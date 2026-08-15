#!/usr/bin/env node
// Phase 4R · Phase 7.2N Fix 1 acceptance verification.
// Invokes analyseIngestedInvoice against staging DB for the 3 target
// fixtures. Captures the full reasoning trace WITHOUT persisting.
//
// Requires: STAGING_DATABASE_URL, DIRECT_DATABASE_URL set to staging Neon.
// Read-only — does not overwrite persisted findings.

import pgLib from "pg";
const { Client } = pgLib;
import path from "node:path";
import { pathToFileURL } from "node:url";

// Ensure Prisma reads the staging DATABASE_URL.
if (!process.env.STAGING_DATABASE_URL) throw new Error("STAGING_DATABASE_URL required");
process.env.DATABASE_URL = process.env.STAGING_DATABASE_URL;
process.env.DIRECT_DATABASE_URL = process.env.STAGING_DATABASE_URL;
process.env.NODE_ENV = "test"; // avoid production-only guards

const CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const FIXTURES = [
  { wiId: "cmsmhak530wv7ppa0lrncy9ib", ingestedDocumentId: null, label: "221178.pdf (Club Support)" },
  { wiId: "cmsgpxuyy000711jt094a8uyu", ingestedDocumentId: null, label: "B0037FC.PDF (DMM)" },
  { wiId: "cms6yc9tf02xvyy77w2io64kn", ingestedDocumentId: null, label: "1091559.pdf (Oakcreek)" },
];

// Resolve ingestedDocumentId per WI via direct SQL (avoids prisma init noise).
const c = new Client({ connectionString: process.env.STAGING_DATABASE_URL });
await c.connect();
for (const f of FIXTURES) {
  const r = await c.query(`
    SELECT wio."referenceId" AS doc_id, id.filename
    FROM "WorkIntakeOrigin" wio
    JOIN "IngestedDocument" id ON id.id = wio."referenceId"
    WHERE wio."workIntakeItemId" = $1 AND wio.kind = 'INGESTED_DOCUMENT'
    LIMIT 1
  `, [f.wiId]);
  f.ingestedDocumentId = r.rows[0]?.doc_id;
  f.actualFilename = r.rows[0]?.filename;
}
await c.end();

console.log("=== Fixtures resolved ===");
for (const f of FIXTURES) {
  console.log(`  wi=${f.wiId.slice(-8)} | doc=${f.ingestedDocumentId?.slice(-8)} | file=${f.actualFilename}`);
}

// Dynamically import analyseIngestedInvoice via TS-compiled dist path.
// Prefer tsx runtime.
const { analyseIngestedInvoice } = await import(
  pathToFileURL(path.resolve("src/lib/ap-intelligence/analyse.ts")).href
);

for (const f of FIXTURES) {
  console.log(`\n\n\n========== ${f.label} ==========`);
  if (!f.ingestedDocumentId) {
    console.log("SKIP: no ingested document");
    continue;
  }
  try {
    const t0 = Date.now();
    const result = await analyseIngestedInvoice({
      clubId: CLUB_ID,
      ingestedDocumentId: f.ingestedDocumentId,
    });
    const elapsedMs = Date.now() - t0;
    console.log(`elapsed: ${elapsedMs}ms`);
    console.log(`vendor: ${JSON.stringify(result.vendor)}`);
    console.log(`extraction.total: ${result.extraction?.total} ${result.extraction?.currency}`);
    console.log(`extraction.supplier: ${result.extraction?.vendor?.guessedName}`);
    console.log(`extraction.invoiceNumber: ${result.extraction?.invoiceNumber}`);
    console.log(`purpose: ${JSON.stringify(result.purposeDecision).slice(0, 300)}`);
    console.log(`capital.state: ${result.capital?.state}`);
    console.log(`accountingIntelligence:`, JSON.stringify({
      natureLeader: result.accountingIntelligence?.natureLeader,
      natureConfidence: result.accountingIntelligence?.natureConfidence,
      natureIsDefensible: result.accountingIntelligence?.natureIsDefensible,
    }));
    console.log(`gl.recommendationStatus: ${result.gl?.recommendationStatus}`);
    console.log(`gl.canonicalWinnerAccountNumber: ${result.gl?.canonicalWinnerAccountNumber}`);
    console.log(`gl.canonicalWinnerScore: ${result.gl?.canonicalWinnerScore}`);
    console.log(`gl.canonicalConfidence: ${JSON.stringify(result.gl?.canonicalConfidence)}`);
    console.log(`gl.abstentionReasons: ${JSON.stringify(result.gl?.abstentionReasons)}`);
    const cands = (result.gl?.candidates || []).slice(0, 5);
    console.log(`gl.candidates[0..5]:`);
    for (const cand of cands) {
      console.log(`  ${cand.accountNumber} | ${cand.accountName?.slice(0, 40)} | tier=${cand.tier || "n/a"} | score=${cand.score || cand.confidence} | postable=${cand.postable ?? "?"} | tierReason=${cand.tierReason?.slice(0, 80) || ""}`);
    }
    const alloc = result.allocations?.allocations || [];
    console.log(`allocations (${alloc.length}):`);
    for (const a of alloc) {
      const acct = a.recommendedAccount;
      console.log(`  amount=${a.amount} | account=${acct?.accountNumber} ${acct?.accountName} | reqReview=${acct?.requiresReview} | conf=${acct?.confidence}`);
    }
  } catch (e) {
    console.error(`FAIL: ${e.message}`);
    console.error(e.stack?.split("\n").slice(0, 5).join("\n"));
  }
}

process.exit(0);
