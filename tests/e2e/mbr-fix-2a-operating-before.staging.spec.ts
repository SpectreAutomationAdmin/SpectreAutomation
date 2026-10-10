// MBR-FIX-2A — capture BEFORE state of the Operating Results
// 12-Month Rolling Trend chart on live staging.  READ-ONLY.

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

async function captureOperating(page: Page, label: string) {
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-02`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  const card = page.locator('[data-testid="stewardship-operating"]').first();
  await card.waitFor({ state: "attached", timeout: 20_000 });
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const txt = (await card.innerText()).replace(/\s+/g, " ").trim();
  console.log(`MBR_FIX_2A_${label}_OPERATING_TEXT ${txt.slice(0, 2000)}`);
  await card.screenshot({ path: `test-results/mbr-fix-2a-operating-${label}.png` });
  // Also probe the SVG bars for the primary series — count non-zero bars.
  const probe = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="stewardship-operating"]');
    if (!card) return { bars: 0, overlayPresent: false };
    const bars = card.querySelectorAll('rect');
    let visible = 0;
    bars.forEach((r) => {
      const h = parseFloat(r.getAttribute("height") || "0");
      if (h > 1) visible++;
    });
    const paths = card.querySelectorAll('path[stroke-dasharray]');
    return { bars: visible, overlayPresent: paths.length > 0 };
  });
  console.log(`MBR_FIX_2A_${label}_PROBE bars=${probe.bars} overlay=${probe.overlayPresent}`);
}

runAt("MBR-FIX-2A · BEFORE · Operating Results on Feb 2026 (live)", async ({ browser }) => {
  test.setTimeout(300_000);
  const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
  const page = await loginAsFounder(ctx);
  await captureOperating(page, "before");
  await ctx.close();
});
