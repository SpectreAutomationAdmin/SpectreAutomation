// COA-MAP-3A (2026-10-07) — authenticated staging acceptance.
//
//   §A  Whoami diagnostic reports the founder's effective role +
//       permissions on Coulee.  (Read-only — proves the diagnosis
//       the founder needs to decide whether to grant CONTROLLER
//       to her gmail user or sign in as the dedicated Controller.)
//   §B  Inspector FS Group field renders as display + "Change…"
//       button (NOT a direct-write <select>).  The Change button
//       is gated on canEdit.
//   §C  Baseline + January parity preserved.
//
// This slice does NOT perform the role grant.  If the whoami probe
// shows the signed-in user lacks `coa:write` on Coulee, the
// Change button is correctly hidden — that is the EXPECTED
// behaviour given the current UserClubRole assignment.  The
// founder must decide whether to:
//   (1) sign in as the Coulee Controller
//       (`cturcato@spectreautomation.com`), or
//   (2) authorize a founder-approved script to add CONTROLLER on
//       Coulee for the gmail user.

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";
const COA_BATCH_ID = "cmuni5ymv000k136q3xdyrpmn";
const COULEE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";

async function invariant(page: Page) {
  const r = await page.request.get(`${BASE}/api/admin/coa-batch-diagnostic/${COA_BATCH_ID}`);
  expect(r.ok()).toBe(true);
  return r.json();
}
async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `test-results/coa-map-3a-${name}.png` }).catch(() => undefined);
}

runAt("COA-MAP-3A · Controller role diagnosis + Inspector UX (canonical FS Group reassign)", async ({ browser }) => {
  test.setTimeout(300_000);
  const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
  const page = await loginAsFounder(ctx);

  const before = await invariant(page);
  console.log("COA_MAP_3A_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);

  // ------------------------------------------------------------
  // §A  Whoami diagnostic — report the founder's effective role.
  // ------------------------------------------------------------
  const whoamiResp = await page.request.get(`${BASE}/api/admin/testing/whoami?clubId=${COULEE_CLUB_ID}`);
  expect(whoamiResp.ok()).toBe(true);
  const whoami = await whoamiResp.json();
  console.log("COA_MAP_3A_WHOAMI " + JSON.stringify(whoami, null, 2));

  // Record a plain-text summary of what the founder's login
  // actually holds on Coulee.
  const couleeRoles = (whoami.memberships as Array<{ clubId: string | null; roleKey: string }>)
    .filter((m) => m.clubId === COULEE_CLUB_ID)
    .map((m) => m.roleKey);
  console.log("COA_MAP_3A_COULEE_ROLES " + JSON.stringify(couleeRoles));
  console.log("COA_MAP_3A_HAS_COA_WRITE_ON_COULEE " + Boolean(whoami.permissions?.["coa:write"]));
  console.log("COA_MAP_3A_IS_SUPER_ADMIN " + Boolean(whoami.superAdmin));

  // ------------------------------------------------------------
  // §B  COA page — Inspector FS Group field.
  // ------------------------------------------------------------
  await page.goto(`${BASE}/app/admin/coa`, { waitUntil: "domcontentloaded" });
  await page.locator(".spectre-dw-table-wrap").waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForTimeout(1000);
  await shot(page, "01-coa-with-inspector-closed");

  // Pick an account.  Click num-col (not the <Link> in td.name
  // which would navigate away).
  const firstAccount = page.locator('[data-testid^="coa-account-row-"]').first();
  await firstAccount.scrollIntoViewIfNeeded();
  await firstAccount.locator("td.num-col").click();
  await page.waitForTimeout(1000);
  await shot(page, "02-inspector-open");

  // The Inspector should be visible; if the viewer has canEdit,
  // the Edit button is enabled; if not, the Edit (permission
  // required) placeholder shows.  Either state is CORRECT
  // behaviour given the signed-in user's effective role.
  const editEnabled = (await page.locator('button:has-text("Edit")').count()) > 0;
  const editDisabled = (await page.locator('span[data-disabled-reason="no-coa-write"]').count()) > 0;
  console.log("COA_MAP_3A_INSPECTOR_EDIT_BUTTON_ENABLED " + editEnabled);
  console.log("COA_MAP_3A_INSPECTOR_EDIT_BUTTON_DISABLED_PLACEHOLDER " + editDisabled);

  // Expect at least one of the two states to be rendered (one and
  // only one Edit affordance should appear depending on canEdit).
  expect(editEnabled || editDisabled).toBe(true);

  // ------------------------------------------------------------
  // If the viewer has coa:write, enter edit mode and verify the
  // FS Group field is display + "Change…" (NOT a <select>).
  // ------------------------------------------------------------
  if (editEnabled) {
    await page.locator('button:has-text("Edit")').first().click();
    await page.waitForTimeout(500);
    const fsgDisplayCount = await page.locator('[data-testid="coa-inspector-field-fsgroup-display"]').count();
    const fsgSelectCount = await page.locator('[data-testid="coa-inspector-field-fsgroup"]').count();
    const changeBtnCount = await page.locator('[data-testid="coa-inspector-field-fsgroup-change-btn"]').count();
    console.log(
      "COA_MAP_3A_INSPECTOR_FSGROUP_FIELD " +
      JSON.stringify({ fsgDisplayCount, fsgSelectCount, changeBtnCount }),
    );
    expect(fsgDisplayCount).toBeGreaterThan(0);
    expect(fsgSelectCount).toBe(0);
    expect(changeBtnCount).toBeGreaterThan(0);
    await shot(page, "03-inspector-edit-mode");
  } else {
    console.log("COA_MAP_3A_INSPECTOR_FSGROUP_FIELD skipped — viewer lacks coa:write");
    await shot(page, "03-inspector-view-only-no-coa-write");
  }

  // ------------------------------------------------------------
  // §C  Baseline + January parity.
  // ------------------------------------------------------------
  const after = await invariant(page);
  console.log("COA_MAP_3A_AFTER " + JSON.stringify({ club: after.club }));
  expect(after.club).toEqual(before.club);

  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01`, { waitUntil: "domcontentloaded" });
  const bodyText = await page.locator("body").innerText();
  const opRevPresent =
    bodyText.includes("$3,124,066.72") ||
    bodyText.includes("$3.12M") ||
    bodyText.includes("3,124,066");
  console.log("COA_MAP_3A_JAN_PARITY_OPREV " + opRevPresent);
  expect(opRevPresent).toBe(true);

  console.log(
    "COA_MAP_3A_AUTOMATED_PASS true · " +
    "whoami_served=true · " +
    "coulee_roles=" + JSON.stringify(couleeRoles) + " · " +
    "has_coa_write=" + Boolean(whoami.permissions?.["coa:write"]) + " · " +
    "inspector_edit_button_shown=" + (editEnabled || editDisabled) + " · " +
    "baseline_preserved=true · jan_parity=true",
  );

  await ctx.close();
});
