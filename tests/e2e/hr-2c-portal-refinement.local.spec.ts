// HR-2C Portal Refinement (2026-08-24) — Founder acceptance walk.
//
// Desktop:
//   * Header user menu (single account entry point).
//   * Open dropdown → Profile / Take portal tour / Sign out.
//   * Standalone Help + Sign out buttons ABSENT.
//   * Time Off widget uses the corrected airplane silhouette (icon
//     is a plane on a runway, not the sun-with-rays and not the
//     previous cursive shape).
//   * Profile: edit personal email + mobile phone → save → values
//     update.
//   * Profile: edit emergency contact (create + update path) → save.
// Mobile 390 × 844:
//   * Same user menu accessible from the compact header.
//   * Menu items reachable inside the viewport.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const OUT = path.resolve("test-results/hr-2c-portal-refinement");
fs.mkdirSync(OUT, { recursive: true });
const prisma = new PrismaClient();
const BASE = "http://silver-springs.localtest.me:3000";
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

interface Fixture { employeeId: string; employeeNumber: string; password: string; }
let fx: Fixture;

async function seedFixture(): Promise<Fixture> {
  const club = await prisma.club.findFirst({ where: { slug: "silver-springs" } });
  if (!club) throw new Error("[Portal Refinement] Silver Springs not seeded.");
  const staleEmps = await prisma.employee.findMany({
    where: { clubId: club.id, employeeNumber: { startsWith: "REFINE-" } },
    select: { id: true },
  });
  for (const e of staleEmps) {
    await prisma.employeeEmergencyContact.deleteMany({ where: { employeeId: e.id } });
    await prisma.employeeHomeNotificationDismissal.deleteMany({ where: { employeeId: e.id } });
    await prisma.employeePortalCredential.deleteMany({ where: { employeeId: e.id } });
    await prisma.employee.deleteMany({ where: { id: e.id } });
  }
  const employeeNumber = `REFINE-${Math.floor(Math.random() * 90000 + 10000)}`;
  const password = "Refine-Pw-1!";
  const passwordHash = await bcrypt.hash(password, 12);
  const employee = await prisma.employee.create({
    data: {
      clubId: club.id, employeeNumber,
      firstName: "Chris", lastName: `Refine-${Date.now().toString().slice(-6)}`,
      personalEmail: `refine-${Date.now()}@spec.test`,
      mobilePhone: "(403) 555-0000",
      status: "ACTIVE", employeeLifecycle: "ACTIVE",
      portalTourCompletedAt: new Date(),
    },
  });
  await prisma.employeePortalCredential.create({
    data: { clubId: club.id, employeeId: employee.id, passwordHash, passwordUpdatedAt: new Date() },
  });
  return { employeeId: employee.id, employeeNumber, password };
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

test.describe("HR-2C Portal Refinement · desktop", () => {
  test.describe.configure({ mode: "serial" });
  test.slow();
  test.use({ viewport: DESKTOP });
  test.beforeAll(async () => { fx = await seedFixture(); });
  test.afterAll(async () => {
    await prisma.employeeEmergencyContact.deleteMany({ where: { employeeId: fx.employeeId } });
    await prisma.employeePortalCredential.deleteMany({ where: { employeeId: fx.employeeId } });
    await prisma.employee.deleteMany({ where: { id: fx.employeeId } });
  });

  test("Header: user menu is the single account entry point; Help + Sign out are inside the dropdown", async ({ page }) => {
    await loginAsEmployee(page);
    // No standalone Help button in the header.
    await expect(page.locator('[data-testid="portal-help"]')).toHaveCount(0);
    // Two DOM triggers exist (desktop header + mobile top bar),
    // both hidden/shown by responsive classes. Scope to the desktop
    // header for this desktop test.
    const trigger = page.locator('[data-testid="portal-header"] [data-testid="portal-user-menu-trigger"]');
    await expect(trigger).toBeVisible();
    await expect(page.locator('[data-testid="portal-header"] [data-testid="portal-topbar-name"]')).toContainText("Chris");
    await expect(page.locator('[data-testid="portal-header"] [data-testid="portal-topbar-employee-number"]')).toContainText(fx.employeeNumber);
    await trigger.click();
    const dropdown = page.locator('[data-testid="portal-header"] [data-testid="portal-user-menu-dropdown"]');
    await expect(dropdown).toBeVisible();
    await expect(dropdown.locator('[data-testid="portal-user-menu-profile"]')).toHaveAttribute("href", "/employee/profile");
    await expect(dropdown.locator('[data-testid="portal-user-menu-take-tour"]')).toBeVisible();
    await expect(dropdown.locator('[data-testid="portal-user-menu-signout"]')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "01-user-menu-open.png"), fullPage: true });
  });

  test("Time Off widget uses the corrected airplane silhouette", async ({ page }) => {
    await loginAsEmployee(page);
    // The widget still exists, and its SVG now contains a runway
    // (bottom horizontal line) — this is the visual anchor for the
    // corrected side-profile airplane icon.
    const widget = page.locator('[data-testid="portal-home-widget-time-off-requests"]');
    await expect(widget).toBeVisible();
    // The runway line has y1="20.5" — a unique marker of the new icon.
    const html = await widget.innerHTML();
    expect(html).toContain('y1="20.5"');
    expect(html).toContain('y2="20.5"');
    await page.screenshot({ path: path.join(OUT, "02-timeoff-icon.png"), fullPage: true });
  });

  test("Profile: edit personal email + mobile phone → values update", async ({ page }) => {
    await loginAsEmployee(page);
    await page.goto(`${BASE}/employee/profile`);
    await expect(page.locator('[data-testid="portal-profile"]')).toBeVisible();

    // Read baseline.
    await expect(page.locator('[data-testid="portal-profile-email"]')).toContainText("refine-");

    // Open editor + save new values.
    await page.locator('[data-testid="btn-edit-personal-contact"]').click();
    const newEmail = `chris.refine.${Date.now()}@example.test`;
    const newPhone = "(587) 555-0011";
    await page.locator('[data-testid="edit-personal-email"]').fill(newEmail);
    await page.locator('[data-testid="edit-personal-mobile"]').fill(newPhone);
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page.locator('[data-testid="save-personal-contact"]').click(),
    ]);
    await expect(page.locator('[data-testid="portal-profile-email"]')).toContainText(newEmail);
    await expect(page.locator('[data-testid="portal-profile-mobile"]')).toContainText(newPhone);

    // DB assertion.
    const row = await prisma.employee.findUnique({
      where: { id: fx.employeeId }, select: { personalEmail: true, mobilePhone: true },
    });
    expect(row!.personalEmail).toBe(newEmail.toLowerCase());
    expect(row!.mobilePhone).toBe(newPhone);
    await page.screenshot({ path: path.join(OUT, "03-personal-contact-saved.png"), fullPage: true });
  });

  test("Profile: emergency contact — create + then update", async ({ page }) => {
    await loginAsEmployee(page);
    await page.goto(`${BASE}/employee/profile`);
    // Create form is open by default when contact is null.
    await page.locator('[data-testid="edit-emergency-name"]').fill("Jamie Refine");
    await page.locator('[data-testid="edit-emergency-relation"]').fill("Spouse");
    await page.locator('[data-testid="edit-emergency-phone"]').fill("(403) 555-0888");
    await page.locator('[data-testid="edit-emergency-email"]').fill("jamie.refine@example.test");
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page.locator('[data-testid="save-emergency-contact"]').click(),
    ]);
    await expect(page.locator('[data-testid="portal-profile-emergency-name"]')).toContainText("Jamie Refine");
    await expect(page.locator('[data-testid="portal-profile-emergency-phone"]')).toContainText("555-0888");

    // Update path — edit affordance appears now.
    await page.locator('[data-testid="btn-edit-emergency-contact"]').click();
    await page.locator('[data-testid="edit-emergency-phone"]').fill("(403) 555-1234");
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page.locator('[data-testid="save-emergency-contact"]').click(),
    ]);
    await expect(page.locator('[data-testid="portal-profile-emergency-phone"]')).toContainText("555-1234");

    // DB — one primary row only, updated in place.
    const rows = await prisma.employeeEmergencyContact.findMany({
      where: { employeeId: fx.employeeId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isPrimary).toBe(true);
    expect(rows[0]!.phone).toBe("(403) 555-1234");
    await page.screenshot({ path: path.join(OUT, "04-emergency-contact.png"), fullPage: true });
  });
});

