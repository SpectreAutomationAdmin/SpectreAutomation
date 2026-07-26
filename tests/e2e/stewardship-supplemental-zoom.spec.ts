import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";

// Captures the two supplemental cards (Department Net Performance +
// Dues Subsidy Analysis) at three admin viewports and verifies they
// stay aligned column-for-column with the rows above.

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

async function measure(page: Page) {
  return page.evaluate(() => {
    function r(n: number) { return Math.round(n * 100) / 100; }
    function rect(el: Element | null) {
      if (!el) return null;
      const b = (el as HTMLElement).getBoundingClientRect();
      return { x: r(b.x), w: r(b.width), right: r(b.x + b.width) };
    }
    const equity = document.querySelector("[data-testid='stewardship-equity']");
    const operate = document.querySelector("[data-testid='stewardship-operating']");
    const scOp = document.querySelector("[data-testid='stewardship-scorecard-operating']");
    const scCap = document.querySelector("[data-testid='stewardship-scorecard-capital']");
    const dept = document.querySelector("[data-testid='department-net-performance']");
    const dues = document.querySelector("[data-testid='dues-subsidy-analysis']");
    return {
      chartEquity: rect(equity),
      chartOperate: rect(operate),
      scorecardOp: rect(scOp),
      scorecardCap: rect(scCap),
      dept: rect(dept),
      dues: rect(dues),
    };
  });
}

test("supplemental cards render across viewports and align column-for-column with the rows above", async ({ page }) => {
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
    const row = page.locator("[data-testid='stewardship-supplemental']");
    await row.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await row.screenshot({ path: `test-results/stewardship-supplemental-zoom-${v.w}.png` });
    const m = await measure(page);
    report.push({ viewport: `${v.w}x${v.h}`, ...m });

    // Alignment invariants — the new row's two cards align with the
    // chart cards above (within 4 px).
    if (m.chartEquity && m.dept) {
      expect.soft(
        Math.abs(m.dept.x - m.chartEquity.x),
        `${v.w}: Department card left ↔ Equity chart left`,
      ).toBeLessThanOrEqual(4);
      expect.soft(
        Math.abs(m.dept.right - m.chartEquity.right),
        `${v.w}: Department card right ↔ Equity chart right`,
      ).toBeLessThanOrEqual(4);
    }
    if (m.chartOperate && m.dues) {
      expect.soft(
        Math.abs(m.dues.x - m.chartOperate.x),
        `${v.w}: Dues card left ↔ Operating chart left`,
      ).toBeLessThanOrEqual(4);
      expect.soft(
        Math.abs(m.dues.right - m.chartOperate.right),
        `${v.w}: Dues card right ↔ Operating chart right`,
      ).toBeLessThanOrEqual(4);
    }
    // And they align with the scorecards row directly above.
    if (m.scorecardOp && m.dept) {
      expect.soft(Math.abs(m.dept.x - m.scorecardOp.x), `${v.w}: Department ↔ Operating scorecard left`)
        .toBeLessThanOrEqual(4);
    }
    if (m.scorecardCap && m.dues) {
      expect.soft(Math.abs(m.dues.x - m.scorecardCap.x), `${v.w}: Dues ↔ Capital scorecard left`)
        .toBeLessThanOrEqual(4);
    }
  }

  writeFileSync(
    "test-results/stewardship-supplemental-alignment.json",
    JSON.stringify(report, null, 2),
    "utf8",
  );
});
