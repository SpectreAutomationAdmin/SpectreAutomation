// BUDGET-HIST-1 (2026-10-04) — diagnostic read endpoint. Returns the
// canonical Budget resolver output for the Jan 2026 reporting period
// so the staging acceptance can verify every A-AC package number
// against staging state (no mutations).
import { NextRequest, NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/services/principal";
import { isSuperAdmin, type Principal } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import {
  resolveBudget,
  resolveBudgetIncomeStatement,
} from "@/lib/reporting/budget-resolver";
import { incomeStatementByDepartmentFromSnapshot } from "@/lib/accounting/dept-pl-from-snapshot";

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
  const fiscalYear = Number(req.nextUrl.searchParams.get("fiscalYear") ?? "2026");
  const throughMonth = Number(req.nextUrl.searchParams.get("throughMonth") ?? "1");
  if (!clubId) return NextResponse.json({ error: "clubId required" }, { status: 400 });
  if (!hasClubAccess(principal, clubId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const resolved = await resolveBudget({ clubId, fiscalYear, throughMonth });
  const isBudget = await resolveBudgetIncomeStatement({ clubId, fiscalYear, throughMonth });

  // Pull the matching Actual by-department (Jan YTD) so the diagnostic
  // can emit the per-dept Actual vs Budget variance in-line.
  const fyStart = new Date(Date.UTC(fiscalYear, 0, 1));
  const periodEnd = new Date(Date.UTC(fiscalYear, throughMonth - 1,
    new Date(Date.UTC(fiscalYear, throughMonth, 0)).getUTCDate(), 23, 59, 59, 999));
  const actualDept = await incomeStatementByDepartmentFromSnapshot(
    clubId, fyStart, periodEnd,
  ).catch(() => null);

  const actualDeptByCode = new Map<string | null, number>();
  if (actualDept) {
    for (const r of actualDept.rows) {
      actualDeptByCode.set(r.departmentCode, Number(r.netIncome.toString()));
    }
  }

  // Join Actual + Budget per department for the YTD view. Budget
  // net income per department is the SIGN-FLIPPED YTD aggregate so
  // it matches the Actual netIncome display convention (positive =
  // net contribution).
  const perDepartment = resolved.byDepartment.map((d) => {
    const ytdRaw = d.monthlyTotals.slice(0, throughMonth).reduce((s, v) => s + v, 0);
    const budgetNetIncome = -ytdRaw; // flip to display convention
    const actualNetIncome = actualDeptByCode.get(d.departmentCode) ?? null;
    const variance =
      actualNetIncome == null ? null : actualNetIncome - budgetNetIncome;
    return {
      departmentId: d.departmentId,
      departmentCode: d.departmentCode,
      departmentName: d.departmentName,
      budgetNetIncomeYtd: budgetNetIncome,
      actualNetIncomeYtd: actualNetIncome,
      varianceYtd: variance,
    };
  });

  return NextResponse.json({
    clubId,
    fiscalYear,
    throughMonth,
    budget: resolved.budget,
    monthlyTotalsRaw: resolved.monthlyTotals,
    ytdTotalRaw: resolved.ytdTotal,
    fullYearTotalRaw: resolved.fullYearTotal,
    incomeStatementJan: isBudget,
    byFsGroup: resolved.byFsGroup.map((r) => ({
      fsGroupKey: r.fsGroupKey,
      januaryRaw: r.monthlyTotals[0],
      annualRaw: r.annualTotal,
    })),
    perDepartmentActualVsBudget: perDepartment,
    accountingBaseline: {
      account:                 await prisma.account.count({ where: { clubId } }),
      journalEntry:            await prisma.journalEntry.count({ where: { clubId } }),
      reportingLedgerBatch:    await prisma.reportingLedgerBatch.count({ where: { clubId } }),
      reportingLedgerSnapshot: await prisma.reportingLedgerSnapshot.count({ where: { clubId } }),
      budgetCount:             await prisma.budget.count({ where: { clubId } }),
      budgetLineCount:         await prisma.budgetLine.count({ where: { clubId } }),
    },
  });
}
