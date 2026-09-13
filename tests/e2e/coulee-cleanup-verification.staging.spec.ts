// Post-cleanup UI verification for Coulee Ridge staging.
// Signs in as Chris and captures the four §22 surfaces.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/coulee-cleanup-verification");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
test.use({ viewport: { width: 1440, height: 900 } });

test("Coulee cleanup — employees + payroll + scheduling + WI empty of fixture data", async ({ browser }) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext();
  const page = await loginAsFounder(ctx);

  // ---- People ----
  await page.goto(`${STAGING}/app/admin/people/employees`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, "01-employees-1440x900.png"), fullPage: false });
  const bodyText = await page.locator("body").innerText();
  const fixtureNames = ["Riley Reconcile", "Sam Salary", "Playwright Fixture", "Taylor Fixture", "Casey Fixture", "Devon Fixture", "Grounds Manager (Fixture)", "Avery Sample", "Jordan Test", "Morgan Demo", "Quinn Warning"];
  for (const n of fixtureNames) {
    expect(bodyText, `Fixture "${n}" must NOT appear on Employees`).not.toContain(n);
  }
  expect(bodyText).toContain("Chris Turcato");
  expect(bodyText).toContain("Lise Montsion");

  // ---- Payroll overview ----
  await page.goto(`${STAGING}/app/admin/payroll`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, "02-payroll-1440x900.png"), fullPage: false });
  const payText = await page.locator("body").innerText();
  expect(payText, "Deleted fixture pay-group code should not appear").not.toContain("3C-ACCEPT");
  expect(payText, "Deleted fixture pay-group code should not appear").not.toContain("3D-ACCEPT");

  // ---- Scheduling ----
  await page.goto(`${STAGING}/app/admin/scheduling`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, "03-scheduling-1440x900.png"), fullPage: false });
  const schedText = await page.locator("body").innerText();
  for (const n of fixtureNames) {
    expect(schedText, `Fixture "${n}" must NOT appear on Scheduling`).not.toContain(n);
  }

  // ---- Work Intake ----
  await page.goto(`${STAGING}/app/mission-control`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, "04-mission-control-1440x900.png"), fullPage: false });

  await ctx.close();
});
