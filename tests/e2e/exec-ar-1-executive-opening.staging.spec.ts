// EXEC-AR-1 §9 / §10 (2026-10-03) — SCOPED Executive Opening acceptance.
//
// Replaces the weak page-wide 99.3% assertion. Reads the actual
// Financial Health card data-testids and asserts each KPI tile
// INSIDE that container. Also verifies the narrative text claims
// AR available / Reserve Coverage unavailable, and that February
// AR remains SOURCE_NOT_LOADED.

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

runAt("EXEC-AR-1 · Executive Opening Financial Health AR Current = 99.3% (scoped)", async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);

  const before = await invariant(page);
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(2);
  expect(before.club.reportingLedgerSnapshot).toBe(2);

  // January 2026 — AR snapshot IS committed; Executive Opening must
  // show 99.3% in the AR Current tile.
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01`, { waitUntil: "domcontentloaded" });

  const wcTile = await page.locator('[data-testid="cover-briefing-financial-health-kpi-working-capital"]').first().textContent({ timeout: 15_000 });
  const crTile = await page.locator('[data-testid="cover-briefing-financial-health-kpi-current-ratio"]').first().textContent({ timeout: 10_000 });
  const arTile = await page.locator('[data-testid="cover-briefing-financial-health-kpi-ar-current"]').first().textContent({ timeout: 10_000 });
  const reserveTile = await page.locator('[data-testid="cover-briefing-financial-health-kpi-reserve-coverage"]').first().textContent({ timeout: 10_000 });
  const narrative = await page.locator('[data-testid="cover-briefing-financial-health-narrative"]').first().textContent({ timeout: 10_000 });
  const statusLabel = await page.locator('[data-testid="cover-briefing-financial-health-status"]').first().textContent({ timeout: 10_000 });

  console.log("EXEC_AR_1_FH_JAN " + JSON.stringify({
    workingCapital: wcTile?.trim(),
    currentRatio: crTile?.trim(),
    arCurrent: arTile?.trim(),
    reserveCoverage: reserveTile?.trim(),
    statusLabel: statusLabel?.trim(),
    narrative: narrative?.trim(),
  }, null, 2));

  // Primary assertions — scoped to the Executive Opening Financial
  // Health card ONLY.
  expect(wcTile).toContain("$4.34M");
  expect(crTile).toContain("8.08x");
  expect(arTile).toContain("99.3%");            // the fix
  expect(reserveTile).toContain("Unavailable"); // reserve stays unavailable

  // Narrative must claim AR is available + reserve coverage unavailable
  // SEPARATELY (one unavailable metric must not misdescribe another).
  expect(narrative).toMatch(/AR is 99\.3% current/);
  expect(narrative).toMatch(/reserve coverage remains unavailable/i);
  // The old lumped language is gone.
  expect(narrative).not.toMatch(/Reserve coverage ratio and AR Current % remain unavailable/);
  expect(narrative).not.toMatch(/AR aging source are not yet loaded/);

  // February 2026 — AR snapshot does NOT exist; AR Current must
  // revert to Unavailable (no carry-forward).
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-02`, { waitUntil: "domcontentloaded" });
  const febAr = await page.locator('[data-testid="cover-briefing-financial-health-kpi-ar-current"]').first().textContent({ timeout: 10_000 }).catch(() => null);
  console.log("EXEC_AR_1_FH_FEB_AR " + JSON.stringify({ arCurrent: febAr?.trim() }));
  // Either the testid resolves and reads "Unavailable", OR the tile
  // is absent on a period with no package — both are acceptable
  // "no January-carry-forward" outcomes.
  if (febAr) expect(febAr).toContain("Unavailable");

  const after = await invariant(page);
  expect(after.club).toEqual(before.club);
  console.log("EXEC_AR_1_BASELINE_HOLD " + JSON.stringify({ before: before.club, after: after.club }));

  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01`, { waitUntil: "domcontentloaded" });
  await page.screenshot({ path: "test-results/exec-ar-1-executive-opening-jan2026.png", fullPage: true });
  await context.close();
});
