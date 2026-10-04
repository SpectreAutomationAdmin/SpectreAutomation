// REPORT-WIRING-1A (2026-10-04) — account-level diagnostic that
// surfaces the fundApplicability + category + fsGroupKey metadata
// so we can bridge the delta between:
//   • Executive IS projection ($3.122M revenue / $2.811M NOI) —
//     filters accounts via Fund Applicability (OPERATING).
//   • Ratio registry ($4.101M revenue / $3.762M NOI) — no fund filter;
//     uses Account.type === "REVENUE" / "EXPENSE".
//
// Returns per-account rows with every classification axis so the
// bridge is traceable to the penny.

import { NextRequest, NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/services/principal";
import { isSuperAdmin, type Principal } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { reportingAccountBalances } from "@/lib/accounting/reporting-balances";
import { consolidateAccountBalances } from "@/lib/accounting/balance";
import { resolveJanuaryMetricSet } from "@/lib/reporting/ratio-registry";
import { incomeStatementByDepartmentFromSnapshot } from "@/lib/accounting/dept-pl-from-snapshot";
import {
  resolveBudgetIncomeStatement,
} from "@/lib/reporting/budget-resolver";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isStaging(): boolean {
  const env = (process.env.SPECTRE_ENV ?? process.env.NEXT_PUBLIC_ENVIRONMENT ?? "").toLowerCase();
  if (env === "staging") return true;
  return env !== "production" && (process.env.NODE_ENV ?? "") !== "production";
}
function hasClubAccess(p: Principal, clubId: string): boolean {
  if (isSuperAdmin(p)) return true;
  return p.memberships.some((m) => m.clubId === clubId);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isStaging()) return NextResponse.json({ error: "Not available in production." }, { status: 404 });
  const principal = await requirePrincipal();
  const clubId = (req.nextUrl.searchParams.get("clubId") ?? "").trim();
  if (!clubId) return NextResponse.json({ error: "clubId required" }, { status: 400 });
  if (!hasClubAccess(principal, clubId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const periodStart = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(2026, 0, 31, 23, 59, 59, 999));

  // Ratio registry (Path B) + dept snapshot (Path C) + budget IS (Path D).
  const [metrics, dept, budgetIs] = await Promise.all([
    resolveJanuaryMetricSet({ clubId, periodStart, periodEnd }).catch(() => null),
    incomeStatementByDepartmentFromSnapshot(clubId, periodStart, periodEnd).catch(() => null),
    resolveBudgetIncomeStatement({ clubId, fiscalYear: 2026, throughMonth: 1 }).catch(() => null),
  ]);

  // ---- Account population from the committed Jan TB snapshot ----
  const { balances: rawBalances } = await reportingAccountBalances(
    clubId,
    { from: periodStart, to: periodEnd },
    { allowCarryForward: true },
  );
  const consolidated = consolidateAccountBalances(rawBalances);
  const accountIds = Array.from(new Set(consolidated.map((b) => b.accountId)));
  const accountRows = await prisma.account.findMany({
    where: { id: { in: accountIds } },
    select: {
      id: true, accountNumber: true, name: true, type: true,
      fundApplicability: true,
      category: { select: { key: true, name: true } },
      fsGroup: { select: { key: true, name: true } },
    },
  });
  const acctById = new Map(accountRows.map((a) => [a.id, a]));

  type Row = {
    acct: string; name: string; type: string;
    categoryKey: string | null; fsGroupKey: string | null;
    fundApplicability: string | null;
    jan: number;
    pathA_includedInOpRevenue: boolean;
    pathA_includedInOpExpense: boolean;
    pathB_isRevenue: boolean;
    pathB_isExpenseCogs: boolean;
    pathB_isExpenseOpex: boolean;
  };
  const rows: Row[] = [];
  for (const b of consolidated) {
    if (b.accountType !== "REVENUE" && b.accountType !== "EXPENSE") continue;
    const meta = acctById.get(b.accountId);
    const amount = Number(b.naturalBalance.toString());
    const fund = meta?.fundApplicability ?? null;
    const fundsSet = new Set(
      (fund ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
    );
    // Executive IS projection: Fund OPERATING only. (Simplified heuristic
    // — the real projection uses the mapper + default fund per fsGroup;
    // but a REVENUE account with explicit fund=CAPITAL or unmapped is
    // excluded from the operating totals.)
    const isOperating = fundsSet.has("OPERATING");
    const isCogs =
      b.fsGroupKey != null &&
      (b.fsGroupKey.startsWith("IS_COGS_") || b.fsGroupKey === "IS_COGS");
    rows.push({
      acct: meta?.accountNumber ?? "?",
      name: meta?.name ?? "?",
      type: b.accountType,
      categoryKey: meta?.category?.key ?? null,
      fsGroupKey: b.fsGroupKey ?? null,
      fundApplicability: fund,
      jan: amount,
      pathA_includedInOpRevenue: b.accountType === "REVENUE" && isOperating,
      pathA_includedInOpExpense: b.accountType === "EXPENSE" && isOperating,
      pathB_isRevenue: b.accountType === "REVENUE",
      pathB_isExpenseCogs: b.accountType === "EXPENSE" && isCogs,
      pathB_isExpenseOpex: b.accountType === "EXPENSE" && !isCogs,
    });
  }
  rows.sort((a, b) => a.acct.localeCompare(b.acct));

  // Bridge computations.
  const bRevenue = -rows.filter((r) => r.pathB_isRevenue).reduce((s, r) => s + r.jan, 0);
  const bCogs = rows.filter((r) => r.pathB_isExpenseCogs).reduce((s, r) => s + r.jan, 0);
  const bOpex = rows.filter((r) => r.pathB_isExpenseOpex).reduce((s, r) => s + r.jan, 0);
  const bNoi = bRevenue - bCogs - bOpex;

  const aRevenue = -rows.filter((r) => r.pathA_includedInOpRevenue).reduce((s, r) => s + r.jan, 0);
  const aExpense = rows.filter((r) => r.pathA_includedInOpExpense).reduce((s, r) => s + r.jan, 0);
  const aNoi = aRevenue - aExpense;

  // Delta accounts: REVENUE/EXPENSE accounts included in B but NOT in A
  // (fundApplicability missing or not OPERATING).
  const revenueOnlyInB = rows.filter(
    (r) => r.pathB_isRevenue && !r.pathA_includedInOpRevenue,
  );
  const expenseOnlyInB = rows.filter(
    (r) => (r.pathB_isExpenseCogs || r.pathB_isExpenseOpex) && !r.pathA_includedInOpExpense,
  );

  return NextResponse.json({
    period: { from: periodStart.toISOString(), to: periodEnd.toISOString() },
    pathA_operating_only_estimate: {
      revenue_display: aRevenue.toFixed(2),
      expense: aExpense.toFixed(2),
      noi: aNoi.toFixed(2),
      revenueAccountCount: rows.filter((r) => r.pathA_includedInOpRevenue).length,
      expenseAccountCount: rows.filter((r) => r.pathA_includedInOpExpense).length,
    },
    pathB_ratioRegistry: {
      revenue_display: bRevenue.toFixed(2),
      cogs: bCogs.toFixed(2),
      opex: bOpex.toFixed(2),
      noi: bNoi.toFixed(2),
      revenueAccountCount: rows.filter((r) => r.pathB_isRevenue).length,
      expenseAccountCount: rows.filter((r) => r.type === "EXPENSE").length,
    },
    pathC_departmentSnapshot: dept
      ? {
          totalRevenue: dept.totals.revenue.toString(),
          totalCogs: dept.totals.cogs.toString(),
          totalOpex: dept.totals.opex.toString(),
          totalNetIncome: dept.totals.netIncome.toString(),
          isBalanced: dept.reconciliation.isBalanced,
        }
      : null,
    pathD_budget: budgetIs
      ? { revenue: budgetIs.revenue, cogs: budgetIs.cogs, opex: budgetIs.opex, noi: budgetIs.noi }
      : null,
    bridge: {
      ratioRegistryRevenue: bRevenue.toFixed(2),
      pathAOperatingRevenue: aRevenue.toFixed(2),
      delta: (bRevenue - aRevenue).toFixed(2),
      explanation:
        "Delta = Σ(REVENUE accounts with fundApplicability not = OPERATING or empty)",
    },
    revenueOnlyInRatioRegistry: revenueOnlyInB.map((r) => ({
      acct: r.acct, name: r.name, fund: r.fundApplicability, fsGroup: r.fsGroupKey,
      categoryKey: r.categoryKey, jan: r.jan.toFixed(2),
    })),
    expenseOnlyInRatioRegistry: expenseOnlyInB.map((r) => ({
      acct: r.acct, name: r.name, fund: r.fundApplicability, fsGroup: r.fsGroupKey,
      categoryKey: r.categoryKey, jan: r.jan.toFixed(2),
    })),
    accountTotal: rows.length,
    accountRows: rows.slice(0, 300),
  });
}
