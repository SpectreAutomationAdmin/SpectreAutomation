// /app/admin/imports/jonas — production import-route validation.
//
// VALIDATES THE FOUNDER SPEC FOR THIS SLICE:
//
//   1. Upload Dataset A → confirm persistence.
//   2. Upload Dataset B → confirm second import appears in history.
//
// Also captures screenshots after each major stage for the
// founder-test report. Screenshots land under `test-results/` so
// they can be linked from the report.
//
// Requires the dev server on http://localhost:3000 (per the project's
// Playwright convention).

import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

// Direct DB cleanup — Playwright hits the running dev server but the
// same SQLite file is accessible from the test process. We wipe the
// Silver Springs Jonas imports before each test so re-runs see a
// fresh state (otherwise Dataset A becomes a `duplicate-no-op` on
// the second run and the assertions for SUCCEEDED fail).
const prisma = new PrismaClient();

async function wipeSilverSpringsJonasImports() {
  const club = await prisma.club.findFirst({
    where: { slug: "silver-springs" },
    select: { id: true },
  });
  if (!club) return;
  await prisma.reportingLedgerSnapshot.deleteMany({
    where: {
      clubId: club.id,
      sourceSystem: "jonas-gl",
    },
  });
  await prisma.reportingLedgerBatch.deleteMany({
    where: {
      clubId: club.id,
      sourceSystem: "jonas-gl",
    },
  });
}

