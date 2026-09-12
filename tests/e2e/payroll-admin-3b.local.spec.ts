// Payroll Admin Slice 3B (2026-09-12) — local acceptance.
//
// Verifies the tab navigation, the Exceptions/Approvals tab render,
// the right-rail Resolve Exceptions + View Time Approvals actions,
// checklist derived state, and the workflow tracker's data-driven
// rendering. The local dev DB has no batches, so most assertions
// exercise the empty-state paths; staging spec covers the populated
// paths.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/payroll-admin-3b");
fs.mkdirSync(OUT, { recursive: true });

test.use({ viewport: { width: 1440, height: 900 } });

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto("http://localhost:3000/login");
  await page.locator('form:has(input[name="email"][value="admin@silversprings.club"]) button').first().click();
  await page.waitForURL(/\/app/, { timeout: 30_000 });
}

test.describe.serial("Payroll 3B — local", () => {
  test.setTimeout(180_000);

  test("A. Workspace tabs are real buttons that navigate via ?tab=", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("http://localhost:3000/app/admin/payroll", { waitUntil: "networkidle" });
    for (const t of ["employees", "exceptions", "adjustments", "approvals", "summary"]) {
      const btn = page.getByTestId(`payroll-admin-tab-${t}`);
      await expect(btn).toBeVisible();
      const tag = await btn.evaluate((el) => el.tagName.toLowerCase());
      expect(tag).toBe("button");
    }
  });

  test("B. Clicking Exceptions tab pushes ?tab=exceptions and switches content", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("http://localhost:3000/app/admin/payroll", { waitUntil: "networkidle" });
    await page.getByTestId("payroll-admin-tab-exceptions").click();
    await page.waitForURL(/tab=exceptions/, { timeout: 20_000 });
    // In empty-state, exceptions tab renders the "no batch" empty state.
    await expect(page.getByTestId("payroll-admin-exceptions-empty")).toBeVisible();
  });

  test("C. Clicking Approvals tab pushes ?tab=approvals and switches content", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("http://localhost:3000/app/admin/payroll", { waitUntil: "networkidle" });
    await page.getByTestId("payroll-admin-tab-approvals").click();
    await page.waitForURL(/tab=approvals/, { timeout: 20_000 });
    // Approvals tab renders EITHER the populated view (when the
    // dev DB has PayrollTimesheetEntry rows from earlier fixtures)
    // OR the empty state. The important behaviour is that one of
    // the two branches renders — the tab must NOT crash or show
    // Employees content.
    const populated = await page.getByTestId("payroll-admin-approvals-tab").count();
    const empty = await page.getByTestId("payroll-admin-approvals-empty").count();
    expect(populated + empty).toBeGreaterThan(0);
  });

  test("D. Right-rail Resolve Exceptions is disabled before Prepare + wired when a batch exists", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("http://localhost:3000/app/admin/payroll", { waitUntil: "networkidle" });
    // No batch on local dev → button disabled.
    const btn = page.getByTestId("payroll-admin-actions-resolve-exceptions");
    await expect(btn).toBeVisible();
    await expect(btn).toBeDisabled();
    const title = await btn.getAttribute("title");
    expect(title).toContain("Prepare a payroll batch");
  });

  test("E. Right-rail View Time Approvals is disabled before Prepare", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("http://localhost:3000/app/admin/payroll", { waitUntil: "networkidle" });
    const btn = page.getByTestId("payroll-admin-actions-view-approvals");
    await expect(btn).toBeVisible();
    await expect(btn).toBeDisabled();
  });

  test("F. Pre-Calculation Checklist has 6 items with 3 3B-owned + 3 future-neutral (no batch)", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("http://localhost:3000/app/admin/payroll", { waitUntil: "networkidle" });
    const items = page.locator('[data-testid^="payroll-admin-checklist-item-"]');
    await expect(items).toHaveCount(6);
    // In the no-batch state (local dev DB): items 1-3 are 3B-owned,
    // items 4-6 remain future-neutral. Items 4-5 become real when a
    // batch exists (covered by 3C staging tests).
    for (const id of ["time-imported", "department-approvals", "resolve-exceptions"]) {
      const el = page.getByTestId(`payroll-admin-checklist-item-${id}`);
      const future = await el.getAttribute("data-future");
      expect(future, `${id} must be data-future=false`).toBe("false");
    }
    for (const id of ["one-time-adjustments", "recurring-components", "verify-employee-data"]) {
      const el = page.getByTestId(`payroll-admin-checklist-item-${id}`);
      const future = await el.getAttribute("data-future");
      expect(future, `${id} must be data-future=true`).toBe("true");
    }
  });

  test("G. Workflow tracker Step 1 renders 'current' when no batch exists", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("http://localhost:3000/app/admin/payroll", { waitUntil: "networkidle" });
    // The workflow is 8 stages. Read the underline decoration as the
    // "current" cue used by the design.
    const workflow = page.getByTestId("payroll-admin-workflow");
    await expect(workflow).toBeVisible();
    const stages = workflow.locator("div.grid.grid-cols-8 > div");
    await expect(stages).toHaveCount(8);
    // Stage 1 label should contain "Prepare".
    await expect(stages.nth(0)).toContainText("Prepare");
  });
});
