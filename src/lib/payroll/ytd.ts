// Payroll-3B-5A (2026-08-31) — canonical YTD aggregation service (§20).
//
// The exclusion contract is deliberately strict:
//   ACTIVE PayrollOpeningBalance          — included
//   POSTED PayrollBatch (payDate < asOf)  — included
//   PREPARED / CALCULATED / VOIDED / DRAFT batches — EXCLUDED
//   ANY batch whose payDate.taxYear ≠ target taxYear — EXCLUDED
//   ANY batch with payDate ≥ asOf         — EXCLUDED
//
// Tax year follows PayrollPayPeriod.payDate (per 3B-2 §21). December
// work paid in January belongs to the January payroll tax year.
//
// 3B-5A does not yet implement the POSTED lifecycle — 3B-5B will
// wire that. The service is nevertheless written to consume it so
// that the moment posting arrives, YTD reconciles correctly. Until
// then, the service returns just the ACTIVE opening balance.
//
// Zero calculation. Just deterministic aggregation.

import type { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "../prisma";
import { getActiveOpeningBalance } from "./opening-balance";

export interface EmployeePayrollYtd {
  clubId: string;
  employeeId: string;
  taxYear: number;
  asOfPayDate: Date;
  ytdGrossEarnings: string;
  ytdTaxableEarnings: string;
  ytdPensionableEarnings: string;
  ytdInsurableEarnings: string;
  // Payroll-3B-5B-1 (§21, §22) — CPP components preserved separately
  // for statutory maximum tracking. `ytdCppEE` and `ytdCppER` are
  // the combined totals for Box 16 reporting.
  ytdCppEE_Base: string;
  ytdCppEE_FirstAdd: string;
  ytdCppEE: string;
  ytdCpp2EE: string;
  ytdEiEE: string;
  ytdFederalTax: string;
  ytdProvincialTax: string;
  ytdCppER_Base: string;
  ytdCppER_FirstAdd: string;
  ytdCppER: string;
  ytdCpp2ER: string;
  ytdEiER: string;
  /**
   * Provenance — which sources contributed to this aggregate. The
   * openingBalance provenance kind is exposed so a future
   * calculator or reviewer can see whether opening YTD came from
   * PRIOR_SYSTEM_SAME_EMPLOYER (contributes to this employer's
   * CPP/EI annual maximums per §23) or from PRIOR_EMPLOYER
   * (recorded for information only; each employer deducts CPP/EI
   * independently).
   */
  sources: {
    openingBalanceId: string | null;
    openingBalancePriorPayrollKind: string | null;
    postedBatchIds: string[];
  };
}

function addDec(a: string, b: string | Decimal | null | undefined): string {
  if (b == null) return a;
  const bs = typeof b === "string" ? b : b.toString();
  // Simple decimal addition via Number — YTD totals fit in JS number
  // precision for club-scale payroll and the service is not the
  // authoritative posting rounder. If tighter precision is ever
  // required, swap to BigInt cent-math like the batch-preparation
  // hours accumulator.
  return (Number(a) + Number(bs)).toFixed(4);
}

/**
 * Aggregate an Employee's payroll YTD for a given tax year as-of a
 * pay date. Includes the ACTIVE opening balance + every POSTED
 * PayrollBatch whose payDate < asOf AND whose payDate falls in the
 * same tax year.
 *
 * When the batch calculation lands in 3B-5B, this service will pull
 * per-employee POSTED batch totals via `PayrollBatchEmployee` fields
 * that don't exist yet. Until then, the loop is defensive: if the
 * fields are null, they contribute nothing.
 */
export async function getEmployeePayrollYtd(
  clubId: string,
  employeeId: string,
  asOfPayDate: Date,
): Promise<EmployeePayrollYtd> {
  const taxYear = asOfPayDate.getUTCFullYear();

  const opening = await getActiveOpeningBalance(clubId, employeeId, taxYear);
  const openingSourceId = opening?.id ?? null;
  const openingKind = opening?.priorPayrollKind ?? null;

  // Payroll-3B-5B-1b (§9-10): a PRIOR_EMPLOYER opening balance
  // must contribute ZERO to EVERY employer-YTD category — including
  // gross, taxable, pensionable, insurable, CPP, CPP2, EI, federal
  // tax, provincial tax, and employer contributions. Per CRA,
  // different employers/business numbers calculate CPP + EI + tax
  // independently; carrying another employer's YTD into this
  // employer's ledger would corrupt T4 reporting + statutory
  // maximum enforcement.
  //
  // Only PRIOR_SYSTEM_SAME_EMPLOYER and PRIOR_ADJUSTMENT rows
  // contribute — these represent this employer's own historical
  // payroll (prior payroll system or a valid correction).
  const includeInThisEmployerYtd =
    opening !== null &&
    (openingKind === "PRIOR_SYSTEM_SAME_EMPLOYER" || openingKind === "PRIOR_ADJUSTMENT");
  const src = includeInThisEmployerYtd ? opening : null;

  const acc: EmployeePayrollYtd = {
    clubId,
    employeeId,
    taxYear,
    asOfPayDate,
    ytdGrossEarnings: src?.values.ytdGrossEarnings ?? "0",
    ytdTaxableEarnings: src?.values.ytdTaxableEarnings ?? "0",
    ytdPensionableEarnings: src?.values.ytdPensionableEarnings ?? "0",
    ytdInsurableEarnings: src?.values.ytdInsurableEarnings ?? "0",
    ytdCppEE_Base: src?.values.ytdCppEE_Base ?? "0",
    ytdCppEE_FirstAdd: src?.values.ytdCppEE_FirstAdd ?? "0",
    ytdCppEE: src?.values.ytdCppEE ?? "0",
    ytdCpp2EE: src?.values.ytdCpp2EE ?? "0",
    ytdEiEE: src?.values.ytdEiEE ?? "0",
    ytdFederalTax: src?.values.ytdFederalTax ?? "0",
    ytdProvincialTax: src?.values.ytdProvincialTax ?? "0",
    ytdCppER_Base: src?.values.ytdCppER_Base ?? "0",
    ytdCppER_FirstAdd: src?.values.ytdCppER_FirstAdd ?? "0",
    ytdCppER: src?.values.ytdCppER ?? "0",
    ytdCpp2ER: src?.values.ytdCpp2ER ?? "0",
    ytdEiER: src?.values.ytdEiER ?? "0",
    sources: {
      openingBalanceId: openingSourceId,
      openingBalancePriorPayrollKind: openingKind,
      postedBatchIds: [],
    },
  };

  // POSTED batches for this Employee whose payDate is strictly
  // before asOf AND whose taxYear matches. The `.taxYear` field on
  // PayrollPayPeriod is authoritative (3B-2 § 21).
  const posted = await prisma.payrollBatch.findMany({
    where: {
      clubId,
      status: "POSTED",
      payPeriod: {
        taxYear,
        payDate: { lt: asOfPayDate },
      },
      employees: { some: { employeeId } },
    },
    select: {
      id: true,
      employees: {
        where: { employeeId },
        select: {
          id: true,
          grossPay: true,
          netPay: true,
          // Reserved for 3B-5B — these fields do not exist yet on
          // PayrollBatchEmployee; when they land, uncomment and
          // aggregate them here. Explicit list so the future
          // contributor cannot forget one:
          //   pensionableEarnings, insurableEarnings, taxableEarnings,
          //   cppEE, cpp2EE, eiEE, federalTax, provincialTax,
          //   cppER, cpp2ER, eiER.
        },
      },
    },
  });

  for (const b of posted) {
    acc.sources.postedBatchIds.push(b.id);
    for (const e of b.employees) {
      acc.ytdGrossEarnings = addDec(acc.ytdGrossEarnings, e.grossPay ?? null);
      // Remaining YTD fields will accumulate in 3B-5B once
      // PayrollBatchEmployee carries them. See comment above.
    }
  }

  return acc;
}
