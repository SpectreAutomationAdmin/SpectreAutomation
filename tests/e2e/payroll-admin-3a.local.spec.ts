// Payroll Admin 3A — local read-only acceptance.
//
// Verifies /app/admin/payroll renders real-data-driven props from
// buildPayrollOverview. The local seed DB has no PayrollBatch, so we
// primarily assert the empty state + URL contract; the population
// path is covered by the staging acceptance spec against Coulee Ridge.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/payroll-admin-3a");
fs.mkdirSync(OUT, { recursive: true });

test.use({ viewport: { width: 1440, height: 900 } });

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto("http://localhost:3000/login");
  await page.locator('form:has(input[name="email"][value="admin@silversprings.club"]) button').first().click();
  await page.waitForURL(/\/app/, { timeout: 30_000 });
}

test.describe.serial("Payroll Admin 3A — real Payroll Overview", () => {
  test.setTimeout(180_000);

  test("A. /app/admin/payroll renders real surface + all approved regions", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("http://localhost:3000/app/admin/payroll", { waitUntil: "networkidle" });
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
    // No horizontal overflow.
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(1440);
    await page.screenshot({ path: path.join(OUT, "local-payroll-1440x900.png"), fullPage: false });
  });

  test("B. Fixture-data removal — approved reference strings must NOT be hardcoded in the real component", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("http://localhost:3000/app/admin/payroll", { waitUntil: "networkidle" });
    // Approved-reference literal strings that MUST not be in the real component
    // (they are only allowed in the isolated preview shell).
    const html = await page.content();
    const forbidden = [
      "Taylor Hourly", "Riley Preview", "Casey Preview", "Devon Preview",
      "Chris Turcato", "Lise Montsion", "Alex Chen", "Jordan Keller", "Morgan West", "Jamie Park",
      "$32,487.62", "1,248.50", "42 hourly · 6 salary", "5% vs. previous period", "3% vs. previous period",
      "5 of 6 complete",
    ];
    const leaked = forbidden.filter((s) => html.includes(s));
    expect(leaked, `these fixture strings must not appear on the real route: ${leaked.join(", ")}`).toEqual([]);
  });

  test("C. Empty state renders when no batch is prepared", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("http://localhost:3000/app/admin/payroll", { waitUntil: "networkidle" });
    // If no batch, the workspace tbody shows the empty state.
    const emptyState = page.getByTestId("payroll-admin-employee-empty");
    const hasEmpty = await emptyState.count();
    if (hasEmpty > 0) {
      const text = await emptyState.textContent();
      expect(text).toMatch(/(No batch prepared|No employees match)/);
      // KPI Total Hours / Gross Pay show "—".
      const totalHours = await page.getByTestId("payroll-admin-kpi-total-hours").textContent();
      expect(totalHours).toContain("—");
    }
    // The workflow tracker must always render 8 nodes.
    const workflowNodes = await page.getByTestId("payroll-admin-workflow").locator("div.grid.grid-cols-8 > div").count();
    expect(workflowNodes).toBe(8);
  });

  test("D. Change Period control renders + Export is disabled + Actions are disabled", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("http://localhost:3000/app/admin/payroll", { waitUntil: "networkidle" });
    const changePeriod = page.getByTestId("payroll-admin-change-period");
    await expect(changePeriod).toBeVisible();
    const exportBtn = page.getByTestId("payroll-admin-export");
    await expect(exportBtn).toBeDisabled();
    const exportTitle = await exportBtn.getAttribute("title");
    expect(exportTitle).toContain("not yet available");
    // Right-rail actions should all be disabled in 3A (no functionality yet).
    const disabledActionCount = await page.getByTestId("payroll-admin-actions").locator("button[disabled]").count();
    expect(disabledActionCount).toBeGreaterThanOrEqual(5);
  });

  test("E. Filter bar renders 3 filter controls + search echoes URL param", async ({ page }) => {
    await loginAsAdmin(page);
    // Prime a search via URL and assert the input echoes it.
    await page.goto("http://localhost:3000/app/admin/payroll?q=Chris", { waitUntil: "networkidle" });
    await expect(page.getByTestId("payroll-admin-search")).toHaveValue("Chris");
    // Filter selects render even when empty; the employment/department/status
    // options are populated ONLY from the loaded batch population, so on a
    // fresh dev DB (no batch) the URL param cannot be honored — that path is
    // covered by the staging acceptance spec.
    await expect(page.getByTestId("payroll-admin-filter-department")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-filter-employment")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-filter-status")).toBeVisible();
  });

  test("F. Non-Payroll admin page (Mission Control) still renders", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("http://localhost:3000/app/admin", { waitUntil: "networkidle" });
    await expect(page.getByTestId("spectre-sidebar")).toBeVisible();
    const err = await page.locator("text=/Application error/i").count();
    expect(err).toBe(0);
  });
});
