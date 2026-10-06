// FB-LIVE-1 (2026-10-06) — canonical Food & Beverage financial
// resolver.
//
// ONE provider-neutral resolver that serves Section XIII (F&B
// Statistics) with the SAME per-department income-statement
// numbers Section X (Departmental P&L Summary) renders — never a
// parallel calculation. Reconciliation is by construction:
//
//   Actuals  ← `incomeStatementByDepartmentFromSnapshot`
//               (Section X's exact resolver — F&B row filtered out)
//   Budget   ← `resolveFbBudgetYtd`
//               (BudgetLine filtered to F&B department, grouped by
//                fsGroupKey / accountType — same semantic as
//                `resolveBudgetPayrollByDepartment`)
//
// Classification rules:
//   - Revenue  = AccountType === "REVENUE"
//   - COGS     = fsGroupKey starts with "IS_COGS_" OR equals "IS_COGS"
//   - Payroll  = fsGroupKey === "IS_PAYROLL" (additive subset of OpEx)
//   - OpEx     = all remaining EXPENSE accounts (INCLUDING payroll),
//                excluding IS_DEPRECIATION
//   - NetIncome = Revenue − COGS − OpEx  (same identity Section X uses)
//
// No account-name regex, no account-number ranges, no Jonas legacy
// numbers. All classification flows through the canonical COA
// (Account.type / fsGroup.key) and the canonical Department
// dimension.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ZERO, toMoney } from "@/lib/accounting/decimal";
import { incomeStatementByDepartmentFromSnapshot } from "@/lib/accounting/dept-pl-from-snapshot";
import {
  DEFAULT_BUDGET_NAME,
  isOperatingFundTag,
} from "@/lib/reporting/budget-resolver";

export const FB_DEPARTMENT_NAME_LOWER = "food & beverage";

export type FbFinancialYtd = {
  // Which Department row matched. Null when no F&B row was present in
  // the consolidated per-department rollup — downstream Section XIII
  // then renders every financial KPI as UNAVAILABLE.
  department: {
    code: string | null;
    name: string;
  } | null;

  // Actual (committed TB) YTD results — reconcile to Section X.
  actual: {
    revenue:    Prisma.Decimal;
    cogs:       Prisma.Decimal;
    opex:       Prisma.Decimal; // includes payroll
    payroll:    Prisma.Decimal; // additive subset of opex
    netIncome:  Prisma.Decimal;
    // Source provenance.
    source:     string;
  } | null;

  // Budget YTD — same semantics, from `BudgetLine`.
  budget: {
    revenue:    number;
    cogs:       number;
    opex:       number;
    payroll:    number;
    netIncome:  number;
    budgetId:   string | null;
    budgetName: string;
  } | null;
};

export type ResolveFbFinancialYtdInput = {
  clubId: string;
  /** YTD start — fiscal year start, UTC midnight. */
  ytdStart: Date;
  /** YTD end — last day of the reporting period, UTC midnight. */
  ytdEnd: Date;
  /** Fiscal year label (e.g. 2026). Used to pick the right Budget. */
  fiscalYear: number;
  /** 1-indexed month-of-fiscal-year through which to accumulate budget
   *  (e.g. 1 for January YTD). */
  throughMonth: number;
  /** Optional budget-name override (defaults to the canonical
   *  "Coulee <fiscalYear> Operating Budget"). */
  budgetName?: string;
};

