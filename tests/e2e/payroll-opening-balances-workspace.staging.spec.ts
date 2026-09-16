// v-slice-1-followup-8 (2026-09-16) — Opening YTD Balances founder
// workspace acceptance on deployed staging.
//
// Proves:
//   A. Payroll Settings → Opening YTD Balances renders + bulk controls
//      are visible for a Payroll Admin.
//   B. CSV template download endpoint returns the canonical header row.
//   C. "Enter opening balance" action on any employee row opens the
//      full-viewport editor dialog with all canonical fields.
//   D. Editor dialog Close/Cancel dismisses safely (no side effects).
//   E. CSV import dialog opens as a full-viewport modal.
//   F. No CSP inline-script violations + no 500.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/payroll-opening-balances-workspace");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.use({ viewport: { width: 1440, height: 900 } });

test("Opening YTD Balances workspace renders + editor + CSV modal reachable", async ({ browser }) => {
  const creds = stagingCredsAvailable();
  test.skip(!creds.ready, creds.reason ?? "staging creds unavailable");
  test.setTimeout(240_000);

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

  // A. Workspace renders.
  await page.goto(`${STAGING}/app/admin/payroll/setup/opening-balances`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(OUT, "01-workspace.png"), fullPage: true });
  await expect(page.locator('[data-testid="payroll-opening-balances-page"]')).toBeVisible();
  await expect(page.locator('[data-testid="opening-balances-workspace"]')).toBeVisible();
  await expect(page.locator('[data-testid="opening-balances-table"]')).toBeVisible();

  // Bulk controls visible for Payroll Admin.
  const bulkValidateBtn = page.locator('[data-testid="opening-balances-bulk-validate-open"]');
  const bulkActivateBtn = page.locator('[data-testid="opening-balances-bulk-activate-open"]');
  const csvOpenBtn = page.locator('[data-testid="opening-balances-open-csv"]');
  await expect(bulkValidateBtn).toBeVisible();
  await expect(bulkActivateBtn).toBeVisible();
  await expect(csvOpenBtn).toBeVisible();

  // B. CSV template downloads a proper CSV.
  const templateResp = await page.request.get(`${STAGING}/app/admin/payroll/setup/opening-balances/template`);
  expect(templateResp.status()).toBe(200);
  const csv = await templateResp.text();
  expect(csv).toMatch(/^employeeNumber,taxYear,/);

  // C. Click the first "Enter opening balance" row action if a row exists.
  const firstRow = page.locator('[data-testid^="opening-balances-open-editor-"]').first();
  if (await firstRow.isVisible().catch(() => false)) {
    await firstRow.click();
    await page.waitForTimeout(600);
    const editorDialog = page.locator('[data-testid="opening-balances-editor-dialog"]');
    await expect(editorDialog).toBeVisible();
    // Verify the dialog spans full viewport width (fixed-position modal).
    const box = await editorDialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(1400);
    await page.screenshot({ path: path.join(OUT, "02-editor-dialog.png"), fullPage: false });

    // Canonical fields visible.
    await expect(page.locator('[data-testid="opening-balances-editor-ytdGrossEarnings"]')).toBeVisible();
    await expect(page.locator('[data-testid="opening-balances-editor-ytdCppEE"]')).toBeVisible();
    await expect(page.locator('[data-testid="opening-balances-editor-ytdEiEE"]')).toBeVisible();
    await expect(page.locator('[data-testid="opening-balances-editor-ytdFederalTax"]')).toBeVisible();
    await expect(page.locator('[data-testid="opening-balances-editor-priorPayrollKind"]')).toBeVisible();

    // D. Cancel/Close dismisses.
    const closeBtn = page.locator('[data-testid="opening-balances-editor-cancel"]');
    await closeBtn.click();
    await page.waitForTimeout(400);
    await expect(editorDialog).not.toBeVisible();
  }

  // E. CSV dialog opens.
  await csvOpenBtn.click();
  await page.waitForTimeout(400);
  const csvDialog = page.locator('[data-testid="opening-balances-csv-dialog"]');
  await expect(csvDialog).toBeVisible();
  await page.screenshot({ path: path.join(OUT, "03-csv-dialog.png"), fullPage: false });
  const csvCancel = page.locator('[data-testid="opening-balances-csv-cancel"]');
  await csvCancel.click();
  await page.waitForTimeout(400);
  await expect(csvDialog).not.toBeVisible();

  // F. Universal guardrails.
  expect(cspViolations.length, `no CSP inline-script violations. Got: ${JSON.stringify(cspViolations)}`).toBe(0);
  expect(badResponses.length, `no 5xx doc responses. Got: ${JSON.stringify(badResponses)}`).toBe(0);
  const body = await page.locator("body").innerText();
  expect(body).not.toContain("Application error");
  expect(body).not.toContain("server-side exception");

  await ctx.close();
});
