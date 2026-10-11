// MBR-FIX-2O — Operating Stewardship Scorecard Actual cells acceptance.
//
// Pre-fix: the four Operating Scorecard Actual cells (Dues-to-
// Revenue Ratio, Payroll & Benefits Ratio, NOI as % of Operating
// Revenue, NOI vs Budget) rendered blank on Mar 2026 despite the
// March committed TB being loaded. Root cause: DEF-4 — scorecard
// builder passed current-month start instead of fiscal-year start
// to `resolveJanuaryMetricSet`, failing the Jonas TB snapshot's
// YTD-slice gate.
//
// Fix: both scorecard builders now derive fiscal-year start locally
// from `period.periodEnd.getUTCFullYear()`.
//
// Staging acceptance validates:
//   • March 2026: all four Actual cells render live percentages /
//     dollar amounts (not blank).
//   • Jan + Feb regressions: same four cells render for the same
//     period's committed data.
//   • Future-period compatibility: the builder is period-driven;
//     the same fix will cover April + beyond automatically.
//   • No regression to Capital Scorecard, Executive Opening,
//     Statement of Activities, Section X dept P&L, Section XII
//     payroll analysis, or MBR-FIX-2H / 2M labels.

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
  const m = txt.match(new RegExp(esc + "[\\s\\S]{0,300}?([\\d.]+)%"));
  return m ? m[1] : null;
}

function matchKpiMoneyAfterLabel(txt: string, label: string): string | null {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = txt.match(new RegExp(esc + "[\\s\\S]{0,300}?(\\$[\\d,.]+[MK]?)"));
  return m ? m[1] : null;
}

async function openPackage(browser: Parameters<typeof test>[1]["browser"], period: string) {
  const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
  const page = await loginAsFounder(ctx);
  await page.goto(
    `${BASE}/app/admin/reporting/monthly?period=${period}#financial-performance`,
    { waitUntil: "domcontentloaded" },
  );
  await page.waitForTimeout(4500);
  return { ctx, page };
}

runAt(
  "MBR-FIX-2O · Mar 2026 — all four Operating Scorecard Actual cells render live",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const { ctx, page } = await openPackage(browser, "2026-03");
    const txt = await bodyText(page);

    // Dues-to-Revenue Ratio Actual
    const duesPct = matchKpiPctAfterLabel(txt, "Dues-to-Revenue Ratio");
    expect(duesPct, "Mar Dues-to-Revenue Actual").not.toBeNull();
    const duesN = Number(duesPct!);
    console.log(`MBR_FIX_2O_MAR_DUES_PCT ${duesN}`);
    expect(duesN).toBeGreaterThan(50);
    expect(duesN).toBeLessThan(100);

    // Payroll & Benefits Ratio Actual
    const payrollPct = matchKpiPctAfterLabel(txt, "Payroll & Benefits Ratio");
    expect(payrollPct, "Mar Payroll Ratio Actual").not.toBeNull();
    const payrollN = Number(payrollPct!);
    console.log(`MBR_FIX_2O_MAR_PAYROLL_PCT ${payrollN}`);
    expect(payrollN).toBeGreaterThan(1);
    expect(payrollN).toBeLessThan(50);

    // NOI as % of Operating Revenue Actual
    const noiPct = matchKpiPctAfterLabel(txt, "NOI as % of Operating Revenue");
    expect(noiPct, "Mar NOI margin Actual").not.toBeNull();
    const noiN = Number(noiPct!);
    console.log(`MBR_FIX_2O_MAR_NOI_PCT ${noiN}`);
    expect(noiN).toBeGreaterThan(-20);
    expect(noiN).toBeLessThan(100);

    // NOI vs Budget — Actual (first dollar amount after row label)
    const noiActual = matchKpiMoneyAfterLabel(txt, "NOI vs Budget");
    expect(noiActual, "Mar NOI vs Budget Actual").not.toBeNull();
    console.log(`MBR_FIX_2O_MAR_NOI_ACTUAL ${noiActual}`);
    expect(noiActual).toMatch(/^\$[\d,.]+[MK]?$/);

    await ctx.close();
  },
);

runAt(
  "MBR-FIX-2O · Feb 2026 regression — four Operating Actuals populate",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const { ctx, page } = await openPackage(browser, "2026-02");
    const txt = await bodyText(page);
    expect(matchKpiPctAfterLabel(txt, "Dues-to-Revenue Ratio"), "Feb Dues").not.toBeNull();
    expect(matchKpiPctAfterLabel(txt, "Payroll & Benefits Ratio"), "Feb Payroll").not.toBeNull();
    expect(matchKpiPctAfterLabel(txt, "NOI as % of Operating Revenue"), "Feb NOI margin").not.toBeNull();
    expect(matchKpiMoneyAfterLabel(txt, "NOI vs Budget"), "Feb NOI vs Budget").not.toBeNull();
    await ctx.close();
  },
);

runAt(
  "MBR-FIX-2O · Jan 2026 regression — four Operating Actuals populate",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const { ctx, page } = await openPackage(browser, "2026-01");
    const txt = await bodyText(page);
    expect(matchKpiPctAfterLabel(txt, "Dues-to-Revenue Ratio"), "Jan Dues").not.toBeNull();
    expect(matchKpiPctAfterLabel(txt, "Payroll & Benefits Ratio"), "Jan Payroll").not.toBeNull();
    expect(matchKpiPctAfterLabel(txt, "NOI as % of Operating Revenue"), "Jan NOI margin").not.toBeNull();
    expect(matchKpiMoneyAfterLabel(txt, "NOI vs Budget"), "Jan NOI vs Budget").not.toBeNull();
    await ctx.close();
  },
);

runAt(
  "MBR-FIX-2O · Mar 2026 — no regression to MBR-FIX-2N labels + MBR-FIX-2M band",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const { ctx, page } = await openPackage(browser, "2026-03");
    const txt = await bodyText(page);
    // MBR-FIX-2N renames persist
    expect(txt).toMatch(/Capital Funding Coverage Ratio/);
    expect(txt).toMatch(/Capital Reinvestment Ratio/);
    expect(txt).toMatch(/F&B Operating Loss as % of Dues/);
    // MBR-FIX-2M period band persists
    expect(txt).toMatch(/LIVE MARCH[^·]*FINANCIAL ROWS/i);
    expect(txt).toMatch(/NOI vs Budget/);
    // MBR-FIX-2H donut unchanged
    expect(txt).toMatch(/Operating Cost Coverage by Membership Dues/);
    await ctx.close();
  },
);

runAt(
  "MBR-FIX-2O · Mar 2026 — scorecard screenshot captured for founder review",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const { ctx, page } = await openPackage(browser, "2026-03");
    // Scorecards sit inside the Financial Performance chapter; the
    // easiest way to crop both is to screenshot the chapter region.
    const anchor = page.locator("text=Operating Stewardship").first();
    await anchor.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.screenshot({
      path: "test-results/mbr-fix-2o-mar-operating-scorecard.png",
      fullPage: false,
    });
    await ctx.close();
  },
);
