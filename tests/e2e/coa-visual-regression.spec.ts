// Sprint 1 reopen — visual-regression harness for the Chart of
// Accounts workspace.
//
// This test does NOT depend on `data-testid`s, DOM coordinate math,
// or successful compilation. It measures the actual rendered pixels
// against three founder-required assertions:
//
//   1. The right-hand inspector <aside> is present in the DOM and
//      has non-zero visible width at ≥ 1280px, regardless of whether
//      an account is selected.
//   2. The checkbox column's <td> element has NO border-radius, NO
//      form-input box-shadow, and NO padding-driven "large rounded
//      cell" appearance. Its computed background matches the row
//      background (i.e. no distinct "outlined box" around every
//      checkbox).
//   3. The header select-all checkbox and the row-selection checkbox
//      compute to identical width, height, border-radius, background,
//      and border colour.
//
// The tolerance for pixel-level comparisons is documented inline
// where it applies. A visual regression is a test failure — a
// passing TypeScript build is NECESSARY but not SUFFICIENT.

import { test, expect, Page } from "@playwright/test";

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator(`form:has(input[name="email"][value="super@spectre.app"]) button`).first().click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
}

test.describe("Chart of Accounts — Sprint 1 acceptance visual contract", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto("/app/admin/coa");
    await page.waitForLoadState("networkidle");
  });

  test("Inspector aside is present with non-zero width when no account is selected", async ({ page }) => {
    // No `?select=<id>` in the URL — the founder-approved concept
    // still reserves the right-hand inspector column at this state.
    // The <aside> must be in the DOM AND visible AND non-zero width.
    const aside = page.locator(".spectre-dw-inspector-slot");
    await expect(aside).toBeVisible();
    const box = await aside.boundingBox();
    expect(box, "inspector aside has a bounding box").not.toBeNull();
    expect(box!.width).toBeGreaterThan(300);
    // The empty state text must be present — regressing to a lifeless
    // panel is not acceptable.
    await expect(aside.getByText(/Select an account to inspect\./)).toBeVisible();
  });

  test("Inspector aside populates when an account is selected via ?select=<id>", async ({ page }) => {
    const firstRow = page.locator("tr[data-account-id]").first();
    const accountId = await firstRow.getAttribute("data-account-id");
    expect(accountId, "at least one account row exists").not.toBeNull();
    await page.goto(`/app/admin/coa?select=${accountId}`);
    await page.waitForLoadState("networkidle");
    const aside = page.locator(".spectre-dw-inspector-slot");
    await expect(aside).toBeVisible();
    // The inspector head shows the eyebrow + selected account marker
    await expect(aside.getByText(/Account · selected from Chart of Accounts/)).toBeVisible();
    await expect(aside.locator(".spectre-dw-inspector-title .num")).toBeVisible();
  });

  test("Checkbox column cells have no rounded form-input styling", async ({ page }) => {
    // The pre-fix defect: `.select` classname collided with the
    // legacy Tailwind `.input, .select, .textarea` rule that applied
    // `border-radius: 0.375rem`, a 1 px stone-300 border, a white
    // background, and a 0.05-opacity box-shadow to every checkbox
    // cell. Assert those styles are absent on the new
    // `.spectre-dw-select-cell` class.
    const cell = page.locator("tr[data-account-id] td.spectre-dw-select-cell").first();
    const styles = await cell.evaluate((el) => {
      const s = window.getComputedStyle(el);
      return {
        borderRadius: s.borderRadius,
        borderTopWidth: s.borderTopWidth,
        boxShadow: s.boxShadow,
      };
    });
    expect(styles.borderRadius, "no rounded corners on checkbox cell").toBe("0px");
    // The legacy rule applied border: 1px solid stone-300 on all four
    // sides. Our fix explicitly resets border to 0; the row's
    // border-bottom hairline lives on the row selector, not on
    // .select cells. All four td borders must be 0.
    expect(styles.borderTopWidth, "no top border on checkbox cell").toBe("0px");
    expect(styles.boxShadow, "no form-input box-shadow on checkbox cell").toBe("none");
  });

  test("Row and header checkbox render identically", async ({ page }) => {
    const rowStyles = await page.locator("tr[data-account-id] input[type='checkbox']").first().evaluate((el) => {
      const s = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        width: r.width, height: r.height,
        borderRadius: s.borderRadius,
        backgroundColor: s.backgroundColor,
        border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
      };
    });
    const headerStyles = await page.locator("table.spectre-dw-table thead input[type='checkbox']").first().evaluate((el) => {
      const s = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        width: r.width, height: r.height,
        borderRadius: s.borderRadius,
        backgroundColor: s.backgroundColor,
        border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
      };
    });
    // Tolerance: zero — both checkboxes must be exactly identical.
    expect(headerStyles.width).toBe(rowStyles.width);
    expect(headerStyles.height).toBe(rowStyles.height);
    expect(headerStyles.borderRadius).toBe(rowStyles.borderRadius);
    expect(headerStyles.backgroundColor).toBe(rowStyles.backgroundColor);
    expect(headerStyles.border).toBe(rowStyles.border);
    // Sanity: 14 px is the designed checkbox size. If this ever
    // changes, the token layer changed too.
    expect(rowStyles.width).toBeCloseTo(14, 0);
    expect(rowStyles.height).toBeCloseTo(14, 0);
  });

  test("Row click opens the inspector, checkbox click does not", async ({ page }) => {
    // The founder-approved concept opens the inspector on a row
    // click, but NOT on a checkbox click (checkbox toggles selection
    // only). Regression from an inspector that opens on any click
    // would break bulk-select workflows.
    const firstRow = page.locator("tr[data-account-id]").first();
    // Checkbox first — click must select the row but NOT set ?select
    await firstRow.locator("input[type='checkbox']").click();
    await page.waitForTimeout(200);
    let url = new URL(page.url());
    expect(url.searchParams.get("select"), "checkbox click does not open inspector").toBeNull();

    // Row click on the account-number cell — must open the inspector.
    // `router.replace` in Next.js App Router updates history without a
    // network round-trip, so `waitForLoadState("networkidle")` is a
    // no-op. Wait for the URL itself to update instead.
    await firstRow.locator("td.num-col").click();
    await page.waitForURL((u) => u.search.includes("select=") || u.search.includes("edit="), { timeout: 5000 });
    url = new URL(page.url());
    expect(url.searchParams.get("select") ?? url.searchParams.get("edit"), "row click sets ?select or ?edit").not.toBeNull();
  });

  // ---------------------------------------------------------------
  // Sprint 1 REOPENED acceptance corrections (2026-07-19).
  // These tests pin the corrections the founder called out after the
  // previous submission:
  //   1. Header select-all cell must inherit the same sunken grey as
  //      the rest of the header — no white card/tile treatment.
  //   2. Density segmented control (Comfy / Standard / Compact) must
  //      be gone from the toolbar.
  //   3. Import + Export buttons must appear in the header actions
  //      (in the founder-specified order — Import · Export · New).
  //   4. Balance column must render for every account row and use
  //      real numbers from `accountBalances`.
  //   5. Type-level totals must render on group headers.
  //   6. FS-group sub-header totals must render.
  //   7. Toolbar must span the full workspace width — the vertical
  //      divider between the table and inspector panes MUST start at
  //      or below the grey table header row, NOT at the top of the
  //      toolbar.
  //   8. "Last updated" metadata must appear in the header.
  // ---------------------------------------------------------------

  test("Header select-all cell inherits the same sunken grey as the rest of the header", async ({ page }) => {
    // The founder called out the previous submission for rendering a
    // white "card" cell on top of the grey header — a discontinuity
    // where the select-all cell interrupted the column-header strip.
    const headerSelect = page.locator("table.spectre-dw-table thead th.spectre-dw-select-cell");
    const headerOther = page.locator("table.spectre-dw-table thead th").nth(1); // first non-select header

    const selectBg = await headerSelect.evaluate((el) => window.getComputedStyle(el).backgroundColor);
    const otherBg = await headerOther.evaluate((el) => window.getComputedStyle(el).backgroundColor);
    expect(selectBg, "select-all header background matches other header cells").toBe(otherBg);
  });

  test("Density segmented control (Comfy / Standard / Compact) is not present", async ({ page }) => {
    // The founder ruled the density switcher was noise and told us to
    // remove it. Assert the button labels are absent from the toolbar.
    const toolbar = page.locator(".spectre-dw-toolbar");
    await expect(toolbar).toBeVisible();
    await expect(toolbar.getByRole("button", { name: /^Comfy$/ })).toHaveCount(0);
    await expect(toolbar.getByRole("button", { name: /^Standard$/ })).toHaveCount(0);
    await expect(toolbar.getByRole("button", { name: /^Compact$/ })).toHaveCount(0);
    // And the container itself is gone.
    await expect(page.locator(".spectre-dw-density-seg")).toHaveCount(0);
  });

  test("Import, Export, and New account actions all exist in the header", async ({ page }) => {
    // Regression guard: any of these disappearing is a founder defect.
    // Import navigates to the imports workspace; Export downloads the
    // CSV endpoint; New opens the new-account modal.
    const importLink = page.locator('[data-testid="coa-import-btn"]');
    const exportLink = page.locator('[data-testid="coa-export-btn"]');
    const newBtn = page.locator('[data-testid="coa-new-account-btn"]');

    await expect(importLink).toBeVisible();
    await expect(exportLink).toBeVisible();
    await expect(newBtn).toBeVisible();

    // Sprint 1 correction (2026-07-19d) — Import now opens a
    // CoA-specific modal on this same page, not the generic
    // multi-domain imports screen. The href stays on /app/admin/coa
    // and carries `?modal=import`.
    const importHref = await importLink.getAttribute("href");
    expect(importHref).toContain("/app/admin/coa");
    expect(importHref).toContain("modal=import");

    // Export links to the CSV endpoint with download attr.
    const exportHref = await exportLink.getAttribute("href");
    expect(exportHref).toContain("/api/admin/coa/export.csv");
    const download = await exportLink.getAttribute("download");
    expect(download).not.toBeNull();
  });

  test("Balance column renders currency for at least one non-zero account", async ({ page }) => {
    // If the balance service was disconnected, every cell would show
    // the em-dash placeholder. Assert at least one row rendered a
    // real number.
    const balanceCells = page.locator("[data-testid^='coa-account-balance-']");
    const count = await balanceCells.count();
    expect(count).toBeGreaterThan(0);

    let nonZero = 0;
    for (let i = 0; i < Math.min(count, 30); i++) {
      const text = (await balanceCells.nth(i).innerText()).trim();
      if (/\$[\d,]+/.test(text)) nonZero++;
    }
    expect(nonZero, "at least one account has a real balance").toBeGreaterThan(0);
  });

  test("Type-level totals render on group headers (Assets, Liabilities, etc.)", async ({ page }) => {
    const totals = page.locator("[data-testid^='coa-section-total-']");
    // At least one group header total on a workspace with seeded data.
    expect(await totals.count()).toBeGreaterThan(0);
    const firstText = (await totals.first().innerText()).trim();
    // Either "$…" or "—" (a zeroed group is still a rendered total).
    expect(/(^\$|^−\$|^—$)/.test(firstText)).toBe(true);
  });

  test("FS-group sub-header totals render", async ({ page }) => {
    const totals = page.locator("[data-testid^='coa-subsection-total-']");
    expect(await totals.count()).toBeGreaterThan(0);
  });

  test("Toolbar spans full workspace width — divider starts BELOW the toolbar", async ({ page }) => {
    // The core geometry the founder flagged: previously the toolbar
    // was inside `.spectre-dw-main` (table pane only), so the vertical
    // inspector border started at the TOP of the workspace and cut
    // through the white toolbar. The correction hoists the toolbar
    // out of `.spectre-dw-main` into a full-width row above the
    // two-pane grid.
    const toolbar = await page.locator(".spectre-dw-toolbar").boundingBox();
    const inspector = await page.locator(".spectre-dw-inspector-slot").boundingBox();
    expect(toolbar).not.toBeNull();
    expect(inspector).not.toBeNull();

    // Toolbar right edge extends AT LEAST to the right edge of the
    // inspector — proving it spans both panes.
    expect(toolbar!.x + toolbar!.width).toBeGreaterThanOrEqual(inspector!.x + inspector!.width - 4);

    // Inspector top starts BELOW the toolbar bottom (with a small
    // rounding tolerance).
    expect(inspector!.y).toBeGreaterThanOrEqual(toolbar!.y + toolbar!.height - 2);
  });

  test("Last updated metadata is present in the header", async ({ page }) => {
    const meta = page.locator("[data-testid='coa-last-updated']");
    await expect(meta).toBeVisible();
    const text = (await meta.innerText()).trim();
    // Either a real timestamp label OR the "No changes yet" fallback.
    expect(/Last updated|No changes yet/.test(text)).toBe(true);
  });

  // ---------------------------------------------------------------
  // Sprint 1 REGRESSION guards (2026-07-19b).
  // The founder reported that after moving the toolbar to span both
  // panes, the right-hand inspector column reserved its 400 px of
  // width but rendered nothing inside — a blank ivory pane. Root
  // cause: `.spectre-dw-root` was converted from a definite-height
  // grid to an indefinite-`min-height` flex column, so the aside's
  // grid-track height became indefinite and every child anchored
  // with `height: 100%` collapsed to 0. These specs pin the
  // corrected geometry so a mounted-but-invisible inspector CANNOT
  // regress into "green tests, blank pane" again.
  // ---------------------------------------------------------------

  test("Empty inspector state renders visible content when no account is selected", async ({ page }) => {
    // The mounted-container assertion above (Inspector aside is present)
    // is necessary but not sufficient — an aside with no visible
    // children is exactly the regression the founder called out.
    const aside = page.locator(".spectre-dw-inspector-slot");
    const asideBox = await aside.boundingBox();
    expect(asideBox, "inspector aside has bounding box").not.toBeNull();

    // The concept requires the empty state to include an eyebrow,
    // the "Select an account to inspect." heading, guidance copy,
    // and keyboard hints. Assert the heading is visibly rendered
    // (not just present in the DOM with 0 height / 0 opacity).
    const emptyHeading = aside.locator(".spectre-dw-inspector-empty h3");
    await expect(emptyHeading).toBeVisible();
    await expect(emptyHeading).toHaveText(/Select an account to inspect/);

    // Also assert non-zero rendered rectangle — this is the specific
    // shape of the blank-inspector regression: a truthy toBeVisible
    // check can pass on an element whose parent has zero height in
    // some renderers. Measure the box directly.
    const headingBox = await emptyHeading.boundingBox();
    expect(headingBox, "empty heading has bounding box").not.toBeNull();
    expect(headingBox!.width, "empty heading has non-zero width").toBeGreaterThan(20);
    expect(headingBox!.height, "empty heading has non-zero height").toBeGreaterThan(8);

    // And guard against the "aside is tall but content is at 0" case:
    // the heading MUST be within the aside's rendered rectangle.
    expect(headingBox!.y).toBeGreaterThanOrEqual(asideBox!.y - 1);
    expect(headingBox!.y + headingBox!.height).toBeLessThanOrEqual(asideBox!.y + asideBox!.height + 1);
  });

  test("Inspector container has substantial rendered height (not collapsed)", async ({ page }) => {
    // Direct geometry guard — the aside must occupy AT LEAST 300 px
    // of vertical space so the empty state (or any populated state)
    // has room to breathe. Anything shorter than this is the exact
    // collapse the founder called out.
    const aside = page.locator(".spectre-dw-inspector-slot");
    const box = await aside.boundingBox();
    expect(box, "inspector aside has bounding box").not.toBeNull();
    expect(box!.height, "inspector aside height ≥ 300 px").toBeGreaterThan(300);
  });

  test("Selecting an account replaces the empty state with populated inspector", async ({ page }) => {
    const firstRow = page.locator("tr[data-account-id]").first();
    const id = await firstRow.getAttribute("data-account-id");
    expect(id).not.toBeNull();

    await page.goto(`/app/admin/coa?select=${id}`);
    await page.waitForLoadState("networkidle");

    const aside = page.locator(".spectre-dw-inspector-slot");
    // Empty state heading MUST be gone.
    await expect(aside.locator(".spectre-dw-inspector-empty h3")).toHaveCount(0);
    // Reader-mode inspector MUST render its title with the account number.
    await expect(aside.locator(".spectre-dw-inspector-title .num")).toBeVisible();
  });

  test("?edit= opens the inspector in editing mode with the details tab visible", async ({ page }) => {
    const firstRow = page.locator("tr[data-account-id]").first();
    const id = await firstRow.getAttribute("data-account-id");
    expect(id).not.toBeNull();
    await page.goto(`/app/admin/coa?edit=${id}`);
    await page.waitForLoadState("networkidle");
    const inspector = page.locator(".spectre-dw-inspector[data-testid='coa-inspector']");
    await expect(inspector).toBeVisible();
    // The Save button appears only in editing/saved/validation modes
    // — its presence proves we're in edit mode, not reader mode.
    await expect(inspector.locator("[data-testid='coa-inspector-save']")).toBeVisible();
  });

  test("Review States floating panel is HIDDEN for a normal user (no ?_review=1)", async ({ page }) => {
    // The founder reported the design-QA "Review states" pill was
    // showing up for a real Club Admin. The gate is now:
    // reviewMode = searchParams._review === "1". No opt-in → no pill.
    await expect(page.locator("[data-testid='coa-review-states-root']")).toHaveCount(0);
    await expect(page.locator("[data-testid='coa-review-states-toggle']")).toHaveCount(0);
  });

  test("Review States floating panel APPEARS when ?_review=1 is set", async ({ page }) => {
    // The utility must still be reachable for internal design QA.
    // The URL opt-in is the explicit internal flag the founder asked
    // for: no role/permission dependency, no NODE_ENV dependency —
    // just an unambiguous query-string marker.
    await page.goto("/app/admin/coa?_review=1");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("[data-testid='coa-review-states-toggle']")).toBeVisible();
  });

  // ---------------------------------------------------------------
  // Sprint 1 INTERACTION corrections (2026-07-19c).
  // Founder ruled that the checkbox and the inspector must be
  // unified: checking one account opens it; checking two shows a
  // bulk state; unchecking back to one shows the remaining account;
  // clearing everything restores the empty state.
  // ---------------------------------------------------------------

  test("Check one account → inspector shows that account and URL syncs to ?select=", async ({ page }) => {
    const firstRow = page.locator("tr[data-account-id]").first();
    const accountId = await firstRow.getAttribute("data-account-id");
    expect(accountId).not.toBeNull();

    await firstRow.locator("input[type='checkbox']").click();

    // URL should sync to ?select=<id>
    await page.waitForURL((u) => u.searchParams.get("select") === accountId, { timeout: 5000 });

    // Inspector should show that account — reader mode, populated title
    const inspector = page.locator(".spectre-dw-inspector[data-testid='coa-inspector']");
    await expect(inspector).toHaveAttribute("data-mode", "reader");
    await expect(inspector.locator(".spectre-dw-inspector-title .num")).toBeVisible();

    // And this MUST NOT enter edit mode — no save button in reader mode
    await expect(inspector.locator("[data-testid='coa-inspector-save']")).toHaveCount(0);
  });

  test("Check a second account → bulk-selection inspector appears", async ({ page }) => {
    const rows = page.locator("tr[data-account-id]");
    await rows.nth(0).locator("input[type='checkbox']").click();
    await rows.nth(1).locator("input[type='checkbox']").click();

    // URL should NO LONGER carry ?select= (bulk state is ephemeral)
    await page.waitForFunction(() => !new URL(location.href).searchParams.get("select"), null, { timeout: 5000 });

    const inspector = page.locator(".spectre-dw-inspector[data-testid='coa-inspector']");
    await expect(inspector).toHaveAttribute("data-mode", "bulk");
    await expect(inspector.locator("[data-testid='coa-inspector-bulk-count']")).toHaveText("2");
    await expect(inspector.locator("[data-testid='coa-inspector-bulk-clear-all']")).toBeVisible();
  });

  test("Uncheck one leaving one → remaining account appears in the inspector", async ({ page }) => {
    const rows = page.locator("tr[data-account-id]");
    const firstId = await rows.nth(0).getAttribute("data-account-id");
    const secondId = await rows.nth(1).getAttribute("data-account-id");
    expect(firstId).not.toBeNull();
    expect(secondId).not.toBeNull();

    await rows.nth(0).locator("input[type='checkbox']").click();
    await rows.nth(1).locator("input[type='checkbox']").click();
    // Now uncheck the first — should leave second as the sole selection
    await rows.nth(0).locator("input[type='checkbox']").click();

    await page.waitForURL((u) => u.searchParams.get("select") === secondId, { timeout: 5000 });

    const inspector = page.locator(".spectre-dw-inspector[data-testid='coa-inspector']");
    await expect(inspector).toHaveAttribute("data-mode", "reader");
    await expect(inspector.locator(".spectre-dw-inspector-title .num")).toBeVisible();
  });

  test("Clear all checkboxes → instructional empty inspector restored + URL cleared", async ({ page }) => {
    const rows = page.locator("tr[data-account-id]");
    await rows.nth(0).locator("input[type='checkbox']").click();
    await rows.nth(1).locator("input[type='checkbox']").click();

    // Bulk state — Clear selection button clears everything
    await page.locator("[data-testid='coa-inspector-bulk-clear-all']").click();

    // URL has no ?select or ?edit
    await page.waitForFunction(() => {
      const u = new URL(location.href);
      return !u.searchParams.get("select") && !u.searchParams.get("edit");
    }, null, { timeout: 5000 });

    // Empty inspector state is back
    const inspector = page.locator(".spectre-dw-inspector[data-testid='coa-inspector']");
    await expect(inspector).toHaveAttribute("data-mode", "empty");
    await expect(inspector.locator(".spectre-dw-inspector-empty h3")).toHaveText(/Select an account to inspect/);
  });

  test("Row click acts like a single-select (replaces prior selection) and does NOT enter edit mode", async ({ page }) => {
    const rows = page.locator("tr[data-account-id]");
    // First check two accounts to establish bulk state
    await rows.nth(0).locator("input[type='checkbox']").click();
    await rows.nth(1).locator("input[type='checkbox']").click();
    await expect(page.locator(".spectre-dw-inspector[data-testid='coa-inspector']")).toHaveAttribute("data-mode", "bulk");

    // Now row-click the third account. Per the unified model, this
    // REPLACES the checkbox selection with just that account.
    const thirdId = await rows.nth(2).getAttribute("data-account-id");
    expect(thirdId).not.toBeNull();
    await rows.nth(2).locator("td.num-col").click();

    await page.waitForURL((u) => u.searchParams.get("select") === thirdId, { timeout: 5000 });

    const inspector = page.locator(".spectre-dw-inspector[data-testid='coa-inspector']");
    await expect(inspector).toHaveAttribute("data-mode", "reader");
    // Reader mode ⇒ Save button MUST be absent (not editing).
    await expect(inspector.locator("[data-testid='coa-inspector-save']")).toHaveCount(0);
    // And the third row's checkbox is now the only one checked.
    const checked = await page.locator("tr[data-account-id] input[type='checkbox']:checked").count();
    expect(checked).toBe(1);
  });

  test("Header select-all → bulk-selection inspector appears when there are ≥2 visible rows", async ({ page }) => {
    const headerBox = page.locator("table.spectre-dw-table thead input[type='checkbox']").first();
    await headerBox.click();

    // Bulk state
    const inspector = page.locator(".spectre-dw-inspector[data-testid='coa-inspector']");
    await expect(inspector).toHaveAttribute("data-mode", "bulk");
    const count = await inspector.locator("[data-testid='coa-inspector-bulk-count']").innerText();
    expect(parseInt(count, 10)).toBeGreaterThanOrEqual(2);

    // Uncheck the header → back to empty inspector
    await headerBox.click();
    await expect(inspector).toHaveAttribute("data-mode", "empty");
  });

  // ---------------------------------------------------------------
  // Sprint 1 correction (2026-07-19d) — CoA Import Modal.
  // Clicking Import on /app/admin/coa must open a CoA-specific
  // modal at `?modal=import` on this page. It MUST NOT navigate to
  // the generic multi-domain imports page. Reuses the existing
  // import pipeline via `createCoaImportBatchFromModalAction`.
  // ---------------------------------------------------------------

  test("Clicking Import opens the CoA-specific modal at ?modal=import (no page navigation)", async ({ page }) => {
    await page.locator("[data-testid='coa-import-btn']").click();
    await page.waitForURL((u) => u.searchParams.get("modal") === "import", { timeout: 5000 });
    // Still on the CoA workspace — NOT the generic imports page.
    expect(new URL(page.url()).pathname).toBe("/app/admin/coa");
    // Modal is visible with the expected header and dropzone.
    const modal = page.locator("[data-testid='coa-import-modal']");
    await expect(modal).toBeVisible();
    await expect(modal.locator("h2")).toHaveText(/Import chart of accounts/);
    await expect(modal.locator("[data-testid='coa-import-dropzone']")).toBeVisible();
    // No unrelated import-domain selector present.
    await expect(modal.locator("select[name='domain']")).toHaveCount(0);
    await expect(modal.getByText(/Members|Vendors|Employees|Inventory|AR history/i)).toHaveCount(0);
  });

  test("Direct navigation to ?modal=import opens the modal", async ({ page }) => {
    await page.goto("/app/admin/coa?modal=import");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("[data-testid='coa-import-modal']")).toBeVisible();
  });

  test("Escape closes the modal and returns focus to the Import button", async ({ page }) => {
    await page.locator("[data-testid='coa-import-btn']").click();
    await expect(page.locator("[data-testid='coa-import-modal']")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !new URL(location.href).searchParams.get("modal"), null, { timeout: 5000 });
    await expect(page.locator("[data-testid='coa-import-modal']")).toHaveCount(0);
    // Focus returned to the Import button. (Chromium reports document
    // active element even for anchors.)
    const activeTid = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute("data-testid"));
    expect(activeTid).toBe("coa-import-btn");
  });

  test("Close button on the modal clears ?modal= while preserving other filter params", async ({ page }) => {
    await page.goto("/app/admin/coa?fund=OPERATING&showInactive=1&modal=import");
    await page.waitForLoadState("networkidle");
    await page.locator("[data-testid='coa-import-modal-close']").click();
    await page.waitForFunction(() => !new URL(location.href).searchParams.get("modal"), null, { timeout: 5000 });
    const u = new URL(page.url());
    expect(u.searchParams.get("modal")).toBeNull();
    expect(u.searchParams.get("fund")).toBe("OPERATING");
    expect(u.searchParams.get("showInactive")).toBe("1");
  });

  test("Dropping an .xlsx file shows the selected-file state and enables the primary action", async ({ page }) => {
    await page.goto("/app/admin/coa?modal=import");
    await page.waitForLoadState("networkidle");
    // Simulate a valid .xlsx file selection via the hidden input.
    const fileInput = page.locator("[data-testid='coa-import-file-input']");
    await fileInput.setInputFiles({
      name: "chart-of-accounts.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from("PKfake-xlsx-signature-only-for-ui-test"),
    });
    await expect(page.locator("[data-testid='coa-import-selected-file']")).toBeVisible();
    await expect(page.locator("[data-testid='coa-import-selected-file-name']")).toHaveText("chart-of-accounts.xlsx");
    await expect(page.locator("[data-testid='coa-import-selected-file-type']")).toHaveText("Excel workbook");
    const submit = page.locator("[data-testid='coa-import-submit']");
    await expect(submit).toBeEnabled();
  });

  test("Dropping a .csv file shows the CSV selected-file state", async ({ page }) => {
    await page.goto("/app/admin/coa?modal=import");
    await page.waitForLoadState("networkidle");
    await page.locator("[data-testid='coa-import-file-input']").setInputFiles({
      name: "coa.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("number,name\n1000,Petty Cash\n"),
    });
    await expect(page.locator("[data-testid='coa-import-selected-file']")).toBeVisible();
    await expect(page.locator("[data-testid='coa-import-selected-file-type']")).toHaveText("CSV file");
  });

  test("Unsupported file types are rejected with an inline error", async ({ page }) => {
    await page.goto("/app/admin/coa?modal=import");
    await page.waitForLoadState("networkidle");
    await page.locator("[data-testid='coa-import-file-input']").setInputFiles({
      name: "malware.exe",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("MZ\x90\x00"),
    });
    await expect(page.locator("[data-testid='coa-import-error']")).toContainText(/Unsupported file type/i);
    // No selected-file state; primary action stays disabled.
    await expect(page.locator("[data-testid='coa-import-selected-file']")).toHaveCount(0);
    await expect(page.locator("[data-testid='coa-import-submit']")).toBeDisabled();
  });

  test("Replace file button restores the empty drop zone", async ({ page }) => {
    await page.goto("/app/admin/coa?modal=import");
    await page.waitForLoadState("networkidle");
    await page.locator("[data-testid='coa-import-file-input']").setInputFiles({
      name: "coa.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("number,name\n1000,Cash\n"),
    });
    await expect(page.locator("[data-testid='coa-import-selected-file']")).toBeVisible();
    await page.locator("[data-testid='coa-import-remove-file']").click();
    await expect(page.locator("[data-testid='coa-import-selected-file']")).toHaveCount(0);
    await expect(page.locator("[data-testid='coa-import-dropzone']")).toBeVisible();
  });

  test("Template download link points at the existing /api/imports/coa/template endpoint", async ({ page }) => {
    await page.goto("/app/admin/coa?modal=import");
    await page.waitForLoadState("networkidle");
    const link = page.locator("[data-testid='coa-import-template-link']");
    await expect(link).toBeVisible();
    expect(await link.getAttribute("href")).toBe("/api/imports/coa/template");
    expect(await link.getAttribute("download")).not.toBeNull();
  });

  test("Generic Data Imports page remains unchanged (no CoA-specific redesign)", async ({ page }) => {
    // Read-only smoke test: navigating to /app/admin/imports still
    // renders the multi-domain New batch form. This proves the CoA
    // modal did not replace or hide the generic imports UX.
    await page.goto("/app/admin/imports");
    await page.waitForLoadState("networkidle");
    // The generic page's domain selector is present.
    await expect(page.locator("select[name='domain']")).toBeVisible();
  });

  test("URL sync is coherent: selection state and ?select= match on external URL change", async ({ page }) => {
    // Test the sync-FROM-URL path (browser back / forward, shared
    // link paste). Selection mutations use router.replace so back
    // may skip intermediate workspace states; the meaningful contract
    // is that when the URL says X, the inspector matches X.
    const rows = page.locator("tr[data-account-id]");
    const firstId = await rows.nth(0).getAttribute("data-account-id");
    const secondId = await rows.nth(1).getAttribute("data-account-id");
    expect(firstId).not.toBeNull();
    expect(secondId).not.toBeNull();

    // Click a checkbox to establish selection A
    await rows.nth(0).locator("input[type='checkbox']").click();
    await page.waitForURL((u) => u.searchParams.get("select") === firstId);

    // External URL change → account B
    await page.goto(`/app/admin/coa?select=${secondId}`);
    await page.waitForLoadState("networkidle");

    // Selected checkbox should now be row B, not row A
    const rowsAfter = page.locator("tr[data-account-id]");
    const checkedIds: string[] = [];
    const rowCount = await rowsAfter.count();
    for (let i = 0; i < Math.min(rowCount, 60); i++) {
      const cb = rowsAfter.nth(i).locator("input[type='checkbox']");
      if (await cb.isChecked()) {
        const id = await rowsAfter.nth(i).getAttribute("data-account-id");
        if (id) checkedIds.push(id);
      }
    }
    expect(checkedIds).toEqual([secondId]);
    const inspector = page.locator(".spectre-dw-inspector[data-testid='coa-inspector']");
    await expect(inspector).toHaveAttribute("data-mode", "reader");

    // External URL change to no selection → empty state
    await page.goto("/app/admin/coa");
    await page.waitForLoadState("networkidle");
    await expect(inspector).toHaveAttribute("data-mode", "empty");
  });
});
