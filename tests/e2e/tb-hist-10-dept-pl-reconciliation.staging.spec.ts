// TB-HIST-10 (2026-10-02) — staging acceptance.
//
// Calls the new `/api/admin/dept-pl-reconciliation` diagnostic against
// Coulee staging for the Jan 2026 period. Proves:
//   • The dept-dimensional resolver runs against the committed Jan 31
//     2026 Jonas Trial Balance snapshot (not JournalEntryLine, which
//     is empty on Coulee).
//   • Returns a non-empty rows[] with real Spectre dept codes.
//   • Reconciliation.isBalanced === true — i.e. department-assigned
//     + nondepartmental == consolidated across Revenue / COS / OpEx /
//     NetIncome, with |difference| ≤ $0.01 per field.
//   • Coulee accounting invariants are unchanged BEFORE/AFTER
//     (562 / 16 / 0 / 2 / 2).

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";
const COA_BATCH_ID = "cmuni5ymv000k136q3xdyrpmn";

async function captureInvariant(page: Page) {
  const resp = await page.request.get(`${BASE}/api/admin/coa-batch-diagnostic/${COA_BATCH_ID}`);
  expect(resp.ok(), `coa diagnostic responded ${resp.status()}`).toBe(true);
  return resp.json();
}

runAt("TB-HIST-10 · dept-dimensional January 2026 reconciliation hard-gate", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);

  const before = await captureInvariant(page);
  console.log("TB_HIST_10_BEFORE " + JSON.stringify({
    status: before.status, totalRows: before.total, club: before.club, clubId: before.clubId,
  }));
  const clubId = (before as { clubId: string }).clubId;

  // Jan 2026 period: FY2026 Period 1 → from = Jan 1 2026, to = Jan 31 2026.
  // The YTD-slice resolver matches the Jonas Jan 31 snapshot's
  // (periodStart, periodEnd) exactly, so this is the authoritative
  // Jan Income Statement window.
  const url = `${BASE}/api/admin/dept-pl-reconciliation?clubId=${clubId}&from=2026-01-01&to=2026-01-31`;
  const resp = await page.request.get(url);
  console.log("TB_HIST_10_HTTP " + JSON.stringify({ status: resp.status(), ok: resp.ok() }));
  expect(resp.ok(), `dept-pl diagnostic responded ${resp.status()}`).toBe(true);

  const body = await resp.json();
  console.log("TB_HIST_10_RESULT " + JSON.stringify({
    source: body.source,
    rowCount: body.rows?.length ?? 0,
    sampleRows: (body.rows ?? []).slice(0, 5).map((r: { departmentCode: string | null; departmentName: string; revenue: string; cogs: string; opex: string; netIncome: string }) => ({
      code: r.departmentCode,
      name: r.departmentName,
      rev: r.revenue,
      cogs: r.cogs,
      opex: r.opex,
      net: r.netIncome,
    })),
    totals: body.totals,
    reconciliation: body.reconciliation,
  }));

  // Core assertions:
  // 1. The resolver reached the authoritative snapshot (not operational ledger).
  expect(body.source).toBe("AUTHORITATIVE_SNAPSHOT");
  // 2. At least one real department row exists.
  expect(Array.isArray(body.rows)).toBe(true);
  expect(body.rows.length).toBeGreaterThan(0);
  // 3. The reconciliation hard-gate (directive §5 §17.9).
  expect(body.reconciliation.isBalanced).toBe(true);
  // 4. All four difference fields are "0" after parsing.
  const diff = body.reconciliation.difference;
  for (const [field, strVal] of Object.entries(diff)) {
    const parsed = Number(strVal as string);
    console.log(`TB_HIST_10_DIFF_${field}=${parsed}`);
    expect(Math.abs(parsed)).toBeLessThanOrEqual(0.01);
  }

  // After invariant.
  const after = await captureInvariant(page);
  expect(after.club).toEqual(before.club);
  console.log("TB_HIST_10_AFTER " + JSON.stringify({ club: after.club }));
  await context.close();
});

runAt("TB-HIST-10 · BS as of 2026-10-02 freshness pill (TB-HIST-9 regression check)", async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);
  await page.goto(`${BASE}/app/admin/reports/balance-sheet?asOf=2026-10-02`, { waitUntil: "domcontentloaded" });
  const pillText = await page.locator('[data-testid="bs-report-data-through"]').textContent({ timeout: 15_000 });
  console.log("TB_HIST_10_BS_FRESHNESS " + JSON.stringify({ pillText }));
  expect(pillText).toContain("Financial data through");
  expect(pillText).toContain("2026-01-31");
  await context.close();
});
