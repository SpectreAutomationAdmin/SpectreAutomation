// HR-2C B3.1 (2026-08-20) — Employee Portal mobile navigation walk.
//
// Fixes the pre-existing mobile-layout defect surfaced by B3: at
// 390 × 844 the fixed-width sidebar caused document-level horizontal
// overflow. The correction is a real mobile navigation pattern
// (compact top bar + hamburger + drawer). This spec proves:
//
//   * document.documentElement.scrollWidth ≤ viewport width at every
//     step of the walk (Portal Home / drawer open / Safety & Training
//     dashboard / course / quiz / result).
//   * The drawer opens on hamburger tap and closes on backdrop tap.
//   * Every EMPLOYEE_NAV entry is reachable from the drawer.
//   * The Safety & Training dashboard renders the seeded required
//     course (from B3 fixture) and the course experience works at
//     mobile width.
//
// Seed strategy mirrors the B3 spec: seed a fresh employee + portal
// credential + published required course via prisma; preseed
// TrainingProgress past the video threshold so the quiz unlocks
// without needing real video playback.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const OUT = path.resolve("test-results/hr-2c-b3-1-mobile");
fs.mkdirSync(OUT, { recursive: true });

const prisma = new PrismaClient();

const TINY_MP4 = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
]);

const VIEWPORT = { width: 390, height: 844 };
const BASE = "http://silver-springs.localtest.me:3000";

interface Fixture {
  clubId: string;
  employeeId: string;
  employeeNumber: string;
  password: string;
  courseId: string;
  versionId: string;
  correctOptionIds: string[];
}

let fx: Fixture;

