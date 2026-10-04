// BUDGET-HIST-1 (2026-10-04) — canonical Budget resolver.
//
// Single source for every Board-package Budget read. Consumers must
// NEVER read `prisma.budgetLine` directly — all queries flow through
// `resolveBudget(…)` so Board / scorecard / department / payroll
// consumers see one authoritative value for the same metric.
//
// Resolution contract:
//   • Reads the newest Budget row for (clubId, fiscalYear, name) by
//     version. Prior versions remain in the DB untouched for audit.
//   • Returns per-month, YTD, and full-year aggregates in RAW dollars
//     (preserved sign + decimals from source).
//   • Supports consolidated, per-department, per-account, and per-FS-
//     group aggregates.
//   • `throughMonth` is 1-indexed (1 = Jan, 12 = Dec).
//
// Sign + presentation semantics:
//   This resolver returns raw stored amounts verbatim. Any sign-flip
//   convention (revenue naturally negative in some ERPs, flipped for
//   board display) MUST be applied by the reporting projection layer
//   at the same place Actual sign semantics are applied — the
//   resolver stays presentation-neutral per directive §13.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

const CENTS = new Prisma.Decimal(100);

export type ResolveBudgetArgs = {
  clubId: string;
  fiscalYear: number;
  /** 1-indexed month. YTD aggregates sum Jan..throughMonth. */
  throughMonth: number;
  budgetName?: string;      // default: "Coulee 2026 Operating Budget"
};

export type ResolveBudgetResult = {
  budget: {
    id: string;
    version: number;
    status: string;
    sourceFileHash: string | null;
    importedAt: string | null;
  } | null;
  /** 12 monthly totals (Jan..Dec), raw dollars. */
  monthlyTotals: number[];
  /** YTD sum through `throughMonth`, raw dollars. */
  ytdTotal: number;
  /** Full-year total, raw dollars. */
  fullYearTotal: number;
  /** Per-department aggregates (both monthly + YTD + annual). */
  byDepartment: Array<{
    departmentId: string | null;
    departmentCode: string | null;
    departmentName: string | null;
    monthlyTotals: number[];
    ytdTotal: number;
    annualTotal: number;
  }>;
  /** Per-account aggregates (same shape). */
  byAccount: Array<{
    accountId: string;
    accountNumber: string;
    accountName: string;
    accountType: string;
    fsGroupKey: string | null;
    monthlyTotals: number[];
    ytdTotal: number;
    annualTotal: number;
  }>;
  /** Per-FS-group aggregates (REVENUE / IS_COGS* / IS_PAYROLL / …). */
  byFsGroup: Array<{
    fsGroupKey: string | null;
    monthlyTotals: number[];
    ytdTotal: number;
    annualTotal: number;
  }>;
};

export const DEFAULT_BUDGET_NAME = "Coulee 2026 Operating Budget";

