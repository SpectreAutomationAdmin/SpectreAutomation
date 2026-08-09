// Sprint 3 · Phase 4 Slice 5.7B (2026-08-09) — PRODUCT_REFERENCE_RESEARCH
// worker handler.
//
// §2 target flow:
//   web tier detects material ambiguity
//     → looks up durable ProductReference
//     → if MISS/EXPIRED/RETRYABLE past cooldown → claim + enqueue
//     → returns immediately with truthful pending state
//   this worker:
//     → transitions PENDING → RUNNING
//     → invokes the paid provider once
//     → persists factual evidence
//     → enqueues AP_INVOICE_REANALYSE for every dependent doc
//     → NEVER writes tenant accounting conclusions (§D founder gate)
//
// §11 re-analysis targeting: the payload carries dependent documentIds
// + clubIds so the worker knows which invoices to re-analyse. New docs
// that later match the same product read the ProductReference row
// during their own analyse call — no follow-up enqueue needed.
//
// §17 retry/DLQ: transient errors get bounded retry; terminal errors
// escalate to FAILED_TERMINAL. Worker itself is idempotent — re-running
// the same payload with the same normalizedKey either (a) hits COMPLETED
// and skips or (b) hits RUNNING (concurrent) and returns SKIPPED_RUNNING.

import { logger } from "@/lib/observability/logger";
import type { ProductReferenceRequest } from "../product-reference-provider";
import {
  markResearchRunning,
  recordResearchOutcome,
  recordResearchError,
  lookupProductReference,
  type NormalizedProductKey,
} from "./durable-cache";
import { PRODUCT_REFERENCE_RESEARCH_VERSION, isResearchVersionCurrent } from "./versions";

export interface ProductReferenceResearchPayload {
  normalizedKey: NormalizedProductKey;
  refRequest: ProductReferenceRequest;
  /** Documents whose current analysis is pending on this research.
   *  On completion, one AP_INVOICE_REANALYSE is enqueued per
   *  (clubId, documentId) pair. */
  dependents: Array<{ clubId: string; ingestedDocumentId: string }>;
  /** Version at enqueue-time. Worker refuses to process if incompatible. */
  researchVersion: string;
}

export type ProductReferenceResearchOutcome =
  | "COMPLETED"
  | "SKIPPED_RUNNING"
  | "SKIPPED_COMPLETED"
  | "SKIPPED_VERSION_MISMATCH"
  | "FAILED_RETRYABLE"
  | "FAILED_TERMINAL";

export interface ProductReferenceResearchResult {
  outcome: ProductReferenceResearchOutcome;
  productReferenceId: string | null;
  reanalyseEnqueued: number;
  externalLookupCount: number;
  latencyMs: number;
  diagnostic: string;
}

/** §D — the ONLY module authorised to call the paid provider. Web tier
 *  must never invoke it directly after Slice 5.7B cutover. */
