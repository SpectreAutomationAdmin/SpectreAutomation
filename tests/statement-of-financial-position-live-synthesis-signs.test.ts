// Founder rule 2026-07-13 v15.22 — integration test using the ACTUAL
// live pipeline that produced the account-2017 defect.
//
// The v15.21 unit tests passed while the browser remained wrong
// because they built synthetic `BalanceSheetSnapshot` fixtures with
// `rawSignedAmount` already populated. The REAL live path is:
//
//   Committed Opening TB Import
//     → posted JournalEntryLine rows
//     → `synthesizeBalanceSheetSnapshot`   ← Math.abs used to strip sign
//     → `enrichSnapshotWithLiveCoa`
//     → `buildStatementOfFinancialPositionFromBalanceSheet`
//     → `aggregateByFsGroup`               ← credit-normal on missing raw
//     → renderer
//
// This test plants a MINIMAL but faithful OTB dataset — including a
// LIABILITY account with an ABNORMAL DEBIT balance modeled on the
// founder's account 2017 — and invokes the SAME public function the
// reporting page uses (`getStatementOfFinancialPositionForClub`) to
// assert the raw sign survives every layer.

import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";

import {
  getStatementOfFinancialPositionForClub,
  validateSofPSignInvariants,
  MissingRawSignedAmountError,
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

const clubId = "club_v1522_signpath";

async function seedPipeline() {
  await prisma.club.upsert({
    where: { id: clubId },
    update: {},
    create: { id: clubId, name: "v15.22 Sign-Path Fixture Club", slug: "v1522-sign-path" },
  });

  // Financial Statement Group + Category — used by SoFP for FS routing.
  const apFsGroup = await prisma.financialStatementGroup.upsert({
    where: { clubId_key: { clubId, key: "BS_AP" } },
    update: {},
    create: { clubId, key: "BS_AP", name: "Accounts Payable", statement: "BALANCE_SHEET", sortOrder: 20 },
  });
  const cashFsGroup = await prisma.financialStatementGroup.upsert({
    where: { clubId_key: { clubId, key: "BS_CASH_EQUIVALENTS" } },
    update: {},
    create: { clubId, key: "BS_CASH_EQUIVALENTS", name: "Cash & Cash Equivalents", statement: "BALANCE_SHEET", sortOrder: 10 },
  });
  const eqFsGroup = await prisma.financialStatementGroup.upsert({
    where: { clubId_key: { clubId, key: "BS_RETAINED_EARNINGS" } },
    update: {},
    create: { clubId, key: "BS_RETAINED_EARNINGS", name: "Operating Fund Balance", statement: "BALANCE_SHEET", sortOrder: 800 },
  });

  const catCurrLiab = await prisma.accountCategory.upsert({
    where: { clubId_key: { clubId, key: "CURRENT_LIABILITIES" } },
    update: {},
    create: { clubId, key: "CURRENT_LIABILITIES", name: "Current Liabilities", type: "LIABILITY" },
  });
  const catCurrAsset = await prisma.accountCategory.upsert({
    where: { clubId_key: { clubId, key: "CURRENT_ASSETS" } },
    update: {},
    create: { clubId, key: "CURRENT_ASSETS", name: "Current Assets", type: "ASSET" },
  });
  const catEquity = await prisma.accountCategory.upsert({
    where: { clubId_key: { clubId, key: "EQUITY" } },
    update: {},
    create: { clubId, key: "EQUITY", name: "Equity", type: "EQUITY" },
  });

  // Cash — Asset debit-normal, +debit balance (normal).
  const cashAccount = await prisma.account.upsert({
    where: { clubId_accountNumber: { clubId, accountNumber: "1010" } },
    update: {},
    create: {
      clubId, accountNumber: "1010", name: "Cash",
      type: "ASSET", normalBalance: "DEBIT",
      categoryId: catCurrAsset.id, fsGroupId: cashFsGroup.id, isActive: true,
    },
  });
  // Normal credit-balance payable — LIABILITY credit-normal.
  const apNormalAccount = await prisma.account.upsert({
    where: { clubId_accountNumber: { clubId, accountNumber: "2000" } },
    update: {},
    create: {
      clubId, accountNumber: "2000", name: "Accounts Payable",
      type: "LIABILITY", normalBalance: "CREDIT",
      categoryId: catCurrLiab.id, fsGroupId: apFsGroup.id, isActive: true,
    },
  });
  // Founder's flagged account 2017 — LIABILITY credit-normal contra
  // with an ABNORMAL DEBIT balance.
  const apContraAccount = await prisma.account.upsert({
    where: { clubId_accountNumber: { clubId, accountNumber: "2017" } },
    update: {},
    create: {
      clubId, accountNumber: "2017", name: "Accts Payable Contra - Grat Payout",
      type: "LIABILITY", normalBalance: "CREDIT",
      categoryId: catCurrLiab.id, fsGroupId: apFsGroup.id, isActive: true,
    },
  });
  const equityAccount = await prisma.account.upsert({
    where: { clubId_accountNumber: { clubId, accountNumber: "3010" } },
    update: {},
    create: {
      clubId, accountNumber: "3010", name: "Operating Fund Balance",
      type: "EQUITY", normalBalance: "CREDIT",
      categoryId: catEquity.id, fsGroupId: eqFsGroup.id, isActive: true,
    },
  });

  // FiscalYear + FiscalPeriod so live-synth can resolve metadata + JE.periodId FK is satisfied.
  const fy = await prisma.fiscalYear.upsert({
    where: { clubId_label: { clubId, label: "FY2026" } },
    update: {},
    create: {
      clubId,
      label: "FY2026",
      startDate: new Date(Date.UTC(2025, 6, 1)),
      endDate: new Date(Date.UTC(2026, 5, 30)),
      status: "OPEN",
    },
  });
  const period = await prisma.fiscalPeriod.upsert({
    where: { clubId_label: { clubId, label: "FY2026-M11" } },
    update: {},
    create: {
      clubId,
      fiscalYearId: fy.id,
      label: "FY2026-M11",
      startDate: new Date(Date.UTC(2026, 4, 1)),
      // End-of-day so resolveFiscalMetadata's `endDate: { gte: asOf }` matches
      // when the caller normalises asOf to 23:59:59.999 (as `getStatement…ForClub` does).
      endDate: new Date(Date.UTC(2026, 4, 31, 23, 59, 59, 999)),
      sequence: 11,
      status: "OPEN",
    },
  });

  // OPENING_TRIAL_BALANCE import batch — the gate that unlocks
  // `hasCommittedRealTrialBalance` and drives the live synthesis path.
  const batch = await prisma.importBatch.upsert({
    where: { id: "batch_v1522_otb" },
    update: {},
    create: {
      id: "batch_v1522_otb",
      clubId,
      domain: "OPENING_TRIAL_BALANCE",
      status: "COMMITTED",
      source: "csv",
      fileName: "otb-may-2026.csv",
    },
  });

  // Post a balanced set of journal entries dated 2026-05-31.
  // Balances established:
  //   1010 Cash                   Dr $581,741        → normal debit asset
  //   2000 Accounts Payable       Cr $647,227        → normal credit liability
  //   2017 AP Contra - Grat Payout Dr $65,486         → ABNORMAL debit in a credit-normal liability
  //   3010 Operating Fund Balance Cr $0              → balance
  // Total debits: 581,741 + 65,486 = 647,227
  // Total credits: 647,227
  const entry = await prisma.journalEntry.create({
    data: {
      club: { connect: { id: clubId } },
      entryNumber: "TB-V1522-1",
      entryDate: new Date(Date.UTC(2026, 4, 31)),
      period: { connect: { id: period.id } },
      status: "POSTED",
      source: "IMPORT",
      description: "v15.22 Opening TB fixture",
      lines: {
        create: [
          { clubId, lineNumber: 1, accountId: cashAccount.id, debit: "581741.00", credit: "0" },
          { clubId, lineNumber: 2, accountId: apNormalAccount.id, debit: "0", credit: "647227.00" },
          { clubId, lineNumber: 3, accountId: apContraAccount.id, debit: "65486.00", credit: "0" },
        ],
      },
    },
  });
  return { batch, entry };
}

let seeded = false;
beforeAll(async () => {
  if (!seeded) {
    await seedPipeline();
    seeded = true;
  }
});

describe("v15.22 live-synthesis sign preservation — actual runtime pipeline", () => {
  it("synthesizeBalanceSheetSnapshot preserves the raw sign on account 2017 as +65,486 (Jonas debit-positive convention)", async () => {
    // Diagnostic: confirm the OTB gate + fiscal metadata are in place.
    const otbCount = await prisma.importBatch.count({
      where: { clubId, domain: "OPENING_TRIAL_BALANCE", status: "COMMITTED", supersededAt: null, voidedAt: null },
    });
    const jeLineCount = await prisma.journalEntryLine.count({ where: { clubId } });
    const fyCount = await prisma.fiscalYear.count({ where: { clubId } });
    // eslint-disable-next-line no-console
    console.log("FIXTURE STATE: otbCount=", otbCount, "jeLineCount=", jeLineCount, "fyCount=", fyCount);
    const snapshot = await synthesizeBalanceSheetSnapshot(clubId, END_OF_MAY_2026);
    // eslint-disable-next-line no-console
    console.log("snapshot=", snapshot ? `${snapshot.lines.length} lines` : "NULL");
    expect(snapshot).not.toBeNull();
    const line = snapshot!.lines.find((l) => l.accountCode === "2017");
    expect(line, "account 2017 must appear in the synthesized snapshot").toBeDefined();
    // amount is the unsigned magnitude (legacy contract).
    expect(Math.round(line!.amount)).toBe(65_486);
    // rawSignedAmount is the raw Jonas signed balance (debit − credit).
    expect(line!.rawSignedAmount, "rawSignedAmount MUST be populated by v15.22 synthesizer").toBeDefined();
    expect(Math.round(line!.rawSignedAmount!)).toBe(65_486); // positive debit
    // Normal credit-balance liability — 2000 — must have raw negative.
    const line2000 = snapshot!.lines.find((l) => l.accountCode === "2000");
    expect(Math.round(line2000!.rawSignedAmount!)).toBe(-647_227);
  });

  it("getStatementOfFinancialPositionForClub produces account 2017 contribution of −$65,486 in the AP drill-down", async () => {
    const snapshot = await synthesizeBalanceSheetSnapshot(clubId, END_OF_MAY_2026);
    // eslint-disable-next-line no-console
    console.log("Pre-enrich snapshot lines:", snapshot!.lines.map((l) => ({
      code: l.accountCode, name: l.accountName, category: l.category, fsGroupKey: l.fsGroupKey, amount: l.amount, raw: l.rawSignedAmount,
    })));
    const ledger = new PrismaReportingLedger(prisma as any);
    const sofp = await getStatementOfFinancialPositionForClub({
      clubId,
      clubName: "v15.22 Fixture",
      period: MAY_2026,
      ledger,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$7.9M",
      viewerCanDrillDown: true,
    });
    // Debug: emit the row keys/labels to expose why AP might be missing.
    // eslint-disable-next-line no-console
    console.log("SoFP liabilitiesEquityRows:", sofp.liabilitiesEquityRows.map((r: any) => ({
      key: r.key, kind: r.kind, fsGroupKey: r.fsGroupKey, label: r.label, current: r.current,
    })));
    // eslint-disable-next-line no-console
    console.log("SoFP assetsRows:", sofp.assetsRows.map((r: any) => ({
      key: r.key, kind: r.kind, fsGroupKey: r.fsGroupKey, label: r.label, current: r.current,
    })));
    // eslint-disable-next-line no-console
    console.log("SoFP unmappedAccounts:", sofp.unmappedAccounts);
    const apRow: any = sofp.liabilitiesEquityRows.find(
      (r: any) => r.fsGroupKey === "BS_AP",
    );
    expect(apRow, "AP FS Group row must exist on the live-built SoFP").toBeDefined();
    const acct2017 = apRow.accounts?.find((a: any) => a.accountCode === "2017");
    expect(acct2017, "account 2017 must be in the drill-down").toBeDefined();
    // The exact defect: pre-v15.22 this rendered as +65,486. Now it is negative.
    expect(acct2017.current).toBeLessThan(0);
    expect(Math.round(acct2017.current)).toBe(-65_486);
    // Normal payable adds positively.
    const acct2000 = apRow.accounts?.find((a: any) => a.accountCode === "2000");
    expect(Math.round(acct2000.current)).toBe(647_227);
    // Parent equals algebraic sum: 647,227 − 65,486 = 581,741.
    expect(Math.round(apRow.current)).toBe(581_741);
  });

  it("validateSofPSignInvariants returns zero failures on the live build", async () => {
    const ledger = new PrismaReportingLedger(prisma as any);
    const sofp = await getStatementOfFinancialPositionForClub({
      clubId,
      clubName: "v15.22 Fixture",
      period: MAY_2026,
      ledger,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$7.9M",
      viewerCanDrillDown: true,
    });
    const failures = validateSofPSignInvariants(sofp);
    expect(failures).toEqual([]);
  });

  it("MUTATION TEST — replacing account-2017 detail with Math.abs (the pre-v15.22 defect) trips FS_GROUP_DETAIL_MISMATCH", async () => {
    const ledger = new PrismaReportingLedger(prisma as any);
    const sofp = await getStatementOfFinancialPositionForClub({
      clubId,
      clubName: "v15.22 Fixture",
      period: MAY_2026,
      ledger,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$7.9M",
      viewerCanDrillDown: true,
    });
    const tampered = {
      ...sofp,
      liabilitiesEquityRows: sofp.liabilitiesEquityRows.map((r: any) => {
        if (r.fsGroupKey !== "BS_AP" || !r.accounts) return r;
        return {
          ...r,
          accounts: r.accounts.map((a: any) =>
            a.accountCode === "2017" ? { ...a, current: Math.abs(a.current ?? 0) } : a,
          ),
        };
      }),
    };
    const failures = validateSofPSignInvariants(tampered);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]).toMatch(/FS_GROUP_DETAIL_MISMATCH/);
    expect(failures[0]).toMatch(/Accounts Payable/);
  });

  it("SOURCE CONTRACT — MissingRawSignedAmountError is exported and the sign-guard message references upstream fix points", () => {
    const err = new MissingRawSignedAmountError({
      accountCode: "TEST",
      accountName: "Test",
      mode: "credit-normal",
    });
    expect(err.code).toBe("MISSING_RAW_SIGNED_AMOUNT");
    expect(err.message).toMatch(/rawSignedAmount/);
    expect(err.message).toMatch(/synthesizer/);
    expect(err.message).toMatch(/projection/);
    expect(err.message).toMatch(/seed/);
  });
});
