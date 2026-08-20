// HR-2B.5 §7 acceptance screenshots (§54 items 1-2) — admin
// compensation setup on the Add Employee form.
//
// Does NOT create an employee — just renders the form so the founder
// can see both cadence variants side by side. The compensation
// section is gated on `hr:compensation:write` (which CLUB_ADMIN has),
// so the section renders for the seed admin user.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/hr-2b5");
fs.mkdirSync(OUT, { recursive: true });

async function login(page: import("@playwright/test").Page) {
  await page.goto("http://localhost:3000/login");
  await page
    .locator('form:has(input[name="email"][value="admin@silversprings.club"]) button')
    .first()
    .click();
  await page.waitForURL(/\/app/, { timeout: 30_000 });
}

test.describe("HR-2B.5 · Admin Add Employee compensation UI", () => {
  test("captures the Hourly compensation variant", async ({ page }) => {
    await login(page);
    await page.goto("http://localhost:3000/app/admin/people/employees/new");
    await page.waitForSelector('[data-testid="compensation-section"]', { timeout: 20_000 });

    // Fill the identity + role fields so the compensation card renders
    // in context (screenshot with realistic surrounding form state).
    await page.locator('input[name="firstName"]').fill("Chris");
    await page.locator('input[name="lastName"]').fill("Turcotte");
    await page.locator('input[name="personalEmail"]').fill("chris.turcotte.hourly@spectre.test");
    await page.locator('input[name="mobilePhone"]').fill("(403) 555-0170");

    // Pick the first department to enable the position dropdown.
    const dept = page.locator('select[name="departmentId"]');
    await dept.selectOption({ index: 1 });
    // Then pick the first position under that department. The client
    // filters cross-department positions so index 1 is the first real
    // option (index 0 is the "— Select —" placeholder).
    const pos = page.locator('select[name="positionId"]');
    // If no positions exist yet the panel offers an inline add — skip
    // that flow for this acceptance shot; leave the position blank.
    const posOptions = await pos.evaluate((el) => (el as HTMLSelectElement).options.length).catch(() => 0);
    if (posOptions > 1) await pos.selectOption({ index: 1 });

    // Set expected start date via the SegmentedDateInput (three inputs).
    await page.locator('[data-testid="expected-start-date-year"]').fill("2026");
    await page.locator('[data-testid="expected-start-date-month"]').fill("09");
    await page.locator('[data-testid="expected-start-date-day"]').fill("08");

    // Cadence is HOURLY by default. Fill rate.
    await page.locator('[data-testid="compensation-cadence"]').selectOption("HOURLY");
    await page.locator('[data-testid="compensation-amount"]').fill("22.50");
    // Ensure the label + hint update to hourly wording.
    await expect(page.locator('label[for="compensationAmount"]')).toContainText("Hourly rate");

    await page.screenshot({ path: path.join(OUT, "01-admin-compensation-hourly.png"), fullPage: true });
  });

  test("captures the Salary compensation variant", async ({ page }) => {
    await login(page);
    await page.goto("http://localhost:3000/app/admin/people/employees/new");
    await page.waitForSelector('[data-testid="compensation-section"]', { timeout: 20_000 });

    await page.locator('input[name="firstName"]').fill("Chris");
    await page.locator('input[name="lastName"]').fill("Turcotte");
    await page.locator('input[name="personalEmail"]').fill("chris.turcotte.salary@spectre.test");
    await page.locator('input[name="mobilePhone"]').fill("(403) 555-0171");
    const dept = page.locator('select[name="departmentId"]');
    await dept.selectOption({ index: 1 });
    const pos = page.locator('select[name="positionId"]');
    const posOptions = await pos.evaluate((el) => (el as HTMLSelectElement).options.length).catch(() => 0);
    if (posOptions > 1) await pos.selectOption({ index: 1 });

    await page.locator('[data-testid="expected-start-date-year"]').fill("2026");
    await page.locator('[data-testid="expected-start-date-month"]').fill("09");
    await page.locator('[data-testid="expected-start-date-day"]').fill("08");

    await page.locator('[data-testid="compensation-cadence"]').selectOption("SALARY");
    await page.locator('[data-testid="compensation-amount"]').fill("72000");
    await expect(page.locator('label[for="compensationAmount"]')).toContainText("Annual salary");

    await page.screenshot({ path: path.join(OUT, "02-admin-compensation-salary.png"), fullPage: true });
  });
});
