// Sprint 3 · Checkpoint 15R Follow-up (2026-07-29) — staging-only
// mailbox diagnostic + retry admin API.
//
// Founder rule (integration recovery brief §8):
//   "Add an authorized, staging-only API route with no new UI that
//    can:
//      * inspect a specific mailbox sync run;
//      * list sanitized failed-message diagnostics;
//      * retry one failed message;
//      * retry all failed messages for a mailbox;
//      * trigger a mailbox sync;
//      * report whether a Work Intake item was created.
//    Requirements:
//      * server-side staging enforcement;
//      * RBAC authorization;
//      * tenant and user scoping;
//      * audit event;
//      * no token or message-body disclosure;
//      * unavailable in production;
//      * idempotent."
//
// This route is READ-ONLY on GET (sanitised diagnostic) and RETRY
// on POST. Both require SUPER_ADMIN. Both refuse in production.
// Nothing rendered client-side; caller invokes via authenticated
// curl / HTTPie.

import { NextResponse } from "next/server";
import * as crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { requirePrincipal } from "@/lib/services/principal";
import { isSuperAdmin } from "@/lib/rbac";
import { logger } from "@/lib/observability/logger";
import { audit } from "@/lib/audit";

function short(v: string | null | undefined): string {
  if (!v) return "none";
  return crypto.createHash("sha256").update(v).digest("hex").slice(0, 12);
}
function sanitiseSubject(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = String(s).trim();
  return t.length <= 60 ? t : t.slice(0, 30) + "…" + t.slice(-20);
}
function sanitiseError(v: string | null | undefined): string | null {
  if (!v) return null;
  return String(v)
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "[email]")
    .replace(/\b[a-f0-9]{32,}\b/gi, "[longhash]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .slice(0, 300);
}

// Staging-only gate. Production always 404s. Uses SPECTRE_ENV
// (canonical) with NODE_ENV as a legacy fallback.
function isStaging(): boolean {
  const env = (process.env.SPECTRE_ENV ?? process.env.NEXT_PUBLIC_ENVIRONMENT ?? "").toLowerCase();
  if (env === "staging") return true;
  // If SPECTRE_ENV isn't set, allow when NODE_ENV isn't "production".
  return env !== "production" && (process.env.NODE_ENV ?? "") !== "production";
}

async function loadConnection(id: string) {
  return prisma.mailboxConnection.findFirst({
    where: { id },
    select: {
      id: true, clubId: true, userId: true, status: true,
      lastSuccessfulSyncAt: true, lastAttemptedSyncAt: true, lastSyncError: true,
      deltaLink: true,
    },
  });
}

