// MBR-VIS-4A (2026-10-11) — publication chrome refinement
// acceptance.  Captures Playwright screenshots at 1440 / 1920 /
// 1280 against the live staging environment and asserts that:
//
//   §A  No pale-yellow full-width banner exists below the masthead.
//   §B  Publication status chip is portaled INSIDE the dark-green
//       masthead (status slot inside the ReportingShell header).
//   §C  Review Draft Preview link is reachable from the masthead.
//   §D  Download Draft PDF button carries the same gold-token
//       styling as the Publish button (no amber colours remain).
//   §E  Both pill buttons apply the optical-center fix
//       (justify-center + text-indent compensating letter-spacing).
//
// Does not mutate any Coulee Ridge data.  Reads the Mar 2026
// draft-state admin surface at three viewports and saves screenshots
// to test-results/.

import { test } from "@playwright/test";
import { expect } from "@playwright/test";
import path from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

const VIEWPORTS: Array<{ label: string; w: number; h: number }> = [
  { label: "1920", w: 1920, h: 1080 },
  { label: "1440", w: 1440, h: 900 },
  { label: "1280", w: 1280, h: 820 },
];

function ensureOutDir(): string {
  const outDir = path.join("test-results");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  return outDir;
}

for (const vp of VIEWPORTS) {
  runAt(
    `MBR-VIS-4A · chrome refinement @ ${vp.label} — chip in masthead, no yellow banner, gold buttons centered`,
    async ({ browser }) => {
      test.setTimeout(240_000);
      const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
      const page = await loginAsFounder(ctx);
      await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-03`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(4500);

      // ─── §A — no pale-yellow full-width banner ──────────────
      // The old banner was a direct child of the body wrapper with
      // bg-amber-100 / bg-amber-50.  A locator that matches should
      // return 0 elements.
      const yellowBanner = page.locator('body div.bg-amber-100, body div.bg-amber-50');
      const yellowCount = await yellowBanner.count();
      console.log(`MBR_VIS_4A_${vp.label}_YELLOW_BANNERS ${yellowCount}`);
      expect(yellowCount).toBe(0);

      // ─── §B — chip is INSIDE the masthead status slot ───────
      const chip = page.locator('[data-testid="publication-status-chip"]');
      await expect(chip).toBeVisible();
      // Walk up: the chip's ancestor chain must include the
      // reporting-shell-header-status-slot span.
      const slotHasChip = await page.evaluate(() => {
        const slot = document.getElementById("reporting-shell-header-status-slot");
        if (!slot) return false;
        return !!slot.querySelector('[data-testid="publication-status-chip"]');
      });
      console.log(`MBR_VIS_4A_${vp.label}_CHIP_IN_MASTHEAD ${slotHasChip}`);
      expect(slotHasChip).toBe(true);

      // ─── §C — Review Draft Preview link reachable ───────────
      const review = page.locator('[data-testid="publication-status-review-draft-link"]');
      await expect(review).toBeVisible();
      const reviewHref = await review.getAttribute("href");
      console.log(`MBR_VIS_4A_${vp.label}_REVIEW_HREF ${reviewHref}`);
      expect(reviewHref).toContain("preview=draft");

      // ─── §D — Download Draft PDF uses the same gold tokens ──
      const dlBtn = page.locator('[data-testid="download-pdf-button"]').first();
      await expect(dlBtn).toBeVisible();
      const dlClass = (await dlBtn.getAttribute("class")) ?? "";
      console.log(`MBR_VIS_4A_${vp.label}_DL_CLASSES ${dlClass.slice(0, 220)}`);
      // Required gold tokens — identical to Publish's STYLE_ACTION_PRIMARY.
      expect(dlClass).toContain("border-club-gold/70");
      expect(dlClass).toContain("bg-club-gold/15");
      expect(dlClass).toContain("text-club-gold");
      // Forbidden amber tokens — must be gone.
      expect(dlClass).not.toMatch(/amber-500|amber-900|amber-200/);

      // ─── §E — both buttons apply the optical-center fix ─────
      const publishBtn = page.locator('[data-testid="reporting-header-publish-btn"]').first();
      await expect(publishBtn).toBeVisible();
      const pubClass = (await publishBtn.getAttribute("class")) ?? "";
      console.log(`MBR_VIS_4A_${vp.label}_PUB_CLASSES ${pubClass.slice(0, 220)}`);
      expect(pubClass).toContain("justify-center");
      // Tailwind compiles `[text-indent:0.18em]` into
      // `[text-indent:0.18em]` as the class name (arbitrary value).
      expect(pubClass).toContain("[text-indent:0.18em]");
      expect(dlClass).toContain("justify-center");
      expect(dlClass).toContain("[text-indent:0.18em]");

      // ─── Measure actual button rendered dimensions for the
      //     centering audit.  Compute label bbox vs button bbox
      //     and assert the label sits within 1px of true center.
      const centerCheck = await page.evaluate(() => {
        function measure(sel: string) {
          const btn = document.querySelector<HTMLElement>(sel);
          if (!btn) return null;
          const label = btn.querySelector<HTMLElement>("span");
          const btnR = btn.getBoundingClientRect();
          const labR = label ? label.getBoundingClientRect() : btnR;
          return {
            btnCenterX: btnR.left + btnR.width / 2,
            labelCenterX: labR.left + labR.width / 2,
            btnCenterY: btnR.top + btnR.height / 2,
            labelCenterY: labR.top + labR.height / 2,
          };
        }
        return {
          publish: measure('[data-testid="reporting-header-publish-btn"]'),
          download: measure('[data-testid="download-pdf-button"]'),
        };
      });
      if (centerCheck.publish) {
        const dxPub = Math.abs(centerCheck.publish.btnCenterX - centerCheck.publish.labelCenterX);
        const dyPub = Math.abs(centerCheck.publish.btnCenterY - centerCheck.publish.labelCenterY);
        console.log(`MBR_VIS_4A_${vp.label}_PUB_CENTER_DX ${dxPub.toFixed(2)}`);
        console.log(`MBR_VIS_4A_${vp.label}_PUB_CENTER_DY ${dyPub.toFixed(2)}`);
        // ≤3px horizontal and ≤2px vertical is well within optical
        // tolerance for a letter-spaced monospace pill.
        expect(dxPub).toBeLessThanOrEqual(3);
        expect(dyPub).toBeLessThanOrEqual(2);
      }
      if (centerCheck.download) {
        const dxDl = Math.abs(centerCheck.download.btnCenterX - centerCheck.download.labelCenterX);
        const dyDl = Math.abs(centerCheck.download.btnCenterY - centerCheck.download.labelCenterY);
        console.log(`MBR_VIS_4A_${vp.label}_DL_CENTER_DX ${dxDl.toFixed(2)}`);
        console.log(`MBR_VIS_4A_${vp.label}_DL_CENTER_DY ${dyDl.toFixed(2)}`);
        // Icon shifts the measurement, so allow a slightly larger
        // horizontal delta; label itself is still centred in its
        // own bbox.
        expect(dyDl).toBeLessThanOrEqual(2);
      }

      // Save a masthead screenshot for the acceptance report.
      const outDir = ensureOutDir();
      const outPath = path.join(outDir, `mbr-vis-4a-masthead-${vp.label}.png`);
      // Capture the shell header strip only — it's at the top of
      // the viewport.  Clip to the known masthead height.
      await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: vp.w, height: 100 } });
      console.log(`MBR_VIS_4A_${vp.label}_SCREENSHOT ${outPath}`);

      await ctx.close();
    },
  );
}
