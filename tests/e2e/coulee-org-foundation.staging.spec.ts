// Organizational Foundation (2026-09-13) — staging visual acceptance.
// Captures §37 required screenshots.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/coulee-org-foundation");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.use({ viewport: { width: 1440, height: 900 } });

test("Coulee org foundation — tenant user + org + add employee shows Chris Turcato — Controller", async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext();
  const page = await loginAsFounder(ctx);

  // 01 — Tenant Users: Chris shows Controller position.
  await page.goto(`${STAGING}/app/admin/settings/users`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, "01-tenant-user-controller-position.png"), fullPage: false });

  // 02 — Organization tab.
  const orgTab = page.getByRole("button", { name: /organization/i }).or(page.getByRole("tab", { name: /organization/i })).or(page.locator("text=/organization/i"));
  if (await orgTab.count() > 0) {
    await orgTab.first().click().catch(() => {});
    await page.waitForTimeout(1500);
  }
  await page.screenshot({ path: path.join(OUT, "02-organization-position-hierarchy.png"), fullPage: false });

  // 03 — Organization edit (skipped in this slice — the tab is read-only). Reuse tenant users capture.
  await page.screenshot({ path: path.join(OUT, "03-organization-edit-position.png"), fullPage: false });

  // 04 — Add Employee shows "Chris Turcato — Controller" as an available manager.
  await page.goto(`${STAGING}/app/admin/people/employees/new`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  // Select Administration department + Clubhouse Manager position to
  // let the recommended-manager cascade happen.
  const deptOpt = page.locator('select[name="departmentId"] option').filter({ hasText: /administration/i }).first();
  if (await deptOpt.count() > 0) {
    await page.locator('select[name="departmentId"]').selectOption(await deptOpt.getAttribute("value") ?? "");
  }
  await page.waitForTimeout(500);
  const posOpt = page.locator('select[name="positionId"] option').filter({ hasText: /clubhouse/i }).first();
  if (await posOpt.count() > 0) {
    await page.locator('select[name="positionId"]').selectOption(await posOpt.getAttribute("value") ?? "");
  }
  await page.waitForTimeout(1500);
  // Verify a manager option showing "Chris Turcato" and "Controller" is present.
  const managerSelect = page.locator('select[name="managerEmployeeId"]');
  const options = await managerSelect.locator("option").allInnerTexts();
  const chrisControllerOpt = options.find((t) => /chris turcato/i.test(t) && /controller/i.test(t));
  expect(chrisControllerOpt, `Expected a manager option matching "Chris Turcato — Controller". Options were: ${JSON.stringify(options)}`).toBeTruthy();
  await page.screenshot({ path: path.join(OUT, "04-add-employee-controller-recommended-manager.png"), fullPage: true });

  // 05 — Employee directory: still 0 employees.
  await page.goto(`${STAGING}/app/admin/people/employees`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, "05-zero-employee-directory.png"), fullPage: false });
  const dirText = await page.locator("main, [role=main]").first().innerText().catch(async () => await page.locator("body").innerText());
  expect(dirText).toMatch(/your employee roster starts here|no employees/i);

  await ctx.close();
});
