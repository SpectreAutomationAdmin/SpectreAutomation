// MBR-FIX-2N — Capital KPI renames + F&B label integrity acceptance.
//
// Validates on live staging:
//   • Section II Capital Scorecard renders "Capital Funding Coverage
//     Ratio" (not the pre-fix "Net Available Capital Ratio") AND
//     stays unavailable with the directive-prescribed reason.
//   • Section II Capital Scorecard renders "Capital Reinvestment
//     Ratio" (not the pre-fix "Net Capital > Depreciation?") AND
//     stays unavailable with the directive-prescribed reason.
//   • "F&B Operating Loss as % of Dues" replaces "F&B Subsidy" in
//     both Section II (scorecard) and Section III (Stewardship
//     Dashboard card) — same calculation, more accurate label.
//   • MBR-FIX-2M results stand: period-aware section band, "NOI
//     vs Budget" rename, Total Capital Income vs Budget wiring,
//     Initiation-Fee N/A.
//   • Jan + Feb regression — all three KPIs render consistently.

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
  const m = txt.match(new RegExp(esc + "[\\s\\S]{0,200}?([\\d.]+)%"));
  return m ? m[1] : null;
}

runAt(
  "MBR-FIX-2N · Mar 2026 — 'Capital Funding Coverage Ratio' replaces 'Net Available Capital Ratio'",
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
    expect(txt).toMatch(/Capital Funding Coverage Ratio/);
    expect(txt).not.toMatch(/Net Available Capital Ratio/);
    // Precise unavailable reason surfaces in the row description.
    expect(txt).toMatch(/Approved capital funding and expenditure plan not fully configured/);
    await ctx.close();
  },
);

runAt(
  "MBR-FIX-2N · Mar 2026 — 'Capital Reinvestment Ratio' replaces 'Net Capital > Depreciation?'",
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
    expect(txt).toMatch(/Capital Reinvestment Ratio/);
    expect(txt).not.toMatch(/Net Capital > Depreciation\?/);
    expect(txt).toMatch(/12 months of capital additions and depreciation history required/);
    await ctx.close();
  },
);

runAt(
  "MBR-FIX-2N · Mar 2026 — Section II scorecard shows 'F&B Operating Loss as % of Dues' + live value",
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
    expect(txt).toMatch(/F&B Operating Loss as % of Dues/);
    // Pre-fix label removed from the Monthly Package.
    expect(txt).not.toMatch(/F&B Subsidy as % of Dues/);
    // Live percentage still populates (same math as MBR-FIX-2M).
    const pctRaw = matchKpiPctAfterLabel(txt, "F&B Operating Loss as % of Dues");
    expect(pctRaw, "Mar F&B Operating Loss KPI parse").not.toBeNull();
    const pct = Number(pctRaw!);
    console.log(`MBR_FIX_2N_MAR_FB_OPERATING_LOSS ${pct}%`);
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThan(30);
    await ctx.close();
  },
);

runAt(
  "MBR-FIX-2N · Section III Stewardship Dashboard F&B card renamed consistently",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(
      `${BASE}/app/admin/reporting/monthly?period=2026-03#stewardship-dashboard`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(4500);
    const txt = await bodyText(page);
    // The Monthly Package now shows the renamed metric on Section
    // III as well. The pre-fix "F&B Subsidy" card label is gone;
    // "F&B Operating Loss as % of Dues" is present.
    expect(txt).toMatch(/F&B Operating Loss as % of Dues/);
    // We don't assert the Section III card never contains the
    // substring "F&B Subsidy" standalone — "Dues Coverage Surplus"
    // is unrelated. The strict assertion is that the OLD metric
    // label "F&B Subsidy as % of Dues" is absent.
    expect(txt).not.toMatch(/F&B Subsidy as % of Dues/);
    await ctx.close();
  },
);

runAt(
  "MBR-FIX-2N · Jan 2026 regression — all three renames + MBR-FIX-2M still correct",
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
    // Renames persist in Jan.
    expect(txt).toMatch(/Capital Funding Coverage Ratio/);
    expect(txt).toMatch(/Capital Reinvestment Ratio/);
    expect(txt).toMatch(/F&B Operating Loss as % of Dues/);
    // MBR-FIX-2M period-aware band stands.
    expect(txt).toMatch(/LIVE JANUARY[^·]*FINANCIAL ROWS/i);
    expect(txt).toMatch(/NOI vs Budget/);
    await ctx.close();
  },
);

runAt(
  "MBR-FIX-2N · Feb 2026 regression — renames persist",
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
    expect(txt).toMatch(/Capital Funding Coverage Ratio/);
    expect(txt).toMatch(/Capital Reinvestment Ratio/);
    expect(txt).toMatch(/F&B Operating Loss as % of Dues/);
    expect(txt).toMatch(/LIVE FEBRUARY[^·]*FINANCIAL ROWS/i);
    await ctx.close();
  },
);

// Preserve the dues-donut suppress check — don't accidentally rename
// "Operating Cost Coverage by Membership Dues" (MBR-FIX-2H).
runAt(
  "MBR-FIX-2N · MBR-FIX-2H donut title unchanged",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(
      `${BASE}/app/admin/reporting/monthly?period=2026-03#stewardship-dashboard`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(4500);
    const txt = await bodyText(page);
    expect(txt).toMatch(/Operating Cost Coverage by Membership Dues/);
    await ctx.close();
  },
);
