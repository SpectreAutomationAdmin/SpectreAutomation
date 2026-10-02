// TB-HIST-10 (2026-10-02) — Income Statement by Department FROM
// COMMITTED JONAS SNAPSHOT (dimensional).
//
// `incomeStatementByDepartment` (in reports.ts) reads POSTED
// JournalEntryLine directly — fine for the operational-ledger path,
// but empty on a Jonas-only tenant (Coulee) where no JE rows exist.
// This resolver serves the same report from the committed Jonas
// Trial Balance snapshot's dimensional payload:
//
//   • Routes through `reportingAccountBalances({from, to}, {
//     allowCarryForward: true })` so the Jonas TB's YTD slice is
//     the source of truth (same resolver chain as the consolidated
//     Income Statement, directive §4-6).
//   • Walks each AccountBalance's `dimensional[]` array (TB-HIST-7
//     seeds this with the per-line (department, fund) tuple from
//     the snapshot payload).
//   • Groups by Spectre Department code — the committed Jan 31 2026
//     snapshot's `department` column already carries the RESOLVED
//     Spectre code (TB-HIST-6 commit-path rewrites Jonas codes to
//     Spectre before writing the payload). The nondepartmental
//     bucket (`department=null`) collects Balance-Sheet-marker
//     accounts (Jonas 000000).
//   • Classifies by `AccountBalance.accountType` + `fsGroupKey`
//     (COGS = fsGroupKey starts with "IS_COGS_" or equals "IS_COGS").
//     No account-number ranges, no description matching, no Jonas
//     legacy numbers — the directive §2 forbids all of those.
//   • Returns per-department numerics PLUS a reconciliation struct
//     that proves "sum of per-dept rows == consolidated totals"
//     subject to the $0.01 rounding tolerance. The hard gate at
//     §5 is enforced in the caller (Chapter X builder); any gap
//     is surfaced, never hidden.

import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { consolidateAccountBalances } from "./balance";
import { sumMoney, toMoney, ZERO } from "./decimal";
import { reportingAccountBalances, type ReportingBalanceSource } from "./reporting-balances";

export type DepartmentPLSnapshotRow = {
  departmentId: string | null;
  departmentCode: string | null;
  departmentName: string;
  revenue: Prisma.Decimal;
  cogs: Prisma.Decimal;
  opex: Prisma.Decimal;
  netIncome: Prisma.Decimal;
};

export type DepartmentPLSnapshotReconciliation = {
  consolidated: { revenue: Prisma.Decimal; cogs: Prisma.Decimal; opex: Prisma.Decimal; netIncome: Prisma.Decimal };
  departmentAssigned: { revenue: Prisma.Decimal; cogs: Prisma.Decimal; opex: Prisma.Decimal; netIncome: Prisma.Decimal };
  nondepartmental: { revenue: Prisma.Decimal; cogs: Prisma.Decimal; opex: Prisma.Decimal; netIncome: Prisma.Decimal };
  difference: { revenue: Prisma.Decimal; cogs: Prisma.Decimal; opex: Prisma.Decimal; netIncome: Prisma.Decimal };
  isBalanced: boolean;
};

export type DepartmentPLSnapshotResult = {
  from: Date;
  to: Date;
  rows: DepartmentPLSnapshotRow[];
  totals: { revenue: Prisma.Decimal; cogs: Prisma.Decimal; opex: Prisma.Decimal; netIncome: Prisma.Decimal };
  reconciliation: DepartmentPLSnapshotReconciliation;
  source: ReportingBalanceSource;
};

