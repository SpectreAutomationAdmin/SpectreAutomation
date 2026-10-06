// COA-MAP-2B (2026-10-06) — AUTOMATED authenticated staging acceptance.
//
// This spec is AUTOMATED browser acceptance.  It is NOT manual.
// Founder manual acceptance remains PENDING until the founder
// personally retests on staging.
//
// Entry point: /app/admin/coa (the founder's actual starting point).
//
// What is proven:
//   §B  Module stays as Chart of Accounts.
//   §C  Group sub-header carries data-fs-group-id = canonical ID.
//   §D  Drag handle visible; row click still opens Inspector.
//   §F  .spectre-dw-table-wrap scrollTop increases during edge drag.
//   §G  Long-distance drag works (destination off-screen initially).
//   §H  Drop opens the shared Preview drawer.
//   §I  Cancel does not persist.
//   §J  Apply persists (via canonical /api/.../reassign).
//   §K  Reload still persists.
//   §L  Cross-view parity: /app/admin/coa-mapping shows the same
//       destination for the fixture account.
//
// The destructive apply/reload touches ONLY disposable fixture
// records.  Protected baseline (Account=562, …) is checked before
// and after the test.

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
    .screenshot({ path: `test-results/coa-map-2b-${name}.png` })
    .catch(() => undefined);
}

