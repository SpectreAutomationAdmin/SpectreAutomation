// Financial-statement engine.
//
// Each report returns structured data; UI components map structure → markup.
// Reports are pure consumers of `accountBalances()` + the COA hierarchy.

import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { accountBalances, hasCommittedRealTrialBalance, type AccountBalance } from "./balance";
import { sumMoney, toMoney, ZERO } from "./decimal";
import type { AccountType, FSStatement } from "./types";

// ---------------------------------------------------------------------------
// Trial Balance
// ---------------------------------------------------------------------------
export type TrialBalanceRow = {
  accountNumber: string;
  name: string;
  type: AccountType;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
};

export type TrialBalanceResult = {
  rows: TrialBalanceRow[];
  totalDebit: Prisma.Decimal;
  totalCredit: Prisma.Decimal;
  isBalanced: boolean;
};

export async function trialBalance(clubId: string, asOf: Date, opts?: { departmentId?: string }): Promise<TrialBalanceResult> {
  const balances = await accountBalances(clubId, { asOf, departmentId: opts?.departmentId });
  const rows: TrialBalanceRow[] = balances
    .filter((b) => !b.debitTotal.equals(b.creditTotal) || !b.debitTotal.isZero())
    .map((b) => {
      // Show net debit OR net credit per row (classic TB convention).
      const signed = b.signedBalance;
      if (signed.gte(0)) return { accountNumber: b.accountNumber, name: b.accountName, type: b.accountType, debit: signed, credit: ZERO };
      return { accountNumber: b.accountNumber, name: b.accountName, type: b.accountType, debit: ZERO, credit: signed.negated() };
    });
  const totalDebit = sumMoney(rows.map((r) => r.debit));
  const totalCredit = sumMoney(rows.map((r) => r.credit));
  // Founder rule 2026-06-30 v14.6 — Trial Balance balance check
  // uses a $0.01 tolerance to absorb sub-cent aggregation noise.
  // Round both totals to 2 decimals BEFORE comparing so a
  // fractional-cent residue from `sumMoney` can't trip the
  // out-of-balance banner. Matches the pattern used by the
  // balance-sheet check at line 213.
  const debitCents = totalDebit.toDecimalPlaces(2);
  const creditCents = totalCredit.toDecimalPlaces(2);
  const variance = debitCents.minus(creditCents).abs();
  const isBalanced = variance.lte(toMoney("0.01"));
  return { rows, totalDebit, totalCredit, isBalanced };
}

// ---------------------------------------------------------------------------
// FS-group tree → flat list with hierarchy
// ---------------------------------------------------------------------------
export type FSGroupNode = {
  id: string;
  key: string;
  name: string;
  statement: FSStatement;
  cashFlowSection: string | null;
  parentKey: string | null;
  sortOrder: number;
  accounts: AccountBalance[]; // leaf-level accounts
  subgroups: FSGroupNode[];   // child groups
  // Computed amount: signed total for this group (sum of all leaf naturalBalances).
  amount: Prisma.Decimal;
};

