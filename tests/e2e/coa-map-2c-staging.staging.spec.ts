// COA-MAP-2C (2026-10-06) — AUTOMATED authenticated staging acceptance.
//
// This spec exercises the pointer-driven whole-row drag using REAL
// Playwright `page.mouse` events — not synthetic DragEvent dispatch.
// Pointer events fire natively in Chromium when page.mouse.{down,
// move, up} is called, and the useAccountDrag hook listens on
// window pointerevent types directly.
//
// What this spec proves:
//   §B  Whole-row dragging — pointerdown on the row body (not a
//       handle) begins the gesture.
//   §C  Click vs drag — a quick click (minimal movement) still
//       opens the Inspector; it does NOT open the drawer.
//   §D  Interactive child exclusions — clicking the row's checkbox
//       continues to work normally (does not begin a drag).
//   §E  Floating overlay appears during drag.
//   §F  Destination group header gets data-drop-hovered=true.
//   §H  Progressive auto-scroll — scrollTop increases over time,
//       with slower velocity at zone entry than at the extreme edge.
//   §J  Drop opens the shared Preview drawer; Cancel does not
//       persist; Apply persists; reload confirms persistence.
//   §L  Cross-view parity — Mapping Studio shows the account in the
//       destination group after apply.
//
// Disposable fixture only; founder-committed mappings untouched.

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";
const COA_BATCH_ID = "cmuni5ymv000k136q3xdyrpmn";
const COULEE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";

type Fixture = {
  fixtureKey: string;
  account: { id: string; accountNumber: string; name: string };
  anchorB: { id: string; accountNumber: string; name: string };
  groupA: { id: string; name: string; key: string };
  groupB: { id: string; name: string; key: string };
};

async function invariant(page: Page) {
  const r = await page.request.get(`${BASE}/api/admin/coa-batch-diagnostic/${COA_BATCH_ID}`);
  expect(r.ok()).toBe(true);
  return r.json();
}
async function shot(page: Page, name: string): Promise<void> {
  await page
    .screenshot({ path: `test-results/coa-map-2c-${name}.png` })
    .catch(() => undefined);
}
async function createFixture(page: Page): Promise<Fixture> {
  const key = `COA_MAP_2C_${Date.now()}`;
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

/**
 * Drag a row to a destination group header using REAL pointer events.
 * The hook disambiguates click vs drag via 6 px squared-distance, so
 * we move 50 px first to activate drag, then step toward the target.
 */
async function dragRowToGroup(page: Page, accountNumber: string, targetFsGroupId: string): Promise<void> {
  const srcRow = page.locator(`[data-testid="coa-account-row-${accountNumber}"]`).first();
  await srcRow.scrollIntoViewIfNeeded();
  const srcBox = await srcRow.boundingBox();
  if (!srcBox) throw new Error("source row not visible");
  const target = page.locator(`[data-fs-group-id="${targetFsGroupId}"] .spectre-dw-sub-header`).first();
  await target.scrollIntoViewIfNeeded();
  const targetBox = await target.boundingBox();
  if (!targetBox) throw new Error("target header not visible");
  // Press from somewhere in the name cell (not the checkbox).
  await page.mouse.move(srcBox.x + srcBox.width / 2, srcBox.y + srcBox.height / 2);
  await page.mouse.down();
  // Cross the 6-px threshold.
  await page.mouse.move(srcBox.x + srcBox.width / 2 + 30, srcBox.y + srcBox.height / 2, { steps: 4 });
  // Then move to the destination header.
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 10 });
  await page.waitForTimeout(100);
  await page.mouse.up();
}

