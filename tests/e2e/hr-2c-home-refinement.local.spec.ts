// HR-2C Home refinement (2026-08-24) — Employee Portal Home layout.
//
// Founder acceptance walk:
//   Desktop
//     * hero renders;
//     * warning info bar sits immediately beneath hero when required
//       training is outstanding;
//     * × dismisses the bar;
//     * dismissal persists across refresh;
//     * underlying training eligibility remains unchanged;
//     * all five widgets render;
//     * real widgets navigate to correct routes;
//     * unavailable widgets do not pretend to work;
//     * old Welcome / profile-summary content is absent.
//   Mobile — 390 × 844
//     * hero renders;
//     * information bar wraps appropriately;
//     * dismissal control is reachable;
//     * widget layout is usable;
//     * mobile drawer remains functional;
//     * document.documentElement.scrollWidth ≤ viewport width.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const OUT = path.resolve("test-results/hr-2c-home-refinement");
fs.mkdirSync(OUT, { recursive: true });

const prisma = new PrismaClient();
const BASE = "http://silver-springs.localtest.me:3000";

const TINY_MP4 = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
]);

interface Fixture {
  clubId: string;
  employeeId: string;
  employeeNumber: string;
  password: string;
  courseId: string;
  versionId: string;
}

let fx: Fixture;

async function seedFixture(): Promise<Fixture> {
  const club = await prisma.club.findFirst({ where: { slug: "silver-springs" } });
  if (!club) throw new Error("[HR-2C Home] Silver Springs not seeded — run `npm run db:seed`.");

  // Purge stale test-only courses + employees so counts are deterministic.
  const stale = await prisma.trainingCourse.findMany({
    where: {
      clubId: club.id,
      OR: [
        { code: { startsWith: "HOME_" } },
        { code: { startsWith: "B4_" } },
        { code: { startsWith: "B3_" } },
        { code: { startsWith: "B31_" } },
        { code: { startsWith: "HR2C_B2_" } },
      ],
    },
    select: { id: true, versions: { select: { id: true } } },
  });
  for (const c of stale) {
    const vids = c.versions.map((v) => v.id);
    if (vids.length > 0) {
      await prisma.trainingCompletion.deleteMany({ where: { courseVersionId: { in: vids } } });
      await prisma.trainingQuestionResponse.deleteMany({
        where: { attempt: { courseVersionId: { in: vids } } },
      });
      await prisma.trainingAttempt.deleteMany({ where: { courseVersionId: { in: vids } } });
      await prisma.trainingProgress.deleteMany({ where: { courseVersionId: { in: vids } } });
      await prisma.trainingAnswerOption.deleteMany({
        where: { question: { courseVersionId: { in: vids } } },
      });
      await prisma.trainingQuestion.deleteMany({ where: { courseVersionId: { in: vids } } });
      await prisma.trainingCourseVersion.deleteMany({ where: { id: { in: vids } } });
    }
    await prisma.trainingCourse.deleteMany({ where: { id: c.id } });
  }
  const staleEmps = await prisma.employee.findMany({
    where: { clubId: club.id, employeeNumber: { startsWith: "HOME-" } },
    select: { id: true },
  });
  for (const e of staleEmps) {
    await prisma.employeeAvailabilityWeek.deleteMany({ where: { employeeId: e.id } });
    await prisma.employeeHomeNotificationDismissal.deleteMany({ where: { employeeId: e.id } });
    await prisma.employeePortalCredential.deleteMany({ where: { employeeId: e.id } });
    await prisma.employee.deleteMany({ where: { id: e.id } });
  }

  const employeeNumber = `HOME-${Math.floor(Math.random() * 90000 + 10000)}`;
  const password = "Home-Spec-Pw-1!";
  const passwordHash = await bcrypt.hash(password, 12);
  const employee = await prisma.employee.create({
    data: {
      clubId: club.id,
      employeeNumber,
      firstName: "HomeWalker",
      lastName: `Home-${Date.now().toString().slice(-6)}`,
      personalEmail: `home-${Date.now()}@spec.test`,
      status: "ACTIVE",
      employeeLifecycle: "ACTIVE",
      // Dismiss the first-login tour so it doesn't race the walk.
      portalTourCompletedAt: new Date(),
    },
  });
  await prisma.employeePortalCredential.create({
    data: {
      clubId: club.id,
      employeeId: employee.id,
      passwordHash,
      passwordUpdatedAt: new Date(),
    },
  });

  // Publish a required applies-to-all course so the employee shows
  // as ineligible → the warning bar appears.
  const course = await prisma.trainingCourse.create({
    data: {
      clubId: club.id,
      code: `HOME_${employeeNumber}`,
      title: "Home Refinement Fixture Course",
      category: "Safety",
      description: "Fixture for the Home refinement walk.",
    },
  });
  const version = await prisma.trainingCourseVersion.create({
    data: {
      courseId: course.id,
      version: 1,
      state: "PUBLISHED",
      title: course.title,
      description: course.description,
      passingScore: 80,
      retakesAllowed: true,
      requiresKnowledgeTest: true,
      required: true,
      appliesToAll: true,
      publishedAt: new Date(),
      videoStorageKey: `clubs/${club.id}/training/${course.id}/1/home-fixture`,
      videoMimeType: "video/mp4",
      videoSizeBytes: TINY_MP4.length,
      videoSha256: "homefixture" + "0".repeat(64 - 11),
      videoDurationSec: 60,
    },
  });
  await prisma.trainingCourse.update({
    where: { id: course.id }, data: { currentVersionId: version.id },
  });
  await prisma.trainingQuestion.create({
    data: {
      courseVersionId: version.id,
      prompt: "Where do you find your Club's required training?",
      displayOrder: 0,
      active: true,
      options: {
        create: [
          { text: "In your email inbox", isCorrect: false, displayOrder: 0 },
          { text: "In Training on your Employee Portal", isCorrect: true, displayOrder: 1 },
        ],
      },
    },
  });

  return {
    clubId: club.id,
    employeeId: employee.id,
    employeeNumber,
    password,
    courseId: course.id,
    versionId: version.id,
  };
}

