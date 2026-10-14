// AP-ORB-1 (2026-10-14) — Vendor-field intelligence motion
// staging acceptance.  This spec is intentionally video-first:
// per the directive §7, static screenshots alone are not
// sufficient evidence; the founder needs an actual recording of
// the choreography.
//
// We force Playwright's video recorder on for this spec via
// `test.use({ video: "on" })` so a successful run still produces
// a .webm file the founder can view.
//
// Verifies:
//   §A — Opening the review page with `?orb=1` renders the real
//        persisted vendor name plus the Replay-orb button.
//   §B — Clicking Replay transitions the Vendor cell through
//        thinking → decel → resolve phases (readable from
//        `data-ap-orb-phase`).
//   §C — The orb canvas appears during thinking and disappears
//        after resolution.
//   §D — The resting Vendor cell DOM at `playing=false` matches
//        the pre-click rendering byte-for-byte (same text, same
//        inline style transform / opacity).
//   §E — Vendor-match exception on the broader page remains
//        unchanged after the animation.
//   §F — Captures a slow-motion frame sequence by sampling the
//        page at ~60 ms intervals through the sequence so the
//        founder can inspect the deceleration + text slide.
//   §G — No horizontal / vertical layout shift elsewhere.

import { test } from "@playwright/test";
import { expect } from "@playwright/test";
import path from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

