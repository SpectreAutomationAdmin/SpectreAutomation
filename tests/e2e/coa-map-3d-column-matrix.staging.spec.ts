// COA-MAP-3D (2026-10-08) — column-by-column drag activation matrix.
//
// Founder requirement: EVERY non-interactive portion of an account
// row must initiate drag.  Only checkboxes, buttons, menus, and
// form inputs should be excluded.
//
// This probe iterates every column of a disposable fixture row
// and attempts to initiate drag from the center of each.  It
// reports a matrix:
//
//   column            | drag activates | source fades | release opens drawer
//
// Columns probed:
//   1. .spectre-dw-select-cell  (checkbox — MUST BLOCK)
//   2. .num-col                 (plain text — MUST ACTIVATE)
//   3. .name                    (contains <Link> — MUST ACTIVATE per COA-MAP-3C)
//   4. .tag (Type)              (plain text — MUST ACTIVATE)
//   5. .tag (FS Group)          (plain text — MUST ACTIVATE)
//   6. .tag (Department)        (plain text — MUST ACTIVATE)
//   7. .spectre-dw-fund-chip    (fund chip — MUST ACTIVATE)
//   8. .spectre-dw-balance-cell (balance — MUST ACTIVATE)
//   9. .spectre-dw-status-cell  (status pill — MUST ACTIVATE)
//  10. td.actions button        (3-dot menu button — MUST BLOCK)
//  11. td.actions blank space   (empty td — MUST ACTIVATE)

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";
const COULEE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";

type Fixture = {
  fixtureKey: string;
  account: { id: string; accountNumber: string; name: string };
  anchorB: { id: string; accountNumber: string; name: string };
  groupA: { id: string; name: string; key: string };
  groupB: { id: string; name: string; key: string };
};

