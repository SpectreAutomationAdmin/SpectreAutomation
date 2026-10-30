// EP-TRAIN-3 Slice 3 (2026-10-30) -- disposable employee + portal
// credential + published training course provisioning script.
//
// Founder-authorised per directive 2026-10-29 (Option 2):
//   - Scope: Coulee Ridge staging only.
//   - Identity: E-SLICE3-TEST, ACTIVE, no payroll/CLUB_ADMIN perms.
//   - Course: 2 required checkpoints at 15s and 30s, 3 cp questions
//     (SINGLE+MULTI+TRUE_FALSE), 2 final-assessment questions.
//   - Teardown via scripts/ep-train-3-slice3-teardown.mjs.
//
// Usage (via Fly SSH):
//   base64 -w0 scripts/ep-train-3-slice3-provision.mjs | ssh console --
// Writes the generated email + password to STDOUT so the operator can
// paste them into .env.playwright.local manually.  Never commits them.

import { createRequire } from "node:module";
const require = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const CLUB_ID = "cmrvdeny7000144372ktmmg9c"; // Coulee Ridge
const EMPLOYEE_NUMBER = "E-SLICE3-TEST";
const EMPLOYEE_EMAIL = "ep-train-3-slice3@spectre.test";
const COURSE_CODE = "SLICE3_TEST";
const COURSE_TITLE = "Slice 3 Interactive Playback Test";

// Reuse WSO v2's video (already uploaded + accessible via R2).
const REUSED_VIDEO_KEY = "clubs/cmrvdeny7000144372ktmmg9c/training/cmt28yaet005g114f43ybgw9f/2/30705365066ec0b93d8f977e7840492285b7f20fc77a002f3da39b86fb0788c8";
const REUSED_VIDEO_SHA = "30705365066ec0b93d8f977e7840492285b7f20fc77a002f3da39b86fb0788c8";

const p = new PrismaClient();

function randomPassword() {
  // 24 alphanumeric characters, cryptographically-random -- displayed
  // once to the operator and NEVER logged elsewhere.
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = require("crypto").randomBytes(24);
  for (let i = 0; i < 24; i++) out += chars[bytes[i] % chars.length];
  return out;
}

