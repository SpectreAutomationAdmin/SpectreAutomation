// TB-HIST-9 (2026-10-02) — staging acceptance.
//
// Covers:
//   1. Hit the new staging-only MonthlyPackage diagnostic endpoint
//      against Coulee + reportingYear=2026 reportingMonth=5. Answer
//      the forensic question: does a published May 2026 package
//      row exist for Coulee? If YES → the admin-page immutability
//      fix will serve it; if NO → restoration is impossible from
//      preserved data (directive §2 "DO NOT recreate May from
//      memory").
//   2. Open /app/admin/reporting/monthly?period=2026-05 and verify:
//      - If a frozen payload exists, it is used verbatim (no live
//        "Data not available" sweep).
//      - If no frozen payload exists, the live-render result is
//        unchanged from TB-HIST-8 (the current founder observation).
//   3. Balance Sheet as of 2026-10-02 continues to carry-forward
//      Jan 31 (TB-HIST-8 regression) AND surfaces the new
//      "Financial data through 2026-01-31" pill.
//   4. Coulee accounting invariants unchanged BEFORE/AFTER.

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";
const COA_BATCH_ID = "cmuni5ymv000k136q3xdyrpmn";

async function captureInvariant(page: Page) {
  const resp = await page.request.get(`${BASE}/api/admin/coa-batch-diagnostic/${COA_BATCH_ID}`);
  expect(resp.ok(), `diagnostic responded ${resp.status()}`).toBe(true);
  return resp.json();
}

runAt("TB-HIST-9 · May 2026 forensic — does Coulee have a published MonthlyPackage row?", async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);

  const before = await captureInvariant(page);
  console.log("TB_HIST_9_BEFORE " + JSON.stringify({
    status: before.status, totalRows: before.total, club: before.club, clubId: before.clubId,
  }));
  const clubId = (before as { clubId: string }).clubId;

  // 1. Query the diagnostic for every MonthlyPackage row on Coulee —
  //    this is the authoritative answer to "was May 2026 ever
  //    published for Coulee?".
  const listResp = await page.request.get(`${BASE}/api/admin/monthly-package-diagnostic?clubId=${clubId}`);
  expect(listResp.ok(), `monthly-package-diagnostic LIST responded ${listResp.status()}`).toBe(true);
  const listBody = await listResp.json();
  console.log("TB_HIST_9_MONTHLY_PACKAGE_LIST " + JSON.stringify({
    count: listBody.count,
    rows: (listBody.rows ?? []).map((r: { reportingYear: number; reportingMonth: number; status: string; publishedAt: string | null; packagePayloadJson_bytes: number }) => ({
      period: `${r.reportingYear}-${String(r.reportingMonth).padStart(2, "0")}`,
      status: r.status,
      publishedAt: r.publishedAt,
      payloadBytes: r.packagePayloadJson_bytes,
    })),
  }));

  // 2. Explicit May 2026 lookup — surface the authoritative row
  //    detail so the acceptance report can prove whether May was
  //    ever published for Coulee.
  const mayResp = await page.request.get(`${BASE}/api/admin/monthly-package-diagnostic?clubId=${clubId}&reportingYear=2026&reportingMonth=5`);
  expect(mayResp.ok(), `May 2026 diagnostic responded ${mayResp.status()}`).toBe(true);
  const mayBody = await mayResp.json();
  console.log("TB_HIST_9_MAY_2026 " + JSON.stringify(mayBody));

  // 3. If a published May 2026 row exists with a non-null payload,
  //    the admin surface MUST now render the frozen payload (not a
  //    live-rebuild). We don't fail the test either way — the
  //    forensic signal is the output of the diagnostic calls above.
  //    But we do capture a screenshot of the admin page as it
  //    stands post-TB-HIST-9.
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-05`, { waitUntil: "domcontentloaded" });
  await page.screenshot({ path: "test-results/tb-hist-9-may-2026-admin.png", fullPage: true });

  const after = await captureInvariant(page);
  // Dec + Jan snapshots must be unchanged.
  expect(after.club.account).toBe(before.club.account);
  expect(after.club.journalEntry).toBe(before.club.journalEntry);
  expect(after.club.reportingLedgerBatch).toBe(before.club.reportingLedgerBatch);
  expect(after.club.reportingLedgerSnapshot).toBe(before.club.reportingLedgerSnapshot);

  await context.close();
});

runAt("TB-HIST-9 · BS as of 2026-10-02 shows 'Financial data through 2026-01-31' pill", async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);

  const before = await captureInvariant(page);

  await page.goto(`${BASE}/app/admin/reports/balance-sheet?asOf=2026-10-02`, { waitUntil: "domcontentloaded" });
  // The new freshness pill lives at data-testid="bs-report-data-through".
  const pillText = await page.locator('[data-testid="bs-report-data-through"]').textContent({ timeout: 15_000 });
  console.log("TB_HIST_9_BS_FRESHNESS " + JSON.stringify({ pillText }));
  expect(pillText).toContain("Financial data through");
  // January 31, 2026 is the latest committed close on Coulee.
  expect(pillText).toContain("2026-01-31");

  // Carry-forward still works (TB-HIST-8 regression check): page
  // must display non-$0 asset figures.
  const bodyText = await page.locator("body").innerText();
  expect(/[\$][1-9][\d,]*(?:\.\d{2})?/.test(bodyText)).toBe(true);

  await page.screenshot({ path: "test-results/tb-hist-9-bs-freshness-pill.png", fullPage: true });

  const after = await captureInvariant(page);
  expect(after.club).toEqual(before.club);
  await context.close();
});
