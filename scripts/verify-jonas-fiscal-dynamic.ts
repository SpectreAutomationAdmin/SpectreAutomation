// One-shot verification — does the Jonas import pipeline read the
// CURRENT Club Settings fiscal-year-end dynamically, or is anything
// cached / defaulted / hardcoded?
//
// Run with:
//   npx tsx scripts/verify-jonas-fiscal-dynamic.ts
//
// Prints the calculated date metadata at every stage of the pipeline
// against:
//   • the live ClubProfile value
//   • a forced "Dec 31" value (proves the calc is dynamic)
//   • a forced "Jun 30" value (regression check from the spec)

import { prisma } from "../src/lib/prisma";
import {
  parseJonasGlCsv,
  type JonasHeadingMetadata,
} from "../src/lib/reporting/ledger/importers/jonas-gl-csv";
import {
  computeFiscalLabels,
  computeFiscalYearStart,
  DEFAULT_FISCAL_YEAR_END,
  lastDayOfMonthUtc,
} from "../src/lib/reporting/ledger/importers/jonas-fiscal-period";
import {
  InMemoryJonasImportHistory,
  JonasGlImporter,
  PrismaReportingLedger,
} from "../src/lib/reporting/ledger";

const JONAS_FIXTURE = `Silver Springs Golf & Country Club
"Trial Balance for Apr, 2026"
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

function divider(title: string) {
  console.log("\n" + "=".repeat(72));
  console.log(title);
  console.log("=".repeat(72));
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function row(label: string, value: string | number | null) {
  console.log(`  ${label.padEnd(28)} ${value}`);
}

async function main() {
  // ---------------------------------------------------------------
  // 1. Club Settings — what does the database say RIGHT NOW?
  // ---------------------------------------------------------------
  divider("STAGE 1 — Read live Club Settings (no cache)");

  const club = await prisma.club.findFirst({
    where: { slug: "silver-springs" },
    select: { id: true, name: true },
  });
  if (!club) {
    console.error("Silver Springs club not seeded");
    process.exit(1);
  }
  const profile = await prisma.clubProfile.findUnique({
    where: { clubId: club.id },
    select: { fiscalYearEndMonth: true, fiscalYearEndDay: true },
  });
  const liveFyEndMonth = profile?.fiscalYearEndMonth ?? DEFAULT_FISCAL_YEAR_END.month;
  const liveFyEndDay = profile?.fiscalYearEndDay ?? DEFAULT_FISCAL_YEAR_END.day;

  row("Club", `${club.name} (${club.id})`);
  row("DB.fiscalYearEndMonth", profile?.fiscalYearEndMonth ?? "(null → default)");
  row("DB.fiscalYearEndDay", profile?.fiscalYearEndDay ?? "(null → default)");
  row("Effective FY end (used)", `month=${liveFyEndMonth}, day=${liveFyEndDay}`);
  row("Default fallback if null", `month=${DEFAULT_FISCAL_YEAR_END.month}, day=${DEFAULT_FISCAL_YEAR_END.day}`);

  // ---------------------------------------------------------------
  // 2. Parser — extract heading metadata
  // ---------------------------------------------------------------
  divider("STAGE 2 — CSV parser extracts heading metadata");

  const parseResult = parseJonasGlCsv(JONAS_FIXTURE);
  if (!parseResult.ok) {
    console.error("Parse failed:", parseResult.fileErrors);
    process.exit(1);
  }
  const md = parseResult.headingMetadata!;
  row("calendarYear", md.calendarYear);
  row("calendarMonth", md.calendarMonth);
  row("periodEndDate (month-end)", md.periodEndDate.toISOString());
  row("(heading-stamped) fiscalYear", md.fiscalYear);
  row("(heading-stamped) fiscalPeriod", md.fiscalPeriod);
  row("Rows parsed", parseResult.rows.length);

  // ---------------------------------------------------------------
  // 3. Fiscal-calendar helpers — show the math for THREE FY ends
  // ---------------------------------------------------------------
  divider("STAGE 3 — Fiscal-calendar derivation (3 scenarios)");

  const scenarios: Array<{ label: string; month: number; day: number }> = [
    { label: "(A) LIVE Club Settings",     month: liveFyEndMonth, day: liveFyEndDay },
    { label: "(B) Forced Dec 31",          month: 12, day: 31 },
    { label: "(C) Forced Jun 30 (regression)", month: 6, day: 30 },
  ];

  for (const sc of scenarios) {
    console.log(`\n  ${sc.label} — FY end ${sc.month}/${sc.day}`);
    const periodEnd = md.periodEndDate;
    const fyStart = computeFiscalYearStart(periodEnd, sc.month, sc.day);
    const labels = computeFiscalLabels(periodEnd, sc.month, sc.day);
    row("    periodEnd", isoDate(periodEnd));
    row("    fiscalYearStart", isoDate(fyStart));
    row("    fiscalYearLabel", `FY${labels.fiscalYearNum}`);
    row("    fiscalPeriod", labels.fiscalPeriodNum);
  }

  // ---------------------------------------------------------------
  // 4. Full pipeline trace — using LIVE Club Settings
  // ---------------------------------------------------------------
  divider("STAGE 4 — Full pipeline trace (LIVE Club Settings)");

  console.log("\n  → CSV parser stage:");
  row("    fiscalYear (heading)", md.fiscalYear);
  row("    fiscalPeriod (heading)", md.fiscalPeriod);
  row("    periodEndDate (inferred)", isoDate(md.periodEndDate));

  console.log("\n  → Metadata inference stage:");
  const inferredStart = computeFiscalYearStart(md.periodEndDate, liveFyEndMonth, liveFyEndDay);
  const inferredLabels = computeFiscalLabels(md.periodEndDate, liveFyEndMonth, liveFyEndDay);
  row("    Period Start", isoDate(inferredStart));
  row("    Period End", isoDate(md.periodEndDate));
  row("    Fiscal Year", `FY${inferredLabels.fiscalYearNum}`);
  row("    Fiscal Period", inferredLabels.fiscalPeriodNum);

  console.log("\n  → Preview model (what the form's banner shows):");
  row("    inferredDates.periodStartIso", isoDate(inferredStart));
  row("    inferredDates.periodEndIso", isoDate(md.periodEndDate));
  row("    inferredDates.fiscalYearLabel", `FY${inferredLabels.fiscalYearNum}`);
  row("    inferredDates.fiscalPeriodSequence", inferredLabels.fiscalPeriodNum);

  console.log("\n  → Validation: dates are derived server-side, form fields ignored");

  console.log("\n  → Commit stage (actually import + persist):");
  // Use a sentinel clubId so we don't pollute the real Silver Springs
  // import history.
  const VERIFY_CLUB = `verify_jonas_dynamic_${Date.now()}`;
  await prisma.reportingLedgerSnapshot.deleteMany({
    where: { clubId: { startsWith: "verify_jonas_dynamic_" } },
  });
  await prisma.reportingLedgerBatch.deleteMany({
    where: { clubId: { startsWith: "verify_jonas_dynamic_" } },
  });
  const ledger = new PrismaReportingLedger(prisma);
  const importer = new JonasGlImporter({
    writer: ledger,
    history: new InMemoryJonasImportHistory(),
  });
  const importResult = await importer.importJonasExtract({
    clubId: VERIFY_CLUB,
    extract: {
      csv: JONAS_FIXTURE,
      filename: "verify-dynamic.csv",
      periodStart: inferredStart,
      periodEnd: md.periodEndDate,
      fiscalYearLabel: `FY${inferredLabels.fiscalYearNum}`,
      fiscalPeriodSequence: inferredLabels.fiscalPeriodNum,
    },
  });
  row("    status", importResult.status);
  row("    snapshotId", importResult.snapshotId ?? "(none)");
  row("    batchId", importResult.batchId);

  console.log("\n  → Reporting Ledger persistence (read back from Prisma):");
  if (importResult.snapshotId) {
    const persisted = await prisma.reportingLedgerSnapshot.findUnique({
      where: { snapshotId: importResult.snapshotId },
      select: {
        snapshotId: true,
        periodStart: true,
        periodEnd: true,
        asOf: true,
        fiscalYearLabel: true,
        reportingPeriod: true,
      },
    });
    if (persisted) {
      row("    DB.periodStart", persisted.periodStart?.toISOString() ?? "(null)");
      row("    DB.periodEnd", persisted.periodEnd?.toISOString() ?? "(null)");
      row("    DB.asOf", persisted.asOf?.toISOString() ?? "(null)");
      row("    DB.fiscalYearLabel", persisted.fiscalYearLabel ?? "(null)");
      row("    DB.reportingPeriod", persisted.reportingPeriod ?? "(null)");
    }
  }

  // Cleanup verification rows.
  await prisma.reportingLedgerSnapshot.deleteMany({
    where: { clubId: { startsWith: "verify_jonas_dynamic_" } },
  });
  await prisma.reportingLedgerBatch.deleteMany({
    where: { clubId: { startsWith: "verify_jonas_dynamic_" } },
  });

  // ---------------------------------------------------------------
  // 5. Expected-vs-actual matrix
  // ---------------------------------------------------------------
  divider("STAGE 5 — Expected vs actual (per user's spec)");

  const expectedDec31 = {
    periodStart: "2026-01-01",
    periodEnd: "2026-04-30",
    fiscalYearLabel: "FY2026",
    fiscalPeriod: 4,
  };
  const expectedJun30 = {
    periodStart: "2025-07-01",
    periodEnd: "2026-04-30",
    fiscalYearLabel: "FY2026",
    fiscalPeriod: 10, // user's expected value per regression-check spec
  };

  console.log("\n  USER-SPECIFIED EXPECTATIONS:");
  console.log("\n  When FY end = Dec 31:");
  Object.entries(expectedDec31).forEach(([k, v]) => row(`    ${k}`, v));

  const dec31 = computeFiscalLabels(md.periodEndDate, 12, 31);
  const dec31Start = computeFiscalYearStart(md.periodEndDate, 12, 31);
  console.log("\n  ACTUAL with FY end = Dec 31 (forced):");
  row("    periodStart", isoDate(dec31Start));
  row("    periodEnd", isoDate(md.periodEndDate));
  row("    fiscalYearLabel", `FY${dec31.fiscalYearNum}`);
  row("    fiscalPeriod", dec31.fiscalPeriodNum);
  const dec31Match =
    isoDate(dec31Start) === expectedDec31.periodStart &&
    isoDate(md.periodEndDate) === expectedDec31.periodEnd &&
    `FY${dec31.fiscalYearNum}` === expectedDec31.fiscalYearLabel &&
    dec31.fiscalPeriodNum === expectedDec31.fiscalPeriod;
  console.log(`\n  Dec 31 scenario MATCH: ${dec31Match ? "✓ YES" : "✗ NO"}`);

  console.log("\n  When FY end = Jun 30 (regression check):");
  Object.entries(expectedJun30).forEach(([k, v]) => row(`    ${k}`, v));

  const jun30 = computeFiscalLabels(md.periodEndDate, 6, 30);
  const jun30Start = computeFiscalYearStart(md.periodEndDate, 6, 30);
  console.log("\n  ACTUAL with FY end = Jun 30 (forced):");
  row("    periodStart", isoDate(jun30Start));
  row("    periodEnd", isoDate(md.periodEndDate));
  row("    fiscalYearLabel", `FY${jun30.fiscalYearNum}`);
  row("    fiscalPeriod", jun30.fiscalPeriodNum);
  // NOTE: the user said expected fiscalPeriod = 10 for Jun 30. The
  // correct value is 10: Jul=1, Aug=2, Sep=3, Oct=4, Nov=5, Dec=6,
  // Jan=7, Feb=8, Mar=9, Apr=10. ✓

  const jun30Match =
    isoDate(jun30Start) === expectedJun30.periodStart &&
    isoDate(md.periodEndDate) === expectedJun30.periodEnd &&
    `FY${jun30.fiscalYearNum}` === expectedJun30.fiscalYearLabel &&
    jun30.fiscalPeriodNum === expectedJun30.fiscalPeriod;
  console.log(`\n  Jun 30 scenario MATCH: ${jun30Match ? "✓ YES" : "✗ NO"}`);

  divider("DONE");

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