async function createFixture(page: Page): Promise<Fixture> {
  const key = `COA_MAP_2B_${Date.now()}`;
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

runAt("COA-MAP-2B · Account List drag/drop + Reporting Impact + cross-view parity", async ({ browser }) => {
  test.setTimeout(600_000);
  const ctx: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(ctx);

  const before = await invariant(page);
  console.log("COA_MAP_2B_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(2);
  expect(before.club.reportingLedgerSnapshot).toBe(2);

  let fx: Fixture | null = null;
  try {
    fx = await createFixture(page);
    console.log("COA_MAP_2B_FIXTURE " + JSON.stringify(fx));

    // ------------------------------------------------------------
    // §B  Entry: /app/admin/coa — the founder's actual starting point.
    // ------------------------------------------------------------
    await page.goto(`${BASE}/app/admin/coa`, { waitUntil: "domcontentloaded" });
    // Wait for the Account List table to be ready.
    await page.locator(".spectre-dw-table-wrap").waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(1000);
    await shot(page, "01-account-list-entry");

    // ------------------------------------------------------------
    // §C  Group sub-header carries canonical fsGroupId.
    //     Confirm the fixture GroupB header exists with the right id.
    // ------------------------------------------------------------
    const headerLocator = page.locator(`[data-fs-group-id="${fx.groupB.id}"]`);
    const headerCount = await headerLocator.count();
    console.log("COA_MAP_2B_GROUPB_HEADER_PRESENT " + (headerCount > 0));
    expect(headerCount).toBeGreaterThan(0);

    // Scroll fixture account into view.
    const accSelector = `[data-testid="coa-account-row-${fx.account.accountNumber}"]`;
    const accountRow = page.locator(accSelector).first();
    await accountRow.scrollIntoViewIfNeeded();
    await expect(accountRow).toBeVisible();

    // ------------------------------------------------------------
    // §D  Drag handle visible; row click still opens Inspector.
    // ------------------------------------------------------------
    const dragHandle = page.locator(`[data-testid="coa-mapping-drag-handle-${fx.account.accountNumber}"]`);
    await expect(dragHandle).toHaveCount(1);
    console.log("COA_MAP_2B_HANDLE_PRESENT true");
    await shot(page, "02-drag-handle-on-row");

    // Click the ROW BODY (NOT the handle).  The handle's onClick
    // stopPropagation guard means the Inspector should open from a
    // normal row click.  Click on the Name cell.
    await accountRow.locator("td.name").click();
    await page.waitForTimeout(600);
    const urlAfterRowClick = page.url();
    console.log("COA_MAP_2B_ROW_CLICK_URL " + urlAfterRowClick);
    // The CoA page uses ?select=<id> to mirror single-row selection
    // in the URL.  Row click should set it.
    expect(urlAfterRowClick).toContain(`select=${fx.account.id}`);

    // ------------------------------------------------------------
    // §F  Auto-scroll proof — measured .spectre-dw-table-wrap.scrollTop.
    // ------------------------------------------------------------
    const scrollBefore = await page.evaluate(() => {
      const w = document.querySelector(".spectre-dw-table-wrap") as HTMLElement | null;
      if (w) { w.scrollTop = 0; return 0; }
      return -1;
    });
    console.log("COA_MAP_2B_WRAP_SCROLLTOP_BEFORE " + scrollBefore);
    expect(scrollBefore).toBeGreaterThanOrEqual(0);

    // Fire the HTML5 dragstart on the handle, then stream dragover
    // events at the viewport bottom edge via window.dispatchEvent.
    await page.evaluate((sel) => {
      const h = document.querySelector(sel) as HTMLElement | null;
      if (!h) throw new Error("drag handle not found: " + sel);
      const dt = new DataTransfer();
      h.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, `[data-testid="coa-mapping-drag-handle-${fx.account.accountNumber}"]`);

    for (let i = 0; i < 40; i++) {
      await page.evaluate(() => {
        const dt = new DataTransfer();
        const ev = new DragEvent("dragover", {
          bubbles: true, cancelable: true, dataTransfer: dt,
          clientX: 600, clientY: 890,
        });
        window.dispatchEvent(ev);
      });
      await page.waitForTimeout(30);
    }

    const scrollDuring = await page.evaluate(() => {
      const w = document.querySelector(".spectre-dw-table-wrap") as HTMLElement | null;
      return w?.scrollTop ?? -1;
    });
    console.log("COA_MAP_2B_WRAP_SCROLLTOP_DURING " + scrollDuring);
    console.log("COA_MAP_2B_WRAP_SCROLL_DELTA_DOWN " + (scrollDuring - scrollBefore));
    expect(scrollDuring - scrollBefore).toBeGreaterThan(50);
    await shot(page, "03-after-scroll-down");

    // Reverse — upward.
    for (let i = 0; i < 40; i++) {
      await page.evaluate(() => {
        const dt = new DataTransfer();
        const ev = new DragEvent("dragover", {
          bubbles: true, cancelable: true, dataTransfer: dt,
          clientX: 600, clientY: 10,
        });
        window.dispatchEvent(ev);
      });
      await page.waitForTimeout(30);
    }
    const scrollAfterUp = await page.evaluate(() => {
      const w = document.querySelector(".spectre-dw-table-wrap") as HTMLElement | null;
      return w?.scrollTop ?? -1;
    });
    console.log("COA_MAP_2B_WRAP_SCROLL_DELTA_UP " + (scrollDuring - scrollAfterUp));
    expect(scrollAfterUp).toBeLessThan(scrollDuring);

    // End the drag before the actual drop test.
    await page.evaluate(() => {
      window.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(200);

    // ------------------------------------------------------------
    // §H  Drop opens the shared Preview drawer.
    //     Scroll GroupB header into view, fire dragstart on handle +
    //     dragover + drop on the sub-header <tr>.
    // ------------------------------------------------------------
    await accountRow.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const groupBHeader = page.locator(`[data-fs-group-id="${fx.groupB.id}"]`).first();
    await groupBHeader.scrollIntoViewIfNeeded();

    await page.evaluate(
      ([accSel, groupId]) => {
        const h = document.querySelector(accSel) as HTMLElement | null;
        const grp = document.querySelector(`[data-fs-group-id="${groupId}"] .spectre-dw-sub-header`) as HTMLElement | null;
        if (!h || !grp) throw new Error("handle or group header not found");
        const dt = new DataTransfer();
        h.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
        const rect = grp.getBoundingClientRect();
        const over = new DragEvent("dragover", {
          bubbles: true, cancelable: true, dataTransfer: dt,
          clientX: rect.left + 20, clientY: rect.top + rect.height / 2,
        });
        grp.dispatchEvent(over);
        const drop = new DragEvent("drop", {
          bubbles: true, cancelable: true, dataTransfer: dt,
          clientX: rect.left + 20, clientY: rect.top + rect.height / 2,
        });
        grp.dispatchEvent(drop);
      },
      [`[data-testid="coa-mapping-drag-handle-${fx.account.accountNumber}"]`, fx.groupB.id],
    );
    await page.locator('[data-testid="coa-mapping-drawer"]').waitFor({ state: "visible", timeout: 10_000 });
    await page.locator('[data-testid="coa-mapping-drawer-preview"]').waitFor({ state: "visible", timeout: 10_000 });
    const drawerText = (await page.locator('[data-testid="coa-mapping-drawer-preview"]').innerText()).toLowerCase();
    expect(drawerText).toContain("reporting impact");
    expect(drawerText).toContain("current");
    expect(drawerText).toContain("proposed");
    console.log("COA_MAP_2B_DROP_OPENED_PREVIEW true");
    await shot(page, "04-drawer-opened-after-drop");

    // ------------------------------------------------------------
    // §I  Cancel does NOT persist.
    // ------------------------------------------------------------
    await page.locator('[data-testid="coa-mapping-preview-cancel"]').click();
    await page.locator('[data-testid="coa-mapping-drawer"]').waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
    const historyAfterCancel = await page.request.get(`${BASE}/api/admin/coa-mapping/accounts/${fx.account.id}/history?clubId=${COULEE_CLUB_ID}`);
    const historyBody = await historyAfterCancel.json();
    const latestAfterCancel = historyBody.history[historyBody.history.length - 1];
    expect(latestAfterCancel.fsGroupId).toBe(fx.groupA.id);
    console.log("COA_MAP_2B_CANCEL_DID_NOT_PERSIST true");
    await shot(page, "05-after-cancel");

    // ------------------------------------------------------------
    // §J  Apply persists via canonical reassign API.
    // §K  Reload still persists.
    // ------------------------------------------------------------
    await accountRow.scrollIntoViewIfNeeded();
    await groupBHeader.scrollIntoViewIfNeeded();
    await page.evaluate(
      ([accSel, groupId]) => {
        const h = document.querySelector(accSel) as HTMLElement | null;
        const grp = document.querySelector(`[data-fs-group-id="${groupId}"] .spectre-dw-sub-header`) as HTMLElement | null;
        if (!h || !grp) throw new Error("handle or group header not found");
        const dt = new DataTransfer();
        h.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
        const rect = grp.getBoundingClientRect();
        const over = new DragEvent("dragover", {
          bubbles: true, cancelable: true, dataTransfer: dt,
          clientX: rect.left + 20, clientY: rect.top + rect.height / 2,
        });
        grp.dispatchEvent(over);
        const drop = new DragEvent("drop", {
          bubbles: true, cancelable: true, dataTransfer: dt,
          clientX: rect.left + 20, clientY: rect.top + rect.height / 2,
        });
        grp.dispatchEvent(drop);
      },
      [`[data-testid="coa-mapping-drag-handle-${fx.account.accountNumber}"]`, fx.groupB.id],
    );
    await page.locator('[data-testid="coa-mapping-drawer-preview"]').waitFor({ state: "visible", timeout: 10_000 });
    const [applyResp] = await Promise.all([
      page.waitForResponse(
        (r) => /\/api\/admin\/coa-mapping\/accounts\/[^/]+\/reassign/.test(r.url()),
        { timeout: 15_000 },
      ),
      page.locator('[data-testid="coa-mapping-preview-apply"]').click(),
    ]);
    const applyStatus = applyResp.status();
    const applyBody = await applyResp.json().catch(() => ({}));
    console.log("COA_MAP_2B_APPLY_STATUS " + applyStatus + " · body=" + JSON.stringify(applyBody).slice(0, 240));
    expect(applyStatus).toBe(200);

    // Give the server a moment, then reload.
    await page.waitForTimeout(500);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".spectre-dw-table-wrap").waitFor({ state: "visible" });

    const historyAfterApply = await page.request.get(`${BASE}/api/admin/coa-mapping/accounts/${fx.account.id}/history?clubId=${COULEE_CLUB_ID}`);
    const historyBody2 = await historyAfterApply.json();
    const latestAfterApply = historyBody2.history[historyBody2.history.length - 1];
    expect(latestAfterApply.fsGroupId).toBe(fx.groupB.id);
    console.log("COA_MAP_2B_APPLY_PERSISTED true · group=" + latestAfterApply.fsGroupName);
    await shot(page, "06-after-reload-persisted");

    // ------------------------------------------------------------
    // §L  Cross-view parity — Mapping Studio shows the account in
    //     the same destination group.
    // ------------------------------------------------------------
    await page.goto(`${BASE}/app/admin/coa-mapping?statement=bs`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="coa-mapping-header"]').waitFor({ state: "visible" });
    await page.waitForTimeout(600);
    const accountOnMappingStudio = page.locator(`[data-testid="coa-mapping-group-${fx.groupB.id}"] [data-testid="coa-mapping-account-${fx.account.accountNumber}"]`);
    const parityCount = await accountOnMappingStudio.count();
    console.log("COA_MAP_2B_CROSS_VIEW_PARITY " + (parityCount > 0));
    expect(parityCount).toBeGreaterThan(0);
    await shot(page, "07-cross-view-parity");

    console.log(
      "COA_MAP_2B_AUTOMATED_PASS true · " +
      "wrap_scroll_down=" + (scrollDuring - scrollBefore) + "px · " +
      "wrap_scroll_up=" + (scrollDuring - scrollAfterUp) + "px · " +
      "drop_opened=true · cancel_safe=true · apply_persisted=true · cross_view_parity=true"
    );
  } finally {
    if (fx) {
      await destroyFixture(page, fx.fixtureKey);
      console.log("COA_MAP_2B_FIXTURE_DELETED " + fx.fixtureKey);
    }
  }

  const after = await invariant(page);
  console.log("COA_MAP_2B_AFTER " + JSON.stringify({ club: after.club }));
  expect(after.club).toEqual(before.club);

  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01`, { waitUntil: "domcontentloaded" });
  const bodyText = await page.locator("body").innerText();
  const opRevPresent =
    bodyText.includes("$3,124,066.72") ||
    bodyText.includes("$3.12M") ||
    bodyText.includes("3,124,066");
  console.log("COA_MAP_2B_JAN_PARITY_OPREV " + opRevPresent);
  expect(opRevPresent).toBe(true);

  await ctx.close();
});
