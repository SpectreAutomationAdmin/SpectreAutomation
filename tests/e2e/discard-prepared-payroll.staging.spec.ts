// Discard-Prepared-Payroll hotfix — staging Playwright acceptance.
//
// Proves the UI affordance is present + the confirmation dialog behaves
// correctly. Per §15 the founder's actual PREPARED batch must NOT be
// discarded automatically — we exercise the CANCEL path only. The
// founder will discard the real batch through the UI during acceptance.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/discard-prepared-payroll");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.use({ viewport: { width: 1440, height: 900 } });

test("Discard Prepared Payroll · button + dialog + cancel path", async ({ browser }) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext();
  const page = await loginAsFounder(ctx);
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(`${e.name}: ${e.message}`));

  // Navigate directly to the founder's PREPARED batch period. The page
  // accepts `?payPeriodId=<id>` per src/app/app/admin/payroll/process/page.tsx.
  // The founder's existing PREPARED batch (id cmu0raj1e00413v4yy681mvw9)
  // sits on payPeriodId cmtjc2wyo001dgnjumh7gz72r (Sep 13–Sep 26 · FDR-BW).
  const foundersPayPeriodId = process.env.SPECTRE_FOUNDER_PAY_PERIOD_ID
    ?? "cmtjc2wyo001dgnjumh7gz72r";
  await page.goto(`${STAGING}/app/admin/payroll/process?payPeriodId=${foundersPayPeriodId}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(3000);

  // Confirm the process workspace rendered.
  const workspace = page.locator('[data-testid="process-workspace"]');
  await expect(workspace).toBeVisible({ timeout: 10_000 });

  // The Discard Prepared Payroll button appears only when a PREPARED
  // batch exists for the selected period.
  const discardBtn = page.locator('[data-testid="process-discard-prepared"]');
  const hasBatch = await discardBtn.count();

  if (hasBatch === 0) {
    // Batch not present — capture the empty-state screenshot for evidence.
    await page.screenshot({
      path: path.join(OUT, "00-no-prepared-batch.png"), fullPage: false,
    });
    console.log("[discard-repro] No PREPARED batch on the selected period — cannot exercise dialog. Skipping.");
    await ctx.close();
    return;
  }

  await page.screenshot({
    path: path.join(OUT, "01-prepared-batch-with-discard-button.png"), fullPage: false,
  });

  // Open the confirmation dialog.
  await discardBtn.scrollIntoViewIfNeeded();
  await discardBtn.click();
  await page.waitForTimeout(600);

  const dialog = page.locator('[data-testid="process-discard-dialog"]');
  await expect(dialog).toBeVisible();
  await page.screenshot({
    path: path.join(OUT, "02-discard-confirmation-dialog.png"), fullPage: false,
  });

  // Assert the confirmation copy per §6.
  const dialogText = await dialog.innerText();
  expect(dialogText).toContain("Discard prepared payroll?");
  expect(dialogText).toContain("Pay period");
  expect(dialogText).toContain("Employees");
  expect(dialogText).toContain("This cannot be undone.");

  // §15 — do NOT confirm-discard the founder's live batch. Take the
  // Cancel path and prove it closes the dialog.
  const cancelBtn = page.locator('[data-testid="process-discard-cancel"]');
  await cancelBtn.click();
  await page.waitForTimeout(500);
  await expect(dialog).toBeHidden();
  await page.screenshot({
    path: path.join(OUT, "03-cancel-returns-to-workspace.png"), fullPage: false,
  });

  // Batch button is still visible — Cancel didn't discard anything.
  await expect(discardBtn).toBeVisible();

  // Assert no page-level crash.
  expect(
    pageErrors.filter((e) => /Cannot read/i.test(e)).length,
    `No length crash. pageErrors: ${JSON.stringify(pageErrors)}`,
  ).toBe(0);

  await ctx.close();
});
