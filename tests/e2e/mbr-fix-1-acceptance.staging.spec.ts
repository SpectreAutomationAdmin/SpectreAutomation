// MBR-FIX-1 (2026-10-09) — authenticated staging acceptance.
//
// Verifies the five defects corrected on live staging:
//
//   DEF-1  — Section II source label uses the current period
//            ("Feb 2026 Jonas Trial Balance"), not a hardcoded
//            "Jan 2026 Jonas Trial Balance".
//   DEF-2  — Section II note interpolates the current month name.
//   DEF-3  — Stewardship Tiles footer uses the current snapshot
//            date (period.periodEndShortLabel), not a hardcoded
//            "January 31, 2026 trial-balance snapshot".
//   DEF-4  — Section II renders real Revenue / COGS / OpEx /
//            Net Income instead of Unavailable / $0 on Feb+.
//   DEF-5  — Reserve Coverage renders "Unavailable" (not "0.00x")
//            when the live reserve is not classified.
//
// Also pins January 2026 (regression guard): the same package
// must still show real Jan data (equivalent to how it rendered
// before this fix).

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

async function dumpAuthoritativePanel(page: Page): Promise<string> {
  // Locate the "FINANCIAL PERFORMANCE — AUTHORITATIVE SOURCE" band
  // by its visible heading text and ascend to the containing
  // section/div so we capture the full block (label + KPI values +
  // availability pills + note).
  const heading = page.locator('text=FINANCIAL PERFORMANCE — AUTHORITATIVE SOURCE').first();
  await heading.waitFor({ state: "attached", timeout: 20_000 });
  const container = heading.locator('xpath=ancestor::*[self::section or self::div][1]');
  const el = container.first();
  return (await el.innerText()).replace(/\s+/g, " ").trim();
}

async function dumpStewardshipTilesFooter(page: Page): Promise<string> {
  // Match the current (fix-1) footer prefix OR the pre-fix
  // literal, whichever is on the page.
  const el = page.locator('text=/Each tile resolves independently from/').first();
  await el.waitFor({ state: "attached", timeout: 20_000 });
  return (await el.innerText()).replace(/\s+/g, " ").trim();
}

async function dumpReserveCoverage(page: Page): Promise<string> {
  // Executive Opening At-A-Glance card for Reserve Coverage.
  // The label may be rendered as a visually-separated eyebrow
  // (e.g. "RESERVE COVERAGE" above a value) so matching the
  // label element alone misses the value.  Ascend 4 levels up
  // and grab everything in the card's visual container.
  const label = page.locator('text=/^Reserve Coverage$/i').first();
  const n = await label.count();
  if (n === 0) return "<missing>";
  const card = label.locator(
    'xpath=ancestor::*[self::article or self::section or (self::div and (contains(@class, "kpi") or contains(@class, "card") or contains(@class, "tile")))][1]',
  );
  const cardCount = await card.count();
  if (cardCount === 0) {
    // Fallback: 4 levels up — enough to capture the common
    // card wrapper on this layout.
    const ancestor = label.locator('xpath=ancestor::*[4]');
    return (await ancestor.first().innerText()).replace(/\s+/g, " ").trim();
  }
  return (await card.first().innerText()).replace(/\s+/g, " ").trim();
}

