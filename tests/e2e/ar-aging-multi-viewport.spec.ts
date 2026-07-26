import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";

// Visual + measurement audit for the new Accounts Receivable Aging
// chapter (VIII, 2026-06-16). Captures the panel at the three admin
// viewports the CLAUDE.md responsive-design rule pins as mandatory
// for desktop reporting work: 1440, 1920, 2560. For each viewport,
// records the panel's outer width + the two main tables (aging,
// membership activity) so the variance report can confirm the panel
// grows with the card and the status pills never wrap.

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
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

async function measureAraPanel(page: Page) {
  return page.evaluate(() => {
    function r(n: number) { return Math.round(n * 100) / 100; }
    function rect(el: Element | null) {
      if (!el) return null;
      const b = (el as HTMLElement).getBoundingClientRect();
      return { x: r(b.x), w: r(b.width), right: r(b.x + b.width) };
    }
    const panel = document.querySelector("[data-testid='ar-aging']");
    if (!panel) return { error: "panel not found" } as const;
    const agingTable = panel.querySelector("[data-testid='ara-aging-table']");
    const membershipTable = panel.querySelector("[data-testid='ara-membership-table']");
    const kpiCards = panel.querySelector("[data-testid='ara-kpi-cards']");
    const notes = panel.querySelector("[data-testid='ara-collection-notes']");

    // Status pills must never wrap mid-pill — capture the rendered
    // height of every pill so a wrapping regression is visible.
    const pillHeights: number[] = [];
    panel.querySelectorAll("[data-testid$='-status']").forEach((p) => {
      const b = (p as HTMLElement).getBoundingClientRect();
      pillHeights.push(r(b.height));
    });

    return {
      panelWidth: rect(panel)?.w ?? null,
      kpiCardsWidth: rect(kpiCards)?.w ?? null,
      agingTableWidth: rect(agingTable)?.w ?? null,
      membershipTableWidth: rect(membershipTable)?.w ?? null,
      notesWidth: rect(notes)?.w ?? null,
      pillCount: pillHeights.length,
      pillMaxHeight: pillHeights.length ? Math.max(...pillHeights) : null,
    };
  });
}

test("AR aging chapter VIII across admin viewports", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page
    .getByTestId("reporting-chapter-ar-aging")
    .waitFor({ timeout: 20_000 });
  await page
    .getByTestId("reporting-chapter-ar-aging")
    .click();
  await page.waitForTimeout(600);
  await page
    .locator("[data-testid='ar-aging']")
    .scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);

  const report: any[] = [];
  for (const v of VIEWPORTS) {
    await page.setViewportSize({ width: v.w, height: v.h });
    await page.waitForTimeout(300);
    await page
      .locator("[data-testid='ar-aging']")
      .scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const m = await measureAraPanel(page);
    report.push({ viewport: `${v.w}x${v.h}`, ...m });
    await page.screenshot({
      path: `test-results/ar-aging-${v.w}.png`,
      fullPage: false,
    });
  }

  writeFileSync(
    "test-results/ar-aging-multi-viewport.json",
    JSON.stringify(report, null, 2),
    "utf8",
  );

  // ─────────────────────────────────────────────────────────────
  // Responsive-design rule: panel grows with the viewport.
  // ─────────────────────────────────────────────────────────────
  const by = (w: number) => report.find((r) => (r.viewport as string).startsWith(`${w}x`));
  const r1440 = by(1440), r1920 = by(1920), r2560 = by(2560);
  expect.soft(r1440, "1440 row present").toBeTruthy();
  expect.soft(r1920, "1920 row present").toBeTruthy();
  expect.soft(r2560, "2560 row present").toBeTruthy();

  if (r1440 && r1920 && r2560) {
    expect.soft(
      r1920.panelWidth,
      "panel widens 1440 → 1920 (no fixed-width cap)",
    ).toBeGreaterThan(r1440.panelWidth);
    // 1920 → 2560: the ReportingShell content column caps at the
    // page-layout max-width (observed ~1528 px). That's app-level
    // composition shared by every chapter — not an AR-panel cap.
    // The panel must not SHRINK at the wider viewport.
    expect.soft(
      r2560.panelWidth,
      "panel does not shrink 1920 → 2560 (shell cap reached, panel still fills it)",
    ).toBeGreaterThanOrEqual(r1920.panelWidth);

    // Status pills must never wrap — single-line CURRENT pill at
    // ~16-22 px. A wrapping regression doubles that.
    for (const row of [r1440, r1920, r2560]) {
      expect.soft(
        row.pillCount,
        `at least one status pill rendered at ${row.viewport}`,
      ).toBeGreaterThan(0);
      expect.soft(
        row.pillMaxHeight,
        `status pill stays single-line at ${row.viewport} (whitespace-nowrap guard)`,
      ).toBeLessThanOrEqual(26);
    }
  }
});
