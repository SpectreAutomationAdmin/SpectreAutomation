// AP-ORB-3 (2026-10-15) — Orb Fidelity Lab staging acceptance.
//
// This spec captures:
//   §A Browser recording of the Spectre fidelity lab (light + dark
//      variants rendering continuously).
//   §B Element-scoped screenshots of each 64 x 64 orb at two
//      asynchronous moments to prove the canvas is actually
//      animating (two frames should differ by at least a few
//      pixels; identical canvases would mean the clock is frozen).
//   §C Reference recording of libraries.dev/orbs so the founder
//      can place the two side by side.
//   §D Measures the actual rendered canvas CSS width + device
//      pixel ratio to confirm the orb renders at native 64 px.
//
// Per directive §5: do not declare visual parity merely because
// props match — the user compares the recordings themselves.
// This spec gathers the evidence; the founder is the acceptance
// authority.

import { test } from "@playwright/test";
import { expect } from "@playwright/test";
import path from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

test.use({ video: "on" });

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

function ensureOutDir(): string {
  const outDir = path.join("test-results");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  return outDir;
}

runAt(
  "AP-ORB-3 · Spectre fidelity lab — direct ThinkingOrb render, both tunings",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const outDir = ensureOutDir();
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      recordVideo: {
        dir: path.join(outDir, "ap-orb-3-spectre-video"),
        size: { width: 1440, height: 900 },
      },
    });
    const page = await loginAsFounder(ctx);
    await page.goto(`${BASE}/app/admin/work-intake/orb-fidelity-lab`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(2_500);

    const lightStage = page.locator('[data-testid="orb-fidelity-stage-light"]');
    const darkStage = page.locator('[data-testid="orb-fidelity-stage-dark"]');
    await expect(lightStage, "light stage mounts").toBeVisible();
    await expect(darkStage, "dark stage mounts").toBeVisible();

    // §D — Canvas native dimensions + DPR.
    const lightMeta = await page.evaluate(() => {
      const stage = document.querySelector('[data-testid="orb-fidelity-stage-light"]');
      const canvas = stage?.querySelector("canvas") as HTMLCanvasElement | null;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      return {
        cssWidth: rect.width,
        cssHeight: rect.height,
        bufferWidth: canvas.width,
        bufferHeight: canvas.height,
        dpr: window.devicePixelRatio,
      };
    });
    const darkMeta = await page.evaluate(() => {
      const stage = document.querySelector('[data-testid="orb-fidelity-stage-dark"]');
      const canvas = stage?.querySelector("canvas") as HTMLCanvasElement | null;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      return {
        cssWidth: rect.width,
        cssHeight: rect.height,
        bufferWidth: canvas.width,
        bufferHeight: canvas.height,
        dpr: window.devicePixelRatio,
      };
    });
    console.log("AP_ORB_3_LIGHT_META", JSON.stringify(lightMeta));
    console.log("AP_ORB_3_DARK_META", JSON.stringify(darkMeta));
    expect(lightMeta?.cssWidth, "light orb CSS width = 64 px").toBeGreaterThanOrEqual(63);
    expect(lightMeta?.cssWidth, "light orb CSS width = 64 px").toBeLessThanOrEqual(65);
    expect(darkMeta?.cssWidth, "dark orb CSS width = 64 px").toBeGreaterThanOrEqual(63);
    expect(darkMeta?.cssWidth, "dark orb CSS width = 64 px").toBeLessThanOrEqual(65);

    // §B — Prove the canvas is actually animating.  Grab a canvas-
    // data-URL hash at two moments ~600 ms apart; the hashes must
    // differ.
    const sampleHash = async (which: "light" | "dark") => {
      return await page.evaluate((w) => {
        const stage = document.querySelector(`[data-testid="orb-fidelity-stage-${w}"]`);
        const canvas = stage?.querySelector("canvas") as HTMLCanvasElement | null;
        if (!canvas) return null;
        // dataURL to tiny thumbnail to keep the hash cheap.
        const t = document.createElement("canvas");
        t.width = 16;
        t.height = 16;
        const ctx = t.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(canvas, 0, 0, 16, 16);
        return t.toDataURL("image/png");
      }, which);
    };
    const lightA = await sampleHash("light");
    const darkA = await sampleHash("dark");
    await page.waitForTimeout(650);
    const lightB = await sampleHash("light");
    const darkB = await sampleHash("dark");
    console.log(
      `AP_ORB_3_ANIM lightChanged=${lightA !== lightB} darkChanged=${darkA !== darkB}`,
    );
    expect(lightA, "light canvas sample A").toBeTruthy();
    expect(darkA, "dark canvas sample A").toBeTruthy();
    expect(lightA !== lightB, "light canvas is animating (frame A != frame B)").toBe(true);
    expect(darkA !== darkB, "dark canvas is animating (frame A != frame B)").toBe(true);

    // Element-scoped frame captures — two frames, ~500 ms apart.
    const frameDir = path.join(outDir, "ap-orb-3-frames");
    if (!existsSync(frameDir)) mkdirSync(frameDir, { recursive: true });
    await lightStage.screenshot({ path: path.join(frameDir, "spectre-light-frame-A.png") });
    await darkStage.screenshot({ path: path.join(frameDir, "spectre-dark-frame-A.png") });
    await page.waitForTimeout(500);
    await lightStage.screenshot({ path: path.join(frameDir, "spectre-light-frame-B.png") });
    await darkStage.screenshot({ path: path.join(frameDir, "spectre-dark-frame-B.png") });

    // Full lab screenshot.
    await page.screenshot({
      path: path.join(outDir, "ap-orb-3-lab-fullpage.png"),
      fullPage: false,
      clip: { x: 0, y: 0, width: 1440, height: 900 },
    });
    console.log("AP_ORB_3_LAB_SCREENSHOT test-results/ap-orb-3-lab-fullpage.png");

    // Keep the context recording a couple more seconds of the
    // continuous animation.
    await page.waitForTimeout(3_000);
    await ctx.close();
    console.log("AP_ORB_3_SPECTRE_VIDEO_DIR test-results/ap-orb-3-spectre-video");
    console.log("AP_ORB_3_FRAME_DIR test-results/ap-orb-3-frames");
  },
);

test(
  "AP-ORB-3 · Libraries.dev reference capture — browser recording",
  async ({ browser }) => {
    test.setTimeout(180_000);
    const outDir = ensureOutDir();
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      recordVideo: {
        dir: path.join(outDir, "ap-orb-3-reference-video"),
        size: { width: 1440, height: 900 },
      },
    });
    const page = await ctx.newPage();
    try {
      await page.goto("https://libraries.dev/orbs", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
    } catch (e) {
      console.log("AP_ORB_3_REFERENCE_FETCH_ERROR", (e as Error).message);
      await ctx.close();
      return;
    }
    await page.waitForTimeout(3_500);

    // Capture the full reference page.
    await page.screenshot({
      path: path.join(outDir, "ap-orb-3-reference-fullpage.png"),
      fullPage: true,
    });
    console.log("AP_ORB_3_REFERENCE_SCREENSHOT test-results/ap-orb-3-reference-fullpage.png");

    // Count canvases on the reference — a smoke that the demo loaded.
    const canvasCount = await page.evaluate(() => document.querySelectorAll("canvas").length);
    console.log(`AP_ORB_3_REFERENCE_CANVAS_COUNT ${canvasCount}`);

    // Linger for the recording.
    await page.waitForTimeout(5_000);
    await ctx.close();
    console.log("AP_ORB_3_REFERENCE_VIDEO_DIR test-results/ap-orb-3-reference-video");
  },
);
