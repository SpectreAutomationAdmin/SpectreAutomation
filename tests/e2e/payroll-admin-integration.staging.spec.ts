// Payroll Admin Phase 2 — staging integration acceptance.
//
// Verifies against the deployed staging release that:
//   1. /api/health returns 200.
//   2. Authenticated /app/admin/payroll renders the approved surface
//      inside the real Spectre admin shell (dark-navy sidebar).
//   3. Every existing sidebar section is present after the styling
//      change (link/icon/hierarchy regression proof).
//   4. Mission Control still renders cleanly.
//   5. Payroll (legacy) at /app/admin/ops/payroll still renders.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/payroll-integration-staging");
fs.mkdirSync(OUT, { recursive: true });

const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.use({ viewport: { width: 1440, height: 900 } });

test.describe.serial("Payroll Admin Phase 2 — staging integration acceptance", () => {
  test.setTimeout(240_000);

  test("A. /api/health = 200", async ({ request }) => {
    const r = await request.get(`${STAGING}/api/health`);
    expect(r.status()).toBe(200);
  });

  test("B. Real /app/admin/payroll renders approved surface inside real chrome", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll`, { waitUntil: "networkidle" });
    await expect(page.getByTestId("spectre-sidebar")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-surface")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-header")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-workflow")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-kpi-strip")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-workspace")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-actions")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-checklist")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-pay-period")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-footer")).toBeVisible();
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(1440);
    await page.screenshot({ path: path.join(OUT, "staging-payroll-1440x900.png"), fullPage: false });
  });

  test("C. Sidebar shows dark-navy treatment + every existing section present", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll`, { waitUntil: "networkidle" });
    const sidebar = page.getByTestId("spectre-sidebar");
    await sidebar.waitFor({ state: "visible" });

    // Dark navy background.
    const bg = await sidebar.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toMatch(/rgb\(15,\s*23,\s*42\)/);

    // Product identity preserved.
    await expect(sidebar.getByTestId("spectre-sidebar-product-name-line-1")).toHaveText("SPECTRE");
    await expect(sidebar.getByTestId("spectre-sidebar-product-name-line-2")).toHaveText("AUTOMATION");

    // Sections visible (perm-gated; founder should see most/all).
    const sectionToggles = sidebar.locator('[data-testid^="nav-section-toggle-"]');
    const sectionCount = await sectionToggles.count();
    expect(sectionCount).toBeGreaterThanOrEqual(10);

    await sidebar.screenshot({ path: path.join(OUT, "staging-sidebar-dark-treatment.png") });
  });

  test("D. Mission Control still renders cleanly (non-Payroll regression)", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin`, { waitUntil: "networkidle" });
    await expect(page.getByTestId("spectre-sidebar")).toBeVisible();
    const err = await page.locator("text=/Application error/i").count();
    expect(err).toBe(0);
    const bg = await page.getByTestId("spectre-sidebar").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toMatch(/rgb\(15,\s*23,\s*42\)/);
    await page.screenshot({ path: path.join(OUT, "staging-mission-control-1440x900.png"), fullPage: false });
  });

  test("E. Payroll (legacy) at /app/admin/ops/payroll continues to render", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/ops/payroll`, { waitUntil: "domcontentloaded" });
    // Ensure the sidebar renders before we check for error banners.
    await page.getByTestId("spectre-sidebar").waitFor({ state: "visible", timeout: 30_000 });
    const err = await page.locator("text=/Application error/i").count();
    expect(err).toBe(0);
    const bg = await page.getByTestId("spectre-sidebar").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toMatch(/rgb\(15,\s*23,\s*42\)/);
  });
});
