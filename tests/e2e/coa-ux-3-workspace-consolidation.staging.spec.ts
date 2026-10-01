// COA-UX-3 (2026-09-30) — authenticated staging acceptance.
//
// Covers:
//   §16 — the founder's committed Coulee batch stays usable as a
//         record; no mutation of the 562 Accounts.
//   §17 — the (zero) hard-error / (six) warning navigation lands
//         inside the Inspector workspace, not any Advanced grid.
//   §18 — the DOM contains neither "Advanced grid" nor "Advanced
//         validation details" sections (not merely CSS-hidden).
//   §19 — Coulee data invariants: Account=562, JournalEntry=0,
//         ReportingLedgerBatch=0, ReportingLedgerSnapshot=0.

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;

const BATCH_ID = "cmuni5ymv000k136q3xdyrpmn";
const BASE = "https://staging.spectreautomation.com";

async function gotoBatch(page: Page) {
  await page.goto(`/app/admin/imports/${BATCH_ID}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Batch", { timeout: 30_000 });
}

runAt("COA-UX-3 · §19 — Coulee committed-state invariants (read-only via diagnostic API)", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);
  const resp = await context.request.get(`${BASE}/api/admin/coa-batch-diagnostic/${BATCH_ID}`);
  expect(resp.ok(), `diagnostic responded ${resp.status()}`).toBe(true);
  const data = await resp.json();
  console.log("COULEE_INVARIANT " + JSON.stringify({
    status: data.status,
    totalRows: data.total,
    reviewed: data.reviewed,
    notReviewed: data.notReviewed,
    violations: data.violations,
    club: data.club,
  }));

  // §19 — Coulee's Chart-of-Accounts is now imported. Account must
  // be exactly the 562 rows the batch imported, and nothing else
  // should have been materialised.
  expect(data.status).toBe("COMMITTED");
  expect(data.total).toBe(562);
  expect(data.club.account).toBe(562);
  expect(data.club.journalEntry).toBe(0);
  expect(data.club.reportingLedgerBatch).toBe(0);
  expect(data.club.reportingLedgerSnapshot).toBe(0);

  await context.close();
});

runAt("COA-UX-3 · §18 — Advanced grid + Advanced validation details are absent from the rendered DOM", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);
  await gotoBatch(page);

  // Not merely hidden with CSS — truly not rendered.
  await expect(page.getByText(/Advanced grid · full per-row mapping table/i)).toHaveCount(0);
  await expect(page.getByText(/Advanced validation details/i)).toHaveCount(0);
  await expect(page.locator('[data-testid="advanced-validation-details"]')).toHaveCount(0);

  // The Inspector workspace is still the primary surface.
  await expect(page.getByTestId("coa-inspector")).toBeVisible();

  await page.screenshot({ path: "test-results/coa-ux-3-committed-no-advanced.png", fullPage: false });

  await context.close();
});

runAt("COA-UX-3 · §17 — clicking a warning navigates to the Inspector (not a mapping grid)", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);
  await gotoBatch(page);

  // Expand the warnings panel. The committed Coulee batch has 0 errors
  // + 6 warnings per the founder's screenshot, so the "See warning
  // details" / "Next warning" labels should render (§14).
  const errorsCard = page.getByTestId("coa-errors-summary-card");
  await expect(errorsCard).toBeVisible();

  // §14 label fidelity — "Next warning →" instead of "Next error →".
  const nextBtn = page.getByTestId("coa-errors-next-error");
  await expect(nextBtn).toContainText(/Next warning/i, { timeout: 10_000 });

  // Expand the details and click the first warning row — it should
  // dispatch spectre:coa-jump-to-row, picked up by BulkCoaReviewControls.
  await page.getByTestId("coa-errors-toggle").click();
  const firstWarningRow = page.locator('[data-testid^="coa-errors-detail-row-"]').first();
  await expect(firstWarningRow).toBeVisible();

  // Capture the rowNumber the row carries so we can confirm it lands
  // on the matching Inspector row.
  const dataTestId = (await firstWarningRow.getAttribute("data-testid")) ?? "";
  const match = dataTestId.match(/coa-errors-detail-row-(\d+)/);
  const expectedRowNumber = match ? Number(match[1]) : null;

  await firstWarningRow.click();

  // After the jump, the Inspector should be visible AND the account
  // list row with the matching data-row-number should be visible.
  await expect(page.getByTestId("coa-inspector")).toBeVisible();
  if (expectedRowNumber !== null) {
    const highlighted = page.locator(`tr[data-row-number="${expectedRowNumber}"]`).first();
    await expect(highlighted).toBeVisible({ timeout: 10_000 });
  }

  // Also prove the jump used Next-warning rather than scrolling to
  // some Advanced grid section.
  await expect(page.getByText(/Advanced grid/i)).toHaveCount(0);

  await page.screenshot({ path: "test-results/coa-ux-3-warning-jump-to-inspector.png", fullPage: false });

  await context.close();
});

runAt("COA-UX-3 · §13 — committed-batch page keeps 'Import completed' affordance (regression)", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);
  await gotoBatch(page);
  await expect(page.getByTestId("coa-action-completed")).toBeVisible();
  await expect(page.getByTestId("coa-action-completed")).toBeDisabled();
  await context.close();
});
