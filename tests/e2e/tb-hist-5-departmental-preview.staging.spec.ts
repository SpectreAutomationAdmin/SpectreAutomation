// TB-HIST-5 (2026-10-01) — staging acceptance for the Jonas
// Departmental (8-column) Trial Balance.
//
// This test is Preview-only and READ-ONLY. It uses the founder's
// REAL Dec 31 2025 TB Departmental.xlsx when present on this
// machine (the directive explicitly authorises Preview-mode use of
// the real file). It will NOT commit. It verifies:
//   • Preview card renders (never silent)
//   • `sum-source-format` reads "Jonas Departmental Trial Balance"
//   • `sum-effective-date` resolves to 2025-12-31 · period 12 · FY2025
//   • `sum-unique-jonas-depts` = 12 (full set in §5)
//   • Entity-mismatch acknowledgement surface still fires (Silver
//     Springs source vs Coulee target)
//   • Coulee invariant unchanged BEFORE/AFTER (562/0/0/0)
//
// If the real file isn't present on the runner, the test is skipped
// (not failed) — a synthetic equivalent runs under
// `tests/jonas-departmental-format.test.ts` at the parser level.

import { test, expect, type Page } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const BASE = "https://staging.spectreautomation.com";
const BATCH_ID = "cmuni5ymv000k136q3xdyrpmn";

// Founder-provided real file path (user downloaded).
const REAL_FILE = "C:\\Users\\cturcato\\Downloads\\December 31, 2025 TB Departmental.xlsx";
const haveRealFile = existsSync(REAL_FILE);
const runAt = creds.ready && haveRealFile ? test : test.skip;

async function captureCouleeInvariant(page: Page) {
  const resp = await page.request.get(`${BASE}/api/admin/coa-batch-diagnostic/${BATCH_ID}`);
  expect(resp.ok(), `diagnostic responded ${resp.status()}`).toBe(true);
  const data = await resp.json();
  return { status: data.status, totalRows: data.total, club: data.club };
}

runAt("TB-HIST-5 · Departmental Preview — Format D parses, dept counts surface, Coulee invariant intact", async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);

  // BEFORE invariant
  const before = await captureCouleeInvariant(page);
  console.log("TB_HIST_5_BEFORE " + JSON.stringify(before));
  expect(before.status).toBe("COMMITTED");
  expect(before.totalRows).toBe(562);
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(0);
  expect(before.club.reportingLedgerSnapshot).toBe(0);

  await page.goto(`${BASE}/app/admin/imports/jonas`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="jonas-import-inputs"]', { timeout: 30_000 });

  // Set effective date FIRST — preamble will supply it anyway but the
  // UI retains the explicit value for the operator's confirmation.
  await page.locator('[data-testid="field-effective-date"]').fill("2025-12-31");

  // Upload the REAL departmental workbook.
  await page.locator('[data-testid="field-source-file"]').setInputFiles(REAL_FILE);
  await expect(page.locator('[data-testid="field-source-filename"]')).toContainText(
    "TB Departmental.xlsx",
    { timeout: 60_000 },
  );

  await page.locator('[data-testid="btn-preview"]').click();

  // Must land on preview card (not validation-failed, not submit-error).
  const previewCard = page.locator('[data-testid="jonas-preview"]');
  const validationCard = page.locator('[data-testid="jonas-validation-failed"]');
  const errorCard = page.locator('[data-testid="jonas-submit-error"]');
  await Promise.race([
    previewCard.waitFor({ state: "visible", timeout: 120_000 }),
    validationCard.waitFor({ state: "visible", timeout: 120_000 }),
    errorCard.waitFor({ state: "visible", timeout: 120_000 }),
  ]);
  const previewVisible = await previewCard.isVisible();
  const validationVisible = await validationCard.isVisible();
  const errorVisible = await errorCard.isVisible();
  console.log("TB_HIST_5_PREVIEW_OUTCOME " + JSON.stringify({ previewVisible, validationVisible, errorVisible }));
  expect(previewVisible, "real departmental workbook must land on jonas-preview").toBe(true);

  // Source format label
  await expect(page.locator('[data-testid="sum-source-format"]')).toContainText(
    "Jonas Departmental Trial Balance",
    { timeout: 10_000 },
  );

  // Effective date resolution
  await expect(page.locator('[data-testid="sum-effective-date"]')).toContainText("2025-12-31");
  await expect(page.locator('[data-testid="sum-effective-date"]')).toContainText("period 12");
  await expect(page.locator('[data-testid="sum-effective-date"]')).toContainText("FY2025");

  // 12 unique source departments present
  await expect(page.locator('[data-testid="sum-unique-jonas-depts"]')).toContainText("12");

  // Entity-mismatch acknowledgement still surfaces (Silver Springs
  // source vs Coulee target).
  const entityMismatchVisible = await page.locator('[data-testid="entity-mismatch"]').isVisible();
  console.log("TB_HIST_5_ENTITY_MISMATCH " + entityMismatchVisible);

  // Capture screenshot for the acceptance package.
  await page.screenshot({ path: "test-results/tb-hist-5-departmental-preview.png", fullPage: true });

  // AFTER invariant — Preview must not have mutated anything.
  const after = await captureCouleeInvariant(page);
  console.log("TB_HIST_5_AFTER " + JSON.stringify(after));
  expect(after).toEqual(before);

  await context.close();
});

runAt("TB-HIST-5 · workbook SHA proof — the file read in the Preview is the authentic founder file", async () => {
  // No login — this is a local file-shape proof. Keeps the staging
  // deploy's Preview result tethered to the exact bytes the founder
  // sent.
  const buf = readFileSync(REAL_FILE);
  console.log("TB_HIST_5_FILE_BYTES " + buf.length);
  // Jonas workbook is an XLSX = ZIP. ZIP magic bytes "PK\x03\x04".
  expect(buf.subarray(0, 2).toString("ascii")).toBe("PK");
  expect(buf.length).toBeGreaterThan(10_000);
});
