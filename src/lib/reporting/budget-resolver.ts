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

/** REPORT-WIRING-1A §7 (2026-10-04) — Operating Revenue / OpEx / NOI
 *  must respect `Account.fundApplicability` so Operating Statement of
 *  Activities + Executive At-a-Glance + Operating Results + ratio
 *  registry all use the same account universe. Accounts tagged only
 *  CAPITAL (initiation fees, LRP capital improvement dues, etc.) are
 *  reported on the capital side — never folded into operating totals. */
export function isOperatingFundTag(fund: string | null | undefined): boolean {
  if (!fund) return false;
  const parts = fund.split(",").map((s) => s.trim().toUpperCase());
  return parts.includes("OPERATING");
}

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
    /** REPORT-WIRING-1A §7 — account's fundApplicability tag (comma-
     *  separated: OPERATING / CAPITAL / OPERATING,CAPITAL). Null when
     *  unset. Consumers filter by this to respect the operating-vs-
     *  capital accounting boundary. */
    fundApplicability: string | null;
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
          fundApplicability: true,
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
    fundApplicability: string | null;
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
      fundApplicability: l.account.fundApplicability ?? null,
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
    fundApplicability: v.row.fundApplicability,
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

/** REPORT-LIVE-3 §6-7 (2026-10-04) — per-month Income Statement
 *  projection of the Budget. Returns 12 monthly series in DISPLAY
 *  sign (revenue flipped positive, expenses already positive, NOI =
 *  revenue − cogs − opex). Used by the Operating Results chart to
 *  render a Budget bar alongside Actual for each month that has a
 *  committed TB snapshot. Future-month Budget values are still
 *  returned (they're legitimately known) — the chart decides whether
 *  to plot them per directive §8. */
export async function resolveBudgetMonthlyIncomeStatement(
  args: ResolveBudgetArgs,
): Promise<{
  monthlyRevenue: number[];
  monthlyCogs: number[];
  /** REPORT-WIRING-1B — opex EXCLUDES depreciation.
   *  REPORT-PRESENTATION-1A.1 — opex also EXCLUDES financing
   *  (IS_INTEREST_EXPENSE) per the Board semantic. */
  monthlyOpex: number[];
  /** REPORT-WIRING-1B — depreciation surfaced separately so the NOI
   *  computation is Revenue − COGS − OpEx-ex-depreciation. */
  monthlyDepreciation: number[];
  /** REPORT-PRESENTATION-1A.1 (2026-10-05) — financing surfaced
   *  separately. Not part of NOI math. */
  monthlyFinancing: number[];
  monthlyPayroll: number[];
  monthlyNoi: number[];
  budget: ResolveBudgetResult["budget"];
}> {
  const r = await resolveBudget(args);
  const rev = Array(12).fill(0);
  const cogs = Array(12).fill(0);
  const opex = Array(12).fill(0);
  const depreciation = Array(12).fill(0);
  const financing = Array(12).fill(0);
  const payroll = Array(12).fill(0);
  for (const a of r.byAccount) {
    // REPORT-WIRING-1A §7-10 (2026-10-04) — Operating IS filter.
    if (!isOperatingFundTag(a.fundApplicability)) continue;
    for (let m = 0; m < 12; m++) {
      const v = a.monthlyTotals[m] ?? 0;
      if (a.accountType === "REVENUE") rev[m] += v;
      else if (a.accountType === "EXPENSE") {
        const key = a.fsGroupKey ?? "";
        if (key.startsWith("IS_COGS")) cogs[m] += v;
        // REPORT-WIRING-1B §20-23 (2026-10-04) — canonical NOI before
        // depreciation. Carve IS_DEPRECIATION out of opex so NOI
        // computation matches the IS projection + live-synth path.
        else if (key === "IS_DEPRECIATION") depreciation[m] += v;
        // REPORT-PRESENTATION-1A.1 (2026-10-05) — IS_INTEREST_EXPENSE
        // is financing, not operating. Carved out of opex so Budget
        // NOI reconciles to the Actual NOI definition.
        else if (key === "IS_INTEREST_EXPENSE") financing[m] += v;
        else opex[m] += v;
        if (key === "IS_PAYROLL") payroll[m] += v;
      }
    }
  }
  // Display sign: revenue natural is negative, flip to positive.
  const monthlyRevenue = rev.map((v) => -v);
  const monthlyNoi = monthlyRevenue.map((rv, i) => rv - cogs[i] - opex[i]);
  return {
    monthlyRevenue,
    monthlyCogs: cogs,
    monthlyOpex: opex,
    monthlyDepreciation: depreciation,
    monthlyFinancing: financing,
    monthlyPayroll: payroll,
    monthlyNoi,
    budget: r.budget,
  };
}

