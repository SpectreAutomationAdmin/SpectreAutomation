// Payroll-3B-5A (2026-08-31) — strict runtime schema for the
// `PayrollBatchEmployee.sourceFactsJson` blob.
//
// The 3B-4 checkpoint identified that this blob was TypeScript-
// documented but not runtime-enforced. Fixed here BEFORE the future
// calculator depends on it. Every write MUST validate through
// `assertValidSourceFactsV1`; every read MUST parse through
// `parseSourceFactsV1`. Rejection is loud — the calculator will
// never silently consume a malformed blob.
//
// Every source-facts version carries an explicit `schemaVersion`
// discriminator so a future evolution can add a v2 shape and the
// calculator can decide per-batch whether it understands the
// on-disk payload.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const IsoDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "not an ISO date" });

const DecimalString = z
  .string()
  .refine((s) => /^-?\d+(\.\d+)?$/.test(s), { message: "not a decimal string" });

// ---------------------------------------------------------------------------
// v1 — the current source-facts contract.
// ---------------------------------------------------------------------------

export const SourceFactsAssignmentV1 = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  departmentId: z.string().nullable(),
  positionId: z.string().nullable(),
  employmentType: z.string().min(1),
  effectiveFrom: IsoDate,
  effectiveTo: IsoDate.nullable(),
});
export type SourceFactsAssignmentV1 = z.infer<typeof SourceFactsAssignmentV1>;

export const SourceFactsCompensationV1 = z.object({
  id: z.string().min(1),
  assignmentId: z.string().nullable(),
  /** HOURLY | SALARY | COMMISSION | PIECE_RATE (upper-cased at snapshot). */
  payType: z.string().min(1),
  /** Non-null only when `payType === "HOURLY"`. Decimal string. */
  hourlyRate: DecimalString.nullable(),
  /** Non-null only when `payType === "SALARY"`. Decimal string. */
  annualSalary: DecimalString.nullable(),
  effectiveFrom: IsoDate,
  effectiveTo: IsoDate.nullable(),
});
export type SourceFactsCompensationV1 = z.infer<typeof SourceFactsCompensationV1>;

export const SourceFactsAllowanceV1 = z.object({
  id: z.string().min(1),
  assignmentId: z.string().nullable(),
  allowanceType: z.string().min(1),
  /** Decimal string in Employee's currency. Not converted. */
  amount: DecimalString,
  /** Source frequency (e.g. PER_PAY_PERIOD / MONTHLY / ANNUAL). */
  frequency: z.string().min(1),
  taxable: z.boolean(),
  effectiveFrom: IsoDate,
  effectiveTo: IsoDate.nullable(),
});
export type SourceFactsAllowanceV1 = z.infer<typeof SourceFactsAllowanceV1>;

/**
 * Payroll-3B-5A (2026-08-31) — coverage window: the intersection
 * of the Employee's Pay Group membership with the Pay Period.
 *
 * When an Employee transfers Pay Groups mid-period, each Batch
 * carries the correct fractional coverage. The future calculator
 * MUST honour this window when prorating salary — treating the
 * full pay-period fraction of an annualised salary would risk
 * duplicate pay across the two batches.
 */
export const SourceFactsCoverageV1 = z.object({
  /** Membership window on the parent Pay Group, half-open. */
  membershipEffectiveFrom: IsoDate,
  membershipEffectiveTo: IsoDate.nullable(),
  /** Pay Period ∩ membership. Always bounded within the period. */
  coverageStart: IsoDate,
  coverageEnd: IsoDate, // period end is always bounded
  /** Number of civil days covered by this batch. */
  coverageDays: z.number().int().nonnegative(),
  /** Number of civil days in the parent Pay Period. */
  periodDays: z.number().int().positive(),
  /** True when this batch covers the entire Pay Period. */
  isFullPeriod: z.boolean(),
});
export type SourceFactsCoverageV1 = z.infer<typeof SourceFactsCoverageV1>;

/**
 * Payroll-3B-5B-1a (2026-08-31) — frozen Employee identity facts
 * the future calculator needs beyond the coverage window. DOB is
 * required for CPP age eligibility (see
 * `src/lib/payroll/statutory/cpp-eligibility.ts`). `dateOfBirth`
 * is nullable to accommodate legacy Employees imported before DOB
 * was collected — a null triggers a MISSING_DATE_OF_BIRTH BLOCKER
 * during preparation.
 */
export const SourceFactsIdentityV1 = z.object({
  dateOfBirth: IsoDate.nullable(),
});
export type SourceFactsIdentityV1 = z.infer<typeof SourceFactsIdentityV1>;

