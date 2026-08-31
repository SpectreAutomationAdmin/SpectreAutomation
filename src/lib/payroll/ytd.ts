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
  ytdCppEE: string;
  ytdCpp2EE: string;
  ytdEiEE: string;
  ytdFederalTax: string;
  ytdProvincialTax: string;
  ytdCppER: string;
  ytdCpp2ER: string;
  ytdEiER: string;
  /** Provenance — which sources contributed to this aggregate. */
  sources: {
    openingBalanceId: string | null;
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

  const acc: EmployeePayrollYtd = {
    clubId,
    employeeId,
    taxYear,
    asOfPayDate,
    ytdGrossEarnings: opening?.values.ytdGrossEarnings ?? "0",
    ytdTaxableEarnings: opening?.values.ytdTaxableEarnings ?? "0",
    ytdPensionableEarnings: opening?.values.ytdPensionableEarnings ?? "0",
    ytdInsurableEarnings: opening?.values.ytdInsurableEarnings ?? "0",
    ytdCppEE: opening?.values.ytdCppEE ?? "0",
    ytdCpp2EE: opening?.values.ytdCpp2EE ?? "0",
    ytdEiEE: opening?.values.ytdEiEE ?? "0",
    ytdFederalTax: opening?.values.ytdFederalTax ?? "0",
    ytdProvincialTax: opening?.values.ytdProvincialTax ?? "0",
    ytdCppER: opening?.values.ytdCppER ?? "0",
    ytdCpp2ER: opening?.values.ytdCpp2ER ?? "0",
    ytdEiER: opening?.values.ytdEiER ?? "0",
    sources: { openingBalanceId: openingSourceId, postedBatchIds: [] },
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
