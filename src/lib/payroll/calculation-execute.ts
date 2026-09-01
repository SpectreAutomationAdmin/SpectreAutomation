// Payroll-3B-5B-2b (2026-09-01) — Gross-to-Net calculator EXECUTE.
//
// Orchestrates earnings + CPP + CPP2 + EI calculation for every
// employee in a PREPARED PayrollBatch, then persists the results
// atomically. Does NOT compute income tax (that ships in 2c) and
// does NOT transition the batch out of PREPARED.
//
// The Controller final-approval Work Intake task is NOT
// materialised here — 2c will materialise it off CALCULATED once
// tax + net pay exist.
//
// Contract:
//   • Consumes prepareCalculationInput first; refuses when !ready.
//   • Reads earnings + allowance snapshots and frozen source facts
//     directly off the batch (no live HR queries).
//   • Runs the four pure calculators (earnings, CPP, CPP2, EI).
//   • Persists per-employee dollar results + a frozen ytdSnapshotJson
//     inside a single Prisma $transaction — either every employee's
//     2b result set is persisted, or none are.
//   • Pins statutoryPackageId + packageChecksum + algorithmVersion on
//     the PayrollBatch. Does NOT set calculatedAt (that flags a
//     COMPLETE gross-to-net calculation, which 2b is not).
//   • Leaves deductionFederalTax / deductionProvincialTax /
//     additionalFederalTax / additionalProvincialTax /
//     totalEmployeeDeductions / netPay UNSET — never writes false
//     zeros for uncomputed tax fields.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { ValidationError } from "../errors";
import { prepareCalculationInput, type CalculationReadinessResult } from "./calculation";
import { calculateEarnings, type EarningRowLike, type AllowanceSnapshotLike } from "./earnings-calculator";
import { calculateCpp } from "./statutory/cpp-calculator";
import { calculateCpp2 } from "./statutory/cpp2-calculator";
import { calculateEi } from "./statutory/ei-calculator";
import { toCentString } from "./statutory/decimal-money";
import type { YtdSnapshotV1 } from "./ytd-snapshot-schema";

const ENTITY = "PayrollBatch";

export interface ExecuteEarningsAndStatutoryResult {
  batchId: string;
  employeeCount: number;
  statutoryPackageId: string;
  packageVersion: string;
  algorithmVersion: string;
  packageChecksum: string;
  /** True when every employee was calculated + persisted. */
  persisted: boolean;
  /** Blockers that prevented calculation (batch remains PREPARED, nothing written). */
  blockers: CalculationReadinessResult["exceptions"];
}

/**
 * Compute + atomically persist the 2b result set (earnings, CPP,
 * CPP2, EI) for every employee in a PREPARED batch. Refuses when
 * readiness is not `ready`. Batch remains PREPARED.
 */