/**
 * Payroll-3B-5B-2c (2026-09-02) — frozen TD1 / tax source facts.
 *
 * Every value here is captured from `EmployeeTaxProfile` at
 * preparation time and NEVER refreshed. A later live-TD1 mutation
 * cannot alter an existing prepared batch — the operational
 * correction is `VOID → correct source → PREPARE replacement`.
 *
 * The block is OPTIONAL at the Zod level for backward compatibility
 * with V1 blobs written before 2c landed (there are none in
 * production, but the calculator degrades to defaults if any exists).
 * Batch preparation ALWAYS emits it from 2c onward.
 *
 * SIN and banking information are never captured here — those live
 * on the operational HR models and are read only when a downstream
 * slice actually needs to emit them (payment file, T4, etc.).
 */
export const SourceFactsTaxV1 = z.object({
  /** Federal TD1 total claim amount, cents-precise Decimal string. */
  federalClaim:                DecimalString,
  /** Alberta TD1 total claim amount. */
  provincialClaim:             DecimalString,
  /** TD1 "more than one employer / payer" election — federal side. */
  claimZeroFederal:            z.boolean(),
  /** Alberta TD1 equivalent. */
  claimZeroProvincial:         z.boolean(),
  /** TD1 "no tax withheld" attestation — total income less than total claim. */
  totalIncomeLessThanClaim:    z.boolean(),
  /** Additional federal tax the employee has requested per pay period. */
  additionalFederalTaxAmount:  DecimalString,
  /** Additional Alberta tax the employee has requested per pay period. */
  additionalProvincialTaxAmount: DecimalString,
});
export type SourceFactsTaxV1 = z.infer<typeof SourceFactsTaxV1>;

/** Sensible default when no `EmployeeTaxProfile` was on file at prep. */
export const DEFAULT_TAX_FACTS_V1: SourceFactsTaxV1 = {
  federalClaim:                  "0",
  provincialClaim:               "0",
  claimZeroFederal:              false,
  claimZeroProvincial:           false,
  totalIncomeLessThanClaim:      false,
  additionalFederalTaxAmount:    "0",
  additionalProvincialTaxAmount: "0",
};

export const PayrollBatchSourceFactsV1 = z.object({
  schemaVersion: z.literal(1),
  coverage: SourceFactsCoverageV1,
  identity: SourceFactsIdentityV1,
  assignments: z.array(SourceFactsAssignmentV1),
  compensations: z.array(SourceFactsCompensationV1),
  allowances: z.array(SourceFactsAllowanceV1),
  /**
   * Payroll-3B-5B-2c — optional for backward compatibility with any
   * pre-2c V1 blob; parser fills with DEFAULT_TAX_FACTS_V1. Batch
   * preparation always emits an explicit tax block from 2c onward.
   */
  tax: SourceFactsTaxV1.optional(),
});
export type PayrollBatchSourceFactsV1 = z.infer<typeof PayrollBatchSourceFactsV1>;

/**
 * Discriminated over `schemaVersion` — future v2 shapes get added
 * to the union without a breaking change to callers.
 */
export const PayrollBatchSourceFacts = z.discriminatedUnion("schemaVersion", [
  PayrollBatchSourceFactsV1,
]);
export type PayrollBatchSourceFacts = z.infer<typeof PayrollBatchSourceFacts>;

// ---------------------------------------------------------------------------
// Validation entry points
// ---------------------------------------------------------------------------

export class InvalidSourceFactsError extends Error {
  readonly issues: z.ZodIssue[];
  constructor(message: string, issues: z.ZodIssue[]) {
    super(message);
    this.name = "InvalidSourceFactsError";
    this.issues = issues;
  }
}

/** Called immediately BEFORE writing the JSON blob to Postgres. */
export function assertValidSourceFactsV1(facts: unknown): asserts facts is PayrollBatchSourceFactsV1 {
  const r = PayrollBatchSourceFactsV1.safeParse(facts);
  if (!r.success) {
    throw new InvalidSourceFactsError(
      `PayrollBatchSourceFactsV1 rejected: ${r.error.issues.length} issue(s)`,
      r.error.issues,
    );
  }
}

/** Called immediately AFTER reading the JSON blob from Postgres. */
export function parseSourceFactsV1(raw: string | null | undefined): PayrollBatchSourceFactsV1 | null {
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new InvalidSourceFactsError("PayrollBatchSourceFactsV1 rejected: not JSON", []);
  }
  const r = PayrollBatchSourceFactsV1.safeParse(json);
  if (!r.success) {
    throw new InvalidSourceFactsError(
      `PayrollBatchSourceFactsV1 rejected: ${r.error.issues.length} issue(s)`,
      r.error.issues,
    );
  }
  return r.data;
}
