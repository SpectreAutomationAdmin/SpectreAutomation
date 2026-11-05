// EP-TRAIN-6D-4I — "before" screenshots for the current persisted
// review UI. Capture Q8, Q6, Q3, and a mobile view so the
// acceptance doc can show the exact state the refinement starts
// from. Runs against deployed staging (Fly v1094 / sha-12e18ff76074).

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const OUT = "test-results/ep-train-6d4i/before";

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const creds = stagingCredsAvailable();
test.skip(!creds.ready, "staging credentials missing");

test.describe("EP-TRAIN-6D-4I — BEFORE screenshots", () => {
  test("capture Q8, Q6, Q3, mobile", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await loginAsFounder(context);

    await page.setViewportSize({ width: 1440, height: 900 });

    for (const [label, draftIdSuffix] of [
      ["q8", "q8-parking-policy"],
      ["q6", "q6-phone-call-discretion-back-room"],
      ["q3", "q3-safety-near-miss-reporting"],
    ] as const) {
      const draftId = `draft_hist_6c_${draftIdSuffix}`;
      await page.goto(`${BASE}/app/admin/ai-training/review/persisted?candidate=${draftId}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.getByText("Persisted review", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
      await page.waitForLoadState("load").catch(() => {});
      await page.screenshot({ path: `${OUT}/${label}-before-1440x900.png`, fullPage: false });
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/app/admin/ai-training/review/persisted?candidate=draft_hist_6c_q8-parking-policy`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByText("Persisted review", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("load").catch(() => {});
    await page.screenshot({ path: `${OUT}/mobile-q8-before-390x844.png`, fullPage: false });
  });
});
