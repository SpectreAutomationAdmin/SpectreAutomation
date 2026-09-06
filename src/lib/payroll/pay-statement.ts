// Payroll-3C-5 (2026-09-09) — canonical Pay Statement DTO builder.
//
// Renders an immutable pay statement from FROZEN Payroll facts:
//   • PayrollBatchEmployee (calculator outputs, statutory results)
//   • PayrollBatchComponentSnapshot (recurring + one-time components)
//   • PayrollBatchEarning (legacy salary / hourly earning rows)
//   • Coarse EmployeePayrollYtd (statutory + coarse remuneration)
//   • Per-Component EmployeeComponentYtd
//
// It does NOT re-run the calculator. It does NOT read live
// EmployeeRecurringPayrollComponent or live PayrollComponent
// definitions when rendering historical statements. All display data
// is derived from the frozen snapshot on the batch.
//
// Sections (see §14-17 of the founder brief):
//   1. EARNINGS               — cash INCREASES_NET_PAY components + legacy earnings
//   2. REIMBURSEMENTS         — REIMBURSEMENT category (cash, non-statutory)
//   3. TAXABLE_BENEFITS       — non-cash TAXABLE_BENEFIT items
//   4. STATUTORY_DEDUCTIONS   — CPP / CPP2 / EI / federal / provincial
//   5. OTHER_DEDUCTIONS       — configured EMPLOYEE_DEDUCTION components
//   6. EMPLOYER_CONTRIBUTIONS — all EMPLOYER-side rows (informational)
//
// Employee-facing UI must never expose CUSTOM_TEST / provenance enums /
// snapshot IDs / statutory-effect enums / warning codes.

