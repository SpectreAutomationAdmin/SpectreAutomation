// Sprint 3 · Phase 4 Slice 5.7B (2026-08-09) — Durable, global
// ProductReference cache backed by Prisma.
//
// §2/§4/§6 (Option C): stores product FACTS only; never tenant
// accounting conclusions. Callers derive accounting per-tenant from
// this evidence via analyseIngestedInvoice.
//
// §9 research state model — every row has an explicit state:
//   NOT_REQUIRED | PENDING | RUNNING | COMPLETED
//   | FAILED_RETRYABLE | FAILED_TERMINAL | NO_RESULT | CONFLICTING_EVIDENCE
//
// §10 idempotency — the durable row IS the in-flight marker. When a
// row exists at state PENDING or RUNNING, no additional research is
// spawned (the enqueue path checks state before pushing a job).
//
// §8 TTL policy — identity vs price separated:
//   - identityExpiresAt: nullable, long-lived (default 90 days)
//   - priceExpiresAt: nullable, short-lived (default 14 days)
//
// §17 retry policy — bounded via researchAttempts + nextRetryAt.
//
// §29 privacy — this module NEVER stores or reads clubId, invoice #,
// email/message ID, banking data, or arbitrary webpage bodies.

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import type {
  ProductReferenceEvidence,
  ProductReferenceRequest,
  ProductReferenceResult,
} from "../product-reference-provider";
import {
  PRODUCT_REFERENCE_EVIDENCE_SCHEMA_VERSION,
  PRODUCT_REFERENCE_RESEARCH_VERSION,
  isEvidenceSchemaCompatible,
} from "./versions";

export type ProductReferenceResearchState =
  | "NOT_REQUIRED"
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED_RETRYABLE"
  | "FAILED_TERMINAL"
  | "NO_RESULT"
  | "CONFLICTING_EVIDENCE"
  // Sprint 3 · Phase 4 Slice 5.7B follow-up (2026-08-09) — §3 audit
  // correction. `INFRASTRUCTURE_UNCONFIGURED` means external research
  // was required, but the execution environment did not have an enabled
  // provider capable of performing it. It is NOT a factual conclusion
  // about the product. Rerunnable once configuration is corrected.
  | "INFRASTRUCTURE_UNCONFIGURED";

export interface NormalizedProductKey {
  normalizedManufacturer: string;
  normalizedModel: string;
  normalizedPartNumber: string | null;
  /** Full canonical key `${MFR}|${MDL}|${PART}`. */
  normalizedKey: string;
}

const IDENTITY_TTL_DAYS = 90;
const PRICE_TTL_DAYS = 14;
const RETRY_COOLDOWN_HOURS = 6;
const MAX_RETRIES = 3;

/** §5 cache key — {manufacturer, model, part}. Uppercased, trimmed,
 *  invoice-independent, tenant-independent. Empty part is allowed. */
export function normalizeProductKey(input: {
  manufacturer?: string | null;
  model?: string | null;
  partNumber?: string | null;
}): NormalizedProductKey | null {
  const mfr = (input.manufacturer ?? "").trim().toUpperCase();
  const mdl = (input.model ?? "").trim().toUpperCase();
  const part = (input.partNumber ?? "").trim().toUpperCase();
  // §2 stop-condition: cache identity must safely distinguish products.
  // A completely-empty key is not usable; model is the minimum required
  // discriminator.
  if (!mdl) return null;
  return {
    normalizedManufacturer: mfr,
    normalizedModel: mdl,
    normalizedPartNumber: part.length > 0 ? part : null,
    normalizedKey: `${mfr}|${mdl}|${part}`,
  };
}

/** §5 — normalize from a ProductReferenceRequest to the canonical key.
 *  Uses the first candidate from each list; other candidates flow to
 *  the provider as query material but do NOT participate in the key. */
