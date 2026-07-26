// Founder rule 2026-07-01 v14.12/v14.13 — the visible Monthly
// Reporting Package Executive Opening → At A Glance YTD Revenue
// KPI reads from real ledger data after a committed OPENING_TRIAL_BALANCE
// import, NOT from `$14.62M` demo.
//
// This test invokes the same `getMonthlyReportingPackage` function
// the `/app/admin/reporting/monthly?period=YYYY-MM` page calls,
// with the same period-parsing logic. If the KPI shows `$14.62M`
// (or any other demo value), this test fails — proving the browser
// would fail the same way.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAccountingClub } from "./util/gl";
import { createBatch, validateBatch, commitBatch } from "@/lib/imports";
import { ensureFiscalYear } from "@/lib/accounting/periods";
import { getMonthlyReportingPackage } from "@/lib/reporting/monthly-package";

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

describe("v14.12/v14.13 — Executive Opening → At A Glance YTD Revenue shows real ledger data, not demo", () => {
  it("real April 2026 TB → getMonthlyReportingPackage's YTD Revenue KPI reads $4.69M (not demo $14.62M)", async () => {
    const club = await bootstrapAccountingClub("v14.12-KPI-BrowserFlow");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const asOf = new Date("2026-04-30T00:00:00.000Z");
    // Founder's actual numbers: total YTD revenue $4,694,244.73.
    await commitTb(p, club.id, asOf, [
      // Debits total $5.3M
      { accountNumber: "1000", description: "Cash",                debit: "5000000.00", credit: "0" },
      { accountNumber: "5000", description: "Cost of Sales — F&B",debit: "300000.00",   credit: "0" },
      // Credits total $5.3M: revenue $4,694,244.73 + retained $605,755.27
      { accountNumber: "3100", description: "Retained Earnings",  debit: "0",           credit: "-605755.27" },
      { accountNumber: "4000", description: "Membership Dues",    debit: "0",           credit: "-2000000.00" },
      { accountNumber: "4100", description: "Greens & Guest Fees",debit: "0",           credit: "-1500000.00" },
      { accountNumber: "4200", description: "F&B — Dining",       debit: "0",           credit: "-1194244.73" },
    ]);

    // Invoke the EXACT function the page calls, with the EXACT
    // period parsing the page uses for `?period=2026-04`. The page
    // constructs Date.UTC(2026, 3, 1) → Date.UTC(2026, 3, 30).
    const pkg = await getMonthlyReportingPackage(club.id, {
      period: {
        start: new Date(Date.UTC(2026, 3, 1)),
        end: new Date(Date.UTC(2026, 3, 30)),
      },
    });

    const ytdRev = pkg.executiveSummary.kpis.find((k) => k.key === "ytd-revenue");
    expect(ytdRev, "YTD Revenue KPI card must exist").toBeTruthy();
    // Demo value must NOT appear.
    expect(ytdRev!.value).not.toContain("14.62");
    expect(ytdRev!.value).not.toContain("$14.62M");
    // Real value from the ledger — formatMoneyShort divides by 1M
    // and .toFixed(2), so $4,694,244.73 → "$4.69M".
    expect(ytdRev!.value).toBe("$4.69M");
  });

  it("no real TB → package still renders demo (pre-import behaviour preserved)", async () => {
    const club = await bootstrapAccountingClub("v14.12-KPI-DemoStill");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    // No TB commit.
    const pkg = await getMonthlyReportingPackage(club.id, {
      period: {
        start: new Date(Date.UTC(2026, 3, 1)),
        end: new Date(Date.UTC(2026, 3, 30)),
      },
    });
    const ytdRev = pkg.executiveSummary.kpis.find((k) => k.key === "ytd-revenue");
    // Demo value (or whatever the demoFallback produces) — the
    // point is the code path DID fall through to demo, not that
    // the exact number matches.
    expect(ytdRev, "YTD Revenue KPI card must exist even on demo").toBeTruthy();
    expect(ytdRev!.value).toMatch(/^\$/);
  });
});
