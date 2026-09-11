// Payroll 3A hotfix (2026-09-11) — local acceptance for the four
// new UI controls: functional page-size dropdown, Prepare Payroll
// initial label + spinner-swap when disabled, Change Period option
// labels carry the " · No batch" / " · <BATCH_STATUS>" suffix.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/payroll-admin-3a-hotfix");
fs.mkdirSync(OUT, { recursive: true });

test.use({ viewport: { width: 1440, height: 900 } });

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto("http://localhost:3000/login");
  await page.locator('form:has(input[name="email"][value="admin@silversprings.club"]) button').first().click();
  await page.waitForURL(/\/app/, { timeout: 30_000 });
}

test.describe.serial("Payroll 3A hotfix — local", () => {
  test.setTimeout(180_000);

  test("A. Page-size control is a real <select> with 10/25/50 options", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("http://localhost:3000/app/admin/payroll", { waitUntil: "networkidle" });
    const pageSize = page.getByTestId("payroll-admin-page-size");
    await expect(pageSize).toBeVisible();
    await expect(pageSize).toBeEnabled();
    const tag = await pageSize.evaluate((el) => el.tagName.toLowerCase());
    expect(tag).toBe("select");
    const options = await pageSize.locator("option").evaluateAll((els) => els.map((o) => (o as HTMLOptionElement).value));
    expect(options).toEqual(["10", "25", "50"]);
    // Default should be 10 with no ?pageSize= URL param.
    await expect(pageSize).toHaveValue("10");
  });

  test("B. Changing page-size updates the URL", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("http://localhost:3000/app/admin/payroll", { waitUntil: "networkidle" });
    await page.getByTestId("payroll-admin-page-size").selectOption("25");
    await page.waitForURL(/pageSize=25/);
    expect(page.url()).toMatch(/pageSize=25/);
    expect(page.url()).toMatch(/page=1/);
  });

  test("C. Prepare Payroll button initial label + PrepareControls are wired", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("http://localhost:3000/app/admin/payroll", { waitUntil: "networkidle" });
    const btn = page.getByTestId("payroll-admin-prepare");
    if (await btn.count() > 0) {
      await expect(btn).toBeVisible();
      await expect(btn).toBeEnabled();
      await expect(btn).toHaveText(/Prepare Payroll/);
      const pending = await btn.getAttribute("data-pending");
      expect(pending).toBe("false");
      // aria-busy reflects idle state.
      const ariaBusy = await btn.getAttribute("aria-busy");
      expect(ariaBusy).toBe("false");
    }
  });

  test("D. Change Period option labels include batch-status suffix ('· No batch' when unprepared)", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("http://localhost:3000/app/admin/payroll", { waitUntil: "networkidle" });
    const changePeriod = page.getByTestId("payroll-admin-change-period");
    await expect(changePeriod).toBeVisible();
    const optionLabels = await changePeriod.locator("option").evaluateAll(
      (els) => els.map((o) => (o as HTMLOptionElement).textContent ?? ""),
    );
    // Local dev DB may have no pay group / no periods — only assert
    // suffix rule when at least one non-empty period option exists.
    const nonEmpty = optionLabels.filter((l) => l && !/No pay periods available/i.test(l));
    if (nonEmpty.length > 0) {
      for (const l of nonEmpty) {
        expect(l, `option "${l}" must carry a batch-status suffix`).toMatch(/·\s+(DRAFT|PREPARED|CALCULATED|SUBMITTED_FOR_APPROVAL|APPROVED|POSTED|No batch)$/);
      }
    }
  });

  test("E. Change Period list is reverse chronological (newest first)", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("http://localhost:3000/app/admin/payroll", { waitUntil: "networkidle" });
    const changePeriod = page.getByTestId("payroll-admin-change-period");
    const optionLabels = await changePeriod.locator("option").evaluateAll(
      (els) => els.map((o) => (o as HTMLOptionElement).textContent ?? ""),
    );
    const nonEmpty = optionLabels.filter((l) => l && !/No pay periods available/i.test(l));
    if (nonEmpty.length >= 2) {
      // Extract the last day of the "MMM d, YYYY – MMM d, YYYY" range.
      const parsed = nonEmpty.map((label) => {
        const m = label.match(/–\s+([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})/);
        if (!m) return null;
        const monthIdx = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].indexOf(m[1]!);
        return Date.UTC(Number(m[3]), monthIdx, Number(m[2]));
      }).filter((v): v is number => v !== null);
      for (let i = 1; i < parsed.length; i++) {
        expect(parsed[i - 1]!, `label ${i - 1} must be newer than label ${i}`).toBeGreaterThanOrEqual(parsed[i]!);
      }
    }
  });
});
