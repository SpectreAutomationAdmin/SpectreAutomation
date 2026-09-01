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

export const YtdSnapshot = z.discriminatedUnion("schemaVersion", [YtdSnapshotV1]);
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
