// AR-HIST-1 §12 — discover the GL AR control account on live Coulee.
// Reads the committed Jan 31 2026 BS snapshot via the existing BS
// resolver and looks for the ACCOUNTS RECEIVABLE line. Logs every
// candidate account (number + name + classification + natural balance)
// so we can prove the correct one deterministically.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";
const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

runAt("AR-HIST-1 §12 · GL AR control account discovery", async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext();
  const page = await loginAsFounder(context);
  const res = await page.request.get(`${BASE}/app/admin/reports/balance-sheet?asOf=2026-01-31`);
  expect(res.ok(), `BS page responded ${res.status()}`).toBe(true);
  const html = await res.text();
  // Dump everything that looks like a line containing "receivable" or
  // "AR" near a dollar amount.
  const lines = html.split(/<\/?(?:tr|td|th|div|span|p)[^>]*>/i).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
  const arCandidates = lines.filter((l) => /receivable/i.test(l) || /\bAR\b/.test(l) || /BS_AR\b|BS_MEMBER_AR\b/.test(l)).slice(0, 50);
  console.log("AR_CANDIDATES " + JSON.stringify(arCandidates, null, 2));
  await context.close();
});