export async function incomeStatementByDepartmentFromSnapshot(
  clubId: string,
  from: Date,
  to: Date,
): Promise<DepartmentPLSnapshotResult> {
  const { balances: rawBalances, source } = await reportingAccountBalances(
    clubId,
    { from, to },
    { allowCarryForward: true },
  );

  // Tenant Department catalog for display + id resolution.
  const departments = await prisma.department.findMany({
    where: { clubId },
    select: { id: true, code: true, name: true },
  });
  const deptByCode = new Map(departments.map((d) => [d.code.toUpperCase(), d]));

  // Group per-dim by Spectre dept code (null for nondepartmental).
  const perDept = new Map<
    string | null,
    { revenue: Prisma.Decimal; cogs: Prisma.Decimal; opex: Prisma.Decimal }
  >();

  for (const b of rawBalances) {
    if (b.accountType !== "REVENUE" && b.accountType !== "EXPENSE") continue;
    const isCogs =
      b.fsGroupKey != null &&
      (b.fsGroupKey.startsWith("IS_COGS_") || b.fsGroupKey === "IS_COGS");

    const dims =
      b.dimensional && b.dimensional.length > 0
        ? b.dimensional
        : [
            {
              department: null as string | null,
              fund: null as string | null,
              debit: b.debitTotal,
              credit: b.creditTotal,
              signedBalance: b.signedBalance,
              naturalBalance: b.naturalBalance,
            },
          ];

    for (const d of dims) {
      const key = d.department && d.department.trim().length > 0 ? d.department.trim() : null;
      const bucket = perDept.get(key) ?? { revenue: ZERO, cogs: ZERO, opex: ZERO };
      const amount = d.naturalBalance;
      if (b.accountType === "REVENUE") {
        bucket.revenue = bucket.revenue.plus(amount);
      } else if (isCogs) {
        bucket.cogs = bucket.cogs.plus(amount);
      } else {
        bucket.opex = bucket.opex.plus(amount);
      }
      perDept.set(key, bucket);
    }
  }

  // Build per-dept rows. Sort: nondepartmental first (null), then by
  // Spectre code alphabetically.
  const rows: DepartmentPLSnapshotRow[] = Array.from(perDept.entries()).map(([code, v]) => {
    const dept = code != null ? deptByCode.get(code.toUpperCase()) : null;
    const departmentName = code === null ? "Nondepartmental" : dept?.name ?? code;
    return {
      departmentId: dept?.id ?? null,
      departmentCode: code,
      departmentName,
      revenue: v.revenue,
      cogs: v.cogs,
      opex: v.opex,
      netIncome: v.revenue.minus(v.cogs).minus(v.opex),
    };
  });
  rows.sort((a, b) => {
    if (a.departmentCode === null) return -1;
    if (b.departmentCode === null) return 1;
    return a.departmentCode.localeCompare(b.departmentCode);
  });

  const totals = {
    revenue: sumMoney(rows.map((r) => r.revenue)),
    cogs: sumMoney(rows.map((r) => r.cogs)),
    opex: sumMoney(rows.map((r) => r.opex)),
    netIncome: sumMoney(rows.map((r) => r.netIncome)),
  };

  // Reconciliation: rebuild consolidated via the same path the
  // standalone IS uses.
  const consolidatedBalances = consolidateAccountBalances(rawBalances);
  let consolidatedRevenue = ZERO;
  let consolidatedCogs = ZERO;
  let consolidatedOpex = ZERO;
  for (const b of consolidatedBalances) {
    if (b.accountType === "REVENUE") {
      consolidatedRevenue = consolidatedRevenue.plus(b.naturalBalance);
    } else if (b.accountType === "EXPENSE") {
      const isCogs =
        b.fsGroupKey != null &&
        (b.fsGroupKey.startsWith("IS_COGS_") || b.fsGroupKey === "IS_COGS");
      if (isCogs) consolidatedCogs = consolidatedCogs.plus(b.naturalBalance);
      else consolidatedOpex = consolidatedOpex.plus(b.naturalBalance);
    }
  }
  const consolidatedNetIncome = consolidatedRevenue
    .minus(consolidatedCogs)
    .minus(consolidatedOpex);

  const deptAssignedRows = rows.filter((r) => r.departmentCode !== null);
  const nondeptRow = rows.find((r) => r.departmentCode === null);
  const departmentAssigned = {
    revenue: sumMoney(deptAssignedRows.map((r) => r.revenue)),
    cogs: sumMoney(deptAssignedRows.map((r) => r.cogs)),
    opex: sumMoney(deptAssignedRows.map((r) => r.opex)),
    netIncome: sumMoney(deptAssignedRows.map((r) => r.netIncome)),
  };
  const nondepartmental = {
    revenue: nondeptRow?.revenue ?? ZERO,
    cogs: nondeptRow?.cogs ?? ZERO,
    opex: nondeptRow?.opex ?? ZERO,
    netIncome: nondeptRow?.netIncome ?? ZERO,
  };

  const difference = {
    revenue: consolidatedRevenue.minus(departmentAssigned.revenue).minus(nondepartmental.revenue),
    cogs: consolidatedCogs.minus(departmentAssigned.cogs).minus(nondepartmental.cogs),
    opex: consolidatedOpex.minus(departmentAssigned.opex).minus(nondepartmental.opex),
    netIncome: consolidatedNetIncome.minus(departmentAssigned.netIncome).minus(nondepartmental.netIncome),
  };
  const TOL = toMoney("0.01");
  const isBalanced =
    difference.revenue.abs().lte(TOL) &&
    difference.cogs.abs().lte(TOL) &&
    difference.opex.abs().lte(TOL) &&
    difference.netIncome.abs().lte(TOL);

  return {
    from, to, rows, totals,
    reconciliation: {
      consolidated: { revenue: consolidatedRevenue, cogs: consolidatedCogs, opex: consolidatedOpex, netIncome: consolidatedNetIncome },
      departmentAssigned,
      nondepartmental,
      difference,
      isBalanced,
    },
    source,
  };
}