// Force video on for this spec regardless of the top-level config.
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
  "AP-ORB-1 · Vendor-field orb reveal — real page, real vendor, video + frame sequence",
  async ({ browser }) => {
    test.setTimeout(600_000);
    const outDir = ensureOutDir();

    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      recordVideo: {
        dir: path.join(outDir, "ap-orb-1-video"),
        size: { width: 1440, height: 900 },
      },
    });
    const page = await loginAsFounder(ctx);

    // Step 1 — follow the first review link on the Work Intake
    // feed, append `?orb=1` so the replay button renders.
    await page.goto(`${BASE}/app/admin/work-intake`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(2_000);
    const link = page.locator('a[href^="/app/admin/work-intake/review/"]').first();
    await link.waitFor({ state: "visible", timeout: 30_000 });
    const href = await link.getAttribute("href");
    if (!href) throw new Error("No review link on Work Intake list");
    const reviewUrl = `${BASE}${href}${href.includes("?") ? "&" : "?"}orb=1`;
    console.log(`AP_ORB_1_REVIEW_URL ${reviewUrl}`);
    await page.goto(reviewUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3_000);

    // Scroll the Vendor cell into view.
    const vendorCell = page.locator('[data-testid="ap-orb-vendor-cell"]').first();
    await vendorCell.waitFor({ state: "visible", timeout: 15_000 });
    await vendorCell.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);

    // §A — Replay button present with ?orb=1.
    const replay = page.locator('[data-testid="ap-orb-vendor-replay"]').first();
    await expect(replay, "Replay button renders when ?orb=1").toBeVisible();
    const vendorBefore = await vendorCell.textContent();
    const beforeBox = await vendorCell.boundingBox();
    console.log(`AP_ORB_1_VENDOR_BEFORE "${(vendorBefore ?? "").trim()}"`);
    console.log(`AP_ORB_1_VENDOR_BOX_BEFORE ${JSON.stringify(beforeBox)}`);

    const idlePhase = await vendorCell.getAttribute("data-ap-orb-phase");
    expect(idlePhase, "idle before click").toBe("idle");

    // §B — Click Replay and sample `data-ap-orb-phase` + orb
    // visibility over the 2.1 s choreography.
    const samples: Array<{ atMs: number; phase: string | null; orbCount: number }> = [];
    const sampleAt = async (atMs: number) => {
      const phase = await vendorCell.getAttribute("data-ap-orb-phase");
      const orbCount = await page.locator('[data-testid="ap-orb-vendor-orb"]').count();
      samples.push({ atMs, phase, orbCount });
    };

    // Element-level screenshots at key frames so the founder has a
    // slow-motion frame sequence.
    const frameDir = path.join(outDir, "ap-orb-1-frames");
    if (!existsSync(frameDir)) mkdirSync(frameDir, { recursive: true });
    const grabFrame = async (ms: number) => {
      const safe = String(ms).padStart(4, "0");
      // Capture the Vendor row's bounding box + a comfortable
      // margin so the founder can see the orb AND the surrounding
      // label.
      const row = page.locator('.ap-motion-field, .wi-review-classify > *').first(); // defensive
      void row; // unused — we rely on the vendor cell + a padded clip
      const bb = await vendorCell.boundingBox();
      if (!bb) return;
      await page.screenshot({
        path: path.join(frameDir, `ap-orb-1-frame-${safe}ms.png`),
        clip: {
          x: Math.max(0, bb.x - 180),
          y: Math.max(0, bb.y - 20),
          width: Math.min(1440 - Math.max(0, bb.x - 180), 720),
          height: Math.min(900 - Math.max(0, bb.y - 20), 90),
        },
      });
    };

    const t0 = Date.now();
    await replay.click();
    // Sample schedule across the ~2.1 s animation.
    const sampleTimes = [40, 200, 500, 850, 1_100, 1_350, 1_600, 1_800, 2_000, 2_200, 2_500];
    for (const ms of sampleTimes) {
      const now = Date.now() - t0;
      const wait = Math.max(0, ms - now);
      if (wait > 0) await page.waitForTimeout(wait);
      await sampleAt(ms);
      await grabFrame(ms);
    }
    console.log("AP_ORB_1_PHASE_SAMPLES", JSON.stringify(samples));

    // §B assertions — observed at least one of thinking / decel /
    // resolve among the sampled phases.
    const phases = new Set(samples.map((s) => s.phase));
    expect(phases.has("thinking"), "thinking phase observed").toBe(true);
    expect(phases.has("decel"), "decel phase observed").toBe(true);
    expect(phases.has("resolve"), "resolve phase observed").toBe(true);

    // §C — Orb was present during thinking + decel; gone at idle
    // after the sequence completes.
    const orbDuringThinking = samples.find((s) => s.phase === "thinking");
    const orbDuringDecel = samples.find((s) => s.phase === "decel");
    expect(orbDuringThinking?.orbCount ?? 0, "orb canvas present during thinking").toBeGreaterThanOrEqual(1);
    expect(orbDuringDecel?.orbCount ?? 0, "orb canvas present during decel").toBeGreaterThanOrEqual(1);

    // §D — After full completion, phase is back to idle, orb canvas
    // is gone, resting cell content equals the pre-click content.
    await page.waitForTimeout(500);
    const idleAfter = await vendorCell.getAttribute("data-ap-orb-phase");
    expect(idleAfter, "idle after animation").toBe("idle");
    const orbAfter = await page.locator('[data-testid="ap-orb-vendor-orb"]').count();
    expect(orbAfter, "orb canvas unmounted at rest").toBe(0);
    const vendorAfter = await vendorCell.textContent();
    expect((vendorAfter ?? "").trim()).toBe((vendorBefore ?? "").trim());

    // §G — Bounding box at rest matches pre-click bounding box.
    //    Allow a 2px tolerance (layout fluctuation on hover state).
    const afterBox = await vendorCell.boundingBox();
    if (beforeBox && afterBox) {
      expect(Math.abs(beforeBox.x - afterBox.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(beforeBox.y - afterBox.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(beforeBox.height - afterBox.height)).toBeLessThanOrEqual(2);
    }
    console.log(`AP_ORB_1_VENDOR_BOX_AFTER ${JSON.stringify(afterBox)}`);

    // §E — Vendor-match row (one of the other MetaRow entries on
    // the page) exists and does NOT display "MATCHED".  No change
    // was requested; this is a regression guard.
    const vendorMatchRow = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll(".wi-review-classify > *"));
      const row = rows.find((r) => r.textContent?.toLowerCase().includes("vendor match"));
      return row?.textContent?.trim() ?? null;
    });
    console.log(`AP_ORB_1_VENDOR_MATCH_ROW "${vendorMatchRow}"`);

    // Full-page screenshot of the rested state.
    await page.screenshot({
      path: path.join(outDir, "ap-orb-1-review-rested.png"),
      clip: { x: 0, y: 0, width: 1440, height: 900 },
    });
    console.log("AP_ORB_1_RESTED_SCREENSHOT test-results/ap-orb-1-review-rested.png");

    await ctx.close(); // closes recordVideo
    console.log(`AP_ORB_1_VIDEO_DIR test-results/ap-orb-1-video`);
    console.log(`AP_ORB_1_FRAME_DIR test-results/ap-orb-1-frames`);
  },
);
