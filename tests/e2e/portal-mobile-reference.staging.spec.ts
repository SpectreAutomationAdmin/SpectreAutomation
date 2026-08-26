// HR mobile-hotfix (2026-08-27) — proof screenshot for the mobile
// Employee Portal reference reconstruction. Runs against staging as
// Chris Turcato (portal login, not admin), captures 390 × 844, and
// asserts every reference component is on the page.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/portal-mobile-reference");
fs.mkdirSync(OUT, { recursive: true });

const EMAIL = process.env.SPECTRE_STAGING_CHRIS_EMAIL ?? "c.s.turcato@gmail.com";
const PASSWORD = process.env.SPECTRE_STAGING_CHRIS_PASSWORD ?? "";

test.describe("Portal mobile — accepted reference reconstruction", () => {
  test.skip(!PASSWORD, "SPECTRE_STAGING_CHRIS_PASSWORD not set");
  test.setTimeout(180_000);

  test("mobile 390×844 — dark green header + hero + banner + widgets + quick-links + bottom nav", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true, hasTouch: true,
      baseURL: "https://staging.spectreautomation.com",
    });
    const page = await context.newPage();
    // Employee-portal login (email + password).
    await page.goto("/employee/login");
    await page.locator('[data-testid="employee-login-email"]').fill(EMAIL);
    await page.locator('[data-testid="employee-login-password"]').fill(PASSWORD);
    await page.locator('[data-testid="employee-login-submit"]').click();
    await page.waitForURL(/\/employee(?!\/login)/, { timeout: 30_000 });
    await expect(page.locator('[data-testid="portal-home"]')).toBeVisible({ timeout: 15_000 });

    // Header
    const topbar = page.locator('[data-testid="portal-mobile-topbar"]');
    await expect(topbar).toBeVisible();
    await expect(page.locator('[data-testid="portal-mobile-brand-wordmark"]')).toContainText("SPECTRE");
    await expect(page.locator('[data-testid="portal-mobile-club-name"]')).toContainText(/Coulee Ridge/i);
    // Hero + weather pill + EMPLOYEE PORTAL rule
    await expect(page.locator('[data-testid="portal-hero-greeting"]').first()).toContainText(/Good (morning|afternoon|evening)/i);
    await expect(page.locator('[data-testid="portal-hero-weather"]')).toBeVisible();
    // Welcome banner + widget grid + quick links
    await expect(page.locator('[data-testid="portal-mobile-welcome-banner"]')).toBeVisible();
    const grid = page.locator('[data-testid="portal-mobile-widgets-grid"]');
    await expect(grid).toBeVisible();
    for (const key of ["scheduling", "paystubs", "time-off", "forms", "training", "clocking-in-out"]) {
      await expect(grid.locator(`[data-testid="portal-mobile-widget-${key}"]`)).toBeVisible();
    }
    await expect(page.locator('[data-testid="portal-mobile-quick-links"]')).toBeVisible();
    // Bottom nav
    const bottom = page.locator('[data-testid="portal-mobile-bottom-nav"]');
    await expect(bottom).toBeVisible();
    for (const key of ["home", "schedule", "pay", "time-off", "more"]) {
      await expect(bottom.locator(`[data-testid="portal-mobile-bottom-${key}"]`)).toBeVisible();
    }
    // No horizontal overflow.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    await page.screenshot({ path: path.join(OUT, "chris-390x844.png"), fullPage: true });
    await context.close();
  });
});
