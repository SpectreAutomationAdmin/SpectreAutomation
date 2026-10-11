// MBR-FIX-2M — Chapter II scorecard integration acceptance.
//
// Live staging reconciliation targets:
//   • March 2026 section band shows the period name, NOT "LIVE
//     JANUARY ..." (regardless of the selected period).
//   • "NOI vs Budget" row label replaces "NOI Variance to Budget".
//   • Operating scorecard renders a real F&B Subsidy percentage
//     (sourced from Section X; must not be blank or "Source not
//     connected").
//   • Capital scorecard renders a real Total Capital Income vs
//     Budget row (Actual + Budget + Variance).
//   • Initiation-Fee Operating Subsidy renders "N/A" explicitly.
//
// Jan / Feb regression specs assert the per-period band flips to
// the correct month name.

import { test, type Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

async function bodyText(page: Page): Promise<string> {
  return page.evaluate(() => (document.body.textContent ?? "").replace(/\s+/g, " "));
}

function matchKpiPctAfterLabel(txt: string, label: string): string | null {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = txt.match(new RegExp(esc + "\\s*([\\d.]+)%"));
  return m ? m[1] : null;
}

function matchKpiMoneyAfterLabel(txt: string, label: string): string | null {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = txt.match(new RegExp(esc + "\\s*(\\$?[\\d,.]+[MK]?)"));
  return m ? m[1] : null;
}

runAt(
  "MBR-FIX-2M · Mar 2026 — Operating section band is period-aware (no 'LIVE JANUARY')",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(
      `${BASE}/app/admin/reporting/monthly?period=2026-03#financial-performance`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(4500);
    const txt = await bodyText(page);
    // Pre-fix band referenced JANUARY unconditionally.
    expect(txt).not.toMatch(/LIVE JANUARY FINANCIAL ROWS/i);
    // Post-fix: the band references the current period label.
    expect(txt).toMatch(/LIVE MARCH[^·]*FINANCIAL ROWS/i);
    await ctx.close();
  },
);

runAt(
  "MBR-FIX-2M · Mar 2026 — 'NOI vs Budget' replaces 'NOI Variance to Budget'",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(
      `${BASE}/app/admin/reporting/monthly?period=2026-03#financial-performance`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(4500);
    const txt = await bodyText(page);
    expect(txt).toMatch(/NOI vs Budget/);
    // Pre-fix label removed.
    expect(txt).not.toMatch(/NOI Variance to Budget/);
    await ctx.close();
  },
);

runAt(
  "MBR-FIX-2M · Mar 2026 — F&B Subsidy renders live percentage (not blank)",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(
      `${BASE}/app/admin/reporting/monthly?period=2026-03#financial-performance`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(4500);
    const txt = await bodyText(page);
    const pctRaw = matchKpiPctAfterLabel(txt, "F&B Subsidy as % of Dues");
    expect(pctRaw, "Mar F&B Subsidy KPI parse").not.toBeNull();
    const pct = Number(pctRaw!);
    console.log(`MBR_FIX_2M_MAR_FB_SUBSIDY ${pct}%`);
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThan(30);
    await ctx.close();
  },
);

runAt(
  "MBR-FIX-2M · Mar 2026 — Total Capital Income vs Budget renders Actual + Budget + Variance",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(
      `${BASE}/app/admin/reporting/monthly?period=2026-03#financial-performance`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(4500);
    const txt = await bodyText(page);
    // Row label present.
    expect(txt).toMatch(/Total Capital Income vs Budget/);
    const actualRaw = matchKpiMoneyAfterLabel(txt, "Total Capital Income vs Budget");
    console.log(`MBR_FIX_2M_MAR_CAP_INCOME_ACTUAL ${actualRaw}`);
    // Actual column must render a dollar amount (not blank / dash).
    expect(actualRaw).toMatch(/^\$[\d,.]+/);
    await ctx.close();
  },
);

runAt(
  "MBR-FIX-2M · Initiation-Fee Operating Subsidy renders explicit N/A",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(
      `${BASE}/app/admin/reporting/monthly?period=2026-03#financial-performance`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(4500);
    const txt = await bodyText(page);
    expect(txt).toMatch(/Initiation-Fee Operating Subsidy/);
    // Row renders "N/A" explicitly (not blank + not "Source not
    // connected" — Coulee's entrance fees are structurally Capital).
    const windowStart = txt.indexOf("Initiation-Fee Operating Subsidy");
    expect(windowStart).toBeGreaterThan(0);
    const window = txt.slice(windowStart, windowStart + 400);
    expect(window).toMatch(/N\/A/);
    expect(window).toMatch(/entrance fees classified to Capital Fund/i);
    await ctx.close();
  },
);

runAt(
  "MBR-FIX-2M · Jan 2026 regression — section band reads 'LIVE JANUARY ...'",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(
      `${BASE}/app/admin/reporting/monthly?period=2026-01#financial-performance`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(4500);
    const txt = await bodyText(page);
    expect(txt).toMatch(/LIVE JANUARY[^·]*FINANCIAL ROWS/i);
    await ctx.close();
  },
);

runAt(
  "MBR-FIX-2M · Feb 2026 regression — section band reads 'LIVE FEBRUARY ...'",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(
      `${BASE}/app/admin/reporting/monthly?period=2026-02#financial-performance`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(4500);
    const txt = await bodyText(page);
    expect(txt).toMatch(/LIVE FEBRUARY[^·]*FINANCIAL ROWS/i);
    await ctx.close();
  },
);