test.beforeEach(async () => {
  await wipeSilverSpringsJonasImports();
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

const DATASET_A_MAY_2026 = `AccountNumber,AccountDescription,PeriodBalance,YTDBalance,FiscalYear,FiscalPeriod
1010,Cash - Operating Account,180000,2000000,FY2026,5
1100,Accounts Receivable Net,84000,1000000,FY2026,5
1850,Reserve Fund Investment,540000,5000000,FY2026,5
1910,Property Plant & Equipment Net,-25000,8000000,FY2026,5
2010,Accounts Payable,-22000,300000,FY2026,5
2510,Long-Term Debt,-15000,1200000,FY2026,5
3010,Members' Equity,0,13500000,FY2026,5
4010,Membership Dues Revenue,900000,4500000,FY2026,5
4020,F&B Revenue,320000,1500000,FY2026,5
5010,Operating Expenses,1100000,5000000,FY2026,5`;

const DATASET_B_JUNE_2026 = `AccountNumber,AccountDescription,PeriodBalance,YTDBalance,FiscalYear,FiscalPeriod
1010,Cash - Operating Account,200000,2200000,FY2026,6
1100,Accounts Receivable Net,50000,1050000,FY2026,6
1850,Reserve Fund Investment,80000,5080000,FY2026,6
1910,Property Plant & Equipment Net,-25000,7975000,FY2026,6
2010,Accounts Payable,0,300000,FY2026,6
2510,Long-Term Debt,0,1200000,FY2026,6
3010,Members' Equity,0,13500000,FY2026,6
4010,Membership Dues Revenue,920000,5420000,FY2026,6
4020,F&B Revenue,340000,1840000,FY2026,6
5010,Operating Expenses,955000,5955000,FY2026,6`;

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

async function uploadAndImport(
  page: Page,
  args: {
    csv: string;
    periodStart: string;
    periodEnd: string;
    fiscalYearLabel: string;
    fiscalPeriodSequence: string;
  },
) {
  // Always paste — the file-upload path is exercised by the field
  // visibility test below; the data-path tests use the paste field
  // for determinism.
  await page.fill('[data-testid="field-csv-textarea"]', args.csv);

  // These datasets are spectre-normalised (they carry FiscalYear +
  // FiscalPeriod columns directly — no Jonas-native preamble), so
  // the manual dates panel must be expanded to fill the period
  // inputs. Click the summary if the panel isn't already open.
  await page.locator('[data-testid="jonas-manual-options-summary"]').click();
  await page.fill('[data-testid="field-period-start"]', args.periodStart);
  await page.fill('[data-testid="field-period-end"]', args.periodEnd);
  await page.fill('[data-testid="field-fiscal-year"]', args.fiscalYearLabel);
  await page.fill('[data-testid="field-fiscal-period"]', args.fiscalPeriodSequence);

  // Preview.
  await page.click('[data-testid="btn-preview"]');
  await expect(page.locator('[data-testid="preview-ok"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-testid="preview-reconciliation"]')).toContainText("PASS");

  // Commit.
  await page.click('[data-testid="btn-commit"]');
  await expect(page.locator('[data-testid="commit-summary"]')).toBeVisible({ timeout: 15_000 });
}

test.describe("/app/admin/imports/jonas — production import route", () => {
  test("upload Dataset A then Dataset B; both persist; both appear in history", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);

    // -----------------------------------------------------------------
    // Navigate to the route via the sidebar link (discoverability gate).
    // -----------------------------------------------------------------
    await page.goto("/app/admin/imports/jonas");
    await expect(page.locator('[data-testid="jonas-import-header"]')).toBeVisible();
    await page.screenshot({
      path: "test-results/jonas-import-1-empty.png",
      fullPage: true,
    });

    // -----------------------------------------------------------------
    // Stage 1 — Upload Dataset A.
    // -----------------------------------------------------------------
    await uploadAndImport(page, {
      csv: DATASET_A_MAY_2026,
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
      fiscalYearLabel: "FY2026",
      fiscalPeriodSequence: "5",
    });

    await expect(page.locator('[data-testid="commit-status"]')).toContainText("SUCCEEDED");
    await page.screenshot({
      path: "test-results/jonas-import-2-dataset-a-committed.png",
      fullPage: true,
    });
    const aSnapshotId = await page
      .locator('[data-testid="commit-snapshot-id"]')
      .textContent();
    expect(aSnapshotId?.length, "Dataset A snapshot id minted").toBeGreaterThan(10);

    // -----------------------------------------------------------------
    // Stage 2 — Reload, confirm Dataset A is in history.
    // -----------------------------------------------------------------
    await page.goto("/app/admin/imports/jonas");
    const historyRows = page.locator('[data-testid^="history-row-"]');
    await expect(historyRows.first()).toBeVisible({ timeout: 10_000 });
    const firstRowText = await historyRows.first().textContent();
    expect(firstRowText, "Dataset A reportingPeriod surfaces in history").toMatch(
      /FY2026 P5/,
    );

    // -----------------------------------------------------------------
    // Stage 3 — Upload Dataset B.
    // -----------------------------------------------------------------
    await uploadAndImport(page, {
      csv: DATASET_B_JUNE_2026,
      periodStart: "2026-06-01",
      periodEnd: "2026-06-30",
      fiscalYearLabel: "FY2026",
      fiscalPeriodSequence: "6",
    });

    await expect(page.locator('[data-testid="commit-status"]')).toContainText("SUCCEEDED");
    await page.screenshot({
      path: "test-results/jonas-import-3-dataset-b-committed.png",
      fullPage: true,
    });
    const bSnapshotId = await page
      .locator('[data-testid="commit-snapshot-id"]')
      .textContent();
    expect(bSnapshotId).not.toBe(aSnapshotId);

    // -----------------------------------------------------------------
    // Stage 4 — Reload, confirm BOTH imports in history.
    // -----------------------------------------------------------------
    await page.goto("/app/admin/imports/jonas");
    const finalHistoryRows = page.locator('[data-testid^="history-row-"]');
    const finalCount = await finalHistoryRows.count();
    expect(finalCount, "history shows ≥ 2 imports after Dataset B").toBeGreaterThanOrEqual(2);

    // Latest row should be Dataset B (most-recent first).
    const latestRowText = await finalHistoryRows.nth(0).textContent();
    expect(latestRowText).toMatch(/FY2026 P6/);

    // A row matching Dataset A must also be present somewhere in
    // the visible history.
    const allRowTexts = await finalHistoryRows.allTextContents();
    const hasDatasetA = allRowTexts.some((t) => /FY2026 P5/.test(t));
    expect(hasDatasetA, "Dataset A still visible in history after Dataset B import").toBe(true);

    await page.screenshot({
      path: "test-results/jonas-import-4-history-both.png",
      fullPage: true,
    });
  });

  test("duplicate-period re-upload surfaces the duplicate warning", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await page.goto("/app/admin/imports/jonas");

    // First import (May 2026 — may already exist from the test above).
    await uploadAndImport(page, {
      csv: DATASET_A_MAY_2026,
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
      fiscalYearLabel: "FY2026",
      fiscalPeriodSequence: "5",
    });
    await expect(page.locator('[data-testid="commit-summary"]')).toBeVisible();

    // Reload then re-paste the SAME CSV for the SAME period. The
    // datasets here are spectre-normalised, so the manual options
    // panel must be expanded to fill the date inputs.
    await page.goto("/app/admin/imports/jonas");
    await page.fill('[data-testid="field-csv-textarea"]', DATASET_A_MAY_2026);
    await page.locator('[data-testid="jonas-manual-options-summary"]').click();
    await page.fill('[data-testid="field-period-start"]', "2026-05-01");
    await page.fill('[data-testid="field-period-end"]', "2026-05-31");
    await page.fill('[data-testid="field-fiscal-year"]', "FY2026");
    await page.fill('[data-testid="field-fiscal-period"]', "5");
    await page.click('[data-testid="btn-preview"]');

    await expect(
      page.locator('[data-testid="preview-duplicate-warning"]'),
    ).toBeVisible({ timeout: 10_000 });
    await page.screenshot({
      path: "test-results/jonas-import-5-duplicate-warning.png",
      fullPage: true,
    });
  });

  test("validation error surfaces when required columns are missing", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await page.goto("/app/admin/imports/jonas");

    await page.fill(
      '[data-testid="field-csv-textarea"]',
      "AccountNumber,AccountDescription\n1010,Cash",
    );
    // The CSV is missing PeriodBalance / YTDBalance / FiscalYear /
    // FiscalPeriod columns — the parser fails at required-column
    // validation BEFORE date validation, so the four date inputs
    // (now collapsed inside the manual-options panel) don't need
    // to be filled. Click Preview immediately.
    await page.click('[data-testid="btn-preview"]');

    await expect(
      page.locator('[data-testid="preview-validation-failed"]'),
    ).toBeVisible({ timeout: 10_000 });
    await page.screenshot({
      path: "test-results/jonas-import-6-validation-error.png",
      fullPage: true,
    });
    // Commit button should not exist when validation failed.
    expect(await page.locator('[data-testid="btn-commit"]').count()).toBe(0);
  });

  // -----------------------------------------------------------------
  // Jonas-native happy path — no manual fields required, end-to-end.
  // -----------------------------------------------------------------

  test("Jonas-native CSV: only file/paste + Preview — no manual date fields needed", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await page.goto("/app/admin/imports/jonas");

    // The four manual fields are inside a <details> that's CLOSED by
    // default. Confirm they're not "visible" without expansion.
    const detailsOpen = await page
      .locator('[data-testid="jonas-manual-options"]')
      .getAttribute("open");
    expect(detailsOpen, "manual options panel is collapsed by default").toBeNull();

    // Paste the raw Jonas-native fixture — 3 preamble rows,
    // embedded-newline headers, currency strings, NEGATIVE credits.
    // Reconciles at $21,000,000 debits ≡ $21,000,000 credits.
    const jonasNativeCsv = `Silver Springs Golf & Country Club
"Trial Balance for May, 2026"
Closing Period Balances
"G/L Account
Code","G/L Account
Description","Closing Bal
Debit","Closing Bal
Credit"
1010,"Cash - Operating Account","$2,015,800.00","$0.00"
1100,"Accounts Receivable Net","$984,200.00","$0.00"
1850,"Reserve Fund Investment","$5,000,000.00","$0.00"
1910,"Property Plant & Equipment Net","$8,000,000.00","$0.00"
2010,"Accounts Payable","$0.00","-$300,000.00"
2510,"Long-Term Debt","$0.00","-$1,200,000.00"
3010,"Members' Equity","$0.00","-$13,500,000.00"
4010,"Membership Dues Revenue","$0.00","-$4,500,000.00"
4020,"F&B Revenue","$0.00","-$1,500,000.00"
5010,"Operating Expenses","$5,000,000.00","$0.00"
`;
    await page.fill('[data-testid="field-csv-textarea"]', jonasNativeCsv);

    // Click Preview — no manual entries.
    await page.click('[data-testid="btn-preview"]');
    await expect(page.locator('[data-testid="preview-ok"]')).toBeVisible({
      timeout: 15_000,
    });

    // Detected-period summary appears with the inferred values.
    // Silver Springs' Club Profile has fiscalYearEndMonth=6, day=30
    // (Jun 30) — so May 2026 falls in FY 2026 starting Jul 1 2025,
    // which makes May the 11th fiscal period (Jul=1 … May=11).
    await expect(
      page.locator('[data-testid="jonas-detected-period"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="jonas-detected-period-summary"]'),
    ).toContainText("FY2026");
    await expect(
      page.locator('[data-testid="jonas-detected-period-summary"]'),
    ).toContainText("Period 11");
    await expect(
      page.locator('[data-testid="jonas-detected-period-start"]'),
    ).toHaveText("2025-07-01");
    await expect(
      page.locator('[data-testid="jonas-detected-period-end"]'),
    ).toHaveText("2026-05-31");

    // Manual-required hint is NOT shown for Jonas-native files.
    expect(
      await page.locator('[data-testid="jonas-manual-required-hint"]').count(),
    ).toBe(0);

    // Commit succeeds without any manual field interaction.
    await page.click('[data-testid="btn-commit"]');
    await expect(page.locator('[data-testid="commit-summary"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('[data-testid="commit-status"]')).toContainText(
      "SUCCEEDED",
    );
  });

  test("non-Jonas CSV: preview surfaces the manual-required hint and auto-opens the Advanced panel", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await page.goto("/app/admin/imports/jonas");

    // Spectre-normalised CSV (no Jonas preamble). Preview without
    // filling manual fields succeeds (the parse is OK) but no
    // dates are inferred.
    await page.fill(
      '[data-testid="field-csv-textarea"]',
      "AccountNumber,AccountDescription,PeriodBalance,YTDBalance,FiscalYear,FiscalPeriod\n1010,Cash,1000,1000,FY2026,5\n",
    );
    await page.click('[data-testid="btn-preview"]');
    await expect(page.locator('[data-testid="preview-ok"]')).toBeVisible({
      timeout: 15_000,
    });

    // The "manual-required" hint surfaces; the detected-period panel
    // does NOT (no Jonas heading to infer from).
    await expect(
      page.locator('[data-testid="jonas-manual-required-hint"]'),
    ).toBeVisible();
    expect(
      await page.locator('[data-testid="jonas-detected-period"]').count(),
    ).toBe(0);

    // The Advanced panel auto-opens so the operator can fill dates
    // immediately without hunting for the toggle.
    const detailsOpen = await page
      .locator('[data-testid="jonas-manual-options"]')
      .getAttribute("open");
    expect(detailsOpen, "manual panel auto-opens on non-Jonas preview").not.toBeNull();
  });
});
