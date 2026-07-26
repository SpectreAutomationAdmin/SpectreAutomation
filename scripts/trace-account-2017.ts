// One-shot diagnostic: trace account 2017 through every layer of the
// May 2026 Statement of Financial Position pipeline using the actual
// DB. Founder rule 2026-07-13 v15.22 — no synthetic fixtures.

import { PrismaClient } from "@prisma/client";
import { getStatementOfFinancialPositionForClub } from "../src/lib/reporting/statement-of-financial-position";
import { buildReportingPeriod } from "../src/lib/reporting/reporting-period";
import { PrismaReportingLedger } from "../src/lib/reporting/ledger";

const prisma = new PrismaClient();

async function main() {
  const club = await prisma.club.findFirst({ where: { slug: "silver-springs" }, select: { id: true, name: true } });
  if (!club) { console.error("Silver Springs club not found"); process.exit(1); }
  console.log("=== CLUB:", club.name, club.id);

  // 1) Raw Chart-of-Accounts row for 2017
  const coa = await prisma.account.findFirst({
    where: { clubId: club.id, accountNumber: "2017" },
    select: { id: true, accountNumber: true, name: true, type: true, normalBalance: true, categoryId: true, fsGroupId: true, isActive: true },
  });
  console.log("\n=== CoA account 2017:");
  console.log(JSON.stringify(coa, null, 2));
  if (coa?.categoryId) {
    const cat = await prisma.accountCategory.findUnique({ where: { id: coa.categoryId }, select: { key: true, name: true } });
    console.log("  category:", cat);
  }
  if (coa?.fsGroupId) {
    const fs = await prisma.financialStatementGroup.findUnique({ where: { id: coa.fsGroupId }, select: { key: true, name: true, sortOrder: true } });
    console.log("  fsGroup:", fs);
  }

  // 2) Latest trial-balance snapshot ≤ May 31 2026 23:59:59
  const periodEnd = new Date(Date.UTC(2026, 4, 31, 23, 59, 59));
  const tbSnapshots = await prisma.reportingLedgerSnapshot.findMany({
    where: { clubId: club.id, entityKind: "trial-balance", asOf: { lte: periodEnd }, batchState: "committed" },
    orderBy: [{ asOf: "desc" }, { capturedAt: "desc" }],
    take: 3,
    select: { snapshotId: true, asOf: true, capturedAt: true, sourceSystem: true, dataSource: true, payloadJson: true },
  });
  console.log("\n=== TB snapshots ≤ May 31 2026 23:59:59 (top 3):");
  tbSnapshots.forEach((s, i) => console.log(`  #${i + 1}`, s.snapshotId, "asOf:", s.asOf?.toISOString(), "sys:", s.sourceSystem, "src:", s.dataSource));

  if (tbSnapshots.length > 0) {
    const payload = JSON.parse(tbSnapshots[0].payloadJson);
    const line2017 = (payload.lines ?? []).find((l: any) => l.accountCode === "2017");
    console.log("\n=== TB payload line 2017 (snapshot", tbSnapshots[0].snapshotId, "):");
    console.log(JSON.stringify(line2017, null, 2));
  }

  // 3) BalanceSheet snapshot payload
  const bsSnapshots = await prisma.reportingLedgerSnapshot.findMany({
    where: { clubId: club.id, entityKind: "balance-sheet", asOf: { lte: periodEnd }, batchState: "committed" },
    orderBy: [{ asOf: "desc" }, { capturedAt: "desc" }],
    take: 3,
    select: { snapshotId: true, asOf: true, capturedAt: true, dataSource: true, payloadJson: true },
  });
  console.log("\n=== BS snapshots ≤ May 31 2026 23:59:59 (top 3):");
  bsSnapshots.forEach((s, i) => console.log(`  #${i + 1}`, s.snapshotId, "asOf:", s.asOf?.toISOString(), "src:", s.dataSource));

  if (bsSnapshots.length > 0) {
    const payload = JSON.parse(bsSnapshots[0].payloadJson);
    const bsLine2017 = (payload.lines ?? []).find((l: any) => l.accountCode === "2017");
    console.log("\n=== BS payload line 2017 (snapshot", bsSnapshots[0].snapshotId, "):");
    console.log(JSON.stringify(bsLine2017, null, 2));
  }

  // 4) Live SoFP build — this is what the page renders
  console.log("\n=== Building live SoFP (viewerCanDrillDown=true) ===");
  const period = buildReportingPeriod(new Date(Date.UTC(2026, 4, 31)));
  const ledger = new PrismaReportingLedger(prisma as any);
  const sofp = await getStatementOfFinancialPositionForClub({
    clubId: club.id,
    clubName: club.name,
    period,
    ledger,
    auxiliaryRatioInputs: {
      arCurrentRate: 0.999,
      duesToRevenueRatio: 0.659,
      reserveCoverageRatio: 0.61,
      debtServiceCoverage: 2.1,
      netToGrossPpeOverride: 0.44,
    },
    grossReplacementCostLabel: "$7.9M",
    viewerCanDrillDown: true,
  });

  const apRow: any = sofp.liabilitiesEquityRows.find((r: any) => r.fsGroupKey === "BS_AP");
  console.log("\n=== Accounts Payable FS Group parent:");
  console.log("  current:", apRow?.current, "  comparative:", apRow?.comparative);
  console.log("  accounts drill-down (viewer canDrillDown=true):");
  apRow?.accounts?.forEach((a: any) => {
    console.log(`    ${String(a.accountCode).padEnd(6)} ${String(a.accountName).padEnd(40)} current=${String(a.current).padStart(12)}   comparative=${String(a.comparative)}`);
  });

  // 5) Sum of drill-down vs parent
  if (apRow?.accounts) {
    const sum = apRow.accounts.reduce((s: number, a: any) => s + (a.current ?? 0), 0);
    console.log("\n  drill-down SUM =", sum, "  parent =", apRow.current, "  match =", Math.abs(sum - (apRow.current ?? 0)) < 1);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
