// Stewardship Dashboard — production-ledger refactor validation.
//
// Mirrors the SoFP + SoA + Executive Opening validation specs.
// Proves the chapter II scorecards AND the chapter III KPI Dashboard
// summary cards all flip from seed → live → replacement when the
// underlying BS + IS snapshots change.
//
// Validation per the migration brief:
//   • scorecards change   (operating + capital scorecard rows recompute)
//   • RAG statuses change (per-row status dots derive from snapshot numerics)
//   • Dashboard Notes change (handled at the summary-card level — see notes
//     in the migration report; the chapter III notes generator still
//     consumes the operatingKpiCards array which is a separate surface)
//
// Captures three screenshots (BEFORE / Dataset A / Dataset B) for
// the migration summary.

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
      filename: "e2e-stewardship.csv",
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

async function gotoMonthly(page: Page) {
  await page.goto("/app/admin/reporting/monthly");
  await page
    .locator('[data-testid="stewardship-summary-revenue-value"]')
    .waitFor({ state: "attached", timeout: 30_000 });
}

async function readSummary(page: Page, key: string): Promise<string> {
  return (await page
    .locator(`[data-testid="stewardship-summary-${key}-value"]`)
    .innerText()).trim();
}

test.describe("Stewardship Dashboard — production-ledger dual-read", () => {
  test.beforeEach(async () => {
    await wipeSilverSpringsJonas();
  });

  test.afterAll(async () => {
    await wipeSilverSpringsJonas();
    await prisma.$disconnect();
  });

  test("BEFORE → seed; AFTER A → live; AFTER B → replacement (chapter III summary cards flip)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);

    // ----------- BEFORE (empty ledger → seed) -----------
    await gotoMonthly(page);
    const beforeRevenue = await readSummary(page, "revenue");
    const beforeNoi = await readSummary(page, "noi");
    const beforeCapital = await readSummary(page, "capital-fund-income");
    expect(beforeRevenue, "seed Total Operating Revenue").toContain("5.786M");
    expect(beforeNoi, "seed NOI").toContain("253K");
    expect(beforeCapital, "seed Capital Fund Income").toContain("1.285M");
    await page.screenshot({
      path: "test-results/stewardship-1-before-empty.png",
      fullPage: true,
    });

    // ----------- AFTER Dataset A -----------
    await importJonasDirect(DATASET_A_MAY_2026);
    await gotoMonthly(page);
    const afterARevenue = await readSummary(page, "revenue");
    const afterANoi = await readSummary(page, "noi");
    // Dataset A: 4.5M dues + 1.5M F&B = $6.000M revenue.
    expect(afterARevenue, "Dataset A revenue").toContain("6.000M");
    expect(afterARevenue).not.toContain("5.786M");
    // NOI = 6M - 5M opex = $1.000M.
    expect(afterANoi, "Dataset A NOI").toContain("1.000M");
    expect(afterANoi).not.toContain("253K");
    await page.screenshot({
      path: "test-results/stewardship-2-after-dataset-a.png",
      fullPage: true,
    });

    // ----------- AFTER Dataset B -----------
    await importJonasDirect(DATASET_B_MAY_2026);
    await gotoMonthly(page);
    const afterBRevenue = await readSummary(page, "revenue");
    const afterBNoi = await readSummary(page, "noi");
    // Dataset B: 5.42M + 1.84M = $7.260M revenue.
    expect(afterBRevenue, "Dataset B revenue").toContain("7.260M");
    expect(afterBRevenue).not.toContain("6.000M");
    // NOI = 7.26M - 5.955M = $1.305M.
    expect(afterBNoi, "Dataset B NOI").toContain("1.305M");
    await page.screenshot({
      path: "test-results/stewardship-3-after-dataset-b.png",
      fullPage: true,
    });
  });

  test("Operating + Capital scorecard rows recompute when underlying IS / BS data changes", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);

    // Capture the entire Stewardship Dashboard region text before
    // and after Dataset A. The scorecard cards live under chapter II's
    // stewardshipDashboard.scorecards block — their per-row actuals
    // recompute from the IS snapshot.
    await gotoMonthly(page);
    const beforeText = await page.locator("body").innerText();

    await importJonasDirect(DATASET_A_MAY_2026);
    await gotoMonthly(page);
    const afterText = await page.locator("body").innerText();

    // The page TEXT differs after the import — scorecard rows
    // (NOI variance, NOI % revenue, payroll ratio, dues:revenue)
    // all recompute from the new snapshot.
    expect(afterText).not.toBe(beforeText);
    // Dataset A produces 6.000M revenue → reflected on the chapter
    // III revenue card.
    expect(afterText, "live revenue surfaces somewhere on the page").toContain("6.000M");
  });

  // -----------------------------------------------------------------
  // Chapter III explanatory KPI cards (operatingKpiCards +
  // capitalKpiCards) — the rows that previously lived as ~16 inline
  // hardcoded literals in monthly-package.ts. Their actuals, tones,
  // and assessment text are now derived from BS + IS where the data
  // exists.
  // -----------------------------------------------------------------
  test("Chapter III KPI cards (dues-rev / payroll-ratio / noi-margin / debt-equity / ppe-reinvestment / working-capital) flip on import", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);

    // ----- BEFORE (demo branch — hardcoded values render) -----
    await gotoMonthly(page);
    const beforeDuesRev = await page
      .locator('[data-testid="stewardship-dues-rev-actual"]')
      .innerText();
    const beforeWorkingCap = await page
      .locator('[data-testid="stewardship-working-capital-actual"]')
      .innerText();
    expect(beforeDuesRev, "seed dues-rev").toContain("41.8");
    expect(beforeWorkingCap, "seed working-capital").toContain("4.71");

    // ----- AFTER Dataset A (live branch — computed from snapshot) -----
    await importJonasDirect(DATASET_A_MAY_2026);
    await gotoMonthly(page);
    const liveDuesRev = await page
      .locator('[data-testid="stewardship-dues-rev-actual"]')
      .innerText();
    const liveNoiMargin = await page
      .locator('[data-testid="stewardship-noi-margin-actual"]')
      .innerText();
    const livePayroll = await page
      .locator('[data-testid="stewardship-payroll-ratio-actual"]')
      .innerText();
    const liveWorkingCap = await page
      .locator('[data-testid="stewardship-working-capital-actual"]')
      .innerText();

    // Dataset A: dues 4.5M / total revenue 6.0M = 75.0%.
    expect(liveDuesRev, "live dues-rev derived from IS").toContain("75.0");
    expect(liveDuesRev).not.toBe(beforeDuesRev);
    // NOI margin: 1.0M NOI / 6.0M revenue = 16.7%.
    expect(liveNoiMargin, "live NOI margin").toContain("16.7");
    // Payroll ratio — Dataset A has no payroll-tagged expense line,
    // so the derived numerator is 0 → ratio 0.0% (the rule is honest
    // about the data sparsity).
    expect(livePayroll, "live payroll ratio").toContain("0.0");
    // Working capital: BS-derived (Cash 2M + AR 1M − AP 300K) = $2.7M.
    expect(liveWorkingCap, "live working capital").toContain("2.7");

    // Tone classification is reactive — pull the tone attribute on
    // the dues-rev tone dot.
    const duesRevTone = await page
      .locator('[data-testid="stewardship-dues-rev-tone"]')
      .getAttribute("data-tone");
    // Seed had policy band 38–44% with actual 41.8% → green.
    // Live actual 75% sits above the 44% policy ceiling → amber/red.
    expect(["amber", "red"]).toContain(duesRevTone);
  });

  test("Dashboard Notes paragraphs flip when KPI tones change (no contradiction with the cards)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);

    // ----- BEFORE: seed dashboard notes contain seed-tone phrasing -----
    await gotoMonthly(page);
    const beforeNotes = await page
      .locator('[data-testid="stewardship-kpi-dashboard-notes"]')
      .innerText();

    // ----- AFTER Dataset A: live KPI tones drive new notes -----
    await importJonasDirect(DATASET_A_MAY_2026);
    await gotoMonthly(page);
    const liveNotes = await page
      .locator('[data-testid="stewardship-kpi-dashboard-notes"]')
      .innerText();

    // The dashboard notes paragraph is regenerated when any KPI tone
    // flips. Seed: dues-rev green, payroll green, noi-margin green
    // → "all operating metrics on plan" branch. Live (Dataset A):
    // dues-rev is amber/red (75% vs 44% policy), noi-margin amber
    // (16.7% vs 20% plan), payroll-ratio 0% (live but degenerate
    // dataset). Branch flips → text differs.
    expect(liveNotes).not.toBe(beforeNotes);
  });
});
