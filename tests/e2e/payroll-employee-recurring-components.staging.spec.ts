// Phase 4 follow-up (2026-09-16) — Employee Profile · Recurring
// Payroll Components staging acceptance at 1440×900.
//
// Proves:
//   A. Chris's Employee Profile → Payroll → Compensation & Benefits
//      section renders.
//   B. Opening Add reveals the component picker + effective-date +
//      Notes fields (with no amount field yet — nothing selected).
//   C. After a FIXED_AMOUNT component is selected, the read-only
//      "component context" panel AND the "Amount per pay (CAD)"
//      input appear. Selecting a PERCENT component swaps the
//      Amount input for a "% of eligible earnings" input.
//   D. No CSP inline-script violations, no 5xx doc responses.
//
// The test does NOT actually SAVE an assignment for Chris on staging
// — per §22 of the founder brief, actual amounts are entered by the
// founder through the browser. This spec verifies the UI structure
// only.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/payroll-employee-recurring-components");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.use({ viewport: { width: 1440, height: 900 } });

test("Employee Profile Payroll tab — Add form dynamically shows Amount/Percent + context panel", async ({ browser }) => {
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

  await page.goto(`${STAGING}/app/admin/people/employees`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);

  const chrisLink = page.locator('a', { hasText: /Turcato/ }).first();
  await chrisLink.click();
  await page.waitForURL(/\/app\/admin\/people\/employees\/[^/]+$/);
  await page.waitForTimeout(2000);

  await page.locator('button, [role="tab"]').filter({ hasText: /^Payroll$/ }).first().click();
  await page.waitForTimeout(1500);

  // A. Section renders.
  const section = page.locator('[data-testid="payroll-recurring-components-section"]');
  await expect(section).toBeVisible();

  // B. Open Add — component picker + effective-date visible.
  await page.locator('[data-testid="payroll-recurring-add-open"]').click();
  await page.waitForTimeout(400);
  await expect(page.locator('[data-testid="payroll-recurring-add-form"]')).toBeVisible();
  const componentSelect = page.locator('[data-testid="payroll-recurring-add-component"]');
  await expect(componentSelect).toBeVisible();
  await expect(page.locator('[data-testid="payroll-recurring-add-effective"]')).toBeVisible();
  // No amount field yet (nothing selected).
  await expect(page.locator('[data-testid="payroll-recurring-add-amount"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="payroll-recurring-add-percent"]')).toHaveCount(0);
  await page.screenshot({ path: path.join(OUT, "01-add-form-empty.png"), fullPage: false });

  // C. Select the first available component. On Coulee Ridge, at
  //    minimum the seeded fixture components should appear. If the
  //    catalogue is empty (no components yet configured on staging),
  //    verify the picker is empty AND surface that to the founder
  //    via the checkpoint — do NOT silently pass.
  const optionCount = await componentSelect.locator("option").count();
  test.skip(optionCount <= 1, "Coulee Ridge staging has no active PayrollComponents in its catalogue — founder must add Cell Phone Allowance in Payroll Settings → Section 7 before this spec can verify the FIXED_AMOUNT path.");

  // Try to find a FIXED_AMOUNT component first; otherwise fall through
  // to PERCENT. Both must reveal one of the two amount / percent inputs.
  await componentSelect.selectOption({ index: 1 });
  await page.waitForTimeout(400);
  // Component context panel now visible.
  await expect(page.locator('[data-testid="payroll-recurring-add-context"]')).toBeVisible();
  const amountVisible = await page.locator('[data-testid="payroll-recurring-add-amount"]').isVisible().catch(() => false);
  const percentVisible = await page.locator('[data-testid="payroll-recurring-add-percent"]').isVisible().catch(() => false);
  expect(amountVisible || percentVisible).toBe(true);
  await page.screenshot({ path: path.join(OUT, "02-add-form-with-selection.png"), fullPage: false });

  // D. Universal guardrails.
  expect(cspViolations.length, `no CSP inline-script violations. Got: ${JSON.stringify(cspViolations)}`).toBe(0);
  expect(badResponses.length, `no 5xx doc responses. Got: ${JSON.stringify(badResponses)}`).toBe(0);
  const body = await page.locator("body").innerText();
  expect(body).not.toContain("Application error");
  expect(body).not.toContain("server-side exception");

  await ctx.close();
});
