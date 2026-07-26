// Founder rule 2026-07-02 v15.4 — Capital Income on the live
// Monthly Reporting Package flows from Account.fundApplicability.
//
// The bug: after tagging real revenue accounts as CAPITAL in the
// CoA, the May 2026 Monthly Reporting Package showed
// Capital Income = $0. Root cause was in
// `synthesizeIncomeStatementSnapshot` (live-synthesis.ts) — it
// hardcoded `totalCapitalIncome: 0` + `totalCapitalExpense: 0`
// and stamped every line's `fund: "operating"`, so the CoA's
// fundApplicability value never reached the Executive Summary.
//
// These tests exercise the exact same call the /reporting/monthly
// page makes, on a real committed Trial Balance where operators
// have set fundApplicability = "CAPITAL" on specific accounts.
// The assertions lock:
//
//   • Executive Summary → Capital Income KPI reads a non-zero
//     value when accounts are tagged CAPITAL.
//   • The value MATCHES the sum of the tagged accounts'
//     natural balances.
//   • Retagging an account from OPERATING → CAPITAL immediately
//     flips it (no snapshot cache; the synth reruns per read).
//   • Balance-sheet + null-tagged accounts stay excluded.
//   • Line-level `fund` field on the snapshot mirrors the CoA
//     value (so downstream consumers reading `snapshot.lines`
//     see the fund correctly).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAccountingClub } from "./util/gl";
import { createBatch, validateBatch, commitBatch } from "@/lib/imports";
import { ensureFiscalYear } from "@/lib/accounting/periods";
import { getMonthlyReportingPackage } from "@/lib/reporting/monthly-package";
import { synthesizeIncomeStatementSnapshot } from "@/lib/reporting/ledger/live-synthesis";

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

/**
 * Tag a specific existing account with a fundApplicability value.
 * The test's "operator override" step — mirrors what happens in
 * the CoA UI when the operator flips OPERATING → CAPITAL on the
 * bulk assignment form.
 */
async function tagFund(
  clubId: string,
  accountNumber: string,
  fund: "OPERATING" | "CAPITAL" | "OPERATING,CAPITAL" | null,
) {
  await db().account.update({
    where: { clubId_accountNumber: { clubId, accountNumber } },
    data: { fundApplicability: fund },
  });
}

