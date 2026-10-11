// MBR-FIX-2H — numeric acceptance for Chair's Dashboard visual
// stewardship pair:
//
//   • Dues Subsidy Analysis donut → now "Operating Cost Coverage
//     by Membership Dues" (per founder authorization 2026-10-10).
//   • Payroll Ratio — Monthly Trend chart.
//
// Pre-fix: on Feb 2026 Coulee both cards rendered as empty /
// unavailable because the live-tenant branches passed zero-input
// stubs.
//
// Live acceptance:
//   • Donut KPI tiles show real operating-dues YTD + a Coverage
//     slice sum that equals 100 %.
//   • Donut title reads "Operating Cost Coverage by Membership Dues".
//   • Payroll Ratio Monthly Trend KPIs show a real YTD ratio ≠ 0 %.
//   • Benchmark KPI reads "57 %+" (config threshold).
//   • Jan 2026 regression: both cards also render live.

import { test, type Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

function parsePct(raw: string): number {
  const m = raw.match(/([\d.]+)%/);
  return m ? Number(m[1]) : NaN;
}

function parseMoney(raw: string): number {
  const neg = /[(−-]/.test(raw);
  const m = raw.match(/\$?([\d,]+(?:\.\d+)?)([MK])?/);
  if (!m) return NaN;
  const base = Number(m[1].replace(/,/g, ""));
  const scale = m[2] === "M" ? 1_000_000 : m[2] === "K" ? 1_000 : 1;
  return (neg ? -1 : 1) * base * scale;
}

async function duesSubsidyText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="dues-subsidy-analysis"]');
    return el ? (el as HTMLElement).innerText.replace(/\s+/g, " ") : "";
  });
}

async function payrollTrendText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const body = document.body.innerText.replace(/\s+/g, " ");
    const anchor = body.indexOf("Payroll Ratio");
    if (anchor < 0) return "";
    return body.slice(anchor, anchor + 1200);
  });
}

runAt(
  "MBR-FIX-2H · Feb 2026 — Operating Cost Coverage donut renders live",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(
      `${BASE}/app/admin/reporting/monthly?period=2026-02#stewardship-dashboard`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(4500);

    const txt = await duesSubsidyText(page);
    console.log("MBR_FIX_2H_FEB_DUES " + txt.slice(0, 1500));

    // Coverage semantic title present.
    expect(txt).toContain("Operating Cost Coverage by Membership Dues");

    // Operating Dues YTD KPI ≠ "$0" / "—".  Feb YTD operating dues
    // ≈ $3.09M per MBR-FIX-2G reconciliation.
    const duesMatch = txt.match(/\$([\d,.]+[KM])/);
    expect(duesMatch, "Operating Dues KPI parse").not.toBeNull();
    const duesYtd = parseMoney("$" + duesMatch![1]);
    console.log(`MBR_FIX_2H_FEB_OPDUES_YTD ${duesYtd}`);
    expect(duesYtd).toBeGreaterThan(500_000);

    // Coverage surplus slice OR shortfall slice must be present
    // in the legend text (one of the two is always emitted so the
    // donut whole sums to 100 %).
    const hasSurplus = /Dues Coverage Surplus/i.test(txt);
    const hasShortfall = /Operating Shortfall/i.test(txt);
    expect(hasSurplus || hasShortfall).toBe(true);

    // No "Unavailable" presentation remains.
    expect(txt).not.toMatch(/^Unavailable/);

    await ctx.close();
  },
);

runAt(
  "MBR-FIX-2H · Feb 2026 — Payroll Ratio Monthly Trend renders live KPIs",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(
      `${BASE}/app/admin/reporting/monthly?period=2026-02#stewardship-dashboard`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(4500);

    const txt = await payrollTrendText(page);
    console.log("MBR_FIX_2H_FEB_TREND " + txt.slice(0, 800));

    // Chart title present.
    expect(txt.toLowerCase()).toContain("payroll ratio");

    // Benchmark tile reads "57%+" (config threshold).
    expect(txt).toMatch(/57\s*%\s*\+/);

    // The YTD Ratio KPI tile must NOT be "0.0%".  Feb YTD payroll
    // ratio ≈ 10.95% per the MBR-FIX-2G reconciliation; the live
    // builder emits YTD-avg-of-monthlies, which lands around 8-11%
    // for Feb (Jan 5.2 %, Feb 11.0 %).  Accept 1-25% band for the
    // specific YTD RATIO tile value — the regex anchors on the
    // label so the commentary's dues-ratio (~96%) doesn't false-
    // positive the matcher.
    const ytdTileMatch = txt.match(/([\d.]+)%\s+YTD RATIO/i);
    expect(ytdTileMatch, "YTD Ratio KPI tile parse").not.toBeNull();
    const ytdTile = parsePct(ytdTileMatch![0]);
    console.log(`MBR_FIX_2H_FEB_TREND_YTD ${ytdTile}`);
    expect(ytdTile).toBeGreaterThan(1);
    expect(ytdTile).toBeLessThan(25);

    await ctx.close();
  },
);

runAt(
  "MBR-FIX-2H · Jan 2026 regression guard — both cards render live",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
    const page = await loginAsFounder(ctx);
    await page.goto(
      `${BASE}/app/admin/reporting/monthly?period=2026-01#stewardship-dashboard`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(4500);

    const dues = await duesSubsidyText(page);
    const trend = await payrollTrendText(page);
    console.log("MBR_FIX_2H_JAN_DUES " + dues.slice(0, 800));
    console.log("MBR_FIX_2H_JAN_TREND " + trend.slice(0, 800));

    expect(dues).toContain("Operating Cost Coverage by Membership Dues");
    expect(dues).toMatch(/Dues Coverage Surplus|Operating Shortfall/);
    expect(trend.toLowerCase()).toContain("payroll ratio");
    expect(trend).toMatch(/57\s*%\s*\+/);

    await ctx.close();
  },
);
