// Trace the exact YTD earnings amount + confirm the SoFP is missing
// a Current-Year Earnings line for Silver Springs May 2026.

import { PrismaClient } from "@prisma/client";
import { balanceSheet, incomeStatement } from "../src/lib/accounting/reports";
import { getStatementOfFinancialPositionForClub } from "../src/lib/reporting/statement-of-financial-position";
import { buildReportingPeriod } from "../src/lib/reporting/reporting-period";
import { PrismaReportingLedger } from "../src/lib/reporting/ledger";

const prisma = new PrismaClient();

async function main() {
  const club = await prisma.club.findFirst({ where: { slug: "silver-springs" }, select: { id: true, name: true } });
  if (!club) { console.error("club missing"); process.exit(1); }

  const asOf = new Date(Date.UTC(2026, 4, 31, 23, 59, 59, 999));

  // 1) Canonical balanceSheet() — reveals its own currentYearEarnings value.
  const bs = await balanceSheet(club.id, asOf);
  console.log("=== canonical balanceSheet() ===");
  console.log("  totalAssets:              ", Number(bs.totalAssets));
  console.log("  totalLiabilities:         ", Number(bs.totalLiabilities));
  console.log("  totalEquity (with earn):  ", Number(bs.totalEquity));
  console.log("  currentYearEarnings:      ", Number(bs.currentYearEarnings));
  console.log("  isBalanced:               ", bs.isBalanced);

  // 2) Canonical incomeStatement() — for the fiscal-year-to-date range.
  const fiscalYear = await prisma.fiscalYear.findFirst({
    where: { clubId: club.id, startDate: { lte: asOf }, endDate: { gte: asOf } },
    select: { id: true, label: true, startDate: true, endDate: true },
  });
  console.log("\n=== fiscal year covering asOf ===");
  console.log(" ", fiscalYear);

  if (fiscalYear) {
    const is = await incomeStatement(club.id, fiscalYear.startDate, asOf);
    console.log("\n=== canonical incomeStatement() FYTD ===");
    console.log("  totalRevenue: ", Number(is.totalRevenue));
    console.log("  totalCogs:    ", Number(is.totalCogs));
    console.log("  grossMargin:  ", Number(is.grossMargin));
    console.log("  totalOpex:    ", Number(is.totalOpex));
    console.log("  netIncome:    ", Number(is.netIncome));
  }

  // 3) Live SoFP builder — check for YTD line + reconciliation.
  const period = buildReportingPeriod(new Date(Date.UTC(2026, 4, 31)));
  const ledger = new PrismaReportingLedger(prisma as any);
  const sofp = await getStatementOfFinancialPositionForClub({
    clubId: club.id,
    clubName: club.name,
    period,
    ledger,
    auxiliaryRatioInputs: {
      arCurrentRate: 0.999, duesToRevenueRatio: 0.659,
      reserveCoverageRatio: 0.61, debtServiceCoverage: 2.1,
      netToGrossPpeOverride: 0.44,
    },
    grossReplacementCostLabel: "$7.9M",
    viewerCanDrillDown: true,
  });

  console.log("\n=== live SoFP builder — equity section rows ===");
  for (const row of sofp.liabilitiesEquityRows) {
    if ((row as any).kind === "section-band-operating" && (row as any).label?.includes?.("Equity")) {
      console.log("  --- Members' Equity section band ---");
    }
    if ((row as any).kind === "fs-group" || (row as any).kind === "subtotal" || (row as any).kind === "total-mid" || (row as any).kind === "total") {
      console.log(`  ${(row as any).kind.padEnd(20)} key=${(row as any).key.padEnd(30)} label="${(row as any).label ?? ''}" current=${(row as any).current}`);
    }
  }

  const totalAssetsRow: any = sofp.assetsRows.find((r: any) => r.key === "total-assets");
  const totalLERow: any = sofp.liabilitiesEquityRows.find((r: any) => r.key === "total-liabilities-and-equity");
  console.log("\n=== reconciliation ===");
  console.log("  Total Assets:                     ", totalAssetsRow?.current);
  console.log("  Total Liabilities & Equity:       ", totalLERow?.current);
  console.log("  Difference:                       ", (totalAssetsRow?.current ?? 0) - (totalLERow?.current ?? 0));
  console.log("  sofp.reconciliation.balances:     ", (sofp as any).reconciliation?.balances);
  console.log("  sofp.reconciliation.diff:         ", (sofp as any).reconciliation?.diff);

  // 4) Is there a YTD line at all in liabilitiesEquityRows?
  const ytdRow = sofp.liabilitiesEquityRows.find(
    (r: any) => r.fsGroupKey === "BS_CURRENT_YEAR_EARNINGS" || r.key?.includes("ytd-net-income"),
  );
  console.log("\n=== YTD line present in built SoFP? ===");
  console.log(" ", ytdRow ? "YES" : "NO");
  if (ytdRow) console.log(" ", ytdRow);

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