export async function runProductReferenceResearchJob(args: {
  jobId: string;
  payload: ProductReferenceResearchPayload;
}): Promise<ProductReferenceResearchResult> {
  const startedAt = Date.now();
  const { normalizedKey, refRequest, dependents, researchVersion } = args.payload;

  // §13 web/worker version parity — if the enqueuing web tier ran under
  // an older code and this worker is newer (or vice-versa), refuse
  // the job rather than write mis-shaped evidence.
  if (!isResearchVersionCurrent(researchVersion)) {
    logger.warn("ap-intelligence.slice5-7b.research.version-mismatch", {
      enqueuedVersion: researchVersion,
      currentVersion: PRODUCT_REFERENCE_RESEARCH_VERSION,
      normalizedKey: normalizedKey.normalizedKey,
    });
    return {
      outcome: "SKIPPED_VERSION_MISMATCH",
      productReferenceId: null,
      reanalyseEnqueued: 0,
      externalLookupCount: 0,
      latencyMs: Date.now() - startedAt,
      diagnostic: `research-version-mismatch: enqueued=${researchVersion} current=${PRODUCT_REFERENCE_RESEARCH_VERSION}`,
    };
  }

  // Look up the durable row. It must exist — the enqueue path always
  // upserts before publishing the job.
  const preLookup = await lookupProductReference(normalizedKey);
  if (preLookup.kind === "MISS") {
    logger.warn("ap-intelligence.slice5-7b.research.no_durable_row", {
      normalizedKey: normalizedKey.normalizedKey,
    });
    return {
      outcome: "FAILED_TERMINAL",
      productReferenceId: null,
      reanalyseEnqueued: 0,
      externalLookupCount: 0,
      latencyMs: Date.now() - startedAt,
      diagnostic: "no_durable_row",
    };
  }

  // Already done — skip immediately (idempotent under retry / concurrent job).
  if (preLookup.kind === "HIT_USABLE") {
    return await maybeReanalyseAndReturn({
      outcome: "SKIPPED_COMPLETED",
      productReferenceId: preLookup.reference.id,
      dependents,
      diagnostic: "already COMPLETED before worker ran",
      startedAt,
      externalLookupCount: 0,
    });
  }
  if (preLookup.kind === "HIT_TERMINAL") {
    return await maybeReanalyseAndReturn({
      outcome: "SKIPPED_COMPLETED",
      productReferenceId: preLookup.reference.id,
      dependents,
      diagnostic: `already ${preLookup.reference.researchState}; not retrying`,
      startedAt,
      externalLookupCount: 0,
    });
  }
  if (preLookup.kind === "HIT_RUNNING") {
    // Another worker instance is on it. Do NOT double-run the provider.
    return {
      outcome: "SKIPPED_RUNNING",
      productReferenceId: preLookup.reference.id,
      reanalyseEnqueued: 0,
      externalLookupCount: 0,
      latencyMs: Date.now() - startedAt,
      diagnostic: "concurrent worker RUNNING; deferring",
    };
  }

  // Claim RUNNING. If we lose the race, another worker is executing.
  const claimed = await markResearchRunning(preLookup.reference.id);
  if (!claimed) {
    return {
      outcome: "SKIPPED_RUNNING",
      productReferenceId: preLookup.reference.id,
      reanalyseEnqueued: 0,
      externalLookupCount: 0,
      latencyMs: Date.now() - startedAt,
      diagnostic: "another worker claimed RUNNING first",
    };
  }

  // §D — invoke provider. This is the ONE place in the codebase that
  // may call the paid provider after Slice 5.7B cutover.
  const { getProductReferenceProvider, activeProviderKind } = await import("./factory");
  const provider = getProductReferenceProvider();
  const providerKind = activeProviderKind();

  try {
    const result = await provider.resolve(refRequest);
    const updated = await recordResearchOutcome({
      id: claimed.id,
      provider: providerKind,
      providerVersion: null,
      result,
      // Selected object type / product family from the winning
      // evidence, if any. Worker never derives accounting decisions;
      // this is metadata only (facts, not conclusions).
      selectedObjectType: pickSelectedObjectType(result),
      selectedProductFamily: pickSelectedProductFamily(result),
    });

    logger.info("ap-intelligence.slice5-7b.research.completed", {
      normalizedKey: normalizedKey.normalizedKey,
      providerKind,
      state: updated.researchState,
      evidenceCount: result.products.length,
      priceCount: result.prices.length,
      callCount: result.callCount,
      dependentCount: dependents.length,
    });

    return await maybeReanalyseAndReturn({
      outcome: updated.researchState === "COMPLETED" ? "COMPLETED" : "SKIPPED_COMPLETED",
      productReferenceId: updated.id,
      dependents,
      diagnostic: `provider=${providerKind} state=${updated.researchState} evidence=${result.products.length}`,
      startedAt,
      externalLookupCount: result.callCount,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 300) : "unknown_error";
    const retryable = isRetryableError(err);
    const updated = await recordResearchError({
      id: claimed.id,
      errorMessage: message,
      retryable,
    });
    logger.warn("ap-intelligence.slice5-7b.research.failed", {
      normalizedKey: normalizedKey.normalizedKey,
      state: updated.researchState,
      retryable,
      attempts: updated.researchAttempts,
      error: message,
    });
    return {
      outcome: retryable ? "FAILED_RETRYABLE" : "FAILED_TERMINAL",
      productReferenceId: updated.id,
      reanalyseEnqueued: 0,
      externalLookupCount: 0,
      latencyMs: Date.now() - startedAt,
      diagnostic: `error=${message}`,
    };
  }
}

/** §11 — after provider work finishes (successfully OR inconclusively),
 *  enqueue AP_INVOICE_REANALYSE for every dependent (clubId, docId).
 *  Deduplication: AP_INVOICE_REANALYSE has its own idempotency key
 *  `ap-reanalyse:{clubId}:{docId}` so multiple simultaneous ProductRef
 *  jobs for related invoices collapse to one re-analyse per doc. */
async function maybeReanalyseAndReturn(args: {
  outcome: ProductReferenceResearchOutcome;
  productReferenceId: string;
  dependents: Array<{ clubId: string; ingestedDocumentId: string }>;
  diagnostic: string;
  startedAt: number;
  externalLookupCount: number;
}): Promise<ProductReferenceResearchResult> {
  let reanalyseEnqueued = 0;
  if (args.dependents.length > 0) {
    const { enqueue } = await import("@/lib/queue");
    const { apInvoiceReanalyseIdempotencyKey } = await import("../reanalyse-worker");
    for (const dep of args.dependents) {
      // Verify the club still exists so the FK on BackgroundJob.clubId
      // holds. In staging / synthetic-fixture contexts a dependent
      // clubId may not resolve to a real Club row — the reanalyse
      // simply becomes a no-op then rather than a hard failure.
      const { prisma } = await import("@/lib/prisma");
      const club = await prisma.club.findUnique({ where: { id: dep.clubId }, select: { id: true } });
      if (!club) {
        logger.info("ap-intelligence.slice5-7b.reanalyse-skip.no-club", {
          clubId: dep.clubId,
          docIdTail: dep.ingestedDocumentId.slice(-6),
        });
        continue;
      }
      try {
        await enqueue({
          kind: "AP_INVOICE_REANALYSE",
          clubId: dep.clubId,
          payload: {
            clubId: dep.clubId,
            ingestedDocumentId: dep.ingestedDocumentId,
            triggerSource: "manual",
          },
          idempotencyKey: apInvoiceReanalyseIdempotencyKey({
            clubId: dep.clubId,
            ingestedDocumentId: dep.ingestedDocumentId,
          }),
        });
        reanalyseEnqueued++;
      } catch (err) {
        // Idempotency-key uniqueness clash → already enqueued; not an error.
        const message = err instanceof Error ? err.message : String(err);
        if (!/unique|conflict|duplicate/i.test(message)) {
          logger.warn("ap-intelligence.slice5-7b.reanalyse-enqueue-failed", {
            clubId: dep.clubId,
            docIdTail: dep.ingestedDocumentId.slice(-6),
            error: message.slice(0, 200),
          });
        }
      }
    }
  }
  return {
    outcome: args.outcome,
    productReferenceId: args.productReferenceId,
    reanalyseEnqueued,
    externalLookupCount: args.externalLookupCount,
    latencyMs: Date.now() - args.startedAt,
    diagnostic: args.diagnostic,
  };
}

function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  const msg = err.message.toLowerCase();
  // Timeouts, transient 5xx, rate-limits → retryable.
  if (/timeout|timed out|econnreset|econnrefused|network|503|502|504|rate.?limit|throttl/.test(msg)) return true;
  // Invalid API key, unsupported request, privacy rejection → terminal.
  if (/invalid.?api.?key|unauthorized|forbidden|401|403|400|invalid.?request/.test(msg)) return false;
  // Default: allow one retry (retryable=true but bounded by MAX_RETRIES).
  return true;
}

function pickSelectedObjectType(result: { products: Array<{ evidenceType: string; matchedProductFamily: string | null; confidence: number }> }): string | null {
  const oem = result.products
    .filter((p) => p.evidenceType === "OEM_PRODUCT_MATCH" || p.evidenceType === "OEM_PART_MATCH")
    .sort((a, b) => b.confidence - a.confidence)[0];
  return oem?.matchedProductFamily ?? null;
}

function pickSelectedProductFamily(result: { products: Array<{ evidenceType: string; matchedProductFamily: string | null; confidence: number }> }): string | null {
  return pickSelectedObjectType(result);
}