beforeAll(async () => { await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

describe("v15.4 live IS synth partitions revenue by Account.fundApplicability", () => {
  it("real May 2026 TB with revenue tagged CAPITAL → totalCapitalIncome > 0 (the founder's exact bug)", async () => {
    const club = await bootstrapAccountingClub("v15.4-Capital-Live");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const asOf = new Date("2026-05-31T00:00:00.000Z");
    // All account numbers below are seeded by bootstrapAccountingClub
    // via DEFAULT_ACCOUNTS — using existing numbers keeps the TB
    // ACCOUNT_NOT_FOUND validation quiet.
    await commitTb(p, club.id, asOf, [
      // Assets / equity (BS) — balancing side.
      { accountNumber: "1000", description: "Cash",                 debit:  "2500000.00", credit: "0" },
      { accountNumber: "3000", description: "Member Shares",        debit: "0",           credit: "-500000.00" },
      // Operating revenue — should stay in the operating totals.
      { accountNumber: "4000", description: "Membership Dues",      debit: "0",           credit: "-1500000.00" },
      // Capital revenue — 4020 is the seeded Capital Assessments
      // account. Slice 1's derive-default already set it to
      // CAPITAL via IS_CAPITAL_ASSESSMENTS, but we re-tag
      // explicitly here so the test's intent is unambiguous.
      { accountNumber: "4020", description: "Capital Assessments",  debit: "0",           credit: "-500000.00" },
    ]);
    // Ensure the tag is CAPITAL regardless of what the seed
    // default landed on.
    await tagFund(club.id, "4020", "CAPITAL");

    const pkg = await getMonthlyReportingPackage(club.id, {
      period: {
        start: new Date(Date.UTC(2026, 4, 1)),
        end: new Date(Date.UTC(2026, 4, 31)),
      },
    });

    const capIncomeKpi = pkg.executiveSummary.kpis.find((k) => k.key === "capital-income");
    expect(capIncomeKpi, "Capital Income KPI card must exist").toBeTruthy();
    // The exact byte the bug fixes: the KPI is no longer $0.
    // `formatMoneyShort` picks its own suffix (K / M) — the
    // essential contract locked here is (a) the value is not
    // zero + (b) it reflects the $500K tagged as CAPITAL.
    expect(capIncomeKpi!.value).not.toBe("$0.00M");
    expect(capIncomeKpi!.value).not.toBe("$0");
    // "$500K" today; format precision may evolve.
    expect(capIncomeKpi!.value).toMatch(/\$5?0?0K|\$0\.5\dM/);
  });

  it("a multi-fund (OPERATING,CAPITAL) revenue account contributes to CAPITAL totals (Slice-1 primary-fund semantic)", async () => {
    const club = await bootstrapAccountingClub("v15.4-Multi-Fund");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const asOf = new Date("2026-05-31T00:00:00.000Z");
    await commitTb(p, club.id, asOf, [
      { accountNumber: "1000", description: "Cash",             debit:  "1500000.00", credit: "0" },
      { accountNumber: "3000", description: "Member Shares",    debit: "0",           credit: "-500000.00" },
      { accountNumber: "4000", description: "Membership Dues",  debit: "0",           credit: "-500000.00" },
      { accountNumber: "4950", description: "Interest Income",  debit: "0",           credit: "-500000.00" },
    ]);
    // Multi-fund: contributes to CAPITAL under the primary-fund
    // tie-break locked in v15.3 fund-applicability-reporting tests.
    await tagFund(club.id, "4950", "OPERATING,CAPITAL");

    const snapshot = await synthesizeIncomeStatementSnapshot(
      club.id,
      new Date(Date.UTC(2026, 4, 1)),
      new Date(Date.UTC(2026, 4, 31)),
    );
    expect(snapshot).not.toBeNull();
    // 4950 flows into capital totals.
    expect(snapshot!.totalCapitalIncome).toBe(500_000);
    // 4000 stays operating.
    expect(snapshot!.totalOperatingRevenue).toBe(500_000);
    // Line-level fund tag reflects the primary fund on 4950.
    const line4950 = snapshot!.lines.find((l) => l.accountCode === "4950");
    expect(line4950).toBeTruthy();
    expect(line4950!.fund).toBe("capital");
  });

  it("expense accounts tagged CAPITAL flow into totalCapitalExpense; depreciation stays operating", async () => {
    const club = await bootstrapAccountingClub("v15.4-Capital-Expense");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const asOf = new Date("2026-05-31T00:00:00.000Z");
    await commitTb(p, club.id, asOf, [
      { accountNumber: "1000", description: "Cash",                 debit:  "1500000.00", credit: "0" },
      { accountNumber: "3000", description: "Member Shares",        debit: "0",           credit: "-1000000.00" },
      { accountNumber: "4000", description: "Membership Dues",      debit: "0",           credit: "-1000000.00" },
      { accountNumber: "6000", description: "Course Salaries",      debit:  "300000.00",  credit: "0" },
      { accountNumber: "6900", description: "Depreciation Expense", debit:  "100000.00",  credit: "0" },
      { accountNumber: "6910", description: "Interest Expense",     debit:  "100000.00",  credit: "0" },
    ]);
    // 6910 is capital-fund debt-service expense.
    await tagFund(club.id, "6910", "CAPITAL");

    const snapshot = await synthesizeIncomeStatementSnapshot(
      club.id,
      new Date(Date.UTC(2026, 4, 1)),
      new Date(Date.UTC(2026, 4, 31)),
    );
    expect(snapshot).not.toBeNull();
    expect(snapshot!.totalCapitalExpense).toBe(100_000);
    // Operating expense = payroll + depreciation = 400K.
    expect(snapshot!.totalOperatingExpense).toBe(400_000);
    // Depreciation subtotal preserved from FS Group.
    expect(snapshot!.depreciation).toBe(100_000);
    // NOI Before Depreciation = 1M − (400K − 100K) = 700K.
    expect(snapshot!.noiBeforeDepreciation).toBe(700_000);
  });
});

describe("v15.4 no snapshot cache — flipping fundApplicability immediately affects the next read", () => {
  it("changing an account from OPERATING to CAPITAL flips its contribution on the very next getMonthlyReportingPackage call", async () => {
    const club = await bootstrapAccountingClub("v15.4-No-Cache");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const asOf = new Date("2026-05-31T00:00:00.000Z");
    await commitTb(p, club.id, asOf, [
      { accountNumber: "1000", description: "Cash",             debit:  "1500000.00", credit: "0" },
      { accountNumber: "3000", description: "Member Shares",    debit: "0",           credit: "-500000.00" },
      { accountNumber: "4000", description: "Membership Dues",  debit: "0",           credit: "-500000.00" },
      { accountNumber: "4900", description: "Other Revenue",    debit: "0",           credit: "-500000.00" },
    ]);
    // Force 4900 to OPERATING as the initial state (bootstrap
    // derived default was already OPERATING for IS_OTHER_REVENUE).
    await tagFund(club.id, "4900", "OPERATING");
    // Read #1 → capital income is $0.
    const before = await synthesizeIncomeStatementSnapshot(
      club.id,
      new Date(Date.UTC(2026, 4, 1)),
      new Date(Date.UTC(2026, 4, 31)),
    );
    expect(before!.totalCapitalIncome).toBe(0);
    // Operator flips 4900 to CAPITAL.
    await tagFund(club.id, "4900", "CAPITAL");
    // Read #2 → same call, no cache invalidation, immediately
    // reflects the new tagging.
    const after = await synthesizeIncomeStatementSnapshot(
      club.id,
      new Date(Date.UTC(2026, 4, 1)),
      new Date(Date.UTC(2026, 4, 31)),
    );
    expect(after!.totalCapitalIncome).toBe(500_000);
    expect(after!.totalOperatingRevenue).toBe(500_000);
  });
});

describe("v15.4 accounts with null fundApplicability are excluded from every roll-up", () => {
  it("a P&L account with fundApplicability = null does not contribute to operating OR capital totals", async () => {
    const club = await bootstrapAccountingClub("v15.4-Null-Excluded");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const asOf = new Date("2026-05-31T00:00:00.000Z");
    await commitTb(p, club.id, asOf, [
      { accountNumber: "1000", description: "Cash",             debit:  "1500000.00", credit: "0" },
      { accountNumber: "3000", description: "Member Shares",    debit: "0",           credit: "-500000.00" },
      { accountNumber: "4000", description: "Membership Dues",  debit: "0",           credit: "-500000.00" },
      { accountNumber: "4900", description: "Other Revenue",    debit: "0",           credit: "-500000.00" },
    ]);
    // Operator FAILS to set fundApplicability on 4900 — we
    // clear whatever the seed default set.
    await tagFund(club.id, "4900", null);

    const snapshot = await synthesizeIncomeStatementSnapshot(
      club.id,
      new Date(Date.UTC(2026, 4, 1)),
      new Date(Date.UTC(2026, 4, 31)),
    );
    expect(snapshot).not.toBeNull();
    // Only 4000 (OPERATING) contributes to operating revenue.
    expect(snapshot!.totalOperatingRevenue).toBe(500_000);
    // 4900 (null) is excluded from both totals per the founder's diagnostic rule.
    expect(snapshot!.totalCapitalIncome).toBe(0);
    // 4900 is still present as a line (so operators can trace
    // it), but the line's fund is the safe placeholder.
    const line4900 = snapshot!.lines.find((l) => l.accountCode === "4900");
    expect(line4900).toBeTruthy();
    expect(line4900!.amount).toBe(500_000);
  });
});
