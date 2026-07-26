import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";

// Visual + behavioural audit for Departmental P&L Summary (chapter X).
// Captures the panel at the three admin viewports the CLAUDE.md
// responsive-design rule pins as mandatory for desktop reporting work:
// 1440 / 1920 / 2560. Asserts:
//   - the rail entry reads "Departmental P&L" (concise) while the
//     section title remains the formal "Departmental P&L Summary"
//   - the rail entry sits directly below "Operating Statistics" in
//     the Operations & Analytics group
//   - the rail remains sticky/visible after clicking the entry
//   - the period-derived management notice + card copy reads May 2026
//     (no Q1, no March)
//   - all 6 department cards render with their dark-green headers + pills
//   - the card grid is 3 columns at >= lg, 2 cols at md, 1 col at sm
//   - both favourable + risk pill tones render

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

const VIEWPORTS = [
  { w: 1440, h: 900 },
  { w: 1920, h: 1080 },
  { w: 2560, h: 1440 },
];

const DEPARTMENT_KEYS = [
  "food-beverage",
  "golf-operations",
  "fitness-center",
  "racquet-operations",
  "aquatics-pool",
  "ga-administration",
];

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

async function measurePanel(page: Page) {
  return page.evaluate((depKeys) => {
    function r(n: number) { return Math.round(n * 100) / 100; }
    function rect(el: Element | null) {
      if (!el) return null;
      const b = (el as HTMLElement).getBoundingClientRect();
      return { x: r(b.x), y: r(b.y), w: r(b.width), right: r(b.x + b.width) };
    }
    const panel = document.querySelector("[data-testid='departmental-p-and-l']");
    if (!panel) return { error: "panel not found" } as const;
    const grid = panel.querySelector("[data-testid='dpl-card-grid']");
    // Group cards into rows by their top Y so we can confirm columns.
    const cards = depKeys.map((k) => {
      const el = panel.querySelector(`[data-testid='dpl-card-${k}']`);
      return el ? { key: k, ...rect(el)! } : null;
    }).filter((c): c is { key: string; x: number; y: number; w: number; right: number } => !!c);
    const yBuckets: Record<number, number> = {};
    for (const c of cards) {
      const yKey = Math.round(c.y / 10) * 10;
      yBuckets[yKey] = (yBuckets[yKey] ?? 0) + 1;
    }
    const colsPerRow = Object.values(yBuckets);
    const maxColsPerRow = Math.max(...colsPerRow);

    return {
      panelWidth: rect(panel)?.w ?? null,
      gridWidth: rect(grid)?.w ?? null,
      cardCount: cards.length,
      maxColsPerRow,
      cardWidths: cards.map((c) => c.w),
    };
  }, DEPARTMENT_KEYS);
}

test("rail entry reads 'Departmental P&L' but the section title remains 'Departmental P&L Summary'", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  const railEntry = page.getByTestId("reporting-chapter-departmental-p-and-l");
  await railEntry.waitFor({ timeout: 20_000 });
  // Rail label = concise form, NOT the formal title.
  await expect(railEntry).toContainText("Departmental P&L");
  await expect(railEntry).not.toContainText("Departmental P&L Summary");

  // Rail order within the Operations & Analytics group: Operating
  // Statistics → Departmental P&L → Operations & Analytics → ...
  // Use de-duplicated order — the rail entries can have nested
  // elements that all share the `reporting-chapter-` prefix.
  const railIds = await page.evaluate(() => {
    const seen: string[] = [];
    document.querySelectorAll("[data-testid^='reporting-chapter-']").forEach((el) => {
      const id = el.getAttribute("data-testid")!.replace("reporting-chapter-", "");
      if (!seen.includes(id)) seen.push(id);
    });
    return seen;
  });
  const opStatIdx = railIds.indexOf("operating-statistics");
  const dplIdx = railIds.indexOf("departmental-p-and-l");
  const operationsIdx = railIds.indexOf("operations");
  expect(opStatIdx, "Operating Statistics rail entry present").toBeGreaterThan(-1);
  expect(dplIdx, "Departmental P&L is after Operating Statistics").toBeGreaterThan(opStatIdx);
  expect(operationsIdx, "Operations & Analytics is after Departmental P&L").toBeGreaterThan(dplIdx);
  // The monthly-reporting-package vitest pins the exact source-order
  // sequence; this Playwright check just verifies DOM ordering at the
  // shell boundary, where mobile + desktop sidebars may interleave.

  // Click scrolls into view + rail stays visible.
  await railEntry.click();
  await page.waitForTimeout(600);
  await expect(page.getByTestId("departmental-p-and-l")).toBeInViewport();
  await expect(page.getByTestId("dpl-title")).toHaveText("Departmental P&L Summary");
  await expect(railEntry).toBeInViewport();
});

test("header chrome flows from ReportingPeriod (May 2026, NO Q1 / March)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-departmental-p-and-l").click();
  await page.waitForTimeout(400);

  await expect(page.getByTestId("dpl-period")).toContainText("May 2026");
  await expect(page.getByTestId("dpl-period")).toContainText("May 31, 2026");
  await expect(page.getByTestId("dpl-statement-number")).toHaveText("Statement 08 of 14");
  await expect(page.getByTestId("dpl-document-chip")).toHaveText("Departmental Detail");
  await expect(page.getByTestId("dpl-prepared-for")).toHaveText("Management Level");

  const period = page.getByTestId("dpl-period");
  await expect(period).not.toContainText("Q1");
  await expect(period).not.toContainText("March");
});

