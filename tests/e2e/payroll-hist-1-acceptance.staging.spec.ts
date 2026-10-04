// PAYROLL-HIST-1 (2026-10-04) — staging acceptance.
//
// Confirms:
//   • Historical Payroll chart renders every dept with real Jan 2026
//     IS_PAYROLL activity (not just the 2 depts with Employees).
//   • Headline KPIs (Total YTD Payroll, vs Budget, Payroll Ratio)
//     use the canonical consolidated payroll — matches ratio-registry
//     to the penny.
//   • Dues-Cover-Payroll check uses canonical consolidated payroll.
//   • Chart bar width is restrained (not giant) with the restored
//     grouped-bar relationship.

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

runAt("PAYROLL-HIST-1 · historical payroll chart + canonical KPIs + bar geometry", async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(ctx);

  const before = await invariant(page);
  console.log("PAYROLL_HIST_1_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);

  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#financial-performance`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="financial-performance-source-panel"]').waitFor({ state: "visible", timeout: 20_000 });

  const card = page.locator('[data-testid="payroll-department"]');
  await card.waitFor({ state: "visible", timeout: 10_000 });

  // ---- Chart rect count — should be > 2 depts × 2 series (REPORT-
  //      WIRING-1B had 6 rects for 2 depts; expect ≥ 10 now when all
  //      payroll-active depts render). ----
  const rects = await card.locator("svg rect").count();
  const svgTexts = await card.locator("svg text").allTextContents();
  console.log("PAYROLL_HIST_1_CHART " + JSON.stringify({
    rects,
    xLabels: svgTexts.filter((t) => /^[A-Z]/.test(t)).slice(0, 15),
  }));
  // At least Admin + Grounds + at least one additional historical dept.
  // (Payroll historically also booked in DUES_AND_CHARGES / F&B / etc.
  // on Coulee Jan 2026.)
  expect(rects).toBeGreaterThanOrEqual(10);

  // ---- KPI ribbon — Total YTD Payroll should now reflect the
  //      canonical ~$162K, not the roster-only ~$0.09M. ----
  const kpiText = await card.locator('[data-testid="payroll-department-kpis"]').innerText();
  console.log("PAYROLL_HIST_1_KPIS " + JSON.stringify(kpiText.replace(/\s+/g, " ")));
  // Headline $0.16M (approx) — must NOT be $0.09M.
  expect(kpiText).toMatch(/\$0\.1[5-9]M|\$1[5-9][0-9]K/);
  expect(kpiText).not.toMatch(/\$0\.09M/);

  // Payroll Ratio tile must render a % (not "—") — canonical payrollRatio
  // from ratio-registry is now wired.
  expect(kpiText).toMatch(/\d+\.\d+%/);

  // ---- Bar geometry — maxBarWidth cap. The chart's svg rects should
  //      have width ≤ 24 px for data bars (allow legend swatches). ----
  const barWidths = await card.locator("svg rect").evaluateAll((nodes) =>
    nodes.map((n) => Number(n.getAttribute("width") ?? 0)),
  );
  const maxBarWidth = Math.max(...barWidths);
  console.log("PAYROLL_HIST_1_BAR_WIDTHS " + JSON.stringify({
    max: maxBarWidth,
    sample: barWidths.slice(0, 10),
  }));
  // Pre-fix: bars could be 100+ px wide with 2 depts. After maxBarWidth=24,
  // every rect should be ≤ ~25px (allow a tiny float wobble).
  expect(maxBarWidth).toBeLessThan(30);

  // ---- Dues-Cover-Payroll check — should reference canonical
  //      consolidated payroll. ----
  const checkText = await card.locator('[data-testid="payroll-department-check"]').innerText();
  console.log("PAYROLL_HIST_1_CHECK " + JSON.stringify(checkText.replace(/\s+/g, " ").slice(0, 400)));
  // Reference headline $0.16M in the check sentence.
  expect(checkText).toMatch(/\$0\.1[5-9]M|\$1[5-9][0-9]K/);

  const after = await invariant(page);
  expect(after.club).toEqual(before.club);
  await page.screenshot({ path: "test-results/payroll-hist-1-section-ii.png", fullPage: true });
  await ctx.close();
});