export function normalizeKeyFromRequest(req: ProductReferenceRequest): NormalizedProductKey | null {
  return normalizeProductKey({
    manufacturer: req.brandCandidates[0] ?? null,
    model: req.modelCandidates[0] ?? null,
    partNumber: req.skuCandidates[0] ?? null,
  });
}

/** Lookup result — communicates freshness AND schema compatibility.
 *  Distinct kinds preserve diagnostic clarity across ops surfaces
 *  (per §3: HIT_INFRASTRUCTURE_UNCONFIGURED must not be conflated
 *  with HIT_EXPIRED even though both are rerunnable). */
export type ReferenceLookupOutcome =
  | { kind: "HIT_USABLE"; reference: DurableProductReference }
  | { kind: "HIT_PENDING"; reference: DurableProductReference }
  | { kind: "HIT_RUNNING"; reference: DurableProductReference }
  | { kind: "HIT_FAILED_COOLDOWN"; reference: DurableProductReference; canRetryAfter: Date | null }
  | { kind: "HIT_TERMINAL"; reference: DurableProductReference }
  | { kind: "HIT_EXPIRED"; reference: DurableProductReference }
  | { kind: "HIT_SCHEMA_INCOMPATIBLE"; reference: DurableProductReference }
  | { kind: "HIT_INFRASTRUCTURE_UNCONFIGURED"; reference: DurableProductReference }
  | { kind: "MISS" };

