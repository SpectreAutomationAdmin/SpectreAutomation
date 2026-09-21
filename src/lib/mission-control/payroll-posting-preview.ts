// FPP-8 (2026-09-21) — Payroll Posting preview DTO for the Mission
// Control workspace preview pane (Payroll Admin side).
//
// Read-only. Bound to:
//   * WorkIntakeItem (PAYROLL_READY_TO_POST subtype, ownerUserId = Payroll Admin)
//   * WorkIntakeOrigin (kind PAYROLL_READY_TO_POST, role PRIMARY, referenceId = batch id)
//   * PayrollBatch (status APPROVED — the immutable approved package)
//   * PayrollBatchEmployee (frozen calculated columns)
//   * PayrollBatchComponentSnapshot (frozen resolved amounts)
//   * PayrollGlAccountingProfile + canonical journal resolver via
//     `previewPayrollJournal` — SAME resolver that `postPayrollBatch`
//     uses at commit time, so the preview and the posted journal are
//     bit-identical.
//
// It NEVER reads:
//   • live PayrollComponent catalogue
//   • live PayrollComponentAssignment
//   • live employee compensation / TD1 / recurring
//   • the current-user's identity for anything but tenant scoping and
//     the audit trail of who is viewing.

import { prisma } from "../prisma";
import { requirePermission, type Principal } from "../rbac";
import { NotFoundError, ConflictError } from "../errors";
import { previewPayrollJournal, type PayrollJournalPreviewResult } from "../payroll/payroll-journal-preview";

const READY_TO_POST_ORIGIN_KIND = "PAYROLL_READY_TO_POST";

export interface PayrollPostingPreview {
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
    rangeLabel: string;
    payDateLabel: string;
  };
  approver: {
    userId: string | null;
    displayName: string | null;
    approvedAtIso: string;
    approvedAtLabel: string;
    approvedDateLabel: string;
    approvedTimeLabel: string;
    roleLabel: string;
  };
  payrollAdmin: {
    userId: string | null;
    displayName: string | null;
    roleLabel: string;
  };
  totals: {
    employeeCount: number;
    grossPayDisplay: string;
    employeeDeductionsDisplay: string;
    netPayDisplay: string;
    employerContributionsDisplay: string;
  };
  executiveInsights: Array<{
    label: string;
    tone: "positive" | "neutral" | "warning";
  }>;
  journal: {
    balanced: boolean;
    totalDebitsDisplay: string;
    totalCreditsDisplay: string;
    differenceCentsDisplay: string;
    readinessBlockers: Array<{ code: string; message: string }>;
    lines: Array<{
      accountNumber: string;
      accountName: string;
      departmentCode: string | null;
      departmentName: string | null;
      debitDisplay: string | null;
      creditDisplay: string | null;
      description: string;
    }>;
  };
  fullReviewHref: string;
  clubDisplayName: string;
}

