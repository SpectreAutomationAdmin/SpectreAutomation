// WEATHER-HIST-1 (2026-10-05) — authenticated staging acceptance.
//
// §1  Section XI renders with dataSource:"live" for Coulee —
//     the chapter does NOT read "Data not available for this
//     reporting period."
// §2  Weather KPI cards populate with LIVE Open-Meteo observations
//     (sunny-days value, rain-days value, °C temperature unit,
//     wind-mph value).
// §3  Weather Pattern donut subtitle names Drumheller, Alberta —
//     from ClubProfile fields, not a hardcoded fingerprint.
// §4  Utilization-dependent cards display explicit UNAVAILABLE
//     sentinels (not fabricated numbers):
//       - rounds-by-weather commentary says "Tee Sheet integration not yet connected"
//       - Golf Rounds correlation card says "Tee Sheet"
//       - Racquet correlation card says "Racquet booking source"
//       - Dining & F&B correlation card says "POS source"
// §5  Protected baseline unchanged (Account=562, JournalEntry=0,
//     ReportingLedgerBatch=2, ReportingLedgerSnapshot=2).

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

runAt("WEATHER-HIST-1 · Section XI live weather + partial availability", async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(ctx);

  const before = await invariant(page);
  console.log("WEATHER_HIST_1_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(2);
  expect(before.club.reportingLedgerSnapshot).toBe(2);

  // -- Navigate to Section XI (Monthly Weather Summary). --
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#weather-and-utilization`, {
    waitUntil: "domcontentloaded",
  });
  await page.locator('[data-testid="weather-and-utilization"]').waitFor({ state: "visible", timeout: 20_000 });

  // -- §1 Chapter must NOT render as unavailable. --
  const chapterSlice = await page.locator('[data-testid="weather-and-utilization"]').innerText();
  console.log("WEATHER_HIST_1_SECTION_XI_HEAD " + JSON.stringify(chapterSlice.slice(0, 400)));
  expect(chapterSlice).not.toContain("Data not available for this reporting period.");

  // -- §2 Weather KPI cards must carry LIVE values. --
  const kpiGrid = page.locator('[data-testid="mws-kpi-grid"]');
  await expect(kpiGrid).toBeVisible();
  const kpiText = await kpiGrid.innerText();
  console.log("WEATHER_HIST_1_KPI " + JSON.stringify(kpiText));
  // KPI labels render with CSS text-transform: uppercase, so innerText
  // returns them in all caps.
  expect(kpiText).toMatch(/sunny days/i);
  expect(kpiText).toMatch(/rain days/i);
  expect(kpiText).toMatch(/avg high temp/i);
  expect(kpiText).toMatch(/avg wind speed/i);
  // °C temperature unit (Alberta tenant) — not °F. Open-Meteo historical
  // January in Drumheller may well be sub-zero so the match allows for
  // negative values.
  expect(kpiText).toMatch(/-?\d+°C/);
  expect(kpiText).not.toMatch(/\d+°F/);
  // Wind speed should be a numeric mph value.
  expect(kpiText).toMatch(/\d+\s*mph/);

  // -- §3 Pattern donut subtitle names Drumheller, Alberta. --
  const patternSubtitle = await page.locator('[data-testid="mws-pattern-card-subtitle"]').innerText();
  console.log("WEATHER_HIST_1_PATTERN_SUBTITLE " + JSON.stringify(patternSubtitle));
  expect(patternSubtitle).toMatch(/Drumheller/i);
  expect(patternSubtitle).toMatch(/Alberta/i);

  // -- §4 Utilization-dependent cards display explicit UNAVAILABLE. --
  expect(chapterSlice).toMatch(/Rounds-by-weather analysis unavailable|Tee Sheet integration not yet connected/i);
  // Golf Rounds correlation names Tee Sheet.
  expect(chapterSlice).toMatch(/Tee Sheet integration not yet connected/);
  // Racquet correlation names the booking source.
  expect(chapterSlice).toMatch(/Racquet booking source[\s\S]*?not yet connected/i);
  // Dining & F&B correlation names POS.
  expect(chapterSlice).toMatch(/POS source not yet connected/);

  // -- Baseline unchanged. --
  const after = await invariant(page);
  expect(after.club).toEqual(before.club);

  await page.screenshot({ path: "test-results/weather-hist-1-section-xi.png", fullPage: true });
  await ctx.close();
});
