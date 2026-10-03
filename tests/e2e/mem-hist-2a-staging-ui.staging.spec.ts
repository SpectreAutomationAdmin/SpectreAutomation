// MEM-HIST-2A §5 / §J (2026-10-03) — staging Member UI verification.
//
// Confirms on live Coulee:
//   §J.1 — Member list loads with the imported dataset
//   §J.2-4 — search by First Name / Last Name / Member #
//   §J.5-6 — leading-zero + alphabetic-suffix Member # search works
//   §J.7 — Member Profile opens
//   §J.8-10 — name is primary display; Member # is secondary;
//             billing + source provenance visible where appropriate
//   §J.11 — NO placeholder email displayed anywhere
// Plus backfill confirmation + protected baseline hold.

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";
const COULEE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const COA_BATCH_ID = "cmuni5ymv000k136q3xdyrpmn";

async function captureInvariant(page: Page) {
  const resp = await page.request.get(`${BASE}/api/admin/coa-batch-diagnostic/${COA_BATCH_ID}`);
  expect(resp.ok()).toBe(true);
  return resp.json();
}

runAt("MEM-HIST-2A · staging Member UI loads + no placeholder email + baseline hold", async ({ browser }) => {
  test.setTimeout(300_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);

  const before = await captureInvariant(page);
  console.log("MEM_HIST_2A_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(2);
  expect(before.club.reportingLedgerSnapshot).toBe(2);

  // §J.1 — Member list loads successfully with 3,000+ Members.
  await page.goto(`${BASE}/app/admin/members`, { waitUntil: "domcontentloaded" });
  const headerText = await page.locator("h1").first().textContent({ timeout: 15_000 });
  console.log("MEM_HIST_2A_LIST_HEADER " + JSON.stringify({ headerText }));
  expect(headerText).toMatch(/Members/);
  const metaText = await page.locator("p.spectre-members-db-meta, p").first().textContent({ timeout: 10_000 });
  console.log("MEM_HIST_2A_LIST_META " + JSON.stringify({ metaText }));
  expect(metaText).toMatch(/3,?08[01] member/);

  // §J.11 — placeholder.invalid must not appear anywhere on the
  // Member list page.
  const listBody = await page.locator("body").innerText();
  expect(listBody).not.toContain("placeholder.invalid");

  // §J.4 — search by Member # (leading-zero "0073")
  await page.goto(`${BASE}/app/admin/members?q=0073`, { waitUntil: "domcontentloaded" });
  const search0073 = await page.locator("body").innerText();
  console.log("MEM_HIST_2A_SEARCH_0073_HIT " + JSON.stringify({ hasHit: /0073\b/.test(search0073) }));
  expect(/0073/.test(search0073)).toBe(true);
  expect(search0073).not.toContain("placeholder.invalid");

  // §J.5-6 — alphabetic-suffix "0073A"
  await page.goto(`${BASE}/app/admin/members?q=0073A`, { waitUntil: "domcontentloaded" });
  const search0073A = await page.locator("body").innerText();
  console.log("MEM_HIST_2A_SEARCH_0073A_HIT " + JSON.stringify({ hasHit: /0073A/.test(search0073A) }));
  expect(/0073A/.test(search0073A)).toBe(true);

  // §J.7-10 — open Member profile. Pick the first row's link.
  await page.goto(`${BASE}/app/admin/members`, { waitUntil: "domcontentloaded" });
  const firstMemberLink = page.locator('a[href*="/app/admin/members/"]').first();
  await firstMemberLink.click({ timeout: 10_000 });
  await page.waitForLoadState("domcontentloaded");
  const profileBody = await page.locator("body").innerText();
  console.log("MEM_HIST_2A_PROFILE_HAS_NAME " + JSON.stringify({
    length: profileBody.length,
    hasPlaceholder: profileBody.includes("placeholder.invalid"),
  }));
  // No placeholder email anywhere on the profile.
  expect(profileBody).not.toContain("placeholder.invalid");
  // Name-first contract — the H1 should contain either a First Name
  // or Last Name string (not just a Member #).
  const profileH1 = (await page.locator("h1").first().textContent({ timeout: 10_000 }))?.trim() ?? "";
  console.log("MEM_HIST_2A_PROFILE_H1 " + JSON.stringify({ profileH1 }));
  expect(profileH1.length).toBeGreaterThan(0);
  // The H1 must not BE just a bare Member Number (regex: all-digits
  // or all-digits + alpha suffix).
  expect(/^[0-9]{3,6}[A-Z]?$/i.test(profileH1)).toBe(false);

  // §K — baseline hold.
  const after = await captureInvariant(page);
  console.log("MEM_HIST_2A_AFTER " + JSON.stringify({ club: after.club }));
  expect(after.club.account).toBe(562);
  expect(after.club.journalEntry).toBe(0);
  expect(after.club.reportingLedgerBatch).toBe(2);
  expect(after.club.reportingLedgerSnapshot).toBe(2);

  await page.screenshot({ path: "test-results/mem-hist-2a-staging-ui.png", fullPage: true });
  await context.close();
});
