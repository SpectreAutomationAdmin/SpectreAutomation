// GOLF-HIST-1B (2026-10-06) — authenticated Section XI acceptance.
//
// §1  Section XI's Weather Pattern remains LIVE (unchanged from
//     WEATHER-HIST-1 + GOLF-HIST-1).
// §2  Weather vs. Golf Rounds card is now LIVE. KPI ribbon shows a
//     real Period Avg (not "0 rds"), real Best + Worst Condition
//     labels, and total days = 31. The rounds-by-weather bar chart
//     renders four non-zero bars.
// §3  Golf Rounds correlation card narrative is LIVE but its data
//     point value stays "—" pending founder approval of the
//     correlation coefficient's statistical semantic.
// §4  Racquet + Dining cards remain UNAVAILABLE (unchanged).
// §5  Protected baseline unchanged. GolfActivityDay stays at 31.

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";
const COA_BATCH_ID = "cmuni5ymv000k136q3xdyrpmn";
const COULEE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";

async function invariant(page: Page) {
  const r = await page.request.get(`${BASE}/api/admin/coa-batch-diagnostic/${COA_BATCH_ID}`);
  expect(r.ok()).toBe(true);
  return r.json();
}

async function countCommittedGolfBatches(page: Page): Promise<number> {
  const r = await page.request.get(`${BASE}/api/admin/golf-activity-import?clubId=${COULEE_CLUB_ID}`);
  if (!r.ok()) return -1;
  const body = await r.json();
  const batches = (body.batches as Array<{ status: string }>) ?? [];
  return batches.filter((b) => b.status === "COMMITTED").length;
}

runAt("GOLF-HIST-1B · Section XI Weather × Golf LIVE for committed January", async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(ctx);

  const before = await invariant(page);
  console.log("GOLF_HIST_1B_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(2);
  expect(before.club.reportingLedgerSnapshot).toBe(2);
  const committedBefore = await countCommittedGolfBatches(page);
  console.log("GOLF_HIST_1B_COMMITTED_BATCHES " + committedBefore);
  // January was founder-committed before this slice runs, so the
  // staging DB holds >= 1 COMMITTED batch for Coulee.
  expect(committedBefore).toBeGreaterThanOrEqual(1);

  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#weather-and-utilization`, {
    waitUntil: "domcontentloaded",
  });
  await page.locator('[data-testid="weather-and-utilization"]').waitFor({ state: "visible", timeout: 20_000 });
  const chapterText = await page.locator('[data-testid="weather-and-utilization"]').innerText();
  console.log("GOLF_HIST_1B_SECTION_XI_HEAD " + JSON.stringify(chapterText.slice(0, 400)));

  // -- §1 Weather Pattern remains LIVE. -------------------------------
  const patternSubtitle = await page.locator('[data-testid="mws-pattern-card-subtitle"]').innerText();
  expect(patternSubtitle).toMatch(/Drumheller/i);
  expect(patternSubtitle).toMatch(/Alberta/i);

  // -- §2 Rounds-by-weather card is LIVE. -----------------------------
  const roundsCard = await page.locator('[data-testid="mws-rounds-card"]').innerText();
  console.log("GOLF_HIST_1B_ROUNDS_CARD " + JSON.stringify(roundsCard));
  // Period Avg must be a real integer (not "0" and not "—").
  // "N rds" where N > 0.
  const periodAvgMatch = roundsCard.match(/Period\s*avg\s*\n*\s*([-\d]+)\s*rds/i);
  expect(periodAvgMatch, "Period avg KPI not found in rounds card").toBeTruthy();
  const periodAvg = Number(periodAvgMatch![1]);
  console.log("GOLF_HIST_1B_PERIOD_AVG " + periodAvg);
  expect(Number.isFinite(periodAvg)).toBe(true);
  expect(periodAvg).toBeGreaterThan(0);
  // Best / worst condition KPIs must NOT be "—" when the join is live.
  expect(roundsCard).toMatch(/Best\s*condition\s*\n*\s*\d+\s*rds/i);
  expect(roundsCard).toMatch(/Worst\s*condition\s*\n*\s*\d+\s*rds/i);
  // Live insight sentence quotes the total.
  expect(roundsCard).toMatch(/Live Golf Activity|401 rounds/i);
  // Chart UNAVAILABLE sentinel panel is NOT present when join is LIVE.
  await expect(page.locator('[data-testid="mws-rounds-unavailable"]')).toBeHidden();

  // -- §3 Golf correlation card: LIVE narrative + "—" coefficient. ---
  const correlation = await page.locator('[data-testid="mws-correlation"]').innerText();
  console.log("GOLF_HIST_1B_CORRELATION " + JSON.stringify(correlation.slice(0, 600)));
  expect(correlation).toMatch(/Live Weather × Golf join/i);
  expect(correlation).toMatch(/withheld pending founder approval/i);
  // Correlation DATA POINT value: should NOT be a numeric coefficient
  // like "-0.68 (rain vs. rounds)". The card holds it at "—".
  expect(correlation).not.toMatch(/\(rain vs\. rounds\)/i);

  // -- §4 Racquet + Dining stay UNAVAILABLE. --------------------------
  expect(correlation).toMatch(/Racquet booking source[\s\S]*?not yet connected/i);
  expect(correlation).toMatch(/POS source not yet connected/i);

  // -- §5 Baseline unchanged + GolfActivityDay committed unchanged. --
  const after = await invariant(page);
  expect(after.club).toEqual(before.club);
  const committedAfter = await countCommittedGolfBatches(page);
  expect(committedAfter).toBe(committedBefore);

  await page.screenshot({ path: "test-results/golf-hist-1b-section-xi.png", fullPage: true });
  await ctx.close();
});