export async function executeEarningsAndStatutory(
  principal: Principal,
  clubId: string,
  batchId: string,
): Promise<ExecuteEarningsAndStatutoryResult> {
  requirePermission(principal, clubId, "payroll:run");

  const readiness = await prepareCalculationInput(principal, clubId, batchId);
  if (!readiness.ready || readiness.statutoryPackage === null) {
    return {
      batchId,
      employeeCount: readiness.employees.length,
      statutoryPackageId: readiness.statutoryPackage?.id ?? "",
      packageVersion:     readiness.statutoryPackage?.packageVersion ?? "",
      algorithmVersion:   readiness.statutoryPackage?.algorithmVersion ?? "",
      packageChecksum:    readiness.statutoryPackage?.checksum ?? "",
      persisted: false,
      blockers: readiness.exceptions.filter((e) => e.severity === "BLOCKER"),
    };
  }

  const pkg = readiness.statutoryPackage;
  const cppParams = pkg.params.cpp;
  const eiParams  = pkg.params.ei;

  // Pull per-employee earning + allowance snapshots in one query.
  const batchEmployees = await prisma.payrollBatchEmployee.findMany({
    where: { batchId, clubId },
    include: { earnings: true, allowanceSnapshots: true },
  });
  const batchEmployeeById = new Map(batchEmployees.map((be) => [be.id, be]));

  // Build every per-employee persistence payload BEFORE opening the
  // transaction. That way if the pure math throws for any employee
  // we surface an atomic BLOCKER rather than half-committing.
  interface Payload {
    batchEmployeeId: string;
    data: {
      grossPay:                string;
      earningsTaxable:         string;
      earningsPensionable:     string;
      earningsInsurable:       string;
      deductionCppEeBase:      string;
      deductionCppEeFirstAdd:  string;
      deductionCppEeCombined:  string;
      deductionCpp2Ee:         string;
      deductionEiEe:           string;
      employerCppBase:         string;
      employerCppFirstAdd:     string;
      employerCppCombined:     string;
      employerCpp2:            string;
      employerEi:              string;
      ytdSnapshotJson:         string;
    };
  }
  const payloads: Payload[] = [];

  for (const emp of readiness.employees) {
    const be = batchEmployeeById.get(emp.batchEmployeeId);
    if (!be) {
      throw new ValidationError([
        { path: "batchEmployeeId", message: `Batch employee ${emp.batchEmployeeId} vanished between readiness and execute.` },
      ]);
    }

    // Frozen earning + allowance snapshots.
    const earningRows: EarningRowLike[] = be.earnings.map((r) => ({
      earningType: r.earningType,
      quantity:    r.quantity.toString(),
      rate:        r.rate.toString(),
    }));
    const allowances: AllowanceSnapshotLike[] = be.allowanceSnapshots.map((a) => ({
      amount:      a.amount.toString(),
      frequency:   a.frequency,
      // Readiness has already refused null classification — assert on read.
      taxable:     a.taxable,
      pensionable: a.pensionable as boolean,
      insurable:   a.insurable   as boolean,
    }));

    const earnings = calculateEarnings({
      sourceFacts:        emp.sourceFacts,
      earningRows,
      allowances,
      approvedHours:      emp.approvedHoursSnapshot,
      periodsPerYear:     readiness.periodsPerYear,
      salariedFullPeriod: emp.salariedFullPeriod,
    });

    const cpp = calculateCpp({
      pensionableEarnings: earnings.earningsPensionable,
      ytdCombinedEE:       emp.ytd.ytdCppEE,
      periodsPerYear:      readiness.periodsPerYear,
      pensionableMonths:   emp.pensionableMonths,
      cpp: {
        ybe:                    cppParams.ybe,
        baseRateEE:             cppParams.baseRateEE,
        firstAdditionalRateEE:  cppParams.firstAdditionalRateEE,
        combinedRateEE:         cppParams.combinedRateEE,
        combinedMaxEE:          cppParams.combinedMaxEE,
      },
    });

    const cpp2 = calculateCpp2({
      pensionableEarnings: earnings.earningsPensionable,
      ytdPensionable:      emp.ytd.ytdPensionableEarnings,
      ytdCpp2EE:           emp.ytd.ytdCpp2EE,
      pensionableMonths:   emp.pensionableMonths,
      cpp: {
        ympe:       cppParams.ympe,
        yampe:      cppParams.yampe,
        cpp2RateEE: cppParams.cpp2RateEE,
        cpp2MaxEE:  cppParams.cpp2MaxEE,
      },
    });

    const ei = calculateEi({
      insurableEarnings: earnings.earningsInsurable,
      ytdInsurable:      emp.ytd.ytdInsurableEarnings,
      ytdEiEE:           emp.ytd.ytdEiEE,
      ytdEiER:           emp.ytd.ytdEiER,
      ei: {
        mie:                eiParams.mie,
        rateEE:             eiParams.rateEE,
        rateER:             eiParams.rateER,
        maxAnnualPremiumEE: eiParams.maxAnnualPremiumEE,
        maxAnnualPremiumER: eiParams.maxAnnualPremiumER,
        employerMultiplier: eiParams.employerMultiplier,
      },
    });

    // Employer CPP mirrors employee (same rates for 2026).
    const employerCpp = calculateCpp({
      pensionableEarnings: earnings.earningsPensionable,
      ytdCombinedEE:       emp.ytd.ytdCppER,
      periodsPerYear:      readiness.periodsPerYear,
      pensionableMonths:   emp.pensionableMonths,
      cpp: {
        ybe:                   cppParams.ybe,
        baseRateEE:            cppParams.baseRateER,
        firstAdditionalRateEE: cppParams.firstAdditionalRateER,
        combinedRateEE:        cppParams.combinedRateER,
        combinedMaxEE:         cppParams.combinedMaxER,
      },
    });
    const employerCpp2 = calculateCpp2({
      pensionableEarnings: earnings.earningsPensionable,
      ytdPensionable:      emp.ytd.ytdPensionableEarnings,
      ytdCpp2EE:           emp.ytd.ytdCpp2ER,
      pensionableMonths:   emp.pensionableMonths,
      cpp: {
        ympe:       cppParams.ympe,
        yampe:      cppParams.yampe,
        cpp2RateEE: cppParams.cpp2RateER,
        cpp2MaxEE:  cppParams.cpp2MaxER,
      },
    });

    const snapshot: YtdSnapshotV1 = {
      schemaVersion: 1,
      asOfPayDate:   readiness.payDate.toISOString(),
      taxYear:       readiness.taxYear,
      sources: {
        openingBalanceId:               emp.ytd.sources.openingBalanceId,
        openingBalancePriorPayrollKind: emp.ytd.sources.openingBalancePriorPayrollKind,
        postedBatchIds:                 emp.ytd.sources.postedBatchIds,
      },
      ytdGrossEarnings:       emp.ytd.ytdGrossEarnings,
      ytdTaxableEarnings:     emp.ytd.ytdTaxableEarnings,
      ytdPensionableEarnings: emp.ytd.ytdPensionableEarnings,
      ytdInsurableEarnings:   emp.ytd.ytdInsurableEarnings,
      ytdCppEE_Base:          emp.ytd.ytdCppEE_Base,
      ytdCppEE_FirstAdd:      emp.ytd.ytdCppEE_FirstAdd,
      ytdCppEE:               emp.ytd.ytdCppEE,
      ytdCpp2EE:              emp.ytd.ytdCpp2EE,
      ytdEiEE:                emp.ytd.ytdEiEE,
      ytdFederalTax:          emp.ytd.ytdFederalTax,
      ytdProvincialTax:       emp.ytd.ytdProvincialTax,
      ytdCppER_Base:          emp.ytd.ytdCppER_Base,
      ytdCppER_FirstAdd:      emp.ytd.ytdCppER_FirstAdd,
      ytdCppER:               emp.ytd.ytdCppER,
      ytdCpp2ER:              emp.ytd.ytdCpp2ER,
      ytdEiER:                emp.ytd.ytdEiER,
    };

    payloads.push({
      batchEmployeeId: be.id,
      data: {
        grossPay:                toCentString(earnings.grossPay),
        earningsTaxable:         toCentString(earnings.earningsTaxable),
        earningsPensionable:     toCentString(earnings.earningsPensionable),
        earningsInsurable:       toCentString(earnings.earningsInsurable),
        deductionCppEeBase:      toCentString(cpp.base),
        deductionCppEeFirstAdd:  toCentString(cpp.firstAdd),
        deductionCppEeCombined:  toCentString(cpp.combined),
        deductionCpp2Ee:         toCentString(cpp2.amount),
        deductionEiEe:           toCentString(ei.employee),
        employerCppBase:         toCentString(employerCpp.base),
        employerCppFirstAdd:     toCentString(employerCpp.firstAdd),
        employerCppCombined:     toCentString(employerCpp.combined),
        employerCpp2:            toCentString(employerCpp2.amount),
        employerEi:              toCentString(ei.employer),
        ytdSnapshotJson:         JSON.stringify(snapshot),
      },
    });
  }

  // Atomic persistence: every employee's row in one transaction, plus
  // the batch-level statutory-package pin. `calculatedAt` is
  // deliberately NOT set — 2c does that when tax + net pay exist.
  await prisma.$transaction(async (tx) => {
    for (const p of payloads) {
      await tx.payrollBatchEmployee.update({
        where: { id: p.batchEmployeeId },
        data:  p.data,
      });
    }
    await tx.payrollBatch.update({
      where: { id: batchId },
      data: {
        statutoryPackageId: pkg.id,
        algorithmVersion:   pkg.algorithmVersion,
        packageChecksum:    pkg.checksum,
      },
    });
  });

  await audit(principal, {
    action: "payroll.batch.execute-2b",
    entityType: ENTITY,
    entityId: batchId,
    clubId,
    after: {
      employeeCount: payloads.length,
      statutoryPackageId: pkg.id,
      packageVersion: pkg.packageVersion,
      packageChecksum: pkg.checksum,
      remainsInLifecycle: "PREPARED",
    },
  });

  return {
    batchId,
    employeeCount: payloads.length,
    statutoryPackageId: pkg.id,
    packageVersion: pkg.packageVersion,
    algorithmVersion: pkg.algorithmVersion,
    packageChecksum: pkg.checksum,
    persisted: true,
    blockers: [],
  };
}
