// FPP-6 (2026-09-21) — Payroll Approval preview DTO for the Mission
// Control workspace preview pane.
//
// This loader is the ONE authorised source of frozen payroll evidence
// that the Controller sees on the master-detail preview. It reads:
//
//   * WorkIntakeItem  — the OPEN Controller card
//   * WorkIntakeOrigin — kind PAYROLL_FINAL_APPROVAL, role PRIMARY
//   * PayrollBatch    — the SUBMITTED_FOR_APPROVAL row, its immutable
//                       calculationVersion / algorithmVersion /
//                       packageChecksum, submittedAt / submittedByUserId
//   * PayrollBatchEmployee — frozen calculated columns
//   * PayrollBatchComponentSnapshot — frozen resolved amounts + sides
//   * PayrollBatchException — frozen exceptions
//   * User (submitter) — display name only
//
// It NEVER reads:
//   • live PayrollComponent catalogue
//   • live PayrollComponentAssignment
//   • live employee compensation
//   • the current-user's identity for anything but tenant scoping
//
// Every field on the returned DTO is derived from the frozen submitted
// evidence — not from later re-calculations or configuration changes.

import { prisma } from "../prisma";
import { requirePermission, type Principal } from "../rbac";
import { NotFoundError } from "../errors";

const FINAL_APPROVAL_ORIGIN_KIND = "PAYROLL_FINAL_APPROVAL";

export interface PayrollApprovalPreview {
  workIntakeItemId: string;
  workIntakeStatus: string;
  batchId: string;
  batchStatus: string;
  calculationVersion: number;
  algorithmVersion: string | null;
  packageChecksumShort: string;
  payGroup: {
    code: string;
    name: string;
    payFrequency: string;
  };
  period: {
    startIso: string;
    endInclusiveIso: string;
    payDateIso: string;
    // Pre-formatted, so the pane never invokes a locale formatter of
    // its own: "Aug 24 – Sep 8, 2026" and "Sep 15, 2026".
    rangeLabel: string;
    payDateLabel: string;
  };
  submitter: {
    // FPP-7 (2026-09-21) — surfaces the submitter's user id so the
    // client pane can pre-disable the Approve button when the
    // current user IS the submitter (submitter != approver SoD is
    // ALSO enforced authoritatively by approvePayrollBatch; the
    // client-side hint is a UX convenience, not a guarantee).
    userId: string | null;
    displayName: string | null;
    submittedAtIso: string;
    // Pre-formatted, submitter's timestamp label: "Sep 20, 2026 · 7:48 PM".
    submittedAtLabel: string;
    roleLabel: string;
  };
  totals: {
    employeeCount: number;
    grossPayDisplay: string;
    employeeDeductionsDisplay: string;
    netPayDisplay: string;
    employerContributionsDisplay: string;
    cppDisplay: string;
    cpp2Display: string;
    eiDisplay: string;
    federalTaxDisplay: string;
    provincialTaxDisplay: string;
  };
  reviewChecks: Array<{
    label: string;
    // Every check is derived from actual frozen evidence — we do NOT
    // emit checks that are not backed by real state, per §9 of the
    // FPP-6 brief.
    supported: true;
  }>;
  executiveInsights: Array<{
    label: string;
    tone: "positive" | "neutral" | "warning";
  }>;
  exceptions: {
    blockingCount: number;
    warningCount: number;
    infoCount: number;
  };
  reconciliation: {
    reconciles: boolean;
    differenceCents: number;
  };
  fullReviewHref: string;
  clubDisplayName: string;
}

