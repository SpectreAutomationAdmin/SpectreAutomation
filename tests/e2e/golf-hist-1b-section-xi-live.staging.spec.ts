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
  // The KPI labels + values render as uppercase chrome; innerText
  // interleaves label and value with newlines. We just assert that:
  //   (a) the live commentary mentions the 401 total + 31 days (proof
  //       the live join is active, not the UNAVAILABLE sentinel),
  //   (b) the Period Avg KPI does NOT render as "— rds" or "0 rds"
  //       (proof of the Zero ≠ UNAVAILABLE fix),
  //   (c) no "— rds" appears anywhere in the card (same proof applied
  //       to Best + Worst condition KPIs).
  expect(roundsCard).toMatch(/Live Golf Activity for January/i);
  expect(roundsCard).toMatch(/401 rounds across 31 day/i);
  expect(roundsCard).toMatch(/average 13 rounds\/day/i);
  // GOLF-HIST-1B §G — the Period Avg KPI must now use the
  // authoritative weighted value (401/31 ≈ 13), not the unweighted
  // mean of per-condition averages. Verify "13 rds" appears next
  // to the PERIOD AVG label.
  expect(roundsCard).toMatch(/13 rds\s*\n*\s*PERIOD AVG/i);
  expect(roundsCard).not.toMatch(/—\s*rds/);
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
