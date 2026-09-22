// FPP-9B (2026-09-22) — end-to-end staging acceptance driver.
//
// Authenticated as Chris Turcato (Controller on Coulee Ridge — the founder's
// credentials in .env.playwright.local). Drives the FPP-9B Reverse & Correct
// acceptance pipeline through all six stages, capturing a screenshot at each
// milestone.
//
// Requires a fresh empty pay period on CRGCC-SM. Set FPP9B_TARGET_PERIOD env
// var, or accept the default (the first empty period after Marc joined
// CRGCC-SM AND after the FPP-9A.1 accepted period).

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

// Target period: FPP-9B uses a DIFFERENT empty period from FPP-9A.1
// (which used cmu5kg3ih000oh4iuxssahldd = seq 18). FPP-9B claims seq 19.
const TARGET_PERIOD = process.env.FPP9B_TARGET_PERIOD ?? "cmu5kg3ih000ph4iuo5w9o34w"; // seq 19, 2026-10-01→2026-10-16
const PIPELINE_URL = "/api/dev/fpp9b-acceptance";

function saveJson(name: string, obj: unknown) {
  const dir = "test-results";
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2));
}

test.describe("FPP-9B · Coulee Ridge Reverse & Correct acceptance", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.setTimeout(600_000);

  test("Drive baseline-error → initiate → post-reversal → patch → calc → post-correction; capture screenshots", async ({ context }) => {
    const creds = stagingCredsAvailable();
    test.skip(!creds.ready, creds.reason ?? "no creds");
    const base = creds.baseURL;

    const page = await loginAsFounder(context);

    async function callPipeline(stage: string) {
      const resp = await page.request.post(`${base}${PIPELINE_URL}?periodId=${TARGET_PERIOD}&stage=${stage}`);
      const status = resp.status();
      let body: any;
      try { body = await resp.json(); } catch { body = { rawText: await resp.text() }; }
      saveJson(`fpp9b-pipeline-${stage}.json`, { status, body });
      if (!resp.ok()) {
        console.log(`[FPP-9B] Pipeline ${stage} FAILED: status=${status}`, JSON.stringify(body, null, 2).slice(0, 2000));
      } else {
        console.log(`[FPP-9B] Pipeline ${stage} OK: stoppedAtStage=${body.stoppedAtStage ?? "full"}`);
      }
      return { status, body };
    }

    async function shoot(name: string, path?: string) {
      if (path) await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `test-results/fpp9b-${name}.png`, fullPage: true });
    }

    // ── STAGE 1: baseline-error — create the intentionally-wrong POSTED baseline
    const s1 = await callPipeline("baseline-error");
    expect(s1.status).toBe(200);
    const baselineBatchId = s1.body?.evidence?.baseline?.batch?.id
      ?? s1.body?.evidence?.guards?.existingBaseline?.id ?? null;
    console.log(`[FPP-9B] baselineBatchId = ${baselineBatchId}`);
    expect(baselineBatchId).toBeTruthy();

    await shoot("01-original-erroneous-posted", `/app/admin/payroll/batches/${baselineBatchId}`);
    // Try to open the Reverse & Correct modal
    const rcButton = page.locator('[data-testid="payroll-admin-reverse-and-correct"]').first();
    if (await rcButton.isVisible().catch(() => false)) {
      await rcButton.click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: "test-results/fpp9b-02-reverse-and-correct-modal.png", fullPage: false });
      await page.locator('[data-testid="payroll-admin-correct-cancel"]').click().catch(() => {});
      await page.waitForTimeout(300);
    }

    // ── STAGE 2: initiate — creates reversal + correction pair
    const s2 = await callPipeline("initiate");
    expect(s2.status).toBe(200);
    const reversalBatchId = s2.body?.evidence?.reversal?.batchId;
    const correctionBatchId = s2.body?.evidence?.correction?.batchId;
    expect(reversalBatchId).toBeTruthy();
    expect(correctionBatchId).toBeTruthy();
    console.log(`[FPP-9B] reversalBatchId=${reversalBatchId} correctionBatchId=${correctionBatchId}`);

    await shoot("03-reversal-submitted-awaiting-controller", `/app/admin/payroll/batches/${reversalBatchId}`);
    await shoot("04-controller-reversal-work-intake", `/app/admin/work-intake`);

    // ── STAGE 3: post-reversal — approve + post the reversal
    const s3 = await callPipeline("post-reversal");
    expect(s3.status).toBe(200);
    await shoot("05-reversal-posted", `/app/admin/payroll/batches/${reversalBatchId}`);

    // ── STAGE 4: patch-correction — apply the salary bump on the correction
    const s4 = await callPipeline("patch-correction");
    expect(s4.status).toBe(200);
    await shoot("06-correction-preparation-after-patch", `/app/admin/payroll/batches/${correctionBatchId}`);

    // ── STAGE 5: calc-correction — recalc with new input
    const s5 = await callPipeline("calc-correction");
    expect(s5.status).toBe(200);
    await shoot("07-correction-calculated-comparison", `/app/admin/payroll/batches/${correctionBatchId}`);

    // ── STAGE 6: post-correction — submit + approve + post + idempotency (via full)
    const s6 = await callPipeline("full");
    expect(s6.status).toBe(200);
    await shoot("08-controller-correction-work-intake", `/app/admin/work-intake`);
    await shoot("09-correction-approved-awaiting-post", `/app/admin/payroll/batches/${correctionBatchId}`);
    await shoot("10-correction-posted", `/app/admin/payroll/batches/${correctionBatchId}`);

    // Register + history + GL
    await shoot("11-payroll-register-original", `/app/admin/payroll/batches/${baselineBatchId}/register`);
    await shoot("11b-payroll-register-correction", `/app/admin/payroll/batches/${correctionBatchId}/register`);
    await shoot("12-employee-payroll-history", `/app/admin/payroll/batches/${baselineBatchId}/paystubs`);
    await shoot("13-baseline-je", `/app/admin/payroll/batches/${baselineBatchId}/gl`);
    await shoot("13b-reversal-je", `/app/admin/payroll/batches/${reversalBatchId}/gl`);
    await shoot("13c-correction-je", `/app/admin/payroll/batches/${correctionBatchId}/gl`);

    saveJson("fpp9b-final-evidence.json", {
      baselineBatchId, reversalBatchId, correctionBatchId,
      fullStage: s6.body,
    });
    console.log(`[FPP-9B] Final evidence saved to test-results/fpp9b-final-evidence.json`);
  });
});
