// COA-MAP-3C (2026-10-08) — focused drag diagnostic.
//
// Previous COA-MAP-2C staging E2E now fails on an unrelated URL
// assertion.  This probe strips away the URL check and goes
// straight to the drag mechanics, logging exactly which step
// fails so we can target the repair precisely.

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
  const key = `COA_MAP_3C_${Date.now()}`;
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

runAt("COA-MAP-3C · drag mechanics probe", async ({ browser }) => {
  test.setTimeout(300_000);
  const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
  const page = await loginAsFounder(ctx);

  let fx: Fixture | null = null;
  try {
    fx = await createFixture(page);
    console.log("PROBE_FIXTURE " + fx.account.accountNumber + " " + fx.account.id);
    console.log("PROBE_GROUPS A=" + fx.groupA.id + " B=" + fx.groupB.id);

    await page.goto(`${BASE}/app/admin/coa`, { waitUntil: "domcontentloaded" });
    await page.locator(".spectre-dw-table-wrap").waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(1200);

    // Probe 1: does the row have data-drag-enabled="true"?
    const srcRow = page.locator(`[data-testid="coa-account-row-${fx.account.accountNumber}"]`).first();
    await srcRow.scrollIntoViewIfNeeded();
    const dragEnabled = await srcRow.getAttribute("data-drag-enabled");
    console.log("PROBE_ROW_DATA_DRAG_ENABLED " + dragEnabled);
    expect(dragEnabled).toBe("true");

    // Probe 2: is onPointerDown wired?  We dispatch a pointer-down
    // via dispatchEvent and see if the hook captures it (we can
    // observe by checking if a subsequent pointermove over distance
    // > 6 px activates the overlay).
    const srcBox = await srcRow.boundingBox();
    if (!srcBox) throw new Error("src row has no box");
    console.log("PROBE_SRC_BOX " + JSON.stringify(srcBox));

    // Probe 3: trigger a real pointer-driven drag from the TYPE
    // column (far from any <Link> or <input>) to isolate whether
    // isInteractiveTarget is short-circuiting us.
    const typeCell = srcRow.locator('td.tag').first();
    const typeBox = await typeCell.boundingBox();
    console.log("PROBE_TYPE_BOX " + JSON.stringify(typeBox));
    if (!typeBox) throw new Error("type cell has no box");
    await page.mouse.move(typeBox.x + typeBox.width / 2, typeBox.y + typeBox.height / 2);
    await page.waitForTimeout(100);
    await page.mouse.down();
    await page.waitForTimeout(100);
    // Cross threshold.
    await page.mouse.move(typeBox.x + typeBox.width / 2 + 30, typeBox.y + typeBox.height / 2 + 40, { steps: 4 });
    await page.waitForTimeout(300);

    const overlayCount = await page.locator('[data-testid="coa-mapping-drag-overlay"]').count();
    const overlayVisible = overlayCount > 0 ? await page.locator('[data-testid="coa-mapping-drag-overlay"]').isVisible() : false;
    console.log("PROBE_OVERLAY_COUNT " + overlayCount + " · visible=" + overlayVisible);

    const sourceFade = await srcRow.getAttribute("data-dragging-source");
    console.log("PROBE_SOURCE_DRAGGING_ATTR " + sourceFade);

    // Measure if a drag is actually in progress.  If the overlay
    // never appears, the hook isn't activating.
    const htmlCursor = await page.evaluate(() => document.documentElement.style.cursor);
    const htmlUserSelect = await page.evaluate(() => document.documentElement.style.userSelect);
    console.log("PROBE_HTML_CURSOR " + JSON.stringify(htmlCursor));
    console.log("PROBE_HTML_USERSELECT " + JSON.stringify(htmlUserSelect));

    // Release.
    await page.mouse.up();
    await page.waitForTimeout(300);
    await page.screenshot({ path: "test-results/coa-map-3c-probe.png" }).catch(() => undefined);

    const anyDrawerOpen = await page.locator('[data-testid="coa-mapping-drawer"]').count();
    console.log("PROBE_DRAWER_OPENED_AFTER_RELEASE " + anyDrawerOpen);

    // Diagnostic summary.
    console.log(
      "PROBE_SUMMARY · " +
      "drag_enabled_attr=" + dragEnabled + " · " +
      "overlay_appeared=" + overlayVisible + " · " +
      "html_cursor=" + htmlCursor + " · " +
      "source_fade=" + sourceFade,
    );
  } finally {
    if (fx) await destroyFixture(page, fx.fixtureKey);
  }

  await ctx.close();
});
