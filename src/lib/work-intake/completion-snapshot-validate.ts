// Sprint 3 · Phase 4R Work Intake Completed-State Immutability
// (2026-08-15) — server-side validator for cardSnapshot values that
// arrive via the /api/work-intake/action HTTP body.
//
// Founder rule: "the client MAY compose the snapshot from the
// projection it just rendered, but the server MUST NOT trust arbitrary
// keys/values." This module enforces the whitelist: only the fields
// declared in CompletionCardSnapshot are accepted. Unknown keys are
// silently dropped. Invalid shapes return null (caller falls through
// to legacy path).
//
// Tenant/authorisation is enforced by resolveIntake / postAndClear
// upstream (they already load the WI with a workIntakeReadableByPrincipal
// guard). This module only sanitises the SHAPE of the snapshot payload
// — it must not be used as a security boundary on its own.

import {
  COMPLETION_CARD_SNAPSHOT_VERSION,
  type CompletionCardSnapshot,
  type CompletionCardSnapshotAllocation,
} from "./completion-snapshot";

// Total upper bound on serialised snapshot size. Prevents an
// unbounded client payload from becoming an unbounded metadataJson
// column.
const MAX_STRING_FIELD_LEN = 500;
const MAX_ALLOCATIONS = 32;

function optionalString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_STRING_FIELD_LEN);
}

function optionalNumber(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}

function optionalBoolean(v: unknown): boolean | null {
  if (typeof v !== "boolean") return null;
  return v;
}

function validateAllocation(raw: unknown): CompletionCardSnapshotAllocation | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return {
    accountNumber: optionalString(r.accountNumber),
    accountName: optionalString(r.accountName),
    amount: optionalNumber(r.amount),
    taxTreatment: optionalString(r.taxTreatment),
    taxRate: optionalNumber(r.taxRate),
    taxAmount: optionalNumber(r.taxAmount),
    confidence: optionalNumber(r.confidence),
    requiresReview: optionalBoolean(r.requiresReview),
  };
}

/** Accept a client-supplied cardSnapshot value and return the sanitised
 *  shape (or null if invalid). Never throws. Never trusts unknown keys.
 *  Never allows a snapshotVersion that doesn't match the current
 *  contract — future-proofing against a rogue client stamping an
 *  arbitrary version tag. */
export function validateCardSnapshotFromClient(
  raw: unknown,
): CompletionCardSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  // Insist on a matching snapshotVersion. If the client stamps a
  // different value the server treats the payload as absent — the
  // legacy fallback kicks in and the completion still succeeds.
  if (r.snapshotVersion !== COMPLETION_CARD_SNAPSHOT_VERSION) return null;

  const allocationsRaw = Array.isArray(r.allocations) ? r.allocations : null;
  const allocations: CompletionCardSnapshotAllocation[] | null = allocationsRaw
    ? allocationsRaw
        .slice(0, MAX_ALLOCATIONS)
        .map(validateAllocation)
        .filter((a): a is CompletionCardSnapshotAllocation => a !== null)
    : null;

  return {
    snapshotVersion: COMPLETION_CARD_SNAPSHOT_VERSION,
    analysisVersion: optionalString(r.analysisVersion),
    supplierDisplayName: optionalString(r.supplierDisplayName),
    vendorId: optionalString(r.vendorId),
    vendorDisplayName: optionalString(r.vendorDisplayName),
    vendorMatchState: optionalString(r.vendorMatchState),
    invoiceNumber: optionalString(r.invoiceNumber),
    invoiceDate: optionalString(r.invoiceDate),
    dueDate: optionalString(r.dueDate),
    subtotal: optionalNumber(r.subtotal),
    taxTotal: optionalNumber(r.taxTotal),
    total: optionalNumber(r.total),
    currency: optionalString(r.currency),
    purchaseOrder: optionalString(r.purchaseOrder),
    categoryLabel: optionalString(r.categoryLabel),
    glAccountNumber: optionalString(r.glAccountNumber),
    glAccountName: optionalString(r.glAccountName),
    allocations,
    confidenceLabel: optionalString(r.confidenceLabel),
    workflowState: optionalString(r.workflowState),
    recommendationSummary: optionalString(r.recommendationSummary),
    completionType: optionalString(r.completionType),
    completedByUserId: null,           // server always stamps this from principal
    completedAt: null,                 // server always stamps this at write time
  };
}
