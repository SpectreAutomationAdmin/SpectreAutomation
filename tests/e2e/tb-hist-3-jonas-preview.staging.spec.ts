// TB-HIST-3 (2026-10-01) — staging acceptance for the Jonas XLSX
// Preview silent-fail fix.
//
// Uploads the synthetic Jonas April 2026 XLSX fixture, clicks Preview,
// and asserts:
//   * the "Preparing preview…" pending indicator becomes visible;
//   * EITHER the preview result card renders, OR the submit-error
//     card renders — NEVER a silent screen;
//   * Coulee's accounting invariants are preserved
//     (Account=562, JE=0, RLB=0, RLS=0);
//   * the preview panel is readable after the server-action returns.

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";
import * as path from "node:path";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";
const BATCH_ID = "cmuni5ymv000k136q3xdyrpmn";
const FIXTURE = path.resolve(process.cwd(), "tests/fixtures/jonas-april-2026-tb.xlsx");

async function captureCouleeInvariant(page: Page) {
  const resp = await page.request.get(`${BASE}/api/admin/coa-batch-diagnostic/${BATCH_ID}`);
  expect(resp.ok(), `diagnostic responded ${resp.status()}`).toBe(true);
  const data = await resp.json();
  return {
    status: data.status,
    totalRows: data.total,
    club: data.club,
  };
}

runAt("TB-HIST-3 · Jonas XLSX Preview — pending → result (never silent) + Coulee invariant intact", async ({ browser }) => {
  // Longer than the project default — upload + server-action +
  // round-trip to the diagnostic API on staging can take > 60s.
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);

  // --- BEFORE invariant ---
  const before = await captureCouleeInvariant(page);
  console.log("TB_HIST_3_BEFORE " + JSON.stringify(before));
  expect(before.status).toBe("COMMITTED");
  expect(before.totalRows).toBe(562);
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(0);
  expect(before.club.reportingLedgerSnapshot).toBe(0);

  // --- Navigate to Jonas import ---
  await page.goto(`${BASE}/app/admin/imports/jonas`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="jonas-import-inputs"]', { timeout: 30_000 });

  // --- Upload the synthetic XLSX fixture ---
  // onFileChosen reads the file as ArrayBuffer async then calls
  // setFields. In staging we've seen the React re-render lag long
  // enough that an immediate `expect().toContainText()` races the
  // setFields propagation — use the locator's built-in retry wait
  // for the "Loaded: …" paragraph to appear.
  await page.locator('[data-testid="field-source-file"]').setInputFiles(FIXTURE);
  await expect(page.locator('[data-testid="field-source-filename"]')).toContainText(
    "jonas-april-2026-tb.xlsx",
    { timeout: 60_000 },
  );

  // --- Explicit effective date so preview doesn't block on resolution ---
  await page.locator('[data-testid="field-effective-date"]').fill("2026-04-30");

  // --- Click Preview and verify pending state becomes visible ---
  const previewBtn = page.locator('[data-testid="btn-preview"]');
  await expect(previewBtn).toBeEnabled();
  await previewBtn.click();

  // The pending indicator should appear (either the progress bar or the
  // label swap — both are driven by stage === "preview-pending").
  await Promise.race([
    page.locator('[data-testid="jonas-preview-progress"]').waitFor({ state: "visible", timeout: 10_000 }),
    page.locator('button[data-testid="btn-preview"]:has-text("Preparing preview")').waitFor({ state: "visible", timeout: 10_000 }),
  ]);

  // --- Wait for result — ANY of the three legitimate outcomes.
  //     The invariant we're proving is "never silent" — the pending
  //     state must resolve to one of these visible states.
  //       (a) `jonas-preview` — preview parsed + rendered.
  //       (b) `jonas-validation-failed` — structural validation
  //           failed (TB-HIST-3 added this branch).
  //       (c) `jonas-submit-error` — server-action thrown or
  //           `{ error }` wrapper.
  const previewCard = page.locator('[data-testid="jonas-preview"]');
  const validationCard = page.locator('[data-testid="jonas-validation-failed"]');
  const errorCard = page.locator('[data-testid="jonas-submit-error"]');
  await Promise.race([
    previewCard.waitFor({ state: "visible", timeout: 60_000 }),
    validationCard.waitFor({ state: "visible", timeout: 60_000 }),
    errorCard.waitFor({ state: "visible", timeout: 60_000 }),
  ]);
  const previewVisible = await previewCard.isVisible();
  const validationVisible = await validationCard.isVisible();
  const errorVisible = await errorCard.isVisible();
  expect(previewVisible || validationVisible || errorVisible, "preview, validation-failed, or error card must become visible").toBe(true);
  console.log("TB_HIST_3_PREVIEW_OUTCOME " + JSON.stringify({ previewVisible, validationVisible, errorVisible }));
  // Pending indicator must have cleared by now.
  await expect(page.locator('[data-testid="jonas-preview-progress"]')).toHaveCount(0);

  // --- Filename + effective date must survive the cycle ---
  await expect(page.locator('[data-testid="field-source-filename"]')).toContainText("jonas-april-2026-tb.xlsx");
  await expect(page.locator('[data-testid="field-effective-date"]')).toHaveValue("2026-04-30");

  // --- Screenshot for the acceptance package ---
  await page.screenshot({ path: "test-results/tb-hist-3-jonas-preview-outcome.png", fullPage: false });

  // --- AFTER invariant — preview must not have mutated any accounting data ---
  const after = await captureCouleeInvariant(page);
  console.log("TB_HIST_3_AFTER " + JSON.stringify(after));
  expect(after).toEqual(before);

  await context.close();
});
