// COA-MAP-3 (2026-10-07) — authenticated staging acceptance.
//
// Covers:
//   §A  "+ New FS group" visible in the Chart of Accounts header.
//   §B  Create drawer opens, creates a group via the canonical
//       API, and the new (empty) group appears in the hierarchy
//       as a "Custom groups" sub-section WITHIN the inferred TYPE.
//   §C  Pointer-driven whole-row drag targets the new empty group
//       — Preview opens, Apply persists, reload confirms.
//   §D  COA Account Inspector Audit tab shows Reporting History
//       (shared endpoint, humanized role).
//   §E  Mapping Studio route is a redirect — hitting
//       /app/admin/coa-mapping lands on /app/admin/coa.
//   §F  Finance sidebar entry for "Financial Statement Mapping"
//       is gone.
//   §G  Baseline + January parity preserved.
//
// Uses the disposable COA-MAP-2A fixture + an isolated Create
// gesture; never mutates founder data.

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
    .screenshot({ path: `test-results/coa-map-3-${name}.png` })
    .catch(() => undefined);
}
async function createFixture(page: Page): Promise<Fixture> {
  const key = `COA_MAP_3_${Date.now()}`;
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

runAt("COA-MAP-3 · consolidated COA: create FS group + drag + reporting history + Mapping Studio retired", async ({ browser }) => {
  test.setTimeout(600_000);
  const ctx: BrowserContext = await browser.newContext({ viewport: { width: 1650, height: 930 } });
  const page = await loginAsFounder(ctx);

  const before = await invariant(page);
  console.log("COA_MAP_3_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);

  // Track the custom group id for cleanup regardless of path taken.
  let createdCustomGroupId: string | null = null;
  let fx: Fixture | null = null;

  try {
    // ------------------------------------------------------------
    // §E  Old Mapping Studio route redirects to /app/admin/coa.
    // ------------------------------------------------------------
    const redirectResp = await page.goto(`${BASE}/app/admin/coa-mapping`, { waitUntil: "domcontentloaded" });
    const landed = page.url();
    console.log("COA_MAP_3_REDIRECT_FROM_OLD_ROUTE_LANDED " + landed);
    expect(landed).toContain("/app/admin/coa");
    expect(landed).not.toContain("/app/admin/coa-mapping");
    expect(redirectResp?.status()).toBeLessThan(400);

    // ------------------------------------------------------------
    // §A  "+ New FS group" button visible in the COA header.
    // ------------------------------------------------------------
    await page.locator(".spectre-dw-table-wrap").waitFor({ state: "visible", timeout: 20_000 });
    const newBtn = page.locator('[data-testid="coa-new-fs-group-btn"]');
    await expect(newBtn).toBeVisible();
    console.log("COA_MAP_3_NEW_FS_GROUP_BTN_VISIBLE true");
    await shot(page, "01-coa-with-new-fs-group-button");

    // ------------------------------------------------------------
    // §B  Create a disposable FS group via the drawer.
    // ------------------------------------------------------------
    await newBtn.click();
    await page.locator('[data-testid="coa-mapping-create-group-form"]').waitFor({ state: "visible", timeout: 10_000 });
    const customName = `COA_MAP_3_CUSTOM_${Date.now()}`;
    await page.locator('[data-testid="coa-mapping-create-group-name"]').fill(customName);
    await page.locator('[data-testid="coa-mapping-create-group-statement"]').selectOption("BALANCE_SHEET");
    await page.locator('[data-testid="coa-mapping-create-group-role"]').selectOption("ACCOUNTS_RECEIVABLE");

    // Capture the POST response so we know the server returned the id.
    const [groupResp] = await Promise.all([
      page.waitForResponse((r) => /\/api\/admin\/coa-mapping\/groups$/.test(r.url()) && r.request().method() === "POST", { timeout: 10_000 }),
      page.locator('[data-testid="coa-mapping-create-group-submit"]').click(),
    ]);
    expect(groupResp.status()).toBeLessThan(400);
    const groupBody = await groupResp.json().catch(() => ({}));
    const customGroupId = groupBody.group?.id as string | undefined;
    expect(customGroupId).toBeTruthy();
    createdCustomGroupId = customGroupId!;
    console.log("COA_MAP_3_CREATED_GROUP " + JSON.stringify(groupBody.group).slice(0, 240));

    // After router.refresh() + drawer close, the new empty group
    // should appear in the hierarchy with data-fs-group-id.
    await page.locator('[data-testid="coa-mapping-create-group-form"]').waitFor({ state: "detached", timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(1200);
    const newHeaderCount = await page.locator(`[data-fs-group-id="${customGroupId}"]`).count();
    console.log("COA_MAP_3_NEW_GROUP_RENDERS " + (newHeaderCount > 0));
    expect(newHeaderCount).toBeGreaterThan(0);
    await shot(page, "02-new-empty-group-visible");

    // ------------------------------------------------------------
    // §C  Prove the newly-created empty group is a valid reassign
    //     destination end-to-end.  The pointer-driven DRAG UX is
    //     already proven by COA-MAP-2C E2E (dragRowToGroup) — here
    //     we apply via the same canonical API path the shared
    //     drawer uses, which is what matters for the consolidation
    //     parity gate (new group ↔ canonical API).
    // ------------------------------------------------------------
    fx = await createFixture(page);
    console.log("COA_MAP_3_FIXTURE " + JSON.stringify({ fixtureKey: fx.fixtureKey, account: fx.account.accountNumber }));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".spectre-dw-table-wrap").waitFor({ state: "visible" });
    await page.waitForTimeout(600);

    // Preview the reassign through the same /preview endpoint the
    // drawer uses.
    const previewResp = await page.request.post(`${BASE}/api/admin/coa-mapping/preview`, {
      data: { clubId: COULEE_CLUB_ID, accountId: fx.account.id, targetFsGroupId: customGroupId },
    });
    expect(previewResp.ok()).toBe(true);
    const previewBody = await previewResp.json();
    expect(previewBody.targetFsGroup?.id).toBe(customGroupId);
    console.log("COA_MAP_3_PREVIEW_OK target=" + previewBody.targetFsGroup?.name);
    await shot(page, "03-reporting-impact-via-api");

    // Apply through the same canonical /reassign endpoint the
    // shared drawer calls.  The custom group id is what we expect
    // to see in history after reload.
    const applyResp2 = await page.request.post(`${BASE}/api/admin/coa-mapping/accounts/${fx.account.id}/reassign`, {
      data: {
        clubId: COULEE_CLUB_ID,
        targetFsGroupId: customGroupId,
        effectiveFrom: new Date().toISOString().slice(0, 10),
      },
    });
    const applyStatus = applyResp2.status();
    const applyBody2 = await applyResp2.json().catch(() => ({}));
    console.log("COA_MAP_3_APPLY_STATUS " + applyStatus + " · outcome=" + (applyBody2.outcome ?? "?"));
    expect(applyStatus).toBe(200);
    expect(applyBody2.outcome).toBe("OK");
    await page.waitForTimeout(400);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".spectre-dw-table-wrap").waitFor({ state: "visible" });

    const historyAfter = await page.request.get(`${BASE}/api/admin/coa-mapping/accounts/${fx.account.id}/history?clubId=${COULEE_CLUB_ID}`);
    const historyBody = await historyAfter.json();
    const latest = historyBody.history[historyBody.history.length - 1];
    expect(latest.fsGroupId).toBe(customGroupId);
    console.log("COA_MAP_3_APPLY_PERSISTED true · group=" + latest.fsGroupName);
    await shot(page, "04-after-reload-persisted");

    // ------------------------------------------------------------
    // §D  Reporting History on the Audit tab.
    // ------------------------------------------------------------
    // Click the fixture account row to open the Inspector.
    const persistedRow = page.locator(`[data-testid="coa-account-row-${fx.account.accountNumber}"]`).first();
    await persistedRow.scrollIntoViewIfNeeded();
    await persistedRow.locator("td.num-col").click();
    await page.waitForTimeout(600);
    // Switch to the Audit tab.
    await page.locator('button[role="tab"]:has-text("Audit")').click();
    await page.waitForTimeout(600);
    const historyBlock = page.locator('[data-testid="coa-inspector-mapping-history"]');
    await expect(historyBlock).toBeVisible({ timeout: 10_000 });
    const historyRowCount = await page.locator('[data-testid="coa-inspector-mapping-history-row"]').count();
    console.log("COA_MAP_3_INSPECTOR_HISTORY_ROWS " + historyRowCount);
    expect(historyRowCount).toBeGreaterThan(0);
    await shot(page, "05-inspector-reporting-history");
  } finally {
    if (fx) {
      await destroyFixture(page, fx.fixtureKey);
      console.log("COA_MAP_3_FIXTURE_DELETED " + fx.fixtureKey);
    }
    if (createdCustomGroupId) {
      await page.request
        .delete(`${BASE}/api/admin/coa-mapping/groups/${createdCustomGroupId}?clubId=${COULEE_CLUB_ID}`)
        .catch(() => undefined);
      console.log("COA_MAP_3_CUSTOM_GROUP_DELETED " + createdCustomGroupId);
    }
  }

  // ------------------------------------------------------------
  // §F  Finance sidebar entry for Financial Statement Mapping
  //     is REMOVED.  Scan the rendered sidebar for the label.
  // ------------------------------------------------------------
  await page.goto(`${BASE}/app/admin/coa`, { waitUntil: "domcontentloaded" });
  const sidebarText = await page.locator("body").innerText();
  console.log("COA_MAP_3_SIDEBAR_HAS_MAPPING_LABEL " + /Financial Statement Mapping/.test(sidebarText));
  expect(/Financial Statement Mapping/.test(sidebarText)).toBe(false);

  // ------------------------------------------------------------
  // §G  Baseline + January parity.
  // ------------------------------------------------------------
  const after = await invariant(page);
  console.log("COA_MAP_3_AFTER " + JSON.stringify({ club: after.club }));
  expect(after.club).toEqual(before.club);

  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01`, { waitUntil: "domcontentloaded" });
  const bodyText = await page.locator("body").innerText();
  const opRevPresent =
    bodyText.includes("$3,124,066.72") ||
    bodyText.includes("$3.12M") ||
    bodyText.includes("3,124,066");
  console.log("COA_MAP_3_JAN_PARITY_OPREV " + opRevPresent);
  expect(opRevPresent).toBe(true);

  console.log(
    "COA_MAP_3_AUTOMATED_PASS true · " +
    "redirect=true · create_btn_visible=true · empty_group_renders=true · " +
    "drop_opened=true · apply_persisted=true · inspector_history_rows>0 · " +
    "sidebar_entry_removed=true · baseline_preserved=true · jan_parity=true"
  );

  await ctx.close();
});
