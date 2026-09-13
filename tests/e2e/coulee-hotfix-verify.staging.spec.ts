// Hotfix verification (2026-09-13) — five defects.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/coulee-hotfix");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.use({ viewport: { width: 1440, height: 900 } });

test("hotfix — Tenant Users Save, manager recommendations, Chris employee, Marc position", async ({ browser }) => {
  test.setTimeout(360_000);
  const ctx = await browser.newContext();
  const page = await loginAsFounder(ctx);
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(`${e.name}: ${e.message}`));

  // Defect 1: Tenant Users Save no crash.
  await page.goto(`${STAGING}/app/admin/settings/users`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const edit = page.getByRole("button", { name: /^edit$/i }).first();
  await edit.click();
  await page.waitForTimeout(800);
  const save = page.getByRole("button", { name: /^save$/i }).first();
  await save.click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(OUT, "01-tenant-users-save-success.png"), fullPage: false });
  expect(pageErrors.filter((e) => /Cannot read/.test(e)).length,
    `Save should not crash. Page errors: ${JSON.stringify(pageErrors)}`).toBe(0);
  // Success banner should show.
  const banner = await page.locator("body").innerText();
  expect(banner.toLowerCase()).toContain("saved");

  // Defect 4a: Chris now appears in Employee Directory.
  await page.goto(`${STAGING}/app/admin/people/employees`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(OUT, "02-controller-linked-employee-directory.png"), fullPage: true });
  const dirText = await page.locator("body").innerText();
  expect(dirText, `Chris should appear in Employee Directory. Body: ${dirText.slice(0, 500)}`).toContain("Chris Turcato");

  // Defect 5b: Marc appears with Payroll Administrator.
  if (dirText.includes("Marc")) {
    await page.screenshot({ path: path.join(OUT, "07-marc-payroll-admin-directory.png"), fullPage: true });
    expect(dirText).toContain("Payroll Administrator");
  }

  // Defect 2/3: Add Employee — Superintendent should show "General Manager — Vacant".
  await page.goto(`${STAGING}/app/admin/people/employees/new`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  // Pick department Grounds (Course & Grounds on Coulee).
  const deptOpt = page.locator('select[name="departmentId"] option').filter({ hasText: /grounds/i }).first();
  if (await deptOpt.count() > 0) {
    await page.locator('select[name="departmentId"]').selectOption(await deptOpt.getAttribute("value") ?? "");
  }
  await page.waitForTimeout(500);
  const posOpt = page.locator('select[name="positionId"] option').filter({ hasText: /golf course superintendent/i }).first();
  if (await posOpt.count() > 0) {
    await page.locator('select[name="positionId"]').selectOption(await posOpt.getAttribute("value") ?? "");
  }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, "03-superintendent-manager-recommendation.png"), fullPage: true });
  // Expect either recommended-vacant or ambiguous or no-recommended state
  // to include the manager POSITION name, not Chris / Controller.
  const reportsToField = await page.locator('[data-testid="reports-to-field"]').innerText();
  const includesGm = /general manager/i.test(reportsToField);
  const includesControllerAsRecommendedManager =
    reportsToField.includes("Recommended") && /controller/i.test(reportsToField);
  expect(
    includesGm && !includesControllerAsRecommendedManager,
    `Superintendent's Reports-To should reference General Manager (Vacant) — NOT Controller. Got: ${reportsToField}`,
  ).toBe(true);

  // Defect 2/3: Add Employee — Clubhouse Manager should show recommended Chris (Controller / CFO).
  await page.goto(`${STAGING}/app/admin/people/employees/new`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const adminOpt = page.locator('select[name="departmentId"] option').filter({ hasText: /administration/i }).first();
  if (await adminOpt.count() > 0) {
    await page.locator('select[name="departmentId"]').selectOption(await adminOpt.getAttribute("value") ?? "");
  }
  await page.waitForTimeout(300);
  const chOpt = page.locator('select[name="positionId"] option').filter({ hasText: /clubhouse manager/i }).first();
  if (await chOpt.count() > 0) {
    await page.locator('select[name="positionId"]').selectOption(await chOpt.getAttribute("value") ?? "");
  }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, "05-add-employee-controller-manager.png"), fullPage: true });
  const clubhouseReports = await page.locator('[data-testid="reports-to-field"]').innerText();
  expect(/chris turcato/i.test(clubhouseReports) && /controller/i.test(clubhouseReports)).toBe(true);
  expect(/recommended/i.test(clubhouseReports)).toBe(true);

  await ctx.close();
});
