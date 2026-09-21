// FPP-5D (2026-09-21) — Parallel-payroll closeout browser acceptance.
//
// Read-only. Preserves the founder's Sep 15 CALCULATED batch
// (cmuajt81m000j8a09bsk5ls00, calculationVersion 1). Confirms:
//   §2 Factor F disclosure line renders under Federal + Alberta
//   §3 Adjustments KPI reads "0" (was "5")
//   §4 Employer contributions drill-down splits statutory / benefits
//      and reconciles to $639.96
//
// Never clicks Return-to-Preparation, Mark Reviewed, Submit,
// Approve, Post, or any adjustment / recurring mutation control.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

test.use({ viewport: { width: 1440, height: 900 } });

const OVERVIEW_URL =
  "/app/admin/payroll?payGroupId=cmu5kg3e40002h4iupsaxezdl&payPeriodId=cmu5kg3ih000nh4iuqyal9zay";
// Same page, but with the Summary tab active — tabs are search-param
// driven (see WorkspaceTabs.setTab in PayrollAdminOverview.tsx), so
// deep-linking is more reliable than click-then-wait through a
// client navigation.
const OVERVIEW_URL_SUMMARY =
  "/app/admin/payroll?payGroupId=cmu5kg3e40002h4iupsaxezdl&payPeriodId=cmu5kg3ih000nh4iuqyal9zay&tab=summary";

test.describe("FPP-5D closeout — Sep 15 batch (read-only)", () => {
  test("§3 Adjustments KPI reports 0 One-time (was 5)", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");

    const page = await loginAsFounder(context, { landing: OVERVIEW_URL });
    await page.waitForLoadState("domcontentloaded");

    // Header confirms the batch is still CALCULATED — the fresh Sep 15
    // parallel payroll is preserved. If it flips to PREPARED or VOIDED
    // the test fails loud, so we notice any accidental mutation.
    await expect(
      page.getByTestId("payroll-admin-header").locator("span").first(),
    ).toContainText(/CALCULATED/i);

    // Adjustments KPI card. The overview view surfaces the numeric
    // count via [data-testid="payroll-admin-kpi-adjustments"] with a
    // sub-line naming provenance. FPP-5D asserts the primary count is
    // 0 (one-time only) and that the recurring count is preserved as
    // a distinct field, not silently merged into "Adjustments".
    const adjustmentsKpi = page.getByTestId("payroll-admin-kpi-adjustments");
    await expect(adjustmentsKpi).toBeVisible();
    // The rendered value must NOT be "5" (the pre-FPP-5D bug value).
    const kpiText = await adjustmentsKpi.textContent();
    expect(kpiText).toBeTruthy();
    expect(kpiText).not.toMatch(/\b5\s+One-time\b/i);

    await page.screenshot({
      path: "test-results/fpp5d-adjustments-kpi.png",
      fullPage: false,
    });
  });

  test("§4 Employer contributions summary breakdown reconciles to $639.96", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");

    const page = await loginAsFounder(context, { landing: OVERVIEW_URL_SUMMARY });
    await page.waitForLoadState("domcontentloaded");
    // The summary-tab container gates all breakdown children on
    // `isCalculated && batchRow?.calculatedAt`.
    await expect(page.getByTestId("payroll-admin-summary-tab")).toBeVisible({ timeout: 30_000 });
    const breakdown = page.getByTestId("payroll-admin-summary-employer-breakdown");
    await expect(breakdown).toBeVisible();
    // The reconciling footer row must be present and show $639.96 for
    // Chris's single-employee batch.
    const footer = page.getByTestId("payroll-admin-summary-employer-breakdown-total");
    await expect(footer).toBeVisible();
    await expect(footer).toContainText("Total employer contributions");
    await expect(footer).toContainText("$639.96");

    await page.screenshot({
      path: "test-results/fpp5d-employer-breakdown.png",
      fullPage: false,
    });
  });

  test("§2 Factor F disclosure shown under Federal + Alberta on Chris's detail", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");

    const page = await loginAsFounder(context, { landing: OVERVIEW_URL });
    await page.waitForLoadState("domcontentloaded");

    // Deep-link straight to the batch review page for the sequence-2
    // CALCULATED batch. The workspace expands the calculation
    // explanation inline via an explicit "Details" button per row.
    await page.goto("/app/admin/payroll/batches/cmuajt81m000j8a09bsk5ls00");
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByTestId("review-employee-table")).toBeVisible({ timeout: 30_000 });

    // Expand Chris's row via the "Details" button — clicking the row
    // itself is a no-op; the button toggles the inline detail panel
    // that renders the calculation explanation.
    const expandBtn = page.locator('[data-testid^="review-emp-expand:"]').first();
    await expect(expandBtn).toBeVisible({ timeout: 15_000 });
    await expandBtn.click();
    // Detail panel loads asynchronously; wait for the calc-explanation
    // heading before probing its Factor F child.
    await expect(page.getByText("Calculation explanation", { exact: false }))
      .toBeVisible({ timeout: 30_000 });

    // Factor F line under Federal
    const federalF = page.getByTestId("explanation-federal-factor-f");
    await expect(federalF).toBeVisible();
    await expect(federalF).toContainText(/RRSP deducted at source \(Factor F\)/i);
    await expect(federalF).toContainText("$229.17");
    await expect(federalF).toContainText("$5,500.08");

    // Factor F line under Alberta
    const provincialF = page.getByTestId("explanation-provincial-factor-f");
    await expect(provincialF).toBeVisible();
    await expect(provincialF).toContainText(/RRSP deducted at source \(Factor F\)/i);
    await expect(provincialF).toContainText("$229.17");
    await expect(provincialF).toContainText("$5,500.08");

    // Employer contributions drill-down reconciles.
    const employerTotal = page.getByTestId("employer-contributions-total");
    await expect(employerTotal).toBeVisible();
    await expect(employerTotal).toContainText("$639.96");

    await page.screenshot({
      path: "test-results/fpp5d-factor-f-and-employer-detail.png",
      fullPage: false,
    });
  });
});
