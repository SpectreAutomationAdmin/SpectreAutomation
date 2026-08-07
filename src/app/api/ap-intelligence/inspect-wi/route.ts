// Sprint 3 · Post-16H Phase 4 Slice 3-forensic (2026-08-06) —
// full attachment-chain forensic diagnostic for the DMM incident.
// Founder §1-§4 audit path:
//
//   Graph (live) → EmailMessage → EmailAttachment →
//   IngestedDocument → WorkIntakeOrigin → ApIntakeSource →
//   canonical AP intake → mailbox-sync BackgroundJob history
//
// Every stage is reported with sanitised IDs (hashes / suffixes)
// and error classes only. No email body, no subject, no filenames
// beyond suffix. No secrets.
//
// Security posture:
//   * staging-only (SPECTRE_ENV != production → 404)
//   * SUPER_ADMIN or system:audit:read only
//   * tenant scoped
//   * read-only — no writes, no queue enqueue, no OCR provider
//   * bounded execution time
//
// Body:
//   { wiId?: string; wiIdSuffix4?: string; probeGraph?: boolean; }
//
// When probeGraph is true AND the underlying EmailMessage is
// reachable, we live-fetch the attachment list from Microsoft
// Graph via getFreshDelegatedAccessToken + listAttachmentMetadata
// so we can compare Spectre's persisted state against Graph's
// authoritative truth.

import { NextResponse } from "next/server";
import { z } from "zod";
import crypto from "node:crypto";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission, isSuperAdmin } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";

function isStagingEnv(): boolean {
  const env = (process.env.SPECTRE_ENV ?? process.env.NODE_ENV ?? "").toLowerCase();
  return env !== "production" && env !== "prod";
}
function hashTail(v: string | null | undefined): string {
  if (!v) return "(null)";
  return "h_" + crypto.createHash("sha1").update(v).digest("hex").slice(-10);
}
function idTail(v: string | null | undefined, n: number = 8): string {
  if (!v) return "(null)";
  return v.slice(-n);
}

const bodySchema = z.object({
  wiId: z.string().min(1).optional(),
  wiIdSuffix4: z.string().length(4).optional(),
  probeGraph: z.boolean().optional().default(false),
}).refine((v) => v.wiId || v.wiIdSuffix4, { message: "wiId or wiIdSuffix4 required" });

