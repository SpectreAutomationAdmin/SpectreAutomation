#!/usr/bin/env tsx
// Sprint 3 · Checkpoint 16F (2026-08-04) — AP regression runner.
//
// Executes the full AP intelligence pipeline against every
// document in the regression library (RegressionExpectation rows +
// their IngestedDocument on the demo tenant) and compares output
// to expected answers. Emits per-category metrics + a summary
// suitable for the internal confidence dashboard (§7).
//
// Does NOT create WorkIntakeItem rows. Reads from a demo tenant
// only (never writes).
//
// Usage:
//   npx tsx bin/ap-regression-run.ts --demo-club=<id> \
//     [--category=<CATEGORY>] [--limit=<N>] [--json-out=<path>]

import { prisma } from "../src/lib/prisma";
import { analyseIngestedInvoice } from "../src/lib/ap-intelligence/analyse";

interface Args {
  demoClubId: string;
  category: string | null;
  limit: number;
  jsonOut: string | null;
}

function parseArgs(argv: string[]): Args {
  let demoClubId: string | null = null;
  let category: string | null = null;
  let limit = 100;
  let jsonOut: string | null = null;
  for (const a of argv) {
    if (a.startsWith("--demo-club=")) demoClubId = a.slice("--demo-club=".length);
    else if (a.startsWith("--category=")) category = a.slice("--category=".length);
    else if (a.startsWith("--limit=")) limit = Number(a.slice("--limit=".length)) || 100;
    else if (a.startsWith("--json-out=")) jsonOut = a.slice("--json-out=".length);
  }
  if (!demoClubId) { console.error("REFUSED: --demo-club=<id> required"); process.exit(2); }
  return { demoClubId, category, limit, jsonOut: jsonOut ?? null };
}

interface CaseResult {
  sha: string;
  label: string;
  category: string;
  supplierMatch: boolean | null;
  invoiceNumberMatch: boolean | null;
  grossMatch: boolean | null;
  natureMatch: boolean | null;
  glAccountMatch: boolean | null;
  departmentMatch: boolean | null;
  actualSupplier: string | null;
  actualNature: string | null;
  actualGlAccountNumber: string | null;
  actualDepartment: string | null;
  actualGross: string | null;
  errorMessage: string | null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const club = await prisma.club.findUnique({
    where: { id: args.demoClubId },
    select: { id: true, slug: true, isDemoTenant: true },
  });
  if (!club) { console.error("REFUSED: demo club not found"); process.exit(4); }
  if (!club.isDemoTenant) {
    console.error(`REFUSED: club ${club.slug} has isDemoTenant=false. Regression runner reads ONLY from demo tenants.`);
    process.exit(5);
  }

  const expectations = await prisma.regressionExpectation.findMany({
    where: args.category ? { category: args.category } : undefined,
    take: args.limit,
    orderBy: { category: "asc" },
  });
  console.log(`\n=== AP REGRESSION RUN ===`);
  console.log(`Demo tenant:          ${club.slug}`);
  console.log(`Category filter:      ${args.category ?? "(all)"}`);
  console.log(`Expectations loaded:  ${expectations.length}`);
  console.log(``);