export async function loadPayrollPostingPreview(
  principal: Principal,
  clubId: string,
  workIntakeItemId: string,
): Promise<PayrollPostingPreview> {
  requirePermission(principal, clubId, "payroll:read");

  const item = await prisma.workIntakeItem.findFirst({
    where: { id: workIntakeItemId, clubId, workSubtype: READY_TO_POST_ORIGIN_KIND },
    select: { id: true, status: true, ownerUserId: true },
  });
  if (!item) throw new NotFoundError("WorkIntakeItem", workIntakeItemId);

  const origin = await prisma.workIntakeOrigin.findFirst({
    where: {
      clubId,
      workIntakeItemId,
      kind: READY_TO_POST_ORIGIN_KIND,
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
          employerCppCombined: true, employerCpp2: true, employerEi: true,
        },
      },
      componentSnapshots: {
        select: { side: true, resolvedAmount: true },
      },
    },
  });
  if (!batch) throw new NotFoundError("PayrollBatch", origin.referenceId);

  const approver = batch.approvedByUserId
    ? await prisma.user.findFirst({
        where: { id: batch.approvedByUserId },
        select: { name: true },
      })
    : null;
  const admin = item.ownerUserId
    ? await prisma.user.findFirst({ where: { id: item.ownerUserId }, select: { name: true } })
    : null;

  const cents = (v: unknown): number =>
    v == null ? 0 : Math.round(Number(v.toString()) * 100);
  const grossCents = batch.employees.reduce((s, e) => s + cents(e.grossPay), 0);
  const netCents = batch.employees.reduce((s, e) => s + cents(e.netPay), 0);
  const totalEmpDedCents = batch.employees.reduce(
    (s, e) => s + cents(e.totalEmployeeDeductions),
    0,
  );
  const employerCppCents = batch.employees.reduce((s, e) => s + cents(e.employerCppCombined), 0);
  const employerCpp2Cents = batch.employees.reduce((s, e) => s + cents(e.employerCpp2), 0);
  const employerEiCents = batch.employees.reduce((s, e) => s + cents(e.employerEi), 0);
  const employerBenefitCents = batch.componentSnapshots
    .filter((cs) => cs.side === "EMPLOYER")
    .reduce((s, cs) => s + cents(cs.resolvedAmount), 0);
  const employerContribCents =
    employerCppCents + employerCpp2Cents + employerEiCents + employerBenefitCents;

  const fmtMoney = (c: number) =>
    `$${(c / 100).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const periodInclusiveEnd = new Date(batch.payPeriod.periodEnd.getTime() - 24 * 60 * 60 * 1000);
  const shortMonthDay = (d: Date) =>
    d.toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "UTC" });
  const longMonthDayYear = (d: Date) =>
    d.toLocaleDateString("en-CA", {
      month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
    });
  const rangeLabel = `${shortMonthDay(batch.payPeriod.periodStart)} – ${longMonthDayYear(periodInclusiveEnd)}`;
  const payDateLabel = longMonthDayYear(batch.payPeriod.payDate);

  const approvedAt = batch.approvedAt!;
  const dLabel = longMonthDayYear(approvedAt);
  const tLabel = approvedAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const approvedAtLabel = `${dLabel} · ${tLabel}`;

  // Executive Insights — factual observations only. Same discipline as
  // FPP-6D approval preview: no fabricated budget deltas / prior-period
  // comparisons / department causality / cash availability.
  const executiveInsights: PayrollPostingPreview["executiveInsights"] = [];
  const emp = batch.employees.length;
  executiveInsights.push({
    label: "Controller approval is complete.",
    tone: "positive",
  });
  const reconciles = grossCents - totalEmpDedCents === netCents;
  if (reconciles) {
    executiveInsights.push({
      label: `Payroll reconciles to the cent (${fmtMoney(grossCents)} gross − ${fmtMoney(totalEmpDedCents)} deductions = ${fmtMoney(netCents)} net) across ${emp} employee${emp === 1 ? "" : "s"}.`,
      tone: "positive",
    });
  } else {
    executiveInsights.push({
      label: "Payroll reconciliation shows a difference. Investigate before posting.",
      tone: "warning",
    });
  }
  executiveInsights.push({
    label: "Posting will create the accounting journal for this payroll.",
    tone: "neutral",
  });
  executiveInsights.push({
    label: "Employee payment transmission is not configured in Spectre and will remain external / manual.",
    tone: "warning",
  });

  // Canonical journal preview — the SAME resolver that
  // `postPayrollBatch` uses at commit time (see
  // src/lib/payroll/payroll-journal-preview.ts).
  let journal: PayrollJournalPreviewResult | null = null;
  const readinessBlockers: Array<{ code: string; message: string }> = [];
  try {
    journal = await previewPayrollJournal(principal, clubId, batch.id);
  } catch (err) {
    if (err instanceof ConflictError) {
      readinessBlockers.push({
        code: "PREVIEW_UNAVAILABLE",
        message: err.message,
      });
    } else {
      throw err;
    }
  }

  const journalOut: PayrollPostingPreview["journal"] = journal
    ? {
        balanced: journal.balanced,
        totalDebitsDisplay: `$${Number(journal.totalDebits).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        totalCreditsDisplay: `$${Number(journal.totalCredits).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        differenceCentsDisplay: `$${(journal.differenceCents / 100).toFixed(2)}`,
        readinessBlockers: journal.readinessBlockers,
        lines: journal.lines.map((l) => ({
          accountNumber: l.accountNumber,
          accountName: l.accountName,
          departmentCode: l.departmentCode,
          departmentName: l.departmentName,
          debitDisplay: l.debit != null
            ? `$${Number(l.debit).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : null,
          creditDisplay: l.credit != null
            ? `$${Number(l.credit).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : null,
          description: l.description,
        })),
      }
    : {
        balanced: false,
        totalDebitsDisplay: "$0.00",
        totalCreditsDisplay: "$0.00",
        differenceCentsDisplay: "$0.00",
        readinessBlockers,
        lines: [],
      };

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
    approver: {
      userId: batch.approvedByUserId ?? null,
      displayName: approver?.name ?? null,
      approvedAtIso: approvedAt.toISOString(),
      approvedAtLabel,
      approvedDateLabel: dLabel,
      approvedTimeLabel: tLabel,
      roleLabel: "Controller",
    },
    payrollAdmin: {
      userId: item.ownerUserId ?? null,
      displayName: admin?.name ?? null,
      roleLabel: "Payroll Administrator",
    },
    totals: {
      employeeCount: batch.employees.length,
      grossPayDisplay: fmtMoney(grossCents),
      employeeDeductionsDisplay: fmtMoney(totalEmpDedCents),
      netPayDisplay: fmtMoney(netCents),
      employerContributionsDisplay: fmtMoney(employerContribCents),
    },
    executiveInsights,
    journal: journalOut,
    fullReviewHref: `/app/admin/payroll/batches/${batch.id}`,
    clubDisplayName: batch.club?.name ?? "",
  };
}
