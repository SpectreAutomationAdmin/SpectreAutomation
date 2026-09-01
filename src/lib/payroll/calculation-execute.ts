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
const ALGORITHM_VERSION = "spectre-payroll-2c-v1";
const FINAL_APPROVAL_ORIGIN_KIND = "PAYROLL_FINAL_APPROVAL";
const REVIEW_ORIGIN_KIND = "PAYROLL_REVIEW";

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
    include: { earnings: true, allowanceSnapshots: true },
  });
  const batchEmployeeById = new Map(batchEmployees.map((be) => [be.id, be]));

  interface Payload {
    batchEmployeeId: string;
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

    const earnings = calculateEarnings({
      sourceFacts:        emp.sourceFacts,
      earningRows, allowances,
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

    // Frozen tax facts (parser fills a v1-only default when absent).
    const tax = emp.sourceFacts.tax ?? DEFAULT_TAX_FACTS_V1;

    const fed = calculateFederalTax({
      grossPay:                 earnings.grossPay,
      f5aThisPay,
      baseCppThisPay:           cpp.base,
      eiThisPay:                ei.employee,
      periodsPerYear:           readiness.periodsPerYear,
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
      grossPay:                 earnings.grossPay,
      f5aThisPay,
      baseCppThisPay:           cpp.base,
      eiThisPay:                ei.employee,
      periodsPerYear:           readiness.periodsPerYear,
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
    const totalEmployeeDeductions = roundCentsHalfUp(
      cpp.combined.plus(cpp2.amount).plus(ei.employee)
        .plus(fed.t4PerPeriod).plus(prov.t4pPerPeriod)
        .plus(additionalFederal).plus(additionalProvincial),
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

    const totalEmployer = employerCpp.combined.plus(employerCpp2.amount).plus(ei.employer);

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

  await prisma.$transaction(async (tx) => {
    for (const p of payloads) {
      await tx.payrollBatchEmployee.update({ where: { id: p.batchEmployeeId }, data: p.data });
    }
    await tx.payrollBatch.update({
      where: { id: batchId },
      data: {
        status:             "CALCULATED",
        calculatedAt:       now,
        calculationVersion: nextVersion,
        statutoryPackageId: pkg.id,
        algorithmVersion:   ALGORITHM_VERSION,
        packageChecksum:    pkg.checksum,
      },
    });
  });

  // §40, §44 — Controller PAYROLL_FINAL_APPROVAL handoff + resolve
  // PAYROLL_REVIEW. Idempotent by (kind, batchId).
  const config = await prisma.payrollClubConfig.findUnique({ where: { clubId } });
  let finalApprovalItemId: string | null = null;
  let finalApprovalOwnerUserId: string | null = null;

  if (!config?.controllerUserId) {
    // §40 — do NOT invent an owner. Leave the task un-materialised
    // and expose the gap on the result. Batch is CALCULATED; a
    // future config edit + explicit re-run of calculatePayrollBatch
    // will materialise it.
    await audit(principal, {
      action: "payroll.batch.calculate.controller-gap",
      entityType: ENTITY, entityId: batchId, clubId,
      after: { reason: "PayrollClubConfig.controllerUserId not set" },
    });
  } else {
    finalApprovalOwnerUserId = config.controllerUserId;
    const period = await prisma.payrollPayPeriod.findFirst({
      where: { id: priorBatch.payPeriodId, clubId },
      select: { periodStart: true, periodEnd: true, payDate: true },
    });
    const totals = payloads.reduce(
      (acc, p) => ({
        gross:     acc.gross     + p.grossCents,
        net:       acc.net       + p.netCents,
        deducted:  acc.deducted  + p.totalDeductionsCents,
        employer:  acc.employer  + p.totalEmployerCents,
      }),
      { gross: 0, net: 0, deducted: 0, employer: 0 },
    );
    const money = (cents: number) => (cents / 100).toFixed(2);
    const payDateLabel = period ? period.payDate.toISOString().slice(0, 10) : "unknown";
    const dateLabel = period
      ? `${period.periodStart.toISOString().slice(0, 10)} → ${new Date(period.periodEnd.getTime() - 86_400_000).toISOString().slice(0, 10)}`
      : priorBatch.payPeriodId;

    // Executive-summary preview per §41 — NO SIN / bank / TD1 / individual employee data.
    const preview =
      `${payloads.length} employees · pay ${payDateLabel} · ` +
      `gross $${money(totals.gross)} · deductions $${money(totals.deducted)} · ` +
      `net $${money(totals.net)} · employer contributions $${money(totals.employer)}`;
    const subject = `Payroll ready for final approval · ${dateLabel}`;

    finalApprovalItemId = await materialiseFinalApprovalItem({
      clubId, batchId, controllerUserId: config.controllerUserId, subject, preview,
    });
    await resolveOutstandingReviewItem(clubId, batchId, principal.id);
  }

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

async function materialiseFinalApprovalItem(args: {
  clubId: string;
  batchId: string;
  controllerUserId: string;
  subject: string;
  preview: string;
}): Promise<string> {
  const existing = await prisma.workIntakeOrigin.findFirst({
    where: {
      clubId: args.clubId, kind: FINAL_APPROVAL_ORIGIN_KIND,
      referenceId: args.batchId, role: "PRIMARY",
    },
    select: { workIntakeItemId: true },
  });
  const now = new Date();
  if (existing) {
    // §43 idempotency — repeated recalculation refreshes the same card.
    await prisma.workIntakeItem.update({
      where: { id: existing.workIntakeItemId },
      data: {
        status: "OPEN", ownerUserId: args.controllerUserId,
        displaySubject: args.subject, displayPreview: args.preview,
        displayReceivedAt: now, resolvedAt: null, resolvedByUserId: null,
      },
    });
    return existing.workIntakeItemId;
  }
  const created = await prisma.workIntakeItem.create({
    data: {
      clubId: args.clubId, status: "OPEN", judgmentRequired: true,
      ownerUserId: args.controllerUserId,
      classification: FINAL_APPROVAL_ORIGIN_KIND,
      classificationReason: "Payroll batch reached CALCULATED — Controller final approval required.",
      classificationMethod: "RULE",
      classificationRuleKey: "payroll-orchestration.v1",
      classificationRuleVersion: 1,
      displaySourceLabel: "Spectre Payroll",
      displaySender: "Payroll orchestration",
      displaySubject: args.subject,
      displayPreview: args.preview,
      displayReceivedAt: now,
      displayHasAttachments: false,
      workDomain: "PAYROLL", workIntent: "APPROVE",
      workSubtype: FINAL_APPROVAL_ORIGIN_KIND,
      workDomainConfidence: 1,
      workDomainClassifiedAt: now,
      workDomainClassifierVersion: "payroll-orchestration.v1",
    },
    select: { id: true },
  });
  await prisma.workIntakeOrigin.create({
    data: {
      clubId: args.clubId, workIntakeItemId: created.id,
      kind: FINAL_APPROVAL_ORIGIN_KIND, referenceId: args.batchId, role: "PRIMARY",
      linkReason: `Payroll orchestrator — batch ${args.batchId} reached CALCULATED.`,
    },
  });
  await prisma.workIntakeActivity.create({
    data: {
      workIntakeItemId: created.id, action: "MATERIALISED",
      note: "Controller final-approval task materialised on PREPARED → CALCULATED transition.",
    },
  });
  return created.id;
}

async function resolveOutstandingReviewItem(clubId: string, batchId: string, actorUserId: string): Promise<void> {
  const link = await prisma.workIntakeOrigin.findFirst({
    where: { clubId, kind: REVIEW_ORIGIN_KIND, referenceId: batchId, role: "PRIMARY" },
    select: { workIntakeItemId: true },
  });
  if (!link) return;
  const now = new Date();
  await prisma.workIntakeItem.updateMany({
    where: { id: link.workIntakeItemId, status: { not: "RESOLVED" } },
    data: { status: "RESOLVED", resolvedAt: now, resolvedByUserId: actorUserId },
  });
  await prisma.workIntakeActivity.create({
    data: {
      workIntakeItemId: link.workIntakeItemId, actorUserId, action: "RESOLVED",
      note: "Batch reached CALCULATED — responsibility handed off to the Controller.",
    },
  });
}

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
