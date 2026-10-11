// MBR-FIX-2L — AR Aging import page UI acceptance on staging.
//
// The directive requires acceptance BEFORE February is imported.
// This spec therefore validates the UI only — no file is uploaded,
// no preview is run, no commit is performed.  Founder uploads the
// Feb workbook herself through the new interface.
//
// Validates:
//   • /app/admin/imports/ar-aging renders with the upload form.
//   • Form carries file + period-end inputs + Preview button.
//   • Commit button is NOT visible before a successful preview
//     (defence against accidental double-click commit).
//   • Import history table shows the committed Jan 31 batch.
//   • Admin Imports hub links to the new page.

import { test, type Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

runAt(
  "MBR-FIX-2L · Admin Imports hub links to the AR Aging page",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(`${BASE}/app/admin/imports`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const link = page.locator('[data-testid="imports-hub-ar-aging-link"]');
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href).toBe("/app/admin/imports/ar-aging");
    await ctx.close();
  },
);

runAt(
  "MBR-FIX-2L · AR Aging import page renders the upload form + history",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(`${BASE}/app/admin/imports/ar-aging`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3500);

    // Page header + upload form present.
    await expect(page.locator('[data-testid="ar-aging-import-header"]')).toBeVisible();
    await expect(page.locator('[data-testid="ar-aging-import-form"]')).toBeVisible();
    await expect(page.locator('[data-testid="ar-aging-import-file"]')).toBeVisible();
    await expect(page.locator('[data-testid="ar-aging-import-effective-date"]')).toBeVisible();
    await expect(page.locator('[data-testid="ar-aging-import-submit"]')).toBeVisible();

    // Commit button is NOT visible before preview — defence against
    // accidental commit without reviewing reconciliation.
    await expect(page.locator('[data-testid="ar-aging-import-commit"]')).toHaveCount(0);

    // Confirmation modal is NOT in the DOM until opened.
    await expect(page.locator('[data-testid="ar-aging-commit-modal"]')).toHaveCount(0);

    // History table (or empty state).  Staging has the Jan 31 batch
    // committed via AR-HIST-1 — assert the row renders.
    const history = page.locator('[data-testid="ar-aging-import-history"]');
    await expect(history).toBeVisible();
    const janRowText = await page.evaluate(() => (document.body.textContent ?? ""));
    // sourceEffectiveDate "2026-01-31" rendered + COMMITTED badge.
    expect(janRowText).toMatch(/2026-01-31/);
    expect(janRowText).toMatch(/COMMITTED/);

    await ctx.close();
  },
);

runAt(
  "MBR-FIX-2L · Preview submit is disabled until file + period-end are present",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(`${BASE}/app/admin/imports/ar-aging`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3500);

    const submit = page.locator('[data-testid="ar-aging-import-submit"]');
    await expect(submit).toBeDisabled();

    // Fill the date; submit stays disabled without a file.
    await page.locator('[data-testid="ar-aging-import-effective-date"]').fill("2026-02-28");
    await expect(submit).toBeDisabled();

    // Clear date + leave file empty: still disabled.
    await page.locator('[data-testid="ar-aging-import-effective-date"]').fill("");
    await expect(submit).toBeDisabled();

    await ctx.close();
  },
);

async function bodyText(page: Page): Promise<string> {
  return page.evaluate(() => (document.body.textContent ?? "").replace(/\s+/g, " "));
}

runAt(
  "MBR-FIX-2L · Hub historical-imports section lists Jonas GL, AR Aging, Golf Activity",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(`${BASE}/app/admin/imports`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    const txt = await bodyText(page);
    expect(txt).toContain("Historical imports");
    expect(txt).toContain("Jonas GL");
    expect(txt).toContain("AR Aging");
    expect(txt).toContain("Golf Activity");
    await ctx.close();
  },
);