export interface DurableProductReference {
  id: string;
  normalizedKey: string;
  normalizedManufacturer: string;
  normalizedModel: string;
  normalizedPartNumber: string | null;
  productFamily: string | null;
  objectType: string | null;
  researchState: ProductReferenceResearchState;
  evidenceQuality: string;
  confidence: number;
  provider: string | null;
  providerVersion: string | null;
  researchVersion: string;
  evidenceSchemaVersion: string;
  identityEvidenceJson: ProductReferenceEvidence[];
  sourceEvidenceJson: ProductReferenceEvidence[];
  identityVerifiedAt: Date | null;
  identityExpiresAt: Date | null;
  priceExpiresAt: Date | null;
  researchAttempts: number;
  lastResearchAttemptAt: Date | null;
  lastResearchError: string | null;
  nextRetryAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function rowToDurable(row: {
  id: string;
  normalizedKey: string;
  normalizedManufacturer: string;
  normalizedModel: string;
  normalizedPartNumber: string | null;
  productFamily: string | null;
  objectType: string | null;
  researchState: string;
  evidenceQuality: string;
  confidence: number;
  provider: string | null;
  providerVersion: string | null;
  researchVersion: string;
  evidenceSchemaVersion: string;
  identityEvidenceJson: string;
  sourceEvidenceJson: string;
  identityVerifiedAt: Date | null;
  identityExpiresAt: Date | null;
  priceExpiresAt: Date | null;
  researchAttempts: number;
  lastResearchAttemptAt: Date | null;
  lastResearchError: string | null;
  nextRetryAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): DurableProductReference {
  return {
    ...row,
    researchState: row.researchState as ProductReferenceResearchState,
    identityEvidenceJson: safeParseEvidence(row.identityEvidenceJson),
    sourceEvidenceJson: safeParseEvidence(row.sourceEvidenceJson),
  };
}

function safeParseEvidence(raw: string): ProductReferenceEvidence[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as ProductReferenceEvidence[];
    return [];
  } catch { return []; }
}

/** §29 privacy guard — reject evidence that carries banned fields.
 *  Anything present here would violate the persistence contract; drop
 *  the field silently so we don't crash the worker but never persist. */
function scrubEvidenceForPersistence(evidence: ProductReferenceEvidence[]): ProductReferenceEvidence[] {
  return evidence.map((e) => {
    // Bounded copy — only allowed fields. Anything else (invoice #,
    // clubId, member data, full webpage text) is dropped by shape.
    return {
      evidenceType: e.evidenceType,
      sourceDomain: e.sourceDomain,
      sourceTitle: (e.sourceTitle ?? "").slice(0, 300),
      retrievedAt: e.retrievedAt,
      queryFingerprint: e.queryFingerprint,
      matchedManufacturer: e.matchedManufacturer,
      matchedModel: e.matchedModel,
      matchedPartNumber: e.matchedPartNumber,
      matchedProductFamily: e.matchedProductFamily,
      observedPrice: e.observedPrice,
      currency: e.currency,
      confidence: e.confidence,
      evidenceSnippet: (e.evidenceSnippet ?? "").slice(0, 500),
    };
  });
}

/** §7 additional persistence audit — never persist to the DB fields
 *  we consider tenant/private. Callers pass a raw JSON string here; we
 *  parse, scrub, and re-serialize before write. */
export function auditEvidenceForPrivacyViolation(evidence: ProductReferenceEvidence[]): {
  ok: boolean;
  offendingFields: string[];
} {
  const banned = new Set([
    "clubId", "invoiceNumber", "workIntakeItemId", "emailMessageId",
    "bankAccount", "bankRouting", "taxRegistration", "memberId",
    "memberName", "customerId", "customerName", "vendorBankProfile",
  ]);
  const offending: string[] = [];
  for (const e of evidence) {
    for (const k of Object.keys(e as unknown as Record<string, unknown>)) {
      if (banned.has(k)) offending.push(k);
    }
  }
  return { ok: offending.length === 0, offendingFields: offending };
}

// -------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------

/** §2/§4 — look up an existing durable ProductReference by canonical
 *  key. Returns a shape that tells the caller precisely how to react
 *  (use it, wait for pending research, cooldown, or trigger new). */
export async function lookupProductReference(
  key: NormalizedProductKey,
  now: Date = new Date(),
): Promise<ReferenceLookupOutcome> {
  const row = await prisma.productReference.findUnique({
    where: { normalizedKey: key.normalizedKey },
  });
  if (!row) return { kind: "MISS" };

  const reference = rowToDurable(row);

  // §13 schema compat — if evidence was written under an older schema
  // the current runtime cannot safely interpret, treat as a miss for
  // read purposes AND enqueue fresh research on the current version.
  if (!isEvidenceSchemaCompatible(reference.evidenceSchemaVersion)) {
    return { kind: "HIT_SCHEMA_INCOMPATIBLE", reference };
  }

  // §8 TTL — identity expiry means the identity facts themselves have
  // gone stale (rare; default 90 days). This forces re-research.
  if (reference.identityExpiresAt && reference.identityExpiresAt.getTime() < now.getTime()) {
    return { kind: "HIT_EXPIRED", reference };
  }

  switch (reference.researchState) {
    case "COMPLETED":
      return { kind: "HIT_USABLE", reference };
    case "PENDING":
      return { kind: "HIT_PENDING", reference };
    case "RUNNING":
      return { kind: "HIT_RUNNING", reference };
    case "FAILED_RETRYABLE": {
      // §H (founder amendment) — NO_RESULT / CONFLICTING / terminal
      // failure must NOT retrigger research on every render. Only
      // retry after nextRetryAt has passed.
      const canRetryAfter = reference.nextRetryAt ?? null;
      if (canRetryAfter && canRetryAfter.getTime() < now.getTime()) {
        return { kind: "HIT_EXPIRED", reference }; // treat as re-runable
      }
      return { kind: "HIT_FAILED_COOLDOWN", reference, canRetryAfter };
    }
    case "FAILED_TERMINAL":
    case "NO_RESULT":
    case "CONFLICTING_EVIDENCE":
      return { kind: "HIT_TERMINAL", reference };
    case "INFRASTRUCTURE_UNCONFIGURED":
      // §3 correction — infrastructure/config failure is NOT a
      // factual conclusion. Rerunnable once ops configures the
      // provider. Distinct lookup kind preserves diagnostic clarity
      // so ops surfaces can tell it apart from HIT_EXPIRED.
      return { kind: "HIT_INFRASTRUCTURE_UNCONFIGURED", reference };
    case "NOT_REQUIRED":
      return { kind: "HIT_USABLE", reference };
    default:
      return { kind: "MISS" };
  }
}

/** §10 atomically claim (create-or-transition-to-PENDING) a
 *  ProductReference row for a normalizedKey. Returns the durable row
 *  AND whether this call was the winner of the create race. Losers
 *  must not enqueue a research job.
 *
 *  Race semantics: the winner is the caller whose `create` succeeded
 *  against the UNIQUE(normalizedKey) index. Losers catch the unique
 *  violation and read back the existing row with `claimed=false`. */
export async function claimProductReferenceForResearch(
  key: NormalizedProductKey,
  _now: Date = new Date(),
): Promise<{ reference: DurableProductReference; claimed: boolean }> {
  try {
    const created = await prisma.productReference.create({
      data: {
        normalizedKey: key.normalizedKey,
        normalizedManufacturer: key.normalizedManufacturer,
        normalizedModel: key.normalizedModel,
        normalizedPartNumber: key.normalizedPartNumber,
        researchState: "PENDING",
        researchVersion: PRODUCT_REFERENCE_RESEARCH_VERSION,
        evidenceSchemaVersion: PRODUCT_REFERENCE_EVIDENCE_SCHEMA_VERSION,
        identityEvidenceJson: "[]",
        sourceEvidenceJson: "[]",
      },
    });
    return { reference: rowToDurable(created), claimed: true };
  } catch (err) {
    // P2002 = unique constraint violation. Someone else won OR the
    // row exists from a prior attempt. Read back + optionally re-claim.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/unique|P2002|SQLITE_CONSTRAINT/i.test(msg)) throw err;
    const existing = await prisma.productReference.findUnique({
      where: { normalizedKey: key.normalizedKey },
    });
    if (!existing) {
      // Extremely unlikely — retry the create once.
      const retry = await prisma.productReference.create({
        data: {
          normalizedKey: key.normalizedKey,
          normalizedManufacturer: key.normalizedManufacturer,
          normalizedModel: key.normalizedModel,
          normalizedPartNumber: key.normalizedPartNumber,
          researchState: "PENDING",
          researchVersion: PRODUCT_REFERENCE_RESEARCH_VERSION,
          evidenceSchemaVersion: PRODUCT_REFERENCE_EVIDENCE_SCHEMA_VERSION,
          identityEvidenceJson: "[]",
          sourceEvidenceJson: "[]",
        },
      });
      return { reference: rowToDurable(retry), claimed: true };
    }
    // §3 correction — INFRASTRUCTURE_UNCONFIGURED is a rerunnable
    // sentinel that says "the paid provider was never actually
    // consulted." Once infrastructure is fixed, the FIRST call to
    // claim gets to transition the row back to PENDING; the DB-side
    // updateMany with a state guard makes that atomic across
    // concurrent renders / instances. Losers get the already-
    // transitioned row back and { claimed: false } so no duplicate
    // job is enqueued.
    //
    // Scope-limited on purpose: FAILED_RETRYABLE past cooldown is
    // NOT touched here — that path uses the worker-side retry
    // machinery. Only the config-failure sentinel is re-claimable
    // from the web-request path.
    const transitioned = await prisma.productReference.updateMany({
      where: {
        id: existing.id,
        researchState: "INFRASTRUCTURE_UNCONFIGURED",
      },
      data: {
        researchState: "PENDING",
        lastResearchError: null,
      },
    });
    if (transitioned.count === 1) {
      const claimed = await prisma.productReference.findUnique({ where: { id: existing.id } });
      return { reference: rowToDurable(claimed!), claimed: true };
    }
    return { reference: rowToDurable(existing), claimed: false };
  }
}

/** Worker calls this when starting to process a job. Transitions
 *  PENDING → RUNNING atomically. Refuses if state is unexpected. */
export async function markResearchRunning(id: string): Promise<DurableProductReference | null> {
  const updated = await prisma.productReference.updateMany({
    where: { id, researchState: { in: ["PENDING", "FAILED_RETRYABLE"] } },
    data: { researchState: "RUNNING", lastResearchAttemptAt: new Date() },
  });
  if (updated.count === 0) return null;
  const row = await prisma.productReference.findUnique({ where: { id } });
  return row ? rowToDurable(row) : null;
}

/** Worker calls this after a successful provider round-trip.
 *  Persists factual evidence, marks COMPLETED or an inconclusive
 *  terminal state, sets TTLs. */
export async function recordResearchOutcome(args: {
  id: string;
  provider: string;
  providerVersion: string | null;
  result: ProductReferenceResult;
  selectedObjectType: string | null;
  selectedProductFamily: string | null;
  now?: Date;
}): Promise<DurableProductReference> {
  const now = args.now ?? new Date();
  const evidence = scrubEvidenceForPersistence(args.result.products);
  const identityExpiresAt = new Date(now.getTime() + IDENTITY_TTL_DAYS * 86_400_000);
  const priceExpiresAt = args.result.prices.length > 0
    ? new Date(now.getTime() + PRICE_TTL_DAYS * 86_400_000)
    : null;

  let researchState: ProductReferenceResearchState;
  switch (args.result.state) {
    case "RESOLVED":
    case "PARTIAL":
      researchState = "COMPLETED";
      break;
    case "NO_RESULTS":
    case "LOW_QUALITY_RESULTS":
      researchState = "NO_RESULT";
      break;
    case "CONFLICTING_RESULTS":
      researchState = "CONFLICTING_EVIDENCE";
      break;
    case "TIMEOUT":
    case "PROVIDER_UNAVAILABLE":
      researchState = "FAILED_RETRYABLE";
      break;
    case "PROVIDER_DISABLED":
      // §3 correction — PROVIDER_DISABLED is a config outcome, not a
      // research outcome. The paid provider was never actually
      // consulted. Persisting FAILED_TERMINAL would globally poison
      // this product identity across every tenant once ops fixes the
      // configuration. Use the distinct rerunnable state instead.
      researchState = "INFRASTRUCTURE_UNCONFIGURED";
      break;
    default:
      researchState = "NO_RESULT";
  }

  // §17 retry cooldown — retryable failures cooldown for
  // RETRY_COOLDOWN_HOURS × attempts (up to MAX_RETRIES).
  const nextAttempts = { increment: 1 } as const;
  const row = await prisma.productReference.update({
    where: { id: args.id },
    data: {
      researchState,
      evidenceQuality: deriveEvidenceQuality(args.result),
      confidence: computeConfidence(args.result),
      provider: args.provider,
      providerVersion: args.providerVersion,
      productFamily: args.selectedProductFamily,
      objectType: args.selectedObjectType,
      identityEvidenceJson: JSON.stringify(evidence),
      sourceEvidenceJson: JSON.stringify(evidence),
      identityVerifiedAt: researchState === "COMPLETED" ? now : null,
      identityExpiresAt: researchState === "COMPLETED" ? identityExpiresAt : null,
      priceExpiresAt,
      lastResearchAttemptAt: now,
      lastResearchError: researchState === "COMPLETED" ? null : args.result.diagnostic.slice(0, 400),
      researchAttempts: nextAttempts,
      nextRetryAt: researchState === "FAILED_RETRYABLE"
        ? new Date(now.getTime() + RETRY_COOLDOWN_HOURS * 3_600_000)
        : null,
    },
  });
  return rowToDurable(row);
}

/** Worker calls this when a job throws (e.g. provider network error).
 *  Bounds retries; escalates to FAILED_TERMINAL after MAX_RETRIES. */
export async function recordResearchError(args: {
  id: string;
  errorMessage: string;
  retryable: boolean;
  now?: Date;
}): Promise<DurableProductReference> {
  const now = args.now ?? new Date();
  const current = await prisma.productReference.findUnique({ where: { id: args.id } });
  const attemptCount = (current?.researchAttempts ?? 0) + 1;
  const escalate = attemptCount >= MAX_RETRIES;
  const nextState: ProductReferenceResearchState = args.retryable && !escalate
    ? "FAILED_RETRYABLE"
    : "FAILED_TERMINAL";
  const row = await prisma.productReference.update({
    where: { id: args.id },
    data: {
      researchState: nextState,
      lastResearchAttemptAt: now,
      lastResearchError: args.errorMessage.slice(0, 400),
      researchAttempts: attemptCount,
      nextRetryAt: nextState === "FAILED_RETRYABLE"
        ? new Date(now.getTime() + RETRY_COOLDOWN_HOURS * attemptCount * 3_600_000)
        : null,
    },
  });
  return rowToDurable(row);
}

/** Reset a ProductReference to PENDING so a controlled re-research can
 *  proceed. Used by (a) TTL expiry path, (b) research-version bump,
 *  (c) explicit staging test setup. */
export async function resetForRefresh(id: string): Promise<DurableProductReference> {
  const row = await prisma.productReference.update({
    where: { id },
    data: {
      researchState: "PENDING",
      researchAttempts: 0,
      nextRetryAt: null,
      lastResearchError: null,
      identityExpiresAt: null,
      researchVersion: PRODUCT_REFERENCE_RESEARCH_VERSION,
      evidenceSchemaVersion: PRODUCT_REFERENCE_EVIDENCE_SCHEMA_VERSION,
    },
  });
  return rowToDurable(row);
}

// -------------------------------------------------------------------
// Diagnostics (used by /api/health)
// -------------------------------------------------------------------

export async function productReferenceStats(): Promise<{
  totalRows: number;
  byState: Record<string, number>;
  schemaCurrent: number;
  schemaIncompatible: number;
}> {
  const rows = await prisma.productReference.groupBy({
    by: ["researchState"],
    _count: { _all: true },
  });
  const byState: Record<string, number> = {};
  let totalRows = 0;
  for (const r of rows) {
    byState[r.researchState] = r._count._all;
    totalRows += r._count._all;
  }
  const [schemaCurrent, schemaIncompatible] = await Promise.all([
    prisma.productReference.count({ where: { evidenceSchemaVersion: PRODUCT_REFERENCE_EVIDENCE_SCHEMA_VERSION } }),
    prisma.productReference.count({ where: { evidenceSchemaVersion: { not: PRODUCT_REFERENCE_EVIDENCE_SCHEMA_VERSION } } }),
  ]);
  return { totalRows, byState, schemaCurrent, schemaIncompatible };
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function deriveEvidenceQuality(result: ProductReferenceResult): string {
  const strong = result.products.filter((p) =>
    p.evidenceType === "OEM_PRODUCT_MATCH" || p.evidenceType === "OEM_PART_MATCH").length;
  if (strong >= 2) return "HIGH";
  if (strong === 1) return "MEDIUM";
  if (result.products.length > 0) return "LOW";
  return "UNKNOWN";
}

function computeConfidence(result: ProductReferenceResult): number {
  if (result.products.length === 0) return 0;
  const sum = result.products.reduce((acc, p) => acc + (p.confidence ?? 0), 0);
  return Math.round((sum / result.products.length) * 100) / 100;
}

// -------------------------------------------------------------------
// §10 idempotency key exposed for enqueue path
// -------------------------------------------------------------------

export function productResearchIdempotencyKey(key: NormalizedProductKey): string {
  return `product-reference:${key.normalizedKey}:${PRODUCT_REFERENCE_RESEARCH_VERSION}`;
}

// Prisma type re-export for consumers that need to construct a
// selective query without pulling Prisma directly.
export type ProductReferenceWhereInput = Prisma.ProductReferenceWhereInput;