export async function POST(req: Request) {
  if (!isStagingEnv()) return new NextResponse("Not Found", { status: 404 });
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ ok: false, error: "UNAUTHENTICATED" }, { status: 401 });
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!clubId) return NextResponse.json({ ok: false, error: "NO_CLUB" }, { status: 400 });
  if (!isSuperAdmin(principal) && !hasPermission(principal, clubId, "system:audit:read")) {
    return NextResponse.json({ ok: false, error: "PERMISSION" }, { status: 403 });
  }
  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ ok: false, error: "INVALID_JSON" }, { status: 400 }); }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ ok: false, error: "VALIDATION" }, { status: 400 });

  // ---- (1) Work Intake Item ----------------------------------------
  const wi = parsed.data.wiId
    ? await prisma.workIntakeItem.findFirst({
        where: { id: parsed.data.wiId, clubId },
        select: {
          id: true, status: true, displaySender: true, createdAt: true,
          classification: true, classificationMethod: true, classificationConfidence: true,
          classificationRuleKey: true, judgmentRequired: true,
        },
      })
    : await prisma.workIntakeItem.findFirst({
        where: { clubId, id: { endsWith: parsed.data.wiIdSuffix4!.toLowerCase() } },
        select: {
          id: true, status: true, displaySender: true, createdAt: true,
          classification: true, classificationMethod: true, classificationConfidence: true,
          classificationRuleKey: true, judgmentRequired: true,
        },
        orderBy: { createdAt: "desc" },
      });
  if (!wi) return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });

  // ---- (2) Email origin (WorkIntakeOrigin / EmailWorkIntakeOrigin) --
  const emailOrigins = await prisma.emailWorkIntakeOrigin.findMany({
    where: { clubId, workIntakeItemId: wi.id },
    select: {
      id: true, emailMessageId: true, role: true, linkReason: true, createdAt: true,
    },
  });

  // ---- (3) EmailMessage(s) ----------------------------------------
  const emailMsgs = emailOrigins.length > 0
    ? await prisma.emailMessage.findMany({
        where: { id: { in: emailOrigins.map((o) => o.emailMessageId) } },
        select: {
          id: true, mailboxConnectionId: true, graphMessageId: true,
          internetMessageId: true, conversationId: true, senderAddress: true,
          receivedAt: true, hasAttachments: true, isRead: true,
          lastSyncedAt: true, retryAttempts: true, ingestFailedAt: true, ingestFailReason: true,
        },
      })
    : [];

  // ---- (4) EmailAttachments -----------------------------------------
  const attachments = emailMsgs.length > 0
    ? await prisma.emailAttachment.findMany({
        where: { emailMessageId: { in: emailMsgs.map((m) => m.id) } },
        select: {
          id: true, emailMessageId: true, graphAttachmentId: true, filename: true,
          contentType: true, sizeBytes: true, isInline: true, storageState: true,
          storageKey: true, scanState: true, createdAt: true, updatedAt: true,
        },
      })
    : [];

  // ---- (5) ApIntakeSource(s) ---------------------------------------
  const apSources = await prisma.apIntakeSource.findMany({
    where: { clubId, canonicalApIntakeId: wi.id },
    select: {
      id: true, emailAttachmentId: true, emailMessageId: true,
      ingestedDocumentId: true, relationship: true, reason: true,
      analysisVersionAtLink: true, createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
  // Also look up any ApIntakeSource keyed on the attachment IDs we
  // found — catches the case where the source exists but points at
  // a DIFFERENT canonical intake.
  const attachmentIds = attachments.map((a) => a.id);
  const apSourcesByAttachment = attachmentIds.length > 0
    ? await prisma.apIntakeSource.findMany({
        where: { clubId, emailAttachmentId: { in: attachmentIds } },
        select: {
          id: true, emailAttachmentId: true, canonicalApIntakeId: true,
          ingestedDocumentId: true, relationship: true, createdAt: true,
        },
      })
    : [];

  // ---- (6) IngestedDocument(s) -------------------------------------
  const docIds = Array.from(new Set([
    ...apSources.map((s) => s.ingestedDocumentId).filter(Boolean),
    ...apSourcesByAttachment.map((s) => s.ingestedDocumentId).filter(Boolean),
  ]));
  const docs = docIds.length > 0
    ? await prisma.ingestedDocument.findMany({
        where: { id: { in: docIds as string[] }, clubId },
        select: {
          id: true, filename: true, mimeType: true, sha256Hash: true,
          byteLength: true, storageKey: true, storageBucket: true,
          sourceKind: true, sourceReferenceId: true, receivedAt: true, createdAt: true,
        },
      })
    : [];

  // ---- (7) Mailbox sync-job / ingest-history (BackgroundJob) --------
  // We look at the last 40 mailbox-related jobs for this club and
  // filter for anything that touched the message's graphMessageId (if
  // any). Payload is not exposed — only status / kind / times.
  const graphMsgIds = emailMsgs.map((m) => m.graphMessageId).filter(Boolean);
  const recentJobs = await prisma.backgroundJob.findMany({
    where: {
      clubId,
      kind: { in: [
        "MAILBOX_DELTA_SYNC", "MAILBOX_ATTACHMENT_FETCH", "AP_INTAKE_INGEST",
        "AP_INVOICE_ANALYSE", "MAILBOX_INITIAL_SYNC", "WORK_INTAKE_CLASSIFY",
      ] },
    },
    orderBy: { createdAt: "desc" },
    take: 60,
    select: {
      id: true, kind: true, status: true, attempts: true, createdAt: true,
      finishedAt: true, payloadJson: true,
    },
  });
  // Filter to jobs that reference this message OR its attachments.
  const relatedJobs = recentJobs.filter((j) => {
    if (!j.payloadJson) return false;
    for (const g of graphMsgIds) if (j.payloadJson.includes(g)) return true;
    for (const a of attachments) if (j.payloadJson.includes(a.graphAttachmentId)) return true;
    for (const d of docs) if (j.payloadJson.includes(d.id)) return true;
    return false;
  }).slice(0, 20);

  // ---- (8) Graph LIVE probe (optional) -----------------------------
  let graphProbe: unknown = null;
  if (parsed.data.probeGraph && emailMsgs.length > 0) {
    try {
      const msg = emailMsgs[0];
      const conn = await prisma.mailboxConnection.findFirst({
        where: { id: msg.mailboxConnectionId, clubId, status: "CONNECTED" },
        select: { id: true, userId: true, externalUserId: true, connectedEmail: true },
      });
      if (!conn) {
        graphProbe = { ok: false, reason: "no CONNECTED mailboxConnection" };
      } else {
        const { getFreshDelegatedAccessToken } = await import("@/lib/mailbox/connect");
        const { getMicrosoftDelegatedProvider } = await import("@/lib/integrations/microsoft-graph-delegated");
        const token = await getFreshDelegatedAccessToken({
          mailboxConnectionId: conn.id,
          callerClubId: clubId,
          callerUserId: principal.id,
        });
        const provider = getMicrosoftDelegatedProvider();
        // We call listAttachmentMetadata directly. The response is
        // Graph's authoritative attachment list for this message.
        const graphAtts = await provider.listAttachmentMetadata({
          accessToken: token.accessToken,
          graphMessageId: msg.graphMessageId,
        });
        graphProbe = {
          ok: true,
          graphMessageIdTail: idTail(msg.graphMessageId, 8),
          attachmentCount: graphAtts.length,
          attachments: graphAtts.map((a) => ({
            graphAttachmentIdTail: idTail(a.id, 8),
            nameSuffix: (a.name ?? "").slice(-24),
            contentType: a.contentType,
            sizeBytes: a.size,
            isInline: a.isInline,
          })),
        };
      }
    } catch (err) {
      graphProbe = {
        ok: false,
        error: err instanceof Error ? (err as Error).name : "unknown",
        message: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      };
    }
  }

  // ---- Sanitized response ------------------------------------------
  return NextResponse.json({
    ok: true,
    workIntakeItem: {
      idTail: idTail(wi.id, 10),
      status: wi.status,
      classification: wi.classification,
      classificationMethod: wi.classificationMethod,
      classificationRuleKey: wi.classificationRuleKey,
      classificationConfidence: wi.classificationConfidence,
      judgmentRequired: wi.judgmentRequired,
      displaySender: wi.displaySender,
      createdAt: wi.createdAt,
    },
    emailOrigins: emailOrigins.map((o) => ({
      idTail: idTail(o.id, 8), role: o.role, linkReason: o.linkReason,
      emailMessageIdTail: idTail(o.emailMessageId, 10), createdAt: o.createdAt,
    })),
    emailMessages: emailMsgs.map((m) => ({
      idTail: idTail(m.id, 10),
      graphMessageIdTail: idTail(m.graphMessageId, 10),
      internetMessageIdHash: hashTail(m.internetMessageId),
      conversationIdHash: hashTail(m.conversationId),
      senderAddressHash: hashTail(m.senderAddress),
      receivedAt: m.receivedAt,
      hasAttachments: m.hasAttachments,
      lastSyncedAt: m.lastSyncedAt,
      retryAttempts: m.retryAttempts,
      ingestFailedAt: m.ingestFailedAt,
      ingestFailReason: m.ingestFailReason,
      mailboxConnectionIdTail: idTail(m.mailboxConnectionId, 6),
    })),
    emailAttachments: attachments.map((a) => ({
      idTail: idTail(a.id, 8),
      emailMessageIdTail: idTail(a.emailMessageId, 10),
      graphAttachmentIdTail: idTail(a.graphAttachmentId, 8),
      filenameSuffix: a.filename.slice(-24),
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      isInline: a.isInline,
      storageState: a.storageState,
      hasStorageKey: !!a.storageKey,
      scanState: a.scanState,
      createdAt: a.createdAt,
    })),
    apIntakeSources: apSources.map((s) => ({
      idTail: idTail(s.id, 8),
      emailAttachmentIdTail: idTail(s.emailAttachmentId, 8),
      ingestedDocumentIdTail: idTail(s.ingestedDocumentId, 8),
      relationship: s.relationship,
      reason: s.reason,
      analysisVersionAtLink: s.analysisVersionAtLink,
      createdAt: s.createdAt,
    })),
    apIntakeSourcesByAttachment: apSourcesByAttachment.map((s) => ({
      idTail: idTail(s.id, 8),
      emailAttachmentIdTail: idTail(s.emailAttachmentId, 8),
      ingestedDocumentIdTail: idTail(s.ingestedDocumentId, 8),
      canonicalApIntakeIdTail: idTail(s.canonicalApIntakeId, 10),
      relationship: s.relationship,
      createdAt: s.createdAt,
    })),
    ingestedDocuments: docs.map((d) => ({
      idTail: idTail(d.id, 8),
      filenameSuffix: d.filename.slice(-24),
      mimeType: d.mimeType,
      sha256Prefix: d.sha256Hash?.slice(0, 12) ?? null,
      byteLength: d.byteLength,
      storageState: d.storageKey ? "STORED" : "NO_KEY",
      sourceKind: d.sourceKind,
      sourceReferenceIdTail: idTail(d.sourceReferenceId, 8),
      receivedAt: d.receivedAt,
      createdAt: d.createdAt,
    })),
    relatedBackgroundJobs: relatedJobs.map((j) => ({
      idTail: idTail(j.id, 6),
      kind: j.kind,
      status: j.status,
      attempts: j.attempts,
      createdAt: j.createdAt,
      finishedAt: j.finishedAt,
    })),
    graphProbe,
  });
}
