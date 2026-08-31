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

export const PayrollBatchSourceFactsV1 = z.object({
  schemaVersion: z.literal(1),
  coverage: SourceFactsCoverageV1,
  assignments: z.array(SourceFactsAssignmentV1),
  compensations: z.array(SourceFactsCompensationV1),
  allowances: z.array(SourceFactsAllowanceV1),
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
