// Payroll-3B-5B-2c (2026-09-02) — Gross-to-Net calculator EXECUTE.
//
// Complete gross-to-net calculation. Orchestrates:
//   1. Readiness (prepareCalculationInput refusal on BLOCKERs).
//   2. Earnings + statutory bases (pure).
//   3. CPP base + first-additional + combined (pure).
//   4. CPP2 (pure).
//   5. EI (pure — employer derived from employee × multiplier).
//   6. F5A = firstAdd + CPP2 per pay.
//   7. Federal tax (pure).
//   8. Alberta tax (pure).
//   9. Additional withholding — added as SEPARATE persisted columns.
//  10. totalEmployeeDeductions + netPay.
//  11. Frozen YTD snapshot + versioned calculation-explanation
//      snapshot per employee.
//  12. Atomic persistence of every employee row + PayrollBatch
//      metadata (calculatedAt, calculationVersion, statutoryPackageId,
//      packageChecksum, algorithmVersion) + PREPARED → CALCULATED.
//  13. Controller PAYROLL_FINAL_APPROVAL Work Intake handoff.
//      Resolves the outstanding PAYROLL_REVIEW task so responsibility
//      moves cleanly. Idempotent on recalculation.
//
// One BLOCKER anywhere ⇒ nothing persists, lifecycle stays PREPARED,
// no Controller task. Complete calculation is batch-atomic.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { ValidationError } from "../errors";
import { prepareCalculationInput, type CalculationReadinessResult } from "./calculation";
import { calculateEarnings, type EarningRowLike, type AllowanceSnapshotLike } from "./earnings-calculator";
import { calculateCpp } from "./statutory/cpp-calculator";
import { calculateCpp2 } from "./statutory/cpp2-calculator";
import { calculateEi } from "./statutory/ei-calculator";
import { calculateFederalTax } from "./statutory/federal-tax-calculator";
import { calculateAlbertaTax } from "./statutory/alberta-tax-calculator";
import { toCentString, toDecimal, nonNegative, roundCentsHalfUp, Decimal } from "./statutory/decimal-money";
import { DEFAULT_TAX_FACTS_V1 } from "./source-facts-schema";
import type { YtdSnapshotV1 } from "./ytd-snapshot-schema";

const ENTITY = "PayrollBatch";
// Payroll-3C-3D.7 (2026-09-09) — production adopts the CRA projected
// year-to-date CPP/EI tax-credit method as its STANDARD K2/K2P basis.
// See src/lib/payroll/statutory/cpp-ei-credit-basis.ts for the
// authoritative formula (T4127 §Federal K2 optional YTD method).
// CRA states the T4127 formulas generally produce more precise
// results than PDOC — a documented Spectre-vs-PDOC delta is
// intentional under this methodology and NOT a defect. Historical
// batches keep their frozen `algorithmVersion`; the engine change
// only affects newly-CALCULATED batches from this version onward.
const ALGORITHM_VERSION = "spectre-payroll-3c3d7-v2";
// Payroll 3E: FINAL_APPROVAL_ORIGIN_KIND + REVIEW_ORIGIN_KIND relocated
// to src/lib/payroll/controller-work-intake.ts.

/** Payroll 3D acceptance hotfix (2026-09-12) — raised when a
 *  concurrent Calculate request loses the compare-and-set race. The
 *  loser must NOT retry blindly; the current batch state should be
 *  re-fetched and the operator informed. */
export class CalculateConcurrencyConflictError extends Error {
  readonly code = "PAYROLL_CALCULATE_CONCURRENCY_CONFLICT";
  readonly batchId: string;
  readonly expectedStatus: string;
  readonly expectedVersion: number;
  constructor(batchId: string, expectedStatus: string, expectedVersion: number) {
    super(
      `Concurrent Calculate detected on batch ${batchId}: expected status=${expectedStatus} version=${expectedVersion} ` +
        "but the row changed under the transaction. Reload the batch and retry.",
    );
    this.batchId = batchId;
    this.expectedStatus = expectedStatus;
    this.expectedVersion = expectedVersion;
  }
}

