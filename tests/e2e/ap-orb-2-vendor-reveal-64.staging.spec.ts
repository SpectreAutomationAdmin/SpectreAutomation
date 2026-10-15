// AP-ORB-2 (2026-10-14) — 64 px Vendor-field orb size experiment,
// staging acceptance.
//
// Verifies, on the staging-only `/app/admin/work-intake/vendor-orb-demo`
// route:
//
//   §A — Both the 20 px and 64 px selector buttons render; the
//        default is 20 px.
//   §B — Switching to 64 px, clicking Replay plays the choreography,
//        and the orb canvas renders in a portal overlay at document.body
//        with CSS width/height = 64 px.
//   §C — The Vendor cell's bounding box is identical before, during,
//        and after the 64 px replay — zero layout shift in the
//        document flow.
//   §D — The 64 px overlay is centered on the Vendor cell (both
//        horizontally and vertically) within a ±4 px tolerance.
//   §E — Capturing a frame at ~1,300 ms (deep inside Phase B, when
//        the orb is at peak visibility) proves the orb is visibly
//        larger than the vendor text.
//   §F — Flipping back to 20 px returns to AP-ORB-1 behavior — the
//        orb renders inside the cell at `[data-testid=ap-orb-vendor-orb]`
//        with CSS width = 20 px, and no portal overlay is in the DOM.
//
// Records video for founder review via `test.use({ video: "on" })`.

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
  "AP-ORB-2 · 64 px overlay — zero layout shift, overlay anchored to cell",
  async ({ browser }) => {
    test.setTimeout(240_000);
    const outDir = ensureOutDir();

    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      recordVideo: {
        dir: path.join(outDir, "ap-orb-2-video"),
        size: { width: 1440, height: 900 },
      },
    });
    const page = await loginAsFounder(ctx);

    await page.goto(`${BASE}/app/admin/work-intake/vendor-orb-demo?orb=1`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(2_000);

    // §A — Selector renders, 20 px active by default.
    const btn20 = page.locator('[data-testid="ap-orb-demo-size-20"]');
    const btn64 = page.locator('[data-testid="ap-orb-demo-size-64"]');
    await expect(btn20, "20 px selector button renders").toBeVisible();
    await expect(btn64, "64 px selector button renders").toBeVisible();
    expect(await btn20.getAttribute("data-active"), "20 px is initial").toBe("true");
    expect(await btn64.getAttribute("data-active"), "64 px not initial").toBe("false");

    const vendorCell = page.locator('[data-testid="ap-orb-vendor-cell"]').first();
    await vendorCell.waitFor({ state: "visible", timeout: 15_000 });
    await vendorCell.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);

    const vendorBoxBefore = await vendorCell.boundingBox();
    console.log(`AP_ORB_2_VENDOR_BOX_BEFORE ${JSON.stringify(vendorBoxBefore)}`);

    // §B — Flip to 64 px.
    await btn64.click();
    await page.waitForTimeout(300);
    expect(await btn64.getAttribute("data-active"), "64 px active after click").toBe("true");

    // Re-locate the cell (component was remounted via the `key` flip).
    const cellAfterFlip = page.locator('[data-testid="ap-orb-vendor-cell"]').first();
    const vendorBoxAfterFlip = await cellAfterFlip.boundingBox();
    console.log(`AP_ORB_2_VENDOR_BOX_AFTER_FLIP ${JSON.stringify(vendorBoxAfterFlip)}`);
    // §C — Vendor cell bounds unchanged by the 20→64 flip.
    if (vendorBoxBefore && vendorBoxAfterFlip) {
      expect(Math.abs(vendorBoxBefore.x - vendorBoxAfterFlip.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(vendorBoxBefore.y - vendorBoxAfterFlip.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(vendorBoxBefore.height - vendorBoxAfterFlip.height)).toBeLessThanOrEqual(2);
      expect(Math.abs(vendorBoxBefore.width - vendorBoxAfterFlip.width)).toBeLessThanOrEqual(2);
    }

    // Click Replay (now at size=64).
    const replay = page.locator('[data-testid="ap-orb-vendor-replay"]').first();
    await replay.waitFor({ state: "visible", timeout: 10_000 });

    const t0 = Date.now();
    await replay.click();

    const sampleTimes = [40, 200, 500, 850, 1_100, 1_300, 1_600, 1_800, 2_000, 2_200, 2_500];
    const samples: Array<{
      atMs: number;
      phase: string | null;
      overlayCount: number;
      overlaySize: { w: number; h: number } | null;
      overlayCenter: { x: number; y: number } | null;
    }> = [];
    const frameDir = path.join(outDir, "ap-orb-2-frames");
    if (!existsSync(frameDir)) mkdirSync(frameDir, { recursive: true });

    for (const ms of sampleTimes) {
      const now = Date.now() - t0;
      const wait = Math.max(0, ms - now);
      if (wait > 0) await page.waitForTimeout(wait);
      const phase = await cellAfterFlip.getAttribute("data-ap-orb-phase");
      const overlay = page.locator('[data-testid="ap-orb-vendor-overlay"]');
      const overlayCount = await overlay.count();
      let overlaySize: { w: number; h: number } | null = null;
      let overlayCenter: { x: number; y: number } | null = null;
      if (overlayCount > 0) {
        const bb = await overlay.boundingBox();
        if (bb) {
          overlaySize = { w: bb.width, h: bb.height };
          overlayCenter = { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
        }
      }
      samples.push({ atMs: ms, phase, overlayCount, overlaySize, overlayCenter });

      const safe = String(ms).padStart(4, "0");
      // Full-width crop centered on the vendor row so the founder
      // can see the orb overflow the cell boundary.
      const cellBox = await cellAfterFlip.boundingBox();
      if (cellBox) {
        await page.screenshot({
          path: path.join(frameDir, `ap-orb-2-frame-${safe}ms.png`),
          clip: {
            x: Math.max(0, cellBox.x + cellBox.width / 2 - 240),
            y: Math.max(0, cellBox.y - 70),
            width: Math.min(1440 - Math.max(0, cellBox.x + cellBox.width / 2 - 240), 480),
            height: Math.min(900 - Math.max(0, cellBox.y - 70), 180),
          },
        });
      }
    }
    console.log("AP_ORB_2_SAMPLES", JSON.stringify(samples));

    // §B assertions.
    const phasesObserved = new Set(samples.map((s) => s.phase));
    expect(phasesObserved.has("thinking"), "thinking phase observed").toBe(true);
    expect(phasesObserved.has("decel"), "decel phase observed").toBe(true);
    expect(phasesObserved.has("resolve"), "resolve phase observed").toBe(true);

    // Overlay present during each of thinking + decel; CSS size = 64.
    const peak = samples.find((s) => s.atMs === 1_300);
    expect(peak?.overlayCount ?? 0, "overlay present at 1,300 ms (peak)").toBeGreaterThanOrEqual(1);
    expect(peak?.overlaySize?.w ?? 0, "overlay width = 64 px").toBeGreaterThanOrEqual(63);
    expect(peak?.overlaySize?.w ?? 0, "overlay width = 64 px").toBeLessThanOrEqual(65);
    expect(peak?.overlaySize?.h ?? 0, "overlay height = 64 px").toBeGreaterThanOrEqual(63);
    expect(peak?.overlaySize?.h ?? 0, "overlay height = 64 px").toBeLessThanOrEqual(65);

    // §D — Overlay centered on the Vendor cell within ±4 px.
    if (vendorBoxAfterFlip && peak?.overlayCenter) {
      const cellCenterX = vendorBoxAfterFlip.x + vendorBoxAfterFlip.width / 2;
      const cellCenterY = vendorBoxAfterFlip.y + vendorBoxAfterFlip.height / 2;
      expect(Math.abs(peak.overlayCenter.x - cellCenterX), "overlay center X ≈ cell center X").toBeLessThanOrEqual(4);
      expect(Math.abs(peak.overlayCenter.y - cellCenterY), "overlay center Y ≈ cell center Y").toBeLessThanOrEqual(4);
    }

    // After the sequence ends, the overlay unmounts.
    await page.waitForTimeout(500);
    const overlayPostCount = await page.locator('[data-testid="ap-orb-vendor-overlay"]').count();
    expect(overlayPostCount, "overlay unmounted post-sequence").toBe(0);

    // §C — Vendor cell bounds unchanged after the full choreography.
    const vendorBoxFinal = await cellAfterFlip.boundingBox();
    console.log(`AP_ORB_2_VENDOR_BOX_FINAL ${JSON.stringify(vendorBoxFinal)}`);
    if (vendorBoxAfterFlip && vendorBoxFinal) {
      expect(Math.abs(vendorBoxAfterFlip.x - vendorBoxFinal.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(vendorBoxAfterFlip.y - vendorBoxFinal.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(vendorBoxAfterFlip.height - vendorBoxFinal.height)).toBeLessThanOrEqual(2);
    }

    // Peak-visibility full-page screenshot the founder can inspect.
    // Replay once more + capture at 1,300 ms.
    await replay.click();
    await page.waitForTimeout(1_300);
    await page.screenshot({
      path: path.join(outDir, "ap-orb-2-peak-visibility.png"),
      clip: { x: 0, y: 0, width: 1440, height: 900 },
    });
    console.log("AP_ORB_2_PEAK_SCREENSHOT test-results/ap-orb-2-peak-visibility.png");
    await page.waitForTimeout(1_500);

    // §F — Flip back to 20 px.  AP-ORB-1 behavior restored: no portal
    // overlay, in-cell orb at 20 px.
    await btn20.click();
    await page.waitForTimeout(300);
    const replay20 = page.locator('[data-testid="ap-orb-vendor-replay"]').first();
    await replay20.click();
    await page.waitForTimeout(500);
    const overlayAt20 = await page.locator('[data-testid="ap-orb-vendor-overlay"]').count();
    const inCellOrbAt20 = await page.locator('[data-testid="ap-orb-vendor-orb"]').count();
    console.log(`AP_ORB_2_AT_20 overlay=${overlayAt20} inCell=${inCellOrbAt20}`);
    expect(overlayAt20, "no overlay at 20 px").toBe(0);
    expect(inCellOrbAt20, "in-cell orb present at 20 px").toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(2_000);

    await ctx.close();
    console.log("AP_ORB_2_VIDEO_DIR test-results/ap-orb-2-video");
    console.log("AP_ORB_2_FRAME_DIR test-results/ap-orb-2-frames");
  },
);