/** REPORT-LIVE-3 §21-24 (2026-10-04) — per-department payroll Budget
 *  (IS_PAYROLL fsGroupKey only), YTD through the selected month.
 *  Returns a flat `{ departmentCode -> payrollBudget }` map. */
export async function resolveBudgetPayrollByDepartment(
  args: ResolveBudgetArgs,
): Promise<Map<string | null, number>> {
  const r = await resolveBudget(args);
  const out = new Map<string | null, number>();
  for (const d of r.byDepartment) {
    // We need to re-aggregate at the dept × IS_PAYROLL cross because
    // byDepartment carries all accounts. Pull the raw byAccount set
    // and sum only IS_PAYROLL rows for this department.
  }
  // Easier: do the aggregation directly from BudgetLine via a bulk
  // read. Avoid duplicate math — reuse resolveBudget's byAccount +
  // byDepartment semantics via a second lightweight query.
  const payrollLines = await import("@/lib/prisma").then(({ prisma }) =>
    prisma.budgetLine.findMany({
      where: {
        clubId: args.clubId,
        budgetId: r.budget?.id,
        account: {
          clubId: args.clubId,
          fsGroup: { key: "IS_PAYROLL" },
        },
      },
      select: {
        monthlyAmounts: true,
        department: { select: { code: true } },
      },
    }),
  );
  const through = Math.max(1, Math.min(12, args.throughMonth));
  for (const l of payrollLines) {
    const code = l.department?.code ?? null;
    try {
      const arr = JSON.parse(l.monthlyAmounts) as unknown;
      if (Array.isArray(arr)) {
        const ytd = arr.slice(0, through).reduce<number>((s, v) => s + Number(v), 0);
        out.set(code, (out.get(code) ?? 0) + ytd);
      }
    } catch { /* ignore */ }
  }
  return out;
}

/** Convenience: just the Income-Statement roll-up for the Operating
 *  dashboard. Returns dollars (not cents). Positive = favorable to
 *  the respective line (callers must apply sign convention). */
export async function resolveBudgetIncomeStatement(
  args: Omit<ResolveBudgetArgs, "budgetName"> & { budgetName?: string },
): Promise<{
  revenue: number;
  cogs: number;
  /** OpEx EXCLUDES depreciation per REPORT-WIRING-1B §22 AND
   *  EXCLUDES financing per REPORT-PRESENTATION-1A.1. */
  opex: number;
  /** Depreciation surfaced separately so consumers can present
   *  NOI-before-dep (default) and NOI-after-dep where needed. */
  depreciation: number;
  /** REPORT-PRESENTATION-1A.1 (2026-10-05) — financing surfaced
   *  separately. Not part of NOI math. */
  financing: number;
  payroll: number;
  /** NOI BEFORE depreciation = Revenue − COGS − OpEx-ex-dep-ex-financing.
   *  Reconciles to the Section IV Financial Statement + ratio-registry. */
  noi: number;
  ytdWindow: { from: number; through: number };
  budget: ResolveBudgetResult["budget"];
}> {
  const r = await resolveBudget(args);
  let revenue = 0;
  let cogs = 0;
  let opex = 0;
  let depreciation = 0;
  let financing = 0;
  let payroll = 0;
  for (const a of r.byAccount) {
    if (!isOperatingFundTag(a.fundApplicability)) continue;
    const ytd = a.monthlyTotals.slice(0, args.throughMonth).reduce((s, v) => s + v, 0);
    if (a.accountType === "REVENUE") {
      revenue += ytd;
    } else if (a.accountType === "EXPENSE") {
      const key = a.fsGroupKey ?? "";
      if (key.startsWith("IS_COGS")) cogs += ytd;
      // REPORT-WIRING-1B §20-23 — carve depreciation out of opex.
      else if (key === "IS_DEPRECIATION") depreciation += ytd;
      // REPORT-PRESENTATION-1A.1 (2026-10-05) — carve financing out of opex.
      else if (key === "IS_INTEREST_EXPENSE") financing += ytd;
      else opex += ytd;
      if (key === "IS_PAYROLL") payroll += ytd;
    }
  }
  const displayRevenue = -revenue;
  // NOI before depreciation (canonical, excludes financing).
  const displayNoi = displayRevenue - cogs - opex;
  return {
    revenue: displayRevenue,
    cogs,
    opex,
    depreciation,
    financing,
    payroll,
    noi: displayNoi,
    ytdWindow: { from: 1, through: args.throughMonth },
    budget: r.budget,
  };
}
