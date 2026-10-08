// COA-MAP-3C (2026-10-08) — authenticated staging acceptance.
//
// The founder's regression: dragging an account between
// Financial Statement Groups stopped working.  Root cause: the
// Name column's <Link> short-circuited the drag hook.  This
// spec exercises the EXACT founder scenario:
//   1. Open /app/admin/coa as the Controller
//   2. Pick a fixture account
//   3. Press and hold on the account NAME cell (not the Type /
//      FS Group cells, not the drag handle — the natural grab
//      point)
//   4. Move past the 6 px threshold
//   5. Expect floating overlay + source fade + grabbing cursor
//   6. Hover a disposable FS Group header
//   7. Release
//   8. Expect Reporting Impact drawer to open (NOT a Link
//      navigation to /app/admin/gl/account/{id})
//   9. Apply via the canonical API path
//  10. Reload — assignment persisted on the target group
//  11. Separately: a PURE CLICK on the Name link still
//      navigates to the GL account page
//  12. Baseline + January parity preserved

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
  await page.screenshot({ path: `test-results/coa-map-3c-${name}.png` }).catch(() => undefined);
}
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

runAt("COA-MAP-3C · drag from Name cell → shared Preview → canonical reassign", async ({ browser }) => {
  test.setTimeout(600_000);
  const ctx: BrowserContext = await browser.newContext({ viewport: { width: 1650, height: 930 } });
  const page = await loginAsFounder(ctx);

  const before = await invariant(page);
  console.log("COA_MAP_3C_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);

  let fx: Fixture | null = null;
  try {
    fx = await createFixture(page);
    console.log("COA_MAP_3C_FIXTURE acct=" + fx.account.accountNumber + " groupA=" + fx.groupA.id + " groupB=" + fx.groupB.id);

    await page.goto(`${BASE}/app/admin/coa`, { waitUntil: "domcontentloaded" });
    await page.locator(".spectre-dw-table-wrap").waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(1500);
    await shot(page, "01-coa-ready");

    // ------------------------------------------------------------
    // §A  Drag from the NAME cell (the founder's natural grab point).
    // ------------------------------------------------------------
    const srcRow = page.locator(`[data-testid="coa-account-row-${fx.account.accountNumber}"]`).first();
    await srcRow.scrollIntoViewIfNeeded();
    const nameCell = srcRow.locator("td.name");
    const nameBox = await nameCell.boundingBox();
    if (!nameBox) throw new Error("name cell has no box");
    console.log("COA_MAP_3C_NAME_BOX " + JSON.stringify(nameBox));

    const targetHeader = page.locator(`[data-fs-group-id="${fx.groupB.id}"] .spectre-dw-sub-header`).first();
    await targetHeader.scrollIntoViewIfNeeded();
    const dstBox = await targetHeader.boundingBox();
    if (!dstBox) throw new Error("target header has no box");

    // Re-scroll source after target so src is in viewport.
    await srcRow.scrollIntoViewIfNeeded();
    const nameBox2 = await nameCell.boundingBox();
    if (!nameBox2) throw new Error("name cell has no box 2");

    await page.mouse.move(nameBox2.x + nameBox2.width / 3, nameBox2.y + nameBox2.height / 2);
    await page.waitForTimeout(100);
    await page.mouse.down();
    // Cross threshold.
    await page.mouse.move(nameBox2.x + nameBox2.width / 3 + 20, nameBox2.y + nameBox2.height / 2 + 30, { steps: 4 });
    await page.waitForTimeout(200);

    // §B  Floating overlay should now appear.
    const overlayVisible = await page.locator('[data-testid="coa-mapping-drag-overlay"]').isVisible().catch(() => false);
    console.log("COA_MAP_3C_OVERLAY_VISIBLE_ON_NAME_DRAG " + overlayVisible);
    expect(overlayVisible).toBe(true);
    const sourceFade = await srcRow.getAttribute("data-dragging-source");
    console.log("COA_MAP_3C_SOURCE_FADE " + sourceFade);
    expect(sourceFade).toBe("true");
    await shot(page, "02-drag-active-from-name");

    // §C  Move to the target header + release.
    await page.mouse.move(dstBox.x + dstBox.width / 2, dstBox.y + dstBox.height / 2, { steps: 10 });
    await page.waitForTimeout(200);
    await page.mouse.up();
    await page.waitForTimeout(400);

    // §D  Drawer should open with Reporting Impact — NOT a navigation.
    const stillOnCoa = page.url().includes("/app/admin/coa");
    console.log("COA_MAP_3C_URL_AFTER_DROP " + page.url());
    expect(stillOnCoa).toBe(true);
    const drawerVisible = await page.locator('[data-testid="coa-mapping-drawer-preview"]').isVisible().catch(() => false);
    console.log("COA_MAP_3C_DRAWER_OPENED " + drawerVisible);
    expect(drawerVisible).toBe(true);
    await shot(page, "03-drawer-opened");

    // §E  Cancel without persisting.
    await page.locator('[data-testid="coa-mapping-preview-cancel"]').click();
    await page.waitForTimeout(400);
    const historyAfterCancel = await page.request.get(`${BASE}/api/admin/coa-mapping/accounts/${fx.account.id}/history?clubId=${COULEE_CLUB_ID}`);
    const histBodyCancel = await historyAfterCancel.json();
    expect(histBodyCancel.history[histBodyCancel.history.length - 1].fsGroupId).toBe(fx.groupA.id);
    console.log("COA_MAP_3C_CANCEL_SAFE true");

    // §F  Apply via canonical API (drag UX is proven above; API
    //     path is proven here).  Uses the SAME endpoint the shared
    //     drawer calls on Apply.
    const applyResp = await page.request.post(`${BASE}/api/admin/coa-mapping/accounts/${fx.account.id}/reassign`, {
      data: {
        clubId: COULEE_CLUB_ID,
        targetFsGroupId: fx.groupB.id,
        effectiveFrom: new Date().toISOString().slice(0, 10),
      },
    });
    const applyBody = await applyResp.json().catch(() => ({}));
    console.log("COA_MAP_3C_APPLY_STATUS " + applyResp.status() + " outcome=" + (applyBody.outcome ?? "?"));
    expect(applyResp.status()).toBe(200);
    expect(applyBody.outcome).toBe("OK");

    await page.waitForTimeout(400);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".spectre-dw-table-wrap").waitFor({ state: "visible" });
    const historyAfterApply = await page.request.get(`${BASE}/api/admin/coa-mapping/accounts/${fx.account.id}/history?clubId=${COULEE_CLUB_ID}`);
    const histBodyApply = await historyAfterApply.json();
    const latest = histBodyApply.history[histBodyApply.history.length - 1];
    expect(latest.fsGroupId).toBe(fx.groupB.id);
    console.log("COA_MAP_3C_APPLY_PERSISTED true group=" + latest.fsGroupName);
    await shot(page, "04-after-reload-persisted");

    // ------------------------------------------------------------
    // §G  Pure CLICK on the Name link (no movement) still
    //     navigates to the GL account page — the Link remains
    //     functional for the non-drag case.
    // ------------------------------------------------------------
    await page.goto(`${BASE}/app/admin/coa`, { waitUntil: "domcontentloaded" });
    await page.locator(".spectre-dw-table-wrap").waitFor({ state: "visible" });
    const anyLink = page.locator("tr.spectre-dw-row td.name a").first();
    await anyLink.scrollIntoViewIfNeeded();
    const linkHref = await anyLink.getAttribute("href");
    console.log("COA_MAP_3C_NAME_LINK_HREF " + linkHref);
    expect(linkHref ?? "").toMatch(/^\/app\/admin\/gl\/account\//);
    await anyLink.click();
    await page.waitForTimeout(800);
    const urlAfterLink = page.url();
    console.log("COA_MAP_3C_URL_AFTER_LINK_CLICK " + urlAfterLink);
    expect(urlAfterLink).toContain("/app/admin/gl/account/");
    await shot(page, "05-link-click-navigated");
  } finally {
    if (fx) {
      await destroyFixture(page, fx.fixtureKey);
      console.log("COA_MAP_3C_FIXTURE_DELETED " + fx.fixtureKey);
    }
  }

  const after = await invariant(page);
  console.log("COA_MAP_3C_AFTER " + JSON.stringify({ club: after.club }));
  expect(after.club).toEqual(before.club);

  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01`, { waitUntil: "domcontentloaded" });
  const bodyText = await page.locator("body").innerText();
  const opRevPresent =
    bodyText.includes("$3,124,066.72") ||
    bodyText.includes("$3.12M") ||
    bodyText.includes("3,124,066");
  console.log("COA_MAP_3C_JAN_PARITY_OPREV " + opRevPresent);
  expect(opRevPresent).toBe(true);

  console.log(
    "COA_MAP_3C_AUTOMATED_PASS true · " +
    "name_drag_overlay=true · source_fade=true · drop_opens_drawer=true · " +
    "did_not_navigate_mid_drop=true · cancel_safe=true · apply_persisted=true · " +
    "pure_click_navigates=true · baseline_preserved=true · jan_parity=true",
  );

  await ctx.close();
});
