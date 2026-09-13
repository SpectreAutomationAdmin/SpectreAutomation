// Zero-baseline UI verification for Coulee Ridge staging.
// Captures 4 screenshots as required by the founder directive §26.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/coulee-zero-baseline");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.use({ viewport: { width: 1440, height: 900 } });

test("Zero-employee baseline — empty directory, empty payroll population, clean scheduling, Add Employee reachable", async ({ browser }) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext();
  const page = await loginAsFounder(ctx);

  // 01 — Employee Directory: empty state
  await page.goto(`${STAGING}/app/admin/people/employees`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, "01-zero-employee-directory.png"), fullPage: false });
  // Look at the Employee directory MAIN region, not the top-right avatar chrome.
  // The founder's own display name is "Chris Turcato" and appears in the avatar,
  // so we scope to the page's main content area.
  const mainText = await page
    .locator("main, [role=main]")
    .first()
    .innerText({ timeout: 5000 })
    .catch(async () => (await page.locator("body").innerText()));
  const forbiddenAsEmployee = ["E-00001", "E-00002", "Lise Montsion", "Riley Reconcile", "Sam Salary", "Playwright Fixture", "Taylor Fixture", "Casey Fixture", "Devon Fixture", "Grounds Manager (Fixture)", "Avery Sample", "Jordan Test", "Morgan Demo", "Quinn Warning", "Riley Synthetic", "Sam Prior", "Executive Chef"];
  for (const n of forbiddenAsEmployee) {
    expect(mainText, `Fixture / legacy "${n}" must NOT appear in Employee Directory main content`).not.toContain(n);
  }

  // 02 — Payroll: empty population
  await page.goto(`${STAGING}/app/admin/payroll`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, "02-empty-payroll-employee-state.png"), fullPage: false });
  const payText = await page
    .locator("main, [role=main]")
    .first()
    .innerText({ timeout: 5000 })
    .catch(async () => (await page.locator("body").innerText()));
  for (const n of forbiddenAsEmployee) {
    expect(payText, `Fixture / legacy "${n}" must NOT appear in Payroll surface main content`).not.toContain(n);
  }

  // 03 — Scheduling: clean
  await page.goto(`${STAGING}/app/admin/scheduling`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, "03-clean-scheduling-state.png"), fullPage: false });
  const schedText = await page
    .locator("main, [role=main]")
    .first()
    .innerText({ timeout: 5000 })
    .catch(async () => (await page.locator("body").innerText()));
  for (const n of forbiddenAsEmployee) {
    expect(schedText, `Fixture / legacy "${n}" must NOT appear in Scheduling surface main content`).not.toContain(n);
  }

  // 04 — Add Employee entry point
  await page.goto(`${STAGING}/app/admin/people/employees`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, "04-add-employee-entry-point.png"), fullPage: false });
  // Look for an Add Employee link/button
  const addEmployeeVisible =
    (await page.getByRole("link", { name: /add employee/i }).count()) > 0 ||
    (await page.getByRole("button", { name: /add employee/i }).count()) > 0 ||
    (await page.locator("text=/add employee/i").count()) > 0;
  expect(addEmployeeVisible, "Add Employee entry point must be visible on empty directory").toBe(true);

  await ctx.close();
});
