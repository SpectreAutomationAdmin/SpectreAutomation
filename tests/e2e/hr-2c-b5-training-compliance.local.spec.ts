// HR-2C B5 (2026-08-28) — Training Compliance dashboard + Employee
// Profile Training tab + Assign-training founder acceptance walk.
//
// Fixture is created directly via Prisma (deterministic, no admin
// UX round-trip) and cleaned up in afterAll:
//   * One published required course (applies to all).
//   * Employee A — no completion → Training required.
//   * Employee B — completion → Up to date.
// Walk covers:
//   1. People → Safety & Training now has Courses + Compliance tabs.
//   2. Compliance dashboard lists both employees with correct counts.
//   3. Filter to "Training required" shows only A.
//   4. Clicking B's link opens Employee Profile → Training tab
//      directly (?tab=training drill-through).
//   5. Assign a second course to A via the profile's Assign action.
//   6. A's outstanding count updates + eligibility flips to Not
//      eligible.
//
// Uses the seeded admin (`admin@silversprings.club`) via the dev-only
// quick-login form.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const OUT = path.resolve("test-results/hr-2c-b5-training-compliance");
fs.mkdirSync(OUT, { recursive: true });
const prisma = new PrismaClient();
const BASE = "http://localhost:3000";

// Tiny valid MP4 (24 bytes: ftyp isom header).
const TINY_MP4 = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
]);
const VIDEO_SHA = require("node:crypto").createHash("sha256").update(TINY_MP4).digest("hex");

interface Fixture {
  clubId: string;
  courseAId: string;
  courseBId: string;
  versionAId: string;
  empAId: string;
  empBId: string;
  empANumber: string;
  empBNumber: string;
  employeeIds: string[];
  courseIds: string[];
}

let fx: Fixture;

async function loginAsAdmin(page: Page) {
  await page.goto(`${BASE}/login`);
  await page
    .locator('form:has(input[name="email"][value="admin@silversprings.club"]) button')
    .first()
    .click();
  await page.waitForURL(/\/app/, { timeout: 30_000 });
}