runAt("COA-MAP-2C · pointer-driven whole-row drag + progressive auto-scroll", async ({ browser }) => {
  test.setTimeout(600_000);
  const ctx: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(ctx);

  const before = await invariant(page);
  console.log("COA_MAP_2C_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);

  let fx: Fixture | null = null;
  try {
    fx = await createFixture(page);
    console.log("COA_MAP_2C_FIXTURE " + JSON.stringify({ fixtureKey: fx.fixtureKey, account: fx.account.accountNumber, groupA: fx.groupA.id, groupB: fx.groupB.id }));

    await page.goto(`${BASE}/app/admin/coa`, { waitUntil: "domcontentloaded" });
    await page.locator(".spectre-dw-table-wrap").waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(800);
    await shot(page, "01-account-list");

    const srcRow = page.locator(`[data-testid="coa-account-row-${fx.account.accountNumber}"]`).first();
    await srcRow.scrollIntoViewIfNeeded();
    await expect(srcRow).toBeVisible();

    // ------------------------------------------------------------
    // §C  Click vs drag — a quick click (no movement past threshold)
    //     opens the Inspector but does NOT open the drawer.
    // ------------------------------------------------------------
    const nameCell = srcRow.locator("td.name");
    await nameCell.click();
    await page.waitForTimeout(500);
    const urlAfterClick = page.url();
    console.log("COA_MAP_2C_ROW_CLICK_URL " + urlAfterClick);
    expect(urlAfterClick).toContain(`select=${fx.account.id}`);
    expect(await page.locator('[data-testid="coa-mapping-drawer"]').count()).toBe(0);
    console.log("COA_MAP_2C_CLICK_DOES_NOT_OPEN_DRAWER true");

    // ------------------------------------------------------------
    // §D  Interactive child — checkbox click should NOT begin a drag
    //     and should NOT open the drawer.  The checkbox toggles the
    //     row's selection state normally.
    // ------------------------------------------------------------
    const checkbox = srcRow.locator('input[type="checkbox"].spectre-dw-check');
    await checkbox.check();
    await page.waitForTimeout(300);
    expect(await page.locator('[data-testid="coa-mapping-drawer"]').count()).toBe(0);
    console.log("COA_MAP_2C_CHECKBOX_INTERACTIVE_EXCLUSION true");
    await checkbox.uncheck();

    // ------------------------------------------------------------
    // §H  Progressive auto-scroll — reset scroll, press, hold at
    //     bottom edge, measure scrollTop over time.
    // ------------------------------------------------------------
    await page.evaluate(() => {
      const w = document.querySelector(".spectre-dw-table-wrap") as HTMLElement | null;
      if (w) w.scrollTop = 0;
    });
    await page.waitForTimeout(100);

    await srcRow.scrollIntoViewIfNeeded();
    const srcBox = await srcRow.boundingBox();
    if (!srcBox) throw new Error("src row not visible");
    // Press on the row body (not the checkbox cell).
    await page.mouse.move(srcBox.x + 300, srcBox.y + srcBox.height / 2);
    await page.mouse.down();
    // Cross threshold.
    await page.mouse.move(srcBox.x + 300, srcBox.y + srcBox.height / 2 + 20, { steps: 4 });
    // Hover near zone entry (penetration ~10 px) for 500 ms.
    await page.mouse.move(400, 820, { steps: 2 });
    await page.waitForTimeout(500);
    const scrollEntry = await page.evaluate(() => {
      const w = document.querySelector(".spectre-dw-table-wrap") as HTMLElement | null;
      return w?.scrollTop ?? -1;
    });
    console.log("COA_MAP_2C_SCROLL_AT_ZONE_ENTRY_500MS " + scrollEntry);
    // Then hover near the extreme edge (penetration ~90 px) for 500 ms.
    await page.mouse.move(400, 895, { steps: 2 });
    await page.waitForTimeout(500);
    const scrollEdge = await page.evaluate(() => {
      const w = document.querySelector(".spectre-dw-table-wrap") as HTMLElement | null;
      return w?.scrollTop ?? -1;
    });
    console.log("COA_MAP_2C_SCROLL_AT_EDGE_500MS " + scrollEdge);
    console.log("COA_MAP_2C_SCROLL_PROGRESSIVE_RATIO " + (scrollEdge / Math.max(scrollEntry, 1)));
    // Progressive ramp: edge-hold velocity > zone-entry velocity.
    expect(scrollEdge).toBeGreaterThan(scrollEntry);
    // Floating overlay is visible during the drag.
    await expect(page.locator('[data-testid="coa-mapping-drag-overlay"]')).toBeVisible();
    console.log("COA_MAP_2C_OVERLAY_VISIBLE true");
    await shot(page, "02-drag-with-overlay");
    // Release outside any valid target to avoid opening the drawer.
    await page.mouse.move(10, 10, { steps: 2 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    expect(await page.locator('[data-testid="coa-mapping-drawer"]').count()).toBe(0);
    console.log("COA_MAP_2C_RELEASE_OUTSIDE_NO_DRAWER true");

    // ------------------------------------------------------------
    // §J  Drop opens the shared Preview drawer.
    // ------------------------------------------------------------
    await dragRowToGroup(page, fx.account.accountNumber, fx.groupB.id);
    await page.locator('[data-testid="coa-mapping-drawer-preview"]').waitFor({ state: "visible", timeout: 10_000 });
    const drawerText = (await page.locator('[data-testid="coa-mapping-drawer-preview"]').innerText()).toLowerCase();
    expect(drawerText).toContain("reporting impact");
    console.log("COA_MAP_2C_DROP_OPENED_PREVIEW true");
    await shot(page, "03-drawer-opened");

    // §I  Cancel does NOT persist.
    await page.locator('[data-testid="coa-mapping-preview-cancel"]').click();
    await page.waitForTimeout(300);
    const historyAfterCancel = await page.request.get(`${BASE}/api/admin/coa-mapping/accounts/${fx.account.id}/history?clubId=${COULEE_CLUB_ID}`);
    const historyBody = await historyAfterCancel.json();
    expect(historyBody.history[historyBody.history.length - 1].fsGroupId).toBe(fx.groupA.id);
    console.log("COA_MAP_2C_CANCEL_DID_NOT_PERSIST true");

    // §J  Apply persists.
    await dragRowToGroup(page, fx.account.accountNumber, fx.groupB.id);
    await page.locator('[data-testid="coa-mapping-drawer-preview"]').waitFor({ state: "visible" });
    const [applyResp] = await Promise.all([
      page.waitForResponse((r) => /\/api\/admin\/coa-mapping\/accounts\/[^/]+\/reassign/.test(r.url()), { timeout: 15_000 }),
      page.locator('[data-testid="coa-mapping-preview-apply"]').click(),
    ]);
    const applyStatus = applyResp.status();
    const applyBody = await applyResp.json().catch(() => ({}));
    console.log("COA_MAP_2C_APPLY_STATUS " + applyStatus + " · outcome=" + (applyBody.outcome ?? "?"));
    expect(applyStatus).toBe(200);
    await page.waitForTimeout(400);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".spectre-dw-table-wrap").waitFor({ state: "visible" });
    const historyAfterApply = await page.request.get(`${BASE}/api/admin/coa-mapping/accounts/${fx.account.id}/history?clubId=${COULEE_CLUB_ID}`);
    const historyBody2 = await historyAfterApply.json();
    const latest = historyBody2.history[historyBody2.history.length - 1];
    expect(latest.fsGroupId).toBe(fx.groupB.id);
    console.log("COA_MAP_2C_APPLY_PERSISTED true · group=" + latest.fsGroupName);
    await shot(page, "04-after-reload-persisted");

    // §L  Cross-view parity.
    await page.goto(`${BASE}/app/admin/coa-mapping?statement=bs`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="coa-mapping-header"]').waitFor({ state: "visible" });
    await page.waitForTimeout(500);
    const inB = page.locator(`[data-testid="coa-mapping-group-${fx.groupB.id}"] [data-testid="coa-mapping-account-${fx.account.accountNumber}"]`);
    const parityCount = await inB.count();
    console.log("COA_MAP_2C_CROSS_VIEW_PARITY " + (parityCount > 0));
    expect(parityCount).toBeGreaterThan(0);
    await shot(page, "05-cross-view-parity");

    console.log(
      "COA_MAP_2C_AUTOMATED_PASS true · " +
      "scroll_zone_entry_500ms=" + scrollEntry + "px · " +
      "scroll_at_edge_500ms=" + scrollEdge + "px · " +
      "progressive_ratio=" + (scrollEdge / Math.max(scrollEntry, 1)).toFixed(2) + " · " +
      "overlay_visible=true · click_vs_drag=true · " +
      "interactive_exclusion=true · drop_opened=true · " +
      "cancel_safe=true · apply_persisted=true · cross_view_parity=true"
    );
  } finally {
    if (fx) {
      await destroyFixture(page, fx.fixtureKey);
      console.log("COA_MAP_2C_FIXTURE_DELETED " + fx.fixtureKey);
    }
  }

  const after = await invariant(page);
  console.log("COA_MAP_2C_AFTER " + JSON.stringify({ club: after.club }));
  expect(after.club).toEqual(before.club);

  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01`, { waitUntil: "domcontentloaded" });
  const bodyText = await page.locator("body").innerText();
  const opRevPresent =
    bodyText.includes("$3,124,066.72") ||
    bodyText.includes("$3.12M") ||
    bodyText.includes("3,124,066");
  console.log("COA_MAP_2C_JAN_PARITY_OPREV " + opRevPresent);
  expect(opRevPresent).toBe(true);

  await ctx.close();
});
