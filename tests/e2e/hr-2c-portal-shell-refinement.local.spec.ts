// HR-2C Shell Refinement (2026-08-24) — Founder acceptance walk.
//
// Desktop:
//   * Club name appears in the top header.
//   * Upper-left says only "Employee Portal".
//   * Circular avatar renders beside display name + employee #.
//   * Left nav shows exactly Home + Profile.
//   * Removed nav labels are absent from the persistent nav.
//   * All five widgets still render.
//   * Widgets carry data-tour-target attributes.
// Mobile 390 × 844:
//   * Compact header renders (mobile top bar + Club name in centre).
//   * Mobile drawer lists exactly Home + Profile.
//   * Widgets remain functional.
//   * No horizontal overflow.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const OUT = path.resolve("test-results/hr-2c-portal-shell-refinement");
fs.mkdirSync(OUT, { recursive: true });
const prisma = new PrismaClient();

const BASE = "http://silver-springs.localtest.me:3000";
const VIEWPORT_DESKTOP = { width: 1440, height: 900 };
const VIEWPORT_MOBILE = { width: 390, height: 844 };

interface Fixture {
  employeeId: string;
  employeeNumber: string;
  password: string;
  clubName: string;
}
let fx: Fixture;

async function seedFixture(): Promise<Fixture> {
  const club = await prisma.club.findFirst({ where: { slug: "silver-springs" } });
  if (!club) throw new Error("[Shell] Silver Springs not seeded.");
  const staleEmps = await prisma.employee.findMany({
    where: { clubId: club.id, employeeNumber: { startsWith: "SHELL-" } },
    select: { id: true },
  });
  for (const e of staleEmps) {
    await prisma.employeeHomeNotificationDismissal.deleteMany({ where: { employeeId: e.id } });
    await prisma.employeePortalCredential.deleteMany({ where: { employeeId: e.id } });
    await prisma.employee.deleteMany({ where: { id: e.id } });
  }
  const employeeNumber = `SHELL-${Math.floor(Math.random() * 90000 + 10000)}`;
  const password = "Shell-Refinement-Pw-1!";
  const passwordHash = await bcrypt.hash(password, 12);
  const employee = await prisma.employee.create({
    data: {
      clubId: club.id, employeeNumber,
      firstName: "Chris", lastName: `Shell-${Date.now().toString().slice(-6)}`,
      personalEmail: `shell-${Date.now()}@spec.test`,
      status: "ACTIVE", employeeLifecycle: "ACTIVE",
      portalTourCompletedAt: new Date(),
    },
  });
  await prisma.employeePortalCredential.create({
    data: { clubId: club.id, employeeId: employee.id, passwordHash, passwordUpdatedAt: new Date() },
  });
  return { employeeId: employee.id, employeeNumber, password, clubName: club.name };
}

async function loginAsEmployee(page: Page) {
  await page.goto(`${BASE}/employee/login`);
  await page.locator('input[name="employeeNumber"]').fill(fx.employeeNumber);
  await page.locator('input[name="password"]').fill(fx.password);
  await Promise.all([
    page.waitForURL(/\/employee(?!\/login)/, { timeout: 30_000 }),
    page.locator('button[type="submit"]').first().click(),
  ]);
}

