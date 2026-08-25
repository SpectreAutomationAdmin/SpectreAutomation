// HR-2C Portal Refinement (2026-08-24 / expanded 2026-08-28)
// — Founder acceptance walk.
//
// Desktop:
//   * Header shows FULL name "Chris Turcato" + employee number.
//   * User menu dropdown: Help + Take portal tour + Sign out;
//     standalone Help + Sign out buttons ABSENT.
//   * Six Home widgets in DOM order: Scheduling / Paystubs /
//     Time Off Requests / Forms / Training / Clocking In / Out.
//   * Time Off Requests widget uses the SUITCASE silhouette
//     (no runway line from the old airplane icon).
//   * Widget geometry: first five widgets on row one; sixth widget
//     on row two column one; equal widths; Clocking In / Out .x
//     matches Scheduling .x; Clocking In / Out .y > Scheduling .y.
//   * Header baseline (bottom of top chrome band) aligns between
//     the sidebar identity block and the top bar (both 64px high).
//   * Profile: edit personal email + mobile phone; edit emergency
//     contact; edit home address; submit direct deposit.
//
// Mobile 390 × 844:
//   * Same user menu accessible from the compact header.
//   * Six widgets render as 2 columns × 3 rows.
//   * No horizontal overflow.
//   * Drawer contains Home + Profile only.

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
    await prisma.employeeBankAccount.deleteMany({ where: { employeeId: e.id } });
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
      firstName: "Chris", lastName: "Turcato",
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
    await prisma.employeeBankAccount.deleteMany({ where: { employeeId: fx.employeeId } });
    await prisma.employeeEmergencyContact.deleteMany({ where: { employeeId: fx.employeeId } });
    await prisma.employeePortalCredential.deleteMany({ where: { employeeId: fx.employeeId } });
    await prisma.employee.deleteMany({ where: { id: fx.employeeId } });
  });

  test("Header: FULL name renders + user menu dropdown items are Help / Take tour / Sign out", async ({ page }) => {
    await loginAsEmployee(page);
    await expect(page.locator('[data-testid="portal-help"]')).toHaveCount(0);
    const trigger = page.locator('[data-testid="portal-header"] [data-testid="portal-user-menu-trigger"]');
    await expect(trigger).toBeVisible();
    // FULL name — the core regression the founder called out.
    const nameEl = page.locator('[data-testid="portal-header"] [data-testid="portal-topbar-name"]');
    await expect(nameEl).toHaveText("Chris Turcato");
    await expect(page.locator('[data-testid="portal-header"] [data-testid="portal-topbar-employee-number"]')).toContainText(fx.employeeNumber);
    await trigger.click();
    const dropdown = page.locator('[data-testid="portal-header"] [data-testid="portal-user-menu-dropdown"]');
    await expect(dropdown).toBeVisible();
    await expect(dropdown.locator('[data-testid="portal-user-menu-help"]')).toBeVisible();
    await expect(dropdown.locator('[data-testid="portal-user-menu-take-tour"]')).toBeVisible();
    await expect(dropdown.locator('[data-testid="portal-user-menu-signout"]')).toBeVisible();
    // Profile is NOT in the dropdown — it's a top-level nav item.
    await expect(dropdown.locator('[data-testid="portal-user-menu-profile"]')).toHaveCount(0);
    await page.screenshot({ path: path.join(OUT, "01-user-menu-open.png"), fullPage: true });
  });

  test("Left nav: only Home + Profile", async ({ page }) => {
    await loginAsEmployee(page);
    const nav = page.locator('[data-testid="portal-nav"]');
    await expect(nav).toBeVisible();
    await expect(nav.locator('a')).toHaveCount(2);
    await expect(nav.locator('[data-testid="portal-nav-home"]')).toBeVisible();
    await expect(nav.locator('[data-testid="portal-nav-profile"]')).toBeVisible();
  });

  test("Home: six widgets in DOM order; suitcase, clock, graduation-cap icons", async ({ page }) => {
    await loginAsEmployee(page);
    const grid = page.locator('[data-testid="portal-home-widgets-grid"]');
    await expect(grid).toBeVisible();
    const tiles = grid.locator("> li");
    await expect(tiles).toHaveCount(6);
    const labels = await tiles.locator('[data-testid^="portal-home-widget-label-"]').allTextContents();
    expect(labels).toEqual([
      "Scheduling", "Paystubs", "Time Off Requests", "Forms", "Safety & Training", "Clock In / Out",
    ]);
    // Suitcase has NO runway line (old airplane marker).
    const timeoff = grid.locator('[data-testid="portal-home-widget-time-off-requests"]');
    const timeoffHtml = await timeoff.innerHTML();
    expect(timeoffHtml).not.toContain('y1="20.5"');
    // Suitcase-specific marker: a rect body + a horizontal divider at 12.5.
    expect(timeoffHtml).toContain('<rect');
    // Clocking In/Out uses a clock face.
    const clock = grid.locator('[data-testid="portal-home-widget-clocking-in-out"]');
    const clockHtml = await clock.innerHTML();
    expect(clockHtml).toContain('<circle');
    await page.screenshot({ path: path.join(OUT, "02-home-widgets.png"), fullPage: true });
  });

  test("Desktop geometry: 5+1 layout — Clocking sits below Scheduling with same width", async ({ page }) => {
    await loginAsEmployee(page);
    const first5 = ["scheduling", "paystubs", "time-off-requests", "forms", "training"];
    const boxes = await Promise.all(first5.map(async (k) => {
      const el = page.locator(`[data-testid="portal-home-widget-${k}"]`);
      return el.boundingBox();
    }));
    const scheduling = boxes[0]!;
    // Row-one alignment — every widget's top edge equal within 1px.
    for (const b of boxes) {
      expect(b).not.toBeNull();
      expect(Math.abs(b!.y - scheduling.y)).toBeLessThanOrEqual(1);
    }
    // Sixth widget wraps to row 2 col 1.
    const sixth = await page.locator('[data-testid="portal-home-widget-clocking-in-out"]').boundingBox();
    expect(sixth).not.toBeNull();
    expect(Math.abs(sixth!.x - scheduling.x)).toBeLessThanOrEqual(1);
    expect(sixth!.y).toBeGreaterThan(scheduling.y + 10);
    expect(Math.abs(sixth!.width - scheduling.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(sixth!.height - scheduling.height)).toBeLessThanOrEqual(1);
  });

  test("Header alignment: sidebar identity + top bar bottom borders line up (both 64px)", async ({ page }) => {
    await loginAsEmployee(page);
    const sidebarEyebrow = await page.locator('[data-testid="portal-sidebar"] > div').first().boundingBox();
    const topBar = await page.locator('[data-testid="portal-header"]').boundingBox();
    expect(sidebarEyebrow).not.toBeNull();
    expect(topBar).not.toBeNull();
    expect(Math.abs(sidebarEyebrow!.height - topBar!.height)).toBeLessThanOrEqual(1);
    // Bottom edges of the two chrome blocks line up.
    const sidebarBottom = sidebarEyebrow!.y + sidebarEyebrow!.height;
    const topBarBottom = topBar!.y + topBar!.height;
    expect(Math.abs(sidebarBottom - topBarBottom)).toBeLessThanOrEqual(1);
  });

  test("Profile: edit personal email + mobile phone", async ({ page }) => {
    await loginAsEmployee(page);
    await page.goto(`${BASE}/employee/profile`);
    await expect(page.locator('[data-testid="portal-profile"]')).toBeVisible();
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
    const row = await prisma.employee.findUnique({
      where: { id: fx.employeeId }, select: { personalEmail: true, mobilePhone: true },
    });
    expect(row!.personalEmail).toBe(newEmail.toLowerCase());
    expect(row!.mobilePhone).toBe(newPhone);
    await page.screenshot({ path: path.join(OUT, "03-personal-contact-saved.png"), fullPage: true });
  });

  test("Profile: save home address; province/country/postal upper-cased", async ({ page }) => {
    await loginAsEmployee(page);
    await page.goto(`${BASE}/employee/profile`);
    // The address form auto-opens when no address is on file.
    await page.locator('[data-testid="edit-address-line1"]').fill("123 Fairway Dr");
    await page.locator('[data-testid="edit-address-city"]').fill("Calgary");
    await page.locator('[data-testid="edit-address-province"]').fill("ab");
    await page.locator('[data-testid="edit-address-postal"]').fill("t2p 3n4");
    await page.locator('[data-testid="edit-address-country"]').fill("ca");
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page.locator('[data-testid="save-address"]').click(),
    ]);
    await expect(page.locator('[data-testid="portal-profile-address-line1"]')).toContainText("123 Fairway Dr");
    const row = await prisma.employee.findUnique({
      where: { id: fx.employeeId },
      select: { homeProvince: true, homePostalCode: true, homeCountry: true },
    });
    expect(row!.homeProvince).toBe("AB");
    expect(row!.homePostalCode).toBe("T2P 3N4");
    expect(row!.homeCountry).toBe("CA");
    await page.screenshot({ path: path.join(OUT, "04-address-saved.png"), fullPage: true });
  });

  test("Profile: emergency contact create + update", async ({ page }) => {
    await loginAsEmployee(page);
    await page.goto(`${BASE}/employee/profile`);
    // The emergency-contact form auto-opens for a first-time contact.
    await page.locator('[data-testid="edit-emergency-name"]').fill("Jamie Refine");
    await page.locator('[data-testid="edit-emergency-relation"]').fill("Spouse");
    await page.locator('[data-testid="edit-emergency-phone"]').fill("(403) 555-0888");
    await page.locator('[data-testid="edit-emergency-email"]').fill("jamie.refine@example.test");
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page.locator('[data-testid="save-emergency-contact"]').click(),
    ]);
    await expect(page.locator('[data-testid="portal-profile-emergency-name"]')).toContainText("Jamie Refine");
    await page.locator('[data-testid="btn-edit-emergency-contact"]').click();
    await page.locator('[data-testid="edit-emergency-phone"]').fill("(403) 555-1234");
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page.locator('[data-testid="save-emergency-contact"]').click(),
    ]);
    await expect(page.locator('[data-testid="portal-profile-emergency-phone"]')).toContainText("555-1234");
    const rows = await prisma.employeeEmergencyContact.findMany({ where: { employeeId: fx.employeeId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isPrimary).toBe(true);
    expect(rows[0]!.phone).toBe("(403) 555-1234");
    await page.screenshot({ path: path.join(OUT, "05-emergency-contact.png"), fullPage: true });
  });

  test("Profile: submit direct deposit; row lands PENDING_PENNY_TEST with masked last-4", async ({ page }) => {
    await loginAsEmployee(page);
    await page.goto(`${BASE}/employee/profile`);
    // Section renders in read state showing the empty message; click to open.
    await page.locator('[data-testid="btn-change-direct-deposit"]').click();
    await page.locator('[data-testid="edit-direct-deposit-holder"]').fill("Chris Turcato");
    await page.locator('[data-testid="edit-direct-deposit-institution"]').fill("001");
    await page.locator('[data-testid="edit-direct-deposit-transit"]').fill("12345");
    await page.locator('[data-testid="edit-direct-deposit-account"]').fill("1234567");
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page.locator('[data-testid="save-direct-deposit"]').click(),
    ]);
    await expect(page.locator('[data-testid="portal-profile-banking-status"]')).toContainText("Awaiting Club verification");
    await expect(page.locator('[data-testid="portal-profile-banking-masked"]')).toContainText("4567");
    const rows = await prisma.employeeBankAccount.findMany({ where: { employeeId: fx.employeeId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("PENDING_PENNY_TEST");
    expect(rows[0]!.accountLastFour).toBe("4567");
    await page.screenshot({ path: path.join(OUT, "06-direct-deposit.png"), fullPage: true });
  });
});