async function loginAsEmployee(page: Page): Promise<void> {
  await page.goto(`${BASE}/employee/login`);
  await page.locator('input[name="employeeNumber"]').fill(fx.employeeNumber);
  await page.locator('input[name="password"]').fill(fx.password);
  await Promise.all([
    page.waitForURL(/\/employee(?!\/login)/, { timeout: 30_000 }),
    page.locator('button[type="submit"]').first().click(),
  ]);
}

async function noHorizontalOverflow(page: Page) {
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

test.describe("HR-2C Home refinement · desktop", () => {
  test.describe.configure({ mode: "serial" });
  test.slow();

  test.beforeAll(async () => { fx = await seedFixture(); });

  test.afterAll(async () => {
    // NOTE: intentionally does NOT $disconnect — the mobile describe
    // below reuses the same shared prisma client. The mobile
    // describe's afterAll handles the final disconnect.
    await prisma.employeeAvailabilityWeek.deleteMany({ where: { employeeId: fx.employeeId } });
    await prisma.employeeHomeNotificationDismissal.deleteMany({ where: { employeeId: fx.employeeId } });
    await prisma.trainingCompletion.deleteMany({ where: { courseVersionId: fx.versionId } });
    await prisma.trainingQuestionResponse.deleteMany({
      where: { attempt: { courseVersionId: fx.versionId } },
    });
    await prisma.trainingAttempt.deleteMany({ where: { courseVersionId: fx.versionId } });
    await prisma.trainingProgress.deleteMany({ where: { courseVersionId: fx.versionId } });
    await prisma.trainingAnswerOption.deleteMany({
      where: { question: { courseVersionId: fx.versionId } },
    });
    await prisma.trainingQuestion.deleteMany({ where: { courseVersionId: fx.versionId } });
    await prisma.trainingCourseVersion.deleteMany({ where: { id: fx.versionId } });
    await prisma.trainingCourse.deleteMany({ where: { id: fx.courseId } });
    await prisma.employeePortalCredential.deleteMany({ where: { employeeId: fx.employeeId } });
    await prisma.employee.deleteMany({ where: { id: fx.employeeId } });
  });

  test("Hero + notification bar + all five widgets render; Welcome / profile summary are absent", async ({ page }) => {
    await loginAsEmployee(page);

    // Hero renders.
    await expect(page.locator('[data-testid="portal-hero"]')).toBeVisible();

    // Notification bar renders and is a warning tone.
    const bar = page.locator('[data-testid="portal-home-notification"]').first();
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute("data-notification-tone", "warning");
    await expect(bar).toContainText(/required training/i);

    // All five widgets render with founder-facing labels.
    for (const label of ["Scheduling", "Paystubs", "Time Off Requests", "Forms", "Training"]) {
      await expect(page.locator('[data-testid="portal-home-widgets-grid"]')).toContainText(label);
    }
    // Old welcome/profile content is gone.
    await expect(page.locator("text=Welcome to your employee portal")).toHaveCount(0);
    await expect(page.locator('[data-testid="portal-home-summary"]')).toHaveCount(0);

    // Real widgets are anchor tags with real hrefs.
    const scheduling = page.locator('[data-testid="portal-home-widget-scheduling"]');
    await expect(scheduling).toHaveAttribute("data-widget-available", "true");
    await expect(scheduling).toHaveAttribute("href", "/employee/schedule");

    const paystubs = page.locator('[data-testid="portal-home-widget-paystubs"]');
    await expect(paystubs).toHaveAttribute("data-widget-available", "true");
    await expect(paystubs).toHaveAttribute("href", "/employee/pay");

    const training = page.locator('[data-testid="portal-home-widget-training"]');
    await expect(training).toHaveAttribute("data-widget-available", "true");
    await expect(training).toHaveAttribute("href", "/employee/safety-training");

    // Non-navigational widgets (Time Off Requests + Forms) stay
    // visually identical but do not masquerade as working links.
    // They render as role="link" + aria-disabled="true" + no href +
    // tabIndex=-1. They also carry NO status/explainer copy.
    const timeOff = page.locator('[data-testid="portal-home-widget-time-off-requests"]');
    await expect(timeOff).toHaveAttribute("data-widget-available", "false");
    await expect(timeOff).toHaveAttribute("aria-disabled", "true");
    await expect(timeOff).not.toHaveAttribute("href", /.+/);
    await expect(timeOff).not.toContainText(/Unavailable/i);
    await expect(timeOff).not.toContainText(/coming soon/i);

    const forms = page.locator('[data-testid="portal-home-widget-forms"]');
    await expect(forms).toHaveAttribute("data-widget-available", "false");
    await expect(forms).toHaveAttribute("aria-disabled", "true");
    await expect(forms).not.toHaveAttribute("href", /.+/);
    await expect(forms).not.toContainText(/Unavailable/i);

    await page.screenshot({ path: path.join(OUT, "01-home-desktop-with-notification.png"), fullPage: true });
  });

  test("× dismisses the bar; dismissal persists on reload; eligibility is unchanged", async ({ page }) => {
    await loginAsEmployee(page);
    const bar = page.locator('[data-testid="portal-home-notification"]').first();
    await expect(bar).toBeVisible();

    // Capture the underlying eligibility BEFORE dismiss.
    const before = await prisma.trainingCompletion.count({ where: { employeeId: fx.employeeId, courseVersionId: fx.versionId } });
    expect(before).toBe(0); // employee still has NOT passed the course

    await page.locator('[data-testid="portal-home-notification-dismiss"]').first().click();
    // The bar disappears optimistically.
    await expect(page.locator('[data-testid="portal-home-notification"]')).toHaveCount(0);

    // Dismissal row persisted.
    await expect
      .poll(async () =>
        prisma.employeeHomeNotificationDismissal.count({ where: { employeeId: fx.employeeId } }),
      )
      .toBeGreaterThanOrEqual(1);

    // Underlying eligibility unchanged — no completion, no availability change.
    const after = await prisma.trainingCompletion.count({ where: { employeeId: fx.employeeId, courseVersionId: fx.versionId } });
    expect(after).toBe(0);

    await page.screenshot({ path: path.join(OUT, "02-home-desktop-after-dismiss.png"), fullPage: true });

    // Reload — the bar stays dismissed (persistence).
    await page.goto(`${BASE}/employee`);
    await expect(page.locator('[data-testid="portal-home-notification"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="portal-hero"]')).toBeVisible();
    // Widgets still there.
    await expect(page.locator('[data-testid="portal-home-widget-scheduling"]')).toBeVisible();

    // Safety & Training page STILL shows the outstanding course.
    await page.goto(`${BASE}/employee/safety-training`);
    await expect(page.locator('[data-testid="portal-safety-training-required"]')).toBeVisible();
    // Availability page STILL shows blocked.
    await page.goto(`${BASE}/employee/availability`);
    await expect(page.locator('[data-testid="portal-availability-training-required"]')).toBeVisible();
  });
});

test.describe("HR-2C Home refinement · mobile 390×844", () => {
  test.describe.configure({ mode: "serial" });
  test.slow();
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeAll(async () => {
    // The desktop describe's afterAll deletes the seeded rows, so
    // always re-seed for the mobile describe. seedFixture is
    // idempotent (purges HOME-* leftovers first).
    fx = await seedFixture();
  });

  test.afterAll(async () => {
    await prisma.employeeAvailabilityWeek.deleteMany({ where: { employeeId: fx.employeeId } });
    await prisma.employeeHomeNotificationDismissal.deleteMany({ where: { employeeId: fx.employeeId } });
    await prisma.trainingProgress.deleteMany({ where: { courseVersionId: fx.versionId } });
    await prisma.trainingAnswerOption.deleteMany({
      where: { question: { courseVersionId: fx.versionId } },
    });
    await prisma.trainingQuestion.deleteMany({ where: { courseVersionId: fx.versionId } });
    await prisma.trainingCourseVersion.deleteMany({ where: { id: fx.versionId } });
    await prisma.trainingCourse.deleteMany({ where: { id: fx.courseId } });
    await prisma.employeePortalCredential.deleteMany({ where: { employeeId: fx.employeeId } });
    await prisma.employee.deleteMany({ where: { id: fx.employeeId } });
    await prisma.$disconnect();
  });

  test("Hero + notification bar wrap + widgets grid render without horizontal overflow; drawer works", async ({ page }) => {
    await loginAsEmployee(page);

    // Hero + notification bar (from the earlier dismissal test the bar
    // may already be dismissed; re-create a fresh dismissal state
    // by clearing dismissals first).
    await prisma.employeeHomeNotificationDismissal.deleteMany({ where: { employeeId: fx.employeeId } });
    await page.goto(`${BASE}/employee`);
    await expect(page.locator('[data-testid="portal-hero"]')).toBeVisible();
    await expect(page.locator('[data-testid="portal-home-notification"]').first()).toBeVisible();
    await noHorizontalOverflow(page);
    await page.screenshot({ path: path.join(OUT, "03-home-mobile-with-notification.png"), fullPage: true });

    // Widgets grid — collapsed to 2 columns on this viewport.
    await expect(page.locator('[data-testid="portal-home-widgets-grid"]')).toBeVisible();
    await expect(page.locator('[data-testid="portal-home-widget-scheduling"]')).toBeVisible();

    // × on the mobile bar is reachable + clickable.
    await page.locator('[data-testid="portal-home-notification-dismiss"]').first().click();
    await expect(page.locator('[data-testid="portal-home-notification"]')).toHaveCount(0);
    await noHorizontalOverflow(page);
    await page.screenshot({ path: path.join(OUT, "04-home-mobile-after-dismiss.png"), fullPage: true });

    // Mobile drawer still works (B3.1 regression) — hamburger opens the drawer.
    await page.locator('[data-testid="portal-mobile-menu-open"]').click();
    await expect(page.locator('[data-testid="portal-mobile-drawer"]')).toBeVisible();
    await noHorizontalOverflow(page);
    await page
      .locator('[data-testid="portal-mobile-drawer-backdrop"]')
      .click({ position: { x: 380, y: 400 } });
    await expect(page.locator('[data-testid="portal-mobile-drawer"]')).toHaveCount(0);
  });
});
