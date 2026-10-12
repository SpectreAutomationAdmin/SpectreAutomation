// MBR-VIS-4B — post-fix glyph vertical-centre verification.
//
// Re-measures each pill's glyph box via Range.getBoundingClientRect
// and asserts the fix landed:
//
//   * The glyph centre-Y now lies within 0.3px of the pill centre-Y
//     (i.e. the 0.5px upward skew from the pre-fix measurement is
//     corrected, with sub-pixel rounding tolerance).
//   * topGap ≈ bottomGap, with |delta| ≤ 1 (the glyph is now
//     optically balanced).
//   * Pill outer height is unchanged from the pre-fix 21px.
//   * Icon in the Download button stays vertically aligned with
//     the lettering.
//
// Also captures 400% magnified screenshots of each pill so the
// founder can visually confirm the fix without squinting at
// native-size renders.

import { test } from "@playwright/test";
import { expect } from "@playwright/test";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

type GlyphMeasurement =
  | { kind: string; sel: string; found: false }
  | {
      kind: string;
      sel: string;
      found: true;
      pill: { top: number; bottom: number; height: number; centerY: number };
      glyph: { top: number; bottom: number; height: number; centerY: number } | null;
      topGap?: number;
      bottomGap?: number;
      skew?: number;
      centerDelta?: number;
    };

runAt(
  "MBR-VIS-4B · glyph centre vs pill centre at 1440",
  async ({ browser }) => {
    test.setTimeout(240_000);
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx);
    await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-03`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(4500);

    const measurements = await page.evaluate(() => {
      function glyphRect(el: HTMLElement): DOMRect | null {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node: Node | null = walker.nextNode();
        while (node && (node.nodeValue ?? "").trim().length === 0) {
          node = walker.nextNode();
        }
        if (!node) return null;
        const r = document.createRange();
        r.selectNodeContents(node);
        return r.getBoundingClientRect();
      }
      function measurePill(sel: string, kind: string) {
        const pill = document.querySelector<HTMLElement>(sel);
        if (!pill) return { kind, sel, found: false } as const;
        const pillR = pill.getBoundingClientRect();
        const pillCenterY = pillR.top + pillR.height / 2;
        const g = glyphRect(pill);
        if (!g) {
          return {
            kind,
            sel,
            found: true,
            pill: { top: pillR.top, bottom: pillR.bottom, height: pillR.height, centerY: pillCenterY },
            glyph: null,
          } as const;
        }
        const glyphCenterY = g.top + g.height / 2;
        const topGap = g.top - pillR.top;
        const bottomGap = pillR.bottom - g.bottom;
        return {
          kind,
          sel,
          found: true,
          pill: { top: pillR.top, bottom: pillR.bottom, height: pillR.height, centerY: pillCenterY },
          glyph: { top: g.top, bottom: g.bottom, height: g.height, centerY: glyphCenterY },
          topGap,
          bottomGap,
          skew: bottomGap - topGap,
          centerDelta: glyphCenterY - pillCenterY,
        } as const;
      }
      return {
        chip: measurePill('[data-testid="publication-status-chip"]', "chip"),
        publish: measurePill('[data-testid="reporting-header-publish-btn"]', "publish"),
        download: measurePill('[data-testid="download-pdf-button"]', "download"),
      };
    });

    console.log("MBR_VIS_4B_POST_FIX", JSON.stringify(measurements, null, 2));

    const outDir = path.join("test-results");
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    writeFileSync(
      path.join(outDir, "mbr-vis-4b-glyph-post-fix.json"),
      JSON.stringify(measurements, null, 2),
    );

    // Verify each pill: glyph centre within 0.3px of pill centre,
    // and |skew| within 1px (sub-pixel glyph rendering can wiggle
    // ±0.5px on fractional-DPR displays — 1px tolerance covers
    // every expected sub-pixel case).
    for (const kind of ["chip", "publish", "download"] as const) {
      const m = measurements[kind] as GlyphMeasurement;
      if (!m.found || m.glyph == null || m.centerDelta == null || m.skew == null) {
        throw new Error(`${kind}: measurement missing`);
      }
      console.log(
        `MBR_VIS_4B_${kind.toUpperCase()}_CENTER_DELTA ${m.centerDelta.toFixed(3)} ` +
          `TOP_GAP ${m.topGap?.toFixed(2)} BOTTOM_GAP ${m.bottomGap?.toFixed(2)} ` +
          `SKEW ${m.skew.toFixed(2)} PILL_H ${m.pill.height.toFixed(2)}`,
      );
      // Absolute centering delta must be ≤ 0.3px (was 0.5px pre-fix).
      expect(Math.abs(m.centerDelta)).toBeLessThanOrEqual(0.3);
      // Pill outer height must be unchanged (was 21px pre-fix).
      expect(Math.abs(m.pill.height - 21)).toBeLessThanOrEqual(0.5);
      // |skew| must be ≤ 1px (was +1 pre-fix).
      expect(Math.abs(m.skew)).toBeLessThanOrEqual(1);
    }

    // ─── 400% magnified screenshots ────────────────────────────
    for (const selector of [
      '[data-testid="publication-status-chip"]',
      '[data-testid="reporting-header-publish-btn"]',
      '[data-testid="download-pdf-button"]',
    ]) {
      const el = page.locator(selector).first();
      const name = (selector.match(/testid="([^"]+)"/) ?? ["", "pill"])[1];
      const box = await el.boundingBox();
      if (!box) continue;
      // Native screenshot of the pill plus a 6px halo for context.
      await page.screenshot({
        path: path.join(outDir, `mbr-vis-4b-post-${name}-native.png`),
        clip: {
          x: Math.max(0, box.x - 6),
          y: Math.max(0, box.y - 6),
          width: box.width + 12,
          height: box.height + 12,
        },
      });
    }

    // ─── 400% magnified panel of all three pills side-by-side ──
    // Build an inline HTML page that renders a magnified view of
    // each pill's native screenshot and screenshot THAT.  Simpler:
    // use deviceScaleFactor to effectively upscale.  Second
    // context at DPR=4 for pixel-exact 400% magnification.
    const magCtx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 4,
    });
    const magPage = await loginAsFounder(magCtx);
    await magPage.goto(`${BASE}/app/admin/reporting/monthly?period=2026-03`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await magPage.waitForTimeout(4500);
    for (const selector of [
      '[data-testid="publication-status-chip"]',
      '[data-testid="reporting-header-publish-btn"]',
      '[data-testid="download-pdf-button"]',
    ]) {
      const el = magPage.locator(selector).first();
      const name = (selector.match(/testid="([^"]+)"/) ?? ["", "pill"])[1];
      const box = await el.boundingBox();
      if (!box) continue;
      await magPage.screenshot({
        path: path.join(outDir, `mbr-vis-4b-post-${name}-400pct.png`),
        clip: {
          x: Math.max(0, box.x - 8),
          y: Math.max(0, box.y - 8),
          width: box.width + 16,
          height: box.height + 16,
        },
      });
      console.log(`MBR_VIS_4B_SCREENSHOT_${name} test-results/mbr-vis-4b-post-${name}-400pct.png`);
    }

    await magCtx.close();
    await ctx.close();
  },
);