export interface ExecutePayrollCalculationResult {
  batchId: string;
  employeeCount: number;
  statutoryPackageId: string;
  packageVersion:     string;
  algorithmVersion:   string;
  packageChecksum:    string;
  persisted:          boolean;
  lifecycleStatus:    "PREPARED" | "CALCULATED";
  calculationVersion: number;
  finalApprovalWorkIntakeItemId: string | null;
  finalApprovalOwnerUserId:      string | null;
  blockers: CalculationReadinessResult["exceptions"];
}

/**
 * Full gross-to-net calculation. When successful, transitions
 * PREPARED → CALCULATED and materialises the Controller
 * PAYROLL_FINAL_APPROVAL Work Intake task exactly once.
 */
export async function calculatePayrollBatch(
  principal: Principal,
  clubId: string,
  batchId: string,
): Promise<ExecutePayrollCalculationResult> {
  requirePermission(principal, clubId, "payroll:run");

  const readiness = await prepareCalculationInput(principal, clubId, batchId);
  if (!readiness.ready || readiness.statutoryPackage === null) {
    return emptyResult(readiness, batchId);
  }

  const pkg = readiness.statutoryPackage;
  const cppParams  = pkg.params.cpp;
  const eiParams   = pkg.params.ei;
  const fedParams  = pkg.params.federal;
  const provParams = pkg.params.provincial;
  if (!provParams) {
    throw new ValidationError([{ path: "provincial", message: "Statutory package has no provincial block." }]);
  }

  const batchEmployees = await prisma.payrollBatchEmployee.findMany({
    where: { batchId, clubId },
    include: {
      earnings: true, allowanceSnapshots: true,
      // Payroll-3C-2 (2026-09-07) — component snapshots read by calc.
      componentSnapshots: true,
    },
  });
  const batchEmployeeById = new Map(batchEmployees.map((be) => [be.id, be]));

  interface Payload {
    batchEmployeeId: string;
    employeeIdForDiag: string;
    percentResolutions: Array<{
      code: string; percentBps: number;
      eligibleBase: "REGULAR_EARNINGS_ONLY" | "CASH_EARNINGS";
      eligibleAmount: { toFixed: (n: number) => string };
      resolvedAmount: { toFixed: (n: number) => string };
    }>;
    calcDiagnostics: Array<{ code: string; message: string }>;
    data: Record<string, string | null>;
    grossCents:            number;
    netCents:              number;
    totalDeductionsCents:  number;
    totalEmployerCents:    number;
  }
  const payloads: Payload[] = [];
  const failures: CalculationReadinessResult["exceptions"] = [];

  for (const emp of readiness.employees) {
    const be = batchEmployeeById.get(emp.batchEmployeeId);
    if (!be) {
      throw new ValidationError([
        { path: "batchEmployeeId", message: `Batch employee ${emp.batchEmployeeId} vanished between readiness and execute.` },
      ]);
    }

    const earningRows: EarningRowLike[] = be.earnings.map((r) => ({
      earningType: r.earningType, quantity: r.quantity.toString(), rate: r.rate.toString(),
    }));
    const allowances: AllowanceSnapshotLike[] = be.allowanceSnapshots.map((a) => ({
      amount: a.amount.toString(), frequency: a.frequency,
      taxable: a.taxable, pensionable: a.pensionable as boolean, insurable: a.insurable as boolean,
    }));
    // Payroll-3C-2 / -3C-3 — frozen component snapshots contribute
    // to the four independent bases via directional effects.
    // PERCENT snapshots have `resolvedAmount = null` here; the
    // calculator computes the amount from the frozen eligible base
    // and returns `percentResolutions` we persist back below.
    const componentSnapshots = be.componentSnapshots.map((cs) => ({
      code: cs.componentCode,
      side: cs.side as "EMPLOYEE" | "EMPLOYER",
      cashEffect: cs.cashEffect as "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT",
      taxableEffect:        cs.taxableEffect        as "ADD" | "SUBTRACT" | "NONE",
      cppPensionableEffect: cs.cppPensionableEffect as "ADD" | "SUBTRACT" | "NONE",
      eiInsurableEffect:    cs.eiInsurableEffect    as "ADD" | "SUBTRACT" | "NONE",
      calculationMethod: cs.calculationMethod as "FIXED_AMOUNT" | "PERCENT_OF_ELIGIBLE_EARNINGS",
      resolvedAmount: cs.resolvedAmount ? cs.resolvedAmount.toString() : null,
      eligibleEarningsBase: cs.eligibleEarningsBase as "REGULAR_EARNINGS_ONLY" | "CASH_EARNINGS" | null,
      sourcePercentBps: cs.sourcePercentBps ?? null,
    }));

    const earnings = calculateEarnings({
      sourceFacts:        emp.sourceFacts,
      earningRows, allowances,
      componentSnapshots,
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
        ybe: cppParams.ybe, baseRateEE: cppParams.baseRateEE,
        firstAdditionalRateEE: cppParams.firstAdditionalRateEE,
        combinedRateEE: cppParams.combinedRateEE, combinedMaxEE: cppParams.combinedMaxEE,
      },
    });
    const cpp2 = calculateCpp2({
      pensionableEarnings: earnings.earningsPensionable,
      ytdPensionable:      emp.ytd.ytdPensionableEarnings,
      ytdCpp2EE:           emp.ytd.ytdCpp2EE,
      pensionableMonths:   emp.pensionableMonths,
      cpp: {
        ympe: cppParams.ympe, yampe: cppParams.yampe,
        cpp2RateEE: cppParams.cpp2RateEE, cpp2MaxEE: cppParams.cpp2MaxEE,
      },
    });
    const ei = calculateEi({
      insurableEarnings: earnings.earningsInsurable,
      ytdInsurable:      emp.ytd.ytdInsurableEarnings,
      ytdEiEE:           emp.ytd.ytdEiEE,
      ytdEiER:           emp.ytd.ytdEiER,
      ei: {
        mie: eiParams.mie, rateEE: eiParams.rateEE, rateER: eiParams.rateER,
        maxAnnualPremiumEE: eiParams.maxAnnualPremiumEE,
        maxAnnualPremiumER: eiParams.maxAnnualPremiumER,
        employerMultiplier: eiParams.employerMultiplier,
      },
    });
    const employerCpp = calculateCpp({
      pensionableEarnings: earnings.earningsPensionable,
      ytdCombinedEE:       emp.ytd.ytdCppER,
      periodsPerYear:      readiness.periodsPerYear,
      pensionableMonths:   emp.pensionableMonths,
      cpp: {
        ybe: cppParams.ybe, baseRateEE: cppParams.baseRateER,
        firstAdditionalRateEE: cppParams.firstAdditionalRateER,
        combinedRateEE: cppParams.combinedRateER, combinedMaxEE: cppParams.combinedMaxER,
      },
    });
    const employerCpp2 = calculateCpp2({
      pensionableEarnings: earnings.earningsPensionable,
      ytdPensionable:      emp.ytd.ytdPensionableEarnings,
      ytdCpp2EE:           emp.ytd.ytdCpp2ER,
      pensionableMonths:   emp.pensionableMonths,
      cpp: {
        ympe: cppParams.ympe, yampe: cppParams.yampe,
        cpp2RateEE: cppParams.cpp2RateER, cpp2MaxEE: cppParams.cpp2MaxER,
      },
    });

    // §9 — F5A = employee first-additional CPP + employee CPP2.
    const f5aThisPay = cpp.firstAdd.plus(cpp2.amount);

    // Payroll-3C-3D (2026-09-09) — T4127 F: sum of every EMPLOYEE-side
    // snapshot whose `taxFormulaDeductionType` maps into the F input
    // (currently RRSP_DEDUCTED_AT_SOURCE only). Percentage components
    // whose resolvedAmount is stamped by the calculator earlier in
    // this loop are covered because the snapshot rows carry the
    // resolved amount by the time this sum runs. If a component
    // stamps a category-type here in the future, it should also be
    // added to the `TAX_FORMULA_F_TYPES` allowlist.
    const TAX_FORMULA_F_TYPES = new Set(["RRSP_DEDUCTED_AT_SOURCE"]);
    let fThisPay: import("./statutory/decimal-money").Decimal | undefined;
    if (be.componentSnapshots.some((s) => s.taxFormulaDeductionType && TAX_FORMULA_F_TYPES.has(s.taxFormulaDeductionType))) {
      const { toDecimal } = await import("./statutory/decimal-money");
      // Percentage components whose resolvedAmount is null at snapshot
      // time have their amount computed inside `calculateEarnings`;
      // find the matching percentResolution to source the amount.
      let sum = toDecimal(0);
      for (const s of be.componentSnapshots) {
        if (!s.taxFormulaDeductionType || !TAX_FORMULA_F_TYPES.has(s.taxFormulaDeductionType)) continue;
        if (s.side !== "EMPLOYEE") continue;
        if (s.resolvedAmount != null) {
          sum = sum.plus(toDecimal(s.resolvedAmount.toString()));
          continue;
        }
        const pr = earnings.percentResolutions.find((p) => p.code === s.componentCode);
        if (pr) sum = sum.plus(toDecimal(pr.resolvedAmount.toString()));
      }
      fThisPay = sum;
    }

    // Frozen tax facts (parser fills a v1-only default when absent).
    const tax = emp.sourceFacts.tax ?? DEFAULT_TAX_FACTS_V1;

    // Payroll-3C-3D.7 (2026-09-09) — CRA year-to-date K2/K2P credit
    // basis (production). D/D1 = current-employer YTD strictly BEFORE
    // this pay (PRIOR_EMPLOYER opening balances contribute zero per
    // the existing 3B-5B YTD aggregator); PR = pay periods remaining
    // in taxYear including current; PM = pensionable months from
    // cppPensionableMonths (age/CPT30/disability/death only — never
    // hire date); C/EI = this pay's combined-CPP + EI outputs from
    // the engine. Federal + Alberta consume the SAME selected basis.
    const { getEmployeePayrollYtd } = await import("./ytd");
    const priorYtd = await getEmployeePayrollYtd(clubId, emp.employeeId, readiness.payDate);
    const remainingIncludingCurrent = await prisma.payrollPayPeriod.count({
      where: {
        clubId,
        payGroupId: readiness.payGroupId,
        taxYear:    readiness.taxYear,
        payDate:    { gte: readiness.payDate },
      },
    });
    const { calculateCppEiTaxCreditBasis } = await import("./statutory/cpp-ei-credit-basis");
    const ytdCreditBasis = calculateCppEiTaxCreditBasis({
      priorYtdCombinedCpp:              priorYtd.ytdCppEE,
      priorYtdEi:                       priorYtd.ytdEiEE,
      currentCombinedCpp:               cpp.combined,
      currentEi:                        ei.employee,
      periodsRemainingIncludingCurrent: remainingIncludingCurrent,
      cppPensionableMonths:             emp.pensionableMonths,
      baseCppRateStr:                   cppParams.baseRateEE,
      combinedCppRateStr:               cppParams.combinedRateEE,
      combinedCppBaseMaxEEStr:          cppParams.baseMaxEE,
      eiMaxAnnualPremiumEEStr:          eiParams.maxAnnualPremiumEE,
    });

    const fed = calculateFederalTax({
      // Payroll-3C-3D.3 — corrected: T4127 §Federal / §Alberta I is
      // periodic TAXABLE remuneration (includes taxable non-cash
      // benefits), not cash gross. Prior implementation passed
      // `earnings.grossPay` and under-withheld income tax whenever
      // the employee had taxable employer benefits.
      periodicTaxableRemuneration: earnings.taxableRemuneration,
      fThisPay,
      f5aThisPay,
      baseCppThisPay:           cpp.base,
      eiThisPay:                ei.employee,
      periodsPerYear:           readiness.periodsPerYear,
      // Payroll-3C-3D.7 — YTD credit basis (production standard).
      ytdCreditBasis:           { combinedSelectedBasis: ytdCreditBasis.combinedSelectedBasis },
      federalClaim:             tax.federalClaim,
      claimZeroFederal:         tax.claimZeroFederal,
      totalIncomeLessThanClaim: tax.totalIncomeLessThanClaim,
      federal: {
        brackets:                 fedParams.brackets,
        lowestRate:               fedParams.lowestRate,
        bpaMax:                   fedParams.bpaMax,
        bpaMin:                   fedParams.bpaMin,
        bpaPhaseOutStart:         fedParams.bpaPhaseOutStart,
        bpaPhaseOutEnd:           fedParams.bpaPhaseOutEnd,
        canadaEmploymentAmountMax: fedParams.canadaEmploymentAmountMax,
      },
    });
    const prov = calculateAlbertaTax({
      // Payroll-3C-3D.3 — corrected: T4127 §Federal / §Alberta I is
      // periodic TAXABLE remuneration (includes taxable non-cash
      // benefits), not cash gross. Prior implementation passed
      // `earnings.grossPay` and under-withheld income tax whenever
      // the employee had taxable employer benefits.
      periodicTaxableRemuneration: earnings.taxableRemuneration,
      fThisPay,
      f5aThisPay,
      baseCppThisPay:           cpp.base,
      eiThisPay:                ei.employee,
      periodsPerYear:           readiness.periodsPerYear,
      // Payroll-3C-3D.7 — same YTD credit basis as federal K2 (§13).
      ytdCreditBasis:           { combinedSelectedBasis: ytdCreditBasis.combinedSelectedBasis },
      provincialClaim:          tax.provincialClaim,
      claimZeroProvincial:      tax.claimZeroProvincial,
      totalIncomeLessThanClaim: tax.totalIncomeLessThanClaim,
      provincial: {
        brackets:   provParams.brackets,
        lowestRate: provParams.lowestRate,
        bpa:        provParams.bpa,
        k5p:        provParams.k5p,
      },
    });

    // Additional withholding — persisted SEPARATELY (§25).
    const additionalFederal    = roundCentsHalfUp(toDecimal(tax.additionalFederalTaxAmount));
    const additionalProvincial = roundCentsHalfUp(toDecimal(tax.additionalProvincialTaxAmount));

    // Total employee deductions + net pay (§27, §28).
    // Payroll-3C-2 — DECREASES_NET_PAY component amounts (LTD, RRSP EE)
    // reduce net alongside statutory deductions.
    const totalEmployeeDeductions = roundCentsHalfUp(
      cpp.combined.plus(cpp2.amount).plus(ei.employee)
        .plus(fed.t4PerPeriod).plus(prov.t4pPerPeriod)
        .plus(additionalFederal).plus(additionalProvincial)
        .plus(earnings.employeeDeductionsFromComponents),
    );
    const netPay = earnings.grossPay.minus(totalEmployeeDeductions);
    if (netPay.lt(0)) {
      // §29 — refuse silent negative net pay.
      failures.push({
        employeeId: emp.employeeId, severity: "BLOCKER", code: "NEGATIVE_NET_PAY",
        message: `Employee ${emp.employeeId} net pay would be ${netPay.toFixed(2)} (gross ${earnings.grossPay.toFixed(2)} − deductions ${totalEmployeeDeductions.toFixed(2)}).`,
        recommendedAction: "Review the employee's earning + statutory + additional-tax inputs; batch remains PREPARED until resolved.",
      });
      continue;
    }

    // Payroll-3C-2 — employer-side component contributions (AD&D,
    // Dependent Life, Employer Life Insurance, Employer RRSP once
    // activated) grow employer cost without touching employee net.
    const totalEmployer = employerCpp.combined.plus(employerCpp2.amount).plus(ei.employer)
      .plus(earnings.employerContributionsFromComponents);

    const ytdSnapshot: YtdSnapshotV1 = {
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

    // Calculation-explanation snapshot (§35, §36) — every T4127
    // intermediate factor that produced this employee's result.
    const explanation = {
      schemaVersion: 1,
      algorithmVersion: ALGORITHM_VERSION,
      packageId:       pkg.id,
      packageVersion:  pkg.packageVersion,
      packageChecksum: pkg.checksum,
      periodsPerYear:  readiness.periodsPerYear,
      pensionableMonths: emp.pensionableMonths,
      grossPay:            toCentString(earnings.grossPay),
      earningsTaxable:     toCentString(earnings.earningsTaxable),
      earningsPensionable: toCentString(earnings.earningsPensionable),
      earningsInsurable:   toCentString(earnings.earningsInsurable),
      cpp: {
        base: toCentString(cpp.base), firstAdd: toCentString(cpp.firstAdd), combined: toCentString(cpp.combined),
      },
      cpp2:  toCentString(cpp2.amount),
      ei:    { employee: toCentString(ei.employee), employer: toCentString(ei.employer) },
      f5A:   toCentString(f5aThisPay),
      federal: {
        a: toCentString(fed.a), aStar: toCentString(fed.aStar),
        f5aAnnual: toCentString(fed.f5aAnnual), bpaf: toCentString(fed.bpaf),
        R: fed.bracketRate.toFixed(4), K: toCentString(fed.bracketK),
        T: toCentString(fed.t),
        K1: toCentString(fed.k1), K2: toCentString(fed.k2), K3: toCentString(fed.k3), K4: toCentString(fed.k4),
        T3Annual: toCentString(fed.t3Annual), T4PerPeriod: toCentString(fed.t4PerPeriod),
        additional: toCentString(additionalFederal),
        federalClaim: tax.federalClaim, claimZeroFederal: tax.claimZeroFederal,
      },
      provincial: {
        a: toCentString(prov.a), f5aAnnual: toCentString(prov.f5aAnnual),
        V: prov.bracketRate.toFixed(4), KP: toCentString(prov.bracketK),
        TP: toCentString(prov.tp),
        K1P: toCentString(prov.k1p), K2P: toCentString(prov.k2p), K3P: toCentString(prov.k3p),
        K4P: toCentString(prov.k4p), K5P: toCentString(prov.k5p),
        T3PAnnual: toCentString(prov.t3pAnnual), T4PPerPeriod: toCentString(prov.t4pPerPeriod),
        additional: toCentString(additionalProvincial),
        provincialClaim: tax.provincialClaim, claimZeroProvincial: tax.claimZeroProvincial,
      },
      totalEmployeeDeductions: toCentString(totalEmployeeDeductions),
      netPay:                   toCentString(netPay),
      totalIncomeLessThanClaim: tax.totalIncomeLessThanClaim,
    };

    payloads.push({
      batchEmployeeId: be.id,
      employeeIdForDiag: be.employeeId,
      percentResolutions: earnings.percentResolutions,
      calcDiagnostics:    earnings.diagnostics,
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
        deductionFederalTax:     toCentString(fed.t4PerPeriod),
        deductionProvincialTax:  toCentString(prov.t4pPerPeriod),
        additionalFederalTax:    toCentString(additionalFederal),
        additionalProvincialTax: toCentString(additionalProvincial),
        totalEmployeeDeductions: toCentString(totalEmployeeDeductions),
        netPay:                  toCentString(netPay),
        employerCppBase:         toCentString(employerCpp.base),
        employerCppFirstAdd:     toCentString(employerCpp.firstAdd),
        employerCppCombined:     toCentString(employerCpp.combined),
        employerCpp2:            toCentString(employerCpp2.amount),
        employerEi:              toCentString(ei.employer),
        ytdSnapshotJson:         JSON.stringify(ytdSnapshot),
        calculationExplanationJson: JSON.stringify(explanation),
      },
      grossCents:           centsOf(earnings.grossPay),
      netCents:             centsOf(netPay),
      totalDeductionsCents: centsOf(totalEmployeeDeductions),
      totalEmployerCents:   centsOf(totalEmployer),
    });
  }

  // §37 atomic contract — if ANY employee raised a fresh BLOCKER,
  // persist nothing and leave the batch in PREPARED.
  if (failures.length > 0) {
    return {
      batchId, employeeCount: readiness.employees.length,
      statutoryPackageId: pkg.id, packageVersion: pkg.packageVersion,
      algorithmVersion: pkg.algorithmVersion, packageChecksum: pkg.checksum,
      persisted: false, lifecycleStatus: "PREPARED",
      calculationVersion: 0,
      finalApprovalWorkIntakeItemId: null, finalApprovalOwnerUserId: null,
      blockers: failures,
    };
  }

  // Load current calculationVersion so recalculation increments deterministically.
  const priorBatch = await prisma.payrollBatch.findUniqueOrThrow({ where: { id: batchId } });
  if (priorBatch.status === "POSTED") {
    return {
      batchId, employeeCount: readiness.employees.length,
      statutoryPackageId: pkg.id, packageVersion: pkg.packageVersion,
      algorithmVersion: pkg.algorithmVersion, packageChecksum: pkg.checksum,
      persisted: false, lifecycleStatus: "PREPARED", calculationVersion: priorBatch.calculationVersion,
      finalApprovalWorkIntakeItemId: null, finalApprovalOwnerUserId: null,
      blockers: [{
        employeeId: null, severity: "BLOCKER", code: "INVALID_BATCH_LIFECYCLE",
        message: `Batch ${batchId} is POSTED and immutable; recalculation refused.`,
      }],
    };
  }

  const nextVersion = priorBatch.calculationVersion + 1;
  const now = new Date();

  // Payroll 3D acceptance hotfix (2026-09-12) — compare-and-set guard
  // for concurrent Calculate. The status/version tuple observed above
  // (`priorBatch.status === "PREPARED"|"CALCULATED"` and
  // `priorBatch.calculationVersion === expectedVersion`) is asserted
  // inside the transaction by an `updateMany` with that WHERE clause.
  // Two concurrent Calculate calls race on the update — the first
  // sees the row unchanged and applies; the second observes 0 rows
  // affected and refuses without silently producing a second
  // calculation. This makes exactly-one-Calculate a database
  // guarantee, not a UI-only expectation.
  const expectedStatus = priorBatch.status; // PREPARED (fresh) or CALCULATED (recalc)
  const expectedVersion = priorBatch.calculationVersion;
  let casSucceeded = false;
  await prisma.$transaction(async (tx) => {
    const gate = await tx.payrollBatch.updateMany({
      where: {
        id: batchId, clubId,
        status: expectedStatus,
        calculationVersion: expectedVersion,
      },
      data: {
        status:             "CALCULATED",
        calculatedAt:       now,
        calculationVersion: nextVersion,
        statutoryPackageId: pkg.id,
        algorithmVersion:   ALGORITHM_VERSION,
        packageChecksum:    pkg.checksum,
      },
    });
    if (gate.count !== 1) {
      // Race lost — the batch's status or calculationVersion changed
      // between prior-read and this transaction. Abort the transaction
      // by throwing; no employee-row updates persist.
      throw new CalculateConcurrencyConflictError(batchId, expectedStatus, expectedVersion);
    }
    for (const p of payloads) {
      await tx.payrollBatchEmployee.update({ where: { id: p.batchEmployeeId }, data: p.data });
      for (const pr of p.percentResolutions) {
        await tx.payrollBatchComponentSnapshot.updateMany({
          where: { batchEmployeeId: p.batchEmployeeId, componentCode: pr.code },
          data: {
            resolvedAmount:         pr.resolvedAmount.toFixed(2),
            eligibleEarningsAmount: pr.eligibleAmount.toFixed(2),
          },
        });
      }
      for (const d of p.calcDiagnostics) {
        await tx.payrollBatchException.create({
          data: {
            clubId, batchId, batchEmployeeId: p.batchEmployeeId, employeeId: p.employeeIdForDiag,
            severity: "WARNING", code: d.code, message: d.message,
          },
        });
      }
    }
    casSucceeded = true;
  });
  if (!casSucceeded) {
    // Belt-and-braces: throw only fires above; this line is unreachable
    // but appeases the type-narrowing pass and documents intent.
    throw new CalculateConcurrencyConflictError(batchId, expectedStatus, expectedVersion);
  }

  // Payroll Admin Slice 3E (2026-09-12) — the Controller
  // PAYROLL_FINAL_APPROVAL handoff has moved to `submitPayrollBatch`.
  // Calculate NO LONGER creates the Controller Work Intake card,
  // NO LONGER resolves the Payroll-Admin PAYROLL_REVIEW task, and
  // NEVER materialises the final-approval item pre-Submit. The batch
  // reaches CALCULATED and waits for the Payroll Admin to attest the
  // CALCULATED_PAYROLL review and click Submit for Approval. See
  // src/lib/payroll/submit-payroll-batch.ts for the moved logic.
  const finalApprovalItemId: string | null = null;
  const finalApprovalOwnerUserId: string | null = null;

  await audit(principal, {
    action: "payroll.batch.calculate",
    entityType: ENTITY, entityId: batchId, clubId,
    after: {
      employeeCount: payloads.length,
      statutoryPackageId: pkg.id, packageChecksum: pkg.checksum,
      calculationVersion: nextVersion, lifecycleStatus: "CALCULATED",
      finalApprovalWorkIntakeItemId: finalApprovalItemId,
    },
  });

  return {
    batchId, employeeCount: payloads.length,
    statutoryPackageId: pkg.id, packageVersion: pkg.packageVersion,
    algorithmVersion: ALGORITHM_VERSION, packageChecksum: pkg.checksum,
    persisted: true, lifecycleStatus: "CALCULATED",
    calculationVersion: nextVersion,
    finalApprovalWorkIntakeItemId: finalApprovalItemId,
    finalApprovalOwnerUserId,
    blockers: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function centsOf(d: Decimal): number {
  return Math.round(Number(d.toFixed(2)) * 100);
}

// Payroll 3E (2026-09-12) — `materialiseFinalApprovalItem` and
// `resolveOutstandingReviewItem` moved to
// `src/lib/payroll/controller-work-intake.ts` and are now called at
// Submit time, not Calculate time. See §7 of the 3E directive.

function emptyResult(readiness: CalculationReadinessResult, batchId: string): ExecutePayrollCalculationResult {
  return {
    batchId, employeeCount: readiness.employees.length,
    statutoryPackageId: readiness.statutoryPackage?.id ?? "",
    packageVersion:     readiness.statutoryPackage?.packageVersion ?? "",
    algorithmVersion:   readiness.statutoryPackage?.algorithmVersion ?? "",
    packageChecksum:    readiness.statutoryPackage?.checksum ?? "",
    persisted: false, lifecycleStatus: "PREPARED", calculationVersion: 0,
    finalApprovalWorkIntakeItemId: null, finalApprovalOwnerUserId: null,
    blockers: readiness.exceptions.filter((e) => e.severity === "BLOCKER"),
  };
}

// Backwards-compatible re-export for callers still using the 2b name.
export { calculatePayrollBatch as executeEarningsAndStatutory };
// Types
export type { CalculationReadinessResult };
export { nonNegative };
