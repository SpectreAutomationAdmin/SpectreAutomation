// Founder rule 2026-07-01 v14.8 — Finance reports use only real
// posted-ledger data, never demo/seeded balances.
//
// Survey findings that this test suite codifies:
//
//   1. All 4 Finance report pages (`/app/admin/reports/{trial-balance,
//      balance-sheet,income-statement,department-pnl}`) call the
//      plain accounting service (`trialBalance`, `balanceSheet`,
//      `incomeStatement`, `incomeStatementByDepartment`) directly.
//   2. All 4 services read from `accountBalances()` or `JournalEntryLine`
//      filtered by `entry.status === "POSTED"`. No demo pathway.
//   3. `prisma/seed.ts` DELETES journal entries at seed time and
//      NEVER creates any — the seed layer plants no ledger data.
//   4. Only 3 code paths write JournalEntry rows: the real GL
//      posting service (permission-gated), the Opening Trial
//      Balance import commit (v14.3), and the manual opening-
//      balance service. None are "demo".
//
// This suite locks in that invariant. If a future change adds
// a demo-balance injection layer to any of the 4 Finance report
// pages or their services, at least one of these tests fails.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAccountingClub } from "./util/gl";
import { createBatch, validateBatch, commitBatch } from "@/lib/imports";
import { ensureFiscalYear } from "@/lib/accounting/periods";
import {
  trialBalance, balanceSheet, incomeStatement, incomeStatementByDepartment,
} from "@/lib/accounting/reports";

async function controllerFor(clubId: string) {
  const email = `ctrl-${Math.random().toString(36).slice(2, 10)}@example.com`;
  await makeUser({ email, role: "CONTROLLER", clubId });
  return principalFor(email);
}

async function commitTb(
  p: Awaited<ReturnType<typeof principalFor>>,
  clubId: string,
  asOfDate: Date,
  rows: Array<{ accountNumber: string; description: string; debit: string; credit: string }>,
) {
  const batch = await createBatch(p, {
    clubId, domain: "OPENING_TRIAL_BALANCE", rows,
    source: "CSV", fileName: `tb-${asOfDate.toISOString().slice(0, 10)}.csv`,
    options: { asOfDate: asOfDate.toISOString() },
  });
  await validateBatch(p, batch.id);
  return commitBatch(p, { batchId: batch.id });
}