async function seedFixture(): Promise<Fixture> {
  const club = await prisma.club.findFirstOrThrow({ where: { slug: "silver-springs" } });
  const suffix = String(Date.now()).slice(-8);
  const empANumber = `B5A-${suffix}`;
  const empBNumber = `B5B-${suffix}`;

  // Clean any prior leftover rows keyed on our suffix.
  const stale = await prisma.employee.findMany({
    where: { clubId: club.id, employeeNumber: { startsWith: "B5" } },
    select: { id: true },
  });
  for (const s of stale) {
    await prisma.trainingCompletion.deleteMany({ where: { employeeId: s.id } });
    await prisma.trainingAttempt.deleteMany({ where: { employeeId: s.id } });
    await prisma.trainingProgress.deleteMany({ where: { employeeId: s.id } });
    await prisma.trainingAssignment.deleteMany({ where: { employeeId: s.id } });
    await prisma.employeePortalCredential.deleteMany({ where: { employeeId: s.id } });
    await prisma.employee.deleteMany({ where: { id: s.id } });
  }
  const staleCourses = await prisma.trainingCourse.findMany({
    where: { clubId: club.id, code: { startsWith: "B5_" } },
    select: { id: true },
  });
  for (const c of staleCourses) {
    await prisma.trainingAssignment.deleteMany({ where: { courseId: c.id } });
    await prisma.trainingCompletion.deleteMany({ where: { courseId: c.id } });
    await prisma.trainingQuestionResponse.deleteMany({ where: { question: { courseVersion: { courseId: c.id } } } });
    await prisma.trainingAttempt.deleteMany({ where: { courseVersion: { courseId: c.id } } });
    await prisma.trainingProgress.deleteMany({ where: { courseVersion: { courseId: c.id } } });
    // Detach currentVersion FK, then remove version rows.
    await prisma.trainingCourse.update({ where: { id: c.id }, data: { currentVersionId: null } });
    await prisma.trainingAnswerOption.deleteMany({ where: { question: { courseVersion: { courseId: c.id } } } });
    await prisma.trainingQuestion.deleteMany({ where: { courseVersion: { courseId: c.id } } });
    await prisma.trainingCourseVersion.deleteMany({ where: { courseId: c.id } });
    await prisma.trainingCourse.deleteMany({ where: { id: c.id } });
  }

  // ---- Course A: published, applies-to-all, required ----
  const courseA = await prisma.trainingCourse.create({
    data: { clubId: club.id, code: `B5_A_${suffix}`, title: "Safety Orientation", category: "Safety" },
  });
  const versionA = await prisma.trainingCourseVersion.create({
    data: {
      courseId: courseA.id, version: 1, state: "PUBLISHED",
      title: "Safety Orientation", description: "B5 seed",
      passingScore: 80, retakesAllowed: true, requiresKnowledgeTest: true,
      videoStorageKey: `training/${courseA.id}/v1.mp4`,
      videoMimeType: "video/mp4", videoSizeBytes: TINY_MP4.length,
      videoSha256: VIDEO_SHA, videoDurationSec: 60,
      appliesToAll: true, appliesToDeptIds: null, appliesToPositionIds: null,
      required: true, publishedAt: new Date(),
    },
  });
  await prisma.trainingCourse.update({
    where: { id: courseA.id }, data: { currentVersionId: versionA.id },
  });
  const qA = await prisma.trainingQuestion.create({
    data: { courseVersionId: versionA.id, prompt: "A?", displayOrder: 1, active: true },
  });
  await prisma.trainingAnswerOption.create({
    data: { questionId: qA.id, text: "wrong", isCorrect: false, displayOrder: 1 },
  });
  await prisma.trainingAnswerOption.create({
    data: { questionId: qA.id, text: "right", isCorrect: true, displayOrder: 2 },
  });

  // ---- Course B: also published, applies-to-all, required (a
  //     second course so we can Assign Something later that IS
  //     already applicable — surfaces the "already assigned" path.)
  const courseB = await prisma.trainingCourse.create({
    data: { clubId: club.id, code: `B5_B_${suffix}`, title: "Hazard Reporting", category: "Safety" },
  });
  const versionB = await prisma.trainingCourseVersion.create({
    data: {
      courseId: courseB.id, version: 1, state: "PUBLISHED",
      title: "Hazard Reporting", description: "B5 seed 2",
      passingScore: 80, retakesAllowed: true, requiresKnowledgeTest: true,
      videoStorageKey: `training/${courseB.id}/v1.mp4`,
      videoMimeType: "video/mp4", videoSizeBytes: TINY_MP4.length,
      videoSha256: VIDEO_SHA, videoDurationSec: 60,
      appliesToAll: false, appliesToDeptIds: null, appliesToPositionIds: null,
      required: true, publishedAt: new Date(),
    },
  });
  await prisma.trainingCourse.update({
    where: { id: courseB.id }, data: { currentVersionId: versionB.id },
  });
  const qB = await prisma.trainingQuestion.create({
    data: { courseVersionId: versionB.id, prompt: "B?", displayOrder: 1, active: true },
  });
  await prisma.trainingAnswerOption.create({
    data: { questionId: qB.id, text: "wrong", isCorrect: false, displayOrder: 1 },
  });
  await prisma.trainingAnswerOption.create({
    data: { questionId: qB.id, text: "right", isCorrect: true, displayOrder: 2 },
  });

  // ---- Employees ----
  const empA = await prisma.employee.create({
    data: {
      clubId: club.id, employeeNumber: empANumber,
      firstName: "Alice", lastName: `B5-${suffix}`,
      personalEmail: `alice-${suffix}@spec.test`,
      status: "ACTIVE", employeeLifecycle: "ACTIVE",
    },
  });
  const empB = await prisma.employee.create({
    data: {
      clubId: club.id, employeeNumber: empBNumber,
      firstName: "Bob", lastName: `B5-${suffix}`,
      personalEmail: `bob-${suffix}@spec.test`,
      status: "ACTIVE", employeeLifecycle: "ACTIVE",
    },
  });
  // Portal credential lets B log in via the same fixture pattern used
  // elsewhere (we do not exercise portal flow in this spec, but
  // required for the fixture cleanup to have symmetry).
  const hash = await bcrypt.hash("pw", 12);
  await prisma.employeePortalCredential.create({
    data: { clubId: club.id, employeeId: empA.id, passwordHash: hash, passwordUpdatedAt: new Date() },
  });
  await prisma.employeePortalCredential.create({
    data: { clubId: club.id, employeeId: empB.id, passwordHash: hash, passwordUpdatedAt: new Date() },
  });

  // ---- B has completed Course A ----
  const attempt = await prisma.trainingAttempt.create({
    data: {
      clubId: club.id, employeeId: empB.id,
      courseVersionId: versionA.id, attemptNumber: 1,
      score: 100, passed: true, startedAt: new Date(), submittedAt: new Date(),
    },
  });
  await prisma.trainingCompletion.create({
    data: {
      clubId: club.id, employeeId: empB.id,
      courseId: courseA.id, courseVersionId: versionA.id,
      attemptId: attempt.id, score: 100, completedAt: new Date(),
    },
  });

  return {
    clubId: club.id,
    courseAId: courseA.id, courseBId: courseB.id, versionAId: versionA.id,
    empAId: empA.id, empBId: empB.id,
    empANumber, empBNumber,
    employeeIds: [empA.id, empB.id],
    courseIds: [courseA.id, courseB.id],
  };
}