export async function resolveBudget(
  args: ResolveBudgetArgs,
): Promise<ResolveBudgetResult> {
  const throughMonth = Math.max(1, Math.min(12, Math.trunc(args.throughMonth)));
  const budgetName = args.budgetName ?? DEFAULT_BUDGET_NAME;

  // Pin to the newest version for this fiscal year.
  const budget = await prisma.budget.findFirst({
    where: {
      clubId: args.clubId,
      name: budgetName,
      fiscalYear: {
        clubId: args.clubId,
        startDate: { gte: new Date(Date.UTC(args.fiscalYear, 0, 1)) },
        endDate: { lte: new Date(Date.UTC(args.fiscalYear + 1, 0, 1)) },
      },
    },
    orderBy: { version: "desc" },
    select: {
      id: true,
      version: true,
      status: true,
      description: true,
    },
  });

  if (!budget) {
    return {
      budget: null,
      monthlyTotals: Array(12).fill(0),
      ytdTotal: 0,
      fullYearTotal: 0,
      byDepartment: [],
      byAccount: [],
      byFsGroup: [],
    };
  }

  let sourceFileHash: string | null = null;
  let importedAt: string | null = null;
  if (budget.description) {
    try {
      const parsed = JSON.parse(budget.description) as {
        sourceFileHash?: string;
        importedAt?: string;
      };
      sourceFileHash = parsed.sourceFileHash ?? null;
      importedAt = parsed.importedAt ?? null;
    } catch {
      /* ignore */
    }
  }

  const lines = await prisma.budgetLine.findMany({
    where: { budgetId: budget.id, clubId: args.clubId },
    include: {
      account: {
        select: {
          id: true,
          accountNumber: true,
          name: true,
          type: true,
          fsGroup: { select: { key: true } },
        },
      },
      department: {
        select: { id: true, code: true, name: true },
      },
    },
  });

  // Parse each line's 12-month array once.
  type Line = {
    monthly: number[];
    annual: number;
    accountId: string;
    accountNumber: string;
    accountName: string;
    accountType: string;
    fsGroupKey: string | null;
    departmentId: string | null;
    departmentCode: string | null;
    departmentName: string | null;
  };
  const parsed: Line[] = lines.map((l) => {
    const monthly = (() => {
      try {
        const arr = JSON.parse(l.monthlyAmounts) as unknown;
        if (Array.isArray(arr) && arr.length === 12) {
          return arr.map((n) => Number(n));
        }
      } catch { /* ignore */ }
      return Array(12).fill(0);
    })();
    return {
      monthly,
      annual: Number(l.annualTotal.toString()),
      accountId: l.account.id,
      accountNumber: l.account.accountNumber,
      accountName: l.account.name,
      accountType: l.account.type,
      fsGroupKey: l.account.fsGroup?.key ?? null,
      departmentId: l.department?.id ?? null,
      departmentCode: l.department?.code ?? null,
      departmentName: l.department?.name ?? null,
    };
  });

  // ---------- Consolidated ----------
  const monthlyTotals = Array(12).fill(0);
  for (const l of parsed) for (let m = 0; m < 12; m++) monthlyTotals[m] += l.monthly[m];
  const ytdTotal = monthlyTotals.slice(0, throughMonth).reduce((s, v) => s + v, 0);
  const fullYearTotal = monthlyTotals.reduce((s, v) => s + v, 0);

  // ---------- By department ----------
  const deptMap = new Map<string | null, { monthlyTotals: number[]; annualTotal: number; row: Line }>();
  for (const l of parsed) {
    const key = l.departmentId;
    let b = deptMap.get(key);
    if (!b) {
      b = { monthlyTotals: Array(12).fill(0), annualTotal: 0, row: l };
      deptMap.set(key, b);
    }
    for (let m = 0; m < 12; m++) b.monthlyTotals[m] += l.monthly[m];
    b.annualTotal += l.annual;
  }
  const byDepartment = Array.from(deptMap.entries()).map(([_, v]) => ({
    departmentId: v.row.departmentId,
    departmentCode: v.row.departmentCode,
    departmentName: v.row.departmentName,
    monthlyTotals: v.monthlyTotals,
    ytdTotal: v.monthlyTotals.slice(0, throughMonth).reduce((s, x) => s + x, 0),
    annualTotal: v.annualTotal,
  }));

  // ---------- By account ----------
  const acctMap = new Map<string, { monthlyTotals: number[]; annualTotal: number; row: Line }>();
  for (const l of parsed) {
    let b = acctMap.get(l.accountId);
    if (!b) {
      b = { monthlyTotals: Array(12).fill(0), annualTotal: 0, row: l };
      acctMap.set(l.accountId, b);
    }
    for (let m = 0; m < 12; m++) b.monthlyTotals[m] += l.monthly[m];
    b.annualTotal += l.annual;
  }
  const byAccount = Array.from(acctMap.entries()).map(([_, v]) => ({
    accountId: v.row.accountId,
    accountNumber: v.row.accountNumber,
    accountName: v.row.accountName,
    accountType: v.row.accountType,
    fsGroupKey: v.row.fsGroupKey,
    monthlyTotals: v.monthlyTotals,
    ytdTotal: v.monthlyTotals.slice(0, throughMonth).reduce((s, x) => s + x, 0),
    annualTotal: v.annualTotal,
  }));

  // ---------- By FS group ----------
  const fsMap = new Map<string | null, { monthlyTotals: number[]; annualTotal: number }>();
  for (const l of parsed) {
    const key = l.fsGroupKey;
    let b = fsMap.get(key);
    if (!b) { b = { monthlyTotals: Array(12).fill(0), annualTotal: 0 }; fsMap.set(key, b); }
    for (let m = 0; m < 12; m++) b.monthlyTotals[m] += l.monthly[m];
    b.annualTotal += l.annual;
  }
  const byFsGroup = Array.from(fsMap.entries()).map(([k, v]) => ({
    fsGroupKey: k,
    monthlyTotals: v.monthlyTotals,
    ytdTotal: v.monthlyTotals.slice(0, throughMonth).reduce((s, x) => s + x, 0),
    annualTotal: v.annualTotal,
  }));

  return {
    budget: {
      id: budget.id,
      version: budget.version,
      status: budget.status,
      sourceFileHash,
      importedAt,
    },
    monthlyTotals,
    ytdTotal,
    fullYearTotal,
    byDepartment,
    byAccount,
    byFsGroup,
  };
}