async function buildFsTree(clubId: string, statement: FSStatement, balances: AccountBalance[]): Promise<FSGroupNode[]> {
  const groups = await prisma.financialStatementGroup.findMany({
    where: { clubId, statement },
    orderBy: { sortOrder: "asc" },
  });
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const groupByKey = new Map(groups.map((g) => [g.key, g]));

  // accountId -> account.fsGroupId
  const accountFsByBalance = new Map<string, string | null>();
  if (balances.length) {
    const accounts = await prisma.account.findMany({
      where: { id: { in: balances.map((b) => b.accountId) } },
      select: { id: true, fsGroupId: true },
    });
    for (const a of accounts) accountFsByBalance.set(a.id, a.fsGroupId);
  }

  // Build node skeleton.
  const nodes = new Map<string, FSGroupNode>();
  for (const g of groups) {
    nodes.set(g.id, {
      id: g.id,
      key: g.key,
      name: g.name,
      statement: g.statement as FSStatement,
      cashFlowSection: g.cashFlowSection,
      parentKey: g.parentGroupId ? (groupById.get(g.parentGroupId)?.key ?? null) : null,
      sortOrder: g.sortOrder,
      accounts: [],
      subgroups: [],
      amount: ZERO,
    });
  }

  // Place accounts.
  for (const b of balances) {
    const fsId = accountFsByBalance.get(b.accountId);
    if (!fsId) continue; // unmapped accounts go to a synthetic "Unmapped" group below
    const node = nodes.get(fsId);
    if (!node) continue;
    if (node.statement !== statement) continue;
    node.accounts.push(b);
    node.amount = node.amount.plus(b.naturalBalance);
  }

  // Wire parent/child + compute aggregate amounts via DFS.
  const roots: FSGroupNode[] = [];
  for (const g of groups) {
    const node = nodes.get(g.id)!;
    if (g.parentGroupId) {
      nodes.get(g.parentGroupId)?.subgroups.push(node);
    } else {
      roots.push(node);
    }
  }
  // Sort children by sortOrder.
  for (const n of nodes.values()) n.subgroups.sort((a, b) => a.sortOrder - b.sortOrder);
  roots.sort((a, b) => a.sortOrder - b.sortOrder);

  // Propagate amounts up.
  function propagate(node: FSGroupNode): Prisma.Decimal {
    for (const child of node.subgroups) {
      const sub = propagate(child);
      node.amount = node.amount.plus(sub);
    }
    return node.amount;
  }
  for (const r of roots) propagate(r);

  // Unmapped synthetic group for visibility.
  const unmapped = balances.filter((b) => {
    const fsId = accountFsByBalance.get(b.accountId);
    if (!fsId) return true;
    const g = nodes.get(fsId);
    return !g || g.statement !== statement;
  });
  if (unmapped.length) {
    const accountTypes = pickStatementTypes(statement);
    const filtered = unmapped.filter((u) => accountTypes.includes(u.accountType));
    if (filtered.length) {
      const node: FSGroupNode = {
        id: "__unmapped__",
        key: "UNMAPPED",
        name: "Unmapped Accounts",
        statement,
        cashFlowSection: null,
        parentKey: null,
        sortOrder: 9999,
        accounts: filtered,
        subgroups: [],
        amount: sumMoney(filtered.map((f) => f.naturalBalance)),
      };
      roots.push(node);
    }
  }

  // Suppress group keys that don't apply to the statement.
  void groupByKey; // used by lookup callers
  return roots;
}

function pickStatementTypes(statement: FSStatement): AccountType[] {
  if (statement === "BALANCE_SHEET") return ["ASSET", "LIABILITY", "EQUITY"];
  if (statement === "INCOME_STATEMENT") return ["REVENUE", "EXPENSE"];
  return ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"];
}

// ---------------------------------------------------------------------------
// Balance Sheet
// ---------------------------------------------------------------------------
export type BalanceSheetResult = {
  asOf: Date;
  assets: FSGroupNode[];
  liabilities: FSGroupNode[];
  equity: FSGroupNode[];
  totalAssets: Prisma.Decimal;
  totalLiabilities: Prisma.Decimal;
  totalEquity: Prisma.Decimal;
  currentYearEarnings: Prisma.Decimal;
  isBalanced: boolean;
};

export async function balanceSheet(clubId: string, asOf: Date): Promise<BalanceSheetResult> {
  // Asset/Liability/Equity activity up to asOf.
  const balances = await accountBalances(clubId, { asOf });
  const balancesNonZero = balances.filter((b) => !b.signedBalance.isZero());

  const tree = await buildFsTree(clubId, "BALANCE_SHEET", balancesNonZero.filter((b) => ["ASSET", "LIABILITY", "EQUITY"].includes(b.accountType)));

  const assets = tree.filter((n) => n.accounts.concat(flattenAccounts(n)).some((a) => a.accountType === "ASSET") || isAssetGroup(n));
  const liabilities = tree.filter((n) => isLiabilityGroup(n));
  const equity = tree.filter((n) => isEquityGroup(n));

  const totalAssets = sumMoney(assets.map((g) => g.amount));
  const totalLiabilities = sumMoney(liabilities.map((g) => g.amount));
  const totalEquity = sumMoney(equity.map((g) => g.amount));

  // Current-year earnings = revenue - expenses over the FY containing asOf.
  // We compute it independently of the equity group so unposted closing entries
  // don't affect the live BS.
  const fy = await currentFiscalYear(clubId, asOf);
  let currentYearEarnings = ZERO;
  if (fy) {
    const isBalances = await accountBalances(clubId, { from: fy.startDate, to: asOf });
    for (const b of isBalances) {
      if (b.accountType === "REVENUE") currentYearEarnings = currentYearEarnings.plus(b.naturalBalance);
      if (b.accountType === "EXPENSE") currentYearEarnings = currentYearEarnings.minus(b.naturalBalance);
    }
  }
  const totalEquityWithEarnings = totalEquity.plus(currentYearEarnings);
  const isBalanced = totalAssets.minus(totalLiabilities).minus(totalEquityWithEarnings).abs().lte(toMoney("0.01"));

  return {
    asOf,
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity: totalEquityWithEarnings,
    currentYearEarnings,
    isBalanced,
  };
}

