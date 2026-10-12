// MBR-VIS-4B — glyph-level vertical centering measurement.
//
// The founder reports that despite dy=0.00 of span-bbox-vs-pill-bbox,
// the VISIBLE GLYPHS of the three pill buttons sit too high relative
// to the pill border — more empty space below the letters than above.
//
// This probe measures the ACTUAL rendered glyph box via
// Range.getBoundingClientRect() (not the span's bbox, which includes
// the line-box's full ascender/descender padding).  It compares that
// to the pill's own bounding box and reports:
//
//   topGap    = glyphRect.top    - pillRect.top
//   bottomGap = pillRect.bottom  - glyphRect.bottom
//   skew      = bottomGap - topGap  (positive → text sits too high)
//
// Also measures the icon in the Download button so the fix can keep
// the icon vertically aligned with the lettering.
//
// Runs on the live staging admin page at a single viewport (1440).

import { test } from "@playwright/test";
import { expect } from "@playwright/test";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

runAt(
  "MBR-VIS-4B · glyph vs pill vertical gap probe",
  async ({ browser }) => {
    test.setTimeout(180_000);
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx);
    await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-03`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(4500);

    const probe = await page.evaluate(() => {
      // Helper — pull a Range over the first text node in a container
      // and return its tight bounding client rect (glyph box).
      function glyphRect(el: HTMLElement): DOMRect | null {
        // Walk the DOM for the first non-empty text node.
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
        const g = glyphRect(pill);
        if (!g) return { kind, sel, found: true, pill: pillR.toJSON(), glyph: null } as const;
        const topGap = g.top - pillR.top;
        const bottomGap = pillR.bottom - g.bottom;
        const skew = bottomGap - topGap; // positive = text sits too high
        return {
          kind,
          sel,
          found: true,
          pill: { top: pillR.top, bottom: pillR.bottom, height: pillR.height },
          glyph: { top: g.top, bottom: g.bottom, height: g.height },
          topGap,
          bottomGap,
          skew,
        } as const;
      }

      function iconRect(sel: string) {
        const pill = document.querySelector<HTMLElement>(sel);
        if (!pill) return null;
        const svg = pill.querySelector<SVGSVGElement>("svg");
        if (!svg) return null;
        const r = svg.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, height: r.height, centerY: r.top + r.height / 2 };
      }

      return {
        chip: measurePill('[data-testid="publication-status-chip"]', "chip"),
        publish: measurePill('[data-testid="reporting-header-publish-btn"]', "publish"),
        download: measurePill('[data-testid="download-pdf-button"]', "download"),
        downloadIcon: iconRect('[data-testid="download-pdf-button"]'),
      };
    });

    console.log("MBR_VIS_4B_PROBE", JSON.stringify(probe, null, 2));

    // Save the raw probe for the fix-sizing step.
    const outDir = path.join("test-results");
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    writeFileSync(
      path.join(outDir, "mbr-vis-4b-glyph-probe.json"),
      JSON.stringify(probe, null, 2),
    );

    // Capture a magnified screenshot of each pill for visual review.
    for (const sel of [
      '[data-testid="publication-status-chip"]',
      '[data-testid="reporting-header-publish-btn"]',
      '[data-testid="download-pdf-button"]',
    ]) {
      const el = page.locator(sel).first();
      const name = (sel.match(/testid="([^"]+)"/) ?? ["", "pill"])[1];
      await el.screenshot({ path: path.join(outDir, `mbr-vis-4b-pre-${name}.png`) });
    }

    // Just affirm the probe ran — no assertions here, this is a
    // measurement step feeding the next commit's fix size.
    expect(probe.publish.found).toBe(true);
    expect(probe.download.found).toBe(true);
    expect(probe.chip.found).toBe(true);

    await ctx.close();
  },
);
