// MEM-HIST-2 — quick status check for in-flight / completed import.
import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";
const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";
const COULEE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";

runAt("MEM-HIST-2 state check", async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext();
  const page = await loginAsFounder(context);
  const r = await page.request.get(`${BASE}/api/admin/member-master-import?clubId=${COULEE_CLUB_ID}`);
  console.log("STATE " + JSON.stringify(await r.json()));
  expect(r.ok()).toBe(true);
  await context.close();
});