test.describe("HR-2C Portal Refinement · mobile", () => {
  test.describe.configure({ mode: "serial" });
  test.slow();
  test.use({ viewport: MOBILE });
  test.beforeAll(async () => { fx = await seedFixture(); });
  test.afterAll(async () => {
    await prisma.employeeEmergencyContact.deleteMany({ where: { employeeId: fx.employeeId } });
    await prisma.employeePortalCredential.deleteMany({ where: { employeeId: fx.employeeId } });
    await prisma.employee.deleteMany({ where: { id: fx.employeeId } });
    await prisma.$disconnect();
  });

  test("Mobile: user menu accessible from compact header; dropdown fits viewport", async ({ page }) => {
    await loginAsEmployee(page);
    // Scope to the mobile top bar — both DOM triggers exist.
    const trigger = page.locator('[data-testid="portal-mobile-topbar"] [data-testid="portal-user-menu-trigger"]');
    await expect(trigger).toBeVisible();
    await trigger.click();
    const dropdown = page.locator('[data-testid="portal-mobile-topbar"] [data-testid="portal-user-menu-dropdown"]');
    await expect(dropdown).toBeVisible();
    // Fits within viewport.
    const box = await dropdown.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(MOBILE.width + 2);
    await page.screenshot({ path: path.join(OUT, "05-mobile-user-menu.png"), fullPage: true });
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(MOBILE.width);
  });
});
