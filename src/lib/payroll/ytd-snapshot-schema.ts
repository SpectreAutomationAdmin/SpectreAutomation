// Payroll-3B-5B-2b (2026-09-01) — strict runtime schema for the
// per-employee `PayrollBatchEmployee.ytdSnapshotJson` blob.
//
// The blob freezes the exact YTD input the 2b calculator used at
// calculation time so the result stays fully explainable even
// after later opening-balance corrections or POSTED-batch VOID +
// re-post cycles.
//
// Discriminated by `schemaVersion` so a v2 shape can be added
// additively without breaking calculators that only understand v1.

import { z } from "zod";

const DecimalString = z
  .string()
  .refine((s) => /^-?\d+(\.\d+)?$/.test(s), { message: "not a decimal string" });

const IsoDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "not an ISO date" });

export const YtdSnapshotV1 = z.object({
  schemaVersion: z.literal(1),
  asOfPayDate:   IsoDate,
  taxYear:       z.number().int(),
  sources: z.object({
    openingBalanceId:               z.string().nullable(),
    openingBalancePriorPayrollKind: z.string().nullable(),
    postedBatchIds:                 z.array(z.string()),
  }),
  ytdGrossEarnings:       DecimalString,
  ytdTaxableEarnings:     DecimalString,
  ytdPensionableEarnings: DecimalString,
  ytdInsurableEarnings:   DecimalString,
  ytdCppEE_Base:          DecimalString,
  ytdCppEE_FirstAdd:      DecimalString,
  ytdCppEE:               DecimalString,
  ytdCpp2EE:              DecimalString,
  ytdEiEE:                DecimalString,
  ytdFederalTax:          DecimalString,
  ytdProvincialTax:       DecimalString,
  ytdCppER_Base:          DecimalString,
  ytdCppER_FirstAdd:      DecimalString,
  ytdCppER:               DecimalString,
  ytdCpp2ER:              DecimalString,
  ytdEiER:                DecimalString,
});
export type YtdSnapshotV1 = z.infer<typeof YtdSnapshotV1>;

// FPP-8B (2026-09-22) — schema v2 adds per-component YTD context.
//
// Component identity: `componentCode` is the stable domain identity —
// PayrollComponent has `@@unique([clubId, code])`, and every historical
// evidence row (PayrollOpeningBalanceComponent + PayrollBatchComponentSnapshot)
// freezes the code. `sourceComponentId` may be null on legacy opening
// rows imported before the club's PayrollComponent registry was built,
// so keying by id causes opening YTD to silently split from batch YTD.
//
// componentYtd is deterministic (sorted ascending by componentCode) so
// the canonical JSON canonicaliser produces a stable calculationFingerprint.
export const YtdComponentEntry = z.object({
  componentCode:      z.string(),
  displayName:        z.string(),
  category:           z.string(),
  side:               z.enum(["EMPLOYEE", "EMPLOYER"]),
  cashEffect:         z.enum(["INCREASES_NET_PAY", "DECREASES_NET_PAY", "NO_NET_PAY_EFFECT"]),
  /** Prior YTD (opening + qualifying POSTED history) BEFORE the current payroll. */
  ytdBefore:          DecimalString,
  /** Current payroll amount for this component (0 if not present on current). */
  currentAmount:      DecimalString,
  /** ytdBefore + currentAmount — YTD as of and including the current payroll. */
  ytdIncludingCurrent: DecimalString,
});
export type YtdComponentEntry = z.infer<typeof YtdComponentEntry>;

export const YtdSnapshotV2 = z.object({
  schemaVersion: z.literal(2),
  asOfPayDate:   IsoDate,
  taxYear:       z.number().int(),
  sources: z.object({
    openingBalanceId:               z.string().nullable(),
    openingBalancePriorPayrollKind: z.string().nullable(),
    postedBatchIds:                 z.array(z.string()),
    componentSourceRefs:            z.array(z.string()).default([]),
  }),
  ytdGrossEarnings:       DecimalString,
  ytdTaxableEarnings:     DecimalString,
  ytdPensionableEarnings: DecimalString,
  ytdInsurableEarnings:   DecimalString,
  ytdCppEE_Base:          DecimalString,
  ytdCppEE_FirstAdd:      DecimalString,
  ytdCppEE:               DecimalString,
  ytdCpp2EE:              DecimalString,
  ytdEiEE:                DecimalString,
  ytdFederalTax:          DecimalString,
  ytdProvincialTax:       DecimalString,
  ytdCppER_Base:          DecimalString,
  ytdCppER_FirstAdd:      DecimalString,
  ytdCppER:               DecimalString,
  ytdCpp2ER:              DecimalString,
  ytdEiER:                DecimalString,
  /**
   * Per-component YTD context used by the calculator. Each entry
   * represents the YTD state (before + current + inclusive) frozen at
   * Calculate time. Sorted ascending by componentCode for determinism.
   */
  componentYtd: z.array(YtdComponentEntry),
});
export type YtdSnapshotV2 = z.infer<typeof YtdSnapshotV2>;

export const YtdSnapshot = z.discriminatedUnion("schemaVersion", [YtdSnapshotV1, YtdSnapshotV2]);
export type YtdSnapshot = z.infer<typeof YtdSnapshot>;

export function assertValidYtdSnapshotV1(v: unknown): asserts v is YtdSnapshotV1 {
  const r = YtdSnapshotV1.safeParse(v);
  if (!r.success) throw new Error(`YtdSnapshotV1 rejected: ${r.error.issues.length} issue(s)`);
}

export function parseYtdSnapshotV1(raw: string | null | undefined): YtdSnapshotV1 | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  const r = YtdSnapshotV1.safeParse(parsed);
  return r.success ? r.data : null;
}

export function assertValidYtdSnapshotV2(v: unknown): asserts v is YtdSnapshotV2 {
  const r = YtdSnapshotV2.safeParse(v);
  if (!r.success) throw new Error(`YtdSnapshotV2 rejected: ${r.error.issues.length} issue(s)`);
}

export function parseYtdSnapshotV2(raw: string | null | undefined): YtdSnapshotV2 | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  const r = YtdSnapshotV2.safeParse(parsed);
  return r.success ? r.data : null;
}

/**
 * Discriminated parser — returns V1 or V2 based on schemaVersion.
 * Legacy v1 snapshots continue to parse without modification; only
 * newly-calculated payrolls after FPP-8B produce v2 shapes.
 */
export function parseYtdSnapshot(raw: string | null | undefined): YtdSnapshot | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  const r = YtdSnapshot.safeParse(parsed);
  return r.success ? r.data : null;
}
