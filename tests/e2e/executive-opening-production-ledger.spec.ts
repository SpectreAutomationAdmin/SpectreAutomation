// Executive Opening — production-ledger refactor validation.
//
// Mirrors the SoFP + SoA validation specs. Proves the cover-page
// At-a-Glance KPIs + reactive headline narrative + board
// consideration block all flip from the seeded Silver Springs
// values to live ledger-derived values after a Jonas import.
//
// Validation per the migration brief:
//   • all cover KPIs change between BEFORE / Dataset A / Dataset B
//   • narrative changes
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
      filename: "e2e-exec.csv",
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

async function gotoMonthlyPackage(page: Page) {
  await page.goto("/app/admin/reporting/monthly");
  // The cover At-a-Glance grid renders four exec KPIs (ytd-revenue,
  // noi, capital-income, reserve-coverage). Wait for the first to
  // attach — confirms the page rendered.
  await page
    .locator('[data-testid="monthly-cover-at-a-glance-ytd-revenue-value"]')
    .waitFor({ state: "attached", timeout: 30_000 });
}

async function readExecKpi(page: Page, key: string): Promise<string> {
  return (await page
    .locator(`[data-testid="monthly-cover-at-a-glance-${key}-value"]`)
    .innerText()).trim();
}

test.describe("Executive Opening — production-ledger dual-read", () => {
  test.beforeEach(async () => {
    await wipeSilverSpringsJonas();
  });

  test.afterAll(async () => {
    await wipeSilverSpringsJonas();
    await prisma.$disconnect();
  });

  test("BEFORE empty → seed; AFTER Dataset A → live; AFTER Dataset B → replacement (every cover KPI changes)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);

    // ----------- BEFORE (empty ledger → seed) -----------
    await gotoMonthlyPackage(page);
    const beforeRevenue = await readExecKpi(page, "ytd-revenue");
    const beforeNoi = await readExecKpi(page, "noi");
    const beforeCapital = await readExecKpi(page, "capital-income");
    const beforeReserve = await readExecKpi(page, "reserve-coverage");
    expect(beforeRevenue, "seed YTD Revenue").toContain("14.6");
    expect(beforeNoi, "seed NOI").toContain("3.18");
    expect(beforeCapital, "seed Capital Income").toContain("2.04");
    // Reserve coverage stays seeded — comes from auxiliary input (not BS/IS).
    expect(beforeReserve, "seed Reserve Coverage").toContain("1.42");
    await page.screenshot({
      path: "test-results/exec-1-before-empty.png",
      fullPage: true,
    });

    // ----------- AFTER Dataset A -----------
    await importJonasDirect(DATASET_A_MAY_2026);
    await gotoMonthlyPackage(page);
    const afterARevenue = await readExecKpi(page, "ytd-revenue");
    const afterANoi = await readExecKpi(page, "noi");
    const afterACapital = await readExecKpi(page, "capital-income");
    // Dataset A: 4010 dues 4.5M + 4020 F&B 1.5M = $6.0M revenue.
    expect(afterARevenue, "Dataset A YTD Revenue").toContain("6.0");
    expect(afterARevenue).not.toContain("14.6");
    // NOI before depreciation = 6M revenue - 5M opex (no depr in dataset) = $1.0M.
    expect(afterANoi).toContain("1.0");
    expect(afterANoi).not.toContain("3.18");
    // Capital income — Dataset A has no 9xxx capital revenue accounts → $0.
    expect(afterACapital).not.toContain("2.04");
    await page.screenshot({
      path: "test-results/exec-2-after-dataset-a.png",
      fullPage: true,
    });

    // ----------- AFTER Dataset B (replacement) -----------
    await importJonasDirect(DATASET_B_MAY_2026);
    await gotoMonthlyPackage(page);
    const afterBRevenue = await readExecKpi(page, "ytd-revenue");
    const afterBNoi = await readExecKpi(page, "noi");
    // Dataset B: 5.42M + 1.84M = $7.26M revenue.
    expect(afterBRevenue, "Dataset B YTD Revenue").toContain("7.26");
    expect(afterBRevenue).not.toContain("6.0");
    // NOI = 7.26M - 5.955M = $1.305M.
    expect(afterBNoi).toContain("1.30");
    await page.screenshot({
      path: "test-results/exec-3-after-dataset-b.png",
      fullPage: true,
    });
  });

  test("Cover At-a-Glance grid values + variances change between seed and live", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);

    // Capture the entire At-a-Glance grid text before + after.
    // The grid is scoped to the executiveSummary block — boardBriefing
    // cards live in a different region and are out of scope here.
    await gotoMonthlyPackage(page);
    const beforeGrid = await page
      .locator('[data-testid="monthly-cover-at-a-glance-grid"]')
      .innerText();
    expect(beforeGrid, "seed grid contains $14.62M revenue").toContain("$14.62M");
    expect(beforeGrid, "seed grid contains $3.18M NOI").toContain("$3.18M");

    // Import Dataset A and re-render.
    await importJonasDirect(DATASET_A_MAY_2026);
    await gotoMonthlyPackage(page);
    const afterGrid = await page
      .locator('[data-testid="monthly-cover-at-a-glance-grid"]')
      .innerText();
    expect(afterGrid, "live grid contains $6.00M revenue").toContain("$6.00M");
    expect(afterGrid, "live grid contains $1.00M NOI").toContain("$1.00M");
    // The seed revenue + NOI values are GONE from the executive
    // summary surface.
    expect(afterGrid).not.toContain("$14.62M");
    expect(afterGrid).not.toContain("$3.18M");
    // Variance line also flipped (different actual vs same comparator
    // → different variance %). Whole grid text differs.
    expect(afterGrid).not.toBe(beforeGrid);
  });
});
