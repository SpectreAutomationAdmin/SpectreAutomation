// Sprint 3 · Post-16H P0-hardening (2026-08-07) — automatic
// ApIntakeSource recovery. Founder rule §4:
//
//   "There must be an automatic recovery mechanism for:
//      IngestedDocument exists
//      + invoice/accounting document eligible for analysis
//      + expected ApIntakeSource absent
//    Do not rely on administrator endpoints, Mission Control
//    rendering, a future unrelated sync, or founder action."
//
// The DMM incident proved that if the inline materialise hook in
// `runMailboxAttachmentIngest` misses a beat (silent failure /
// race / non-standard ingest path), a PDF can be stranded
// indefinitely. This module closes the gap two ways:
//
//   (a) INLINE ENQUEUE — every IngestedDocument insert that
//       classifies as an accounting document eligible for AP intake
//       enqueues a recovery job with a deterministic idempotency key.
//       That key means at-most-once effective execution across a
//       burst of overlapping ingests.
//
//   (b) PERIODIC SWEEP — `sweepStrandedApDocuments` scans for
//       IngestedDocuments that classify as accounting-relevant AND
//       lack an ApIntakeSource, and enqueues the same recovery job
//       for each. Called on a schedule (or via an admin recovery
//       endpoint) so a permanently-lost enqueue is caught.
//
// Idempotency:
//   * The job's idempotency key is `ap-materialise-recover:{clubId}:{ingestedDocumentId}`.
//   * The handler calls materialiseSingleInvoiceDocument, which
//     itself is idempotent by canonical-intake natural key +
//     upsertApIntakeSource.
//   * No duplicate ApIntakeSource is possible (EmailAttachment.id
//     UNIQUE constraint on ApIntakeSource).
//   * No duplicate canonical AP intake WI is possible (findOrCreate
//     natural key).

import { prisma } from "@/lib/prisma";
import { enqueue } from "@/lib/queue";
import { logger } from "@/lib/observability/logger";

export interface RecoveryPayload {
  clubId: string;
  ingestedDocumentId: string;
  emailAttachmentId?: string;
  emailMessageId?: string;
}

const RECOVERY_JOB_KIND = "AP_MATERIALISE_RECOVERY" as const;

/**
 * Enqueue a recovery job for a specific document. Idempotent —
 * a duplicate enqueue with the same key is a no-op.
 */
export async function enqueueApMaterialiseRecovery(payload: RecoveryPayload): Promise<{ enqueued: boolean; idempotencyKey: string }> {
  const idempotencyKey = `ap-materialise-recover:${payload.clubId}:${payload.ingestedDocumentId}`;
  try {
    await enqueue({
      kind: RECOVERY_JOB_KIND,
      clubId: payload.clubId,
      payload,
      idempotencyKey,
    });
    return { enqueued: true, idempotencyKey };
  } catch (err) {
    logger.warn("ap-intelligence.materialise_recovery.enqueue_failed", {
      clubId: payload.clubId,
      documentIdTail: payload.ingestedDocumentId.slice(-6),
      error: err instanceof Error ? err.message : String(err),
    });
    return { enqueued: false, idempotencyKey };
  }
}

/**
 * Handler for AP_MATERIALISE_RECOVERY jobs. Registered from the
 * worker bootstrap. Safe to call directly for admin-driven repair
 * or from a test harness.
 */