function flattenAccounts(n: FSGroupNode): AccountBalance[] {
  return [...n.accounts, ...n.subgroups.flatMap(flattenAccounts)];
}
function groupHasType(n: FSGroupNode, t: AccountType): boolean {
  return flattenAccounts(n).some((a) => a.accountType === t);
}
function isAssetGroup(n: FSGroupNode): boolean {
  return n.key.startsWith("BS_") && (n.key.includes("ASSET") || (n.subgroups.length === 0 && groupHasType(n, "ASSET")));
}
function isLiabilityGroup(n: FSGroupNode): boolean {
  return n.key.startsWith("BS_") && (n.key.includes("LIABILIT") || n.key === "BS_DEFERRED_CONTRIBUTIONS" || (n.subgroups.length === 0 && groupHasType(n, "LIABILITY")));
}
function isEquityGroup(n: FSGroupNode): boolean {
  return n.key === "BS_EQUITY" || (n.subgroups.length === 0 && groupHasType(n, "EQUITY"));
}

// ---------------------------------------------------------------------------
// Income Statement
// ---------------------------------------------------------------------------
export type IncomeStatementResult = {
  from: Date;
  to: Date;
  revenue: FSGroupNode[];
  cogs: FSGroupNode[];
  opex: FSGroupNode[];
  totalRevenue: Prisma.Decimal;
  totalCogs: Prisma.Decimal;
  grossMargin: Prisma.Decimal;
  totalOpex: Prisma.Decimal;
  netIncome: Prisma.Decimal;
};

export async function incomeStatement(clubId: string, from: Date, to: Date, opts?: { departmentId?: string }): Promise<IncomeStatementResult> {
  const balances = await accountBalances(clubId, { from, to, departmentId: opts?.departmentId });
  const tree = await buildFsTree(clubId, "INCOME_STATEMENT", balances.filter((b) => b.accountType === "REVENUE" || b.accountType === "EXPENSE"));
  // Founder rule 2026-07-01 v14.7 — classify by ACCOUNT TYPE +
  // FS Group key prefix, not by legacy parent-group names. The
  // canonical taxonomy has no `IS_REVENUE_*`, `IS_COGS`, or
  // `IS_OPEX` parent groups (they were removed in the 2026-07-19
  // canonical lock-in). Real revenue keys are `IS_MEMBERSHIP_DUES`,
  // `IS_GREEN_FEES`, `IS_FOOD_SALES`, etc.; real COGS keys are
  // `IS_COGS_MERCHANDISE`, `IS_COGS_FOOD`, `IS_COGS_BEVERAGE`.
  //   • revenue = any group whose leaves contain a REVENUE-typed account
  //   • cogs    = any group whose key starts with `IS_COGS_`
  //   • opex    = everything else with EXPENSE-typed leaves
  const isCogsGroup = (n: FSGroupNode) => n.key.startsWith("IS_COGS_") || n.key === "IS_COGS";
  const revenue = tree.filter((n) => groupHasType(n, "REVENUE"));
  const cogs = tree.filter(isCogsGroup);
  const opex = tree.filter((n) => !isCogsGroup(n) && !groupHasType(n, "REVENUE") && groupHasType(n, "EXPENSE"));

  const totalRevenue = sumMoney(revenue.map((g) => g.amount));
  const totalCogs = sumMoney(cogs.map((g) => g.amount));
  const totalOpex = sumMoney(opex.map((g) => g.amount));
  const grossMargin = totalRevenue.minus(totalCogs);
  const netIncome = grossMargin.minus(totalOpex);

  return { from, to, revenue, cogs, opex, totalRevenue, totalCogs, grossMargin, totalOpex, netIncome };
}

// ---------------------------------------------------------------------------
// Income Statement by Department
// ---------------------------------------------------------------------------
export type DepartmentISRow = {
  departmentId: string | null;
  departmentName: string;
  revenue: Prisma.Decimal;
  cogs: Prisma.Decimal;
  opex: Prisma.Decimal;
  contribution: Prisma.Decimal;
};

