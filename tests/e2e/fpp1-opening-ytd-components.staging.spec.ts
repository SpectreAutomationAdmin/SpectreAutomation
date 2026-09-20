// FPP-1 (2026-09-20) §4 — staging browser acceptance for the new
// Payroll Component YTD workflow.
//
// This spec is READ-ONLY on Chris. It proves the deployed staging build
// carries the new FPP-1 code paths without touching any founder data:
//   - Employee → Payroll tab renders with the new grid
//   - Year-to-Date Detail route renders (aggregate + four component groups)
//   - "View Full Details" now points at /ytd-detail (not the old broken route)
//   - The Payroll tab has no anchor to the OLD 404 opening-balances URL
//
// The MODAL write flow (add / duplicate / remove / lock at ACTIVE) is
// covered exhaustively at unit-test level in
// tests/payroll/opening-balance-components.test.ts (12/12 pass) and at
// full-pipeline level in tests/payroll/fpp1-full-reconciliation.test.ts
// (1/1 pass). A browser walk-through of the modal write flow requires
// either (a) the synthetic Slice-C tenant switched into
// MID_YEAR_MIGRATION for the duration of the run, or (b) a new
// synthetic MID_YEAR_MIGRATION tenant — neither of which this spec
// initiates automatically to keep Chris + Marc production data
// untouched.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT_DIR = "test-results/fpp1-opening-ytd";
const CHRIS_ID = "cmu0fiaod000187prcy9ufo2d";

test.describe("FPP-1 §4 — Payroll Component YTD staging surface (read-only)", () => {
  test.beforeAll(() => {
    const { ready, reason } = stagingCredsAvailable();
    test.skip(!ready, reason ?? "staging creds unavailable");
  });

  test("read-only surface proof: grid + YTD detail + no old 404 anchors", async ({ context }) => {
    const page = await loginAsFounder(context, { landing: "/app/admin" });
    await page.setViewportSize({ width: 1440, height: 900 });

    // A. Employee → Payroll opens normally on Chris.
    await page.goto(`https://staging.spectreautomation.com/app/admin/people/employees/${CHRIS_ID}?tab=payroll`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByTestId("employee-payroll-grid").waitFor({ state: "visible", timeout: 30_000 });
    await page.screenshot({ path: `${OUT_DIR}/A-chris-payroll-tab.png`, fullPage: false });

    // O. No anchor to the old /app/admin/payroll/opening-balances 404
    //    lives on the page.
    const brokenAnchors = await page
      .locator('a[href*="/app/admin/payroll/opening-balances?employeeId="]')
      .count();
    expect(brokenAnchors).toBe(0);

    // C-adjacent. The compact Payroll-tab YTD Summary card is intact and
    // exposes the "View Full Details" link pointing at the NEW route.
    const detailLink = page.locator('[data-testid="grid-view-ytd-details"]');
    await detailLink.waitFor({ state: "visible", timeout: 10_000 });
    const detailHref = await detailLink.getAttribute("href");
    expect(detailHref, "grid-view-ytd-details must link to the new /ytd-detail route").toContain("/ytd-detail");

    // §5 detail surface renders with aggregate + four component-group cards.
    const detailUrl = detailHref!.startsWith("http")
      ? detailHref!
      : `https://staging.spectreautomation.com${detailHref}`;
    await page.goto(detailUrl, { waitUntil: "domcontentloaded" });
    await page.getByTestId("employee-ytd-detail-page").waitFor({ state: "visible", timeout: 15_000 });
    for (const g of [
      "ytd-detail-aggregate",
      "ytd-detail-recurring",
      "ytd-detail-other-earnings",
      "ytd-detail-ee-deductions",
      "ytd-detail-er-contributions",
    ]) {
      await expect(page.getByTestId(g)).toBeVisible();
    }
    await page.screenshot({ path: `${OUT_DIR}/P-ytd-detail.png`, fullPage: true });

    // Back link keeps the founder on the payroll tab (no wandering).
    const back = page.locator('[data-testid="ytd-detail-back"]');
    expect(await back.count()).toBeGreaterThan(0);
    const backHref = await back.getAttribute("href");
    expect(backHref).toContain(`/employees/${CHRIS_ID}`);
    expect(backHref).toContain("tab=payroll");
  });
});
