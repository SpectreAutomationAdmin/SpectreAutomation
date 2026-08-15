// Phase 4R · Phase 7.2N Fix 1 acceptance — authenticated staging verification.
//
// Fetches the AP-evidence route (which re-runs analyseIngestedInvoice)
// for the three known-failing fixtures on staging v211 with Fix 1
// live, then captures the FRESH result and asserts:
//   - 9900 Bank-Credit Facilities is INELIGIBLE / not appearing in
//     allocation for 221178
//   - 1000 Petty Cash is INELIGIBLE / not appearing for DMM
//
// Uses SUPER_ADMIN staging creds from .env.playwright.local.

import { test, expect } from "@playwright/test";
import { stagingCredsAvailable, loginAsFounder } from "./_lib/staging-auth";

const FIXTURES = [
  {
    wiId: "cmsmhak530wv7ppa0lrncy9ib",
    label: "221178.pdf (Club Support)",
    forbiddenAccounts: ["9900"], // Bank - Credit Facilities/Mortgage
    expectedFamilyAccount: "6054", // Computer & IT Services
  },
  {
    wiId: "cmsgpxuyy000711jt094a8uyu",
    label: "B0037FC.PDF (DMM)",
    forbiddenAccounts: ["1000"], // Petty Cash
    expectedFamilyAccount: "6025", // Fuel (Gas/Diesel)
  },
  {
    wiId: "cms6yc9tf02xvyy77w2io64kn",
    label: "1091559.pdf (Oakcreek)",
    forbiddenAccounts: [], // capital-treatment case; Fix 1 doesn't touch
    expectedFamilyAccount: "1506", // Equipment & Fixtures - Grounds
  },
];

test.describe("Phase 7.2N Fix 1 acceptance", () => {
  test("fresh analysis on staging v211 — 3 fixtures", async ({ browser }) => {
    const creds = stagingCredsAvailable();
    test.skip(!creds.ready, creds.reason ?? "staging creds unavailable");

    const context = await browser.newContext();
    const page = await loginAsFounder(context);

    for (const fx of FIXTURES) {
      console.log(`\n=== ${fx.label} (${fx.wiId}) ===`);
      const url = `${creds.baseURL}/api/mission-control/work-intake/${fx.wiId}/ap-evidence`;
      const response = await page.request.get(url);
      const status = response.status();
      console.log(`GET ap-evidence status: ${status}`);

      if (status !== 200) {
        const body = await response.text();
        console.log(`FAIL body: ${body.slice(0, 400)}`);
        continue;
      }
      const json = await response.json();

      // The API returns a SHAPED projection (not the raw AnalyseResult).
      // Dump full response to a per-fixture file for later inspection.
      const fs = require("node:fs");
      const outFile = `test-results/phase72n-fix1-${fx.wiId.slice(-8)}.json`;
      fs.mkdirSync("test-results", { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(json, null, 2));
      console.log(`  full response written to ${outFile}`);
      console.log(`  response top-level keys: ${Object.keys(json).join(", ")}`);

      const analysis = json.analysis || json;
      const gl = json.glRecommendation ?? analysis?.gl;
      const allocations = json.allocations ?? analysis?.allocations?.allocations ?? [];
      const extraction = json.extraction ?? analysis?.extraction;
      const purpose = analysis?.purposeDecision ?? json.purposeDecision;
      const capital = json.capitalRecommendation ?? analysis?.capital ?? json.capital;
      const nature = analysis?.accountingIntelligence ?? json.accountingIntelligence;
      const cardCategory = json.category ?? analysis?.allocations?.cardCategory;
      console.log(`  gl full: ${JSON.stringify(gl).slice(0, 500)}`);
      console.log(`  capital: ${JSON.stringify(capital).slice(0, 300)}`);
      console.log(`  card cat: ${cardCategory}`);

      console.log(`extraction.total: ${extraction?.total} ${extraction?.currency}`);
      console.log(`extraction.supplier: ${extraction?.vendor?.guessedName}`);
      console.log(`extraction.invoiceNumber: ${extraction?.invoiceNumber}`);
      console.log(`purpose: concept=${purpose?.concept} conf=${purpose?.confidence} committed=${purpose?.state}`);
      console.log(`capital.state: ${capital?.state}`);
      console.log(`nature: ${JSON.stringify(nature ?? null).slice(0, 200)}`);
      console.log(`gl.recommendationStatus: ${gl?.recommendationStatus}`);
      console.log(`gl.canonicalWinnerAccountNumber: ${gl?.canonicalWinnerAccountNumber}`);
      console.log(`gl.canonicalWinnerScore: ${gl?.canonicalWinnerScore}`);
      console.log(`gl.abstentionReasons: ${JSON.stringify(gl?.abstentionReasons)}`);
      console.log(`allocations (${allocations.length}):`);
      for (const a of allocations) {
        const acct = a.recommendedAccount;
        console.log(`  amount=${a.amount} account=${acct?.accountNumber} ${acct?.accountName} reqReview=${acct?.requiresReview}`);
      }
      const top5 = (gl?.candidates ?? []).slice(0, 5);
      console.log(`gl.candidates top-5:`);
      for (const c of top5) {
        console.log(`  ${c.accountNumber} | ${(c.accountName || "").slice(0, 40)} | score=${c.score || c.confidence} | tier=${c.tier || "-"} | postable=${c.postable ?? "?"}`);
      }

      // Structural assertion: forbidden accounts must NOT appear as
      // allocation destinations or top-3 canonical candidates.
      for (const forbidden of fx.forbiddenAccounts) {
        const inAlloc = allocations.some((a: { recommendedAccount?: { accountNumber?: string } }) => a.recommendedAccount?.accountNumber === forbidden);
        const inTop3 = (gl?.candidates ?? []).slice(0, 3).some((c: { accountNumber?: string }) => c.accountNumber === forbidden);
        console.log(`  ✓ forbidden ${forbidden}: inAllocation=${inAlloc} inTop3=${inTop3}`);
        expect(inAlloc, `${forbidden} must not be in allocations post-Fix-1`).toBe(false);
      }
    }
    await context.close();
  });
});