export async function incomeStatementByDepartment(clubId: string, from: Date, to: Date): Promise<{
  rows: DepartmentISRow[];
  totalRevenue: Prisma.Decimal;
  totalCogs: Prisma.Decimal;
  totalOpex: Prisma.Decimal;
  totalContribution: Prisma.Decimal;
}> {
  // v14.9 — exclude DEMO-tagged seed entries when the club has
  // committed a real Trial Balance import. Same rule as
  // accountBalances(); keeps report classification consistent.
  const excludeDemo = await hasCommittedRealTrialBalance(clubId);
  // Pull all posted IS lines in the window with department info.
  // Founder rule 2026-07-01 v14.10 — also pull the account's
  // `defaultDepartment` so we can fall back to it when the line's
  // own `departmentId` is null. Journal entries posted by the
  // v14.3 Opening Trial Balance import never populated the line-
  // level departmentId; the COA mapping is on the account itself.
  // Without this fallback, every TB-imported line lands under
  // "Unassigned" regardless of the imported COA's dept mapping.
  const rows = await prisma.journalEntryLine.findMany({
    where: {
      clubId,
      entry: {
        status: "POSTED",
        entryDate: { gte: from, lte: to },
        ...(excludeDemo ? { source: { not: "DEMO" } } : {}),
      },
      account: { type: { in: ["REVENUE", "EXPENSE"] } },
    },
    include: {
      account: { include: { defaultDepartment: true } },
      department: true,
    },
  });

  const byDept = new Map<string, { name: string; revenue: Prisma.Decimal; cogs: Prisma.Decimal; opex: Prisma.Decimal }>();
  for (const r of rows) {
    // v14.10 — line-level department wins when present; else the
    // account's defaultDepartment (from the COA import) is used;
    // else the row lands in "Unassigned" for genuinely-unmapped
    // accounts (a diagnostic signal, not a default).
    const effectiveDeptId = r.departmentId ?? r.account.defaultDepartmentId ?? null;
    const effectiveDeptName =
      r.department?.name ?? r.account.defaultDepartment?.name ?? "Unassigned";
    const key = effectiveDeptId ?? "__none__";
    const name = effectiveDeptName;
    if (!byDept.has(key)) byDept.set(key, { name, revenue: ZERO, cogs: ZERO, opex: ZERO });
    const bucket = byDept.get(key)!;
    const debit = toMoney(r.debit as unknown as Prisma.Decimal);
    const credit = toMoney(r.credit as unknown as Prisma.Decimal);
    // Revenue: credit increases.  Expense: debit increases.
    if (r.account.type === "REVENUE") bucket.revenue = bucket.revenue.plus(credit).minus(debit);
    else if (r.account.fsGroupId) {
      // Founder rule 2026-07-01 v14.8 — same fix as v14.7 for the
      // main Income Statement. Canonical taxonomy has NO `IS_COGS`
      // parent group; actual keys are `IS_COGS_MERCHANDISE`,
      // `IS_COGS_FOOD`, `IS_COGS_BEVERAGE`. The old exact-match
      // sent every COGS entry to OPEX, producing inflated Operating
      // Expenses on the department report.
      const fs = await prisma.financialStatementGroup.findUnique({ where: { id: r.account.fsGroupId } });
      const isCogs = !!fs?.key && (fs.key.startsWith("IS_COGS_") || fs.key === "IS_COGS");
      if (isCogs) bucket.cogs = bucket.cogs.plus(debit).minus(credit);
      else bucket.opex = bucket.opex.plus(debit).minus(credit);
    } else {
      bucket.opex = bucket.opex.plus(debit).minus(credit);
    }
  }

  const result: DepartmentISRow[] = Array.from(byDept.entries()).map(([k, v]) => ({
    departmentId: k === "__none__" ? null : k,
    departmentName: v.name,
    revenue: v.revenue,
    cogs: v.cogs,
    opex: v.opex,
    contribution: v.revenue.minus(v.cogs).minus(v.opex),
  }));
  result.sort((a, b) => a.departmentName.localeCompare(b.departmentName));

  return {
    rows: result,
    totalRevenue: sumMoney(result.map((r) => r.revenue)),
    totalCogs: sumMoney(result.map((r) => r.cogs)),
    totalOpex: sumMoney(result.map((r) => r.opex)),
    totalContribution: sumMoney(result.map((r) => r.contribution)),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function currentFiscalYear(clubId: string, asOf: Date) {
  return prisma.fiscalYear.findFirst({
    where: { clubId, startDate: { lte: asOf }, endDate: { gte: asOf } },
    orderBy: { startDate: "desc" },
  });
}
