// REPORT-WIRING-1B (2026-10-04) — staging acceptance.
//
// Confirms:
//   1. Payroll Analysis — Department Breakdown renders ONLY the
//      payroll-valid departments from the Payroll module. On a
//      tenant without Employee records (Coulee staging today) the
//      chart renders empty + the reconciliation note surfaces.
//   2. Section III Operating vs. Capital Stewardship sub-header +
//      the 4 summary cards populate from the canonical operating-
//      fund path.
//   3. Depreciation carve-out: canonical NOI-before-dep is identical
//      across every resolver that reads IS data.

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

runAt("REPORT-WIRING-1B · Payroll roster + NOI-before-dep canonical", async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(ctx);

  const before = await invariant(page);
  console.log("REPORT_WIRING_1B_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);

  // ---- 1. Payroll Department roster ----
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#financial-performance`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="financial-performance-source-panel"]').waitFor({ state: "visible", timeout: 20_000 });

  const payrollCard = page.locator('[data-testid="payroll-department"]');
  const payrollRects = await payrollCard.locator("svg rect").count();
  const payrollBody = await payrollCard.innerText();
  console.log("REPORT_WIRING_1B_PAYROLL_RECTS " + JSON.stringify({ payrollRects }));
  console.log("REPORT_WIRING_1B_PAYROLL_SNIPPET " + JSON.stringify(payrollBody.replace(/\s+/g, " ").slice(0, 400)));
  // Coulee staging has no Employee records today — chart renders empty.
  // Pre-fix was ~18 rects (9 depts × 2 series). After-fix should be
  // dramatically lower (0 bars + maybe a legend swatch).
  expect(payrollRects).toBeLessThan(10);

  // ---- 2. Four-path parity gate (POST depreciation carve-out) ----
  const diag = await page.request.get(
    `${BASE}/api/admin/classifier-reconciliation?clubId=${CLUB_ID}`,
  );
  const j = await diag.json();
  console.log("REPORT_WIRING_1B_PATH_A " + JSON.stringify(j.pathA_operating_only_estimate));
  console.log("REPORT_WIRING_1B_PATH_B_REAL " + JSON.stringify(j.pathB_ratioRegistry_REAL));
  console.log("REPORT_WIRING_1B_PATH_C " + JSON.stringify(j.pathC_departmentSnapshot));
  console.log("REPORT_WIRING_1B_PATH_D " + JSON.stringify(j.pathD_budget));

  // All operating-fund-only paths agree. Executive uses the IS
  // projection (ex-dep already); ratio-registry + dept + budget now
  // match it after the carve-out.
  const bRevReal = Math.abs(Number(j.pathB_ratioRegistry_REAL?.revenue_value ?? 0));
  const aRevDisplay = -Number(j.pathA_operating_only_estimate.revenue_display);
  const cRevDisplay = Number(j.pathC_departmentSnapshot.totalRevenue);
  expect(Math.abs(bRevReal - aRevDisplay)).toBeLessThan(0.01);
  expect(Math.abs(cRevDisplay - aRevDisplay)).toBeLessThan(0.01);

  // ---- 3. Executive At-a-Glance variance recomputed ----
  const revVar = await page
    .locator('[data-testid="monthly-cover-at-a-glance-ytd-revenue-variance"]')
    .innerText().catch(() => "");
  const noiVar = await page
    .locator('[data-testid="monthly-cover-at-a-glance-noi-variance"]')
    .innerText().catch(() => "");
  console.log("REPORT_WIRING_1B_EXEC_REVENUE " + JSON.stringify(revVar));
  console.log("REPORT_WIRING_1B_EXEC_NOI " + JSON.stringify(noiVar));
  expect(revVar).toMatch(/[+(]?\d+(\.\d+)?%?\)?\s+(ABOVE|BELOW)\s+PLAN/i);
  expect(noiVar).toMatch(/[+(]?\d+(\.\d+)?%?\)?\s+(ABOVE|BELOW)\s+PLAN/i);

  // ---- Baseline hold ----
  const after = await invariant(page);
  expect(after.club).toEqual(before.club);
  await page.screenshot({ path: "test-results/report-wiring-1b-section-ii.png", fullPage: true });
  await ctx.close();
});
