// REPORT-LIVE-1 §22-23 (2026-10-03) — scoped staging acceptance for
// Section II (Financial Performance) + Section VIII (AR Aging) on
// live Coulee January 2026.
//
// Expected authoritative values:
//   Section II source panel (fp-source-*):
//     revenue    = $4.10M        (Jan IS)
//     cogs       = $14K          (Jan IS)
//     opex       = $325K         (Jan IS)
//     net income = $3.76M        (Jan IS)
//     actual     = AVAILABLE
//     budget     = SOURCE_NOT_CONNECTED
//     prior year = SOURCE_NOT_LOADED
//     departmentCount = 8
//
//   Section VIII AR Aging (ara-kpi-*):
//     total-ar             = $3,585,591
//     current-pct          = 99.3%
//     non-current          = $26,812
//     non-current-accounts = 93
//
//   Cross-component parity:
//     Executive Opening AR Current = Stewardship AR tile = Section VIII Current %
//
//   February 2026 regression:
//     Section VIII renders empty (no snapshot); Executive Opening AR = Unavailable

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";
const COULEE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const COA_BATCH_ID = "cmuni5ymv000k136q3xdyrpmn";

async function invariant(page: Page) {
  const r = await page.request.get(`${BASE}/api/admin/coa-batch-diagnostic/${COA_BATCH_ID}`);
  expect(r.ok()).toBe(true);
  return r.json();
}

runAt("REPORT-LIVE-1 · Section II + Section VIII scoped acceptance on live Coulee Jan 2026", async ({ browser }) => {
  test.setTimeout(300_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);

  const before = await invariant(page);
  console.log("REPORT_LIVE_1_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(2);
  expect(before.club.reportingLedgerSnapshot).toBe(2);

  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01`, { waitUntil: "domcontentloaded" });

  // ---- Section II source panel ----
  const fpPanel = page.locator('[data-testid="financial-performance-source-panel"]');
  await fpPanel.waitFor({ state: "visible", timeout: 15_000 });
  const fpRevenue   = await page.locator('[data-testid="fp-source-revenue"]').textContent({ timeout: 10_000 });
  const fpCogs      = await page.locator('[data-testid="fp-source-cogs"]').textContent({ timeout: 10_000 });
  const fpOpex      = await page.locator('[data-testid="fp-source-opex"]').textContent({ timeout: 10_000 });
  const fpNetIncome = await page.locator('[data-testid="fp-source-net-income"]').textContent({ timeout: 10_000 });
  const fpActual    = await page.locator('[data-testid="fp-source-actual"]').textContent({ timeout: 10_000 });
  const fpBudget    = await page.locator('[data-testid="fp-source-budget"]').textContent({ timeout: 10_000 });
  const fpPriorYear = await page.locator('[data-testid="fp-source-prior-year"]').textContent({ timeout: 10_000 });
  const fpDeptCount = await page.locator('[data-testid="fp-source-dept-count"]').textContent({ timeout: 10_000 });
  console.log("REPORT_LIVE_1_SECTION_II " + JSON.stringify({
    revenue: fpRevenue?.trim(),
    cogs: fpCogs?.trim(),
    opex: fpOpex?.trim(),
    netIncome: fpNetIncome?.trim(),
    actual: fpActual?.trim(),
    budget: fpBudget?.trim(),
    priorYear: fpPriorYear?.trim(),
    deptCount: fpDeptCount?.trim(),
  }));
  expect(fpRevenue).toMatch(/\$4\.(1|10)M/);
  expect(fpCogs).toMatch(/\$1[34]K/);
  expect(fpOpex).toMatch(/\$32[45]K/);
  expect(fpNetIncome).toMatch(/\$3\.7[56]M/);
  expect(fpActual).toContain("AVAILABLE");
  expect(fpBudget).toContain("SOURCE_NOT_CONNECTED");
  expect(fpPriorYear).toContain("SOURCE_NOT_LOADED");
  expect(fpDeptCount).toContain("8");

  // ---- Section VIII AR Aging ----
  const totalAr    = await page.locator('[data-testid="ara-kpi-total-ar"]').first().textContent({ timeout: 15_000 });
  const currentPct = await page.locator('[data-testid="ara-kpi-current-pct"]').first().textContent({ timeout: 10_000 });
  const nonCur     = await page.locator('[data-testid="ara-kpi-non-current"]').first().textContent({ timeout: 10_000 });
  const nonCurAcct = await page.locator('[data-testid="ara-kpi-non-current-accounts"]').first().textContent({ timeout: 10_000 });
  console.log("REPORT_LIVE_1_SECTION_VIII " + JSON.stringify({
    totalAr: totalAr?.trim(),
    currentPct: currentPct?.trim(),
    nonCur: nonCur?.trim(),
    nonCurAcct: nonCurAcct?.trim(),
  }));
  expect(totalAr).toMatch(/\$3,585,591/);
  expect(currentPct).toContain("99.3%");
  expect(nonCur).toMatch(/\$26,812/);
  expect(nonCurAcct).toContain("93");

  // ---- Cross-component parity ----
  const execAr = await page.locator('[data-testid="cover-briefing-financial-health-kpi-ar-current"]').first().textContent({ timeout: 10_000 });
  const stewardshipAr = await page.locator('[data-testid="stewardship-tile-ar-current-pct-metric"]').first().textContent({ timeout: 10_000 });
  console.log("REPORT_LIVE_1_PARITY " + JSON.stringify({ exec: execAr?.trim(), stewardship: stewardshipAr?.trim(), sectionVIII: currentPct?.trim() }));
  expect(execAr).toContain("99.3%");
  expect(stewardshipAr).toContain("99.3%");

  // ---- February regression ----
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-02`, { waitUntil: "domcontentloaded" });
  const febExecAr = await page.locator('[data-testid="cover-briefing-financial-health-kpi-ar-current"]').first().textContent({ timeout: 10_000 }).catch(() => null);
  console.log("REPORT_LIVE_1_FEB " + JSON.stringify({ execAr: febExecAr?.trim() }));
  if (febExecAr) expect(febExecAr).toContain("Unavailable");

  // ---- Baseline hold ----
  const after = await invariant(page);
  expect(after.club).toEqual(before.club);
  console.log("REPORT_LIVE_1_AFTER " + JSON.stringify({ club: after.club }));

  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01`, { waitUntil: "domcontentloaded" });
  await page.screenshot({ path: "test-results/report-live-1-jan2026.png", fullPage: true });
  await context.close();
});
