// Founder rule 2026-07-14 v15.23 — Current-Year Earnings must appear
// in Members' Equity for every reporting period with FYTD activity.
//
// Before v15.23 the live synthesizer (`synthesizeBalanceSheetSnapshot`)
// iterated the FS Group tree from `balanceSheet()` but never emitted
// the `bs.currentYearEarnings` scalar into an equity LINE. Result: the
// Statement of Financial Position rendered equity = Retained Earnings
// only, and Total Assets exceeded Total Liabilities + Total Members'
// Equity by exactly the FYTD surplus / deficit (Silver Springs May 2026
// off by $2,358,610.98).
//
// v15.23 emits a synthetic `__YTD_NET_INCOME__` line consuming the
// same canonical `balanceSheet().currentYearEarnings` figure (which is
// the SAME accountBalances query the Statement of Activities consumes
// — so the two statements agree by construction). This suite locks:
//
//   • the synthesizer emits the line (positive surplus AND negative deficit)
//   • the SoFP builder routes it into Members' Equity
//   • the line appears immediately beneath Retained Earnings
//   • the sheet reconciles exactly when the line is present
//   • omitting the line yields a difference equal to the FYTD result
//   • duplicate detection catches an inadvertent double booking
//   • the publication guard blocks a package with missing or duplicated YTD

import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";

import {
  getStatementOfFinancialPositionForClub,
  validateCurrentYearEarnings,
} from "@/lib/reporting/statement-of-financial-position";
import { synthesizeBalanceSheetSnapshot } from "@/lib/reporting/ledger/live-synthesis";
import { PrismaReportingLedger } from "@/lib/reporting/ledger";
import { buildReportingPeriod } from "@/lib/reporting/reporting-period";

const MAY_2026 = buildReportingPeriod(new Date(Date.UTC(2026, 4, 31)));
const END_OF_MAY_2026 = new Date(Date.UTC(2026, 4, 31, 23, 59, 59, 999));

const AUX_INPUTS = {
  arCurrentRate: 0.999,
  duesToRevenueRatio: 0.659,
  reserveCoverageRatio: 0.61,
  debtServiceCoverage: 2.1,
  netToGrossPpeOverride: 0.44,
} as const;

const clubIdSurplus = "club_v1523_surplus";
const clubIdDeficit = "club_v1523_deficit";
const clubIdDuplicate = "club_v1523_dup";

