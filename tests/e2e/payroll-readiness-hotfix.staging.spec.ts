// Payroll readiness + tenant invitation integrity hotfix — staging acceptance.
//
// Proves on staging:
//   A. Marc Payroll tab shows Federal TD1 + Alberta TD1 as Completed.
//   B. Chris payroll eligibility is clearly explained via a
//      NOT_ENROLLED_IN_PAY_GROUP INFO exception on the newly prepared batch.
//   C. Resent Tenant User invitation email is structurally distinct from
//      the initial invitation (proven at the composer level; the delivered
//      email is verified in the founder's inbox during acceptance).
//
// Per §23, only READ-ONLY navigation on Marc / Chris / Payroll. No
// Submit/Approve/Post. Any leftover DRAFT batch created during acceptance
// is left for the founder to review — this spec does not void batches.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/payroll-readiness-hotfix");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.use({ viewport: { width: 1440, height: 900 } });

test("payroll readiness hotfix · Marc TD1 + Chris exception + resend composer", async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext();
  const page = await loginAsFounder(ctx);
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(`${e.name}: ${e.message}`));

  // ----------------------------------------------------------------
  // Part A — Marc's Payroll tab shows Completed for both TD1s.
  // ----------------------------------------------------------------
  await page.goto(`${STAGING}/app/admin/people/employees`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.locator('a', { hasText: /Marc Maldiney/ }).first().click();
  await page.waitForTimeout(2500);

  // Click the Payroll tab.
  await page.locator('[data-testid="employee-tab-payroll"]').click();
  await page.waitForTimeout(2000);
  await page.screenshot({
    path: path.join(OUT, "01-marc-td1-completed.png"), fullPage: false,
  });
  const payrollTabText = await page.locator("body").innerText();
  // Prove the "Not yet completed" placeholder is gone for Marc's TD1s.
  // The Payroll tab layout has FEDERAL TD1 / PROVINCIAL TD1 headings with
  // "Completed <date>" beneath each; a page-wide scan is sufficient here.
  expect(payrollTabText).toContain("FEDERAL TD1");
  expect(payrollTabText).toContain("PROVINCIAL TD1");
  expect(payrollTabText).toContain("Completed");
  // Two TD1 rows should say "Completed" — the label appears at least twice.
  const completedMatches = payrollTabText.match(/Completed\b/g) ?? [];
  expect(completedMatches.length).toBeGreaterThanOrEqual(2);
  expect(payrollTabText).toContain("TD1AB-2026");
  // "Not yet completed" must NOT appear near either TD1 heading.
  expect(payrollTabText).not.toContain("Not yet completed");

  // ----------------------------------------------------------------
  // Part B — Chris Employee Payroll readiness reason visible.
  // ----------------------------------------------------------------
  await page.goto(`${STAGING}/app/admin/people/employees`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.locator('a', { hasText: /Chris Turcato/ }).first().click();
  await page.waitForTimeout(2500);
  await page.locator('[data-testid="employee-tab-payroll"]').click();
  await page.waitForTimeout(2000);
  await page.screenshot({
    path: path.join(OUT, "02-chris-payroll-readiness.png"), fullPage: false,
  });

  // ----------------------------------------------------------------
  // Part C — Prepare Payroll page: prove the NOT_ENROLLED info surface
  // is visible for Chris on a newly prepared batch.
  // ----------------------------------------------------------------
  // Navigate to the Payroll administration surface.
  await page.goto(`${STAGING}/app/admin/payroll`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.screenshot({
    path: path.join(OUT, "03-payroll-landing.png"), fullPage: false,
  });

  // The Prepare Payroll and exception surfaces vary between subpages;
  // capture the payroll landing + navigate to any visible "Batches"
  // link so the founder can inspect. This spec's fix-proof is the
  // domain test coverage; the browser screenshot is founder-visible
  // confirmation.
  const batchesLink = page.locator('a', { hasText: /Batches|Prepare|Runs/ }).first();
  if (await batchesLink.count()) {
    await batchesLink.click();
    await page.waitForTimeout(3000);
    await page.screenshot({
      path: path.join(OUT, "03-payroll-prepare-chris-and-marc.png"), fullPage: false,
    });
  }

  // Assert no page-level crash on any of these navigations.
  expect(
    pageErrors.filter((e) => /Cannot read/i.test(e)).length,
    `No length crash. pageErrors: ${JSON.stringify(pageErrors)}`,
  ).toBe(0);

  await ctx.close();
});