/** Convenience: just the Income-Statement roll-up for the Operating
 *  dashboard. Returns dollars (not cents). Positive = favorable to
 *  the respective line (callers must apply sign convention). */
export async function resolveBudgetIncomeStatement(
  args: Omit<ResolveBudgetArgs, "budgetName"> & { budgetName?: string },
): Promise<{
  revenue: number;
  cogs: number;
  opex: number;
  payroll: number;
  noi: number;
  ytdWindow: { from: number; through: number };
  budget: ResolveBudgetResult["budget"];
}> {
  const r = await resolveBudget(args);
  // We lean on the Account.type + Account.fsGroup.key classifier that
  // powers the Actual Income Statement so the Budget projection is
  // apples-to-apples with Actual (REPORT-CHART-1A §3 confirmed the
  // IS resolver uses `type === "REVENUE" | "EXPENSE"` and the
  // fsGroupKey "IS_COGS*" split).
  let revenue = 0;
  let cogs = 0;
  let opex = 0;
  let payroll = 0;
  for (const a of r.byAccount) {
    const ytd = a.monthlyTotals.slice(0, args.throughMonth).reduce((s, v) => s + v, 0);
    if (a.accountType === "REVENUE") {
      revenue += ytd;
    } else if (a.accountType === "EXPENSE") {
      const key = a.fsGroupKey ?? "";
      if (key.startsWith("IS_COGS")) cogs += ytd;
      else opex += ytd;
      if (key === "IS_PAYROLL") payroll += ytd;
    }
  }
  // Operating ERPs often store Revenue as a negative natural balance
  // (credit) and Expenses as positive (debit). The Spectre Actual
  // projection converts natural balance → DISPLAY sign at render
  // time. Budget source signs mirror this convention for Coulee
  // (REVENUE accounts carry negative amounts). We invert REVENUE
  // signs here so the returned numbers are DISPLAY-sign-aligned
  // (positive revenue, positive expense, positive NOI when revenue
  // exceeds expense), matching the Actual projection consumers
  // expect. If a tenant's source signs ever diverge from this, this
  // conversion is the ONE place to override — never in a React
  // component.
  const displayRevenue = -revenue;
  const displayNoi = displayRevenue - cogs - opex;
  return {
    revenue: displayRevenue,
    cogs,
    opex,
    payroll,
    noi: displayNoi,
    ytdWindow: { from: 1, through: args.throughMonth },
    budget: r.budget,
  };
}
