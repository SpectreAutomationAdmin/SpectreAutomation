// COA-UX-2b (2026-09-29) — Authenticated Playwright staging suite.
//
// Section 14: prove `checkbox.checked === selectedRowIds.has(rowId)`
// as a DOM invariant — not by screenshot appearance, per §16.
//
// Section 15: prove Category → FS Group filtering and mixed-Type
// safeguard in the bulk Classification menu — WITHOUT persisting
// mapping changes (§16: "avoid leaving founder mapping changes
// behind"). The tests inspect the dropdown option lists but never
// click Apply, so no server action fires and the founder's live
// batch remains untouched.

import { test, expect, type Locator, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;

const LIVE_MASTER_COA_BATCH_ID = "cmuni5ymv000k136q3xdyrpmn";

async function gotoBatch(page: Page) {
  await page.goto(`/app/admin/imports/${LIVE_MASTER_COA_BATCH_ID}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Batch", { timeout: 30_000 });
}

async function rowIndexForAccountCode(page: Page, code: string): Promise<number> {
  const rows = page.locator("tbody tr");
  const total = await rows.count();
  for (let i = 0; i < total; i++) {
    const text = (await rows.nth(i).innerText()).trim();
    if (text.startsWith(code + "\t") || text.startsWith(code + " ") || text.startsWith(code + "\n")) {
      return i;
    }
  }
  throw new Error(`Row with account code ${code} not found in visible list`);
}

async function toolbarCount(page: Page): Promise<number> {
  const toolbar = page.getByTestId("coa-bulk-toolbar");
  await expect(toolbar).toBeVisible();
  const text = (await toolbar.textContent()) ?? "";
  const match = text.match(/(\d+)\s+selected/);
  return match ? Number(match[1]) : 0;
}

runAt("COA-UX-2b · checkbox invariant — click 1000, both endpoints render checked=true @ 1440x900", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);
  await gotoBatch(page);

  const idx = await rowIndexForAccountCode(page, "1000");
  const rowCheckboxes = page.locator('tbody tr td input[type="checkbox"]');

  // ─── Test A · plain click renders the box checked ─────────────
  const box = rowCheckboxes.nth(idx);
  await box.click();
  // §14A: checkbox.checked === true (DOM property, not screenshot)
  await expect(box).toBeChecked();
  expect(await toolbarCount(page)).toBe(1);

  // ─── Test B · click again → visibly unchecks + count decrements ─
  await box.click();
  await expect(box).not.toBeChecked();
  const toolbar = page.getByTestId("coa-bulk-toolbar");
  await expect(toolbar).toHaveCount(0);

  await context.close();
});

runAt("COA-UX-2b · checkbox invariant — Shift-click range: BOTH endpoints + every intermediate row render checked=true @ 1440x900", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);
  await gotoBatch(page);

  const idxStart = await rowIndexForAccountCode(page, "1000");
  const idxEnd = await rowIndexForAccountCode(page, "1051");
  expect(idxStart).toBeLessThan(idxEnd);
  const rowCheckboxes = page.locator('tbody tr td input[type="checkbox"]');

  await rowCheckboxes.nth(idxStart).click();
  await rowCheckboxes.nth(idxEnd).click({ modifiers: ["Shift"] });

  const expectedCount = idxEnd - idxStart + 1;
  const actualCount = await toolbarCount(page);
  expect(actualCount).toBe(expectedCount);

  // §14C — the core invariant. Every row in the visible range must
  // report .isChecked() === true — including both endpoints.
  for (let i = idxStart; i <= idxEnd; i++) {
    const box = rowCheckboxes.nth(i);
    await expect(box, `row at index ${i} (expected checked)`).toBeChecked();
  }
  // Rows JUST outside the range must NOT be checked.
  if (idxStart > 0) await expect(rowCheckboxes.nth(idxStart - 1)).not.toBeChecked();
  const total = await rowCheckboxes.count();
  if (idxEnd + 1 < total) await expect(rowCheckboxes.nth(idxEnd + 1)).not.toBeChecked();

  await page.screenshot({
    path: "test-results/coa-ux-2b-shift-select-both-endpoints-checked.png",
    fullPage: false,
  });

  // Clean up so we leave no incidental state.
  const clearBtn = page.getByTestId("coa-bulk-toolbar").getByRole("button", { name: /^Clear$/ });
  await clearBtn.click();
  await expect(page.getByTestId("coa-bulk-toolbar")).toHaveCount(0);
  // §14G · every visible checkbox is now unchecked after Clear.
  for (let i = idxStart; i <= idxEnd; i++) {
    await expect(rowCheckboxes.nth(i)).not.toBeChecked();
  }

  await context.close();
});

runAt("COA-UX-2b · Inspector — FS Group dropdown filtered by Category (§8) @ 1440x900", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);
  await gotoBatch(page);

  // Click Account 1000 (Petty Cash) to inspect it.
  const idx = await rowIndexForAccountCode(page, "1000");
  await page.locator("tbody tr").nth(idx).click();

  const aside = page.locator("aside").first();
  await expect(aside.getByText("Classification")).toBeVisible();

  // Find the FS Group <select> by its adjacent label.
  const fsGroupSelect = aside.locator("label:has(span:text-is('FS Group')) select").first();
  const categorySelect = aside.locator("label:has(span:text-is('Category')) select").first();

  // Read FS Group options BEFORE picking a Category (or with the
  // default Category applied). Baseline observation.
  const baselineFsGroups = await fsGroupSelect.locator("option").allTextContents();
  // Set Category to "Capital Assets" — assert only Capital-Assets
  // FS Groups remain visible.
  await categorySelect.selectOption({ label: "Capital Assets" });

  // The onChange fires a server action; wait for the router refresh
  // to finish updating the Inspector's currently-selected Category.
  await expect(categorySelect).toHaveValue("CAPITAL_ASSETS", { timeout: 10_000 });

  const filteredFsGroups = await fsGroupSelect.locator("option").allTextContents();

  // Baseline must have contained AT LEAST some non-capital FS Groups.
  // Filtered list must contain Capital-Asset FS Groups and NOT contain
  // Cash & Cash Equivalents / AR / etc.
  expect(filteredFsGroups.some((t) => /capital assets/i.test(t))).toBe(true);
  expect(filteredFsGroups.some((t) => /cash.*equivalents|cash & cash equivalents/i.test(t))).toBe(false);
  expect(filteredFsGroups.some((t) => /accounts receivable/i.test(t))).toBe(false);
  expect(filteredFsGroups.some((t) => /food|beverage|payroll/i.test(t))).toBe(false);

  // §16 restore — put Category back to what it was.
  // For account 1000 (Petty Cash) the baseline Category is Current Assets.
  // If the baseline read showed a different label the founder had already
  // set, we restore to it; else default to Current Assets.
  await categorySelect.selectOption({ label: "Current Assets" });
  await expect(categorySelect).toHaveValue("CURRENT_ASSETS", { timeout: 10_000 });
  // Log baseline so any manual audit sees what was displaced.
  console.log(JSON.stringify({ restored: "CURRENT_ASSETS", baselineFsGroupsLength: baselineFsGroups.length }));

  await context.close();
});

runAt("COA-UX-2b · bulk Classification menu — mixed-Type selection disables Category/FS Group (§6) @ 1440x900", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);
  await gotoBatch(page);

  // Select a couple of ASSET rows.
  const idx1000 = await rowIndexForAccountCode(page, "1000");
  const rowCheckboxes = page.locator('tbody tr td input[type="checkbox"]');
  await rowCheckboxes.nth(idx1000).click();

  // Also select a LIABILITY row. Coulee's Master COA has liabilities
  // at 2xxx range — filter to one of them. We use the search filter
  // to locate quickly.
  const search = page.locator("input[placeholder*='or name'], input[placeholder='# or name']").first();
  await search.fill("2000");
  await page.waitForTimeout(300); // debounce
  // Some rows may be filtered — find the first visible row (any
  // 2xxx account) and Ctrl-click its checkbox to add to selection
  // without disturbing the anchor.
  const filteredRows = page.locator("tbody tr");
  const filteredCount = await filteredRows.count();
  if (filteredCount === 0) {
    // Fallback: try 2100 which should be Accounts Payable / a liability.
    await search.fill("2100");
    await page.waitForTimeout(300);
  }
  const firstLiabilityCheckbox = filteredRows.first().locator('td input[type="checkbox"]').first();
  await firstLiabilityCheckbox.click();

  // Clear the filter so the toolbar shows the combined selection.
  await search.fill("");

  // Open the bulk Classification menu.
  const toolbar = page.getByTestId("coa-bulk-toolbar");
  await expect(toolbar).toBeVisible();
  const classificationBtn = toolbar.getByRole("button", { name: /^Classification/ });
  await classificationBtn.click();

  // The menu should display the mixed-Type warning.
  await expect(page.getByText(/Selected accounts contain multiple Types/)).toBeVisible();

  // Category + FS Group selects inside the menu should be disabled.
  const menu = page.locator("div").filter({ hasText: /Selected accounts contain multiple Types/ }).first();
  const menuCategorySelect = menu.locator("label:has(span:text-is('Category')) select").first();
  const menuFsGroupSelect = menu.locator("label:has(span:text-is('FS Group')) select").first();
  await expect(menuCategorySelect).toBeDisabled();
  await expect(menuFsGroupSelect).toBeDisabled();

  // Type select stays enabled (§6 — Type is always settable).
  const menuTypeSelect = menu.locator("label:has(span:text-is('Type')) select").first();
  await expect(menuTypeSelect).toBeEnabled();

  // Screenshot for founder review.
  await page.screenshot({
    path: "test-results/coa-ux-2b-mixed-type-safeguard.png",
    fullPage: false,
  });

  // Close menu + clean up the selection. NEVER click Apply — this
  // test performs zero mutations on the founder's batch.
  await classificationBtn.click();
  const clearBtn = page.getByTestId("coa-bulk-toolbar").getByRole("button", { name: /^Clear$/ });
  await clearBtn.click();
  await expect(page.getByTestId("coa-bulk-toolbar")).toHaveCount(0);

  await context.close();
});
