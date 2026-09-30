// DIM-2a (2026-09-29) — Read-only review helpers for a COA import
// batch's dimensional configuration.
//
// Consumers:
//   * the map-accounts preview page (batch-level summary card)
//   * DIM-2a acceptance tests (produce the review lists the founder
//     wants to see BEFORE committing the Master COA)
//
// Pure. Deterministic. No DB access — every input is already
// resolved. Callers assemble the input from
// `predictCoaBatch(rows, existingByNumber)` or from `ImportRow`
// rawJson bundles.

import type { CoaPrediction } from "./coa-predictor";
import type { DimensionPolicy } from "@/lib/accounting/dimension-policy-prediction";

// Per-row input: everything the review helpers need to classify a
// row. `accountNumber` + `name` are the identity; the rest are
// current proposals (from predictor or operator override).
export type CoaReviewInputRow = {
  accountNumber: string;
  name: string;
  type: CoaPrediction["type"];
  fsGroupKey: string;
  confidence: CoaPrediction["confidence"];
  source: CoaPrediction["source"];
  departmentPolicy: DimensionPolicy;
  fundPolicy: DimensionPolicy;
  fundApplicabilityKeys: string[];
  departmentApplicabilityCodes: string[]; // AccountDepartment codes selected in preview; [] when none
  // DIM-2b (2026-09-29) — review state (optional so existing
  // callers stay compatible). When undefined treat as `reviewed=false`.
  reviewed?: boolean;
};

// ---------------------------------------------------------------------------
// Batch-level summary card
// ---------------------------------------------------------------------------

export type CoaDimensionalReviewSummary = {
  totalRows: number;

  typeDistribution: Record<string, number>;
  confidenceDistribution: { high: number; medium: number; low: number };

  departmentPolicyDistribution: Record<DimensionPolicy, number>;
  fundPolicyDistribution: Record<DimensionPolicy, number>;

  fundKeysDistribution: Record<string, number>;
  rowsWithFundKeys: number;
  rowsWithoutFundKeys: number;

  /** Number of rows whose fundPolicy=REQUIRED AND fundApplicabilityKeys is empty. */
  fundPolicyRequiredWithoutApplicability: number;
  /** Number of rows whose departmentPolicy=REQUIRED AND no AccountDepartment applicability. */
  departmentPolicyRequiredWithoutApplicability: number;

  /** DIM-2b (2026-09-29) — operator explicitly reviewed (via edit
   *  or Mark Reviewed). Distinct from prediction confidence. */
  rowsReviewed: number;
  rowsNotReviewed: number;
  /** Medium-confidence rows the operator has NOT yet reviewed. */
  mediumConfidenceNotReviewed: number;

  /** Rows the founder should see before commit — combines low
   *  confidence, policy/applicability mismatches, and any signal
   *  the review lists flag. */
  rowsRequiringAttention: number;
};

// ---------------------------------------------------------------------------
// COA-UX-2c (2026-09-30) — Shared review / attention predicates.
//
// One authoritative source of truth for "does this row still need
// founder attention?", consumed by:
//   * the batch summary ribbon (`summariseCoaBatch`)
//   * client-side filters in BulkCoaReviewControls
//   * unit tests that guard the invariant `attention ≤ unreviewed`
//
// Attention here is REVIEW attention — advisory signals the operator
// should look at before committing. It is distinct from BLOCKING
// validation errors (missing classification, invalid Type→Category,
// etc.), which are surfaced through the ImportError table and NEVER
// suppressed by the `reviewed` flag.
// ---------------------------------------------------------------------------

/** True when the row was explicitly acknowledged by the operator. */
export function isReviewed(r: Pick<CoaReviewInputRow, "reviewed">): boolean {
  return r.reviewed === true;
}

/**
 * True when the row has at least one advisory condition the founder
 * should look at. Deliberately DOES NOT consult `reviewed` — that
 * gate lives in `needsAttention` so the same predicate can power
 * both the ribbon count (with the gate) and a "why is this row on
 * the attention list" tooltip (without it).
 */
export function hasAttentionCondition(
  r: Pick<CoaReviewInputRow, "confidence" | "departmentPolicy" | "fundPolicy" | "departmentApplicabilityCodes" | "fundApplicabilityKeys">,
): boolean {
  if (r.fundPolicy === "REQUIRED" && r.fundApplicabilityKeys.length === 0) return true;
  if (r.departmentPolicy === "REQUIRED" && r.departmentApplicabilityCodes.length === 0) return true;
  if (r.confidence === "medium") return true;
  if (r.confidence === "low") return true;
  return false;
}

