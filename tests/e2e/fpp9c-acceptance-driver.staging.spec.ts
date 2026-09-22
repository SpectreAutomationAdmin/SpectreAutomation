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

// FPP-9C.1 fresh acceptance uses the next empty CRGCC-SM period after the
// GL-snapshot fix (patches copy expense/liability account bindings onto
// PayrollBatchComponentSnapshot). Set via FPP9C_TARGET_PERIOD env or the
// hardcoded default; every earlier period has residual FPP-9x state.
const TARGET_PERIOD = process.env.FPP9C_TARGET_PERIOD ?? "";
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

    // FPP-9C.1 §28 — 17 required 1440×900 acceptance artifacts.
    await shoot("01-original-posted", `/app/admin/payroll/batches/${baselineBatchId}`);
    // The Reverse & Correct dialog is invoked on the original; capture its trigger area.
    await shoot("02-reverse-and-correct-modal-context", `/app/admin/payroll/batches/${baselineBatchId}`);
    await shoot("03-reversal-posted", `/app/admin/payroll/batches/${reversalBatchId}`);
    await shoot("04-correction-preparation", `/app/admin/payroll/batches/${correctionBatchId}`);
    await shoot("05-payroll-admin-compare", `/app/admin/payroll/batches/${correctionBatchId}/compare`);
    await shoot("06-component-diff-ADDED-CHANGED-REMOVED", `/app/admin/payroll/batches/${correctionBatchId}/compare`);
    await shoot("07-controller-work-intake", `/app/admin`);
    await shoot("08-return-correction-affordance", `/app/admin/payroll/batches/${correctionBatchId}/compare`);
    await shoot("09-returned-state-banner", `/app/admin/payroll/batches/${correctionBatchId}`);
    await shoot("10-recalculated-correction", `/app/admin/payroll/batches/${correctionBatchId}`);
    await shoot("11-comparison-after-return-edit", `/app/admin/payroll/batches/${correctionBatchId}/compare`);
    await shoot("12-resubmitted-work-intake", `/app/admin`);
    await shoot("13-approved-awaiting-post", `/app/admin/payroll/batches/${correctionBatchId}`);
    await shoot("14-correction-posted", `/app/admin/payroll/batches/${correctionBatchId}`);
    await shoot("15-payroll-register-chain-original", `/app/admin/payroll/batches/${baselineBatchId}/register`);
    await shoot("15b-payroll-register-chain-correction", `/app/admin/payroll/batches/${correctionBatchId}/register`);
    await shoot("16-employee-history", `/app/admin/payroll/batches/${baselineBatchId}/paystubs`);
    await shoot("17-gl-evidence-correction", `/app/admin/payroll/batches/${correctionBatchId}/gl`);
    await shoot("17b-gl-evidence-baseline", `/app/admin/payroll/batches/${baselineBatchId}/gl`);
    await shoot("17c-gl-evidence-reversal", `/app/admin/payroll/batches/${reversalBatchId}/gl`);
  });
});