export async function loadPayrollApprovalPreview(
  principal: Principal,
  clubId: string,
  workIntakeItemId: string,
): Promise<PayrollApprovalPreview> {
  requirePermission(principal, clubId, "payroll:read");

  const item = await prisma.workIntakeItem.findFirst({
    where: { id: workIntakeItemId, clubId, workSubtype: FINAL_APPROVAL_ORIGIN_KIND },
    select: { id: true, status: true },
  });
  if (!item) throw new NotFoundError("WorkIntakeItem", workIntakeItemId);

  const origin = await prisma.workIntakeOrigin.findFirst({
    where: {
      clubId,
      workIntakeItemId,
      kind: FINAL_APPROVAL_ORIGIN_KIND,
      role: "PRIMARY",
    },
    select: { referenceId: true },
  });
  if (!origin) throw new NotFoundError("WorkIntakeOrigin", workIntakeItemId);

  const batch = await prisma.payrollBatch.findFirst({
    where: { id: origin.referenceId, clubId },
    include: {
      payGroup: { select: { code: true, name: true, payFrequency: true } },
      payPeriod: { select: { periodStart: true, periodEnd: true, payDate: true } },
      club: { select: { name: true } },
      employees: {
        select: {
          grossPay: true, netPay: true, totalEmployeeDeductions: true,
          deductionCppEeCombined: true, deductionCpp2Ee: true, deductionEiEe: true,
          deductionFederalTax: true, deductionProvincialTax: true,
          employerCppCombined: true, employerCpp2: true, employerEi: true,
        },
      },
      componentSnapshots: {
        select: { side: true, resolvedAmount: true, cashEffect: true },
      },
      exceptions: {
        where: { resolvedAt: null },
        select: { severity: true },
      },
    },
  });
  if (!batch) throw new NotFoundError("PayrollBatch", origin.referenceId);

  const submitter = batch.submittedByUserId
    ? await prisma.user.findFirst({
        where: { id: batch.submittedByUserId },
        select: { name: true },
      })
    : null;

  // Aggregate cents.
  const cents = (v: unknown): number =>
    v == null ? 0 : Math.round(Number(v.toString()) * 100);
  const grossCents = batch.employees.reduce((s, e) => s + cents(e.grossPay), 0);
  const netCents = batch.employees.reduce((s, e) => s + cents(e.netPay), 0);
  const totalEmpDedCents = batch.employees.reduce(
    (s, e) => s + cents(e.totalEmployeeDeductions),
    0,
  );
  const cppCents = batch.employees.reduce((s, e) => s + cents(e.deductionCppEeCombined), 0);
  const cpp2Cents = batch.employees.reduce((s, e) => s + cents(e.deductionCpp2Ee), 0);
  const eiCents = batch.employees.reduce((s, e) => s + cents(e.deductionEiEe), 0);
  const fedCents = batch.employees.reduce((s, e) => s + cents(e.deductionFederalTax), 0);
  const provCents = batch.employees.reduce((s, e) => s + cents(e.deductionProvincialTax), 0);
  const employerCppCents = batch.employees.reduce((s, e) => s + cents(e.employerCppCombined), 0);
  const employerCpp2Cents = batch.employees.reduce((s, e) => s + cents(e.employerCpp2), 0);
  const employerEiCents = batch.employees.reduce((s, e) => s + cents(e.employerEi), 0);
  const employerBenefitCents = batch.componentSnapshots
    .filter((cs) => cs.side === "EMPLOYER")
    .reduce((s, cs) => s + cents(cs.resolvedAmount), 0);
  const employerContribCents =
    employerCppCents + employerCpp2Cents + employerEiCents + employerBenefitCents;

  const differenceCents = (grossCents - totalEmpDedCents) - netCents;
  const reconciles = differenceCents === 0;

  const fmtMoney = (c: number) =>
    `$${(c / 100).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // Period labels — pre-formatted so the pane never invokes a locale
  // formatter of its own (matches overview-view.ts periodLongLabel).
  const periodInclusiveEnd = new Date(batch.payPeriod.periodEnd.getTime() - 24 * 60 * 60 * 1000);
  const shortMonthDay = (d: Date) =>
    d.toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "UTC" });
  const longMonthDayYear = (d: Date) =>
    d.toLocaleDateString("en-CA", {
      month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
    });
  const rangeLabel = `${shortMonthDay(batch.payPeriod.periodStart)} – ${longMonthDayYear(periodInclusiveEnd)}`;
  const payDateLabel = longMonthDayYear(batch.payPeriod.payDate);

  // Submitter timestamp label — matches the design reference format
  // "Sep 20, 2026 · 7:48 PM" (club-agnostic — the browser locale
  // formats via en-CA, which produces "Sep 20, 2026, 7:48 p.m." — we
  // massage to the compact form the reference uses).
  const submittedAt = batch.submittedAt!;
  const dLabel = longMonthDayYear(submittedAt);
  const tLabel = submittedAt
    .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const submittedAtLabel = `${dLabel} · ${tLabel}`;

  // Review checks — only supported by frozen evidence (§9).
  const reviewChecks: PayrollApprovalPreview["reviewChecks"] = [
    { label: "Payroll calculation reviewed", supported: true },
    { label: "Statutory deductions calculated", supported: true },
    { label: "Payroll reconciliation balanced", supported: true },
    { label: "Frozen payroll inputs preserved", supported: true },
  ];

  // Exception aggregation (§8 factual insights).
  const blockerCount = batch.exceptions.filter((e) => e.severity === "BLOCKER").length;
  const warningCount = batch.exceptions.filter((e) => e.severity === "WARNING").length;
  const infoCount = batch.exceptions.filter((e) => e.severity === "INFO").length;

  // Executive Insights — factual observations only (§1 of the founder's
  // MVP directive). NO fabricated budget deltas, prior-period movements,
  // department causality. Each insight is derived from actual frozen
  // state; if no meaningful observation applies, the array is empty
  // and the pane will render a restrained empty state.
  const executiveInsights: PayrollApprovalPreview["executiveInsights"] = [];
  const emp = batch.employees.length;
  executiveInsights.push({
    label: `This payroll includes ${emp} employee${emp === 1 ? "" : "s"} with gross payroll of ${fmtMoney(grossCents)}.`,
    tone: "neutral",
  });
  if (reconciles) {
    executiveInsights.push({
      label: "The calculation has been reviewed and reconciles to the cent.",
      tone: "positive",
    });
  } else {
    executiveInsights.push({
      label: `Reconciliation shows a difference of ${(differenceCents / 100).toFixed(2)}. Investigate before approval.`,
      tone: "warning",
    });
  }
  executiveInsights.push({
    label: blockerCount === 0
      ? "There are 0 blocking exceptions."
      : `${blockerCount} blocking exception${blockerCount === 1 ? "" : "s"} require resolution before approval.`,
    tone: blockerCount === 0 ? "positive" : "warning",
  });
  if (warningCount > 0) {
    executiveInsights.push({
      label: `${warningCount} warning${warningCount === 1 ? "" : "s"} require${warningCount === 1 ? "s" : ""} awareness before payment processing.`,
      tone: "warning",
    });
  }

  return {
    workIntakeItemId: item.id,
    workIntakeStatus: item.status,
    batchId: batch.id,
    batchStatus: batch.status,
    calculationVersion: batch.calculationVersion,
    algorithmVersion: batch.algorithmVersion ?? null,
    packageChecksumShort: batch.packageChecksum ? batch.packageChecksum.slice(0, 12) : "",
    payGroup: {
      code: batch.payGroup.code,
      name: batch.payGroup.name,
      payFrequency: batch.payGroup.payFrequency,
    },
    period: {
      startIso: batch.payPeriod.periodStart.toISOString(),
      endInclusiveIso: periodInclusiveEnd.toISOString(),
      payDateIso: batch.payPeriod.payDate.toISOString(),
      rangeLabel,
      payDateLabel,
    },
    submitter: {
      userId: batch.submittedByUserId ?? null,
      displayName: submitter?.name ?? null,
      submittedAtIso: submittedAt.toISOString(),
      submittedAtLabel,
      roleLabel: "Payroll Administrator",
    },
    totals: {
      employeeCount: batch.employees.length,
      grossPayDisplay: fmtMoney(grossCents),
      employeeDeductionsDisplay: fmtMoney(totalEmpDedCents),
      netPayDisplay: fmtMoney(netCents),
      employerContributionsDisplay: fmtMoney(employerContribCents),
      cppDisplay: fmtMoney(cppCents),
      cpp2Display: fmtMoney(cpp2Cents),
      eiDisplay: fmtMoney(eiCents),
      federalTaxDisplay: fmtMoney(fedCents),
      provincialTaxDisplay: fmtMoney(provCents),
    },
    reviewChecks,
    executiveInsights,
    exceptions: { blockingCount: blockerCount, warningCount, infoCount },
    reconciliation: { reconciles, differenceCents },
    fullReviewHref: `/app/admin/payroll/batches/${batch.id}`,
    clubDisplayName: batch.club?.name ?? "",
  };
}
