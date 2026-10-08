// COA-MAP-3B (2026-10-07) — authenticated staging acceptance.
//
//   §A  Hitting whoami with NO session cookie returns a structured
//       401 JSON { status: "unauthenticated", cookiesPresent } —
//       NOT an opaque HTTP 500 like the founder reported.
//   §B  Hitting whoami with the founder-equivalent session returns
//       the full identity + permissions payload.
//   §C  COA page renders the Edit action in the Inspector HEAD
//       meta row (coa-inspector-head-edit-<accountNumber>), not
//       just in the footer.
//   §D  Clicking the head Edit action enters edit mode; Save +
//       Cancel surface in the head alongside the pills.
//   §E  Baseline + January parity preserved.

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
  await page.screenshot({ path: `test-results/coa-map-3b-${name}.png` }).catch(() => undefined);
}

runAt("COA-MAP-3B · whoami hardening + Inspector header Edit", async ({ browser }) => {
  test.setTimeout(300_000);

  // ------------------------------------------------------------
  // §A  UNAUTHENTICATED request to whoami → structured 401, not 500.
  // ------------------------------------------------------------
  const anonCtx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
  const anonResp = await anonCtx.request.get(`${BASE}/api/admin/testing/whoami?clubId=${COULEE_CLUB_ID}`, {
    headers: { "cookie": "" }, // explicitly no session cookie
  });
  console.log("COA_MAP_3B_ANON_STATUS " + anonResp.status());
  // The key gate — the pre-COA-MAP-3B endpoint returned 500 here.
  expect(anonResp.status()).toBe(401);
  const anonBody = await anonResp.json().catch(() => ({}));
  console.log("COA_MAP_3B_ANON_BODY " + JSON.stringify(anonBody));
  expect(anonBody.status).toBe("unauthenticated");
  expect("cookiesPresent" in anonBody).toBe(true);
  await anonCtx.close();

  // ------------------------------------------------------------
  // §B  AUTHENTICATED whoami returns full payload.
  // ------------------------------------------------------------
  const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
  const page = await loginAsFounder(ctx);
  const before = await invariant(page);
  console.log("COA_MAP_3B_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);

  const authedResp = await page.request.get(`${BASE}/api/admin/testing/whoami?clubId=${COULEE_CLUB_ID}`);
  console.log("COA_MAP_3B_AUTHED_STATUS " + authedResp.status());
  expect(authedResp.status()).toBe(200);
  const authedBody = await authedResp.json();
  console.log("COA_MAP_3B_AUTHED_BODY " + JSON.stringify(authedBody, null, 2));
  expect(authedBody.status).toBe("ok");
  expect(typeof authedBody.user?.email).toBe("string");

  // ------------------------------------------------------------
  // §C + §D  Inspector header Edit action.
  // ------------------------------------------------------------
  await page.goto(`${BASE}/app/admin/coa`, { waitUntil: "domcontentloaded" });
  await page.locator(".spectre-dw-table-wrap").waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForTimeout(1000);

  const firstAccount = page.locator('[data-testid^="coa-account-row-"]').first();
  await firstAccount.scrollIntoViewIfNeeded();
  const accNum = await firstAccount.getAttribute("data-testid");
  const num = accNum?.replace(/^coa-account-row-/, "") ?? "";
  await firstAccount.locator("td.num-col").click();
  await page.waitForTimeout(1000);
  await shot(page, "01-inspector-open-viewing-mode");

  // The HEAD Edit action should be visible.
  const headEditSel = `[data-testid="coa-inspector-head-edit-${num}"]`;
  const headEdit = page.locator(headEditSel).first();
  await expect(headEdit).toBeVisible({ timeout: 10_000 });
  const headEditText = await headEdit.innerText();
  console.log("COA_MAP_3B_HEAD_EDIT_TEXT " + JSON.stringify(headEditText));
  expect(headEditText.toLowerCase()).toContain("edit");

  // Clicking the head Edit should enter edit mode and surface
  // Save / Cancel in the head.
  await headEdit.click();
  await page.waitForTimeout(600);
  const headSave = page.locator('[data-testid="coa-inspector-head-save"]');
  const headDiscard = page.locator('[data-testid="coa-inspector-head-discard"]');
  await expect(headSave).toBeVisible();
  await expect(headDiscard).toBeVisible();
  console.log("COA_MAP_3B_HEAD_SAVE_VISIBLE true");
  console.log("COA_MAP_3B_HEAD_DISCARD_VISIBLE true");
  await shot(page, "02-inspector-head-save-cancel");

  // Verify the actual <input> for Name is now rendered (edit mode).
  const nameInput = page.locator('[data-testid="coa-inspector-field-name"]');
  await expect(nameInput).toBeVisible();
  console.log("COA_MAP_3B_NAME_INPUT_VISIBLE true");

  // Cancel without saving — no mutation.
  await headDiscard.click();
  await page.waitForTimeout(600);
  const afterCancelInputCount = await nameInput.count();
  console.log("COA_MAP_3B_NAME_INPUT_AFTER_CANCEL " + afterCancelInputCount);
  // In viewing mode the name <input> is removed; the display text takes over.
  expect(afterCancelInputCount).toBe(0);
  await shot(page, "03-inspector-after-cancel");

  // ------------------------------------------------------------
  // §E  Baseline + January parity.
  // ------------------------------------------------------------
  const after = await invariant(page);
  console.log("COA_MAP_3B_AFTER " + JSON.stringify({ club: after.club }));
  expect(after.club).toEqual(before.club);

  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01`, { waitUntil: "domcontentloaded" });
  const bodyText = await page.locator("body").innerText();
  const opRevPresent =
    bodyText.includes("$3,124,066.72") ||
    bodyText.includes("$3.12M") ||
    bodyText.includes("3,124,066");
  console.log("COA_MAP_3B_JAN_PARITY_OPREV " + opRevPresent);
  expect(opRevPresent).toBe(true);

  console.log(
    "COA_MAP_3B_AUTOMATED_PASS true · " +
    "whoami_anon=401 · whoami_authed=200 · " +
    "head_edit_visible=true · head_save_visible=true · head_discard_visible=true · " +
    "name_input_edit_mode=true · cancel_restored=true · " +
    "baseline_preserved=true · jan_parity=true",
  );

  await ctx.close();
});
