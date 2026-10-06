// GOLF-HIST-1A (2026-10-06) — authenticated real-upload acceptance.
//
// The GOLF-HIST-1 E2E only proved the importer page LOADED. It did
// NOT upload a real PDF — which is why the parser regression stayed
// hidden until the founder manually tried the real file. This E2E
// exercises the full browser flow:
//
//   1. Open the Golf Activity importer.
//   2. Set the file input to the real January 2026 PDF.
//   3. Click Preview and wait for the parse to complete.
//   4. Verify the reconciliation panel shows RECONCILED + the known
//      January totals (Guests 4, Members 397, Total 401, Juniors 2,
//      Women 94, all deltas 0).
//   5. Open the preview page via the returned link.
//   6. Verify the Commit button is ENABLED (reconciled + no conflicts).
//   7. DO NOT CLICK COMMIT.
//   8. Delete the PREVIEW batch so the E2E leaves no residue.
//
// Protected baseline verified before + after.

import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";
const COA_BATCH_ID = "cmuni5ymv000k136q3xdyrpmn";
const COULEE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const FIXTURE_PDF = path.resolve(
  __dirname,
  "../fixtures/golf-hist-1/january-2026.pdf",
);

async function invariant(page: Page) {
  const r = await page.request.get(`${BASE}/api/admin/coa-batch-diagnostic/${COA_BATCH_ID}`);
  expect(r.ok()).toBe(true);
  return r.json();
}

async function countGolfActivityDays(page: Page): Promise<number> {
  // The GET endpoint returns the batches; we read committed days via
  // the Monthly Reporting Package's Section XI live-vs-UNAVAILABLE
  // state. A simpler probe: ask the admin API for the batch list and
  // count rows that have status COMMITTED. If no API exists, we fall
  // back to inspecting the admin page.
  const r = await page.request.get(`${BASE}/api/admin/golf-activity-import?clubId=${COULEE_CLUB_ID}`);
  if (!r.ok()) return -1;
  const body = await r.json();
  const batches = (body.batches as Array<{ status: string }>) ?? [];
  return batches.filter((b) => b.status === "COMMITTED").length;
}