/**
 * The single authoritative "does this row still need the founder's
 * attention" test. Ribbon count, review filter, and any acceptance
 * tests MUST call this — never re-implement.
 *
 * needsAttention(row) = !isReviewed(row) && hasAttentionCondition(row)
 */
export function needsAttention(r: CoaReviewInputRow): boolean {
  return !isReviewed(r) && hasAttentionCondition(r);
}

export function summariseCoaBatch(rows: ReadonlyArray<CoaReviewInputRow>): CoaDimensionalReviewSummary {
  const typeDistribution: Record<string, number> = {};
  const confidenceDistribution = { high: 0, medium: 0, low: 0 };
  const departmentPolicyDistribution: Record<DimensionPolicy, number> = {
    REQUIRED: 0, OPTIONAL: 0, NOT_APPLICABLE: 0,
  };
  const fundPolicyDistribution: Record<DimensionPolicy, number> = {
    REQUIRED: 0, OPTIONAL: 0, NOT_APPLICABLE: 0,
  };
  const fundKeysDistribution: Record<string, number> = {};
  let rowsWithFundKeys = 0;
  let rowsWithoutFundKeys = 0;
  let fundPolicyRequiredWithoutApplicability = 0;
  let departmentPolicyRequiredWithoutApplicability = 0;
  let rowsReviewed = 0;
  let mediumConfidenceNotReviewed = 0;
  const attentionSet = new Set<number>();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    typeDistribution[r.type] = (typeDistribution[r.type] ?? 0) + 1;
    confidenceDistribution[r.confidence] = (confidenceDistribution[r.confidence] ?? 0) + 1;
    departmentPolicyDistribution[r.departmentPolicy]++;
    fundPolicyDistribution[r.fundPolicy]++;
    if (r.fundApplicabilityKeys.length > 0) {
      rowsWithFundKeys++;
      const key = r.fundApplicabilityKeys.slice().sort().join(",");
      fundKeysDistribution[key] = (fundKeysDistribution[key] ?? 0) + 1;
    } else {
      rowsWithoutFundKeys++;
      fundKeysDistribution["(none)"] = (fundKeysDistribution["(none)"] ?? 0) + 1;
    }

    const reviewed = isReviewed(r);
    if (reviewed) rowsReviewed++;

    // Informational batch-health counters — count ALL rows meeting
    // the condition regardless of reviewed state. These are NOT the
    // Attention number; they're the underlying signal population.
    if (r.fundPolicy === "REQUIRED" && r.fundApplicabilityKeys.length === 0) {
      fundPolicyRequiredWithoutApplicability++;
    }
    if (r.departmentPolicy === "REQUIRED" && r.departmentApplicabilityCodes.length === 0) {
      departmentPolicyRequiredWithoutApplicability++;
    }
    if (r.confidence === "medium" && !reviewed) {
      mediumConfidenceNotReviewed++;
    }

    // COA-UX-2c (2026-09-30) — Attention now represents outstanding
    // founder-review work: a row contributes ONLY IF it has a real
    // attention condition AND has NOT yet been reviewed. Marking a
    // row Reviewed removes it from Attention. Invariant enforced by
    // tests: `attention ≤ (totalRows − rowsReviewed)`.
    if (needsAttention(r)) attentionSet.add(i);
  }

  return {
    totalRows: rows.length,
    typeDistribution,
    confidenceDistribution,
    departmentPolicyDistribution,
    fundPolicyDistribution,
    fundKeysDistribution,
    rowsWithFundKeys,
    rowsWithoutFundKeys,
    fundPolicyRequiredWithoutApplicability,
    departmentPolicyRequiredWithoutApplicability,
    rowsReviewed,
    rowsNotReviewed: rows.length - rowsReviewed,
    mediumConfidenceNotReviewed,
    rowsRequiringAttention: attentionSet.size,
  };
}

// ---------------------------------------------------------------------------
// CAPITAL review list
// ---------------------------------------------------------------------------
// Read-only analysis of which accounts SHOULD be reviewed for
// CAPITAL applicability. Never automatically assigns CAPITAL.
// Uses name + type + FS Group signals per DIM-2a Section 4.

const CAPITAL_FS_GROUPS: ReadonlySet<string> = new Set([
  "BS_CAPITAL_ASSETS",
  "BS_ACCUMULATED_DEPRECIATION",
  "BS_CAPITAL_RESERVE",
  "BS_LONG_TERM_DEBT",
  "BS_CAPITAL_LEASE",
  "BS_LONG_TERM_RECEIVABLES",
]);