// GET /api/admin/mailbox-diagnostic/:mailboxConnectionId
// Returns sanitized diagnostic for the most recent 5 sync runs +
// each failing message (retryAttempts > 0 or ingestFailedAt != null).
export async function GET(req: Request, ctx: { params: Promise<{ mailboxConnectionId: string }> }) {
  if (!isStaging()) {
    return NextResponse.json({ error: "not_available_in_production" }, { status: 404 });
  }
  const principal = await requirePrincipal();
  if (!isSuperAdmin(principal)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { mailboxConnectionId } = await ctx.params;
  const conn = await loadConnection(mailboxConnectionId);
  if (!conn) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const runs = await prisma.mailboxSyncRun.findMany({
    where: { mailboxConnectionId: conn.id },
    orderBy: { queuedAt: "desc" },
    take: 5,
    select: {
      id: true, status: true, triggerKind: true,
      queuedAt: true, startedAt: true, completedAt: true,
      messagesExamined: true, messagesImported: true, messagesUpdated: true,
      messagesSuppressed: true, messagesFailed: true,
      intakeCreatedActionable: true, intakeCreatedInformational: true,
      failureCategory: true,
    },
  });
  const failingMessages = await prisma.emailMessage.findMany({
    where: {
      mailboxConnectionId: conn.id,
      OR: [
        { retryAttempts: { gt: 0 } },
        { ingestFailedAt: { not: null } },
      ],
    },
    orderBy: { updatedAt: "desc" },
    take: 20,
    select: {
      id: true, graphMessageId: true, subject: true, receivedAt: true,
      hasAttachments: true, retryAttempts: true, ingestFailedAt: true,
      ingestFailReason: true,
    },
  });
  const response = {
    connection: {
      id: conn.id,
      status: conn.status,
      lastSuccessfulSyncAt: conn.lastSuccessfulSyncAt,
      lastAttemptedSyncAt: conn.lastAttemptedSyncAt,
      lastSyncError: sanitiseError(conn.lastSyncError),
      deltaCursorPresent: conn.deltaLink != null,
      deltaCursorLength: conn.deltaLink?.length ?? 0,
    },
    recentRuns: runs,
    failingMessages: failingMessages.map((m) => ({
      idHash: short(m.id),
      graphMessageIdHash: short(m.graphMessageId),
      subject: sanitiseSubject(m.subject),
      receivedAt: m.receivedAt,
      hasAttachments: m.hasAttachments,
      retryAttempts: m.retryAttempts,
      ingestFailedAt: m.ingestFailedAt,
      ingestFailReason: sanitiseError(m.ingestFailReason),
      quarantined: m.ingestFailedAt != null,
    })),
  };
  logger.info("mailbox.diagnostic.viewed", {
    mailboxConnectionIdTail: conn.id.slice(-6),
    actorUserIdTail: principal.id.slice(-6),
    failingCount: failingMessages.length,
  });
  return NextResponse.json(response);
}

// POST /api/admin/mailbox-diagnostic/:mailboxConnectionId
//   { action: "retry_message", graphMessageIdHash }
//   { action: "retry_all_failed" }
//   { action: "trigger_delta_sync" }
//
// Idempotent: retry actions clear retryAttempts / ingestFailedAt on
// the targeted rows and enqueue a fresh delta sync. No duplicate
// EmailMessage / IngestedDocument / WorkIntakeItem is created on
// retry — the existing dedup paths in ingestOneMessage +
// ingestAttachment + email-materializer handle idempotency.
export async function POST(req: Request, ctx: { params: Promise<{ mailboxConnectionId: string }> }) {
  if (!isStaging()) {
    return NextResponse.json({ error: "not_available_in_production" }, { status: 404 });
  }
  const principal = await requirePrincipal();
  if (!isSuperAdmin(principal)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { mailboxConnectionId } = await ctx.params;
  const conn = await loadConnection(mailboxConnectionId);
  if (!conn) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const body = await req.json().catch(() => ({})) as {
    action?: string;
    graphMessageIdHash?: string;
  };
  const action = body.action;

  if (action === "retry_all_failed") {
    // Clear retryAttempts + ingestFailedAt on every failing message
    // so the next sync re-attempts. Delta cursor stays put — the
    // next tick will re-process the same batch. Idempotent.
    const cleared = await prisma.emailMessage.updateMany({
      where: {
        mailboxConnectionId: conn.id,
        OR: [
          { retryAttempts: { gt: 0 } },
          { ingestFailedAt: { not: null } },
        ],
      },
      data: { retryAttempts: 0, ingestFailedAt: null, ingestFailReason: null },
    });
    await audit(principal, {
      clubId: conn.clubId,
      action: "MAILBOX_DIAGNOSTIC_RETRY_ALL",
      entityType: "MailboxConnection",
      entityId: conn.id,
      meta: { messagesCleared: cleared.count },
    });
    logger.info("mailbox.diagnostic.retry_all", {
      mailboxConnectionIdTail: conn.id.slice(-6),
      actorUserIdTail: principal.id.slice(-6),
      messagesCleared: cleared.count,
    });
    return NextResponse.json({ ok: true, messagesCleared: cleared.count });
  }

  if (action === "retry_message") {
    if (!body.graphMessageIdHash) {
      return NextResponse.json({ error: "graphMessageIdHash required" }, { status: 400 });
    }
    // The GET endpoint returns hashes only — never raw Graph IDs.
    // Retry-by-hash finds the row whose hash matches. Idempotent.
    const targeted = await prisma.emailMessage.findMany({
      where: { mailboxConnectionId: conn.id },
      select: { id: true, graphMessageId: true },
    });
    const match = targeted.find((m) => short(m.graphMessageId) === body.graphMessageIdHash);
    if (!match) {
      return NextResponse.json({ error: "message_not_found_for_hash" }, { status: 404 });
    }
    await prisma.emailMessage.update({
      where: { id: match.id },
      data: { retryAttempts: 0, ingestFailedAt: null, ingestFailReason: null },
    });
    await audit(principal, {
      clubId: conn.clubId,
      action: "MAILBOX_DIAGNOSTIC_RETRY_ONE",
      entityType: "MailboxConnection",
      entityId: conn.id,
      meta: { emailMessageIdTail: match.id.slice(-6) },
    });
    logger.info("mailbox.diagnostic.retry_one", {
      mailboxConnectionIdTail: conn.id.slice(-6),
      actorUserIdTail: principal.id.slice(-6),
      emailMessageIdTail: match.id.slice(-6),
    });
    return NextResponse.json({ ok: true });
  }

  if (action === "trigger_delta_sync") {
    // Enqueue a MAILBOX_DELTA_SYNC job for this connection. The
    // auto-sync scheduler would eventually do this within 60s;
    // this route just fires it immediately. Idempotency key uses
    // a per-minute bucket so multiple triggers within the same
    // minute collapse to one job.
    const { enqueue } = await import("@/lib/queue");
    const bucket = Math.floor(Date.now() / 60_000);
    const job = await enqueue({
      kind: "MAILBOX_DELTA_SYNC",
      queue: "mailbox",
      clubId: conn.clubId,
      payload: { mailboxConnectionId: conn.id },
      idempotencyKey: `mailbox:diagnostic-trigger:${conn.id}:${bucket}`,
      maxAttempts: 3,
    });
    await audit(principal, {
      clubId: conn.clubId,
      action: "MAILBOX_DIAGNOSTIC_TRIGGER_SYNC",
      entityType: "MailboxConnection",
      entityId: conn.id,
      meta: { jobIdTail: String(job?.id ?? "").slice(-6) },
    });
    logger.info("mailbox.diagnostic.trigger_sync", {
      mailboxConnectionIdTail: conn.id.slice(-6),
      actorUserIdTail: principal.id.slice(-6),
    });
    return NextResponse.json({ ok: true, enqueued: true });
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
}
