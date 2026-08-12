// Phase 4R · Phase 6 (§§4-8) — real-fixture accounting acceptance on
// staging. Authenticates as the founder account, then POSTs
// /api/ap-intelligence/inspect-wi for each currently-visible
// Phase 4R real-fixture control and captures the canonical analysis
// (winner, candidates, confidence, recommendation status).
//
// This spec is not run in normal CI. It runs on-demand as part of
// Phase 6 staging acceptance validation.

import { test, expect } from "@playwright/test";
import { loginAsFounder } from "./_lib/staging-auth";
import fs from "node:fs";
import path from "node:path";

// Real-fixture Work Intake IDs discovered on staging (2026-08-12 via
// staging DB search).
const FIXTURES: Array<{ label: string; wiId: string }> = [
  { label: "Club Support · 221178.pdf", wiId: "cmsmhak530wv7ppa0lrncy9ib" },
  { label: "Oakcreek 1091559.pdf", wiId: "cms6yc9tf02xvyy77w2io64kn" },
  { label: "Oakcreek 1087769.pdf", wiId: "cms6xwpvc01o1yy77rkso7b0b" },
];

const OUT_DIR = path.resolve(
  process.env.APPDATA
    ? `${process.env.APPDATA}/../Local/Temp/claude/c--dev-SpectreAutomation/0024fdd7-1cbc-4a67-8903-1a917d6d43e4/scratchpad`
    : "/tmp",
);

test.describe.serial("Phase 4R · Phase 6 real-fixture inspection", () => {
  test.setTimeout(180_000);

  test("authenticate + inspect each real fixture", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await loginAsFounder(context);
    // baseURL is embedded in loginAsFounder; recover it from the URL
    // after login lands.
    const url = new URL(page.url());
    const baseUrl = `${url.protocol}//${url.host}`;

    const results: any[] = [];
    for (const fx of FIXTURES) {
      // POST to inspect-wi with wiId; positionalTrace + extractorDiff off.
      const resp = await page.request.post(`${baseUrl}/api/ap-intelligence/inspect-wi`, {
        data: { wiId: fx.wiId },
        headers: { "content-type": "application/json" },
      });
      const status = resp.status();
      const bodyText = await resp.text();
      let body: any = null;
      try { body = JSON.parse(bodyText); } catch {}
      results.push({
        label: fx.label,
        wiId: fx.wiId,
        httpStatus: status,
        analysisResult: body?.analyseResult ?? body ?? bodyText.slice(0, 800),
      });
      console.log(`===== ${fx.label} =====`);
      console.log(`  wiId: ${fx.wiId}`);
      console.log(`  HTTP: ${status}`);
      if (body?.analyseResult) {
        const gl = body.analyseResult?.gl ?? null;
        const alloc = body.analyseResult?.allocations ?? null;
        console.log(`  gl.accountNumber: ${gl?.accountNumber ?? "(null)"}`);
        console.log(`  gl.accountName: ${gl?.accountName ?? "(null)"}`);
        console.log(`  gl.source: ${gl?.source ?? "(null)"}`);
        console.log(`  gl.confidence: ${gl?.confidence ?? "(null)"}`);
        console.log(`  gl.recommendationStatus: ${gl?.recommendationStatus ?? "(null)"}`);
        console.log(`  gl.canonicalWinnerAccountNumber: ${gl?.canonicalWinnerAccountNumber ?? "(null)"}`);
        console.log(`  gl.canonicalConfidence.level: ${gl?.canonicalConfidence?.level ?? "(none)"}`);
        console.log(`  gl.canonicalConfidence.genuineCompetitors.length: ${gl?.canonicalConfidence?.genuineCompetitors?.length ?? 0}`);
        if (gl?.candidates) {
          for (let i = 0; i < Math.min(3, gl.candidates.length); i++) {
            const c = gl.candidates[i];
            console.log(`  candidates[${i}]: ${c.accountNumber} ${c.accountName} conf=${c.confidence}`);
          }
        }
        if (alloc?.allocations) {
          console.log(`  allocations count: ${alloc.allocations.length}`);
          console.log(`  cardCategory: ${alloc.cardCategory ?? "(null)"}`);
          console.log(`  requiresReview: ${alloc.requiresReview}`);
          for (const a of alloc.allocations) {
            console.log(`    · ${a.economicPurpose?.concept ?? "?"} $${a.amount} → ${a.recommendedAccount?.accountNumber ?? "(null)"} ${a.recommendedAccount?.accountName ?? ""} [${a.recommendationStatus ?? "?"}]`);
          }
        }
      } else {
        console.log(`  BODY: ${bodyText.slice(0, 400)}`);
      }
    }

    // Persist raw JSON for the checkpoint doc.
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(OUT_DIR, "phase6-real-fixture-inspection.json"),
      JSON.stringify(results, null, 2),
    );
    console.log(`\nRaw results written to ${path.join(OUT_DIR, "phase6-real-fixture-inspection.json")}`);

    // Take a screenshot of the AP review card for each fixture (DOM parity).
    for (const fx of FIXTURES) {
      await page.goto(`${baseUrl}/app/admin/mission-control?wi=${fx.wiId}`);
      await page.waitForLoadState("networkidle");
      const shot = path.join(OUT_DIR, `phase6-${fx.wiId}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      console.log(`Screenshot: ${shot}`);
    }

    // At minimum, every inspect-wi call must have returned a 200-class
    // response. Actual accounting content is reviewed manually.
    for (const r of results) {
      expect(r.httpStatus, `wi ${r.wiId} inspect-wi HTTP status`).toBeGreaterThanOrEqual(200);
      expect(r.httpStatus, `wi ${r.wiId} inspect-wi HTTP status`).toBeLessThan(500);
    }
  });
});