const CAPITAL_NAME_TERMS: readonly RegExp[] = [
  /\bcapital\b/i,
  /\bassessment\b/i,
  /\bdeprecat/i,             // depreciation / depreciate
  /\bamortization\b/i,
  /\baccumulated\s+depre/i,
  /\breserve\s+fund\b/i,
  /\breserve\s+assessment\b/i,
  /\blong[\s-]?range/i,
  /\bfinancing\b/i,
  /\bcapital\s+contribution\b/i,
  /\bcapital\s+lease\b/i,
  /\bequipment\s+under\s+financing\b/i,
  /\bcapital\s+improvement\b/i,
  /\basset\s+disposal\b/i,
  /\bgain\s+on\s+sale\b/i,
  /\bloss\s+on\s+sale\b/i,
];

export type CoaCapitalReviewCandidate = CoaReviewInputRow & {
  reason: string;
};

export function capitalReviewCandidates(
  rows: ReadonlyArray<CoaReviewInputRow>,
): CoaCapitalReviewCandidate[] {
  const out: CoaCapitalReviewCandidate[] = [];
  for (const r of rows) {
    // Skip rows that already have CAPITAL in their proposed fund set.
    if (r.fundApplicabilityKeys.some((k) => k === "CAPITAL")) continue;
    const reasons: string[] = [];
    if (CAPITAL_FS_GROUPS.has(r.fsGroupKey)) {
      reasons.push(`FS Group ${r.fsGroupKey} suggests capital context`);
    }
    for (const re of CAPITAL_NAME_TERMS) {
      if (re.test(r.name)) {
        reasons.push(`Name matches capital-context term ${re}`);
        break;
      }
    }
    if (reasons.length > 0) {
      out.push({ ...r, reason: reasons.join("; ") });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// departmentPolicy=REQUIRED exception review
// ---------------------------------------------------------------------------
// Corporate-level accounts (interest, tax, gain/loss, etc.) that
// the predictor may have marked REQUIRED but usually aren't
// meaningfully departmental in a private-club setting.

const DEPT_QUESTIONABLE_NAME_TERMS: readonly RegExp[] = [
  /\binterest\b/i,
  /\btax\b/i,
  /\bgain\s+on/i,
  /\bloss\s+on/i,
  /\bpenalty\b/i,
  /\bfinancing\s+charge/i,
  /\bcapital\s+contribution/i,
];

const DEPT_QUESTIONABLE_FS_GROUPS: ReadonlySet<string> = new Set([
  "IS_INTEREST_INCOME",
  "IS_INTEREST_EXPENSE",
  "IS_INCOME_TAX",
  "IS_OTHER_INCOME",
  "IS_OTHER_EXPENSE",
  "IS_GAIN_LOSS_ON_SALE",
]);

export type CoaDeptExceptionRow = CoaReviewInputRow & {
  reason: string;
};

export function departmentPolicyExceptions(
  rows: ReadonlyArray<CoaReviewInputRow>,
): CoaDeptExceptionRow[] {
  const out: CoaDeptExceptionRow[] = [];
  for (const r of rows) {
    if (r.departmentPolicy !== "REQUIRED") continue;
    const reasons: string[] = [];
    if (DEPT_QUESTIONABLE_FS_GROUPS.has(r.fsGroupKey)) {
      reasons.push(`FS Group ${r.fsGroupKey} typically not departmental`);
    }
    for (const re of DEPT_QUESTIONABLE_NAME_TERMS) {
      if (re.test(r.name)) {
        reasons.push(`Name matches non-departmental term ${re}`);
        break;
      }
    }
    if (reasons.length > 0) {
      out.push({ ...r, reason: reasons.join("; ") });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// fundPolicy=REQUIRED but no Fund applicability review
// ---------------------------------------------------------------------------
// The most important integrity check: a REQUIRED policy paired with
// an empty applicability set means the account cannot legally have
// a fund assigned even though every posting must supply one.

export type CoaFundExceptionRow = CoaReviewInputRow & {
  reason: string;
};

export function fundPolicyRequiredWithoutApplicabilityRows(
  rows: ReadonlyArray<CoaReviewInputRow>,
): CoaFundExceptionRow[] {
  const out: CoaFundExceptionRow[] = [];
  for (const r of rows) {
    if (r.fundPolicy === "REQUIRED" && r.fundApplicabilityKeys.length === 0) {
      out.push({
        ...r,
        reason: "fundPolicy=REQUIRED but AccountFund applicability set is empty — every posting will fail validation",
      });
    }
  }
  return out;
}

export function departmentPolicyRequiredWithoutApplicabilityRows(
  rows: ReadonlyArray<CoaReviewInputRow>,
): CoaFundExceptionRow[] {
  const out: CoaFundExceptionRow[] = [];
  for (const r of rows) {
    if (r.departmentPolicy === "REQUIRED" && r.departmentApplicabilityCodes.length === 0) {
      out.push({
        ...r,
        reason: "departmentPolicy=REQUIRED but AccountDepartment applicability set is empty — technically unconstrained under DIM-1 but the operator should see this before commit",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// DIM-2b (2026-09-29) — filter primitives.
// ---------------------------------------------------------------------------
// Pure, composable predicates the bulk-review UI + tests use to
// isolate a working subset from the full 562-row batch.

export type CoaReviewFilter = {
  confidence?: ReadonlyArray<CoaReviewInputRow["confidence"]>;
  type?: ReadonlyArray<CoaReviewInputRow["type"]>;
  fsGroupKey?: ReadonlyArray<string>;
  departmentPolicy?: ReadonlyArray<DimensionPolicy>;
  fundPolicy?: ReadonlyArray<DimensionPolicy>;
  /** "NONE" → no AccountDepartment applicability; "SOME" → any applicability. */
  departmentApplicabilityState?: "NONE" | "SOME";
  /** "NONE" → no fund keys; "SOME" → any fund keys. */
  fundApplicabilityState?: "NONE" | "SOME";
  /** Filter by specific canonical fund key membership. */
  fundApplicabilityHasKey?: string;
  /** "REVIEWED" → operator confirmed; "NOT_REVIEWED" → still pending. */
  reviewState?: "REVIEWED" | "NOT_REVIEWED";
  /** true → row is in the CAPITAL review candidate set. */
  capitalReviewCandidate?: boolean;
  /** Search matches accountNumber OR name (case-insensitive substring). */
  search?: string;
};

function isCapitalCandidate(row: CoaReviewInputRow): boolean {
  // Delegate to capitalReviewCandidates on a single-row slice — the
  // helper filters out rows already tagged CAPITAL, so the client
  // can treat "already CAPITAL" as effectively out-of-list.
  return capitalReviewCandidates([row]).length > 0;
}

export function filterCoaBatch(
  rows: ReadonlyArray<CoaReviewInputRow>,
  filter: CoaReviewFilter,
): CoaReviewInputRow[] {
  const q = filter.search?.trim().toLowerCase() ?? "";
  return rows.filter((r) => {
    if (filter.confidence && filter.confidence.length > 0 && !filter.confidence.includes(r.confidence)) return false;
    if (filter.type && filter.type.length > 0 && !filter.type.includes(r.type)) return false;
    if (filter.fsGroupKey && filter.fsGroupKey.length > 0 && !filter.fsGroupKey.includes(r.fsGroupKey)) return false;
    if (filter.departmentPolicy && filter.departmentPolicy.length > 0 && !filter.departmentPolicy.includes(r.departmentPolicy)) return false;
    if (filter.fundPolicy && filter.fundPolicy.length > 0 && !filter.fundPolicy.includes(r.fundPolicy)) return false;
    if (filter.departmentApplicabilityState) {
      const hasSome = r.departmentApplicabilityCodes.length > 0;
      if (filter.departmentApplicabilityState === "NONE" && hasSome) return false;
      if (filter.departmentApplicabilityState === "SOME" && !hasSome) return false;
    }
    if (filter.fundApplicabilityState) {
      const hasSome = r.fundApplicabilityKeys.length > 0;
      if (filter.fundApplicabilityState === "NONE" && hasSome) return false;
      if (filter.fundApplicabilityState === "SOME" && !hasSome) return false;
    }
    if (filter.fundApplicabilityHasKey && !r.fundApplicabilityKeys.includes(filter.fundApplicabilityHasKey)) return false;
    if (filter.reviewState) {
      const isReviewed = r.reviewed === true;
      if (filter.reviewState === "REVIEWED" && !isReviewed) return false;
      if (filter.reviewState === "NOT_REVIEWED" && isReviewed) return false;
    }
    if (filter.capitalReviewCandidate !== undefined) {
      const isCand = isCapitalCandidate(r);
      if (filter.capitalReviewCandidate && !isCand) return false;
      if (!filter.capitalReviewCandidate && isCand) return false;
    }
    if (q.length > 0) {
      if (!r.accountNumber.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}
