// AP-MOTION-1 — staging acceptance of the isolated AP Review
// motion prototype.  Walks the 6 scenes end-to-end using the
// playback controls, capturing a screenshot per scene so the
// founder has a frame-by-frame visual record of the sequence.
//
// Isolation checks:
//   - URL ends with `/review-prototype` (NOT the production
//     review path).
//   - `data-testid="ap-motion-prototype"` is present.
//   - No `data-testid="wi-review-root"` on the page — the shell
//     is prototype-only.

import { test } from "@playwright/test";
import { expect } from "@playwright/test";
import path from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

function ensureOutDir(): string {
  const outDir = path.join("test-results");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  return outDir;
}

runAt(
  "AP-MOTION-1 · prototype 6-scene playback + per-scene screenshots",
  async ({ browser }) => {
    test.setTimeout(600_000);
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx);
    const outDir = ensureOutDir();

    await page.goto(`${BASE}/app/admin/work-intake/review-prototype`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(2_000);

    const root = page.locator('[data-testid="ap-motion-prototype"]').first();
    await expect(root).toBeVisible();

    // Scene index starts at 1 (scene-1-received).  Walk through
    // each scene by clicking the dot indicator, capturing both
    // the current data-scene attribute AND a screenshot.
    const sceneKeys = [
      "scene-1-received",
      "scene-2-extraction",
      "scene-3-classification",
      "scene-4-exception",
      "scene-5-intervention",
      "scene-6-resolution",
    ];
    for (let i = 0; i < sceneKeys.length; i++) {
      const dot = page.locator(`[data-testid="ap-motion-dot-${i + 1}"]`).first();
      await dot.click();
      await page.waitForTimeout(650);
      const sceneAttr = await root.getAttribute("data-scene");
      console.log(`AP_MOTION_1_SCENE_${i + 1} ${sceneAttr}`);
      expect(sceneAttr).toBe(sceneKeys[i]);

      // On scene 4 the vendor field must be in attention state.
      if (sceneKeys[i] === "scene-4-exception") {
        const vendorField = page.locator('[data-field="vendor"]').first();
        const vendorClasses = await vendorField.getAttribute("class");
        expect(vendorClasses).toMatch(/ap-motion-field--attention/);
      }
      // On scene 6 the vendor field must be resolved.
      if (sceneKeys[i] === "scene-6-resolution") {
        const vendorField = page.locator('[data-field="vendor"]').first();
        const vendorClasses = await vendorField.getAttribute("class");
        expect(vendorClasses).toMatch(/ap-motion-field--resolved/);
      }

      await page.screenshot({
        path: path.join(outDir, `ap-motion-1-scene-${i + 1}.png`),
        clip: { x: 0, y: 0, width: 1440, height: 900 },
      });
      console.log(`AP_MOTION_1_SCREENSHOT scene-${i + 1} test-results/ap-motion-1-scene-${i + 1}.png`);
    }

    // Vendor-match popover opens on scene 5 and resolves to scene 6.
    const dot5 = page.locator('[data-testid="ap-motion-dot-5"]').first();
    await dot5.click();
    await page.waitForTimeout(400);
    const matchBtn = page.locator('[data-testid="ap-motion-match-vendor-btn"]').first();
    await expect(matchBtn).toBeVisible();
    await matchBtn.click();
    const popover = page.locator('[data-testid="ap-motion-popover"]').first();
    await expect(popover).toBeVisible();
    // Click the first candidate — advances scene to resolution.
    await popover.locator("button.ap-motion-popover-item").first().click();
    await page.waitForTimeout(800);
    const finalScene = await root.getAttribute("data-scene");
    console.log(`AP_MOTION_1_POPOVER_RESOLVED ${finalScene}`);
    expect(finalScene).toBe("scene-6-resolution");

    // Isolation guard — production review-root is NOT on this page.
    const prodRoot = page.locator('[data-testid="wi-review-root"]').first();
    const prodCount = await prodRoot.count();
    console.log(`AP_MOTION_1_PROD_ROOT_PRESENT ${prodCount}`);
    expect(prodCount).toBe(0);

    await ctx.close();
  },
);
