// Payroll Admin 3A — staging acceptance.
//
// Verifies against the deployed staging release that:
//   - /api/health = 200
//   - /app/admin/payroll renders the approved surface driven by real
//     Coulee Ridge Payroll data (not the fixture strings).
//   - Change Period control renders.
//   - Filter controls render (with URL-echoed values where the domain
//     has data to populate them).
//   - Mission Control still renders (non-Payroll regression).
//
// Coulee Ridge staging is where the founder's mental model of "the
// test tenant" lives; this spec runs the founder acceptance walk.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/payroll-admin-3a-staging");
fs.mkdirSync(OUT, { recursive: true });

const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.use({ viewport: { width: 1440, height: 900 } });

test.describe.serial("Payroll Admin 3A — staging", () => {
  test.setTimeout(240_000);

  test("A. /api/health = 200", async ({ request }) => {
    const r = await request.get(`${STAGING}/api/health`);
    expect(r.status()).toBe(200);
  });

  test("B. /app/admin/payroll renders the real surface", async ({ context }) => {
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

  test("C. Fixture-data leak check on staging", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll`, { waitUntil: "networkidle" });
    const html = await page.content();
    const forbidden = [
      "Taylor Hourly", "Riley Preview", "Casey Preview", "Devon Preview",
      "Lise Montsion", "Alex Chen", "Jordan Keller", "Morgan West", "Jamie Park",
      // Chris Turcato is the real founder account; do NOT flag his name here.
      "$32,487.62", "1,248.50", "42 hourly · 6 salary",
      "5% vs. previous period", "3% vs. previous period",
      "5 of 6 complete",
    ];
    const leaked = forbidden.filter((s) => html.includes(s));
    expect(leaked, `forbidden fixtures leaked: ${leaked.join(", ")}`).toEqual([]);
  });

  test("D. Change Period + Export disabled + future-slice Payroll Actions still disabled", async ({ context }) => {
    // Slice 3B activated Resolve Exceptions + View Time Approvals
    // (when a batch exists). The three future-slice actions —
    // Add One-Time Adjustment, Manage Recurring Components, and
    // Calculate Payroll — remain disabled until 3C/3D own them.
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll`, { waitUntil: "networkidle" });
    await expect(page.getByTestId("payroll-admin-change-period")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-export")).toBeDisabled();
    const disabledActionCount = await page.getByTestId("payroll-admin-actions").locator("button[disabled]").count();
    expect(disabledActionCount).toBeGreaterThanOrEqual(3);
  });

  test("E. Filter bar + search URL echo", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?q=Chris`, { waitUntil: "networkidle" });
    await expect(page.getByTestId("payroll-admin-search")).toHaveValue("Chris");
    await expect(page.getByTestId("payroll-admin-filter-department")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-filter-employment")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-filter-status")).toBeVisible();
  });

  test("F. Mission Control still renders (non-Payroll regression)", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin`, { waitUntil: "networkidle" });
    await expect(page.getByTestId("spectre-sidebar")).toBeVisible();
    const err = await page.locator("text=/Application error/i").count();
    expect(err).toBe(0);
    await page.screenshot({ path: path.join(OUT, "staging-mission-control-1440x900.png"), fullPage: false });
  });

  test("G. Sidebar Payroll link is present in the Finance section", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin`, { waitUntil: "networkidle" });
    const sidebar = page.getByTestId("spectre-sidebar");
    // Open the Finance section (single-open accordion).
    const financeToggle = sidebar.getByTestId("nav-section-toggle-finance");
    await financeToggle.waitFor({ state: "visible" });
    const isOpen = await financeToggle.getAttribute("data-open");
    if (isOpen !== "true") await financeToggle.click();
    // The Payroll link (href=/app/admin/payroll) must appear in the expanded body.
    const payrollLink = sidebar.locator('a[href="/app/admin/payroll"]');
    await expect(payrollLink).toBeVisible();
    await sidebar.screenshot({ path: path.join(OUT, "staging-sidebar-payroll-link.png") });
  });

  test("H. Prepare Payroll button appears when no batch exists", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll`, { waitUntil: "networkidle" });
    // Either the no-batch state renders the Prepare button, OR a batch already exists.
    const prepareBtn = page.getByTestId("payroll-admin-prepare");
    const hasPrepare = await prepareBtn.count();
    if (hasPrepare > 0) {
      await expect(prepareBtn).toBeVisible();
      await expect(prepareBtn).toBeEnabled();
    } else {
      // Populated case — an existing batch was found. Ensure the workspace is not the empty state.
      const empty = page.getByTestId("payroll-admin-employee-empty");
      const isEmpty = await empty.count();
      expect(isEmpty, "either Prepare button or a non-empty workspace must be visible").toBe(0);
    }
  });
});
