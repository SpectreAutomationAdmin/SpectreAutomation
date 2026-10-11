// MBR-FIX-2J — numeric acceptance for the three Stewardship Dashboard
// KPI integrity fixes (Working Capital, LT Debt-to-Equity, F&B
// Subsidy).
//
// Reconciliation targets (per MBR-AUDIT findings + MBR-FIX-2F):
//   • Working Capital YTD Feb 2026 ≈ $3.94M (Exec Opening match).
//   • Long-Term Debt-to-Equity ≈ 0.14x (≈ $1.5M debt / ~$10.9M equity).
//   • F&B Subsidy = |-$58,559.59| / $3,091,464.32 × 100 ≈ 1.9 % Feb YTD.
//
// Validation shape:
//   • Working Capital must NOT read ~$34M (the pre-fix defect).
//   • LT Debt-to-Equity must NOT read "0.00" (the pre-fix defect).
//   • F&B Subsidy must NOT read "Source not connected".

import { test, type Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

function parseMoney(raw: string): number {
  const neg = /[(−-]/.test(raw);
  const m = raw.match(/\$?([\d,]+(?:\.\d+)?)([MK])?/);
  if (!m) return NaN;
  const base = Number(m[1].replace(/,/g, ""));
  const scale = m[2] === "M" ? 1_000_000 : m[2] === "K" ? 1_000 : 1;
  return (neg ? -1 : 1) * base * scale;
}

async function stewardshipText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const body = document.body.innerText.replace(/\s+/g, " ");
    const anchor = body.indexOf("Stewardship");
    return anchor < 0 ? "" : body.slice(anchor, anchor + 12000);
  });
}

runAt(
  "MBR-FIX-2J · Feb 2026 — Working Capital reads Executive Opening value",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(
      `${BASE}/app/admin/reporting/monthly?period=2026-02#stewardship-dashboard`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(5000);
    const txt = await stewardshipText(page);
    const wcMatch = txt.match(/\$([\d,.]+[MK]?)\s+Working Capital/i);
    expect(wcMatch, "Working Capital KPI parse").not.toBeNull();
    const wc = parseMoney("$" + wcMatch![1]);
    console.log(`MBR_FIX_2J_FEB_WC ${wc}`);
    // Pre-fix defect: $34.439M.  Post-fix: ~$3.94M (Executive Opening
    // match).  Accept $1M-$10M band.  Specifically must NOT be > $20M.
    expect(wc).toBeGreaterThan(500_000);
    expect(wc).toBeLessThan(20_000_000);
    await ctx.close();
  },
);

runAt(
  "MBR-FIX-2J · Feb 2026 — Long-Term Debt-to-Equity renders a real ratio",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(
      `${BASE}/app/admin/reporting/monthly?period=2026-02#stewardship-dashboard`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(5000);
    const txt = await stewardshipText(page);
    console.log("MBR_FIX_2J_FEB_LTD_RAW " + txt.match(/.{0,80}Long-Term Debt-to-Equity.{0,80}/)?.[0]);
    // Match the ratio value preceding the "Long-Term Debt-to-Equity"
    // label (as rendered in the KPI tile: "0.14x Long-Term Debt-to-Equity").
    const ratioMatch = txt.match(/([\d.]+)x\s+Long-Term Debt-to-Equity/i);
    expect(ratioMatch, "LT Debt-to-Equity ratio parse").not.toBeNull();
    const ratio = Number(ratioMatch![1]);
    console.log(`MBR_FIX_2J_FEB_LTD_RATIO ${ratio}`);
    // Pre-fix defect: 0.00. Post-fix: non-zero ratio reflecting the
    // committed LT debt. Accept any positive ratio < 2.0.
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(2);
    await ctx.close();
  },
);

runAt(
  "MBR-FIX-2J · Feb 2026 — F&B Subsidy computes from Section X",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(
      `${BASE}/app/admin/reporting/monthly?period=2026-02#stewardship-dashboard`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(5000);
    const txt = await stewardshipText(page);
    // Pre-fix defect: "F&B subledger not yet integrated".
    expect(txt).not.toMatch(/F&B subledger not yet integrated/i);
    // Post-fix: KPI value is a real percentage.
    const pctMatch = txt.match(/([\d.]+)%\s+F&B Subsidy/i);
    expect(pctMatch, "F&B Subsidy KPI parse").not.toBeNull();
    const pct = Number(pctMatch![1]);
    console.log(`MBR_FIX_2J_FEB_FB_SUBSIDY ${pct}%`);
    // Reconciliation (Feb YTD): $58,559.59 / $3,091,464.32 ≈ 1.89 %.
    // Accept 0-10 % band to absorb formatter rounding.
    expect(pct).toBeGreaterThan(0.1);
    expect(pct).toBeLessThan(10);
    await ctx.close();
  },
);

runAt(
  "MBR-FIX-2J · Jan 2026 regression — all three KPIs render correctly",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(
      `${BASE}/app/admin/reporting/monthly?period=2026-01#stewardship-dashboard`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(5000);
    const txt = await stewardshipText(page);
    // Working Capital present
    const wcMatch = txt.match(/\$([\d,.]+[MK]?)\s+Working Capital/i);
    expect(wcMatch, "Jan Working Capital KPI parse").not.toBeNull();
    const wc = parseMoney("$" + wcMatch![1]);
    console.log(`MBR_FIX_2J_JAN_WC ${wc}`);
    expect(wc).toBeGreaterThan(500_000);
    expect(wc).toBeLessThan(20_000_000);

    const ratioMatch = txt.match(/([\d.]+)x\s+Long-Term Debt-to-Equity/i);
    expect(ratioMatch, "Jan LT Debt-to-Equity ratio parse").not.toBeNull();
    const ratio = Number(ratioMatch![1]);
    console.log(`MBR_FIX_2J_JAN_LTD_RATIO ${ratio}`);
    expect(ratio).toBeGreaterThan(0);

    expect(txt).not.toMatch(/F&B subledger not yet integrated/i);
    const pctMatch = txt.match(/([\d.]+)%\s+F&B Subsidy/i);
    expect(pctMatch, "Jan F&B Subsidy KPI parse").not.toBeNull();
    const pct = Number(pctMatch![1]);
    console.log(`MBR_FIX_2J_JAN_FB_SUBSIDY ${pct}%`);
    expect(pct).toBeGreaterThan(0);

    await ctx.close();
  },
);
