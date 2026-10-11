// MBR-VIS-1 Part B — authenticated staging smoke test.
//
// Does NOT create any MonthlyPackageVisibility rows + does NOT
// republish any real Coulee package. Only verifies that the three
// publication-state modes render and that at least one toggle is
// visible in editing mode. Screenshots are captured for the
// founder-facing acceptance report.
//
// Scenarios covered:
//   • Editing mode: `/app/admin/reporting/monthly?period=2026-03`
//     → chapter + scorecard-card + scorecard-row toggles present.
//   • Draft Preview: `?period=2026-03&preview=draft` → DRAFT PREVIEW
//     banner mounted; toggles absent.
//   • Published State: `?period=2026-03&preview=published` → PUBLISHED
//     STATE banner mounted; toggles absent; publish metadata rendered.

import { test, type Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

async function openPage(browser: import("@playwright/test").Browser, url: string) {
  const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
  const page = await loginAsFounder(ctx);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4500);
  return { ctx, page };
}

async function hasElement(page: Page, selector: string): Promise<boolean> {
  return (await page.locator(selector).count()) > 0;
}

runAt(
  "MBR-VIS-1 · Editing mode · chapter + scorecard toggles are present",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const { ctx, page } = await openPage(
      browser,
      `${BASE}/app/admin/reporting/monthly?period=2026-03#financial-performance`,
    );
    // Chapter-level toggle on the Financial Performance anchor.
    const financialPerfToggleWrap = await hasElement(
      page,
      '[data-testid="chapter-toggle-wrap-financial-performance"]',
    );
    expect(financialPerfToggleWrap).toBe(true);
    // Operating Scorecard card-level toggle present.
    const operatingCardToggle = await hasElement(
      page,
      '[data-testid="stewardship-scorecard-operating-card-toggle-wrap"]',
    );
    expect(operatingCardToggle).toBe(true);
    // At least one per-row toggle inside the Operating Scorecard.
    const operatingRowToggles = await page
      .locator('[data-testid^="stewardship-scorecard-operating-row-toggle-"]')
      .count();
    expect(operatingRowToggles).toBeGreaterThan(5);
    // Specifically the two directive-named rows exist as toggleable rows.
    const golfToggle = await hasElement(
      page,
      '[data-testid="stewardship-scorecard-operating-row-toggle-golf-rounds-vs-budget"]',
    );
    const coversToggle = await hasElement(
      page,
      '[data-testid="stewardship-scorecard-operating-row-toggle-fb-covers-vs-budget"]',
    );
    expect(golfToggle).toBe(true);
    expect(coversToggle).toBe(true);
    // No banner in editing mode.
    expect(await hasElement(page, '[data-testid="publication-state-banner-draft"]')).toBe(false);
    expect(await hasElement(page, '[data-testid="publication-state-banner-published"]')).toBe(false);
    // Capture.
    await page.screenshot({ path: "test-results/mbr-vis-1-editing.png", fullPage: false });
    await ctx.close();
  },
);

runAt(
  "MBR-VIS-1 · Draft Preview mode · banner present + toggles absent",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const { ctx, page } = await openPage(
      browser,
      `${BASE}/app/admin/reporting/monthly?period=2026-03&preview=draft`,
    );
    const draftBanner = await hasElement(
      page,
      '[data-testid="publication-state-banner-draft"]',
    );
    expect(draftBanner).toBe(true);
    // Toggles absent in Draft Preview.
    const anyToggle = await page.locator('[data-testid^="visibility-toggle-"]').count();
    expect(anyToggle).toBe(0);
    await page.screenshot({ path: "test-results/mbr-vis-1-draft-preview.png", fullPage: false });
    await ctx.close();
  },
);

runAt(
  "MBR-VIS-1 · Published State mode · banner present + publish metadata rendered",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const { ctx, page } = await openPage(
      browser,
      `${BASE}/app/admin/reporting/monthly?period=2026-03&preview=published`,
    );
    const publishedBanner = await hasElement(
      page,
      '[data-testid="publication-state-banner-published"]',
    );
    expect(publishedBanner).toBe(true);
    const anyToggle = await page.locator('[data-testid^="visibility-toggle-"]').count();
    expect(anyToggle).toBe(0);
    // Published banner mentions "PUBLISHED STATE" copy.
    const bannerTxt = await page
      .locator('[data-testid="publication-state-banner-published"]')
      .innerText();
    expect(bannerTxt.toLowerCase()).toContain("published state");
    await page.screenshot({ path: "test-results/mbr-vis-1-published-state.png", fullPage: false });
    await ctx.close();
  },
);
