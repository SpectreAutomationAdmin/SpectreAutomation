// MBR-VIS-4C — true glyph-ink measurement via Canvas measureText.
//
// Range.getBoundingClientRect returns the LINE-BOX of text, not the
// ink silhouette.  Centring the line-box ≠ centring the visible
// glyphs: when the font's ascent is larger than its descent, the
// ink sits in the UPPER portion of the line-box and the visual
// perception is "text too high" even when the line-box is centred.
//
// This probe uses the Canvas `measureText()` API which returns
// `actualBoundingBoxAscent` and `actualBoundingBoxDescent` — the
// TRUE ink extent of the glyphs for the resolved font + size.
// From that we compute where the ink midpoint sits relative to the
// pill border and derive the exact asymmetric-padding needed.

import { test } from "@playwright/test";
import { expect } from "@playwright/test";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

runAt(
  "MBR-VIS-4C · true ink measurement via Canvas measureText",
  async ({ browser }) => {
    test.setTimeout(180_000);
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx);
    await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-03`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(4500);

    const result = await page.evaluate(() => {
      function inspectPill(sel: string, text: string, kind: string) {
        const pill = document.querySelector<HTMLElement>(sel);
        if (!pill) return { kind, found: false } as const;
        // Find the inner span that actually holds the text.  For
        // the Download button there's an SVG + span; the first
        // <span> child is the label span.
        const span = pill.querySelector<HTMLElement>("span") ?? pill;
        const cs = getComputedStyle(span);
        const pillCS = getComputedStyle(pill);
        const pillR = pill.getBoundingClientRect();

        // Canvas measureText with the exact resolved font.
        const canvas = document.createElement("canvas");
        const g = canvas.getContext("2d");
        if (!g) return { kind, found: true, error: "no canvas ctx" } as const;
        g.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        g.textBaseline = "alphabetic";
        const m = g.measureText(text);

        // Compute the ink midpoint vertical offset from the baseline:
        //   actualBoundingBoxAscent  = pixels above baseline to top of ink
        //   actualBoundingBoxDescent = pixels below baseline to bottom of ink
        // Ink midpoint = baseline - (ascent - descent)/2
        const inkAscent = m.actualBoundingBoxAscent;
        const inkDescent = m.actualBoundingBoxDescent;
        const inkHeight = inkAscent + inkDescent;
        const inkMidFromBaseline = (inkDescent - inkAscent) / 2; // negative = above baseline

        // Where does the baseline sit within the pill?  Use a Range
        // on the span's text node to find the baseline position
        // empirically (the Range bbox bottom corresponds to the
        // baseline for an all-latin text with no descenders — but
        // for mixed case we need a better anchor).  Fallback: use
        // font-metrics-ascent via Range top + line-box geometry.
        const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
        let node: Node | null = walker.nextNode();
        while (node && (node.nodeValue ?? "").trim().length === 0) {
          node = walker.nextNode();
        }
        if (!node) return { kind, found: true, error: "no text node" } as const;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rangeR = range.getBoundingClientRect();

        // Compute pill geometry.
        const pillCenterY = pillR.top + pillR.height / 2;

        // Baseline estimate: for Latin alphabetic text, Chromium
        // places the baseline at `rangeR.top + fontMetricsAscent`.
        // We don't have direct access to fontMetricsAscent, but
        // measureText's `fontBoundingBoxAscent` approximates it.
        const fontMetricsAscent =
          m.fontBoundingBoxAscent ?? inkAscent;
        const fontMetricsDescent =
          m.fontBoundingBoxDescent ?? inkDescent;
        const baselineY = rangeR.top + fontMetricsAscent;

        const inkTopY = baselineY - inkAscent;
        const inkBottomY = baselineY + inkDescent;
        const inkCenterY = (inkTopY + inkBottomY) / 2;

        const topInkGap = inkTopY - pillR.top;
        const bottomInkGap = pillR.bottom - inkBottomY;
        const inkSkew = bottomInkGap - topInkGap; // positive = text too high
        const inkCenterDelta = inkCenterY - pillCenterY; // negative = ink above pill center

        return {
          kind,
          found: true,
          pill: {
            top: pillR.top,
            bottom: pillR.bottom,
            height: pillR.height,
            centerY: pillCenterY,
            paddingTop: pillCS.paddingTop,
            paddingBottom: pillCS.paddingBottom,
            borderTopWidth: pillCS.borderTopWidth,
            borderBottomWidth: pillCS.borderBottomWidth,
            lineHeight: pillCS.lineHeight,
            fontSize: pillCS.fontSize,
            fontFamily: pillCS.fontFamily,
            fontWeight: pillCS.fontWeight,
          },
          range: { top: rangeR.top, bottom: rangeR.bottom, height: rangeR.height },
          measureText: {
            width: m.width,
            actualBoundingBoxAscent: inkAscent,
            actualBoundingBoxDescent: inkDescent,
            fontBoundingBoxAscent: fontMetricsAscent,
            fontBoundingBoxDescent: fontMetricsDescent,
            inkHeight,
            inkMidFromBaseline,
          },
          baselineY,
          ink: {
            top: inkTopY,
            bottom: inkBottomY,
            centerY: inkCenterY,
          },
          topInkGap,
          bottomInkGap,
          inkSkew,
          inkCenterDelta,
          /** Suggested downward shift to centre the ink.  Positive =
           *  shift down.  To apply via asymmetric padding on a 4px-
           *  vertical-padding pill: pt-[2 + shift]px pb-[2 - shift]px. */
          suggestedDownShift: inkCenterDelta < 0 ? -inkCenterDelta : 0,
        } as const;
      }

      return {
        chip: inspectPill(
          '[data-testid="publication-status-chip"]',
          "DRAFT",
          "chip",
        ),
        publish: inspectPill(
          '[data-testid="reporting-header-publish-btn"]',
          "PUBLISH",
          "publish",
        ),
        download: inspectPill(
          '[data-testid="download-pdf-button"]',
          "DOWNLOAD DRAFT PDF",
          "download",
        ),
      };
    });

    console.log("MBR_VIS_4C_PROBE", JSON.stringify(result, null, 2));

    const outDir = path.join("test-results");
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    writeFileSync(
      path.join(outDir, "mbr-vis-4c-ink-probe.json"),
      JSON.stringify(result, null, 2),
    );

    expect(result.chip.found).toBe(true);
    expect(result.publish.found).toBe(true);
    expect(result.download.found).toBe(true);

    await ctx.close();
  },
);
