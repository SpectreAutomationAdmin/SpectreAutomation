// Organizational Foundation closeout (2026-09-13) — final acceptance
// screenshots for the Organization tab editor + Add Employee.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/coulee-org-foundation-closeout");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.use({ viewport: { width: 1440, height: 900 } });

test("Coulee org foundation closeout — hierarchy view, editor, add position, vacant+occupied, add employee, empty directory", async ({ browser }) => {
  test.setTimeout(360_000);
  const ctx = await browser.newContext();
  const page = await loginAsFounder(ctx);

  // 01 — Full hierarchy visible on the Organization tab.
  await page.goto(`${STAGING}/app/admin/settings/users`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const orgTab = page.getByRole("button", { name: /^organization$/i })
    .or(page.getByRole("tab", { name: /organization/i }))
    .or(page.locator("button:has-text('Organization')"));
  if (await orgTab.count() > 0) {
    await orgTab.first().click();
    await page.waitForTimeout(2000);
  }
  await page.screenshot({ path: path.join(OUT, "01-organization-full-hierarchy.png"), fullPage: true });
  // Assert the canonical tree rendered.
  await expect(page.locator('[data-testid="organization-tab-canonical"]')).toBeVisible();
  await expect(page.locator('[data-testid="org-node-GENERAL_MANAGER"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="org-node-CONTROLLER"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="org-node-CLUBHOUSE_MANAGER"]').first()).toBeVisible();

  // 02 — Edit Clubhouse Manager (name, department, reports-to).
  const editBtn = page.locator('[data-testid="org-edit-CLUBHOUSE_MANAGER"]').first();
  await editBtn.click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, "02-organization-position-edit.png"), fullPage: false });
  // Cancel the edit — we don't want to persist.
  const cancel = page.locator('[data-testid="org-edit-CLUBHOUSE_MANAGER"]').first();
  await cancel.click();
  await page.waitForTimeout(500);

  // 03 — Add Position dialog (from root Add position button).
  const addBtn = page.locator('[data-testid="org-add-root-position"]').first();
  await addBtn.click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, "03-organization-add-position.png"), fullPage: false });
  // Close it.
  const closeAdd = page.getByRole("button", { name: /^cancel$/i }).first();
  if (await closeAdd.count() > 0) await closeAdd.click();
  await page.waitForTimeout(500);

  // 04 — Vacant + occupied evidence.
  await page.screenshot({ path: path.join(OUT, "04-organization-vacant-and-occupied.png"), fullPage: true });
  // The Controller node's occupants should include Chris Turcato.
  const controllerOccupants = await page
    .locator('[data-testid="org-occupants-CONTROLLER"]')
    .first()
    .innerText();
  expect(controllerOccupants).toContain("Chris Turcato");
  // The Clubhouse Manager node's occupants should be "Vacant".
  const clubhouseOccupants = await page
    .locator('[data-testid="org-occupants-CLUBHOUSE_MANAGER"]')
    .first()
    .innerText();
  expect(clubhouseOccupants.toLowerCase()).toContain("vacant");

  // 05 — Add Employee still shows Chris Turcato — Controller / CFO manager option.
  await page.goto(`${STAGING}/app/admin/people/employees/new`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const deptOpt = page.locator('select[name="departmentId"] option').filter({ hasText: /administration/i }).first();
  if (await deptOpt.count() > 0) {
    await page.locator('select[name="departmentId"]').selectOption(await deptOpt.getAttribute("value") ?? "");
  }
  await page.waitForTimeout(500);
  const posOpt = page.locator('select[name="positionId"] option').filter({ hasText: /clubhouse/i }).first();
  if (await posOpt.count() > 0) {
    await page.locator('select[name="positionId"]').selectOption(await posOpt.getAttribute("value") ?? "");
  }
  await page.waitForTimeout(1200);
  const options = await page.locator('select[name="managerEmployeeId"] option').allInnerTexts();
  const chrisControllerOpt = options.find((t) => /chris turcato/i.test(t) && /controller/i.test(t));
  expect(chrisControllerOpt, `Expected "Chris Turcato — Controller / CFO". Options: ${JSON.stringify(options)}`).toBeTruthy();
  await page.screenshot({ path: path.join(OUT, "05-add-employee-controller-manager.png"), fullPage: true });

  // 06 — Employee directory still empty.
  await page.goto(`${STAGING}/app/admin/people/employees`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, "06-zero-employee-directory.png"), fullPage: false });
  const dirText = await page
    .locator("main, [role=main]")
    .first()
    .innerText({ timeout: 5000 })
    .catch(async () => (await page.locator("body").innerText()));
  expect(dirText).toMatch(/your employee roster starts here|no employees/i);

  await ctx.close();
});
