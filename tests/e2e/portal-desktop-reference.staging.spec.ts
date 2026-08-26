// HR mobile-hotfix continuation (2026-08-28) — desktop reference
// reconstruction proof. Logs in as the synthetic Playwright
// fixture, captures screenshots at 5 representative desktop widths,
// asserts the accepted composition is present (dark shell, hero,
// 3×2 widget grid, right rail, footer).

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/portal-desktop-reference");
fs.mkdirSync(OUT, { recursive: true });

const EMAIL = process.env.SPECTRE_PLAYWRIGHT_FIXTURE_EMAIL
  ?? "playwright-fixture@spectreautomation.internal";
const PASSWORD = process.env.SPECTRE_PLAYWRIGHT_FIXTURE_PASSWORD
  ?? "playwright-fixture-2026-test";

const VIEWPORTS = [
  { label: "1280x720",  w: 1280, h: 720 },
  { label: "1366x768",  w: 1366, h: 768 },
  { label: "1440x900",  w: 1440, h: 900 },
  { label: "1536x864",  w: 1536, h: 864 },
  { label: "1920x1080", w: 1920, h: 1080 },
];

test.describe("Portal desktop — accepted reference reconstruction", () => {
  test.setTimeout(300_000);

  for (const vp of VIEWPORTS) {
    test(`${vp.label} — dark shell + hero + 3x2 grid + right rail + footer`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: vp.w, height: vp.h },
        baseURL: "https://staging.spectreautomation.com",
      });
      const page = await context.newPage();
      await page.goto("/employee/login");
      await page.locator('[data-testid="employee-login-email"]').fill(EMAIL);
      await page.locator('[data-testid="employee-login-password"]').fill(PASSWORD);
      await page.locator('[data-testid="employee-login-submit"]').click();
      await page.waitForURL(/\/employee(?!\/login)/, { timeout: 30_000 });
      // Dismiss the first-login tour so the desktop chrome is unobstructed.
      await page.evaluate(async () => {
        try { await fetch("/api/employee/tour-completed", { method: "POST" }); } catch {}
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);

      // The layout renders BOTH the desktop shell and the mobile shell
      // wrappers (Next.js can't gate them server-side by viewport), and
      // each wraps {children} — so page.tsx renders TWICE. Its own
      // desktop branch carries data-testid="portal-desktop-home", which
      // is the unique root we scope the reference assertions from.
      const shell = page.locator('[data-testid="portal-desktop-shell"]');
      const home = shell.locator('[data-testid="portal-desktop-home"]').first();
      await expect(shell).toBeVisible();
      await expect(shell.locator('[data-testid="portal-sidebar"]')).toBeVisible();
      await expect(shell.locator('[data-testid="portal-sidebar-wordmark"]')).toContainText("SPECTRE");
      await expect(shell.locator('[data-testid="portal-header"]')).toBeVisible();
      await expect(shell.locator('[data-testid="portal-header-club-name"]')).toContainText(/Coulee Ridge/i);
      await expect(shell.locator('[data-testid="portal-header-notifications"]')).toBeVisible();
      await expect(home.locator('[data-testid="portal-hero-desktop"]')).toBeVisible();
      await expect(home.locator('[data-testid="portal-hero-weather-desktop"]')).toBeVisible();
      for (const key of ["home", "schedule", "pay", "time-off", "forms", "training", "clock", "more"]) {
        await expect(shell.locator(`[data-testid="portal-nav-${key}"]`)).toBeVisible();
      }
      await expect(shell.locator('[data-testid="portal-sidebar-help"]')).toBeVisible();
      const grid = home.locator('[data-testid="portal-desktop-widgets-grid"]');
      await expect(grid).toBeVisible();
      for (const k of ["scheduling", "paystubs", "time-off", "forms", "training", "clocking-in-out"]) {
        await expect(grid.locator(`[data-testid="portal-desktop-widget-${k}"]`)).toBeVisible();
      }
      await expect(home.locator('[data-testid="portal-desktop-announcements"]')).toBeVisible();
      await expect(home.locator('[data-testid="portal-desktop-quick-links"]')).toBeVisible();
      await expect(home.locator('[data-testid="portal-desktop-footer"]')).toContainText(/All rights reserved/);
      // No horizontal overflow.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);

      await page.screenshot({ path: path.join(OUT, `${vp.label}.png`), fullPage: false });
      await context.close();
    });
  }
});
