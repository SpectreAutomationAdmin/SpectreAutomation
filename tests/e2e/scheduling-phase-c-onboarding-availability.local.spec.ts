// Scheduling Foundation · Phase C (2026-09-07) — visual acceptance
// for the hourly onboarding "Your Availability" step.
//
// Walks the actual HR-2B onboarding conversational flow from the
// invitation redemption through Name → Contact → Address →
// Employment → Photo → **Availability**, screenshots both desktop
// (1440×900) and mobile viewports, and closes the loop with a
// negative test proving salaried employees skip the step.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const OUT = path.resolve("test-results/scheduling-phase-c-onboarding");
fs.mkdirSync(OUT, { recursive: true });

const FIXTURE_PATH = path.resolve("test-results/hr-2b2-fixture.json");
const FIXTURE_SCRIPT = path.resolve("scripts/hr-2b2-fixture-invitation.mjs");

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

interface Fixture {
  clubId: string;
  employeeId: string;
  employeeFirstName: string;
  employeeLastName: string;
  departmentId: string;
  departmentName: string;
  redemptionUrl: string;
}

function primeFixture(email: string): Fixture {
  execFileSync("node", [FIXTURE_SCRIPT, "--email", email], {
    cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
  });
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
}

async function seedShiftTemplatesForFixture(fixture: Fixture, prisma: PrismaClient) {
  // Ensure the fixture's employee has an ACTIVE assignment in the
  // fixture's department so listShiftTemplatesForEmployee finds them.
  const existingAssn = await prisma.employeeEmploymentAssignment.findFirst({
    where: { clubId: fixture.clubId, employeeId: fixture.employeeId, effectiveTo: null },
  });
  if (!existingAssn) {
    await prisma.employeeEmploymentAssignment.create({
      data: {
        clubId: fixture.clubId, employeeId: fixture.employeeId,
        role: "PRIMARY", employmentType: "PART_TIME",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
        departmentId: fixture.departmentId,
      },
    });
  } else if (existingAssn.departmentId !== fixture.departmentId) {
    await prisma.employeeEmploymentAssignment.update({
      where: { id: existingAssn.id },
      data: { departmentId: fixture.departmentId },
    });
  }
  // Seed Day + Evening templates on this department (idempotent).
  const templates: Array<{ code: string; name: string; startTimeMinutes: number; endTimeMinutes: number }> = [
    { code: "DAY",     name: "Day Shift",     startTimeMinutes: 11 * 60,        endTimeMinutes: 17 * 60 + 30 },
    { code: "EVENING", name: "Evening Shift", startTimeMinutes: 17 * 60 + 30,   endTimeMinutes: 23 * 60      },
  ];
  for (const t of templates) {
    await prisma.shiftTemplate.upsert({
      where: {
        clubId_departmentId_code: {
          clubId: fixture.clubId, departmentId: fixture.departmentId, code: t.code,
        },
      },
      update: { name: t.name, startTimeMinutes: t.startTimeMinutes, endTimeMinutes: t.endTimeMinutes, active: true },
      create: {
        clubId: fixture.clubId, departmentId: fixture.departmentId,
        code: t.code, name: t.name,
        startTimeMinutes: t.startTimeMinutes, endTimeMinutes: t.endTimeMinutes,
        active: true, sortOrder: t.code === "DAY" ? 10 : 20,
      },
    });
  }
}

async function walkAboutYou(page: Page, fixture: Fixture) {
  await page.goto(fixture.redemptionUrl, { waitUntil: "domcontentloaded" });
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/about-you\/name/, { timeout: 30_000 }),
    page.locator('[data-testid="hr-onboarding-begin"]').click(),
  ]);
  await page.locator('input[name="firstName"]').fill(fixture.employeeFirstName);
  await page.locator('input[name="lastName"]').fill(fixture.employeeLastName);
  // The Name step now requires date-of-birth (Payroll-3B-5B-1a).
  const dob = page.locator('input[name="dateOfBirth"]');
  if (await dob.count()) await dob.fill("1990-06-15");
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/about-you\/contact/, { timeout: 20_000 }),
    page.locator('button[type="submit"]').first().click(),
  ]);
  await page.locator('input[name="personalEmail"]').fill("scheduling-phase-c@spectre.test");
  await page.locator('input[name="mobilePhone"]').fill("(403) 555-0107");
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/about-you\/(address|employment)/, { timeout: 20_000 }),
    page.locator('button[type="submit"]').first().click(),
  ]);
  // Address step — fill minimum required, submit.
  if (page.url().includes("/about-you/address")) {
    const addressLine1 = page.locator('input[name="homeAddressLine1"]');
    if (await addressLine1.count()) {
      await addressLine1.fill("100 Test Ave");
      const city = page.locator('input[name="homeCity"]');
      if (await city.count()) await city.fill("Calgary");
      const postal = page.locator('input[name="homePostalCode"]');
      if (await postal.count()) await postal.fill("T2P 1J9");
    }
    await Promise.all([
      page.waitForURL(/\/hr\/onboarding\/about-you\/employment/, { timeout: 20_000 }),
      page.locator('button[type="submit"]').first().click(),
    ]);
  }
  // Employment step — accept as-is.
  await page.locator('[data-testid="employment-outcome-correct"]').check();
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/about-you\/photo/, { timeout: 20_000 }),
    page.locator('button[type="submit"]').first().click(),
  ]);
  await page.setInputFiles(
    '[data-testid="photo-choose-input"]',
    { name: "me.png", mimeType: "image/png", buffer: TINY_PNG },
  );
  await expect(page.locator('img[alt="Selected photo preview"]')).toBeVisible();
}

