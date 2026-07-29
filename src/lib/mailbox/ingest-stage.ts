// Sprint 3 · Checkpoint 15R Follow-up (2026-07-29) — mailbox ingest
// stage enum + shared per-message failure bookkeeping helper.
//
// Founder rule (integration recovery brief):
//   "Improve structured logging so future failures identify the
//    processing stage without logging message bodies or secrets."
//
// The delta-sync catch block was silently swallowing exceptions and
// not updating the per-message retry state (despite a comment that
// claimed otherwise). The result on staging: the same one message
// failed every 60s with zero diagnostic and zero forward progress
// — the delta cursor could not advance because the outcome stayed
// BOUNDED_PARTIAL forever.
//
// This module extracts the retry bookkeeping from sync.ts into a
// single helper both initial-sync and delta-sync call. It ALSO
// emits a structured log line tagged with the failure stage so
// operators can grep for the exact stage where things went wrong.

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import * as crypto from "node:crypto";

/**
 * A message-ingestion pipeline stage. Every exception raised inside
 * a per-message loop should be tagged with one of these values so
 * the log stream is greppable by stage.
 */
export type MailboxIngestStage =
  | "MESSAGE_NORMALIZE"
  | "MESSAGE_UPSERT"
  | "ATTACHMENT_METADATA"
  | "ATTACHMENT_ENQUEUE"
  | "ATTACHMENT_DOWNLOAD"
  | "BLOB_STORE"
  | "DOCUMENT_UPSERT"
  | "CLASSIFY"
  | "WORK_INTAKE_UPSERT"
  | "ANALYSE"
  | "MATERIALISE"
  | "UNKNOWN";

/**
 * Bound: a single message that fails this many times in a row is
 * quarantined (`ingestFailedAt` set) and skipped on subsequent runs.
 * A quarantined message can be manually retried via the staging-only
 * diagnostic route.
 */
export const MAX_MESSAGE_RETRIES = 3;

/**
 * Sanitise an exception message for logs. Removes email addresses,
 * long hexadecimal hashes, and truncates.
 */
export function sanitiseIngestError(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return raw
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "[email]")
    .replace(/\b[a-f0-9]{32,}\b/gi, "[longhash]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .slice(0, 400);
}

/** Short SHA of any string identifier — for logs so raw Graph IDs are not exposed. */
export function shortHash(v: string | null | undefined): string {
  if (!v) return "none";
  return crypto.createHash("sha256").update(v).digest("hex").slice(0, 12);
}

/**
 * Record a per-message failure. Emits a structured log line tagged
 * with the stage AND updates the EmailMessage row's retry counter
 * (quarantining after MAX_MESSAGE_RETRIES).
 *
 * Returns the resulting retry state so the caller can decide whether
 * the delta cursor may advance past this message (quarantined ==
 * yes) or not (still retriable == no).
 */
export async function recordMessageFailure(args: {
  clubId: string;
  mailboxConnectionId: string;
  graphMessageId: string;              // as returned by Graph (immutable id preferred)
  stage: MailboxIngestStage;
  error: unknown;
  triggerKind: "INITIAL" | "DELTA";
}): Promise<{ retryAttempts: number; quarantined: boolean }> {
  const sanitised = sanitiseIngestError(args.error);
  const errorName = args.error instanceof Error ? args.error.name : "UnknownError";
  const httpStatus = (args.error as { status?: number; statusCode?: number })?.status
    ?? (args.error as { status?: number; statusCode?: number })?.statusCode
    ?? null;

  // Best-effort DB update. A meta-failure here is non-fatal — we
  // still log the primary failure below.
  let retryAttempts = 0;
  let quarantined = false;
  try {
    const existing = await prisma.emailMessage.findFirst({
      where: {
        mailboxConnectionId: args.mailboxConnectionId,
        graphMessageId: args.graphMessageId,
      },
      select: { id: true, retryAttempts: true },
    });
    if (existing) {
      retryAttempts = (existing.retryAttempts ?? 0) + 1;
      quarantined = retryAttempts >= MAX_MESSAGE_RETRIES;
      await prisma.emailMessage.update({
        where: { id: existing.id },
        data: {
          retryAttempts,
          ingestFailedAt: quarantined ? new Date() : null,
          ingestFailReason: quarantined ? `${args.stage}: ${sanitised}` : null,
        },
      });
    } else {
      // Message row does not exist yet — the failure was during upsert
      // itself. We can't update retry state; log-only.
      retryAttempts = 0;
      quarantined = false;
    }
  } catch (metaErr) {
    logger.warn("mailbox.ingest.retry_bookkeeping_failed", {
      mailboxConnectionIdTail: args.mailboxConnectionId.slice(-6),
      graphMessageIdHash: shortHash(args.graphMessageId),
      metaError: sanitiseIngestError(metaErr).slice(0, 200),
    });
  }

  logger.warn("mailbox.ingest.message_failed", {
    mailboxConnectionIdTail: args.mailboxConnectionId.slice(-6),
    clubIdTail: args.clubId.slice(-6),
    graphMessageIdHash: shortHash(args.graphMessageId),
    stage: args.stage,
    errorName,
    httpStatus,
    sanitisedMessage: sanitised,
    retryAttempts,
    quarantined,
    triggerKind: args.triggerKind,
  });

  return { retryAttempts, quarantined };
}

/**
 * Emit a structured log for a per-message SUCCESS. Optional — most
 * callers won't use this because success is the common case, but
 * available for debugging integrations.
 */
export function logMessageSuccess(args: {
  clubId: string;
  mailboxConnectionId: string;
  graphMessageId: string;
  stage: MailboxIngestStage;
  triggerKind: "INITIAL" | "DELTA";
  extra?: Record<string, unknown>;
}): void {
  logger.info("mailbox.ingest.message_ok", {
    mailboxConnectionIdTail: args.mailboxConnectionId.slice(-6),
    clubIdTail: args.clubId.slice(-6),
    graphMessageIdHash: shortHash(args.graphMessageId),
    stage: args.stage,
    triggerKind: args.triggerKind,
    ...(args.extra ?? {}),
  });
}