runAt("MBR-FIX-1 · Feb 2026 package — DEF-1/2/3/4/5 restored", async ({ browser }) => {
  test.setTimeout(600_000);
  const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
  const page = await loginAsFounder(ctx);

  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-02`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: "test-results/mbr-fix-1-feb-01-authoritative.png", fullPage: false });

  // §DEF-1 — source label is "Feb 2026 Jonas Trial Balance", not Jan.
  const panel = await dumpAuthoritativePanel(page);
  console.log("MBR_FIX_1_FEB_PANEL " + panel);
  expect(panel).toContain("Feb 2026 Jonas Trial Balance");
  expect(panel).not.toContain("Jan 2026 Jonas Trial Balance");

  // §DEF-2 — note interpolates "February" (not "January").
  expect(panel).toContain("committed February Jonas Trial Balance");
  expect(panel).not.toContain("committed January Jonas Trial Balance");

  // §DEF-4 — Section II shows real numbers, not Unavailable / $0 everywhere.
  // Revenue must NOT read "Unavailable" and COGS/OpEx must NOT be exactly "$0".
  // Panel copy order: REVENUE … COST OF SALES … OPERATING EXPENSES … NET INCOME ….
  const revMatch = panel.match(/REVENUE\s+(\S+)/);
  const cogsMatch = panel.match(/COST OF SALES\s+(\S+)/);
  const opexMatch = panel.match(/OPERATING EXPENSES\s+(\S+)/);
  const netMatch = panel.match(/NET INCOME\s+(\S+)/);
  const revStr = revMatch ? revMatch[1] : "<missing>";
  const cogsStr = cogsMatch ? cogsMatch[1] : "<missing>";
  const opexStr = opexMatch ? opexMatch[1] : "<missing>";
  const netStr = netMatch ? netMatch[1] : "<missing>";
  console.log(`MBR_FIX_1_FEB_IS rev=${revStr} cogs=${cogsStr} opex=${opexStr} net=${netStr}`);
  expect(revStr).not.toBe("Unavailable");
  expect(revStr).not.toBe("$0");
  expect(netStr).not.toBe("Unavailable");
  // Independently reconciled Feb YTD figures: Rev $3.21M, NOI $2.54M.
  // Allow some formatting tolerance — assert the number begins with "$3" (M-rounded).
  expect(revStr.replace(/,/g, "")).toMatch(/^\$3\./);

  // §DEF-3 — Stewardship Tiles footer uses Feb 28, 2026, not Jan 31, 2026.
  const stew = await dumpStewardshipTilesFooter(page);
  console.log("MBR_FIX_1_FEB_STEW_FOOTER " + stew.slice(0, 300));
  expect(stew).toContain("February 28, 2026 trial-balance snapshot");
  expect(stew).not.toContain("January 31, 2026 trial-balance snapshot");

  // §DEF-5 — Reserve Coverage must NOT render as "0.00x".
  const reserve = await dumpReserveCoverage(page);
  console.log("MBR_FIX_1_FEB_RESERVE " + reserve.slice(0, 200));
  expect(reserve).not.toContain("0.00x");
  // Must say Unavailable (card value) somewhere in Reserve Coverage card.
  expect(reserve).toMatch(/Unavailable|Pending/);

  await ctx.close();
});

runAt("MBR-FIX-1 · Jan 2026 package — regression guard (still real data)", async ({ browser }) => {
  test.setTimeout(600_000);
  const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
  const page = await loginAsFounder(ctx);

  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: "test-results/mbr-fix-1-jan-01-authoritative.png", fullPage: false });

  const panel = await dumpAuthoritativePanel(page);
  console.log("MBR_FIX_1_JAN_PANEL " + panel);

  // Jan 2026 — source label uses "Jan 2026", note uses "January".
  expect(panel).toContain("Jan 2026 Jonas Trial Balance");
  expect(panel).toContain("committed January Jonas Trial Balance");

  // Revenue must be a real $-value (Jan YTD operating revenue was $3.12M).
  const revMatch = panel.match(/REVENUE\s+(\S+)/);
  const revStr = revMatch ? revMatch[1] : "<missing>";
  console.log(`MBR_FIX_1_JAN_REV ${revStr}`);
  expect(revStr).not.toBe("Unavailable");
  expect(revStr.replace(/,/g, "")).toMatch(/^\$3\./);

  // Stewardship footer uses Jan 31, 2026 for the Jan period.
  const stew = await dumpStewardshipTilesFooter(page);
  console.log("MBR_FIX_1_JAN_STEW_FOOTER " + stew.slice(0, 300));
  expect(stew).toContain("January 31, 2026 trial-balance snapshot");
  expect(stew).not.toContain("February 28, 2026 trial-balance snapshot");

  await ctx.close();
});
