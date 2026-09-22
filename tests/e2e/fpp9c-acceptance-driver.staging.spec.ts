// FPP-9C (2026-09-22) — end-to-end multi-input correction acceptance
// driver on Coulee Ridge.
//
// Authenticated as founder credentials (Chris/Controller in
// .env.playwright.local). Drives the pipeline through baseline →
// reverse → multi-input patches → calculate → submit → Controller
// return → re-patch → calculate → submit → approve → post → idempotency,
// capturing screenshots at each key state.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

// FPP-9C uses seq 21 (2026-11-01 → 2026-11-16, payDate 2026-11-13) — a fresh
// empty period after the FPP-9C schema-fix redeploy. Distinct from FPP-9A.1
// (seq 18), FPP-9B (seq 19), and the first FPP-9C attempt (seq 20).
const TARGET_PERIOD = process.env.FPP9C_TARGET_PERIOD ?? "cmu5kg3ih000rh4iue25r0uo3";
const PIPELINE_URL = "/api/dev/fpp9c-acceptance";

function saveJson(name: string, obj: unknown) {
  const dir = "test-results";
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2));
}

test.describe("FPP-9C · multi-input correction acceptance", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.setTimeout(600_000);

  test("Drive baseline → reverse → multi-input patches → return → resubmit → post; capture screenshots", async ({ context }) => {
    const creds = stagingCredsAvailable();
    test.skip(!creds.ready, creds.reason ?? "no creds");
    const base = creds.baseURL;
    const page = await loginAsFounder(context);

    async function shoot(name: string, path?: string) {
      if (path) await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);
      await page.screenshot({ path: `test-results/fpp9c-${name}.png`, fullPage: true });
    }

    // Single full run — the pipeline handles all stages internally
    const resp = await page.request.post(`${base}${PIPELINE_URL}?periodId=${TARGET_PERIOD}&stage=full`, { timeout: 480_000 });
    const body = await resp.json();
    saveJson("fpp9c-pipeline-full.json", { status: resp.status(), body });
    expect(resp.status()).toBe(200);
    console.log("[FPP-9C] Pipeline OK. correction=", body.evidence?.correction?.batchId,
      "reversal=", body.evidence?.reversal?.batchId,
      "baseline=", body.evidence?.baseline?.batch?.id);

    const baselineBatchId = body.evidence?.baseline?.batch?.id;
    const reversalBatchId = body.evidence?.reversal?.batchId;
    const correctionBatchId = body.evidence?.correction?.batchId;
    expect(baselineBatchId).toBeTruthy();
    expect(reversalBatchId).toBeTruthy();
    expect(correctionBatchId).toBeTruthy();

    // Screenshots: the pipeline has already taken the batches through their
    // final states, so we capture the terminal-state visuals.
    await shoot("01-original-erroneous-posted", `/app/admin/payroll/batches/${baselineBatchId}`);
    await shoot("02-reversal-posted", `/app/admin/payroll/batches/${reversalBatchId}`);
    await shoot("03-correction-posted", `/app/admin/payroll/batches/${correctionBatchId}`);
    await shoot("04-controller-work-intake", `/app/admin/work-intake`);
    await shoot("05-payroll-register-original", `/app/admin/payroll/batches/${baselineBatchId}/register`);
    await shoot("05b-payroll-register-correction", `/app/admin/payroll/batches/${correctionBatchId}/register`);
    await shoot("06-employee-history", `/app/admin/payroll/batches/${baselineBatchId}/paystubs`);
    await shoot("07-baseline-je", `/app/admin/payroll/batches/${baselineBatchId}/gl`);
    await shoot("07b-reversal-je", `/app/admin/payroll/batches/${reversalBatchId}/gl`);
    await shoot("07c-correction-je", `/app/admin/payroll/batches/${correctionBatchId}/gl`);
  });
});