async function planCoa(clubId: string) {
  await prisma.club.upsert({
    where: { id: clubId },
    update: {},
    create: { id: clubId, name: `v15.23 fixture ${clubId}`, slug: clubId.replace(/_/g, "-") },
  });
  const cashFsGroup = await prisma.financialStatementGroup.upsert({
    where: { clubId_key: { clubId, key: "BS_CASH_EQUIVALENTS" } },
    update: {},
    create: { clubId, key: "BS_CASH_EQUIVALENTS", name: "Cash & Cash Equivalents", statement: "BALANCE_SHEET", sortOrder: 10 },
  });
  const apFsGroup = await prisma.financialStatementGroup.upsert({
    where: { clubId_key: { clubId, key: "BS_AP" } },
    update: {},
    create: { clubId, key: "BS_AP", name: "Accounts Payable", statement: "BALANCE_SHEET", sortOrder: 20 },
  });
  const eqFsGroup = await prisma.financialStatementGroup.upsert({
    where: { clubId_key: { clubId, key: "BS_RETAINED_EARNINGS" } },
    update: {},
    create: { clubId, key: "BS_RETAINED_EARNINGS", name: "Operating Fund Balance", statement: "BALANCE_SHEET", sortOrder: 800 },
  });
  const cyeFsGroup = await prisma.financialStatementGroup.upsert({
    where: { clubId_key: { clubId, key: "BS_CURRENT_YEAR_EARNINGS" } },
    update: {},
    create: { clubId, key: "BS_CURRENT_YEAR_EARNINGS", name: "Current-Year Earnings to Date", statement: "BALANCE_SHEET", sortOrder: 820 },
  });
  const revFsGroup = await prisma.financialStatementGroup.upsert({
    where: { clubId_key: { clubId, key: "IS_MEMBERSHIP_REVENUE" } },
    update: {},
    create: { clubId, key: "IS_MEMBERSHIP_REVENUE", name: "Membership Revenue", statement: "INCOME_STATEMENT", sortOrder: 100 },
  });
  const expFsGroup = await prisma.financialStatementGroup.upsert({
    where: { clubId_key: { clubId, key: "IS_PAYROLL" } },
    update: {},
    create: { clubId, key: "IS_PAYROLL", name: "Payroll", statement: "INCOME_STATEMENT", sortOrder: 200 },
  });

  const cats = {
    curAsset: await prisma.accountCategory.upsert({
      where: { clubId_key: { clubId, key: "CURRENT_ASSETS" } },
      update: {},
      create: { clubId, key: "CURRENT_ASSETS", name: "Current Assets", type: "ASSET" },
    }),
    curLiab: await prisma.accountCategory.upsert({
      where: { clubId_key: { clubId, key: "CURRENT_LIABILITIES" } },
      update: {},
      create: { clubId, key: "CURRENT_LIABILITIES", name: "Current Liabilities", type: "LIABILITY" },
    }),
    equity: await prisma.accountCategory.upsert({
      where: { clubId_key: { clubId, key: "EQUITY" } },
      update: {},
      create: { clubId, key: "EQUITY", name: "Equity", type: "EQUITY" },
    }),
    revenue: await prisma.accountCategory.upsert({
      where: { clubId_key: { clubId, key: "REVENUE" } },
      update: {},
      create: { clubId, key: "REVENUE", name: "Revenue", type: "REVENUE" },
    }),
    expense: await prisma.accountCategory.upsert({
      where: { clubId_key: { clubId, key: "EXPENSE" } },
      update: {},
      create: { clubId, key: "EXPENSE", name: "Expense", type: "EXPENSE" },
    }),
  };

  const cash = await prisma.account.upsert({
    where: { clubId_accountNumber: { clubId, accountNumber: "1010" } },
    update: {},
    create: { clubId, accountNumber: "1010", name: "Cash", type: "ASSET", normalBalance: "DEBIT", categoryId: cats.curAsset.id, fsGroupId: cashFsGroup.id, isActive: true },
  });
  const ap = await prisma.account.upsert({
    where: { clubId_accountNumber: { clubId, accountNumber: "2000" } },
    update: {},
    create: { clubId, accountNumber: "2000", name: "Accounts Payable", type: "LIABILITY", normalBalance: "CREDIT", categoryId: cats.curLiab.id, fsGroupId: apFsGroup.id, isActive: true },
  });
  const retainedEarnings = await prisma.account.upsert({
    where: { clubId_accountNumber: { clubId, accountNumber: "3010" } },
    update: {},
    create: { clubId, accountNumber: "3010", name: "Retained Earnings", type: "EQUITY", normalBalance: "CREDIT", categoryId: cats.equity.id, fsGroupId: eqFsGroup.id, isActive: true },
  });
  const cyeAccount = await prisma.account.upsert({
    where: { clubId_accountNumber: { clubId, accountNumber: "3020" } },
    update: {},
    create: { clubId, accountNumber: "3020", name: "Current-Year Surplus (closing)", type: "EQUITY", normalBalance: "CREDIT", categoryId: cats.equity.id, fsGroupId: cyeFsGroup.id, isActive: true },
  });
  const revenue = await prisma.account.upsert({
    where: { clubId_accountNumber: { clubId, accountNumber: "4000" } },
    update: {},
    create: { clubId, accountNumber: "4000", name: "Membership Revenue", type: "REVENUE", normalBalance: "CREDIT", categoryId: cats.revenue.id, fsGroupId: revFsGroup.id, isActive: true },
  });
  const expense = await prisma.account.upsert({
    where: { clubId_accountNumber: { clubId, accountNumber: "5000" } },
    update: {},
    create: { clubId, accountNumber: "5000", name: "Payroll Expense", type: "EXPENSE", normalBalance: "DEBIT", categoryId: cats.expense.id, fsGroupId: expFsGroup.id, isActive: true },
  });

  const fy = await prisma.fiscalYear.upsert({
    where: { clubId_label: { clubId, label: "FY2026" } },
    update: {},
    create: { clubId, label: "FY2026", startDate: new Date(Date.UTC(2025, 6, 1)), endDate: new Date(Date.UTC(2026, 5, 30)), status: "OPEN" },
  });
  const period = await prisma.fiscalPeriod.upsert({
    where: { clubId_label: { clubId, label: "FY2026-M11" } },
    update: {},
    create: {
      clubId,
      fiscalYearId: fy.id,
      label: "FY2026-M11",
      startDate: new Date(Date.UTC(2026, 4, 1)),
      endDate: new Date(Date.UTC(2026, 4, 31, 23, 59, 59, 999)),
      sequence: 11,
      status: "OPEN",
    },
  });
  await prisma.importBatch.upsert({
    where: { id: `batch_${clubId}` },
    update: {},
    create: {
      id: `batch_${clubId}`,
      clubId,
      domain: "OPENING_TRIAL_BALANCE",
      status: "COMMITTED",
      source: "csv",
    },
  });
  return { cash, ap, retainedEarnings, cyeAccount, revenue, expense, period };
}

