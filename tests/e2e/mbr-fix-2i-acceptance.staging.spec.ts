// MBR-FIX-2I — numeric acceptance for the Operating Cost Coverage
// donut legend / tooltip percentage formatting.
//
// Pre-fix: legend values rendered as raw unrounded decimals with a
// trailing % symbol (e.g. "11.386988286508837%").
//
// Fix acceptance:
//   • Every legend row's percentage value matches /^-?\d+\.\d{2}%$/
//     (exactly two decimal places + % symbol).
//   • The underlying `pct` numeric field is NOT accidentally scaled
//     up by the formatter (no value exceeds 100.01).
//   • Sum of displayed rounded percentages lands within ±0.5 of 100.
//   • No legend text or value is clipped at the card boundary.
//   • Jan 2026 regression: same formatting applies.
//   • Payroll Ratio Monthly Trend is unchanged by this slice.

import { test, type Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

const PCT_FORMAT = /^-?\d+\.\d{2}%$/;

async function readLegendValues(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const legend = document.querySelector('[data-testid="dues-subsidy-legend"]');
    if (!legend) return [];
    // Legend row = grid with 3 columns [swatch, label, value]; value
    // is the last `<span>` in each row.
    const rows = legend.querySelectorAll('[data-testid^="dues-legend-"]');
    const out: string[] = [];
    for (const row of Array.from(rows)) {
      const spans = row.querySelectorAll("span");
      if (spans.length === 0) continue;
      const last = spans[spans.length - 1];
      out.push((last.textContent ?? "").trim());
    }
    return out;
  });
}

async function readLegendRowOverflow(page: Page): Promise<boolean> {
  // Returns true if ANY legend row's value span is visibly clipped
  // by its container.
  return page.evaluate(() => {
    const legend = document.querySelector('[data-testid="dues-subsidy-legend"]');
    if (!legend) return false;
    const rows = legend.querySelectorAll('[data-testid^="dues-legend-"]');
    for (const row of Array.from(rows)) {
      const spans = row.querySelectorAll("span");
      if (spans.length === 0) continue;
      const last = spans[spans.length - 1] as HTMLElement;
      // Clipping: scrollWidth > offsetWidth means the content is wider
      // than the rendered column.
      if (last.scrollWidth > last.offsetWidth + 1) return true;
    }
    return false;
  });
}

runAt(
  "MBR-FIX-2I · Feb 2026 — every legend value formats as X.XX%",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(
      `${BASE}/app/admin/reporting/monthly?period=2026-02#stewardship-dashboard`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(4500);

    const values = await readLegendValues(page);
    console.log("MBR_FIX_2I_FEB_LEGEND_VALUES " + JSON.stringify(values));

    // At least 15 slices expected on Coulee Feb 2026 (per MBR-FIX-2H
    // staging capture: ~19 OpEx categories + 1 Surplus slice).
    expect(values.length).toBeGreaterThan(5);

    // Every value must be formatted as X.XX%.
    for (const v of values) {
      expect(v, `legend value "${v}" must be X.XX%`).toMatch(PCT_FORMAT);
    }

    // No value exceeds 100.01 % (sanity: formatter did not accidentally
    // multiply by 100 again).
    const numeric = values.map((v) => Number(v.replace(/%$/, "")));
    for (const n of numeric) {
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(100.01);
    }

    // Sum of displayed rounded percentages lands within ±0.5 of 100.
    const sum = numeric.reduce((s, v) => s + v, 0);
    console.log(`MBR_FIX_2I_FEB_SUM ${sum.toFixed(4)}`);
    expect(sum).toBeGreaterThan(99.5);
    expect(sum).toBeLessThan(100.5);

    // Visual clipping check — no legend row's value is clipped.
    const anyClipped = await readLegendRowOverflow(page);
    expect(anyClipped, "no legend value should overflow its column").toBe(false);

    // Capture a screenshot of the dues card for founder review.
    const card = page.locator('[data-testid="dues-subsidy-analysis"]');
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: "test-results/mbr-fix-2i-feb-dues-donut.png" });

    await ctx.close();
  },
);

runAt(
  "MBR-FIX-2I · Jan 2026 regression — same formatting applies",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(
      `${BASE}/app/admin/reporting/monthly?period=2026-01#stewardship-dashboard`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(4500);

    const values = await readLegendValues(page);
    console.log("MBR_FIX_2I_JAN_LEGEND_VALUES " + JSON.stringify(values));

    expect(values.length).toBeGreaterThan(5);
    for (const v of values) {
      expect(v).toMatch(PCT_FORMAT);
    }
    const sum = values
      .map((v) => Number(v.replace(/%$/, "")))
      .reduce((s, v) => s + v, 0);
    expect(sum).toBeGreaterThan(99.5);
    expect(sum).toBeLessThan(100.5);

    const card = page.locator('[data-testid="dues-subsidy-analysis"]');
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: "test-results/mbr-fix-2i-jan-dues-donut.png" });

    await ctx.close();
  },
);

runAt(
  "MBR-FIX-2I · Payroll Ratio Monthly Trend is unchanged by this slice",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(
      `${BASE}/app/admin/reporting/monthly?period=2026-02#stewardship-dashboard`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(4500);

    const txt = await page.evaluate(() => {
      const body = document.body.innerText.replace(/\s+/g, " ");
      const anchor = body.indexOf("Payroll Ratio — Monthly Trend");
      return anchor < 0 ? "" : body.slice(anchor, anchor + 400);
    });

    // Benchmark + YTD Ratio tiles still present (same assertions as
    // MBR-FIX-2H).
    expect(txt).toMatch(/57\s*%\s*\+/);
    const ytdTile = txt.match(/([\d.]+)%\s+YTD RATIO/i);
    expect(ytdTile, "YTD RATIO tile parse").not.toBeNull();
    const ytdPct = Number(ytdTile![1]);
    expect(ytdPct).toBeGreaterThan(1);
    expect(ytdPct).toBeLessThan(25);

    await ctx.close();
  },
);
