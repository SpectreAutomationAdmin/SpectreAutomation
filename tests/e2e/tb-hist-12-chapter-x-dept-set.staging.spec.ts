// TB-HIST-12 §4 (2026-10-03) — Chapter X dept-set parity gate.
//
// Fixes the TB-HIST-11 test gap where the Playwright assertion only
// checked a hardcoded subset of 6 Spectre department names (resolver
// returned 8). This spec:
//
//   1. Queries the TB-HIST-10 resolver diagnostic
//      (`/api/admin/dept-pl-reconciliation`) for Coulee's January 2026
//      period to obtain the AUTHORITATIVE dept set — every dept the
//      resolver returns (with its exact name string).
//   2. Opens the Chair's Dashboard → Chapter X ("Departmental P&L
//      Summary") on the live Coulee tenant.
//   3. Asserts EVERY resolver dept name appears somewhere in the
//      Chapter X rendering. Any missing name is a parity failure.
//
// Companion to:
//   - tests/e2e/tb-hist-11-chapter-x.staging.spec.ts  (visible subset)
//   - tests/tb-hist-11-source-contracts.test.ts        (source pins)

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

// Coulee Country Club (live tenant, Jan 2026 committed TB).
const COULEE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const COA_BATCH_ID = "cmuni5ymv000k136q3xdyrpmn";
const JAN_FROM = "2026-01-01";
const JAN_TO = "2026-01-31";

async function captureInvariant(page: Page) {
  const resp = await page.request.get(`${BASE}/api/admin/coa-batch-diagnostic/${COA_BATCH_ID}`);
  expect(resp.ok(), `coa diagnostic responded ${resp.status()}`).toBe(true);
  return resp.json();
}

runAt("TB-HIST-12 §4 · Chapter X renders EVERY resolver department for Coulee Jan 2026", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);

  const before = await captureInvariant(page);
  console.log("TB_HIST_12_BEFORE " + JSON.stringify({
    status: before.status, totalRows: before.total, club: before.club, clubId: before.clubId,
  }));

  // 1. Pull the authoritative resolver dept set.
  const reconUrl = `${BASE}/api/admin/dept-pl-reconciliation?clubId=${COULEE_CLUB_ID}&from=${JAN_FROM}&to=${JAN_TO}`;
  const reconResp = await page.request.get(reconUrl);
  expect(reconResp.ok(), `dept-pl-reconciliation responded ${reconResp.status()}`).toBe(true);
  const recon = await reconResp.json();

  const resolverDeptNames: string[] = (recon.rows ?? []).map((r: { departmentName: string }) => r.departmentName);
  console.log("TB_HIST_12_RESOLVER_DEPT_SET " + JSON.stringify({
    count: resolverDeptNames.length,
    names: resolverDeptNames,
    isBalanced: recon.reconciliation?.isBalanced,
  }));
  expect(resolverDeptNames.length).toBeGreaterThanOrEqual(2);
  // Resolver must reconcile — if it doesn't, Chapter X values are
  // untrustworthy and the parity assertion below is moot.
  expect(recon.reconciliation?.isBalanced).toBe(true);

  // 2. Open the Monthly Board Reporting Package for Jan 2026.
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01`, { waitUntil: "domcontentloaded" });
  const bodyText = await page.locator("body").innerText();

  // 3. Assert every resolver dept name is present in the rendered page.
  const missing: string[] = resolverDeptNames.filter((n) => !bodyText.includes(n));
  console.log("TB_HIST_12_CHAPTER_X_RENDERED " + JSON.stringify({
    resolverCount: resolverDeptNames.length,
    missingCount: missing.length,
    missing,
  }));
  expect(missing, `Chapter X failed to render these resolver departments: ${JSON.stringify(missing)}`).toEqual([]);

  // 4. Board package freshness pill present + reads January close.
  const freshnessPill = await page.locator('[data-testid="board-package-data-through"]').textContent({ timeout: 15_000 });
  console.log("TB_HIST_12_FRESHNESS_PILL " + JSON.stringify({ pillText: freshnessPill }));
  expect(freshnessPill).toContain("Financial data through");
  expect(freshnessPill).toContain("2026-01-31");

  // 5. No Silver Springs branding leak.
  expect(bodyText).not.toContain("Silver Springs Golf & Country Club · Visual Summary");
  expect(bodyText).not.toContain("Silver Springs Golf & Country Club · KPI Dashboard");

  // 6. Executive status integrity — the three hardcoded demo labels
  //    must NOT appear on the live Coulee package.
  //    "On Plan" / "Strong Position" / "Executing" belong to the
  //    Silver Springs demo path only.
  expect(bodyText).not.toContain("On Plan");
  expect(bodyText).not.toContain("Strong Position");
  expect(bodyText).not.toContain("Executing");

  await page.screenshot({ path: "test-results/tb-hist-12-chapter-x-dept-set.png", fullPage: true });

  const after = await captureInvariant(page);
  expect(after.club).toEqual(before.club);
  console.log("TB_HIST_12_AFTER " + JSON.stringify({ club: after.club }));
  await context.close();
});
