// FPP-9B.1 (2026-09-22) — Calculation fingerprint.
//
// Distinct from `packageChecksum`, which identifies the STATUTORY PACKAGE
// (CRA T4127 tables + algorithm version). Two payrolls that legitimately
// use the same package share the same `packageChecksum`. That is correct.
//
// `calculationFingerprint` answers the DIFFERENT question:
//     "What exact frozen payroll calculation was approved and posted?"
//
// It is a deterministic SHA-256 over a canonical JSON representation of
// the material frozen state of a PayrollBatch. Two batches with the same
// package but different inputs (a corrected salary, an added allowance,
// a different employee, a different pay date) produce DIFFERENT
// fingerprints. Two batches with logically-equivalent state (same
// inputs, same outputs, differing only in object-key ordering) produce
// IDENTICAL fingerprints.
//
// -----------------------------------------------------------------------
// § Fingerprint coverage (deterministic)
// -----------------------------------------------------------------------
//
// The fingerprint is computed over a canonicalised object with these
// fields, sorted lexically at every level; Decimals normalised to
// fixed 4-decimal strings; nulls preserved:
//
//   batch:
//     transactionType, statutoryPackageId, algorithmVersion,
//     packageChecksum, calculationVersion,
//     payGroupId, payPeriodId (identity of what was calculated for),
//     reversesPayrollBatchId, correctsPayrollBatchId,
//     pairedReversalBatchId
//   employees[] (sorted by employeeId, one row per included employee):
//     employeeId, jurisdictionCountry, jurisdictionProvince, salaried,
//     employeeLifecycleAtPrep, status,
//     sourceFactsJson (parsed + canonicalised, or null),
//     ytdSnapshotJson (parsed + canonicalised, or null),
//     Every calculated Decimal (grossPay, netPay, taxable, pensionable,
//       insurable, CPP base/firstAdd/combined, CPP2, EI, federal tax,
//       provincial tax, additional federal, additional provincial,
//       employer CPP base/firstAdd/combined, employer CPP2, employer EI,
//       totalEmployeeDeductions, additionalFederalTax,
//       additionalProvincialTax)
//   componentSnapshots[] (sorted by (employeeId, componentCode)):
//     componentCode, category, side, cashEffect, resolvedAmount,
//     eligibleEarningsAmount, sourcePercentBps
//
// EXCLUDED (deliberately):
//   • row ids (`id` on PayrollBatch, PayrollBatchEmployee, snapshots)
//     — identity is derived from the calculation content, not the row PK.
//   • timestamps (createdAt, updatedAt, preparedAt, calculatedAt,
//     approvedAt, postedAt) — the fingerprint should not change simply
//     because the batch was posted later.
//   • actor user ids (preparedByUserId, submittedByUserId, etc.)
//     — actors are audited elsewhere; they do not change WHAT was
//     calculated.
//   • JournalEntry / GL adapter output — the JE is DERIVED from the
//     frozen calculation; hashing it in would circularly depend on POST.
//
// If any calculation input is added to Spectre in the future that
// materially affects the frozen payroll, add it explicitly to
// `canonicaliseBatch`. Do not silently include unrelated fields.

import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";

/** Normalise a Prisma.Decimal-like value to a canonical fixed-precision string. */
function normDecimal(v: Prisma.Decimal | string | number | null | undefined): string | null {
  if (v == null) return null;
  const dec = v instanceof Prisma.Decimal ? v : new Prisma.Decimal(v);
  return dec.toFixed(4); // internal precision, dollar-level use gets rounded elsewhere
}

/** Deep canonicalise an unknown JSON-shaped value: sort object keys, walk arrays. */
function canonicalise(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicalise);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = canonicalise(obj[key]);
    }
    return sorted;
  }
  return value;
}

/** Canonicalise an arbitrary JSON string (like sourceFactsJson) — parse, canonicalise, or return null. */
function canoniseJsonString(s: string | null | undefined): unknown {
  if (s == null || s === "") return null;
  try {
    return canonicalise(JSON.parse(s));
  } catch {
    // If the persisted string is not JSON (defensive), hash it verbatim.
    return { __rawInvalidJson: s };
  }
}

type BatchLike = {
  transactionType: string;
  statutoryPackageId: string | null;
  algorithmVersion: string | null;
  packageChecksum: string | null;
  calculationVersion: number;
  payGroupId: string;
  payPeriodId: string;
  reversesPayrollBatchId: string | null;
  correctsPayrollBatchId: string | null;
  pairedReversalBatchId: string | null;
};

