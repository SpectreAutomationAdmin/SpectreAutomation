// Payroll-3B-5B-2a (2026-08-31) — canonical BLOCKER / WARNING codes
// emitted by the calculation readiness service.
//
// Every code here is a permanent contract that the future
// gross-to-net calculator (3B-5B-2b, 3B-5B-2c) refuses to bypass.
// Silent zero-fallbacks are prohibited — a source-fact the MVP
// cannot handle MUST surface here as a BLOCKER so the Payroll
// Admin sees exactly which employee is not calculable and why.
//
// Codes are string constants (not a TS enum) so the underlying
// `PayrollBatchException.code String` column keeps the same shape
// across the batch-preparation and calculation-readiness services.

// ---------------------------------------------------------------------------
// Statutory-input BLOCKERs — T4127 source facts the MVP does not
// support. Presence of any of these on an employee means the
// calculator cannot produce a correct T4127-conformant result yet.
// ---------------------------------------------------------------------------

export const UNSUPPORTED_RPP_DEDUCTION       = "UNSUPPORTED_RPP_DEDUCTION";
export const UNSUPPORTED_ALIMONY_DEDUCTION   = "UNSUPPORTED_ALIMONY_DEDUCTION";
export const UNSUPPORTED_ANNUAL_DEDUCTION    = "UNSUPPORTED_ANNUAL_DEDUCTION";
export const UNSUPPORTED_UNION_DUES          = "UNSUPPORTED_UNION_DUES";
export const UNSUPPORTED_PRESCRIBED_ZONE     = "UNSUPPORTED_PRESCRIBED_ZONE";

// ---------------------------------------------------------------------------
// Structural BLOCKERs — the input shape the calculator needs is not
// yet satisfied. Distinct from batch-preparation blockers (which
// live in `batch-preparation.ts`); these fire specifically at the
// calculation-readiness boundary.
// ---------------------------------------------------------------------------

/** No statutory package resolves for (country, province, payDate). */
export const STATUTORY_PACKAGE_UNRESOLVED    = "STATUTORY_PACKAGE_UNRESOLVED";

/**
 * Batch is not in a state the calculator can consume. Typical cases:
 *   - DRAFT (must be PREPARED first)
 *   - POSTED (immutable — never recalculable)
 *   - VOIDED (must be re-prepared as a new batch)
 */
export const INVALID_BATCH_LIFECYCLE         = "INVALID_BATCH_LIFECYCLE";

/**
 * A salaried employee's coverage is a strict subset of the pay period
 * (mid-period hire, termination, pay-group transfer, assignment
 * change). No Spectre salary-proration policy has been founder-
 * approved; the calculator refuses rather than silently applying
 * calendar-day proration and risking double pay.
 */
export const SALARY_PRORATION_POLICY_REQUIRED = "SALARY_PRORATION_POLICY_REQUIRED";

/**
 * A snapshotted allowance carries an unsupported frequency. The
 * supported set for the MVP is PER_PAY_PERIOD / MONTHLY / BIWEEKLY /
 * WEEKLY / ANNUAL / ONE_TIME. Anything else refuses rather than
 * silently annualising with a guess.
 */
export const UNSUPPORTED_ALLOWANCE_FREQUENCY = "UNSUPPORTED_ALLOWANCE_FREQUENCY";

/**
 * A snapshotted allowance has null or ambiguous taxable / pensionable
 * / insurable classification. The three flags are independent per
 * §18 of the calculator spec — silent assumptions would corrupt
 * bases in a way T4 reporting cannot recover from.
 */
export const MISSING_ALLOWANCE_CLASSIFICATION = "MISSING_ALLOWANCE_CLASSIFICATION";

/**
 * A snapshotted earning uses an `earningType` outside the MVP-
 * supported set (REGULAR, SALARY, OVERTIME, VACATION, STAT_HOLIDAY
 * calculated by future slices). BONUS / COMMISSION / RETRO_PAY are
 * out of MVP scope; they surface here rather than being computed
 * as regular income.
 */
export const UNSUPPORTED_EARNING_TYPE        = "UNSUPPORTED_EARNING_TYPE";

/**
 * An hourly employee's `PayrollBatchEmployee` has draft or
 * unapproved time entries attached (not carried through the
 * canonical `PayrollApprovedTimeEntry` bridge). No unapproved
 * time may enter the calculation input.
 */
export const DRAFT_TIME_ENTRIES_PRESENT      = "DRAFT_TIME_ENTRIES_PRESENT";

// ---------------------------------------------------------------------------
// WARNING codes — do not block calculation but should be surfaced
// to the Payroll Admin.
// ---------------------------------------------------------------------------

export const NO_APPROVED_HOURS_FOR_HOURLY    = "NO_APPROVED_HOURS_FOR_HOURLY";

// ---------------------------------------------------------------------------
// Consolidated list — every BLOCKER code the readiness service can
// emit. Kept explicit so a future contributor sees the complete
// contract without grepping.
// ---------------------------------------------------------------------------

export const CALCULATION_BLOCKER_CODES = [
  UNSUPPORTED_RPP_DEDUCTION,
  UNSUPPORTED_ALIMONY_DEDUCTION,
  UNSUPPORTED_ANNUAL_DEDUCTION,
  UNSUPPORTED_UNION_DUES,
  UNSUPPORTED_PRESCRIBED_ZONE,
  STATUTORY_PACKAGE_UNRESOLVED,
  INVALID_BATCH_LIFECYCLE,
  SALARY_PRORATION_POLICY_REQUIRED,
  UNSUPPORTED_ALLOWANCE_FREQUENCY,
  MISSING_ALLOWANCE_CLASSIFICATION,
  UNSUPPORTED_EARNING_TYPE,
  DRAFT_TIME_ENTRIES_PRESENT,
] as const;

export type CalculationBlockerCode = (typeof CALCULATION_BLOCKER_CODES)[number];

/**
 * MVP-supported earning types. Anything else on
 * `PayrollBatchEarning.earningType` triggers UNSUPPORTED_EARNING_TYPE.
 * The set is intentionally small — later slices add BONUS /
 * COMMISSION / RETRO_PAY behind their own founder-approved policies.
 */
export const MVP_SUPPORTED_EARNING_TYPES = new Set([
  "REGULAR",
  "SALARY",
  "OVERTIME",
  "VACATION",
  "STAT_HOLIDAY",
]);

/**
 * Allowance frequencies the calculator's per-period annualisation
 * knows how to handle. Anything else on
 * `PayrollBatchAllowanceSnapshot.frequency` triggers
 * UNSUPPORTED_ALLOWANCE_FREQUENCY.
 */
export const MVP_SUPPORTED_ALLOWANCE_FREQUENCIES = new Set([
  "PER_PAY_PERIOD",
  "MONTHLY",
  "BIWEEKLY",
  "WEEKLY",
  "ANNUAL",
  "ONE_TIME",
]);
