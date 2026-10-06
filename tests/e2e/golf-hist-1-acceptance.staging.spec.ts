// GOLF-HIST-1 (2026-10-05) — authenticated staging acceptance.
//
// §1  Importer page loads at /app/admin/imports/golf-activity and
//     exposes the Upload form + the (empty-state) history section.
// §2  Section XI still presents the Rounds-by-Weather chart as
//     UNAVAILABLE because no Golf Activity has been committed yet —
//     the Playwright run does NOT upload or commit anything.
// §3  Weather KPIs + Pattern donut remain LIVE (WEATHER-HIST-1).
// §4  Protected baseline unchanged.

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";
const COA_BATCH_ID = "cmuni5ymv000k136q3xdyrpmn";

async function invariant(page: Page) {
  const r = await page.request.get(`${BASE}/api/admin/coa-batch-diagnostic/${COA_BATCH_ID}`);
  expect(r.ok()).toBe(true);
  return r.json();
}

runAt("GOLF-HIST-1 · Importer scaffolding live; Section XI golf still unavailable", async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(ctx);

  const before = await invariant(page);
  console.log("GOLF_HIST_1_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(2);
  expect(before.club.reportingLedgerSnapshot).toBe(2);

  // -- §1 Importer page loads. ----------------------------------------
  await page.goto(`${BASE}/app/admin/imports/golf-activity`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="golf-activity-import-header"]').waitFor({ state: "visible", timeout: 20_000 });
  const importerText = await page.locator('body').innerText();
  console.log("GOLF_HIST_1_IMPORTER_HEAD " + JSON.stringify(importerText.slice(0, 300)));
  expect(importerText).toMatch(/Golf Activity import/i);
  expect(importerText).toMatch(/GGGolf Daily Report PDF/i);
  // The upload form must be present but we DO NOT upload — the
  // founder performs the first real commit.
  await expect(page.locator('[data-testid="golf-activity-import-form"]')).toBeVisible();
  await expect(page.locator('[data-testid="golf-activity-import-file"]')).toBeVisible();
  // History renders as empty state (no batches yet).
  const historyText = await page.locator('[data-testid="golf-activity-import-history"]').innerText();
  console.log("GOLF_HIST_1_IMPORTER_HISTORY " + JSON.stringify(historyText.slice(0, 400)));

  // -- §2 Section XI golf cards remain UNAVAILABLE. --------------------
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#weather-and-utilization`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="weather-and-utilization"]').waitFor({ state: "visible", timeout: 20_000 });
  const chapterText = await page.locator('[data-testid="weather-and-utilization"]').innerText();
  console.log("GOLF_HIST_1_SECTION_XI_HEAD " + JSON.stringify(chapterText.slice(0, 400)));

  // Section XI chapter must still render (not "Data not available for this reporting period.").
  expect(chapterText).not.toContain("Data not available for this reporting period.");

  // The rounds-by-weather card's commentary must announce the Golf
  // Activity source is not yet connected.
  expect(chapterText).toMatch(/Rounds-by-weather analysis unavailable|Golf Activity source not yet/i);
  // Racquet + Dining stay UNAVAILABLE (unchanged).
  expect(chapterText).toMatch(/Racquet booking source[\s\S]*?not yet connected/i);
  expect(chapterText).toMatch(/POS source not yet connected/i);

  // -- §3 Weather KPIs still LIVE. ------------------------------------
  const kpiText = await page.locator('[data-testid="mws-kpi-grid"]').innerText();
  console.log("GOLF_HIST_1_KPI " + JSON.stringify(kpiText));
  expect(kpiText).toMatch(/sunny days/i);
  expect(kpiText).toMatch(/avg wind speed/i);
  expect(kpiText).toMatch(/-?\d+°C/);

  // Pattern donut subtitle still names Drumheller, Alberta.
  const patternSubtitle = await page.locator('[data-testid="mws-pattern-card-subtitle"]').innerText();
  expect(patternSubtitle).toMatch(/Drumheller/i);
  expect(patternSubtitle).toMatch(/Alberta/i);

  // -- §4 Protected baseline unchanged. --------------------------------
  const after = await invariant(page);
  expect(after.club).toEqual(before.club);

  await page.screenshot({ path: "test-results/golf-hist-1-section-xi.png", fullPage: true });
  await ctx.close();
});