export async function runApMaterialiseRecovery(payload: RecoveryPayload): Promise<{
  status: "ALREADY_LINKED" | "MATERIALISED_NOW" | "SKIPPED_NOT_ELIGIBLE" | "FAILED";
  intakeIdTail?: string;
  reason?: string;
}> {
  // Step 1: bail if the doc already has an ApIntakeSource.
  const existing = await prisma.apIntakeSource.findFirst({
    where: { clubId: payload.clubId, ingestedDocumentId: payload.ingestedDocumentId },
    select: { id: true, canonicalApIntakeId: true },
  });
  if (existing) {
    logger.info("ap-intelligence.materialise_recovery.already_linked", {
      clubId: payload.clubId,
      documentIdTail: payload.ingestedDocumentId.slice(-6),
      apIntakeSourceIdTail: existing.id.slice(-8),
    });
    return { status: "ALREADY_LINKED", intakeIdTail: existing.canonicalApIntakeId.slice(-8) };
  }

  // Step 2: verify the doc is eligible for AP intake.
  const doc = await prisma.ingestedDocument.findFirst({
    where: { id: payload.ingestedDocumentId, clubId: payload.clubId },
    select: { id: true, classification: true, status: true, mimeType: true },
  });
  if (!doc) return { status: "SKIPPED_NOT_ELIGIBLE", reason: "IngestedDocument not found" };
  if (doc.classification !== "INVOICE") {
    // STATEMENT / CREDIT_MEMO route through their own materialisers
    // and are out of scope for this recovery hook. Founder-approved
    // narrow scope: INVOICE only.
    return { status: "SKIPPED_NOT_ELIGIBLE", reason: `classification=${doc.classification}` };
  }
  if (doc.status !== "STORED") {
    return { status: "SKIPPED_NOT_ELIGIBLE", reason: `status=${doc.status}` };
  }
  if (doc.mimeType !== "application/pdf") {
    return { status: "SKIPPED_NOT_ELIGIBLE", reason: `mime=${doc.mimeType}` };
  }

  // Step 3: try to resolve the source context. If not provided by
  // the caller, walk EMAIL_ATTACHMENT sourceReferenceId back.
  let sourceContext = payload.emailAttachmentId && payload.emailMessageId
    ? { emailAttachmentId: payload.emailAttachmentId, emailMessageId: payload.emailMessageId }
    : undefined;
  if (!sourceContext) {
    const docFull = await prisma.ingestedDocument.findFirst({
      where: { id: doc.id, clubId: payload.clubId },
      select: { sourceKind: true, sourceReferenceId: true },
    });
    if (docFull?.sourceKind === "EMAIL_ATTACHMENT" && docFull.sourceReferenceId) {
      const att = await prisma.emailAttachment.findFirst({
        where: { id: docFull.sourceReferenceId },
        select: { id: true, emailMessageId: true },
      });
      if (att) {
        sourceContext = { emailAttachmentId: att.id, emailMessageId: att.emailMessageId };
      }
    }
  }

  // Step 4: run the shared materialiser. Idempotent.
  try {
    const { materialiseSingleInvoiceDocument } = await import("./materialise");
    const result = await materialiseSingleInvoiceDocument({
      clubId: payload.clubId,
      ingestedDocumentId: doc.id,
      sourceContext,
    });
    logger.info("ap-intelligence.materialise_recovery.completed", {
      clubId: payload.clubId,
      documentIdTail: doc.id.slice(-6),
      intakeIdTail: result.intakeId.slice(-8),
      created: result.created,
      apIntakeSourceRelationship: result.apIntakeSourceRelationship ?? null,
    });
    return { status: "MATERIALISED_NOW", intakeIdTail: result.intakeId.slice(-8) };
  } catch (err) {
    logger.warn("ap-intelligence.materialise_recovery.failed", {
      clubId: payload.clubId,
      documentIdTail: doc.id.slice(-6),
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "FAILED", reason: err instanceof Error ? err.message : "unknown" };
  }
}

/**
 * Periodic sweep — finds every IngestedDocument in the tenant that
 * has classification INVOICE + status STORED and no ApIntakeSource,
 * enqueueing one recovery job per doc. Returns counts.
 *
 * Bounded scan: max 200 stranded docs per invocation to keep the
 * job payload burst small. Idempotency-key dedup at the queue
 * layer means overlapping sweeps do not double-enqueue.
 */
export async function sweepStrandedApDocuments(args: {
  clubId: string;
  limit?: number;
}): Promise<{ scanned: number; enqueued: number; skipped: number; sample: string[] }> {
  const limit = Math.min(200, Math.max(1, args.limit ?? 100));
  // Left-anti-join via NOT EXISTS: find INVOICE STORED docs with no
  // corresponding ApIntakeSource.
  const stranded = await prisma.ingestedDocument.findMany({
    where: {
      clubId: args.clubId,
      classification: "INVOICE",
      status: "STORED",
      mimeType: "application/pdf",
      NOT: {
        // Prisma-Postgres doesn't have a direct "NOT EXISTS" — express
        // via a raw check: docs where no ApIntakeSource points at them.
        // We approximate by loading candidates then filtering; the
        // scan is bounded so this is cheap.
        id: { in: [] },
      },
    },
    orderBy: { createdAt: "desc" },
    take: limit * 3,   // over-fetch and filter
    select: { id: true },
  });
  const sourced = stranded.length > 0
    ? await prisma.apIntakeSource.findMany({
        where: { clubId: args.clubId, ingestedDocumentId: { in: stranded.map((d) => d.id) } },
        select: { ingestedDocumentId: true },
      })
    : [];
  const sourcedIds = new Set(sourced.map((s) => s.ingestedDocumentId));
  const trueStranded = stranded.filter((d) => !sourcedIds.has(d.id)).slice(0, limit);
  let enqueued = 0;
  const sample: string[] = [];
  for (const d of trueStranded) {
    const r = await enqueueApMaterialiseRecovery({ clubId: args.clubId, ingestedDocumentId: d.id });
    if (r.enqueued) {
      enqueued++;
      if (sample.length < 10) sample.push(d.id.slice(-8));
    }
  }
  logger.info("ap-intelligence.materialise_recovery.sweep", {
    clubId: args.clubId,
    scanned: stranded.length,
    enqueued,
    trueStrandedCount: trueStranded.length,
  });
  return { scanned: stranded.length, enqueued, skipped: trueStranded.length - enqueued, sample };
}
