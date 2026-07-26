import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";

// Visual + behavioural audit for Operating Statistics (chapter IX).
// Captures the panel at the three admin viewports the CLAUDE.md
// responsive-design rule pins as mandatory for desktop reporting work:
// 1440 / 1920 / 2560. Asserts:
//   - the new rail entry "IX Operating Statistics" sits under the
//     "Operations & Analytics" group label
//   - the rail remains sticky/fixed while scrolling
//   - clicking the rail link scrolls the section into view
//   - the period-derived column headers read "May 2026 Actual" /
//     "May 2025 Actual" (NOT Q1/March/quarterly)
//   - metric-aware favourable/unfavourable tones render
//   - both Focus Area cards render with the correct accent palette
//   - the panel grows with the viewport (1440 → 1920) and does not
//     shrink at 2560 (page-shell content-width cap is acceptable)

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

const VIEWPORTS = [
  { w: 1440, h: 900 },
  { w: 1920, h: 1080 },
  { w: 2560, h: 1440 },
];

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 30_000 });
}

async function measurePanel(page: Page) {
  return page.evaluate(() => {
    function r(n: number) { return Math.round(n * 100) / 100; }
    function rect(el: Element | null) {
      if (!el) return null;
      const b = (el as HTMLElement).getBoundingClientRect();
      return { x: r(b.x), w: r(b.width), right: r(b.x + b.width) };
    }
    const panel = document.querySelector("[data-testid='operating-statistics']");
    if (!panel) return { error: "panel not found" } as const;
    const table = panel.querySelector("[data-testid='os-table']");
    const focusGrid = panel.querySelector("[data-testid='os-focus-grid']");
    // Pick the two top-level focus articles (Operating + Capital).
    const operating = panel.querySelector("[data-testid='os-focus-operating-focus']");
    const capital = panel.querySelector("[data-testid='os-focus-capital-focus']");
    return {
      panelWidth: rect(panel)?.w ?? null,
      tableWidth: rect(table)?.w ?? null,
      focusGridWidth: rect(focusGrid)?.w ?? null,
      operatingCardWidth: rect(operating)?.w ?? null,
      capitalCardWidth: rect(capital)?.w ?? null,
      focusCardCount: [operating, capital].filter(Boolean).length,
    };
  });
}

test("rail places Operating Statistics under the Operations & Analytics group", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  const opStat = page.getByTestId("reporting-chapter-operating-statistics");
  await opStat.waitFor({ timeout: 20_000 });
  // Rail label = "Operating Statistics".
  await expect(opStat).toContainText("Operating Statistics");

  // The rail nav contains the group label "Operations & Analytics"
  // — appears once as the group heading above the entries.
  const groupHeading = page.locator("text=Operations & Analytics").first();
  await expect(groupHeading).toBeVisible();

  // Operating Statistics is the first link inside that group — verify
  // by reading the order of rail-entry data-testids.
  const railIds = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll("[data-testid^='reporting-chapter-']"),
      (el) => el.getAttribute("data-testid")!.replace("reporting-chapter-", ""),
    ),
  );
  const opStatIdx = railIds.indexOf("operating-statistics");
  const operationsIdx = railIds.indexOf("operations");
  expect(opStatIdx).toBeGreaterThan(-1);
  expect(operationsIdx).toBeGreaterThan(opStatIdx);
});

test("clicking Operating Statistics scrolls the section into view + the rail stays sticky", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  const railEntry = page.getByTestId("reporting-chapter-operating-statistics");
  await railEntry.waitFor({ timeout: 20_000 });

  await railEntry.click();
  await page.waitForTimeout(600);

  // Section is in viewport after the scroll.
  await expect(page.getByTestId("operating-statistics")).toBeInViewport();
  await expect(page.getByTestId("os-title")).toHaveText("Operating Statistics & Focus Areas");

  // Rail itself stays visible after the section scroll — that's what
  // "sticky / fixed" means in practice. The active-state highlight may
  // shift the active entry's height a few pixels, but the rail entry
  // must remain on-screen.
  await expect(railEntry).toBeInViewport();
});