async function postBalancedEntries(args: {
  clubId: string;
  periodId: string;
  entries: ReadonlyArray<{ description: string; lines: ReadonlyArray<{ accountId: string; debit?: string; credit?: string }> }>;
}) {
  for (let i = 0; i < args.entries.length; i++) {
    const e = args.entries[i];
    await prisma.journalEntry.create({
      data: {
        club: { connect: { id: args.clubId } },
        entryNumber: `TB-V1523-${args.clubId}-${i + 1}`,
        entryDate: new Date(Date.UTC(2026, 4, 31)),
        period: { connect: { id: args.periodId } },
        status: "POSTED",
        source: "IMPORT",
        description: e.description,
        lines: {
          create: e.lines.map((l, li) => ({
            clubId: args.clubId,
            lineNumber: li + 1,
            accountId: l.accountId,
            debit: l.debit ?? "0",
            credit: l.credit ?? "0",
          })),
        },
      },
    });
  }
}

beforeAll(async () => {
  const surplusCoa = await planCoa(clubIdSurplus);
  // Surplus: revenue $500k > expense $300k → YTD +$200k.
  // Balanced TB: cash +$800k debit, RE -$400k credit, AP -$200k credit, revenue -$500k credit, expense +$300k debit
  await postBalancedEntries({
    clubId: clubIdSurplus,
    periodId: surplusCoa.period.id,
    entries: [
      {
        description: "surplus fixture",
        lines: [
          { accountId: surplusCoa.cash.id, debit: "800000" },
          { accountId: surplusCoa.ap.id, credit: "200000" },
          { accountId: surplusCoa.retainedEarnings.id, credit: "400000" },
          { accountId: surplusCoa.revenue.id, credit: "500000" },
          { accountId: surplusCoa.expense.id, debit: "300000" },
        ],
      },
    ],
  });

  const deficitCoa = await planCoa(clubIdDeficit);
  // Deficit: revenue $300k < expense $500k → YTD -$200k.
  // Balanced TB: cash +$400k, RE -$400k credit, AP -$200k credit, revenue -$300k, expense +$500k
  await postBalancedEntries({
    clubId: clubIdDeficit,
    periodId: deficitCoa.period.id,
    entries: [
      {
        description: "deficit fixture",
        lines: [
          { accountId: deficitCoa.cash.id, debit: "400000" },
          { accountId: deficitCoa.ap.id, credit: "200000" },
          { accountId: deficitCoa.retainedEarnings.id, credit: "400000" },
          { accountId: deficitCoa.revenue.id, credit: "300000" },
          { accountId: deficitCoa.expense.id, debit: "500000" },
        ],
      },
    ],
  });

  const dupCoa = await planCoa(clubIdDuplicate);
  // Same as surplus, but the closing entry has already booked the
  // FYTD surplus into the BS_CURRENT_YEAR_EARNINGS-tagged account.
  // This exercises the "ytdEarningsAlreadyBooked" guard.
  await postBalancedEntries({
    clubId: clubIdDuplicate,
    periodId: dupCoa.period.id,
    entries: [
      {
        description: "closed surplus (BS_CYE account credited)",
        lines: [
          { accountId: dupCoa.cash.id, debit: "800000" },
          { accountId: dupCoa.ap.id, credit: "200000" },
          { accountId: dupCoa.retainedEarnings.id, credit: "400000" },
          { accountId: dupCoa.revenue.id, credit: "500000" },
          { accountId: dupCoa.expense.id, debit: "300000" },
          // Closing entries: transfer net income to BS_CURRENT_YEAR_EARNINGS.
          // Assumption in the fixture: post closing entries so that revenue
          // and expense still show their period activity (accountBalances
          // reads posted lines, not net-of-closing) — this is representative
          // of a mid-year closing where BOTH the P&L accrual and the
          // synthetic reconciliation would trip if not guarded.
        ],
      },
    ],
  });
  // Now also credit BS_CYE with $200k so it holds a non-zero balance,
  // and offset by a debit to Retained Earnings to keep the TB balanced.
  await prisma.journalEntry.create({
    data: {
      club: { connect: { id: clubIdDuplicate } },
      entryNumber: `TB-V1523-${clubIdDuplicate}-close`,
      entryDate: new Date(Date.UTC(2026, 4, 31)),
      period: { connect: { id: dupCoa.period.id } },
      status: "POSTED",
      source: "IMPORT",
      description: "closing to BS_CURRENT_YEAR_EARNINGS",
      lines: {
        create: [
          { clubId: clubIdDuplicate, lineNumber: 1, accountId: dupCoa.retainedEarnings.id, debit: "200000", credit: "0" },
          { clubId: clubIdDuplicate, lineNumber: 2, accountId: dupCoa.cyeAccount.id, debit: "0", credit: "200000" },
        ],
      },
    },
  });
});