type BatchEmployeeLike = {
  employeeId: string;
  jurisdictionCountry: string;
  jurisdictionProvince: string | null;
  salaried: boolean;
  employeeLifecycleAtPrep: string;
  status: string;
  sourceFactsJson: string | null;
  ytdSnapshotJson: string | null;
  grossPay: Prisma.Decimal | null;
  netPay: Prisma.Decimal | null;
  earningsTaxable: Prisma.Decimal | null;
  earningsPensionable: Prisma.Decimal | null;
  earningsInsurable: Prisma.Decimal | null;
  deductionCppEeBase: Prisma.Decimal | null;
  deductionCppEeFirstAdd: Prisma.Decimal | null;
  deductionCppEeCombined: Prisma.Decimal | null;
  deductionCpp2Ee: Prisma.Decimal | null;
  deductionEiEe: Prisma.Decimal | null;
  deductionFederalTax: Prisma.Decimal | null;
  deductionProvincialTax: Prisma.Decimal | null;
  additionalFederalTax: Prisma.Decimal | null;
  additionalProvincialTax: Prisma.Decimal | null;
  totalEmployeeDeductions: Prisma.Decimal | null;
  employerCppBase: Prisma.Decimal | null;
  employerCppFirstAdd: Prisma.Decimal | null;
  employerCppCombined: Prisma.Decimal | null;
  employerCpp2: Prisma.Decimal | null;
  employerEi: Prisma.Decimal | null;
};

type ComponentSnapshotLike = {
  employeeId: string;
  componentCode: string;
  category: string;
  side: string;
  cashEffect: string;
  resolvedAmount: Prisma.Decimal | null;
  eligibleEarningsAmount: Prisma.Decimal | null;
  sourcePercentBps: number | null;
};

/** Build the canonical fingerprint input object. */
export function canoniseBatch(input: {
  batch: BatchLike;
  employees: BatchEmployeeLike[];
  componentSnapshots: ComponentSnapshotLike[];
}) {
  const canonicalBatch = {
    transactionType: input.batch.transactionType,
    statutoryPackageId: input.batch.statutoryPackageId,
    algorithmVersion: input.batch.algorithmVersion,
    packageChecksum: input.batch.packageChecksum,
    calculationVersion: input.batch.calculationVersion,
    payGroupId: input.batch.payGroupId,
    payPeriodId: input.batch.payPeriodId,
    reversesPayrollBatchId: input.batch.reversesPayrollBatchId,
    correctsPayrollBatchId: input.batch.correctsPayrollBatchId,
    pairedReversalBatchId: input.batch.pairedReversalBatchId,
  };
  const canonicalEmployees = [...input.employees]
    .sort((a, b) => a.employeeId.localeCompare(b.employeeId))
    .map((e) => ({
      employeeId: e.employeeId,
      jurisdictionCountry: e.jurisdictionCountry,
      jurisdictionProvince: e.jurisdictionProvince,
      salaried: e.salaried,
      employeeLifecycleAtPrep: e.employeeLifecycleAtPrep,
      status: e.status,
      sourceFacts: canoniseJsonString(e.sourceFactsJson),
      ytdSnapshot: canoniseJsonString(e.ytdSnapshotJson),
      grossPay: normDecimal(e.grossPay),
      netPay: normDecimal(e.netPay),
      earningsTaxable: normDecimal(e.earningsTaxable),
      earningsPensionable: normDecimal(e.earningsPensionable),
      earningsInsurable: normDecimal(e.earningsInsurable),
      deductionCppEeBase: normDecimal(e.deductionCppEeBase),
      deductionCppEeFirstAdd: normDecimal(e.deductionCppEeFirstAdd),
      deductionCppEeCombined: normDecimal(e.deductionCppEeCombined),
      deductionCpp2Ee: normDecimal(e.deductionCpp2Ee),
      deductionEiEe: normDecimal(e.deductionEiEe),
      deductionFederalTax: normDecimal(e.deductionFederalTax),
      deductionProvincialTax: normDecimal(e.deductionProvincialTax),
      additionalFederalTax: normDecimal(e.additionalFederalTax),
      additionalProvincialTax: normDecimal(e.additionalProvincialTax),
      totalEmployeeDeductions: normDecimal(e.totalEmployeeDeductions),
      employerCppBase: normDecimal(e.employerCppBase),
      employerCppFirstAdd: normDecimal(e.employerCppFirstAdd),
      employerCppCombined: normDecimal(e.employerCppCombined),
      employerCpp2: normDecimal(e.employerCpp2),
      employerEi: normDecimal(e.employerEi),
    }));
  const canonicalComponents = [...input.componentSnapshots]
    .sort((a, b) => a.employeeId.localeCompare(b.employeeId) || a.componentCode.localeCompare(b.componentCode))
    .map((s) => ({
      employeeId: s.employeeId,
      componentCode: s.componentCode,
      category: s.category,
      side: s.side,
      cashEffect: s.cashEffect,
      resolvedAmount: normDecimal(s.resolvedAmount),
      eligibleEarningsAmount: normDecimal(s.eligibleEarningsAmount),
      sourcePercentBps: s.sourcePercentBps,
    }));

  return canonicalise({
    schemaVersion: 1,
    batch: canonicalBatch,
    employees: canonicalEmployees,
    componentSnapshots: canonicalComponents,
  });
}

/** Pure hashing entry point — deterministic. */
export function fingerprintFromCanonical(canonical: unknown): string {
  const json = JSON.stringify(canonical);
  return "cfp-v1-" + crypto.createHash("sha256").update(json, "utf8").digest("hex");
}