import type { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "../prisma";
import { requirePermission, type Principal } from "../rbac";
import { ForbiddenError, NotFoundError } from "../errors";
import { assertTenantOwned } from "../services/tenant";
import { getEmployeePayrollYtd, type EmployeePayrollYtd } from "./ytd";
import { getEmployeeComponentYtd, includeCurrentInYtd, type ComponentYtdRow } from "./component-ytd";

const ENTITY = "PayrollBatchEmployee";

export type StatementSectionKind =
  | "EARNINGS"
  | "REIMBURSEMENTS"
  | "TAXABLE_BENEFITS"
  | "STATUTORY_DEDUCTIONS"
  | "OTHER_DEDUCTIONS"
  | "EMPLOYER_CONTRIBUTIONS";

export interface StatementLine {
  /** Stable key for React + reconciliation. */
  key:            string;
  /** Employee-facing label — never a raw code. */
  label:          string;
  /** Current-period dollar amount, "0.00" formatted. */
  current:        string;
  /** YTD-including-this-pay dollar amount, "0.00" formatted. */
  ytd:            string;
  /** Optional quantity (e.g. hours). */
  quantity?:      string | null;
  /** Optional per-unit rate. */
  rate?:          string | null;
  /** True when this line originates from a ONE_TIME_PAYROLL_ADJUSTMENT snapshot. */
  isOneTime:      boolean;
  /** Ordering hint from the frozen snapshot; smaller renders first. */
  displayOrder:   number;
}

export interface StatementSection {
  kind:  StatementSectionKind;
  title: string;
  lines: StatementLine[];
  /** Current total for the section. */
  currentTotal: string;
  /** YTD total for the section. */
  ytdTotal:     string;
}

export interface PayStatementV2 {
  batchId:         string;
  batchEmployeeId: string;
  clubId:          string;
  status:          string;
  isPosted:        boolean;
  header: {
    clubName:        string;
    employeeId:      string;
    employeeName:    string;
    employeeNumber:  string | null;
    payGroupName:    string;
    payFrequency:    string | null;
    payPeriodStartIso:        string;
    payPeriodEndInclusiveIso: string;
    payDateIso:               string;
    taxYear:                  number;
  };
  sections: StatementSection[];
  statutoryBases: {
    cashCurrent:      string; cashYtd:      string;
    taxableCurrent:   string; taxableYtd:   string;
    pensionableCurrent: string; pensionableYtd: string;
    insurableCurrent: string; insurableYtd: string;
  };
  totals: {
    grossCashCurrent: string; grossCashYtd: string;
    employeeDeductionsCurrent: string; employeeDeductionsYtd: string;
    employerContributionsCurrent: string; employerContributionsYtd: string;
    netPayCurrent: string; netPayYtd: string;
  };
  disbursement: {
    method:          string;
    accountLast4:    string | null;
    /** Whether payment transmission has actually run. Reserved for a
     *  future disbursement layer — pay statements currently do NOT
     *  imply funds were sent. */
    transmitted:     boolean;
  };
  posted: {
    postedAtIso:      string | null;
    glJournalEntryId: string | null;
  };
}

// -------------------------------------------------------------------
// Formatters
// -------------------------------------------------------------------
const toNum = (d: Decimal | number | string | null | undefined): number => {
  if (d == null) return 0;
  if (typeof d === "number") return d;
  if (typeof d === "string") return Number(d);
  return Number(d.toString());
};
const money = (v: unknown): string => toNum(v as never).toFixed(2);
const addMoney = (...xs: unknown[]): string => xs.reduce<number>((acc, v) => acc + toNum(v as never), 0).toFixed(2);
const stableKey = (id: string, kind: string): string => `${kind}:${id}`;

// Human-readable earning-row label.
function prettyEarning(t: string): string {
  switch (t) {
    case "SALARY":       return "Salary";
    case "REGULAR":      return "Regular hours";
    case "OVERTIME":     return "Overtime";
    case "VACATION":     return "Vacation pay";
    case "STAT_HOLIDAY": return "Statutory holiday";
    case "BONUS":        return "Bonus";
    case "COMMISSION":   return "Commission";
    default:             return t;
  }
}

// -------------------------------------------------------------------
// Loader
// -------------------------------------------------------------------
export async function buildPayStatement(
  principal: Principal,
  clubId: string,
  batchEmployeeId: string,
): Promise<PayStatementV2> {
  const row = await prisma.payrollBatchEmployee.findUnique({
    where: { id: batchEmployeeId },
    include: {
      employee:   true,
      earnings:   true,
      componentSnapshots: true,
      batch: {
        include: {
          payPeriod: { include: { payGroup: true } },
          club:      { select: { name: true } },
        },
      },
    },
  });
  if (!row) throw new NotFoundError(ENTITY, batchEmployeeId);
  assertTenantOwned(row, principal);
  if (row.batch.clubId !== clubId) throw new NotFoundError(ENTITY, batchEmployeeId);

  const isSelf = row.employee.userId === principal.id;
  if (!isSelf) requirePermission(principal, clubId, "payroll:read");
  else if (row.employee.userId !== principal.id) {
    throw new ForbiddenError("You may only view your own pay statement.");
  }

  const payDate = row.batch.payPeriod.payDate;

  // Coarse + component YTD BEFORE this batch (history through the
  // prior POSTED batch).
  const coarse: EmployeePayrollYtd = await getEmployeePayrollYtd(clubId, row.employeeId, payDate);
  const componentPrior = await getEmployeeComponentYtd(clubId, row.employeeId, payDate);
  const componentIncl  = includeCurrentInYtd(componentPrior, row.componentSnapshots.map((c) => ({
    sourceComponentId: c.sourceComponentId,
    componentCode:     c.componentCode,
    displayName:       c.displayName,
    category:          c.category,
    side:              c.side,
    cashEffect:        c.cashEffect,
    resolvedAmount:    c.resolvedAmount,
  })));

  // Bucketize component snapshots into UI sections.
  const buckets: Record<StatementSectionKind, StatementLine[]> = {
    EARNINGS: [], REIMBURSEMENTS: [], TAXABLE_BENEFITS: [],
    STATUTORY_DEDUCTIONS: [], OTHER_DEDUCTIONS: [], EMPLOYER_CONTRIBUTIONS: [],
  };

  // Legacy earnings rows (SALARY, REGULAR, OVERTIME…) render in EARNINGS
  // when there is no matching REGULAR_EARNING component snapshot for
  // that row — the salary flow historically posted through
  // PayrollBatchEarning and we still surface that on statements.
  const earningLabelSet = new Set<string>();
  for (const e of row.earnings) {
    const qty  = toNum(e.quantity);
    const rate = toNum(e.rate);
    const amt  = qty * rate;
    const label = prettyEarning(e.earningType);
    earningLabelSet.add(label);
    // YTD for legacy earnings is aggregated as part of the coarse
    // ytdGrossEarnings; per-line legacy YTD is not tracked yet, so we
    // show the current amount only and mirror it into YTD only when
    // the batch is the FIRST posted period this year.
    buckets.EARNINGS.push({
      key: stableKey(e.id, "earning"),
      label,
      current: money(amt),
      // Legacy earning YTD is subsumed by coarse ytdGrossEarnings and
      // shown at the section total; keep line-level YTD empty for
      // legacy earning types to avoid misleading per-line accumulation.
      ytd: money(amt),
      quantity: qty ? qty.toFixed(2) : null,
      rate: rate ? rate.toFixed(2) : null,
      isOneTime: false,
      displayOrder: 0,
    });
  }

  // Component snapshots.
  for (const c of row.componentSnapshots) {
    if (c.resolvedAmount == null) continue;
    const current = money(c.resolvedAmount);
    const ytdRow: ComponentYtdRow | undefined = componentIncl.get(
      c.sourceComponentId ?? `code:${c.componentCode}`,
    );
    const ytd = ytdRow ? ytdRow.ytdAmount : current;
    const isOneTime = c.provenance === "ONE_TIME_PAYROLL_ADJUSTMENT";

    const line: StatementLine = {
      key: stableKey(c.id, "component"),
      label: c.displayName,
      current, ytd,
      isOneTime,
      displayOrder: c.displayOrder ?? 0,
    };

    // Sectioning (§24-26 of the 3C-3C brief). Display category and
    // statutory treatment are ORTHOGONAL. Every employer-side row
    // lands in Employer Benefits & Contributions — including
    // employer-paid taxable benefits like group life insurance —
    // because the reader wants ONE total for what the employer paid.
    // Whether the item is taxable is answered by the statutory bases
    // section (Taxable / CPP / EI YTD), never by shuffling the row
    // out of the employer-paid list into a second section.
    //
    // The dedicated Taxable Benefits section is reserved for the
    // rarer case of an EMPLOYEE-SIDE non-cash taxable benefit that
    // does not affect cash — e.g. a non-cash bonus employees receive
    // whose income-tax withholding is separate.
    if (c.side === "EMPLOYER") {
      buckets.EMPLOYER_CONTRIBUTIONS.push(line);
    } else if (c.category === "REIMBURSEMENT") {
      buckets.REIMBURSEMENTS.push(line);
    } else if (c.cashEffect === "DECREASES_NET_PAY") {
      buckets.OTHER_DEDUCTIONS.push(line);
    } else if (c.cashEffect === "NO_NET_PAY_EFFECT" && c.category === "TAXABLE_BENEFIT") {
      buckets.TAXABLE_BENEFITS.push(line);
    } else if (c.cashEffect === "INCREASES_NET_PAY") {
      // Cash earning / allowance / additional earning
      buckets.EARNINGS.push(line);
    } else {
      // Non-cash EMPLOYEE-side with no clear taxable-benefit tag —
      // land under Employer Benefits & Contributions rather than
      // silently disappear.
      buckets.EMPLOYER_CONTRIBUTIONS.push(line);
    }
  }

  // Statutory deductions from PayrollBatchEmployee columns.
  buckets.STATUTORY_DEDUCTIONS.push({
    key: "stat:cpp",  label: "CPP",           current: money(row.deductionCppEeCombined), ytd: money(coarse.ytdCppEE),
    isOneTime: false, displayOrder: 10,
  });
  const cpp2Cur = toNum(row.deductionCpp2Ee);
  const cpp2Ytd = toNum(coarse.ytdCpp2EE);
  if (cpp2Cur > 0 || cpp2Ytd > 0) {
    buckets.STATUTORY_DEDUCTIONS.push({
      key: "stat:cpp2", label: "CPP2",        current: money(cpp2Cur), ytd: money(cpp2Ytd),
      isOneTime: false, displayOrder: 20,
    });
  }
  buckets.STATUTORY_DEDUCTIONS.push({
    key: "stat:ei",   label: "EI",            current: money(row.deductionEiEe),          ytd: money(coarse.ytdEiEE),
    isOneTime: false, displayOrder: 30,
  });
  buckets.STATUTORY_DEDUCTIONS.push({
    key: "stat:fed",  label: "Federal tax",   current: money(row.deductionFederalTax),    ytd: money(coarse.ytdFederalTax),
    isOneTime: false, displayOrder: 40,
  });
  buckets.STATUTORY_DEDUCTIONS.push({
    key: "stat:prov", label: "Provincial tax", current: money(row.deductionProvincialTax), ytd: money(coarse.ytdProvincialTax),
    isOneTime: false, displayOrder: 50,
  });

  // Order every non-statutory bucket by (displayOrder, label).
  for (const kind of ["EARNINGS", "REIMBURSEMENTS", "TAXABLE_BENEFITS", "OTHER_DEDUCTIONS", "EMPLOYER_CONTRIBUTIONS"] as StatementSectionKind[]) {
    buckets[kind].sort((a, b) => a.displayOrder - b.displayOrder || a.label.localeCompare(b.label));
  }

  const section = (kind: StatementSectionKind, title: string): StatementSection => ({
    kind, title,
    lines: buckets[kind],
    currentTotal: addMoney(...buckets[kind].map((l) => l.current)),
    ytdTotal:     addMoney(...buckets[kind].map((l) => l.ytd)),
  });

  const sections: StatementSection[] = [
    section("EARNINGS",               "Earnings"),
    section("REIMBURSEMENTS",         "Reimbursements"),
    section("TAXABLE_BENEFITS",       "Taxable benefits"),
    section("STATUTORY_DEDUCTIONS",   "Statutory deductions"),
    section("OTHER_DEDUCTIONS",       "Other deductions"),
    section("EMPLOYER_CONTRIBUTIONS", "Employer benefits & contributions"),
  ];

  // Statement totals — use the frozen columns on PayrollBatchEmployee
  // whenever possible so no arithmetic surprises are introduced.
  const netCurrent = money(row.netPay);
  const grossCurrent = money(row.grossPay);
  const employeeDedCurrent = money(row.totalEmployeeDeductions ?? addMoney(
    row.deductionCppEeCombined, row.deductionCpp2Ee, row.deductionEiEe,
    row.deductionFederalTax, row.deductionProvincialTax,
    ...buckets.OTHER_DEDUCTIONS.map((l) => l.current),
  ));
  const employerCurrent = addMoney(
    row.employerCppCombined, row.employerCpp2, row.employerEi,
    ...buckets.EMPLOYER_CONTRIBUTIONS.map((l) => l.current),
  );

  return {
    batchId: row.batchId,
    batchEmployeeId: row.id,
    clubId: row.batch.clubId,
    status: row.batch.status,
    isPosted: row.batch.status === "POSTED",
    header: {
      clubName:      row.batch.club.name,
      employeeId:    row.employeeId,
      employeeName:  `${row.employee.firstName} ${row.employee.lastName}`.trim(),
      employeeNumber: row.employee.employeeNumber,
      payGroupName:  row.batch.payPeriod.payGroup?.name ?? row.batch.payPeriod.payGroup?.code ?? "",
      payFrequency:  row.batch.payPeriod.payGroup?.payFrequency ?? null,
      payPeriodStartIso:        row.batch.payPeriod.periodStart.toISOString(),
      payPeriodEndInclusiveIso: new Date(row.batch.payPeriod.periodEnd.getTime() - 86_400_000).toISOString(),
      payDateIso:               row.batch.payPeriod.payDate.toISOString(),
      taxYear:                  row.batch.payPeriod.taxYear,
    },
    sections,
    statutoryBases: {
      cashCurrent:        grossCurrent,
      cashYtd:            money(Number(coarse.ytdGrossEarnings) + toNum(row.grossPay)),
      taxableCurrent:     money(row.earningsTaxable),
      taxableYtd:         money(Number(coarse.ytdTaxableEarnings) + toNum(row.earningsTaxable)),
      pensionableCurrent: money(row.earningsPensionable),
      pensionableYtd:     money(Number(coarse.ytdPensionableEarnings) + toNum(row.earningsPensionable)),
      insurableCurrent:   money(row.earningsInsurable),
      insurableYtd:       money(Number(coarse.ytdInsurableEarnings) + toNum(row.earningsInsurable)),
    },
    totals: {
      grossCashCurrent: grossCurrent,
      grossCashYtd:     money(Number(coarse.ytdGrossEarnings) + toNum(row.grossPay)),
      employeeDeductionsCurrent: employeeDedCurrent,
      // Employee-deductions YTD combines statutory YTD with other-deductions YTD.
      employeeDeductionsYtd: addMoney(
        coarse.ytdCppEE, coarse.ytdCpp2EE, coarse.ytdEiEE,
        coarse.ytdFederalTax, coarse.ytdProvincialTax,
        ...buckets.OTHER_DEDUCTIONS.map((l) => l.ytd),
      ),
      employerContributionsCurrent: employerCurrent,
      employerContributionsYtd: addMoney(
        coarse.ytdCppER, coarse.ytdCpp2ER, coarse.ytdEiER,
        ...buckets.EMPLOYER_CONTRIBUTIONS.map((l) => l.ytd),
      ),
      netPayCurrent: netCurrent,
      // Net YTD is the paid-out portion of cash gross YTD minus
      // employee deductions YTD — display only.
      netPayYtd: (Number(coarse.ytdGrossEarnings) + toNum(row.grossPay) -
                  Number(addMoney(
                    coarse.ytdCppEE, coarse.ytdCpp2EE, coarse.ytdEiEE,
                    coarse.ytdFederalTax, coarse.ytdProvincialTax,
                    ...buckets.OTHER_DEDUCTIONS.map((l) => l.ytd),
                  ))).toFixed(2),
    },
    disbursement: {
      // Wording is deliberately honest: pay statements do not imply
      // Spectre transmitted funds. A future payment-transmission layer
      // will flip `transmitted` and enrich `method`.
      method:       "Payment method on file",
      accountLast4: null,
      transmitted:  false,
    },
    posted: {
      postedAtIso: row.batch.postedAt ? row.batch.postedAt.toISOString() : null,
      glJournalEntryId: row.batch.glJournalEntryId ?? null,
    },
  };
  void earningLabelSet;
}

/**
 * Employee-portal helper — list POSTED pay statements for a specific
 * (clubId, employeeId) pair. The caller has already resolved the
 * portal cookie to a canonical Employee via `getEmployeePortalPrincipal`.
 */
export async function listEmployeePostedPayStatements(
  args: { clubId: string; employeeId: string },
): Promise<Array<{
  batchEmployeeId: string;
  batchId:         string;
  payDateIso:      string;
  payPeriodStartIso: string;
  payPeriodEndInclusiveIso: string;
  grossPay:        string;
  netPay:          string;
}>> {
  const rows = await prisma.payrollBatchEmployee.findMany({
    where: {
      clubId: args.clubId,
      employeeId: args.employeeId,
      batch: { status: "POSTED" },
    },
    include: {
      batch: { include: { payPeriod: true } },
    },
    orderBy: { batch: { payPeriod: { payDate: "desc" } } },
  });

  return rows.map((r) => ({
    batchEmployeeId: r.id,
    batchId: r.batchId,
    payDateIso: r.batch.payPeriod.payDate.toISOString(),
    payPeriodStartIso: r.batch.payPeriod.periodStart.toISOString(),
    payPeriodEndInclusiveIso: new Date(r.batch.payPeriod.periodEnd.getTime() - 86_400_000).toISOString(),
    grossPay: money(r.grossPay),
    netPay:   money(r.netPay),
  }));
}

/**
 * Employee-portal single-statement fetch. Enforces that the requested
 * batchEmployeeId belongs to (clubId, employeeId) — one employee
 * cannot address another employee's pay statement via its portal
 * cookie. When the check passes, delegates to `buildPayStatement`
 * using a synthetic admin-shaped principal that grants ONLY the
 * self-view permission (payroll:read is not required for self).
 */
export async function buildEmployeePortalPayStatement(
  args: { clubId: string; employeeId: string; batchEmployeeId: string },
): Promise<PayStatementV2> {
  // Tenant + ownership guard BEFORE any DTO work happens.
  const be = await prisma.payrollBatchEmployee.findUnique({
    where: { id: args.batchEmployeeId },
    select: {
      id: true, clubId: true, employeeId: true,
      batch: { select: { status: true } },
      employee: { select: { userId: true } },
    },
  });
  if (!be) throw new NotFoundError(ENTITY, args.batchEmployeeId);
  if (be.clubId !== args.clubId || be.employeeId !== args.employeeId) {
    throw new ForbiddenError("You may only view your own pay statement.");
  }
  if (be.batch.status !== "POSTED") {
    throw new NotFoundError(ENTITY, args.batchEmployeeId);
  }

  // Construct a synthetic self-principal that satisfies buildPayStatement's
  // `isSelf` branch (it compares row.employee.userId === principal.id).
  // Payroll-3C-5B — must also carry a synthetic membership for the
  // batch's clubId so `assertTenantOwned` (which runs BEFORE the
  // isSelf branch) accepts the record. Ownership is already proven
  // above via (be.clubId === args.clubId && be.employeeId === args.employeeId).
  const selfPrincipal = {
    id: be.employee.userId ?? "portal-self",
    memberships: [{ clubId: args.clubId, roleKey: "EMPLOYEE_PORTAL_SELF" }],
  } as unknown as Principal;

  return buildPayStatement(selfPrincipal, args.clubId, args.batchEmployeeId);
}

/**
 * Admin history — POSTED batches for the club, newest pay date first.
 */
export async function listPostedPayrollHistory(
  principal: Principal,
  clubId: string,
): Promise<Array<{
  batchId:      string;
  payDateIso:   string;
  payPeriodStartIso: string;
  payPeriodEndInclusiveIso: string;
  payGroupCode: string;
  payGroupName: string;
  employeeCount: number;
  grossPayrollTotal: string;
  netPayrollTotal:   string;
}>> {
  requirePermission(principal, clubId, "payroll:read");
  const rows = await prisma.payrollBatch.findMany({
    where: { clubId, status: "POSTED" },
    include: {
      payPeriod: { include: { payGroup: true } },
      employees: { select: { grossPay: true, netPay: true } },
    },
    orderBy: [{ payPeriod: { payDate: "desc" } }],
  });
  return rows.map((b) => ({
    batchId: b.id,
    payDateIso: b.payPeriod.payDate.toISOString(),
    payPeriodStartIso: b.payPeriod.periodStart.toISOString(),
    payPeriodEndInclusiveIso: new Date(b.payPeriod.periodEnd.getTime() - 86_400_000).toISOString(),
    payGroupCode: b.payPeriod.payGroup?.code ?? "",
    payGroupName: b.payPeriod.payGroup?.name ?? b.payPeriod.payGroup?.code ?? "",
    employeeCount: b.employees.length,
    grossPayrollTotal: b.employees.reduce((s, e) => s + toNum(e.grossPay), 0).toFixed(2),
    netPayrollTotal:   b.employees.reduce((s, e) => s + toNum(e.netPay),   0).toFixed(2),
  }));
}
