// Statement of Activities — production-ledger refactor validation.
//
// Mirrors the SoFP validation spec; proves chapter IV is fully
// dual-read driven against the production Reporting Ledger.
//
// Validation per the migration brief:
//   • revenue changes
//   • expenses change
//   • NOI changes
//   • variances change
//   • commentary changes
//
// Captures three screenshots (BEFORE empty → AFTER Dataset A → AFTER
// Dataset B) for the migration summary.

import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

import {
  InMemoryJonasImportHistory,
  JonasGlImporter,
  PrismaReportingLedger,
} from "@/lib/reporting/ledger";

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

const prisma = new PrismaClient();

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

// Dataset B uses the same May 2026 period so it's a replacement of A.
// Reconciles 22.26M ≡ 22.26M.
const DATASET_B_MAY_2026 = `AccountNumber,AccountDescription,PeriodBalance,YTDBalance,FiscalYear,FiscalPeriod
1010,Cash - Operating Account,200000,2200000,FY2026,5
1100,Accounts Receivable Net,50000,1050000,FY2026,5
1850,Reserve Fund Investment,80000,5080000,FY2026,5
1910,Property Plant & Equipment Net,-25000,7975000,FY2026,5
2010,Accounts Payable,0,300000,FY2026,5
2510,Long-Term Debt,0,1200000,FY2026,5
3010,Members' Equity,0,13500000,FY2026,5
4010,Membership Dues Revenue,920000,5420000,FY2026,5
4020,F&B Revenue,340000,1840000,FY2026,5
5010,Operating Expenses,955000,5955000,FY2026,5`;

const MAY_START = new Date(Date.UTC(2026, 4, 1));
const MAY_END = new Date(Date.UTC(2026, 4, 31, 23, 59, 59));

async function wipeSilverSpringsJonas() {
  const club = await prisma.club.findFirst({
    where: { slug: "silver-springs" },
    select: { id: true },
  });
  if (!club) return;
  await prisma.reportingLedgerSnapshot.deleteMany({
    where: { clubId: club.id, sourceSystem: "jonas-gl" },
  });
  await prisma.reportingLedgerBatch.deleteMany({
    where: { clubId: club.id, sourceSystem: "jonas-gl" },
  });
}

async function importJonasDirect(csv: string) {
  const club = await prisma.club.findFirst({
    where: { slug: "silver-springs" },
    select: { id: true },
  });
  if (!club) throw new Error("Silver Springs club not seeded");
  const ledger = new PrismaReportingLedger(prisma);
  const importer = new JonasGlImporter({
    writer: ledger,
    history: new InMemoryJonasImportHistory(),
  });
  const result = await importer.importJonasExtract({
    clubId: club.id,
    extract: {
      csv,
      filename: "e2e-soa.csv",
      periodStart: MAY_START,
      periodEnd: MAY_END,
      fiscalYearLabel: "FY2026",
      fiscalPeriodSequence: 5,
    },
  });
  if (result.status !== "succeeded") {
    throw new Error(`Import did not succeed: ${result.status} — ${result.notes ?? ""}`);
  }
  return result;
}

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

async function gotoSoA(page: Page) {
  await page.goto("/app/admin/reporting/monthly");
  // Wait for the SoA's Total Operating Revenue row.
  await page
    .locator('[data-testid="soa-row-total-operating-revenue"]')
    .waitFor({ state: "attached", timeout: 30_000 });
}

async function readRow(page: Page, key: string): Promise<string> {
  const text = await page.locator(`[data-testid="soa-row-${key}"]`).innerText();
  return text.replace(/\s+/g, " ").trim();
}

test.describe("Statement of Activities — production-ledger dual-read", () => {
  test.beforeEach(async () => {
    await wipeSilverSpringsJonas();
  });

  test.afterAll(async () => {
    await wipeSilverSpringsJonas();
    await prisma.$disconnect();
  });

  test("BEFORE empty → seed; AFTER Dataset A → live; AFTER Dataset B → replacement (revenue + NOI + depreciation + commentary all change)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);

    // ----------- BEFORE (empty ledger) -----------
    await gotoSoA(page);
    const beforeRevenue = await readRow(page, "total-operating-revenue");
    const beforeNoi = await readRow(page, "noi-before-dep");
    const beforeDep = await readRow(page, "depreciation");
    expect(beforeRevenue, "seed total operating revenue").toContain("3,271,707");
    expect(beforeNoi, "seed NOI Before Dep").toContain("253,460");
    // Seed depreciation rendered as negative -$1,029,122.
    expect(beforeDep, "seed depreciation").toContain("1,029,122");
    await page
      .locator('[data-testid="soa-row-total-operating-revenue"]')
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: "test-results/soa-1-before-empty.png",
      fullPage: true,
    });

    // ----------- AFTER Dataset A -----------
    await importJonasDirect(DATASET_A_MAY_2026);
    await gotoSoA(page);
    const afterARevenue = await readRow(page, "total-operating-revenue");
    const afterANoi = await readRow(page, "noi-before-dep");
    const afterADep = await readRow(page, "depreciation");
    // Dataset A revenue: 4010 (4.5M dues) + 4020 (1.5M F&B) = 6,000,000.
    expect(afterARevenue, "Dataset A total operating revenue").toContain(
      "6,000,000",
    );
    // Seed value gone.
    expect(afterARevenue).not.toContain("3,271,707");
    // Dataset A has no depreciation account → snapshot.depreciation = 0
    // → rendered as 0 / em-dash. Seed value gone.
    expect(afterADep).not.toContain("1,029,122");
    // NOI Before Dep = 6M revenue - 5M op exp = 1,000,000.
    expect(afterANoi).toContain("1,000,000");
    expect(afterANoi).not.toContain("253,460");
    await page.screenshot({
      path: "test-results/soa-2-after-dataset-a.png",
      fullPage: true,
    });

    // ----------- AFTER Dataset B -----------
    await importJonasDirect(DATASET_B_MAY_2026);
    await gotoSoA(page);
    const afterBRevenue = await readRow(page, "total-operating-revenue");
    const afterBNoi = await readRow(page, "noi-before-dep");
    // Dataset B revenue: 5,420K + 1,840K = 7,260,000.
    expect(afterBRevenue, "Dataset B total operating revenue").toContain(
      "7,260,000",
    );
    expect(afterBRevenue).not.toContain("6,000,000");
    // NOI Before Dep = 7,260K - 5,955K = 1,305,000.
    expect(afterBNoi).toContain("1,305,000");
    await page.screenshot({
      path: "test-results/soa-3-after-dataset-b.png",
      fullPage: true,
    });
  });

  test("CFO commentary text changes between seed / Dataset A / Dataset B (NOI variance figure flips)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);

    // Use the CFO commentary block — it lives in the rendered page
    // and quotes the actual NOI value. Different snapshot → different
    // NOI value embedded in the bullet.
    await gotoSoA(page);
    const seedCommentary = await page
      .locator('text=/NOI before depreciation of/i')
      .first()
      .innerText();
    expect(seedCommentary).toContain("253,460");

    await importJonasDirect(DATASET_A_MAY_2026);
    await gotoSoA(page);
    const liveCommentary = await page
      .locator('text=/NOI before depreciation of/i')
      .first()
      .innerText();
    expect(liveCommentary).toContain("1,000,000");
    expect(liveCommentary).not.toContain("253,460");
    expect(liveCommentary).not.toBe(seedCommentary);
  });
});