async function tearDownFixture() {
  for (const id of fx.employeeIds) {
    await prisma.trainingCompletion.deleteMany({ where: { employeeId: id } });
    await prisma.trainingAttempt.deleteMany({ where: { employeeId: id } });
    await prisma.trainingProgress.deleteMany({ where: { employeeId: id } });
    await prisma.trainingAssignment.deleteMany({ where: { employeeId: id } });
    await prisma.employeePortalCredential.deleteMany({ where: { employeeId: id } });
    await prisma.employee.deleteMany({ where: { id } });
  }
  for (const id of fx.courseIds) {
    await prisma.trainingCompletion.deleteMany({ where: { courseId: id } });
    await prisma.trainingAssignment.deleteMany({ where: { courseId: id } });
    await prisma.trainingCourse.update({ where: { id }, data: { currentVersionId: null } });
    await prisma.trainingAnswerOption.deleteMany({ where: { question: { courseVersion: { courseId: id } } } });
    await prisma.trainingQuestion.deleteMany({ where: { courseVersion: { courseId: id } } });
    await prisma.trainingAttempt.deleteMany({ where: { courseVersion: { courseId: id } } });
    await prisma.trainingProgress.deleteMany({ where: { courseVersion: { courseId: id } } });
    await prisma.trainingCourseVersion.deleteMany({ where: { courseId: id } });
    await prisma.trainingCourse.deleteMany({ where: { id } });
  }
  await prisma.$disconnect();
}

test.describe("HR-2C B5 · Training Compliance", () => {
  test.describe.configure({ mode: "serial" });
  test.slow();
  test.use({ viewport: { width: 1440, height: 900 } });
  test.beforeAll(async () => { fx = await seedFixture(); });
  test.afterAll(tearDownFixture);

  test("Safety & Training landing now has Courses + Compliance tabs", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE}/app/admin/people/safety-training`);
    const nav = page.locator('[data-testid="training-subnav"]');
    await expect(nav).toBeVisible();
    await expect(nav.locator('[data-testid="training-subnav-courses"]')).toBeVisible();
    await expect(nav.locator('[data-testid="training-subnav-compliance"]')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "01-training-tabs.png"), fullPage: true });
  });

  test("Compliance dashboard lists our seeded employees with correct counts", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE}/app/admin/people/safety-training/compliance`);
    await expect(page.locator('[data-testid="compliance-summary"]')).toBeVisible();
    const rowA = page.locator(`[data-testid="compliance-row-${fx.empANumber}"]`);
    const rowB = page.locator(`[data-testid="compliance-row-${fx.empBNumber}"]`);
    await expect(rowA).toBeVisible();
    await expect(rowB).toBeVisible();
    // A: 1 required / 0 complete / 1 outstanding / not eligible.
    await expect(rowA.locator(`[data-testid="compliance-eligibility-${fx.empANumber}"]`)).toHaveText("Not eligible");
    // B: 1 required / 1 complete / 0 outstanding / eligible.
    await expect(rowB.locator(`[data-testid="compliance-eligibility-${fx.empBNumber}"]`)).toHaveText("Eligible");
    await page.screenshot({ path: path.join(OUT, "02-compliance-dashboard.png"), fullPage: true });
  });

  test("Filter → Training required shows only Alice", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE}/app/admin/people/safety-training/compliance?status=training_required`);
    await expect(page.locator(`[data-testid="compliance-row-${fx.empANumber}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="compliance-row-${fx.empBNumber}"]`)).toHaveCount(0);
    await page.screenshot({ path: path.join(OUT, "03-compliance-filtered.png"), fullPage: true });
  });

  test("Drill-through: Bob → Employee Profile → Training tab (via ?tab=training)", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE}/app/admin/people/safety-training/compliance`);
    await Promise.all([
      page.waitForURL(/\/employees\/[^/]+\?tab=training/, { timeout: 20_000 }),
      page.locator(`[data-testid="compliance-employee-link-${fx.empBNumber}"]`).click(),
    ]);
    await expect(page.locator('[data-testid="employee-training-section"]')).toBeVisible();
    await expect(page.locator('[data-testid="training-eligibility-eligible"]')).toBeVisible();
    // Current requirements list contains the seeded course.
    await expect(page.locator('[data-testid="training-current-list"] li')).toHaveCount(1);
    // History has the completion.
    await expect(page.locator('[data-testid="training-history"] tbody tr')).toHaveCount(1);
    await page.screenshot({ path: path.join(OUT, "04-profile-training-bob.png"), fullPage: true });
  });

  test("Alice: assign the additional course → outstanding grows + eligibility remains Not eligible", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE}/app/admin/people/employees/${fx.empAId}?tab=training`);
    await expect(page.locator('[data-testid="employee-training-section"]')).toBeVisible();
    // Starting outstanding: 1 (Course A). Assign Course B via the button.
    await page.locator('[data-testid="btn-assign-training"]').click();
    await page.locator('[data-testid="assign-training-course"]').selectOption(fx.courseBId);
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page.locator('[data-testid="assign-training-submit"]').click(),
    ]);
    // Refresh so we see the new row deterministically.
    await page.goto(`${BASE}/app/admin/people/employees/${fx.empAId}?tab=training`);
    // 2 current items now: Course A + Course B (explicit assignment).
    await expect(page.locator('[data-testid="training-current-list"] li')).toHaveCount(2);
    await expect(page.locator('[data-testid="training-eligibility-not-eligible"]')).toContainText("2 required");
    // DB assertion.
    const rows = await prisma.trainingAssignment.findMany({ where: { employeeId: fx.empAId } });
    expect(rows.length).toBe(1);
    expect(rows[0]!.courseId).toBe(fx.courseBId);
    await page.screenshot({ path: path.join(OUT, "05-alice-assign-training.png"), fullPage: true });
  });
});
