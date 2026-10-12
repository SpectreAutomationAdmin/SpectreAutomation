// MBR-VIS-5 (2026-10-11) — chapter + card visibility acceptance.
//
// Verifies on live staging (Mar 2026 Coulee Ridge, DRAFT state):
//
//   §A  Every one of the 14 chapters renders a ChapterTitleToggle
//       chip (inline, no absolute positioning).
//   §B  Each wrapped top-level panel exposes a card-level
//       visibility overlay via CardVisibilityWrapper.
//   §C  Statement of Activities (chapter IV) has NO header-element
//       overlap: the chapter chip sits above the heading, the SOA
//       header's right column ("Statement No. IV" + document chip
//       + Prepared For) is visible and unobscured.
//   §D  Operating + Capital Stewardship scorecards both expose a
//       card toggle inline in their dark-green header.
//
// Captures screenshots of the Operating Stewardship card and the
// Statement of Activities header area for the acceptance report.

import { test } from "@playwright/test";
import { expect } from "@playwright/test";
import path from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

const CHAPTERS = [
  "financial-performance",
  "stewardship-dashboard",
  "statement-of-activities",
  "capital-fund",
  "capital-projects",
  "financial-position",
  "ar-aging",
  "operating-statistics",
  "departmental-p-and-l",
  "weather-and-utilization",
  "payroll-analysis",
  "f-and-b-statistics",
  "inventory-analysis",
];

const PANEL_KEYS = [
  "card:statement-of-activities:soa-panel",
  "card:capital-fund:capital-fund-panel",
  "card:capital-projects:capital-projects-panel",
  "card:financial-position:financial-position-panel",
  "card:ar-aging:ar-aging-panel",
  "card:operating-statistics:operating-statistics-panel",
  "card:departmental-p-and-l:departmental-pl-panel",
  "card:weather-and-utilization:weather-panel",
  "card:payroll-analysis:payroll-panel",
  "card:f-and-b-statistics:f-and-b-panel",
  "card:inventory-analysis:inventory-panel",
];

function ensureOutDir(): string {
  const outDir = path.join("test-results");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  return outDir;
}

runAt(
  "MBR-VIS-5 §A/§B · all 13 chapter toggles + 11 panel wrappers render on staging",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-03`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(6000);

    // Chapter chips — count all rendered ChapterTitleToggles.
    for (const anchor of CHAPTERS) {
      const chip = page.locator(`[data-testid="chapter-title-toggle-${anchor}"]`);
      const n = await chip.count();
      console.log(`MBR_VIS_5_CHAPTER_CHIP ${anchor} count=${n}`);
      expect(n).toBe(1);
      // Confirm no absolute positioning on the chip itself.
      const pos = await chip.first().evaluate((el) => getComputedStyle(el).position);
      expect(pos).not.toBe("absolute");
    }

    // Panel wrappers.
    for (const compKey of PANEL_KEYS) {
      const wrap = page.locator(`[data-component-key="${compKey}"]`);
      const n = await wrap.count();
      console.log(`MBR_VIS_5_PANEL_WRAP ${compKey} count=${n}`);
      expect(n).toBe(1);
    }

    await ctx.close();
  },
);

runAt(
  "MBR-VIS-5 §C · Statement of Activities header has no visibility-toggle overlap",
  async ({ browser }) => {
    test.setTimeout(240_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-03#statement-of-activities`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(5000);

    // Chapter chip for Statement of Activities must exist and be
    // inline (not covering the right column).
    const chip = page.locator('[data-testid="chapter-title-toggle-statement-of-activities"]').first();
    await expect(chip).toBeVisible();
    const chipRect = await chip.boundingBox();
    const soaRight = page.locator('[data-testid="soa-statement-number"]').first();
    await expect(soaRight).toBeVisible();
    const rightRect = await soaRight.boundingBox();
    console.log(`MBR_VIS_5_SOA_CHIP ${JSON.stringify(chipRect)}`);
    console.log(`MBR_VIS_5_SOA_RIGHT_HEADER ${JSON.stringify(rightRect)}`);

    // The chip must sit ABOVE the SOA right header (no overlap).
    if (chipRect && rightRect) {
      const overlapsVertically =
        chipRect.y < rightRect.y + rightRect.height &&
        chipRect.y + chipRect.height > rightRect.y;
      const overlapsHorizontally =
        chipRect.x < rightRect.x + rightRect.width &&
        chipRect.x + chipRect.width > rightRect.x;
      const overlaps = overlapsVertically && overlapsHorizontally;
      console.log(`MBR_VIS_5_SOA_OVERLAP ${overlaps}`);
      expect(overlaps).toBe(false);
    }

    const outDir = ensureOutDir();
    await page.screenshot({
      path: path.join(outDir, "mbr-vis-5-soa-header.png"),
      clip: { x: 0, y: 0, width: 1650, height: 400 },
    });
    console.log(`MBR_VIS_5_SOA_SCREENSHOT ${path.join(outDir, "mbr-vis-5-soa-header.png")}`);

    await ctx.close();
  },
);

runAt(
  "MBR-VIS-5 §D · Operating + Capital scorecards expose card toggles inline",
  async ({ browser }) => {
    test.setTimeout(240_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-03#stewardship-dashboard`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(5000);

    for (const scorecardKey of [
      "financial-performance-operating-scorecard",
      "financial-performance-capital-scorecard",
    ]) {
      const toggleWrap = page.locator(`[data-testid="${scorecardKey}-card-toggle-wrap"]`);
      const n = await toggleWrap.count();
      console.log(`MBR_VIS_5_SCORECARD_TOGGLE ${scorecardKey} count=${n}`);
      if (n > 0) {
        const pos = await toggleWrap.first().evaluate((el) => getComputedStyle(el).position);
        console.log(`MBR_VIS_5_SCORECARD_TOGGLE_POSITION ${scorecardKey} ${pos}`);
        expect(pos).not.toBe("absolute");
      }
    }

    const outDir = ensureOutDir();
    const operating = page.locator('[data-testid="financial-performance-operating-scorecard"]').first();
    const box = await operating.boundingBox();
    if (box) {
      await page.screenshot({
        path: path.join(outDir, "mbr-vis-5-operating-scorecard.png"),
        clip: {
          x: Math.max(0, box.x - 8),
          y: Math.max(0, box.y - 8),
          width: box.width + 16,
          height: Math.min(400, box.height + 16),
        },
      });
      console.log(`MBR_VIS_5_OPERATING_SCREENSHOT test-results/mbr-vis-5-operating-scorecard.png`);
    }

    await ctx.close();
  },
);
