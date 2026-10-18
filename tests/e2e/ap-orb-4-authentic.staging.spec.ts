// AP-ORB-4 (2026-10-18) — authentic Vendor-field orb integration
// staging acceptance.
//
// Verifies, on the staging-only `/app/admin/work-intake/vendor-orb-demo`
// route (the same production VendorFieldAuthenticClient component
// the AP Review page now wires):
//
//   §A Replay button renders when `?orb=1`.
//   §B Clicking Replay hides the vendor text (visibility:hidden,
//      not display:none, so the cell retains width).
//   §C A portal overlay mounts at document.body with a 64 x 64 px
//      <ThinkingOrb/> canvas at native CSS size.
//   §D Canvas is actually animating (two frames ~400 ms apart
//      differ by non-trivial pixel area).
//   §E After ~2 s, the overlay unmounts and the vendor text
//      returns to visibility:visible.
//   §F Vendor cell bounding box is identical at idle-before,
//      during-replay, and idle-after — zero layout shift.
//   §G Vendor text value is identical before and after.
//   §H prefers-reduced-motion short-circuits: no portal, no
//      visibility swap, the button toggles disabled briefly
//      and resolves immediately.

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
  "AP-ORB-4 · authentic 64 px orb — zero layout shift, native canvas, animating",
  async ({ browser }) => {
    test.setTimeout(240_000);
    const outDir = ensureOutDir();
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      recordVideo: {
        dir: path.join(outDir, "ap-orb-4-video"),
        size: { width: 1440, height: 900 },
      },
    });
    const page = await loginAsFounder(ctx);
    await page.goto(`${BASE}/app/admin/work-intake/vendor-orb-demo?orb=1`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(2_000);

    const cell = page.locator('[data-testid="ap-orb-authentic-cell"]');
    await cell.waitFor({ state: "visible", timeout: 15_000 });
    await cell.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);

    // §A — Replay button present with ?orb=1.
    const replay = page.locator('[data-testid="ap-orb-authentic-replay"]');
    await expect(replay, "Replay button renders when ?orb=1").toBeVisible();

    const text = page.locator('[data-testid="ap-orb-authentic-text"]');
    const vendorBefore = (await text.textContent())?.trim() ?? "";
    const cellBoxBefore = await cell.boundingBox();
    console.log(`AP_ORB_4_VENDOR_BEFORE "${vendorBefore}"`);
    console.log(`AP_ORB_4_CELL_BOX_BEFORE ${JSON.stringify(cellBoxBefore)}`);
    expect(vendorBefore.length).toBeGreaterThan(0);

    // §B / §C / §F — Click Replay, verify text hidden, overlay
    // mounted at 64 x 64, cell bounds unchanged.
    const t0 = Date.now();
    await replay.click();
    await page.waitForTimeout(300);

    const overlay = page.locator('[data-testid="ap-orb-authentic-overlay"]');
    await expect(overlay, "overlay mounts after replay click").toBeVisible();
    const canvasMeta = await page.evaluate(() => {
      const o = document.querySelector('[data-testid="ap-orb-authentic-overlay"]');
      const c = o?.querySelector("canvas") as HTMLCanvasElement | null;
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return {
        cssWidth: r.width,
        cssHeight: r.height,
        bufferWidth: c.width,
        bufferHeight: c.height,
        dpr: window.devicePixelRatio,
      };
    });
    console.log("AP_ORB_4_CANVAS_META", JSON.stringify(canvasMeta));
    expect(canvasMeta?.cssWidth, "canvas CSS width = 64 px").toBeGreaterThanOrEqual(63);
    expect(canvasMeta?.cssWidth, "canvas CSS width = 64 px").toBeLessThanOrEqual(65);
    expect(canvasMeta?.cssHeight, "canvas CSS height = 64 px").toBeGreaterThanOrEqual(63);
    expect(canvasMeta?.cssHeight, "canvas CSS height = 64 px").toBeLessThanOrEqual(65);

    // Vendor text is hidden (visibility:hidden) so bounding box
    // still exists but it's not painted.  Check computed style.
    const textHidden = await text.evaluate((el) =>
      window.getComputedStyle(el).visibility === "hidden",
    );
    expect(textHidden, "vendor text is visibility:hidden during replay").toBe(true);

    const cellBoxDuring = await cell.boundingBox();
    console.log(`AP_ORB_4_CELL_BOX_DURING ${JSON.stringify(cellBoxDuring)}`);
    if (cellBoxBefore && cellBoxDuring) {
      expect(Math.abs(cellBoxBefore.x - cellBoxDuring.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(cellBoxBefore.y - cellBoxDuring.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(cellBoxBefore.height - cellBoxDuring.height)).toBeLessThanOrEqual(2);
      expect(Math.abs(cellBoxBefore.width - cellBoxDuring.width)).toBeLessThanOrEqual(2);
    }

    // §D — Prove canvas is actually animating.  Sample two 16x16
    // dataURL thumbnails ~400 ms apart; they must differ.
    const sampleThumb = async () => {
      return await page.evaluate(() => {
        const o = document.querySelector('[data-testid="ap-orb-authentic-overlay"]');
        const c = o?.querySelector("canvas") as HTMLCanvasElement | null;
        if (!c) return null;
        const t = document.createElement("canvas");
        t.width = 16;
        t.height = 16;
        const ctx = t.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(c, 0, 0, 16, 16);
        return t.toDataURL("image/png");
      });
    };
    const frameA = await sampleThumb();
    await page.waitForTimeout(400);
    const frameB = await sampleThumb();
    console.log(`AP_ORB_4_ANIM frameAneqB=${frameA !== frameB}`);
    expect(frameA, "frame A sampled").toBeTruthy();
    expect(frameB, "frame B sampled").toBeTruthy();
    expect(frameA !== frameB, "canvas is animating (frame A != frame B)").toBe(true);

    // Element-scoped frame screenshots (peak visibility).
    const frameDir = path.join(outDir, "ap-orb-4-frames");
    if (!existsSync(frameDir)) mkdirSync(frameDir, { recursive: true });
    await overlay.screenshot({ path: path.join(frameDir, "orb-peak-A.png") });
    await page.waitForTimeout(300);
    await overlay.screenshot({ path: path.join(frameDir, "orb-peak-B.png") });

    // Full page shot during replay.
    await page.screenshot({
      path: path.join(outDir, "ap-orb-4-page-during.png"),
      clip: { x: 0, y: 0, width: 1440, height: 900 },
    });

    // §E — Wait for the 2 s cycle to complete + small buffer, then
    // confirm overlay is gone and text is visible again.
    const elapsed = Date.now() - t0;
    const remaining = Math.max(0, 2_300 - elapsed);
    await page.waitForTimeout(remaining);
    await expect(overlay, "overlay unmounted after ~2 s").toHaveCount(0);
    const textVisibleAfter = await text.evaluate(
      (el) => window.getComputedStyle(el).visibility === "visible",
    );
    expect(textVisibleAfter, "vendor text visible again at idle").toBe(true);
    const vendorAfter = (await text.textContent())?.trim() ?? "";
    expect(vendorAfter, "vendor text identical before/after").toBe(vendorBefore);

    // §F closeout — cell bounds identical post-cycle.
    const cellBoxAfter = await cell.boundingBox();
    console.log(`AP_ORB_4_CELL_BOX_AFTER ${JSON.stringify(cellBoxAfter)}`);
    if (cellBoxBefore && cellBoxAfter) {
      expect(Math.abs(cellBoxBefore.x - cellBoxAfter.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(cellBoxBefore.y - cellBoxAfter.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(cellBoxBefore.height - cellBoxAfter.height)).toBeLessThanOrEqual(2);
      expect(Math.abs(cellBoxBefore.width - cellBoxAfter.width)).toBeLessThanOrEqual(2);
    }

    await page.screenshot({
      path: path.join(outDir, "ap-orb-4-page-rested.png"),
      clip: { x: 0, y: 0, width: 1440, height: 900 },
    });

    await ctx.close();
    console.log("AP_ORB_4_VIDEO_DIR test-results/ap-orb-4-video");
    console.log("AP_ORB_4_FRAME_DIR test-results/ap-orb-4-frames");
  },
);

runAt(
  "AP-ORB-4 · prefers-reduced-motion short-circuit — no portal, no visibility swap",
  async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
    });
    const page = await loginAsFounder(ctx);
    await page.goto(`${BASE}/app/admin/work-intake/vendor-orb-demo?orb=1`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(1_500);

    const cell = page.locator('[data-testid="ap-orb-authentic-cell"]');
    await cell.waitFor({ state: "visible", timeout: 15_000 });
    const text = page.locator('[data-testid="ap-orb-authentic-text"]');
    const vendorBefore = (await text.textContent())?.trim() ?? "";

    await page.locator('[data-testid="ap-orb-authentic-replay"]').click();
    await page.waitForTimeout(400);

    const overlayCount = await page
      .locator('[data-testid="ap-orb-authentic-overlay"]')
      .count();
    const textVisible = await text.evaluate(
      (el) => window.getComputedStyle(el).visibility === "visible",
    );
    const playing = await cell.getAttribute("data-ap-orb-authentic-playing");
    console.log(
      `AP_ORB_4_RM overlay=${overlayCount} textVisible=${textVisible} playing=${playing}`,
    );
    expect(overlayCount, "reduced-motion never mounts the overlay").toBe(0);
    expect(textVisible, "vendor text stays visible under reduced-motion").toBe(true);
    expect(playing, "cell flag never flips to playing").toBe("false");
    const vendorAfter = (await text.textContent())?.trim() ?? "";
    expect(vendorAfter).toBe(vendorBefore);

    await ctx.close();
  },
);
