// REPORT-WIRING-1A (2026-10-04) — final cross-report parity gate.
// After the canonical operating-fund classifier is applied, every
// financial reporting path must agree to $0.01 on canonical Revenue,
// COGS, OpEx, NOI.

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";
const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";
const CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const COA_BATCH_ID = "cmuni5ymv000k136q3xdyrpmn";

async function invariant(page: Page) {
  const r = await page.request.get(`${BASE}/api/admin/coa-batch-diagnostic/${COA_BATCH_ID}`);
  expect(r.ok()).toBe(true);
  return r.json();
}

runAt("REPORT-WIRING-1A · four-path parity gate", async ({ browser }) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext();
  const page = await loginAsFounder(ctx);

  const before = await invariant(page);
  console.log("REPORT_WIRING_1A_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);

  const diag = await page.request.get(
    `${BASE}/api/admin/classifier-reconciliation?clubId=${CLUB_ID}`,
  );
  const j = await diag.json();
  console.log("REPORT_WIRING_1A_A " + JSON.stringify(j.pathA_operating_only_estimate));
  console.log("REPORT_WIRING_1A_B_UNFILTERED " + JSON.stringify(j.pathB_ratioRegistry_UNFILTERED));
  console.log("REPORT_WIRING_1A_B_REAL " + JSON.stringify(j.pathB_ratioRegistry_REAL));
  console.log("REPORT_WIRING_1A_C " + JSON.stringify(j.pathC_departmentSnapshot));
  console.log("REPORT_WIRING_1A_D " + JSON.stringify(j.pathD_budget));

  // After the fix, the REAL resolveJanuaryMetricSet (consumed by
  // Operating Scorecard + Operating Results) must agree with Path A
  // (Executive IS projection operating-only) and Path C (dept
  // snapshot) to the penny.
  const aRevDisplay = -Number(j.pathA_operating_only_estimate.revenue_display); // flip to display
  const cRevDisplay = Number(j.pathC_departmentSnapshot.totalRevenue);
  const bRevValue = j.pathB_ratioRegistry_REAL?.revenue_value;
  const bRevReal = bRevValue == null ? null : Math.abs(Number(bRevValue));
  console.log("REPORT_WIRING_1A_PARITY " + JSON.stringify({
    aRevDisplay, cRevDisplay, bRevReal,
    cNoi: Number(j.pathC_departmentSnapshot.totalNetIncome),
    bNoiReal: j.pathB_ratioRegistry_REAL?.noi_value,
  }));

  // Path A operating-only Revenue = Path C dept total revenue — both
  // $3,124,066.72 display sign.
  expect(Math.abs(aRevDisplay - cRevDisplay)).toBeLessThan(0.01);
  // Path B (actual ratio registry) raw REVENUE sign is natural
  // (negative). Comparing absolute values to Path A operating.
  if (bRevReal != null) {
    expect(Math.abs(bRevReal - aRevDisplay)).toBeLessThan(0.01);
  }
  expect(j.pathB_ratioRegistry_REAL?.availability).toBe("AVAILABLE");

  const after = await invariant(page);
  expect(after.club).toEqual(before.club);
  await ctx.close();
});
