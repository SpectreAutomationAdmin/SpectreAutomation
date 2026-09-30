// COA-UX-2a (2026-09-29) — authenticated Playwright staging verification.
//
// Drives the canonical desktop range-selection scenario against the
// founder's live Master COA preview batch on staging:
//
//   1. click checkbox on Account 1000 row
//   2. Shift-click checkbox on Account 1051 row (across the current
//      visible display order)
//   3. assert the bulk toolbar's "N selected" count matches the
//      number of visible rows between 1000 and 1051 inclusive
//   4. screenshot for founder review
//   5. clear the selection so the batch is not left with incidental
//      test UI state
//
// This test performs NO mutation. It only exercises client-side
// checkbox state.

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;

const LIVE_MASTER_COA_BATCH_ID = "cmuni5ymv000k136q3xdyrpmn";

async function gotoBatch(page: Page) {
  await page.goto(`/app/admin/imports/${LIVE_MASTER_COA_BATCH_ID}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Batch", { timeout: 30_000 });
}

// Locate the row whose account code label starts with the given code.
// The left table renders account code in the first data column.
async function rowIndexForAccountCode(page: Page, code: string): Promise<number> {
  const rows = page.locator("tbody tr");
  const total = await rows.count();
  for (let i = 0; i < total; i++) {
    const text = (await rows.nth(i).innerText()).trim();
    // Account code usually starts the row; match at the beginning.
    if (text.startsWith(code + "\t") || text.startsWith(code + " ") || text.startsWith(code + "\n")) {
      return i;
    }
  }
  throw new Error(`Row with account code ${code} not found in visible list`);
}

runAt("COA-UX-2a · Shift-click 1000 → 1051 selects the contiguous visible range @ 1440x900", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);
  await gotoBatch(page);

  // Find both anchor rows.
  const idxStart = await rowIndexForAccountCode(page, "1000");
  const idxEnd = await rowIndexForAccountCode(page, "1051");
  const expectedCount = Math.abs(idxEnd - idxStart) + 1;
  // Sanity: this range shouldn't be tiny or absurdly large.
  expect(expectedCount).toBeGreaterThanOrEqual(2);
  expect(expectedCount).toBeLessThanOrEqual(60);

  const rowCheckboxes = page.locator('tbody tr td input[type="checkbox"]');

  // 1. Plain click Account 1000 checkbox (sets anchor).
  await rowCheckboxes.nth(idxStart).click();

  // 2. Shift-click Account 1051 checkbox (extends the range across
  //    the current display order).
  await rowCheckboxes.nth(idxEnd).click({ modifiers: ["Shift"] });

  // 3. Bulk toolbar should now report exactly `expectedCount` selected.
  const toolbar = page.locator("text=/\\d+ selected/").first();
  await expect(toolbar).toBeVisible();
  const toolbarText = await toolbar.textContent();
  expect(toolbarText).toMatch(new RegExp(`^${expectedCount} selected`));

  // 4. Screenshot for founder review — full page shows the amber
  //    toolbar + the contiguous checked column.
  await page.screenshot({
    path: "test-results/coa-ux-2a-shift-select-1000-to-1051.png",
    fullPage: false,
  });

  // 5. Clear Selection so we leave no incidental state on the batch UI.
  //    The contextual bulk toolbar carries data-testid="coa-bulk-toolbar"
  //    and unmounts when nothing is selected — asserting that container
  //    disappears is the least-brittle invariant.
  const clearBtn = page.getByTestId("coa-bulk-toolbar").getByRole("button", { name: /^Clear$/ });
  await clearBtn.click();
  await expect(page.getByTestId("coa-bulk-toolbar")).toHaveCount(0);

  await context.close();
});

runAt("COA-UX-2a · reverse direction: Shift-click 1051 → 1000 also selects the same range @ 1440x900", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);
  await gotoBatch(page);

  const idxStart = await rowIndexForAccountCode(page, "1051");
  const idxEnd = await rowIndexForAccountCode(page, "1000");
  const expectedCount = Math.abs(idxEnd - idxStart) + 1;

  const rowCheckboxes = page.locator('tbody tr td input[type="checkbox"]');
  await rowCheckboxes.nth(idxStart).click();
  await rowCheckboxes.nth(idxEnd).click({ modifiers: ["Shift"] });

  const toolbar = page.locator("text=/\\d+ selected/").first();
  await expect(toolbar).toBeVisible();
  const toolbarText = await toolbar.textContent();
  expect(toolbarText).toMatch(new RegExp(`^${expectedCount} selected`));

  await page.screenshot({
    path: "test-results/coa-ux-2a-shift-select-reverse-1051-to-1000.png",
    fullPage: false,
  });

  const clearBtn = page.getByTestId("coa-bulk-toolbar").getByRole("button", { name: /^Clear$/ });
  await clearBtn.click();
  await expect(page.getByTestId("coa-bulk-toolbar")).toHaveCount(0);

  await context.close();
});

runAt("COA-UX-2a · plain click does NOT extend a prior range — anchor resets @ 1440x900", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);
  await gotoBatch(page);

  const idx1000 = await rowIndexForAccountCode(page, "1000");
  const idx1051 = await rowIndexForAccountCode(page, "1051");
  const rowCheckboxes = page.locator('tbody tr td input[type="checkbox"]');

  // Click 1000 (anchor) then plain-click 1051 (does not extend).
  await rowCheckboxes.nth(idx1000).click();
  await rowCheckboxes.nth(idx1051).click();

  // Only 2 rows selected (not the whole range between them).
  const toolbar = page.locator("text=/\\d+ selected/").first();
  await expect(toolbar).toBeVisible();
  const txt = await toolbar.textContent();
  expect(txt).toMatch(/^2 selected/);

  const clearBtn = page.getByTestId("coa-bulk-toolbar").getByRole("button", { name: /^Clear$/ });
  await clearBtn.click();
  await expect(page.getByTestId("coa-bulk-toolbar")).toHaveCount(0);

  await context.close();
});
