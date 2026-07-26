// Founder rule 2026-07-01 v14.11 — Monthly Reporting Package uses
// real ledger data once a committed Opening Trial Balance import
// exists.
//
// Root cause: `PrismaReportingLedger.getTrialBalance()` reads only
// a persisted snapshot table (a legacy Jonas import pipeline the
// v14.3 TB commit never writes to). When no snapshot exists, all 5
// dual-read builders — Executive Summary, Stewardship Dashboard,
// Statement of Activities, Capital Fund, Statement of Financial
// Position — fell through to demo, producing the founder's
// screenshot $14.62M YTD Revenue instead of the real $4.69M.
//
// Fix: live-synthesis fallback in PrismaReportingLedger — when the
// snapshot table is empty AND `hasCommittedRealTrialBalance` is
// true, synthesize a snapshot from the same accounting service the
// Finance reports use. Monthly Package numbers now reconcile to
// Finance report numbers by construction.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAccountingClub } from "./util/gl";
import { createBatch, validateBatch, commitBatch } from "@/lib/imports";
import { ensureFiscalYear } from "@/lib/accounting/periods";
import { incomeStatement, balanceSheet } from "@/lib/accounting/reports";
import { PrismaReportingLedger } from "@/lib/reporting/ledger/prisma-ledger";

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

