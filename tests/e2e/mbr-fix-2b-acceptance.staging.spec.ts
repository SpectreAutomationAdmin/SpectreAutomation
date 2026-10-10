// MBR-FIX-2B — AFTER acceptance on live staging.
//
// Verifies that the Executive Operations briefing on
// /app/admin/reporting/monthly?period=2026-02 now shows:
//   • Real Revenue (not Unavailable)
//   • Real NOI Before Depreciation (not Unavailable)
//   • Real Budget variance in the narrative
//   • The stale "Budget comparison is unavailable — no budget source
//     has been loaded for this tenant" sentence is gone
// And that period=2026-01 keeps the same shape (regression guard).

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

async function captureOps(page: Page, periodQuery: string, label: string) {
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=${periodQuery}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  // Operations briefing card — find by heading text (layout-stable).
  const briefing = page.locator('text=Are we operating successfully?').first();
  await briefing.waitFor({ state: "attached", timeout: 20_000 });
  const card = briefing.locator('xpath=ancestor::*[self::section or self::div][2]');
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const txt = (await card.innerText()).replace(/\s+/g, " ").trim();
  await card.screenshot({ path: `test-results/mbr-fix-2b-ops-${label}.png` });
  return txt;
}

runAt("MBR-FIX-2B · AFTER · Feb 2026 Executive Operations renders real numbers", async ({ browser }) => {
  test.setTimeout(300_000);
  const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
  const page = await loginAsFounder(ctx);

  const txt = await captureOps(page, "2026-02", "feb-after");
  console.log("MBR_FIX_2B_FEB_AFTER " + txt.slice(0, 1500));

  // Stale sentence must be gone.
  expect(txt).not.toContain("Budget comparison is unavailable — no budget source has been loaded for this tenant.");

  // Real values present.
  expect(txt).toMatch(/Operating revenue \(fiscal YTD\) totals/);
  expect(txt).toMatch(/NOI before depreciation/);
  expect(txt).toMatch(/\$3\.2[12]M|\$3,215,124\.73/); // Rev around $3.21M
  // NOI around $2.54M.
  expect(txt).toMatch(/\$2\.5[34]M|\$2,539,292/);

  // Reactive budget variance sentences.
  expect(txt).toMatch(/Revenue variance/i);
  expect(txt).toMatch(/NOI variance/i);
  // Reference Budget $4.18M (revenue budget YTD) OR $1.83M (NOI budget YTD).
  expect(txt).toMatch(/Budget of \$[14]\.[0-9]+M/);

  await ctx.close();
});

runAt("MBR-FIX-2B · AFTER · Jan 2026 regression guard", async ({ browser }) => {
  test.setTimeout(300_000);
  const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
  const page = await loginAsFounder(ctx);

  const txt = await captureOps(page, "2026-01", "jan-after");
  console.log("MBR_FIX_2B_JAN_AFTER " + txt.slice(0, 1500));

  expect(txt).not.toContain("Budget comparison is unavailable — no budget source has been loaded for this tenant.");
  expect(txt).toMatch(/Operating revenue \(fiscal YTD\) totals/);
  // Jan Rev ~$3.12M, NOI ~$2.82M.
  expect(txt).toMatch(/\$3\.1[12]M|\$3,124,066/);
  expect(txt).toMatch(/\$2\.8[12]M|\$2,819,873/);

  await ctx.close();
});
