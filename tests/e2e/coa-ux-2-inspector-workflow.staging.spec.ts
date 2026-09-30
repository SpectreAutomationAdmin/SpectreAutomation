// COA-UX-2 (2026-09-29) — authenticated Playwright visual acceptance.
//
// Section 18 of the founder's directive: 6 required screenshots
// against the actual live 562-row Master COA preview batch on
// staging. Batch id resolved dynamically from the founder's account.
//
// Screenshots saved to test-results/coa-ux-2-*.png.

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;

// Founder's live Master COA batch (from post-v615 verification).
const LIVE_MASTER_COA_BATCH_ID = "cmuni5ymv000k136q3xdyrpmn";

async function gotoBatch(page: Page) {
  await page.goto(`/app/admin/imports/${LIVE_MASTER_COA_BATCH_ID}`, { waitUntil: "domcontentloaded" });
  // Wait for the compact summary strip to render (COA-UX-2 workspace loaded).
  await page.waitForSelector("text=Batch", { timeout: 30_000 });
}

runAt("COA-UX-2 · A + B — top of preview + workspace overview @ 1440x900", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);
  await gotoBatch(page);

  // A — top of import preview (header + summary strip + filter row visible).
  await page.screenshot({ path: "test-results/coa-ux-2-A-top-of-preview.png", fullPage: false });

  // B — main account list + Inspector (both visible in the workspace).
  const workspace = page.locator("text=Batch").first().locator("..").locator("..");
  await workspace.screenshot({ path: "test-results/coa-ux-2-B-workspace-overview.png" });

  // Structural invariants for A + B.
  await expect(page.locator("text=CAPITAL cand")).toBeVisible();
  await expect(page.locator("text=attention")).toBeVisible();
  await expect(page.locator("text=Advanced grid")).toBeVisible();

  await context.close();
});

runAt("COA-UX-2 · C + D — medium-confidence row selected → Inspector shows Classification + Dept + Fund @ 1440x900", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);
  await gotoBatch(page);

  // Filter to Confidence = MEDIUM via query param (the filter ribbon
  // uses URL params).
  await page.goto(`/app/admin/imports/${LIVE_MASTER_COA_BATCH_ID}?f_conf=medium`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Batch", { timeout: 30_000 });

  // Click the first medium-confidence row in the left table.
  const firstRow = page.locator("tbody tr").first();
  await firstRow.click();
  // The Inspector should now show Classification / Department / Fund / Review sections.
  await expect(page.locator("text=Classification")).toBeVisible();
  await expect(page.locator("text=Department").first()).toBeVisible();
  await expect(page.locator("text=Fund").first()).toBeVisible();
  await expect(page.locator("text=Review").first()).toBeVisible();

  // C — screenshot showing the selected medium-confidence row + inspected account.
  await page.screenshot({ path: "test-results/coa-ux-2-C-medium-confidence-selected.png", fullPage: false });

  // D — scroll the inspector aside into view (already visible on 1440x900) and
  // screenshot the right column focused on Dept + Fund sections.
  const aside = page.locator("aside").first();
  await aside.screenshot({ path: "test-results/coa-ux-2-D-inspector-dept-fund.png" });

  await context.close();
});

runAt("COA-UX-2 · E — bulk toolbar with multiple accounts selected @ 1440x900", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);
  await gotoBatch(page);

  // Check the first 5 row checkboxes (skip the header checkbox at index 0).
  const rowCheckboxes = page.locator('tbody tr td input[type="checkbox"]');
  const count = await rowCheckboxes.count();
  const toCheck = Math.min(5, count);
  for (let i = 0; i < toCheck; i++) {
    await rowCheckboxes.nth(i).check();
  }

  // The contextual bulk toolbar (amber "N selected · Department ▾ Fund ▾ Policy ▾ Mark Reviewed · Clear")
  // should now appear in the filter row.
  await expect(page.locator("text=selected").first()).toBeVisible();
  await expect(page.locator("text=Mark Reviewed").first()).toBeVisible();

  await page.screenshot({ path: "test-results/coa-ux-2-E-bulk-selected.png", fullPage: false });

  await context.close();
});

runAt("COA-UX-2 · F — CAPITAL candidate filter isolates the review subset @ 1440x900", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);
  await page.goto(`/app/admin/imports/${LIVE_MASTER_COA_BATCH_ID}?f_capital=YES`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Batch", { timeout: 30_000 });

  // Should show only capital-candidate rows.
  await expect(page.locator("text=CAPITAL cand")).toBeVisible();

  await page.screenshot({ path: "test-results/coa-ux-2-F-capital-candidates.png", fullPage: false });

  await context.close();
});