test.describe("HR-2C Portal Refinement · mobile", () => {
  test.describe.configure({ mode: "serial" });
  test.slow();
  test.use({ viewport: MOBILE });
  test.beforeAll(async () => { fx = await seedFixture(); });
  test.afterAll(async () => {
    await prisma.employeeBankAccount.deleteMany({ where: { employeeId: fx.employeeId } });
    await prisma.employeeEmergencyContact.deleteMany({ where: { employeeId: fx.employeeId } });
    await prisma.employeePortalCredential.deleteMany({ where: { employeeId: fx.employeeId } });
    await prisma.employee.deleteMany({ where: { id: fx.employeeId } });
    await prisma.$disconnect();
  });

  test("Mobile: user menu dropdown fits inside viewport", async ({ page }) => {
    await loginAsEmployee(page);
    const trigger = page.locator('[data-testid="portal-mobile-topbar"] [data-testid="portal-user-menu-trigger"]');
    await expect(trigger).toBeVisible();
    await trigger.click();
    const dropdown = page.locator('[data-testid="portal-mobile-topbar"] [data-testid="portal-user-menu-dropdown"]');
    await expect(dropdown).toBeVisible();
    const box = await dropdown.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(MOBILE.width + 2);
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(MOBILE.width);
  });

  test("Mobile: six widgets render as exactly 2 columns × 3 rows; equal size", async ({ page }) => {
    await loginAsEmployee(page);
    const grid = page.locator('[data-testid="portal-home-widgets-grid"]');
    await expect(grid).toBeVisible();
    const boxes = await Promise.all(
      ["scheduling", "paystubs", "time-off-requests", "forms", "training", "clocking-in-out"]
        .map((k) => page.locator(`[data-testid="portal-home-widget-${k}"]`).boundingBox()),
    );
    for (const b of boxes) expect(b).not.toBeNull();
    // Column check: 6 boxes → x has 2 unique values, y has 3 unique values (within 2 px tolerance).
    const uniqueX = new Set(boxes.map((b) => Math.round(b!.x / 2) * 2));
    const uniqueY = new Set(boxes.map((b) => Math.round(b!.y / 2) * 2));
    expect(uniqueX.size).toBe(2);
    expect(uniqueY.size).toBe(3);
    // Equal size across all six.
    const w0 = boxes[0]!.width;
    const h0 = boxes[0]!.height;
    for (const b of boxes) {
      expect(Math.abs(b!.width - w0)).toBeLessThanOrEqual(1);
      expect(Math.abs(b!.height - h0)).toBeLessThanOrEqual(1);
    }
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(MOBILE.width);
    await page.screenshot({ path: path.join(OUT, "07-mobile-2x3.png"), fullPage: true });
  });

  test("Mobile drawer: Home + Profile only", async ({ page }) => {
    await loginAsEmployee(page);
    await page.locator('[data-testid="portal-mobile-menu-open"]').click();
    const nav = page.locator('[data-testid="portal-mobile-nav"]');
    await expect(nav).toBeVisible();
    await expect(nav.locator('a')).toHaveCount(2);
    await expect(nav.locator('[data-testid="portal-mobile-nav-home"]')).toBeVisible();
    await expect(nav.locator('[data-testid="portal-mobile-nav-profile"]')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "08-mobile-drawer.png"), fullPage: true });
  });
});