test("column headers flow from ReportingPeriod — May 2026 / May 2025 (NOT Q1 / March / quarterly)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-operating-statistics").click();
  await page.waitForTimeout(400);

  const headers = page.getByTestId("os-column-headers");
  await expect(headers).toContainText("May 2026 Actual");
  await expect(headers).toContainText("May 2025 Actual");
  await expect(headers).toContainText("Change");
  await expect(headers).toContainText("Budget");
  await expect(headers).toContainText("Vs. Budget");
  await expect(headers).not.toContainText("Q1");
  await expect(headers).not.toContainText("March");
});

test("metric-aware tones — resignations DECREASE renders favourable; payroll OVER budget renders risk", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-operating-statistics").click();
  await page.waitForTimeout(400);

  // Resignations YTD — current 5 vs prior year 8 → favourable.
  const resigChange = page.getByTestId("os-row-resignations-ytd-change");
  await expect(resigChange).toHaveAttribute("data-tone", "favorable");

  // Payroll % — vs Budget renders risk (38.4 vs 38.0 = above plan,
  // lower-is-better, so above-budget is unfavourable).
  const payrollVsBudget = page.getByTestId("os-row-payroll-pct-revenue-vs-budget");
  await expect(payrollVsBudget).toHaveAttribute("data-tone", "risk");
});

test("focus cards render with the correct accent palette", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-operating-statistics").click();
  await page.getByTestId("operating-statistics").waitFor({ timeout: 20_000 });
  // Wait for the focus grid to render before asserting attributes;
  // batched test runs can race the panel hydration.
  await page.getByTestId("os-focus-operating-focus").waitFor({ timeout: 20_000 });

  await expect(page.getByTestId("os-focus-operating-focus")).toHaveAttribute("data-accent", "rust");
  await expect(page.getByTestId("os-focus-capital-focus")).toHaveAttribute("data-accent", "slate");
  await expect(page.getByTestId("os-focus-operating-focus-title")).toContainText("May 2026 → Q3 2026");
});

test("Operating Statistics — multi-viewport: panel grows with the shell, focus cards side-by-side", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-operating-statistics").click();
  await page.waitForTimeout(600);
  await page.locator("[data-testid='operating-statistics']").scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);

  const report: any[] = [];
  for (const v of VIEWPORTS) {
    await page.setViewportSize({ width: v.w, height: v.h });
    await page.waitForTimeout(300);
    await page.locator("[data-testid='operating-statistics']").scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const m = await measurePanel(page);
    report.push({ viewport: `${v.w}x${v.h}`, ...m });
    await page.screenshot({
      path: `test-results/operating-statistics-${v.w}.png`,
      fullPage: false,
    });
  }

  writeFileSync(
    "test-results/operating-statistics-multi-viewport.json",
    JSON.stringify(report, null, 2),
    "utf8",
  );

  const by = (w: number) => report.find((r) => (r.viewport as string).startsWith(`${w}x`));
  const r1440 = by(1440), r1920 = by(1920), r2560 = by(2560);
  expect.soft(r1440 && r1920 && r2560, "all three viewports present").toBeTruthy();

  if (r1440 && r1920 && r2560) {
    // 2 focus cards rendered at every viewport.
    for (const r of [r1440, r1920, r2560]) {
      expect.soft(r.focusCardCount, `2 focus cards at ${r.viewport}`).toBe(2);
    }
    expect.soft(
      r1920.panelWidth,
      "panel widens 1440 → 1920 (no fixed-width cap)",
    ).toBeGreaterThan(r1440.panelWidth);
    expect.soft(
      r2560.panelWidth,
      "panel does not shrink 1920 → 2560 (shell cap reached, panel still fills it)",
    ).toBeGreaterThanOrEqual(r1920.panelWidth);
    // Focus cards are side-by-side at >= md viewports.
    for (const r of [r1440, r1920, r2560]) {
      expect.soft(
        r.operatingCardWidth! + r.capitalCardWidth!,
        `focus cards side-by-side at ${r.viewport}`,
      ).toBeLessThanOrEqual(r.focusGridWidth! + 4);
    }
  }
});