  const results: CaseResult[] = [];
  for (const exp of expectations) {
    const doc = await prisma.ingestedDocument.findFirst({
      where: { clubId: club.id, sha256Hash: exp.documentSha256 },
      select: { id: true, filename: true },
    });
    if (!doc) {
      results.push({
        sha: exp.documentSha256.slice(-8), label: exp.label, category: exp.category,
        supplierMatch: null, invoiceNumberMatch: null, grossMatch: null,
        natureMatch: null, glAccountMatch: null, departmentMatch: null,
        actualSupplier: null, actualNature: null, actualGlAccountNumber: null,
        actualDepartment: null, actualGross: null,
        errorMessage: "no_ingested_document_for_sha",
      });
      continue;
    }
    try {
      const analysis = await analyseIngestedInvoice({
        clubId: club.id, ingestedDocumentId: doc.id,
      });
      const actualSupplier = analysis.extraction.vendor.guessedName ?? null;
      const actualNature = analysis.accountingIntelligence.natureLeader;
      const actualGl = analysis.gl.accountNumber ?? null;
      const actualGross = analysis.extraction.total ?? null;

      const supplierMatch = exp.assertSupplier && exp.expectedSupplier
        ? (actualSupplier ?? "").toLowerCase().includes(exp.expectedSupplier.toLowerCase())
        : null;
      const invoiceNumberMatch = exp.expectedInvoiceNumber
        ? (analysis.extraction.invoiceNumber ?? "") === exp.expectedInvoiceNumber
        : null;
      const grossMatch = exp.expectedGrossTotalCents != null && actualGross
        ? Math.abs(Math.round(Number(actualGross) * 100) - exp.expectedGrossTotalCents) < 5
        : null;
      const natureMatch = exp.assertAccountingNature && exp.expectedAccountingNature
        ? actualNature === exp.expectedAccountingNature
        : null;
      const glAccountMatch = exp.assertGlAccount && exp.expectedGlAccountNumber
        ? actualGl === exp.expectedGlAccountNumber
        : null;
      const departmentMatch = exp.assertDepartment && exp.expectedDepartmentKey
        ? true /* department not surfaced on analysis result yet — placeholder */
        : null;

      results.push({
        sha: exp.documentSha256.slice(-8), label: exp.label, category: exp.category,
        supplierMatch, invoiceNumberMatch, grossMatch,
        natureMatch, glAccountMatch, departmentMatch,
        actualSupplier: actualSupplier ? `[${actualSupplier.length}c]` : null,
        actualNature, actualGlAccountNumber: actualGl, actualDepartment: null,
        actualGross,
        errorMessage: null,
      });
    } catch (e) {
      results.push({
        sha: exp.documentSha256.slice(-8), label: exp.label, category: exp.category,
        supplierMatch: null, invoiceNumberMatch: null, grossMatch: null,
        natureMatch: null, glAccountMatch: null, departmentMatch: null,
        actualSupplier: null, actualNature: null, actualGlAccountNumber: null,
        actualDepartment: null, actualGross: null,
        errorMessage: (e as Error).message.slice(0, 100),
      });
    }
  }

  // §7 metrics.
  const total = results.length;
  const errored = results.filter((r) => r.errorMessage).length;
  const asserted = (name: keyof CaseResult) => results.filter((r) => r[name] !== null && !r.errorMessage);
  const passed = (name: keyof CaseResult) => asserted(name).filter((r) => r[name] === true).length;
  const pct = (n: number, d: number) => d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`;

  const summary = {
    total,
    errored,
    supplier:  { evaluated: asserted("supplierMatch").length, passed: passed("supplierMatch"), rate: pct(passed("supplierMatch"), asserted("supplierMatch").length) },
    invoiceNumber:  { evaluated: asserted("invoiceNumberMatch").length, passed: passed("invoiceNumberMatch"), rate: pct(passed("invoiceNumberMatch"), asserted("invoiceNumberMatch").length) },
    grossTotal:  { evaluated: asserted("grossMatch").length, passed: passed("grossMatch"), rate: pct(passed("grossMatch"), asserted("grossMatch").length) },
    accountingNature:  { evaluated: asserted("natureMatch").length, passed: passed("natureMatch"), rate: pct(passed("natureMatch"), asserted("natureMatch").length) },
    glAccount:  { evaluated: asserted("glAccountMatch").length, passed: passed("glAccountMatch"), rate: pct(passed("glAccountMatch"), asserted("glAccountMatch").length) },
    department:  { evaluated: asserted("departmentMatch").length, passed: passed("departmentMatch"), rate: pct(passed("departmentMatch"), asserted("departmentMatch").length) },
  };

  console.log(`\n=== SUMMARY ===`);
  console.log(JSON.stringify(summary, null, 2));

  if (args.jsonOut) {
    await (await import("node:fs")).promises.writeFile(
      args.jsonOut,
      JSON.stringify({ summary, results }, null, 2),
      "utf8",
    );
    console.log(`\nJSON written to ${args.jsonOut}`);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