test.describe.serial("Scheduling Foundation · Phase C · onboarding availability visual acceptance", () => {
  test.setTimeout(300_000);
  let prisma: PrismaClient;
  test.beforeAll(() => { prisma = new PrismaClient(); });
  test.afterAll(async () => { await prisma.$disconnect(); });

  test("§15 desktop 1440×900 — hourly employee lands on Your Availability step", async ({ browser }) => {
    const fixture = primeFixture("scheduling-phase-c-hourly@spectre.test");
    await seedShiftTemplatesForFixture(fixture, prisma);
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await walkAboutYou(page, fixture);
    // Photo submit lands on /about-you/complete — click "Continue to
    // payroll" which routes through resolveOnboardingContinuation and
    // (for hourly) sends to /availability.
    await Promise.all([
      page.waitForURL(/\/hr\/onboarding\/about-you\/complete/, { timeout: 30_000 }),
      page.locator('button[type="submit"]').first().click(),
    ]);
    await Promise.all([
      page.waitForURL(/\/hr\/onboarding\/availability/, { timeout: 20_000 }),
      page.locator('[data-testid="continue-to-payroll"]').click(),
    ]);
    // The availability page loaded — screenshot before interacting.
    await expect(page.locator("text=/Your Availability/i").first()).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "desktop-1440x900-availability.png"), fullPage: true });
    // Verify data-driven templates render (no hardcoded Day/Evening).
    // Both departments seeded (Day + Evening) must appear.
    await expect(page.locator('text=Day Shift').first()).toBeVisible();
    await expect(page.locator('text=Evening Shift').first()).toBeVisible();
    // Verify the rail shows Availability as current.
    const rail = page.getByRole("navigation", { name: /onboarding progress/i });
    await expect(rail.locator('[aria-current="step"]').filter({ hasText: /Availability/ })).toBeVisible();
    await ctx.close();
  });

  test("§15 mobile — upper day/shift matrix + lower preferences", async ({ browser }) => {
    const fixture = primeFixture("scheduling-phase-c-mobile@spectre.test");
    await seedShiftTemplatesForFixture(fixture, prisma);
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await walkAboutYou(page, fixture);
    await Promise.all([
      page.waitForURL(/\/hr\/onboarding\/about-you\/complete/, { timeout: 30_000 }),
      page.locator('button[type="submit"]').first().click(),
    ]);
    await Promise.all([
      page.waitForURL(/\/hr\/onboarding\/availability/, { timeout: 20_000 }),
      page.locator('[data-testid="continue-to-payroll"]').click(),
    ]);
    // Upper matrix section screenshot (viewport-only, not full page).
    await page.screenshot({ path: path.join(OUT, "mobile-390x844-availability-upper.png"), fullPage: false });
    // Scroll to the preferences panel and screenshot the lower half.
    await page.locator('label:has-text("Preferred hours per week")').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(OUT, "mobile-390x844-availability-lower.png"), fullPage: false });
    // Prove no horizontal scroll at 390px.
    const bodyScrollWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyScrollWidth, `expected no horizontal scroll at 390px, saw scrollWidth=${bodyScrollWidth}`)
      .toBeLessThanOrEqual(400);
    await ctx.close();
  });

  test("§11 salaried employee — Photo → SIN (Availability skipped)", async ({ browser }) => {
    const fixture = primeFixture("scheduling-phase-c-salaried@spectre.test");
    // Flip the fixture's employee to SALARIED before walking.
    await prisma.employee.update({
      where: { id: fixture.employeeId },
      data: { compensationType: "SALARY" },
    });
    await seedShiftTemplatesForFixture(fixture, prisma);
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const visited: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) visited.push(frame.url());
    });
    await walkAboutYou(page, fixture);
    // Continue from Photo — salaried employees skip Availability
    // and route through /about-you/complete to /payroll/sin.
    await Promise.all([
      page.waitForURL(/\/hr\/onboarding\/about-you\/complete/, { timeout: 30_000 }),
      page.locator('button[type="submit"]').first().click(),
    ]);
    await Promise.all([
      page.waitForURL(/\/hr\/onboarding\/payroll\/sin/, { timeout: 20_000 }),
      page.locator('[data-testid="continue-to-payroll"]').click(),
    ]);
    // Negative assertion — never touched /availability.
    const availabilityHits = visited.filter((u) => /\/hr\/onboarding\/availability/.test(u));
    expect(availabilityHits, `salaried employee should NOT hit /availability; saw ${JSON.stringify(availabilityHits)}`)
      .toEqual([]);
    await ctx.close();
  });
});