async function seedFixture(): Promise<Fixture> {
  const club = await prisma.club.findFirst({ where: { slug: "silver-springs" } });
  if (!club) throw new Error("[HR-2C B3.1] Silver Springs club not seeded — run `npm run db:seed`.");

  // Purge any leftover B31_/B3_ fixture courses.
  const stale = await prisma.trainingCourse.findMany({
    where: {
      clubId: club.id,
      OR: [
        { code: { startsWith: "B31_" } },
        { code: { startsWith: "B3_" } },
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
    where: { clubId: club.id, employeeNumber: { startsWith: "B31-" } },
    select: { id: true },
  });
  for (const e of staleEmps) {
    await prisma.employeePortalCredential.deleteMany({ where: { employeeId: e.id } });
    await prisma.employee.deleteMany({ where: { id: e.id } });
  }

  const employeeNumber = `B31-${Math.floor(Math.random() * 90000 + 10000)}`;
  const password = "Mobile-Spec-Pw-1!";
  const passwordHash = await bcrypt.hash(password, 12);
  const employee = await prisma.employee.create({
    data: {
      clubId: club.id,
      employeeNumber,
      firstName: "Mobile",
      lastName: `Tester-${Date.now().toString().slice(-6)}`,
      personalEmail: `b31-${Date.now()}@spec.test`,
      status: "ACTIVE",
      employeeLifecycle: "ACTIVE",
      // Dismiss the first-login tour so it doesn't auto-open the
      // mobile drawer and race the drawer-toggle assertions.
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

  const course = await prisma.trainingCourse.create({
    data: {
      clubId: club.id,
      code: `B31_${employeeNumber}`,
      title: "Mobile Portal Safety Test",
      category: "Safety",
      description: "Short synthetic course for the mobile Playwright walk.",
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
      videoStorageKey: `clubs/${club.id}/training/${course.id}/1/b31-fixture`,
      videoMimeType: "video/mp4",
      videoSizeBytes: TINY_MP4.length,
      videoSha256: "b31fixture" + "0".repeat(64 - 10),
      videoDurationSec: 60,
    },
  });
  await prisma.trainingCourse.update({
    where: { id: course.id },
    data: { currentVersionId: version.id },
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
          { text: "In Safety & Training on your Employee Portal", isCorrect: true, displayOrder: 1 },
        ],
      },
    },
  });
  await prisma.trainingProgress.create({
    data: {
      clubId: club.id,
      employeeId: employee.id,
      courseVersionId: version.id,
      secondsWatched: 60,
      farthestSecond: 60,
      percentComplete: 100,
    },
  });

  const savedQs = await prisma.trainingQuestion.findMany({
    where: { courseVersionId: version.id },
    orderBy: { displayOrder: "asc" },
    include: { options: { orderBy: { displayOrder: "asc" } } },
  });
  const correctOptionIds = savedQs.map((q) => q.options.find((o) => o.isCorrect)!.id);

  return {
    clubId: club.id,
    employeeId: employee.id,
    employeeNumber,
    password,
    courseId: course.id,
    versionId: version.id,
    correctOptionIds,
  };
}

async function assertNoDocOverflow(page: Page, label: string) {
  const [scrollWidth, clientWidth] = await Promise.all([
    page.evaluate(() => document.documentElement.scrollWidth),
    page.evaluate(() => document.documentElement.clientWidth),
  ]);
  expect(scrollWidth, `${label}: scrollWidth ${scrollWidth} vs clientWidth ${clientWidth}`)
    .toBeLessThanOrEqual(clientWidth);
  expect(clientWidth, `${label}: viewport ${VIEWPORT.width}`).toBe(VIEWPORT.width);
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

test.describe("HR-2C B3.1 · Employee Portal mobile navigation walk", () => {
  test.describe.configure({ mode: "serial" });
  test.slow();
  test.use({ viewport: VIEWPORT });

  test.beforeAll(async () => {
    fx = await seedFixture();
  });

  test.afterAll(async () => {
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
    await prisma.$disconnect();
  });

  test("Portal Home renders at 390×844 with no horizontal overflow; sidebar hidden; mobile top bar visible", async ({ page }) => {
    await loginAsEmployee(page);
    await expect(page.locator('[data-testid="portal-home"]')).toBeVisible();
    // Sidebar is hidden on mobile.
    await expect(page.locator('[data-testid="portal-sidebar"]')).toBeHidden();
    // Mobile top bar is visible.
    await expect(page.locator('[data-testid="portal-mobile-topbar"]')).toBeVisible();
    await expect(page.locator('[data-testid="portal-mobile-menu-open"]')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "01-home-mobile.png"), fullPage: true });
    await assertNoDocOverflow(page, "Portal Home");
  });

  test("Hamburger opens drawer with all nav items; backdrop closes it", async ({ page }) => {
    await loginAsEmployee(page);
    await assertNoDocOverflow(page, "Portal Home (pre-open)");
    // Drawer not present yet.
    await expect(page.locator('[data-testid="portal-mobile-drawer"]')).toHaveCount(0);
    // Open.
    await page.locator('[data-testid="portal-mobile-menu-open"]').click();
    await expect(page.locator('[data-testid="portal-mobile-drawer"]')).toBeVisible();
    // All EMPLOYEE_NAV items are present in the drawer nav.
    const nav = page.locator('[data-testid="portal-mobile-nav"]');
    for (const label of ["Home", "Schedule", "Availability", "Pay", "Safety & Training", "Documents", "Profile"]) {
      await expect(nav).toContainText(label);
    }
    await page.screenshot({ path: path.join(OUT, "02-drawer-open.png"), fullPage: true });
    await assertNoDocOverflow(page, "Drawer open");
    // Close via backdrop tap in the area outside the drawer panel.
    // (The drawer is 288 px wide on the left; the tap lands at x=380
    //  which is clearly outside the drawer.)
    await page
      .locator('[data-testid="portal-mobile-drawer-backdrop"]')
      .click({ position: { x: 380, y: 400 } });
    await expect(page.locator('[data-testid="portal-mobile-drawer"]')).toHaveCount(0);
  });

  test("Navigate to Safety & Training via the drawer; page renders without overflow", async ({ page }) => {
    await loginAsEmployee(page);
    await page.locator('[data-testid="portal-mobile-menu-open"]').click();
    await expect(page.locator('[data-testid="portal-mobile-drawer"]')).toBeVisible();
    await Promise.all([
      page.waitForURL(/\/employee\/safety-training$/, { timeout: 15_000 }),
      page.locator('[data-testid="portal-mobile-nav-safety-training"]').click(),
    ]);
    await expect(page.locator('[data-testid="portal-safety-training"]')).toBeVisible();
    // Required course visible.
    await expect(page.locator(`[data-testid="portal-safety-training-course-${fx.courseId}"]`)).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "03-safety-training-mobile.png"), fullPage: true });
    await assertNoDocOverflow(page, "Safety & Training dashboard");
  });

  test("Full course walk on mobile: video → quiz → pass; no overflow at any step", async ({ page }) => {
    await loginAsEmployee(page);
    // Direct navigation (mimics tapping the required course card).
    await page.goto(`${BASE}/employee/safety-training/${fx.versionId}`);
    await expect(page.locator('[data-testid="portal-course-title"]')).toBeVisible();
    await assertNoDocOverflow(page, "Course page");
    await page.screenshot({ path: path.join(OUT, "04-course-mobile.png"), fullPage: true });

    // Video section + quiz-ready state (progress preseeded to 100 %).
    await expect(page.locator('[data-testid="portal-course-start-attempt"]')).toBeVisible();
    await page.locator('[data-testid="portal-course-start-attempt"]').click();
    await expect(page.locator('[data-testid="portal-course-quiz-answering"]')).toBeVisible();
    await assertNoDocOverflow(page, "Quiz answering");

    // Pick every correct answer.
    for (const optId of fx.correctOptionIds) {
      await page.locator(`[data-testid="portal-course-option-${optId}"]`).click();
    }
    // Submit and wait on the CompletedBanner (persistent — survives
    // the router.refresh that fires on pass; the quiz-passed banner
    // is transient and can vanish before Playwright sees it).
    await page.locator('[data-testid="portal-course-submit-attempt"]').click();
    await page.waitForSelector(
      '[data-testid="portal-course-completed-banner"]',
      { timeout: 15_000 },
    );
    await expect(page.locator('[data-testid="portal-course-completed-banner"]')).toContainText(
      /Training complete/i,
    );
    await page.screenshot({ path: path.join(OUT, "05-quiz-passed-mobile.png"), fullPage: true });
    await assertNoDocOverflow(page, "Quiz passed");
  });
});