export async function resolveFbFinancialYtd(input: ResolveFbFinancialYtdInput): Promise<FbFinancialYtd> {
  const { clubId, ytdStart, ytdEnd } = input;

  // -------- Actuals --------
  const dept = await findFbDepartment(clubId);
  const departmentField = dept ? { code: dept.code, name: dept.name } : null;

  const deptPl = await incomeStatementByDepartmentFromSnapshot(clubId, ytdStart, ytdEnd);
  const fbRow = deptPl.rows.find(
    (r) => r.departmentName.toLowerCase() === FB_DEPARTMENT_NAME_LOWER,
  );
  const actual = fbRow
    ? {
        revenue:   fbRow.revenue,
        cogs:      fbRow.cogs,
        opex:      fbRow.opex,
        payroll:   fbRow.payroll,
        netIncome: fbRow.netIncome,
        source:    deptPl.source,
      }
    : null;

  // -------- Budget --------
  const budget = await resolveFbBudgetYtd({
    clubId,
    fiscalYear: input.fiscalYear,
    throughMonth: input.throughMonth,
    budgetName: input.budgetName ?? `Coulee ${input.fiscalYear} Operating Budget`,
    departmentId: dept?.id ?? null,
  });

  return {
    department: departmentField,
    actual,
    budget,
  };
}

async function findFbDepartment(clubId: string): Promise<{ id: string; code: string; name: string } | null> {
  const depts = await prisma.department.findMany({
    where: { clubId },
    select: { id: true, code: true, name: true },
  });
  return depts.find((d) => d.name.toLowerCase() === FB_DEPARTMENT_NAME_LOWER) ?? null;
}

type FbBudgetYtdInput = {
  clubId: string;
  fiscalYear: number;
  throughMonth: number;
  budgetName: string;
  departmentId: string | null;
};

/** Resolve the F&B department's YTD budget, grouped by fsGroupKey /
 *  accountType. Same accountType/fsGroup classification as the
 *  Actual resolver — reconciliation is semantic, not textual. */
async function resolveFbBudgetYtd(input: FbBudgetYtdInput): Promise<FbFinancialYtd["budget"]> {
  if (!input.departmentId) return null;

  const budget = await prisma.budget.findFirst({
    where: {
      clubId: input.clubId,
      name: input.budgetName,
      fiscalYear: {
        clubId: input.clubId,
        startDate: { gte: new Date(Date.UTC(input.fiscalYear, 0, 1)) },
        endDate:   { lte: new Date(Date.UTC(input.fiscalYear + 1, 0, 1)) },
      },
    },
    orderBy: { version: "desc" },
    select: { id: true, version: true },
  });
  if (!budget) return null;

  const lines = await prisma.budgetLine.findMany({
    where: {
      clubId: input.clubId,
      budgetId: budget.id,
      departmentId: input.departmentId,
    },
    include: {
      account: {
        select: {
          id: true,
          type: true,
          fundApplicability: true,
          fsGroup: { select: { key: true } },
        },
      },
    },
  });

  const through = Math.max(1, Math.min(12, input.throughMonth));
  let revenue = 0;
  let cogs = 0;
  let opex = 0;
  let payroll = 0;
  for (const l of lines) {
    if (!isOperatingFundTag(l.account.fundApplicability)) continue;
    const fsGroupKey = l.account.fsGroup?.key ?? null;
    if (fsGroupKey === "IS_DEPRECIATION") continue;
    const monthly = parseMonthly(l.monthlyAmounts);
    const ytd = monthly.slice(0, through).reduce((s, v) => s + v, 0);
    if (l.account.type === "REVENUE") {
      revenue += ytd;
    } else if (l.account.type === "EXPENSE") {
      const isCogs =
        fsGroupKey != null &&
        (fsGroupKey.startsWith("IS_COGS_") || fsGroupKey === "IS_COGS");
      if (isCogs) {
        cogs += ytd;
      } else {
        opex += ytd;
        if (fsGroupKey === "IS_PAYROLL") payroll += ytd;
      }
    }
  }
  return {
    revenue,
    cogs,
    opex,
    payroll,
    netIncome: revenue - cogs - opex,
    budgetId: budget.id,
    budgetName: input.budgetName,
  };
}

function parseMonthly(json: string): number[] {
  try {
    const arr = JSON.parse(json) as unknown;
    if (Array.isArray(arr) && arr.length === 12) return arr.map((n) => Number(n));
  } catch { /* ignore */ }
  return Array(12).fill(0);
}

// Reference the imports so the bundler can tree-shake correctly.
void ZERO;
void toMoney;
void DEFAULT_BUDGET_NAME;