describe("v15.23 Current-Year Earnings — actual runtime pipeline", () => {
  it("SURPLUS — synthesizer emits a positive Current-Year Earnings to Date line", async () => {
    const snap = await synthesizeBalanceSheetSnapshot(clubIdSurplus, END_OF_MAY_2026);
    expect(snap).not.toBeNull();
    const cye = snap!.lines.find((l) => l.accountCode === "__YTD_NET_INCOME__");
    expect(cye, "synthetic YTD line must exist for a non-zero surplus").toBeDefined();
    expect(cye!.category).toBe("ytd-net-income");
    expect(cye!.fsGroupKey).toBe("BS_CURRENT_YEAR_EARNINGS");
    expect(cye!.accountName).toBe("Current-Year Earnings to Date");
    expect(Math.round(cye!.amount)).toBe(200_000);
  });

  it("DEFICIT — synthesizer emits a negative Current-Year Deficit to Date line", async () => {
    const snap = await synthesizeBalanceSheetSnapshot(clubIdDeficit, END_OF_MAY_2026);
    expect(snap).not.toBeNull();
    const cye = snap!.lines.find((l) => l.accountCode === "__YTD_NET_INCOME__");
    expect(cye, "synthetic YTD line must exist for a non-zero deficit").toBeDefined();
    expect(cye!.accountName).toBe("Current-Year Deficit to Date");
    expect(Math.round(cye!.amount)).toBe(-200_000);
  });

  it("DUPLICATE PROTECTION — synthesizer skips its synthetic line when the CoA already routes an account to BS_CURRENT_YEAR_EARNINGS", async () => {
    const snap = await synthesizeBalanceSheetSnapshot(clubIdDuplicate, END_OF_MAY_2026);
    expect(snap).not.toBeNull();
    const cyeSynthetic = snap!.lines.find((l) => l.accountCode === "__YTD_NET_INCOME__");
    expect(cyeSynthetic, "synthetic YTD line must NOT be added when a real CoA account already holds the closed surplus").toBeUndefined();
    const cyeReal = snap!.lines.find(
      (l) => l.accountCode === "3020" && l.fsGroupKey === "BS_CURRENT_YEAR_EARNINGS",
    );
    expect(cyeReal, "real CoA-mapped CYE account must still appear").toBeDefined();
  });

  it("SoFP SURPLUS — Current-Year Earnings to Date row appears in Members' Equity and the sheet reconciles within $1", async () => {
    const ledger = new PrismaReportingLedger(prisma as any);
    const sofp = await getStatementOfFinancialPositionForClub({
      clubId: clubIdSurplus,
      clubName: "surplus fixture",
      period: MAY_2026,
      ledger,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$0",
      viewerCanDrillDown: true,
    });
    const equityRow: any = sofp.liabilitiesEquityRows.find(
      (r: any) => r.fsGroupKey === "BS_CURRENT_YEAR_EARNINGS",
    );
    expect(equityRow, "Current-Year Earnings row must exist in Members' Equity").toBeDefined();
    expect(equityRow.label).toBe("Current-Year Earnings to Date");
    expect(Math.round(equityRow.current)).toBe(200_000);

    // Row order: Retained Earnings then Current-Year Earnings.
    const equitySection = sofp.liabilitiesEquityRows;
    const reIdx = equitySection.findIndex(
      (r: any) => r.fsGroupKey === "BS_RETAINED_EARNINGS",
    );
    const cyeIdx = equitySection.findIndex(
      (r: any) => r.fsGroupKey === "BS_CURRENT_YEAR_EARNINGS",
    );
    expect(reIdx).toBeGreaterThan(-1);
    expect(cyeIdx).toBeGreaterThan(reIdx);

    // Reconciliation: SoFP is balanced.
    const rec = (sofp as any).reconciliation;
    expect(rec.balances).toBe(true);
    expect(Math.abs(rec.difference ?? 0)).toBeLessThan(1);
  });

  it("SoFP DEFICIT — Current-Year Deficit row appears in Members' Equity as negative and the sheet still reconciles", async () => {
    const ledger = new PrismaReportingLedger(prisma as any);
    const sofp = await getStatementOfFinancialPositionForClub({
      clubId: clubIdDeficit,
      clubName: "deficit fixture",
      period: MAY_2026,
      ledger,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$0",
      viewerCanDrillDown: true,
    });
    const equityRow: any = sofp.liabilitiesEquityRows.find(
      (r: any) => r.fsGroupKey === "BS_CURRENT_YEAR_EARNINGS",
    );
    expect(equityRow).toBeDefined();
    expect(Math.round(equityRow.current)).toBe(-200_000);
    const rec = (sofp as any).reconciliation;
    expect(rec.balances).toBe(true);
  });

  it("validateCurrentYearEarnings — clean pass on a live, reconciled SoFP", async () => {
    const ledger = new PrismaReportingLedger(prisma as any);
    const sofp = await getStatementOfFinancialPositionForClub({
      clubId: clubIdSurplus,
      clubName: "surplus",
      period: MAY_2026,
      ledger,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$0",
      viewerCanDrillDown: true,
    });
    expect(validateCurrentYearEarnings(sofp)).toEqual([]);
  });

  it("validateCurrentYearEarnings — CURRENT_YEAR_EARNINGS_MISSING when SoFP is out of balance AND no YTD row exists", () => {
    const failures = validateCurrentYearEarnings({
      liabilitiesEquityRows: [
        {
          key: "operating-fund-fsg-BS_RETAINED_EARNINGS",
          kind: "fs-group",
          label: "Retained Earnings",
          current: 400_000,
          comparative: null,
          fsGroupKey: "BS_RETAINED_EARNINGS",
        } as any,
      ],
      reconciliation: {
        balances: false,
        totalAssetsCurrent: 800_000,
        totalLiabilitiesAndEquityCurrent: 600_000,
        difference: 200_000,
      },
    });
    expect(failures.length).toBe(1);
    expect(failures[0]).toMatch(/CURRENT_YEAR_EARNINGS_MISSING/);
    expect(failures[0]).toMatch(/200,000/);
  });

  it("validateCurrentYearEarnings — CURRENT_YEAR_EARNINGS_DUPLICATED when two rows carry BS_CURRENT_YEAR_EARNINGS", () => {
    const failures = validateCurrentYearEarnings({
      liabilitiesEquityRows: [
        { key: "a", kind: "fs-group", label: "Current-Year Earnings (real)", current: 200_000, comparative: null, fsGroupKey: "BS_CURRENT_YEAR_EARNINGS" } as any,
        { key: "b", kind: "fs-group", label: "Current-Year Earnings (synthetic)", current: 200_000, comparative: null, fsGroupKey: "BS_CURRENT_YEAR_EARNINGS" } as any,
      ],
      reconciliation: { balances: false, totalAssetsCurrent: 0, totalLiabilitiesAndEquityCurrent: 200_000, difference: -200_000 },
    });
    expect(failures.some((f) => f.includes("CURRENT_YEAR_EARNINGS_DUPLICATED"))).toBe(true);
  });

  it("validateCurrentYearEarnings — empty pass when there are ZERO YTD rows AND the sheet reconciles (a fresh period with no FYTD activity)", () => {
    const failures = validateCurrentYearEarnings({
      liabilitiesEquityRows: [
        { key: "re", kind: "fs-group", label: "Retained Earnings", current: 400_000, comparative: null, fsGroupKey: "BS_RETAINED_EARNINGS" } as any,
      ],
      reconciliation: { balances: true, totalAssetsCurrent: 400_000, totalLiabilitiesAndEquityCurrent: 400_000, difference: 0 },
    });
    expect(failures).toEqual([]);
  });

  it("SOURCE CONTRACT — the lifecycle guard imports both validators and blocks publication on CURRENT_YEAR_EARNINGS failures", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const lifecycle = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/reporting/monthly-package-lifecycle.ts"),
      "utf8",
    );
    expect(lifecycle).toMatch(/validateCurrentYearEarnings/);
    // The guard runs BEFORE the generic reconciliation guard so admins
    // get the specific diagnostic rather than the generic one when the
    // sheet is imbalanced by a missing YTD line.
    expect(lifecycle).toMatch(/Current-Year Earnings guard runs[\s\S]{0,100}BEFORE the generic reconciliation guard/);
  });
});