async function main() {
  const existing = await p.employee.findFirst({ where: { clubId: CLUB_ID, employeeNumber: EMPLOYEE_NUMBER } });
  if (existing) {
    console.log("EMPLOYEE_ALREADY_EXISTS id=" + existing.id);
    console.log("Use teardown script before re-provisioning.");
    return;
  }
  const password = randomPassword();
  const hash = await bcrypt.hash(password, 10);

  const result = await p.$transaction(async (tx) => {
    const emp = await tx.employee.create({
      data: {
        clubId: CLUB_ID,
        employeeNumber: EMPLOYEE_NUMBER,
        firstName: "Slice3",
        lastName: "Test",
        personalEmail: EMPLOYEE_EMAIL,
        status: "ACTIVE",
        employeeLifecycle: "ACTIVE",
        onboardingState: "APPROVED",
        payrollReadiness: "NOT_READY",
        hireDate: new Date(),
        activatedAt: new Date(),
      },
    });
    await tx.employeePortalCredential.create({
      data: {
        clubId: CLUB_ID,
        employeeId: emp.id,
        passwordHash: hash,
      },
    });
    const course = await tx.trainingCourse.create({
      data: {
        clubId: CLUB_ID,
        code: COURSE_CODE,
        title: COURSE_TITLE,
        category: "Safety",
        description: "Disposable test course for Slice 3 interactive-playback acceptance.",
      },
    });
    const version = await tx.trainingCourseVersion.create({
      data: {
        courseId: course.id,
        version: 1,
        state: "DRAFT",
        title: COURSE_TITLE,
        description: "Disposable test course for Slice 3 interactive-playback acceptance.",
        passingScore: 80,
        retakesAllowed: true,
        requiresKnowledgeTest: true,
        required: true,
        appliesToAll: true,
        videoStorageKey: REUSED_VIDEO_KEY,
        videoSha256: REUSED_VIDEO_SHA,
        videoMimeType: "video/mp4",
        videoSizeBytes: 1024 * 1024,
        videoDurationSec: 60,
      },
    });
    // Two REQUIRED checkpoints at 15s and 30s.
    const cp1 = await tx.trainingCheckpoint.create({
      data: {
        courseVersionId: version.id,
        atSecond: 15,
        label: "Checkpoint 1 - Hazard Identification",
        requiredToProceed: true,
        maxRetries: 2,
        displayOrder: 0,
      },
    });
    const cp2 = await tx.trainingCheckpoint.create({
      data: {
        courseVersionId: version.id,
        atSecond: 30,
        label: "Checkpoint 2 - Response Protocol",
        requiredToProceed: true,
        maxRetries: 2,
        displayOrder: 1,
      },
    });
    // Checkpoint 1: SINGLE_CHOICE
    const q1 = await tx.trainingQuestion.create({
      data: {
        courseVersionId: version.id,
        checkpointId: cp1.id,
        prompt: "What color are safety cones typically?",
        displayOrder: 0,
        active: true,
        questionType: "SINGLE_CHOICE",
      },
    });
    await tx.trainingAnswerOption.createMany({
      data: [
        { questionId: q1.id, text: "Orange", isCorrect: true, displayOrder: 0 },
        { questionId: q1.id, text: "Green", isCorrect: false, displayOrder: 1 },
        { questionId: q1.id, text: "Blue", isCorrect: false, displayOrder: 2 },
      ],
    });
    // Checkpoint 1: MULTI_ANSWER
    const q2 = await tx.trainingQuestion.create({
      data: {
        courseVersionId: version.id,
        checkpointId: cp1.id,
        prompt: "Which of these are personal protective equipment? (Select all that apply)",
        displayOrder: 1,
        active: true,
        questionType: "MULTI_ANSWER",
      },
    });
    await tx.trainingAnswerOption.createMany({
      data: [
        { questionId: q2.id, text: "Hard hat", isCorrect: true, displayOrder: 0 },
        { questionId: q2.id, text: "Safety goggles", isCorrect: true, displayOrder: 1 },
        { questionId: q2.id, text: "Business suit", isCorrect: false, displayOrder: 2 },
      ],
    });
    // Checkpoint 1: TRUE_FALSE
    const q3 = await tx.trainingQuestion.create({
      data: {
        courseVersionId: version.id,
        checkpointId: cp1.id,
        prompt: "Safety procedures should be followed consistently",
        displayOrder: 2,
        active: true,
        questionType: "TRUE_FALSE",
      },
    });
    await tx.trainingAnswerOption.createMany({
      data: [
        { questionId: q3.id, text: "True", isCorrect: true, displayOrder: 0 },
        { questionId: q3.id, text: "False", isCorrect: false, displayOrder: 1 },
      ],
    });
    // Checkpoint 2: SINGLE_CHOICE
    const q4 = await tx.trainingQuestion.create({
      data: {
        courseVersionId: version.id,
        checkpointId: cp2.id,
        prompt: "Who should you report a workplace hazard to?",
        displayOrder: 0,
        active: true,
        questionType: "SINGLE_CHOICE",
      },
    });
    await tx.trainingAnswerOption.createMany({
      data: [
        { questionId: q4.id, text: "Your supervisor immediately", isCorrect: true, displayOrder: 0 },
        { questionId: q4.id, text: "Nobody", isCorrect: false, displayOrder: 1 },
      ],
    });
    // Final assessment Q1
    const fq1 = await tx.trainingQuestion.create({
      data: {
        courseVersionId: version.id,
        checkpointId: null,
        prompt: "What is the first step in workplace safety?",
        displayOrder: 0,
        active: true,
        questionType: "SINGLE_CHOICE",
      },
    });
    await tx.trainingAnswerOption.createMany({
      data: [
        { questionId: fq1.id, text: "Risk assessment", isCorrect: true, displayOrder: 0 },
        { questionId: fq1.id, text: "Doing nothing", isCorrect: false, displayOrder: 1 },
      ],
    });
    // Final assessment Q2
    const fq2 = await tx.trainingQuestion.create({
      data: {
        courseVersionId: version.id,
        checkpointId: null,
        prompt: "Workplace safety is a shared responsibility",
        displayOrder: 1,
        active: true,
        questionType: "TRUE_FALSE",
      },
    });
    await tx.trainingAnswerOption.createMany({
      data: [
        { questionId: fq2.id, text: "True", isCorrect: true, displayOrder: 0 },
        { questionId: fq2.id, text: "False", isCorrect: false, displayOrder: 1 },
      ],
    });
    // Publish the version.
    await tx.trainingCourseVersion.update({
      where: { id: version.id },
      data: { state: "PUBLISHED", publishedAt: new Date() },
    });
    await tx.trainingCourse.update({
      where: { id: course.id },
      data: { currentVersionId: version.id },
    });
    return { employeeId: emp.id, courseId: course.id, versionId: version.id };
  });

  // Audit the provisioning (outside the main tx so the audit is
  // atomic to its own row).
  await p.auditLog.create({
    data: {
      clubId: CLUB_ID,
      userId: "cmrvdenz700034437agp7gqs5",
      action: "hr.training.provision.disposable",
      entityType: "Employee",
      entityId: result.employeeId,
      afterJson: JSON.stringify({
        employeeNumber: EMPLOYEE_NUMBER,
        personalEmail: EMPLOYEE_EMAIL,
        courseId: result.courseId,
        courseVersionId: result.versionId,
        courseCode: COURSE_CODE,
        reason: "EP-TRAIN-3 Slice 3 authenticated-browser acceptance per founder directive 2026-10-29 Option 2",
        teardownScript: "scripts/ep-train-3-slice3-teardown.mjs",
      }),
    },
  });

  console.log(
    "PROVISIONED",
    JSON.stringify({
      employeeId: result.employeeId,
      employeeNumber: EMPLOYEE_NUMBER,
      email: EMPLOYEE_EMAIL,
      password,
      courseId: result.courseId,
      courseVersionId: result.versionId,
      courseCode: COURSE_CODE,
    }),
  );
  console.log(
    "\n>>> Add to .env.playwright.local (git-ignored):\n" +
      "SPECTRE_STAGING_PORTAL_EMAIL=" + EMPLOYEE_EMAIL + "\n" +
      "SPECTRE_STAGING_PORTAL_PASSWORD=" + password + "\n",
  );
  await p.$disconnect();
}

main().catch((e) => { console.error("ERR", e); process.exit(1); });
