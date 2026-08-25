// HR mobile-hotfix (2026-08-30) — Playwright browser proof for the
// six mobile defects the founder identified during real onboarding.
//
// Runs at 390 × 844 (iPhone-class portrait). Every check that
// asserts geometry does so via getBoundingClientRect() on the
// actually-rendered elements — not on the SVG container or the
// generic scrollWidth alone. §8 requires "prove the rendered
// CoachMark geometry is actually relative to the target element";
// §9 requires "scrollWidth <= viewportWidth + 1" across major
// portal pages.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const OUT = path.resolve("test-results/hr-mobile-hotfix");
fs.mkdirSync(OUT, { recursive: true });
const prisma = new PrismaClient();
const BASE = "http://silver-springs.localtest.me:3000";
const MOBILE = { width: 390, height: 844 };

interface Fixture {
  clubId: string;
  employeeId: string;
  employeeNumber: string;
  password: string;
}
let fx: Fixture;

async function seedFixture(): Promise<Fixture> {
  const club = await prisma.club.findFirstOrThrow({ where: { slug: "silver-springs" } });
  // Ensure a canonical timezone so the greeting can resolve against it.
  if (!club.timezone) {
    await prisma.club.update({ where: { id: club.id }, data: { timezone: "America/Edmonton" } });
  }
  const staleEmps = await prisma.employee.findMany({
    where: { clubId: club.id, employeeNumber: { startsWith: "MHF-" } },
    select: { id: true },
  });
  for (const e of staleEmps) {
    await prisma.employeePortalCredential.deleteMany({ where: { employeeId: e.id } });
    await prisma.employee.deleteMany({ where: { id: e.id } });
  }
  const employeeNumber = `MHF-${Math.floor(Math.random() * 90000 + 10000)}`;
  const password = "Mhf-Pw-1!";
  const passwordHash = await bcrypt.hash(password, 12);
  const employee = await prisma.employee.create({
    data: {
      clubId: club.id, employeeNumber,
      firstName: "Chris", lastName: "MobileHotfix",
      personalEmail: `mhf-${Date.now()}@spec.test`,
      status: "ACTIVE", employeeLifecycle: "ACTIVE",
      portalTourCompletedAt: null,   // Fresh employee → tour active.
    },
  });
  await prisma.employeePortalCredential.create({
    data: { clubId: club.id, employeeId: employee.id, passwordHash, passwordUpdatedAt: new Date() },
  });
  return { clubId: club.id, employeeId: employee.id, employeeNumber, password };
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

test.describe("HR mobile-hotfix @ 390×844", () => {
  test.describe.configure({ mode: "serial" });
  test.slow();
  test.use({ viewport: MOBILE });
  test.beforeAll(async () => { fx = await seedFixture(); });
  test.afterAll(async () => {
    await prisma.employeePortalCredential.deleteMany({ where: { employeeId: fx.employeeId } });
    await prisma.employee.deleteMany({ where: { id: fx.employeeId } });
    await prisma.$disconnect();
  });

  test("§9 — no horizontal scroll on Home", async ({ page }) => {
    await loginAsEmployee(page);
    // Wait for widgets to render.
    await expect(page.locator('[data-testid="portal-home-widgets-grid"]')).toBeVisible();
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(sw).toBeLessThanOrEqual(MOBILE.width + 1);
    await page.screenshot({ path: path.join(OUT, "01-home.png"), fullPage: true });
  });

  test("§6 — mobile widgets are compact (materially smaller than the accepted desktop height)", async ({ page }) => {
    await loginAsEmployee(page);
    const first = page.locator('[data-testid="portal-home-widget-scheduling"]');
    const box = await first.boundingBox();
    expect(box).not.toBeNull();
    // Desktop min-h is 132; mobile compact target is ≤ 108 (min-h-[92px]
    // + typical content). Reject anything ≥ 130 as a regression to the
    // accepted desktop treatment.
    expect(box!.height).toBeLessThanOrEqual(120);
    expect(box!.height).toBeGreaterThanOrEqual(60);
  });

  test("§9 — no horizontal scroll on Profile", async ({ page }) => {
    await loginAsEmployee(page);
    await page.goto(`${BASE}/employee/profile`);
    await expect(page.locator('[data-testid="portal-profile"]')).toBeVisible();
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(sw).toBeLessThanOrEqual(MOBILE.width + 1);
    await page.screenshot({ path: path.join(OUT, "02-profile.png"), fullPage: true });
  });

  test("§10 — hamburger opens drawer without launching tour, then closes cleanly", async ({ page }) => {
    await loginAsEmployee(page);
    // Fresh employee → tour is active. Confirm the popover renders.
    await expect(page.locator('[data-testid="portal-tour"]')).toBeVisible();
    // Tap hamburger.
    await page.locator('[data-testid="portal-mobile-menu-open"]').click();
    await expect(page.locator('[data-testid="portal-mobile-drawer"]')).toBeVisible();
    // Tour popover must temporarily hide while the drawer covers the widget.
    await expect(page.locator('[data-testid="portal-tour"]')).toHaveCount(0);
    // Close drawer via the explicit close button (backdrop clicks
    // can race with the tour popover portal on some viewports).
    await page.locator('[data-testid="portal-mobile-menu-close"]').click();
    await expect(page.locator('[data-testid="portal-mobile-drawer"]')).toHaveCount(0);
    // Tour resumes at the same step — the popover reappears (does NOT reset to Welcome).
    await expect(page.locator('[data-testid="portal-tour"]')).toBeVisible();
    // Step title is still "Welcome …" since we never advanced.
    await expect(page.locator('[data-testid="portal-tour"]')).toContainText(/Welcome/i);
    await page.screenshot({ path: path.join(OUT, "03-drawer-tour-preserved.png"), fullPage: true });
  });

  test("§7 §8 — tour popover fits mobile viewport and is geometrically adjacent to its target", async ({ page }) => {
    await loginAsEmployee(page);
    // Step 0 anchors to the hero (bottom-preferred). Read both rects
    // and prove adjacency.
    const popover = page.locator('[data-testid="portal-tour"]');
    const hero = page.locator('[data-testid="portal-hero"]');
    await expect(popover).toBeVisible();
    const popBox = await popover.boundingBox();
    const heroBox = await hero.boundingBox();
    expect(popBox).not.toBeNull();
    expect(heroBox).not.toBeNull();
    // Popover width fits inside the mobile viewport with margin.
    expect(popBox!.width).toBeLessThanOrEqual(MOBILE.width - 20);
    // Popover is adjacent to the hero: right edge of hero → top of
    // popover, or below the hero. The gap must be ≤ 40 px.
    const heroBottom = heroBox!.y + heroBox!.height;
    const distanceBelow = popBox!.y - heroBottom;
    const distanceAbove = heroBox!.y - (popBox!.y + popBox!.height);
    const distanceRight = popBox!.x - (heroBox!.x + heroBox!.width);
    const distanceLeft = heroBox!.x - (popBox!.x + popBox!.width);
    // At least ONE side (bottom / top / right / left) must be within
    // 40 px — the popover is genuinely adjacent to the hero, not
    // floating in the centre of the viewport.
    const nearest = Math.min(
      Math.abs(distanceBelow),
      Math.abs(distanceAbove),
      Math.abs(distanceRight),
      Math.abs(distanceLeft),
    );
    expect(nearest, `Popover must be adjacent to hero (nearest edge distance = ${nearest})`).toBeLessThanOrEqual(40);
    // Arrow presence + a defined side attribute prove positioning is
    // dynamic, not a static bottom-right fallback.
    await expect(page.locator('[data-testid="coach-mark-arrow"]')).toBeVisible();
    const side = await popover.getAttribute("data-coach-mark-side");
    expect(side, "CoachMark must expose a computed side").toBeTruthy();
    await page.screenshot({ path: path.join(OUT, "04-tour-anchored.png"), fullPage: true });
  });
});
