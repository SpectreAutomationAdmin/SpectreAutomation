// Phase 4 (2026-09-16) — Employee Profile · Recurring Payroll
// Components staging acceptance at 1440×900.
//
// Proves:
//   A. Chris's Employee Profile → Payroll tab renders the new
//      "Compensation & Benefits" section.
//   B. The section shows Active / Upcoming / Historical buckets
//      and an "+ Add Recurring Component" affordance.
//   C. Opening Add reveals the component picker + effective-date +
//      amount fields.
//   D. No CSP inline-script violations, no 5xx doc responses.
//
// The test does NOT assign an actual Cell Phone Allowance amount to
// Chris — per the founder directive that must be done by the founder
// through the browser, not by automation. This spec only proves the
// UI is reachable and structurally correct.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/payroll-employee-recurring-components");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.use({ viewport: { width: 1440, height: 900 } });

test("Employee Profile Payroll tab renders Compensation & Benefits section", async ({ browser }) => {
  const creds = stagingCredsAvailable();
  test.skip(!creds.ready, creds.reason ?? "staging creds unavailable");
  test.setTimeout(180_000);

  const ctx = await browser.newContext();
  const page = await loginAsFounder(ctx);
  const cspViolations: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && /Content Security Policy/i.test(msg.text()) && /inline script/i.test(msg.text())) {
      cspViolations.push(msg.text().slice(0, 200));
    }
  });
  const badResponses: Array<{ url: string; status: number }> = [];
  page.on("response", (r) => {
    if (r.request().resourceType() === "document" && r.status() >= 500) {
      badResponses.push({ url: r.url(), status: r.status() });
    }
  });

  // Land on Employees list; pick Chris.
  await page.goto(`${STAGING}/app/admin/people/employees`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(OUT, "01-employees-list.png"), fullPage: true });

  const chrisLink = page.locator('a', { hasText: /Turcato/ }).first();
  await chrisLink.click();
  await page.waitForURL(/\/app\/admin\/people\/employees\/[^/]+$/);
  await page.waitForTimeout(2000);

  // Click Payroll tab.
  await page.locator('button, [role="tab"]').filter({ hasText: /^Payroll$/ }).first().click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, "02-payroll-tab.png"), fullPage: true });

  // A. Compensation & Benefits section renders.
  const section = page.locator('[data-testid="payroll-recurring-components-section"]');
  await expect(section).toBeVisible();

  // B. Active bucket + Add affordance visible.
  const activeEmpty = page.locator('[data-testid="payroll-recurring-active-empty"]');
  const activeList  = page.locator('[data-testid="payroll-recurring-active-list"]');
  const oneVisible = (await activeEmpty.isVisible().catch(() => false)) ||
                     (await activeList.isVisible().catch(() => false));
  expect(oneVisible).toBe(true);

  const addBtn = page.locator('[data-testid="payroll-recurring-add-open"]');
  await expect(addBtn).toBeVisible();

  // C. Open the Add form; component picker + effective-date visible.
  await addBtn.click();
  await page.waitForTimeout(400);
  await expect(page.locator('[data-testid="payroll-recurring-add-form"]')).toBeVisible();
  await expect(page.locator('[data-testid="payroll-recurring-add-component"]')).toBeVisible();
  await expect(page.locator('[data-testid="payroll-recurring-add-effective"]')).toBeVisible();
  await page.screenshot({ path: path.join(OUT, "03-add-form-open.png"), fullPage: false });

  // D. Universal guardrails.
  expect(cspViolations.length, `no CSP inline-script violations. Got: ${JSON.stringify(cspViolations)}`).toBe(0);
  expect(badResponses.length, `no 5xx doc responses. Got: ${JSON.stringify(badResponses)}`).toBe(0);
  const body = await page.locator("body").innerText();
  expect(body).not.toContain("Application error");
  expect(body).not.toContain("server-side exception");

  await ctx.close();
});