describe("v14.11 — Monthly Reporting Package ledger synthesizes real data from committed TB imports", () => {
  it("no committed TB → PrismaReportingLedger.getTrialBalance returns null (dual-read → demo)", async () => {
    const club = await bootstrapAccountingClub("v14.11-NoTB");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const ledger = new PrismaReportingLedger(db() as unknown as PrismaClient);
    const tb = await ledger.getTrialBalance(club.id, new Date("2026-04-30T00:00:00.000Z"));
    expect(tb).toBeNull();
  });

  it("committed TB → PrismaReportingLedger.getTrialBalance returns a synthesized snapshot with real totals", async () => {
    const club = await bootstrapAccountingClub("v14.11-Live-TB");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const asOf = new Date("2026-04-30T00:00:00.000Z");
    await commitTb(p, club.id, asOf, [
      { accountNumber: "1000", description: "Cash",              debit: "500000.00", credit: "0" },
      { accountNumber: "2000", description: "Accounts Payable",  debit: "0",         credit: "-100000.00" },
      { accountNumber: "3100", description: "Retained Earnings", debit: "0",         credit: "-200000.00" },
      { accountNumber: "4000", description: "Membership Dues",   debit: "0",         credit: "-200000.00" },
    ]);
    const ledger = new PrismaReportingLedger(db() as unknown as PrismaClient);
    const tb = await ledger.getTrialBalance(club.id, asOf);
    expect(tb).not.toBeNull();
    expect(tb!.sourceSystem).toBe("spectre-accounting");
    expect(tb!.dataSource).toBe("accounting");
    expect(tb!.isBalanced).toBe(true);
    expect(Number(tb!.totalDebits)).toBe(500000);
    expect(Number(tb!.totalCredits)).toBe(500000);
    // Lines carry the imported account balances.
    const membership = tb!.lines.find((l) => l.accountCode === "4000");
    expect(membership).toBeTruthy();
    expect(Number(membership!.credit)).toBe(200000);
  });

  it("synthesized BS snapshot reconciles EXACTLY to balanceSheet() Finance-report totals", async () => {
    const club = await bootstrapAccountingClub("v14.11-BS-Reconciles");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const asOf = new Date("2026-04-30T00:00:00.000Z");
    await commitTb(p, club.id, asOf, [
      { accountNumber: "1000", description: "Cash",              debit: "500000.00", credit: "0" },
      { accountNumber: "2000", description: "Accounts Payable",  debit: "0",         credit: "-100000.00" },
      { accountNumber: "3100", description: "Retained Earnings", debit: "0",         credit: "-200000.00" },
      { accountNumber: "4000", description: "Membership Dues",   debit: "0",         credit: "-200000.00" },
    ]);
    const ledger = new PrismaReportingLedger(db() as unknown as PrismaClient);
    const [snap, real] = await Promise.all([
      ledger.getBalanceSheet(club.id, asOf),
      balanceSheet(club.id, asOf),
    ]);
    expect(snap).not.toBeNull();
    expect(snap!.sourceSystem).toBe("spectre-accounting");
    expect(snap!.totalAssets.toFixed(2)).toBe(real.totalAssets.toFixed(2));
    expect(snap!.totalLiabilities.toFixed(2)).toBe(real.totalLiabilities.toFixed(2));
    expect(snap!.totalEquity.toFixed(2)).toBe(real.totalEquity.toFixed(2));
    expect(snap!.isReconciled).toBe(real.isBalanced);
  });

  it("synthesized IS snapshot reconciles EXACTLY to incomeStatement() — the founder's screenshot scenario", async () => {
    // Founder's scenario: real April TB imported → Executive
    // Opening → At A Glance shows YTD Revenue matching Income
    // Statement, NOT the demo $14.62M.
    const club = await bootstrapAccountingClub("v14.11-IS-Reconciles");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const asOf = new Date("2026-04-30T00:00:00.000Z");
    const fyStart = new Date("2026-01-01T00:00:00.000Z");
    // Import balances mirroring the founder's actual TB
    // (aggregate $4.69M revenue split across the seed's revenue accounts).
    await commitTb(p, club.id, asOf, [
      // Debits total 5,300,000
      { accountNumber: "1000", description: "Cash",                debit: "5000000.00", credit: "0" },
      { accountNumber: "5000", description: "Cost of Sales — F&B",debit: "300000.00",   credit: "0" },
      // Credits total 5,300,000: revenue 4,694,244.73 + retained 605,755.27
      { accountNumber: "3100", description: "Retained Earnings",  debit: "0",           credit: "-605755.27" },
      { accountNumber: "4000", description: "Membership Dues",    debit: "0",           credit: "-2000000.00" },
      { accountNumber: "4100", description: "Greens & Guest Fees",debit: "0",           credit: "-1500000.00" },
      { accountNumber: "4200", description: "F&B — Dining",       debit: "0",           credit: "-1194244.73" },
    ]);
    const ledger = new PrismaReportingLedger(db() as unknown as PrismaClient);
    const [snap, real] = await Promise.all([
      ledger.getIncomeStatement(club.id, fyStart, asOf),
      incomeStatement(club.id, fyStart, asOf),
    ]);
    expect(snap).not.toBeNull();
    expect(snap!.sourceSystem).toBe("spectre-accounting");
    // YTD Revenue reconciles EXACTLY.
    expect(snap!.totalOperatingRevenue.toFixed(2)).toBe(real.totalRevenue.toFixed(2));
    expect(snap!.totalOperatingRevenue.toFixed(2)).toBe("4694244.73"); // ← founder's expected value
    // Expense reconciles.
    const expenseTotal = Number(real.totalCogs.plus(real.totalOpex));
    expect(snap!.totalOperatingExpense).toBe(expenseTotal);
    // NOI reconciles.
    expect(snap!.noiBeforeDepreciation.toFixed(2)).toBe(real.netIncome.toFixed(2));
  });

  it("persisted snapshot wins over synthesis (backward compatibility with the legacy Jonas import pipeline)", async () => {
    // If a legacy Jonas month-end importer ever populates the
    // reporting-ledger snapshot table for a period, that snapshot
    // must win — the live synthesis is a FALLBACK, not a rewrite.
    // This test proves the read order.
    const club = await bootstrapAccountingClub("v14.11-Snapshot-Wins");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const asOf = new Date("2026-04-30T00:00:00.000Z");
    // Commit a real TB with $500k revenue.
    await commitTb(p, club.id, asOf, [
      { accountNumber: "1000", description: "Cash",              debit: "500000.00", credit: "0" },
      { accountNumber: "2000", description: "AP",                debit: "0",         credit: "-500000.00" },
    ]);
    // Write a mock "legacy Jonas" TB snapshot with different totals.
    const rowId = `mock-${Math.random().toString(36).slice(2)}`;
    const batchId = `mock-batch-${Math.random().toString(36).slice(2)}`;
    await db().reportingLedgerBatch.create({
      data: {
        batchId, clubId: club.id,
        sourceSystem: "jonas-gl",
        state: "committed",
        closedAt: new Date(),
      },
    });
    await db().reportingLedgerSnapshot.create({
      data: {
        snapshotId: rowId, clubId: club.id,
        entityKind: "trial-balance",
        payloadHash: "mockhash",
        sourceSystem: "jonas-gl",
        batchState: "committed",
        importBatchId: batchId,
        capturedAt: new Date(),
        dataSource: "accounting",
        asOf,
        periodStart: new Date("2026-01-01T00:00:00.000Z"),
        periodEnd: asOf,
        fiscalYearLabel: "FY2026",
        payloadJson: JSON.stringify({
          entityKind: "trial-balance",
          snapshotId: rowId,
          clubId: club.id,
          capturedAt: new Date(),
          sourceSystem: "jonas-gl",
          importBatchId: batchId,
          dataSource: "accounting",
          notes: null,
          asOf,
          periodStart: new Date("2026-01-01T00:00:00.000Z"),
          periodEnd: asOf,
          fiscalYearLabel: "FY2026",
          fiscalPeriodSequence: 4,
          accounts: [],
          lines: [],
          totalDebits: 999999,   // ← distinct value proves snapshot won
          totalCredits: 999999,
          isBalanced: true,
        }),
      },
    });
    const ledger = new PrismaReportingLedger(db() as unknown as PrismaClient);
    const tb = await ledger.getTrialBalance(club.id, asOf);
    expect(tb!.sourceSystem).toBe("jonas-gl");
    expect(Number(tb!.totalDebits)).toBe(999999);
  });
});