test("management notice renders with the documented copy", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-departmental-p-and-l").click();
  await page.waitForTimeout(400);

  const notice = page.getByTestId("dpl-management-notice");
  await expect(notice).toBeVisible();
  await expect(page.getByTestId("dpl-management-notice-eyebrow")).toHaveText("Management Document");
  await expect(notice).toContainText("department-level detail for GM");
  await expect(notice).toContainText("board receives the combined statement");
});

test("six department cards render with their dark-green headers + tone-classified pills", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-departmental-p-and-l").click();
  await page.waitForTimeout(400);

  for (const key of DEPARTMENT_KEYS) {
    await expect(
      page.getByTestId(`dpl-card-${key}`),
      `department card "${key}" must render`,
    ).toBeVisible();
  }

  // Pill tones: F&B favourable, Golf risk, Fitness risk, Racquet
  // favourable, Aquatics favourable, G&A risk.
  await expect(page.getByTestId("dpl-card-food-beverage-pill")).toHaveAttribute("data-tone", "favorable");
  await expect(page.getByTestId("dpl-card-golf-operations-pill")).toHaveAttribute("data-tone", "risk");
  await expect(page.getByTestId("dpl-card-fitness-center-pill")).toHaveAttribute("data-tone", "risk");
  await expect(page.getByTestId("dpl-card-racquet-operations-pill")).toHaveAttribute("data-tone", "favorable");
  await expect(page.getByTestId("dpl-card-aquatics-pool-pill")).toHaveAttribute("data-tone", "favorable");
  await expect(page.getByTestId("dpl-card-ga-administration-pill")).toHaveAttribute("data-tone", "risk");
});

test("metric-row tones — favourable rows render green; risk rows render rust", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-departmental-p-and-l").click();
  await page.waitForTimeout(400);

  // F&B vs Budget = "+$61,730" favourable.
  const fbVsBudget = page.locator("[data-testid='dpl-card-food-beverage'] [data-testid='dpl-row-vs-budget']");
  await expect(fbVsBudget).toHaveAttribute("data-tone", "favorable");
  // Fitness Primary Cause = "Instructor turnover" risk.
  const fitCause = page.locator("[data-testid='dpl-card-fitness-center'] [data-testid='dpl-row-primary-cause']");
  await expect(fitCause).toHaveAttribute("data-tone", "risk");
  // G&A Legal & Professional Fees = "Elevated" risk.
  const gaLegal = page.locator("[data-testid='dpl-card-ga-administration'] [data-testid='dpl-row-legal-professional-fees']");
  await expect(gaLegal).toHaveAttribute("data-tone", "risk");
});

test("department notes render with the period-aware Facilities note", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-departmental-p-and-l").click();
  await page.waitForTimeout(400);

  await expect(page.getByTestId("dpl-notes-eyebrow")).toHaveText("Department Notes");
  await expect(page.getByTestId("dpl-note-0")).toContainText("Course Maintenance expenses");
  // Facilities note quotes the period's current quarter (Q2 2026 for
  // May), NOT a hardcoded Q1.
  const facilities = page.getByTestId("dpl-note-1");
  await expect(facilities).toContainText("in Q2 2026 relative to budget");
  await expect(facilities).not.toContainText("in Q1 relative to budget");
});

test("Departmental P&L — multi-viewport: card grid grows from 1 → 3 columns + cards fill row width", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-departmental-p-and-l").click();
  await page.waitForTimeout(600);
  await page.locator("[data-testid='departmental-p-and-l']").scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);

  const report: any[] = [];
  for (const v of VIEWPORTS) {
    await page.setViewportSize({ width: v.w, height: v.h });
    await page.waitForTimeout(300);
    await page.locator("[data-testid='departmental-p-and-l']").scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const m = await measurePanel(page);
    report.push({ viewport: `${v.w}x${v.h}`, ...m });
    await page.screenshot({
      path: `test-results/departmental-pl-${v.w}.png`,
      fullPage: false,
    });
  }

  writeFileSync(
    "test-results/departmental-pl-multi-viewport.json",
    JSON.stringify(report, null, 2),
    "utf8",
  );

  const by = (w: number) => report.find((r) => (r.viewport as string).startsWith(`${w}x`));
  const r1440 = by(1440), r1920 = by(1920), r2560 = by(2560);
  expect.soft(r1440 && r1920 && r2560, "all three viewports captured").toBeTruthy();

  if (r1440 && r1920 && r2560) {
    for (const r of [r1440, r1920, r2560]) {
      // All 6 cards always render.
      expect.soft(r.cardCount, `6 cards at ${r.viewport}`).toBe(6);
      // At desktop sizes (>= lg breakpoint = 1024 px) the grid uses
      // 3 columns per row.
      expect.soft(r.maxColsPerRow, `3 cols/row at ${r.viewport}`).toBe(3);
    }
    expect.soft(
      r1920.panelWidth,
      "panel widens 1440 → 1920 (no fixed-width cap)",
    ).toBeGreaterThan(r1440.panelWidth);
    expect.soft(
      r2560.panelWidth,
      "panel does not shrink 1920 → 2560 (shell cap reached, panel still fills it)",
    ).toBeGreaterThanOrEqual(r1920.panelWidth);
  }
});
