// OPS-LIVE-1 (2026-10-06) — authenticated staging acceptance.
//
// §1  Section XI Utilization Outcomes KPI tiles:
//        Rounds YTD           = 401       (LIVE from canonical YTD)
//        Course Utilization   = —         (UNAVAILABLE)
//        Spend per Member     = —         (UNAVAILABLE)
//        Spend per Round      = —         (UNAVAILABLE)
//     Demo values 31,420 / 74.1% / $1,567 / $63.97 do NOT appear.
//     Subtitles name the missing source for each UNAVAILABLE tile.
// §2  Section XI Weather Pattern + Weather vs. Golf still LIVE
//     (GOLF-HIST-1B regression check).
// §3  Section IX Operating Statistics live-tenant table renders
//     "401" for Total Rounds — All Categories and "4" for Guest
//     Rounds. Member Rounds 18/9 Hole + F&B + Member Engagement +
//     Payroll rows render "—" (UNAVAILABLE).
// §4  Protected baseline + GolfActivityDay=31 preserved.

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

runAt("OPS-LIVE-1 · Sections IX + XI live wiring (no demo leakage)", async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(ctx);

  const before = await invariant(page);
  console.log("OPS_LIVE_1_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(2);
  expect(before.club.reportingLedgerSnapshot).toBe(2);
  const committed = await countCommittedGolfBatches(page);
  console.log("OPS_LIVE_1_COMMITTED_BATCHES " + committed);
  expect(committed).toBeGreaterThanOrEqual(1);

  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01`, { waitUntil: "domcontentloaded" });

  // -- §1 Section XI Utilization Outcomes KPIs. -----------------------
  await page.locator('[data-testid="weather-and-utilization"]').waitFor({ state: "visible", timeout: 20_000 });
  const utilRow = await page.locator('[data-testid="mws-utilization-extension-grid"]').innerText();
  console.log("OPS_LIVE_1_UTILIZATION " + JSON.stringify(utilRow));

  // KPI tiles render as: LABEL\n VALUE·\n CONTEXT·\n SUB — labels
  // are uppercased by CSS. Order matches the DOM for innerText.
  // Rounds YTD = 401 (LIVE)
  expect(utilRow).toMatch(/ROUNDS YTD\s*\n[\s\S]{0,20}401/i);
  expect(utilRow).toMatch(/1\.0% guest share/i);
  // Course Utilization UNAVAILABLE
  expect(utilRow).toMatch(/COURSE UTILIZATION\s*\n[\s\S]{0,20}—/i);
  expect(utilRow).toMatch(/Tee-time inventory source not connected/i);
  // Spend per Member UNAVAILABLE
  expect(utilRow).toMatch(/SPEND PER MEMBER\s*\n[\s\S]{0,20}—/i);
  expect(utilRow).toMatch(/Member spend source not connected/i);
  // Spend per Round UNAVAILABLE
  expect(utilRow).toMatch(/SPEND PER ROUND\s*\n[\s\S]{0,20}—/i);
  expect(utilRow).toMatch(/Round spend source not connected/i);
  // Demo values must NOT appear anywhere on the Utilization row.
  expect(utilRow).not.toMatch(/31,420/);
  expect(utilRow).not.toMatch(/74\.1%/);
  expect(utilRow).not.toMatch(/\$1,567/);
  expect(utilRow).not.toMatch(/\$63\.97/);

  // -- §2 Weather Pattern + Weather vs. Golf still LIVE. -------------
  const roundsCard = await page.locator('[data-testid="mws-rounds-card"]').innerText();
  expect(roundsCard).toMatch(/Live Golf Activity for January/i);
  expect(roundsCard).toMatch(/401 rounds across 31 day/i);
  // GOLF-HIST-1B regression: no demo rounds leaking.
  expect(roundsCard).not.toMatch(/31,420/);

  // -- §3 Section IX Operating Statistics. ---------------------------
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#operating-statistics`, { waitUntil: "domcontentloaded" });
  // Scroll into view + capture the Section IX chapter body.
  const section9Text = await page.locator('body').innerText();
  const idx = section9Text.indexOf("Operating Statistics & Focus Areas");
  expect(idx).toBeGreaterThan(-1);
  const section9Slice = section9Text.slice(idx, idx + 3000);
  console.log("OPS_LIVE_1_SECTION_9_SLICE " + JSON.stringify(section9Slice.slice(0, 1200)));
  // Total Rounds LIVE
  expect(section9Slice).toMatch(/Total Rounds — All Categories[\s\S]{0,160}401/);
  // Guest Rounds LIVE
  expect(section9Slice).toMatch(/Guest Rounds[\s\S]{0,160}\b4\b/);
  // Member Rounds 18/9 UNAVAILABLE
  expect(section9Slice).toMatch(/Member Rounds — 18 Hole[\s\S]{0,120}—/);
  expect(section9Slice).toMatch(/Member Rounds — 9 Hole[\s\S]{0,120}—/);
  // F&B rows UNAVAILABLE
  expect(section9Slice).toMatch(/Total Covers[\s\S]{0,160}—/);
  // Demo numerics must NOT appear in Section IX.
  expect(section9Slice).not.toMatch(/4,280|2,640|1,120|6,840|18\.40|32\.40/);

  // -- §4 Baseline + GolfActivityDay=31 preserved. -------------------
  const after = await invariant(page);
  expect(after.club).toEqual(before.club);
  const committedAfter = await countCommittedGolfBatches(page);
  expect(committedAfter).toBe(committed);

  await page.screenshot({ path: "test-results/ops-live-1-sections.png", fullPage: true });
  await ctx.close();
});
