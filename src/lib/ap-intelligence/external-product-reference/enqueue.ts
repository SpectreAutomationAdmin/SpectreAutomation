// Sprint 3 · Phase 4 Slice 5.7B (2026-08-09) — web-side enqueue helper
// for external product research.
//
// §2/§10/§J — this module is the ONLY place the web tier interacts
// with the async research pipeline. It:
//   1. normalizes the request into a canonical product key
//   2. atomically claims (or reuses) a durable ProductReference row
//   3. enqueues a PRODUCT_REFERENCE_RESEARCH job at most once per
//      (normalizedKey, researchVersion)
//   4. NEVER invokes the paid provider directly
//
// Callers get back a diagnostic outcome describing what will happen
// (nothing / already-cached / research pending / research just spawned).

import { logger } from "@/lib/observability/logger";
import type { ProductReferenceRequest } from "../product-reference-provider";
import {
  claimProductReferenceForResearch,
  lookupProductReference,
  normalizeKeyFromRequest,
  productResearchIdempotencyKey,
  type DurableProductReference,
  type NormalizedProductKey,
  type ReferenceLookupOutcome,
} from "./durable-cache";
import { PRODUCT_REFERENCE_RESEARCH_VERSION } from "./versions";

export type EnqueueDecision =
  | { kind: "UNRESOLVABLE_KEY"; reason: string }
  | { kind: "REUSED_COMPLETED"; reference: DurableProductReference }
  | { kind: "REUSED_TERMINAL"; reference: DurableProductReference }
  | { kind: "AWAITING_PENDING"; reference: DurableProductReference }
  | { kind: "AWAITING_RUNNING"; reference: DurableProductReference }
  | { kind: "AWAITING_COOLDOWN"; reference: DurableProductReference; canRetryAfter: Date | null }
  | { kind: "RESEARCH_JUST_ENQUEUED"; reference: DurableProductReference; jobId: string | null }
  | { kind: "RESEARCH_ENQUEUE_FAILED"; reference: DurableProductReference; error: string };

export interface EnqueueRequest {
  refRequest: ProductReferenceRequest;
  clubId: string;
  ingestedDocumentId: string;
}

/** §2 — the single web-side entry-point. Returns a diagnostic outcome
 *  describing durable state; NEVER blocks on a provider call. */
export async function ensureProductResearchEnqueued(
  args: EnqueueRequest,
): Promise<EnqueueDecision> {
  const key = normalizeKeyFromRequest(args.refRequest);
  if (!key) {
    return { kind: "UNRESOLVABLE_KEY", reason: "no manufacturer|model|part could be normalized" };
  }

  // Read current durable state first — most calls will hit this and
  // return without touching the queue.
  const lookup = await lookupProductReference(key);
  const shortCircuit = shortCircuitFromLookup(lookup);
  if (shortCircuit) return shortCircuit;

  // MISS / EXPIRED / SCHEMA_INCOMPATIBLE / RETRYABLE-past-cooldown →
  // claim (upsert to PENDING) and enqueue. The DB unique constraint
  // on `normalizedKey` + the BackgroundJob idempotency key together
  // guarantee at-most-one paid provider call per key + researchVersion.
  const { reference, claimed } = await claimProductReferenceForResearch(key);

  // If someone else won the create-race, do NOT enqueue a duplicate
  // job — return AWAITING with the existing state.
  if (!claimed) {
    if (reference.researchState === "RUNNING") return { kind: "AWAITING_RUNNING", reference };
    if (reference.researchState === "COMPLETED") return { kind: "REUSED_COMPLETED", reference };
    if (reference.researchState === "NO_RESULT" || reference.researchState === "CONFLICTING_EVIDENCE" || reference.researchState === "FAILED_TERMINAL") {
      return { kind: "REUSED_TERMINAL", reference };
    }
    return { kind: "AWAITING_PENDING", reference };
  }

  if (reference.researchState === "RUNNING") {
    return { kind: "AWAITING_RUNNING", reference };
  }

  try {
    const { enqueue } = await import("@/lib/queue");
    // §6 Option C: research is global (no clubId in the payload's
    // dedupe scope). Enqueue with clubId=null so the unique key
    // `(clubId=null, kind, idempotencyKey)` collapses concurrent
    // enqueues across all tenants that reference the same product.
    const job = await enqueue({
      kind: "PRODUCT_REFERENCE_RESEARCH",
      clubId: null,
      idempotencyKey: productResearchIdempotencyKey(key),
      payload: {
        normalizedKey: key,
        refRequest: args.refRequest,
        dependents: [{ clubId: args.clubId, ingestedDocumentId: args.ingestedDocumentId }],
        researchVersion: PRODUCT_REFERENCE_RESEARCH_VERSION,
      },
    });
    logger.info("ap-intelligence.slice5-7b.research.enqueued", {
      clubId: args.clubId,
      normalizedKey: key.normalizedKey,
      productReferenceId: reference.id,
      jobId: job.id,
    });
    return { kind: "RESEARCH_JUST_ENQUEUED", reference, jobId: job.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // BackgroundJob unique clash = another render/instance already
    // enqueued this exact key. Not an error — just report reused.
    if (/unique|conflict|duplicate/i.test(message)) {
      return { kind: "AWAITING_PENDING", reference };
    }
    logger.warn("ap-intelligence.slice5-7b.research.enqueue-failed", {
      normalizedKey: key.normalizedKey,
      error: message.slice(0, 200),
    });
    return { kind: "RESEARCH_ENQUEUE_FAILED", reference, error: message.slice(0, 200) };
  }
}

function shortCircuitFromLookup(lookup: ReferenceLookupOutcome): EnqueueDecision | null {
  switch (lookup.kind) {
    case "HIT_USABLE": return { kind: "REUSED_COMPLETED", reference: lookup.reference };
    case "HIT_TERMINAL": return { kind: "REUSED_TERMINAL", reference: lookup.reference };
    case "HIT_PENDING": return { kind: "AWAITING_PENDING", reference: lookup.reference };
    case "HIT_RUNNING": return { kind: "AWAITING_RUNNING", reference: lookup.reference };
    case "HIT_FAILED_COOLDOWN":
      return {
        kind: "AWAITING_COOLDOWN",
        reference: lookup.reference,
        canRetryAfter: lookup.canRetryAfter,
      };
    // MISS, HIT_EXPIRED, HIT_SCHEMA_INCOMPATIBLE → fall through to claim+enqueue.
    case "MISS":
    case "HIT_EXPIRED":
    case "HIT_SCHEMA_INCOMPATIBLE":
      return null;
  }
}

/** Convert a durable reference's persisted evidence back into a
 *  ProductReferenceResult shape a FixtureProvider can replay so the
 *  existing resolver code path can consume DB evidence unchanged. */
export function evidenceToReplayResult(reference: DurableProductReference): {
  state: "RESOLVED" | "NO_RESULTS";
  products: DurableProductReference["identityEvidenceJson"];
} {
  return {
    state: reference.identityEvidenceJson.length > 0 ? "RESOLVED" : "NO_RESULTS",
    products: reference.identityEvidenceJson,
  };
}

export function normalizedKeyFromRequestPublic(req: ProductReferenceRequest): NormalizedProductKey | null {
  return normalizeKeyFromRequest(req);
}