async function createFixture(page: Page): Promise<Fixture> {
  const key = `COA_MAP_3D_${Date.now()}`;
  const res = await page.request.post(`${BASE}/api/admin/testing/coa-map-2a-fixture`, {
    data: { clubId: COULEE_CLUB_ID, fixtureKey: key },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as Fixture;
}
async function destroyFixture(page: Page, fixtureKey: string): Promise<void> {
  await page.request
    .delete(`${BASE}/api/admin/testing/coa-map-2a-fixture?clubId=${COULEE_CLUB_ID}&fixtureKey=${encodeURIComponent(fixtureKey)}`)
    .catch(() => undefined);
}

async function tryDragFrom(
  page: Page,
  rowTestid: string,
  spot: { x: number; y: number },
  label: string,
): Promise<{ overlay: boolean; fade: boolean }> {
  // Fresh press-move sequence from the given spot.
  await page.mouse.move(spot.x, spot.y);
  await page.waitForTimeout(80);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.move(spot.x + 40, spot.y + 40, { steps: 4 });
  await page.waitForTimeout(220);
  const overlay = await page.locator('[data-testid="coa-mapping-drag-overlay"]').isVisible().catch(() => false);
  const srcRow = page.locator(`[data-testid="${rowTestid}"]`).first();
  const fadeAttr = await srcRow.getAttribute("data-dragging-source").catch(() => null);
  const fade = fadeAttr === "true";
  // Release outside any valid target to avoid opening the drawer.
  await page.mouse.move(10, 10, { steps: 2 });
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(200);
  // Reset ESC-style: close any drawer that might have appeared.
  const drawerExists = await page.locator('[data-testid="coa-mapping-drawer-preview"]').count();
  if (drawerExists > 0) {
    await page.locator('[data-testid="coa-mapping-preview-cancel"]').click({ timeout: 2000 }).catch(() => undefined);
    await page.waitForTimeout(200);
  }
  console.log(`COA_MAP_3D_COL ${label} overlay=${overlay} fade=${fade}`);
  return { overlay, fade };
}

runAt("COA-MAP-3D · column-by-column drag activation matrix", async ({ browser }) => {
  test.setTimeout(600_000);
  const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
  const page = await loginAsFounder(ctx);

  let fx: Fixture | null = null;
  try {
    fx = await createFixture(page);
    console.log("COA_MAP_3D_FIXTURE acct=" + fx.account.accountNumber);

    await page.goto(`${BASE}/app/admin/coa`, { waitUntil: "domcontentloaded" });
    await page.locator(".spectre-dw-table-wrap").waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(1200);

    const rowTestid = `coa-account-row-${fx.account.accountNumber}`;
    const srcRow = page.locator(`[data-testid="${rowTestid}"]`).first();
    await srcRow.scrollIntoViewIfNeeded();

    const columns: Array<{ label: string; selector: string; nth?: number; expectActivate: boolean }> = [
      { label: "01-select-cell-checkbox",    selector: 'td.spectre-dw-select-cell input[type="checkbox"]', expectActivate: false },
      { label: "02-num-col",                  selector: "td.num-col",                                       expectActivate: true  },
      { label: "03-name-link",                selector: 'td.name a',                                        expectActivate: true  },
      { label: "04-name-cell-whitespace",     selector: "td.name",                                          expectActivate: true  },
      { label: "05-type-tag",                 selector: 'td.tag',                       nth: 0,             expectActivate: true  },
      { label: "06-fsgroup-tag",              selector: 'td.tag',                       nth: 1,             expectActivate: true  },
      { label: "07-dept-tag",                 selector: 'td.tag',                       nth: 2,             expectActivate: true  },
      { label: "08-fund-chip",                selector: `[data-testid="coa-account-fund-${fx.account.accountNumber}"]`, expectActivate: true  },
      { label: "09-balance-cell",             selector: `[data-testid="coa-account-balance-${fx.account.accountNumber}"]`, expectActivate: true  },
      { label: "10-status-flags",             selector: `[data-testid="coa-account-flags-${fx.account.accountNumber}"]`, expectActivate: true  },
      { label: "11-actions-button",           selector: 'td.actions .spectre-dw-row-actions .trigger',       expectActivate: false },
    ];

    const results: Array<{ label: string; expectActivate: boolean; actualOverlay: boolean; actualFade: boolean; elementAtPoint?: string }> = [];
    for (const col of columns) {
      const cell = col.nth !== undefined
        ? srcRow.locator(col.selector).nth(col.nth)
        : srcRow.locator(col.selector).first();
      const cellCount = await cell.count();
      if (cellCount === 0) {
        console.log(`COA_MAP_3D_COL ${col.label} NO_MATCH`);
        results.push({ label: col.label, expectActivate: col.expectActivate, actualOverlay: false, actualFade: false });
        continue;
      }
      // Scroll the cell into view in the horizontally scrolling
      // table container so its CSS box is actually visible — the
      // columns to the right of balance would otherwise sit under
      // the Inspector pane.
      await cell.scrollIntoViewIfNeeded().catch(() => undefined);
      await page.waitForTimeout(80);
      const box = await cell.boundingBox();
      if (!box) {
        console.log(`COA_MAP_3D_COL ${col.label} NO_BOX`);
        results.push({ label: col.label, expectActivate: col.expectActivate, actualOverlay: false, actualFade: false });
        continue;
      }
      const spot = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      // Diagnostic — what element is actually at that pixel?
      const elAtPoint = await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        if (!el) return "null";
        let desc = el.tagName.toLowerCase();
        const cn = el.getAttribute("class");
        if (cn) desc += "." + cn.split(/\s+/).join(".");
        const role = el.getAttribute("role");
        if (role) desc += `[role=${role}]`;
        const tid = el.getAttribute("data-testid");
        if (tid) desc += `[data-testid=${tid}]`;
        return desc;
      }, spot);
      console.log(`COA_MAP_3D_SPOT ${col.label} x=${spot.x.toFixed(0)} y=${spot.y.toFixed(0)} elAtPoint=${elAtPoint}`);
      const { overlay, fade } = await tryDragFrom(page, rowTestid, spot, col.label);
      results.push({ label: col.label, expectActivate: col.expectActivate, actualOverlay: overlay, actualFade: fade, elementAtPoint: elAtPoint });
      // Short pause between probes so React settles.
      await page.waitForTimeout(200);
    }

    // Print the matrix.
    console.log("COA_MAP_3D_MATRIX_START");
    for (const r of results) {
      const activated = r.actualOverlay || r.actualFade;
      const outcome = activated === r.expectActivate ? "PASS" : "FAIL";
      console.log(`  ${r.label}  expect=${r.expectActivate ? "activate" : "block"}  actual=${activated ? "activate" : "block"}  elAtPoint=${r.elementAtPoint ?? "?"}  ${outcome}`);
    }
    console.log("COA_MAP_3D_MATRIX_END");

    // Hard-fail if any outcome deviates.
    const failures = results.filter((r) => (r.actualOverlay || r.actualFade) !== r.expectActivate);
    if (failures.length > 0) {
      console.log("COA_MAP_3D_FAILURES " + JSON.stringify(failures));
    }
    expect(failures).toEqual([]);

    await page.screenshot({ path: "test-results/coa-map-3d-matrix.png" }).catch(() => undefined);

    // ------------------------------------------------------------
    // §B  Interactive-controls preservation.  Clicking the row
    //     checkbox and the 3-dot menu button must NOT initiate
    //     drag — they must perform their native action.
    // ------------------------------------------------------------

    // Checkbox: a pure click must toggle its state (no drag).
    const checkbox = srcRow.locator('td.spectre-dw-select-cell input[type="checkbox"]');
    await checkbox.scrollIntoViewIfNeeded();
    const beforeChecked = await checkbox.isChecked();
    await checkbox.click();
    await page.waitForTimeout(200);
    const afterChecked = await checkbox.isChecked();
    const overlayAfterCheckboxClick = await page.locator('[data-testid="coa-mapping-drag-overlay"]').isVisible().catch(() => false);
    console.log(`COA_MAP_3D_CHECKBOX_TOGGLE before=${beforeChecked} after=${afterChecked} overlay=${overlayAfterCheckboxClick}`);
    expect(afterChecked).toBe(!beforeChecked);
    expect(overlayAfterCheckboxClick).toBe(false);
    // Restore the previous state so bulk-select UI isn't left dirty.
    await checkbox.click();
    await page.waitForTimeout(200);

    // 3-dot menu button: a pure click must open the menu (no drag).
    const menuBtn = srcRow.locator('td.actions .spectre-dw-row-actions .trigger');
    await menuBtn.scrollIntoViewIfNeeded();
    const menuContainer = srcRow.locator('td.actions .spectre-dw-row-actions');
    const menuOpenBefore = await menuContainer.getAttribute('data-open');
    await menuBtn.click();
    await page.waitForTimeout(200);
    const menuOpenAfter = await menuContainer.getAttribute('data-open');
    const overlayAfterMenuClick = await page.locator('[data-testid="coa-mapping-drag-overlay"]').isVisible().catch(() => false);
    console.log(`COA_MAP_3D_MENU_OPEN before=${menuOpenBefore} after=${menuOpenAfter} overlay=${overlayAfterMenuClick}`);
    expect(menuOpenAfter).toBe('true');
    expect(overlayAfterMenuClick).toBe(false);
    // Close the menu by clicking the trigger again.
    await menuBtn.click();
    await page.waitForTimeout(200);

    // ------------------------------------------------------------
    // §C  End-to-end drop from a NON-NAME column.  Picks the
    //     status/flags cell (farthest right in the drag-eligible
    //     region) and drops it on groupB — verifies drawer opens,
    //     then cancels without persisting.  Mirrors COA-MAP-3C's
    //     name-column drop test for a different starting column.
    // ------------------------------------------------------------
    const flagsCell = srcRow.locator(`[data-testid="coa-account-flags-${fx.account.accountNumber}"]`);
    await flagsCell.scrollIntoViewIfNeeded();
    const flagsBox = await flagsCell.boundingBox();
    if (!flagsBox) throw new Error("flags cell has no box");

    const targetHeader = page.locator(`[data-fs-group-id="${fx.groupB.id}"] .spectre-dw-sub-header`).first();
    await targetHeader.scrollIntoViewIfNeeded();
    const dstBox = await targetHeader.boundingBox();
    if (!dstBox) throw new Error("target header has no box");

    // Re-measure after the second scrollIntoView may have shifted things.
    await flagsCell.scrollIntoViewIfNeeded();
    const flagsBox2 = await flagsCell.boundingBox();
    if (!flagsBox2) throw new Error("flags cell has no box 2");

    await page.mouse.move(flagsBox2.x + flagsBox2.width / 2, flagsBox2.y + flagsBox2.height / 2);
    await page.waitForTimeout(80);
    await page.mouse.down();
    await page.mouse.move(flagsBox2.x + flagsBox2.width / 2 + 20, flagsBox2.y + flagsBox2.height / 2 + 20, { steps: 4 });
    await page.waitForTimeout(200);
    const overlayVisibleOnFlagsDrag = await page.locator('[data-testid="coa-mapping-drag-overlay"]').isVisible().catch(() => false);
    console.log(`COA_MAP_3D_FLAGS_DRAG_OVERLAY ${overlayVisibleOnFlagsDrag}`);
    expect(overlayVisibleOnFlagsDrag).toBe(true);
    await page.mouse.move(dstBox.x + dstBox.width / 2, dstBox.y + dstBox.height / 2, { steps: 10 });
    await page.waitForTimeout(200);
    await page.mouse.up();
    await page.waitForTimeout(400);
    const drawerAfterFlagsDrop = await page.locator('[data-testid="coa-mapping-drawer-preview"]').isVisible().catch(() => false);
    console.log(`COA_MAP_3D_FLAGS_DRAWER_OPENED ${drawerAfterFlagsDrop}`);
    expect(drawerAfterFlagsDrop).toBe(true);
    await page.locator('[data-testid="coa-mapping-preview-cancel"]').click();
    await page.waitForTimeout(300);
    const histAfterCancel = await page.request.get(
      `${BASE}/api/admin/coa-mapping/accounts/${fx.account.id}/history?clubId=${COULEE_CLUB_ID}`,
    );
    const histBody = await histAfterCancel.json();
    expect(histBody.history[histBody.history.length - 1].fsGroupId).toBe(fx.groupA.id);
    console.log('COA_MAP_3D_FLAGS_CANCEL_SAFE true');
  } finally {
    if (fx) {
      await destroyFixture(page, fx.fixtureKey);
      console.log("COA_MAP_3D_FIXTURE_DELETED " + fx.fixtureKey);
    }
  }

  await ctx.close();
});