test.describe("HR-2C Shell Refinement · desktop", () => {
  test.describe.configure({ mode: "serial" });
  test.slow();
  test.use({ viewport: VIEWPORT_DESKTOP });

  test.beforeAll(async () => { fx = await seedFixture(); });
  test.afterAll(async () => {
    await prisma.employeeHomeNotificationDismissal.deleteMany({ where: { employeeId: fx.employeeId } });
    await prisma.employeePortalCredential.deleteMany({ where: { employeeId: fx.employeeId } });
    await prisma.employee.deleteMany({ where: { id: fx.employeeId } });
  });

  test("Header: Club name in top header + circular avatar (initials fallback) + display name + employee #", async ({ page }) => {
    await loginAsEmployee(page);
    // Club name in header.
    const clubName = page.locator('[data-testid="portal-header-club-name"]');
    await expect(clubName).toBeVisible();
    await expect(clubName).toContainText(fx.clubName);
    // Employee identity block (initials fallback since no photo seeded).
    await expect(page.locator('[data-testid="portal-topbar-name"]')).toContainText("Chris");
    await expect(page.locator('[data-testid="portal-topbar-employee-number"]')).toContainText(fx.employeeNumber);
    await expect(page.locator('[data-testid="portal-header-avatar-initials"]')).toBeVisible();
    // Sidebar identity: eyebrow only, no Club name in the sidebar.
    await expect(page.locator('[data-testid="portal-sidebar-eyebrow"]')).toContainText(/Employee Portal/i);
    await expect(page.locator('[data-testid="portal-club-name"]')).toHaveCount(0);
    await page.screenshot({ path: path.join(OUT, "01-header-desktop.png"), fullPage: true });
  });

  test("Left nav contains exactly Home + Profile; removed labels are absent", async ({ page }) => {
    await loginAsEmployee(page);
    await expect(page.locator('[data-testid="portal-sidebar"] [data-testid="portal-nav-home"]')).toBeVisible();
    await expect(page.locator('[data-testid="portal-sidebar"] [data-testid="portal-nav-profile"]')).toBeVisible();
    // Removed items are absent from the persistent left rail.
    for (const testid of [
      "portal-nav-schedule",
      "portal-nav-availability",
      "portal-nav-pay",
      "portal-nav-safety-training",
      "portal-nav-documents",
    ]) {
      await expect(page.locator(`[data-testid="portal-sidebar"] [data-testid="${testid}"]`)).toHaveCount(0);
    }
  });

  test("All five widgets render with correct routes + data-tour-target attributes", async ({ page }) => {
    await loginAsEmployee(page);
    for (const label of ["Scheduling", "Paystubs", "Time Off Requests", "Forms", "Training"]) {
      await expect(page.locator('[data-testid="portal-home-widgets-grid"]')).toContainText(label);
    }
    // Real destinations wired correctly.
    await expect(page.locator('[data-testid="portal-home-widget-scheduling"]'))
      .toHaveAttribute("href", "/employee/schedule");
    await expect(page.locator('[data-testid="portal-home-widget-paystubs"]'))
      .toHaveAttribute("href", "/employee/pay");
    await expect(page.locator('[data-testid="portal-home-widget-training"]'))
      .toHaveAttribute("href", "/employee/safety-training");
    // Tour targets present.
    for (const [key, tourTarget] of Object.entries({
      "portal-home-widget-scheduling": "scheduling",
      "portal-home-widget-paystubs": "paystubs",
      "portal-home-widget-time-off-requests": "time-off",
      "portal-home-widget-forms": "forms",
      "portal-home-widget-training": "training",
    })) {
      await expect(page.locator(`[data-testid="${key}"]`))
        .toHaveAttribute("data-tour-target", tourTarget);
    }
    // Direct routes still work (removal from nav ≠ removal of route).
    await page.goto(`${BASE}/employee/schedule`);
    await expect(page.locator('[data-testid="portal-schedule"]')).toBeVisible();
    await page.goto(`${BASE}/employee/documents`);
    await expect(page.locator('[data-testid="portal-documents"]')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "02-widgets-desktop.png"), fullPage: true });
  });
});

test.describe("HR-2C Shell Refinement · mobile", () => {
  test.describe.configure({ mode: "serial" });
  test.slow();
  test.use({ viewport: VIEWPORT_MOBILE });

  test.beforeAll(async () => {
    // Desktop describe's afterAll deletes the fixture — always
    // re-seed for the mobile describe. seedFixture is idempotent.
    fx = await seedFixture();
  });
  test.afterAll(async () => {
    await prisma.employeeHomeNotificationDismissal.deleteMany({ where: { employeeId: fx.employeeId } });
    await prisma.employeePortalCredential.deleteMany({ where: { employeeId: fx.employeeId } });
    await prisma.employee.deleteMany({ where: { id: fx.employeeId } });
    await prisma.$disconnect();
  });

  test("Mobile drawer contains exactly Home + Profile; no horizontal overflow", async ({ page }) => {
    await loginAsEmployee(page);
    await expect(page.locator('[data-testid="portal-mobile-topbar"]')).toBeVisible();
    await page.locator('[data-testid="portal-mobile-menu-open"]').click();
    await expect(page.locator('[data-testid="portal-mobile-drawer"]')).toBeVisible();
    const nav = page.locator('[data-testid="portal-mobile-nav"]');
    await expect(nav).toContainText("Home");
    await expect(nav).toContainText("Profile");
    // Removed labels absent from the drawer.
    for (const label of ["Schedule", "Availability", "Pay", "Safety & Training", "Documents"]) {
      const re = new RegExp(`\\b${label}\\b`);
      await expect(nav).not.toContainText(re);
    }
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    await page.screenshot({ path: path.join(OUT, "03-mobile-drawer.png"), fullPage: true });
    // Close drawer.
    await page
      .locator('[data-testid="portal-mobile-drawer-backdrop"]')
      .click({ position: { x: 380, y: 400 } });
    await expect(page.locator('[data-testid="portal-mobile-drawer"]')).toHaveCount(0);
    // Home widgets remain functional at mobile width.
    await expect(page.locator('[data-testid="portal-home-widget-scheduling"]')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "04-mobile-home.png"), fullPage: true });
  });
});