runAt("GOLF-HIST-1A · Real January PDF upload reaches RECONCILED (no commit)", async ({ browser }) => {
  test.setTimeout(300_000);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(ctx);

  const before = await invariant(page);
  console.log("GOLF_HIST_1A_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(2);
  expect(before.club.reportingLedgerSnapshot).toBe(2);
  const committedBefore = await countGolfActivityDays(page);
  console.log("GOLF_HIST_1A_COMMITTED_BEFORE " + committedBefore);
  expect(committedBefore).toBe(0);

  // -- Navigate to the importer. --------------------------------------
  await page.goto(`${BASE}/app/admin/imports/golf-activity`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="golf-activity-import-header"]').waitFor({ state: "visible", timeout: 20_000 });

  // -- Upload the real January PDF. ----------------------------------
  const fileInput = page.locator('[data-testid="golf-activity-import-file"]');
  await fileInput.setInputFiles(FIXTURE_PDF);
  await page.locator('[data-testid="golf-activity-import-submit"]').click();

  // Wait for the result block to appear.
  await page.locator('[data-testid="golf-activity-import-result"]').waitFor({ state: "visible", timeout: 60_000 });

  // -- Verify reconciliation shows the known January totals. ---------
  const resultText = await page.locator('[data-testid="golf-activity-import-result"]').innerText();
  console.log("GOLF_HIST_1A_PREVIEW_RESULT " + JSON.stringify(resultText.slice(0, 800)));
  expect(resultText).toMatch(/2026-01-01/);
  expect(resultText).toMatch(/2026-01-31/);
  expect(resultText).toMatch(/31 daily rows/);
  expect(resultText).toMatch(/23 active/);
  expect(resultText).toMatch(/8 zero/);
  expect(resultText).toMatch(/reconciliation:\s*RECONCILED/i);
  // Zero deltas on every reconciled line.
  const totalsTable = await page.locator('[data-testid="golf-activity-import-totals"]').innerText();
  console.log("GOLF_HIST_1A_PREVIEW_TOTALS " + JSON.stringify(totalsTable));
  expect(totalsTable).toMatch(/Guests\s+4\s+4\s+0/);
  expect(totalsTable).toMatch(/Green Fees\s+0\s+0\s+0/);
  expect(totalsTable).toMatch(/Members\s+397\s+397\s+0/);
  expect(totalsTable).toMatch(/Total\s+401\s+401\s+0/);
  expect(totalsTable).toMatch(/Juniors\s+2\s+2\s+0/);
  expect(totalsTable).toMatch(/Women\s+94\s+94\s+0/);

  // -- Open the batch preview page via the returned link. -----------
  const link = await page.locator('[data-testid="golf-activity-import-preview-link"]');
  const href = await link.getAttribute("href");
  expect(href).toMatch(/\/app\/admin\/imports\/golf-activity\//);
  await link.click();
  await page.locator('[data-testid="golf-batch-header"]').waitFor({ state: "visible", timeout: 20_000 });
  const summaryText = await page.locator('[data-testid="golf-batch-summary"]').innerText();
  console.log("GOLF_HIST_1A_BATCH_SUMMARY " + JSON.stringify(summaryText.slice(0, 500)));
  expect(summaryText).toMatch(/RECONCILED/);
  expect(summaryText).toMatch(/Conflicts:\s*0/);

  // -- Verify Commit button is ENABLED but DO NOT CLICK. -------------
  const commitBtn = page.locator('[data-testid="golf-batch-commit-button"]');
  await expect(commitBtn).toBeVisible();
  await expect(commitBtn).toBeEnabled();

  // -- E2E CLEANUP: delete the PREVIEW batch so staging stays clean.
  // The batch id is encoded in the preview link's URL path.
  const batchId = href!.split("/").pop();
  expect(batchId).toBeTruthy();
  const del = await page.request.delete(`${BASE}/api/admin/golf-activity-import?clubId=${COULEE_CLUB_ID}&batchId=${batchId}`);
  console.log("GOLF_HIST_1A_CLEANUP " + del.status());
  expect([200, 204, 404]).toContain(del.status());

  // -- Baseline unchanged, no committed days created. ----------------
  const after = await invariant(page);
  expect(after.club).toEqual(before.club);
  const committedAfter = await countGolfActivityDays(page);
  console.log("GOLF_HIST_1A_COMMITTED_AFTER " + committedAfter);
  expect(committedAfter).toBe(0);

  await page.screenshot({ path: "test-results/golf-hist-1a-batch-preview.png", fullPage: true });
  await ctx.close();
});

runAt("GOLF-HIST-1A · PARSE_FAILED on a non-PDF upload (fail-closed)", async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(ctx);

  await page.goto(`${BASE}/app/admin/imports/golf-activity`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="golf-activity-import-header"]').waitFor({ state: "visible", timeout: 20_000 });

  const notPdfPath = path.resolve(__dirname, "../fixtures/golf-hist-1/not-a-pdf.txt");
  // Create the fixture on the fly — small text file, not committed.
  const fs = await import("node:fs");
  fs.writeFileSync(notPdfPath, "This is not a PDF, intentionally.");
  try {
    await page.locator('[data-testid="golf-activity-import-file"]').setInputFiles(notPdfPath);
    await page.locator('[data-testid="golf-activity-import-submit"]').click();
    await page.locator('[data-testid="golf-activity-import-error"]').waitFor({ state: "visible", timeout: 30_000 });
    const errText = await page.locator('[data-testid="golf-activity-import-error"]').innerText();
    console.log("GOLF_HIST_1A_PARSE_FAILED_BANNER " + JSON.stringify(errText));
    expect(errText).toMatch(/PARSE FAILED/);
    expect(errText).toMatch(/NO DAILY ACTIVITY ROWS DETECTED/i);
    // The result block must NOT appear.
    await expect(page.locator('[data-testid="golf-activity-import-result"]')).toBeHidden();
  } finally {
    fs.unlinkSync(notPdfPath);
  }

  await ctx.close();
});
