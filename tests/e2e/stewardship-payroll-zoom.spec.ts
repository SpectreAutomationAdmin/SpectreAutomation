import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";

// Captures the two new payroll cards at 1440 / 1920 / 2560 and
// asserts they stay aligned column-for-column with the rows above
// them (Equity chart, scorecards, supplemental — all 4 rows share the
// same two-column geometry).

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
    const dept     = document.querySelector("[data-testid='department-net-performance']");
    const dues     = document.querySelector("[data-testid='dues-subsidy-analysis']");
    const payrollD = document.querySelector("[data-testid='payroll-department']");
    const payrollT = document.querySelector("[data-testid='payroll-ratio-trend']");
    return {
      equity:   rect(equity),
      operate:  rect(operate),
      dept:     rect(dept),
      dues:     rect(dues),
      payrollD: rect(payrollD),
      payrollT: rect(payrollT),
    };
  });
}

test("payroll cards render across viewports + align with rows above", async ({ page }) => {
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
    const row = page.locator("[data-testid='stewardship-payroll']");
    await row.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await row.screenshot({ path: `test-results/stewardship-payroll-zoom-${v.w}.png` });

    const m = await alignmentMeasurement(page);
    report.push({ viewport: `${v.w}x${v.h}`, ...m });

    if (m.equity && m.payrollD) {
      expect.soft(Math.abs(m.payrollD.x - m.equity.x), `${v.w}: payroll-dept left ↔ equity left`).toBeLessThanOrEqual(4);
      expect.soft(Math.abs(m.payrollD.right - m.equity.right), `${v.w}: payroll-dept right ↔ equity right`).toBeLessThanOrEqual(4);
    }
    if (m.operate && m.payrollT) {
      expect.soft(Math.abs(m.payrollT.x - m.operate.x), `${v.w}: payroll-trend left ↔ operating left`).toBeLessThanOrEqual(4);
      expect.soft(Math.abs(m.payrollT.right - m.operate.right), `${v.w}: payroll-trend right ↔ operating right`).toBeLessThanOrEqual(4);
    }
    if (m.dept && m.payrollD) {
      expect.soft(Math.abs(m.payrollD.x - m.dept.x), `${v.w}: payroll-dept ↔ dept-perf left`).toBeLessThanOrEqual(4);
    }
    if (m.dues && m.payrollT) {
      expect.soft(Math.abs(m.payrollT.x - m.dues.x), `${v.w}: payroll-trend ↔ dues-subsidy left`).toBeLessThanOrEqual(4);
    }
  }

  writeFileSync(
    "test-results/stewardship-payroll-alignment.json",
    JSON.stringify(report, null, 2),
    "utf8",
  );
});