/** Convenience: canonicalise + hash in one call. */
export function computeCalculationFingerprint(input: Parameters<typeof canoniseBatch>[0]): string {
  return fingerprintFromCanonical(canoniseBatch(input));
}

/**
 * Load the persisted state of a batch and compute its fingerprint.
 * Does NOT persist — the caller decides. Reads from immutable persisted
 * evidence only; no recalculation performed.
 */
export async function loadAndComputeFingerprintForBatch(batchId: string): Promise<{
  fingerprint: string;
  batch: BatchLike;
  employeeCount: number;
  componentCount: number;
}> {
  const batch = await prisma.payrollBatch.findUniqueOrThrow({
    where: { id: batchId },
    select: {
      transactionType: true, statutoryPackageId: true, algorithmVersion: true,
      packageChecksum: true, calculationVersion: true,
      payGroupId: true, payPeriodId: true,
      reversesPayrollBatchId: true, correctsPayrollBatchId: true,
      pairedReversalBatchId: true,
    },
  });
  const employees = await prisma.payrollBatchEmployee.findMany({
    where: { batchId },
    select: {
      employeeId: true, jurisdictionCountry: true, jurisdictionProvince: true,
      salaried: true, employeeLifecycleAtPrep: true, status: true,
      sourceFactsJson: true, ytdSnapshotJson: true,
      grossPay: true, netPay: true,
      earningsTaxable: true, earningsPensionable: true, earningsInsurable: true,
      deductionCppEeBase: true, deductionCppEeFirstAdd: true, deductionCppEeCombined: true,
      deductionCpp2Ee: true, deductionEiEe: true,
      deductionFederalTax: true, deductionProvincialTax: true,
      additionalFederalTax: true, additionalProvincialTax: true,
      totalEmployeeDeductions: true,
      employerCppBase: true, employerCppFirstAdd: true, employerCppCombined: true,
      employerCpp2: true, employerEi: true,
    },
  });
  const componentSnapshots = await prisma.payrollBatchComponentSnapshot.findMany({
    where: { batchId },
    select: {
      employeeId: true, componentCode: true, category: true, side: true,
      cashEffect: true, resolvedAmount: true, eligibleEarningsAmount: true,
      sourcePercentBps: true,
    },
  });
  const fingerprint = computeCalculationFingerprint({ batch, employees, componentSnapshots });
  return { fingerprint, batch, employeeCount: employees.length, componentCount: componentSnapshots.length };
}

/**
 * If the batch has no persisted `calculationFingerprint`, compute it from
 * persisted evidence and store it. Never overwrites an existing fingerprint.
 * Returns the current (or newly-stored) fingerprint.
 *
 * FPP-9C (2026-09-22, §21) — MISMATCH_LEFT_UNCHANGED now persists a
 * durable `FingerprintMismatchEvent` row for permanent audit evidence.
 * The unique constraint (batchId, stored, recomputed) makes repeated
 * detections idempotent — the same mismatch is not duplicated.
 */
export async function backfillCalculationFingerprint(
  batchId: string,
  opts: { detectedByUserId?: string; detectionContext?: string } = {},
): Promise<{
  fingerprint: string;
  action: "STORED_NEW" | "MATCHED_EXISTING" | "MISMATCH_LEFT_UNCHANGED";
  mismatchEventId?: string;
}> {
  const existing = await prisma.payrollBatch.findUniqueOrThrow({
    where: { id: batchId },
    select: { calculationFingerprint: true, clubId: true },
  });
  const { fingerprint } = await loadAndComputeFingerprintForBatch(batchId);
  if (existing.calculationFingerprint == null) {
    await prisma.payrollBatch.update({
      where: { id: batchId },
      data: { calculationFingerprint: fingerprint },
    });
    return { fingerprint, action: "STORED_NEW" };
  }
  if (existing.calculationFingerprint === fingerprint) {
    return { fingerprint, action: "MATCHED_EXISTING" };
  }
  // Mismatch — historical fingerprint disagrees with persisted evidence.
  // Persist a durable audit row (upsert by unique constraint for
  // idempotency). Do NOT overwrite the stored fingerprint.
  const event = await prisma.fingerprintMismatchEvent.upsert({
    where: {
      batchId_storedFingerprint_recomputedFingerprint: {
        batchId,
        storedFingerprint: existing.calculationFingerprint,
        recomputedFingerprint: fingerprint,
      },
    },
    update: {},  // idempotent — no-op if we've already recorded this mismatch
    create: {
      clubId: existing.clubId,
      batchId,
      storedFingerprint: existing.calculationFingerprint,
      recomputedFingerprint: fingerprint,
      detectedByUserId: opts.detectedByUserId ?? null,
      detectionContext: opts.detectionContext ?? "backfill",
      actionTaken: "HISTORICAL_VALUE_LEFT_UNCHANGED",
    },
    select: { id: true },
  });
  return { fingerprint: existing.calculationFingerprint, action: "MISMATCH_LEFT_UNCHANGED", mismatchEventId: event.id };
}