beforeAll(async () => { await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

describe("v14.8 — Finance reports read ONLY real posted-ledger data (no demo injection)", () => {
  it("bootstrap-only club (no imports, no journal entries) → every Finance report is empty / zero", async () => {
    // A fresh club with a seeded COA but zero posted activity
    // MUST NOT show any balance. If a demo layer were injecting
    // data, one of these assertions would fail.
    const club = await bootstrapAccountingClub("Finance-NoActivity");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const asOf = new Date("2026-04-30T00:00:00.000Z");

    const tb = await trialBalance(club.id, asOf);
    expect(tb.totalDebit.toFixed(2)).toBe("0.00");
    expect(tb.totalCredit.toFixed(2)).toBe("0.00");
    expect(tb.rows.length).toBe(0);

    const bs = await balanceSheet(club.id, asOf);
    expect(bs.totalAssets.toFixed(2)).toBe("0.00");
    expect(bs.totalLiabilities.toFixed(2)).toBe("0.00");
    expect(bs.totalEquity.toFixed(2)).toBe("0.00");

    const is = await incomeStatement(club.id, new Date("2026-01-01T00:00:00.000Z"), asOf);
    expect(is.totalRevenue.toFixed(2)).toBe("0.00");
    expect(is.totalCogs.toFixed(2)).toBe("0.00");
    expect(is.totalOpex.toFixed(2)).toBe("0.00");
    expect(is.netIncome.toFixed(2)).toBe("0.00");

    const dept = await incomeStatementByDepartment(club.id, new Date("2026-01-01T00:00:00.000Z"), asOf);
    expect(dept.rows.length).toBe(0);
    expect(dept.totalRevenue.toFixed(2)).toBe("0.00");
    expect(dept.totalOpex.toFixed(2)).toBe("0.00");
  });

  it("after real TB commit: every Finance report reconciles EXACTLY to the imported amounts (no extras)", async () => {
    const club = await bootstrapAccountingClub("Finance-Reconciles");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const asOf = new Date("2026-04-30T00:00:00.000Z");
    // Import a balanced TB with 6 lines totalling exact amounts
    // I can reconcile against. If any demo balance leaks in,
    // the totals will exceed these numbers.
    await commitTb(p, club.id, asOf, [
      { accountNumber: "1000", description: "Cash & Bank",          debit: "100000.00", credit: "0" },
      { accountNumber: "2000", description: "Accounts Payable",     debit: "0",         credit: "-30000.00" },
      { accountNumber: "3100", description: "Retained Earnings",    debit: "0",         credit: "-30000.00" },
      { accountNumber: "4000", description: "Membership Dues",      debit: "0",         credit: "-50000.00" },
      { accountNumber: "5000", description: "Cost of Sales — F&B",  debit: "5000.00",   credit: "0" },
      { accountNumber: "6000", description: "Course Salaries",      debit: "5000.00",   credit: "0" },
    ]);
    // Trial Balance — EXACTLY $110k each side, no extras.
    const tb = await trialBalance(club.id, asOf);
    expect(tb.totalDebit.toFixed(2)).toBe("110000.00");
    expect(tb.totalCredit.toFixed(2)).toBe("110000.00");
    expect(tb.isBalanced).toBe(true);
    expect(tb.rows.length).toBe(6);
    // Balance Sheet — Assets $100k, Liabilities $30k, Equity net $30k, Current-Year Earnings $40k = $70k right side.
    const bs = await balanceSheet(club.id, asOf);
    expect(bs.totalAssets.toFixed(2)).toBe("100000.00");
    expect(bs.totalLiabilities.toFixed(2)).toBe("30000.00");
    // Income Statement — Rev $50k, COGS $5k, OPEX $5k, Net $40k.
    const is = await incomeStatement(club.id, new Date("2026-01-01T00:00:00.000Z"), asOf);
    expect(is.totalRevenue.toFixed(2)).toBe("50000.00");
    expect(is.totalCogs.toFixed(2)).toBe("5000.00");
    expect(is.totalOpex.toFixed(2)).toBe("5000.00");
    expect(is.grossMargin.toFixed(2)).toBe("45000.00");
    expect(is.netIncome.toFixed(2)).toBe("40000.00");
    // Department P&L — same total revenue / COGS / OPEX as the IS.
    const dept = await incomeStatementByDepartment(club.id, new Date("2026-01-01T00:00:00.000Z"), asOf);
    expect(dept.totalRevenue.toFixed(2)).toBe("50000.00");
    expect(dept.totalCogs.toFixed(2)).toBe("5000.00");
    expect(dept.totalOpex.toFixed(2)).toBe("5000.00");
  });

  it("two clubs, one imports, one does not: the untouched club still reports zero", async () => {
    // Founder acceptance criterion: "Other clubs without real
    // imports are unaffected." If a demo layer were global, an
    // untouched club would show non-zero balances.
    const clubA = await bootstrapAccountingClub("Finance-Untouched-A");
    const clubB = await bootstrapAccountingClub("Finance-Import-B");
    await ensureFiscalYear(clubA.id, { startYear: 2026, startMonth: 1 });
    await ensureFiscalYear(clubB.id, { startYear: 2026, startMonth: 1 });
    const pB = await controllerFor(clubB.id);
    const asOf = new Date("2026-04-30T00:00:00.000Z");
    // Import ONLY into club B.
    await commitTb(pB, clubB.id, asOf, [
      { accountNumber: "1000", description: "Cash", debit: "50000.00", credit: "0" },
      { accountNumber: "2000", description: "AP",   debit: "0",       credit: "-50000.00" },
    ]);
    // Club A stays flat.
    const tbA = await trialBalance(clubA.id, asOf);
    expect(tbA.totalDebit.toFixed(2)).toBe("0.00");
    expect(tbA.rows.length).toBe(0);
    // Club B has the imported balances.
    const tbB = await trialBalance(clubB.id, asOf);
    expect(tbB.totalDebit.toFixed(2)).toBe("50000.00");
  });
});

// ---------------------------------------------------------------------------
// v14.9 — seeded JournalEntry rows are tagged source="DEMO"; Finance
// reports exclude them once a real Opening Trial Balance import exists.
// ---------------------------------------------------------------------------
describe("v14.9 — demo-tagged journal entries are excluded from Finance reports after real TB commit", () => {
  async function plantDemoJournal(
    clubId: string,
    accountNumber: string,
    debit: number,
    credit: number,
    entryDate: Date,
    postedByUserId: string,
  ) {
    const period = await db().fiscalPeriod.findFirstOrThrow({
      where: { fiscalYear: { clubId }, startDate: { lte: entryDate }, endDate: { gte: entryDate } },
    });
    const acct = await db().account.findFirstOrThrow({ where: { clubId, accountNumber } });
    const je = await db().journalEntry.create({
      data: {
        clubId,
        entryNumber: `DEMO-${Math.random().toString(36).slice(2, 8)}`,
        entryDate, periodId: period.id,
        description: "planted demo journal",
        source: "DEMO",           // ← v14.9 tag
        status: "POSTED",
        postedAt: new Date(),
        postedByUserId,
        totalDebits: debit,
        totalCredits: credit,
      },
    });
    await db().journalEntryLine.create({
      data: { clubId, journalEntryId: je.id, lineNumber: 1, accountId: acct.id, debit, credit },
    });
    return je.id;
  }

  it("the founder's exact 4 demo balances ($1,240 / $1,640 / $960 / $300) are HIDDEN from Finance reports on July 1, 2026 after a real TB commit", async () => {
    const club = await bootstrapAccountingClub("v14.9-Founder-Amounts");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const demoDate = new Date("2026-07-01T00:00:00.000Z");
    // Plant demo journals at the founder's reported amounts:
    // - $1,240 → account 5000 (F&B COGS)
    // - $1,640 → account 4000 (Membership Dues → Admin dept revenue)
    // - $960   → account 4300 (Pro Shop Revenue)
    // - $300   → account 4900 (Other Revenue → Unassigned dept)
    await plantDemoJournal(club.id, "5000", 1240, 0,    demoDate, p.id);
    await plantDemoJournal(club.id, "4000", 0,    1640, demoDate, p.id);
    await plantDemoJournal(club.id, "4300", 0,    960,  demoDate, p.id);
    await plantDemoJournal(club.id, "4900", 0,    300,  demoDate, p.id);
    // BEFORE any real TB commit: demo entries show through.
    const isBefore = await incomeStatement(club.id, new Date("2026-01-01T00:00:00.000Z"), demoDate);
    expect(Number(isBefore.totalCogs)).toBe(1240);
    expect(Number(isBefore.totalRevenue)).toBe(1640 + 960 + 300);

    // Now commit a real Opening Trial Balance import.
    await commitTb(p, club.id, new Date("2026-04-30T00:00:00.000Z"), [
      { accountNumber: "1000", description: "Cash & Bank",      debit: "100000.00", credit: "0" },
      { accountNumber: "2000", description: "Accounts Payable", debit: "0",         credit: "-100000.00" },
    ]);
    // AFTER the real TB commit: demo entries are excluded from
    // EVERY Finance report at every date.
    const tb = await trialBalance(club.id, demoDate);
    expect(Number(tb.totalDebit)).toBe(100000);   // only the real TB row remains
    expect(Number(tb.totalCredit)).toBe(100000);
    expect(tb.rows.every((r) => r.accountNumber === "1000" || r.accountNumber === "2000")).toBe(true);

    const isAfter = await incomeStatement(club.id, new Date("2026-01-01T00:00:00.000Z"), demoDate);
    expect(Number(isAfter.totalCogs)).toBe(0);         // $1,240 F&B COGS: gone
    expect(Number(isAfter.totalRevenue)).toBe(0);      // $1,640 + $960 + $300 revenues: all gone
    expect(Number(isAfter.netIncome)).toBe(0);

    const dept = await incomeStatementByDepartment(club.id, new Date("2026-01-01T00:00:00.000Z"), demoDate);
    expect(Number(dept.totalRevenue)).toBe(0);         // demo dept revenues: gone
    expect(Number(dept.totalCogs)).toBe(0);
  });

  it("club without a real TB commit STILL shows demo entries (pre-import mode is preserved)", async () => {
    const club = await bootstrapAccountingClub("v14.9-Pre-Import");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const demoDate = new Date("2026-07-01T00:00:00.000Z");
    await plantDemoJournal(club.id, "5000", 1240, 0, demoDate, p.id);
    // No TB commit — pre-import state.
    const is = await incomeStatement(club.id, new Date("2026-01-01T00:00:00.000Z"), demoDate);
    expect(Number(is.totalCogs)).toBe(1240);           // demo still visible
  });

  it("voiding the club's live TB batch re-enables demo entries (via hasCommittedRealTrialBalance)", async () => {
    const club = await bootstrapAccountingClub("v14.9-Void-Live");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const demoDate = new Date("2026-07-01T00:00:00.000Z");
    await plantDemoJournal(club.id, "5000", 1240, 0, demoDate, p.id);
    // Commit a TB → demo excluded.
    const committed = await commitTb(p, club.id, new Date("2026-04-30T00:00:00.000Z"), [
      { accountNumber: "1000", description: "Cash", debit: "100.00", credit: "0" },
      { accountNumber: "2000", description: "AP",   debit: "0",     credit: "-100.00" },
    ]);
    let is = await incomeStatement(club.id, new Date("2026-01-01T00:00:00.000Z"), demoDate);
    expect(Number(is.totalCogs)).toBe(0);
    // Void the live TB → the club is back to "no real import" → demo returns.
    await (await import("@/lib/imports")).voidCommittedBatch(p, committed.id, "test housekeeping");
    is = await incomeStatement(club.id, new Date("2026-01-01T00:00:00.000Z"), demoDate);
    expect(Number(is.totalCogs)).toBe(1240);
  });

  it("hasCommittedRealTrialBalance: true only when a COMMITTED batch that isn't superseded/voided exists", async () => {
    const club = await bootstrapAccountingClub("v14.9-Detection");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const { hasCommittedRealTrialBalance } = await import("@/lib/accounting/balance");
    expect(await hasCommittedRealTrialBalance(club.id)).toBe(false);
    await commitTb(p, club.id, new Date("2026-04-30T00:00:00.000Z"), [
      { accountNumber: "1000", description: "Cash", debit: "100.00", credit: "0" },
      { accountNumber: "2000", description: "AP",   debit: "0",     credit: "-100.00" },
    ]);
    expect(await hasCommittedRealTrialBalance(club.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// v14.10 — Income by Department honors the imported COA's dept mapping.
// ---------------------------------------------------------------------------
describe("v14.10 — Income by Department uses each account's default department from the COA", () => {
  it("TB commit populates journal-line departmentId from account.defaultDepartmentId (new imports carry the dept end-to-end)", async () => {
    const club = await bootstrapAccountingClub("v14.10-CarryThroughDept");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const asOf = new Date("2026-04-30T00:00:00.000Z");
    // Every seeded revenue/expense account has a defaultDepartmentCode
    // (see coa-template.ts DEFAULT_ACCOUNTS). Import a mixed TB.
    await commitTb(p, club.id, asOf, [
      { accountNumber: "1000", description: "Cash",                        debit: "10000.00", credit: "0" },
      { accountNumber: "2000", description: "AP",                          debit: "0",        credit: "-10000.00" },
      // Revenue with departments: 4000 → ADMIN, 4100 → PROSHOP.
      { accountNumber: "4000", description: "Membership Dues",             debit: "0",        credit: "-3000.00" },
      { accountNumber: "4100", description: "Greens & Guest Fees",         debit: "0",        credit: "-2000.00" },
      // COGS: 5000 → F&B.
      { accountNumber: "5000", description: "Cost of Sales — F&B",         debit: "1500.00",  credit: "0" },
      // OPEX: 6000 → GROUNDS.
      { accountNumber: "6000", description: "Course Salaries & Wages",     debit: "3500.00",  credit: "0" },
    ]);
    // Every non-BS journal line should now have departmentId set
    // to the account's defaultDepartmentId.
    const lines = await db().journalEntryLine.findMany({
      where: {
        clubId: club.id,
        entry: { source: "IMPORT", sourceEntityType: "ImportBatch" },
        account: { type: { in: ["REVENUE", "EXPENSE"] } },
      },
      include: { account: true },
    });
    for (const l of lines) {
      expect(l.departmentId).toBe(l.account.defaultDepartmentId);
      expect(l.departmentId).not.toBeNull();
    }
  });

  it("Income by Department attributes each row to the imported COA's department (not Unassigned)", async () => {
    const club = await bootstrapAccountingClub("v14.10-Attribution");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const asOf = new Date("2026-04-30T00:00:00.000Z");
    await commitTb(p, club.id, asOf, [
      { accountNumber: "1000", description: "Cash",                    debit: "10000.00", credit: "0" },
      { accountNumber: "2000", description: "AP",                      debit: "0",        credit: "-10000.00" },
      { accountNumber: "4000", description: "Membership Dues",         debit: "0",        credit: "-3000.00" },     // ADMIN
      { accountNumber: "4100", description: "Greens & Guest Fees",     debit: "0",        credit: "-2000.00" },     // PROSHOP
      { accountNumber: "5000", description: "Cost of Sales — F&B",     debit: "1500.00",  credit: "0" },            // F&B
      { accountNumber: "6000", description: "Course Salaries & Wages", debit: "3500.00",  credit: "0" },            // GROUNDS
    ]);
    const dept = await incomeStatementByDepartment(club.id, new Date("2026-01-01T00:00:00.000Z"), asOf);
    // Departments present + their contributions.
    const byName = new Map(dept.rows.map((r) => [r.departmentName, r]));
    const admin = byName.get("Administration");
    const proshop = byName.get("Pro Shop");
    const fb = byName.get("Food & Beverage");
    const grounds = byName.get("Grounds");
    expect(admin, "ADMIN row present").toBeTruthy();
    expect(proshop, "PROSHOP row present").toBeTruthy();
    expect(fb, "F&B row present").toBeTruthy();
    expect(grounds, "GROUNDS row present").toBeTruthy();
    // Amounts land in the correct dept + column.
    expect(Number(admin!.revenue)).toBe(3000);
    expect(Number(proshop!.revenue)).toBe(2000);
    expect(Number(fb!.cogs)).toBe(1500);
    expect(Number(grounds!.opex)).toBe(3500);
    // NO row should be Unassigned — every account in the seed COA has a dept.
    expect(dept.rows.some((r) => r.departmentName === "Unassigned")).toBe(false);
  });

  it("consolidated department totals reconcile EXACTLY to the Income Statement totals", async () => {
    const club = await bootstrapAccountingClub("v14.10-Reconciliation");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const asOf = new Date("2026-04-30T00:00:00.000Z");
    await commitTb(p, club.id, asOf, [
      { accountNumber: "1000", description: "Cash",                    debit: "2300.00", credit: "0" },
      { accountNumber: "2000", description: "AP",                      debit: "0",       credit: "-1000.00" },
      { accountNumber: "3100", description: "Retained Earnings",       debit: "0",       credit: "-600.00" },
      { accountNumber: "4000", description: "Membership Dues",         debit: "0",       credit: "-800.00" },
      { accountNumber: "4100", description: "Greens & Guest Fees",     debit: "0",       credit: "-500.00" },
      { accountNumber: "5000", description: "Cost of Sales — F&B",     debit: "200.00",  credit: "0" },
      { accountNumber: "6000", description: "Course Salaries & Wages", debit: "400.00",  credit: "0" },
    ]);
    const from = new Date("2026-01-01T00:00:00.000Z");
    const is = await incomeStatement(club.id, from, asOf);
    const dept = await incomeStatementByDepartment(club.id, from, asOf);
    expect(dept.totalRevenue.toFixed(2)).toBe(is.totalRevenue.toFixed(2));
    expect(dept.totalCogs.toFixed(2)).toBe(is.totalCogs.toFixed(2));
    expect(dept.totalOpex.toFixed(2)).toBe(is.totalOpex.toFixed(2));
    // Contribution = revenue - cogs - opex, same math as net income.
    expect(dept.totalContribution.toFixed(2)).toBe(is.netIncome.toFixed(2));
  });

  it("report-layer fallback: legacy journal lines (departmentId=null) still land under the account's default department", async () => {
    // This proves the founder's ALREADY-COMMITTED TB — where
    // pre-v14.10 lines have departmentId=null — is corrected
    // by the report-layer fallback without a re-import.
    const club = await bootstrapAccountingClub("v14.10-Fallback");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const asOf = new Date("2026-04-30T00:00:00.000Z");
    const period = await db().fiscalPeriod.findFirstOrThrow({
      where: { fiscalYear: { clubId: club.id }, startDate: { lte: asOf }, endDate: { gte: asOf } },
    });
    // 4000 (Membership Dues) has defaultDepartmentCode="ADMIN".
    const acct = await db().account.findFirstOrThrow({ where: { clubId: club.id, accountNumber: "4000" } });
    expect(acct.defaultDepartmentId).not.toBeNull();
    // Plant a JE with line.departmentId = null (simulating a
    // pre-v14.10 commit).
    const je = await db().journalEntry.create({
      data: {
        clubId: club.id,
        entryNumber: "LEGACY-TB-1",
        entryDate: asOf, periodId: period.id,
        description: "legacy TB import",
        source: "IMPORT",
        status: "POSTED",
        postedAt: new Date(),
        postedByUserId: p.id,
        totalDebits: 0,
        totalCredits: 500,
      },
    });
    await db().journalEntryLine.create({
      data: {
        clubId: club.id, journalEntryId: je.id, lineNumber: 1,
        accountId: acct.id,
        departmentId: null,   // ← the pre-v14.10 state
        debit: 0, credit: 500,
      },
    });
    const dept = await incomeStatementByDepartment(club.id, new Date("2026-01-01T00:00:00.000Z"), asOf);
    // Even though the LINE has no departmentId, the ACCOUNT's
    // default is ADMIN — the fallback places the row under
    // "Administration", not Unassigned.
    const admin = dept.rows.find((r) => r.departmentName === "Administration");
    expect(admin, "ADMIN row present via fallback").toBeTruthy();
    expect(Number(admin!.revenue)).toBe(500);
    expect(dept.rows.some((r) => r.departmentName === "Unassigned")).toBe(false);
  });

  it("truly unmapped accounts (no line dept AND no account default) still land in Unassigned", async () => {
    const club = await bootstrapAccountingClub("v14.10-Unassigned");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const asOf = new Date("2026-04-30T00:00:00.000Z");
    // Deliberately clear the default dept from 4900 (Other Revenue).
    await db().account.updateMany({
      where: { clubId: club.id, accountNumber: "4900" },
      data: { defaultDepartmentId: null },
    });
    // Post a journal line to the now-dept-less account.
    const acct = await db().account.findFirstOrThrow({ where: { clubId: club.id, accountNumber: "4900" } });
    expect(acct.defaultDepartmentId).toBeNull();
    const period = await db().fiscalPeriod.findFirstOrThrow({
      where: { fiscalYear: { clubId: club.id }, startDate: { lte: asOf }, endDate: { gte: asOf } },
    });
    const je = await db().journalEntry.create({
      data: {
        clubId: club.id, entryNumber: "TEST-UNASSIGNED",
        entryDate: asOf, periodId: period.id,
        description: "no dept on either line or account",
        source: "IMPORT", status: "POSTED", postedAt: new Date(), postedByUserId: p.id,
        totalDebits: 0, totalCredits: 300,
      },
    });
    await db().journalEntryLine.create({
      data: {
        clubId: club.id, journalEntryId: je.id, lineNumber: 1,
        accountId: acct.id, departmentId: null, debit: 0, credit: 300,
      },
    });
    const dept = await incomeStatementByDepartment(club.id, new Date("2026-01-01T00:00:00.000Z"), asOf);
    const unassigned = dept.rows.find((r) => r.departmentName === "Unassigned");
    expect(unassigned, "Unassigned row present for truly-unmapped account").toBeTruthy();
    expect(Number(unassigned!.revenue)).toBe(300);
  });
});

describe("v14.8 — source-contract: Finance report pages + services import ZERO demo helpers", () => {
  const paths = {
    trialBalancePage:      "src/app/app/admin/reports/trial-balance/page.tsx",
    balanceSheetPage:      "src/app/app/admin/reports/balance-sheet/page.tsx",
    incomeStatementPage:   "src/app/app/admin/reports/income-statement/page.tsx",
    departmentPnlPage:     "src/app/app/admin/reports/department-pnl/page.tsx",
    reportsService:        "src/lib/accounting/reports.ts",
    balanceService:        "src/lib/accounting/balance.ts",
  };

  const readAll = () => {
    const out: Record<string, string> = {};
    for (const [k, rel] of Object.entries(paths)) {
      out[k] = fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");
    }
    return out;
  };

  it("no file in the Finance report chain imports anything that looks like a demo helper", () => {
    const srcs = readAll();
    // Forbidden patterns — any of these strings in any file
    // would mean a demo-injection helper is being referenced.
    const forbidden = [
      /demo[A-Z][A-Za-z]+\s*\(/,        // demoBalances(), demoFinancial()
      /seedDemo[A-Za-z]*\s*\(/,          // seedDemoLedger()
      /fakeBalance/i,
      /mockBalance/i,
      /import\s*\{[^}]*[Dd]emo[^}]*\}/,  // import { demoXxx }
    ];
    for (const [name, src] of Object.entries(srcs)) {
      for (const pat of forbidden) {
        expect(src, `${name} imports a demo helper matching ${pat}`).not.toMatch(pat);
      }
    }
  });

  it("service functions read from Prisma with status: POSTED filter (no fallback / demo branch)", () => {
    const { balanceService, reportsService } = readAll();
    // balance.ts — accountBalances filters by entry.status = POSTED.
    expect(balanceService).toMatch(/status:\s*"POSTED"/);
    // reports.ts — every JE query goes through accountBalances or its own POSTED filter.
    expect(reportsService).toMatch(/accountBalances\(clubId/);
    // Neither service has a "no-data fallback" that returns
    // synthetic rows.
    expect(balanceService).not.toMatch(/return\s+DEMO_ROWS/);
    expect(reportsService).not.toMatch(/return\s+DEMO_/);
  });

  it("no Finance report page calls a report function that itself pulls from a non-JournalEntry table", () => {
    // A sanity check: the report pages import ONLY from
    // '@/lib/accounting/reports' (or format helpers), not from
    // any Monthly Reporting Package module that seeds snapshots.
    const { trialBalancePage, balanceSheetPage, incomeStatementPage, departmentPnlPage } = readAll();
    for (const [name, src] of Object.entries({ trialBalancePage, balanceSheetPage, incomeStatementPage, departmentPnlPage })) {
      // The Monthly Reporting Package uses `monthly-package` +
      // `monthly-accounting-contract` + friends — those files
      // are the ones with seeded snapshots. Finance pages MUST
      // NOT import them.
      expect(src, `${name} imports from monthly-package / seed layer`).not.toMatch(/from\s+"@\/lib\/reporting\/monthly[-/]/);
      expect(src, `${name} imports monthly-accounting-contract`).not.toMatch(/monthly-accounting-contract/);
    }
  });
});
