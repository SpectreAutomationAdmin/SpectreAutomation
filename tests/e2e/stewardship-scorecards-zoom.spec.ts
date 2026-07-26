import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";

// Zoomed screenshots of the two new Stewardship Scorecard cards
// (Operating + Capital) rendered beneath the chart pair in Chapter II.
// Captures evidence at three admin viewports and asserts the scorecard
// row stays aligned with the chart row above it.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

const VIEWPORTS = [
  { w: 1440, h: 900 },
  { w: 1920, h: 1080 },
  { w: 2560, h: 1440 },
];

async function alignmentMeasurement(page: Page) {
  return page.evaluate(() => {
    function r(n: number) { return Math.round(n * 100) / 100; }
    function rect(el: Element | null) {
      if (!el) return null;
      const b = (el as HTMLElement).getBoundingClientRect();
      return { x: r(b.x), w: r(b.width), right: r(b.x + b.width) };
    }
    const equity   = document.querySelector("[data-testid='stewardship-equity']");
    const operate  = document.querySelector("[data-testid='stewardship-operating']");
    const scOp     = document.querySelector("[data-testid='stewardship-scorecard-operating']");
    const scCap    = document.querySelector("[data-testid='stewardship-scorecard-capital']");
    return {
      chartEquity: rect(equity),
      chartOperate: rect(operate),
      scorecardOp: rect(scOp),
      scorecardCap: rect(scCap),
    };
  });
}

test("scorecards render across viewports and align with chart cards above", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.locator("[data-testid='reporting-chapter-financial-performance']").click();
  await page.waitForTimeout(800);

  const report: any[] = [];
  for (const v of VIEWPORTS) {
    await page.setViewportSize({ width: v.w, height: v.h });
    await page.waitForTimeout(300);
    const row = page.locator("[data-testid='stewardship-scorecards']");
    await row.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    // Visual evidence per viewport.
    await row.screenshot({
      path: `test-results/stewardship-scorecards-zoom-${v.w}.png`,
    });

    const m = await alignmentMeasurement(page);
    report.push({ viewport: `${v.w}x${v.h}`, ...m });

    // Alignment invariants: each scorecard's outer left edge matches
    // the chart card directly above it (within 4 px). Each scorecard's
    // right edge matches the corresponding chart card's right edge.
    if (m.chartEquity && m.scorecardOp) {
      expect.soft(
        Math.abs(m.scorecardOp.x - m.chartEquity.x),
        `${v.w}: Operating scorecard left ↔ Equity chart left`,
      ).toBeLessThanOrEqual(4);
      expect.soft(
        Math.abs(m.scorecardOp.right - m.chartEquity.right),
        `${v.w}: Operating scorecard right ↔ Equity chart right`,
      ).toBeLessThanOrEqual(4);
    }
    if (m.chartOperate && m.scorecardCap) {
      expect.soft(
        Math.abs(m.scorecardCap.x - m.chartOperate.x),
        `${v.w}: Capital scorecard left ↔ Operating chart left`,
      ).toBeLessThanOrEqual(4);
      expect.soft(
        Math.abs(m.scorecardCap.right - m.chartOperate.right),
        `${v.w}: Capital scorecard right ↔ Operating chart right`,
      ).toBeLessThanOrEqual(4);
    }
  }

  writeFileSync(
    "test-results/stewardship-scorecards-alignment.json",
    JSON.stringify(report, null, 2),
    "utf8",
  );
});
