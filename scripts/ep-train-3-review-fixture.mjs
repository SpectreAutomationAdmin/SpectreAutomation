// EP-TRAIN-3 (2026-10-30) — Founder-review disposable demonstration
// fixture.  Provisions ONE clearly-identified demo course + ONE
// disposable demo employee (with portal credential) for the founder's
// hands-on Safety & Training review per directive §1-§2.
//
// Scope:
//   * Course: "Founder Demo – Safety & Training" (code DEMO_FR_SAFETY)
//     - short playable video (reuses the WSO v2 remuxed asset)
//     - 2 required checkpoints (atSecond 15 + 28)
//     - mix of question types: SINGLE_CHOICE + MULTI_ANSWER + TRUE_FALSE
//     - maxRetries = 2 per checkpoint
//     - final assessment with 2 questions (passing score 80)
//     - PUBLISHED and visible to all employees via appliesToAll=true
//   * Employee: "FounderDemo DemoEmployee" (E-FOUNDER-DEMO)
//     - ACTIVE, APPROVED, no payroll / CLUB_ADMIN permissions
//     - Portal credential with freshly generated 24-char password
//
// Run on staging via Fly SSH:
//   base64 -w0 scripts/ep-train-3-review-fixture.mjs | ssh console --
//
// Teardown via a dedicated single-fixture script when the review is
// complete.  No existing fixture is touched.

import { createRequire } from "node:module";
const require = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const crypto = require("node:crypto");

const CLUB_ID = "cmrvdeny7000144372ktmmg9c"; // Coulee Ridge
const EMPLOYEE_NUMBER = "E-FOUNDER-DEMO";
const EMPLOYEE_EMAIL = "ep-train-3-founder-demo@spectre.test";
const COURSE_CODE = "DEMO_FR_SAFETY";
const COURSE_TITLE = "Founder Demo – Safety & Training";

const REUSED_VIDEO_KEY = "training/cmt28yaet005g114f43ybgw9f/2/40e9c31eda3520963d7089e80751efa33d82fb398d6a4b69b305d650f4045dad";
const REUSED_VIDEO_SHA = "40e9c31eda3520963d7089e80751efa33d82fb398d6a4b69b305d650f4045dad";

function randomPassword() {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(24); let out = "";
  for (let i = 0; i < 24; i++) out += chars[bytes[i] % chars.length];
  return out;
}

const p = new PrismaClient();
async function main() {
  const existing = await p.employee.findFirst({ where: { clubId: CLUB_ID, employeeNumber: EMPLOYEE_NUMBER } });
  if (existing) {
    const course = await p.trainingCourse.findFirst({ where: { clubId: CLUB_ID, code: COURSE_CODE }, include: { versions: { select: { id: true } } } });
    console.log("REVIEW_FIXTURE_ALREADY_EXISTS " + JSON.stringify({ employeeId: existing.id, courseId: course?.id ?? null }));
    await p.$disconnect();
    return;
  }
  const password = randomPassword();
  const hash = await bcrypt.hash(password, 10);
  const result = await p.$transaction(async (tx) => {
    const emp = await tx.employee.create({ data: { clubId: CLUB_ID, employeeNumber: EMPLOYEE_NUMBER, firstName: "FounderDemo", lastName: "DemoEmployee", personalEmail: EMPLOYEE_EMAIL, status: "ACTIVE", employeeLifecycle: "ACTIVE", onboardingState: "APPROVED", payrollReadiness: "NOT_READY", hireDate: new Date(), activatedAt: new Date() } });
    await tx.employeePortalCredential.create({ data: { clubId: CLUB_ID, employeeId: emp.id, passwordHash: hash } });
    const course = await tx.trainingCourse.create({ data: { clubId: CLUB_ID, code: COURSE_CODE, title: COURSE_TITLE, category: "Safety", description: "Founder-review demonstration course for EP-TRAIN-3 Slice 3 — covers video playback, mid-video knowledge checkpoints, a mix of question types, retries, and a final knowledge assessment." } });
    const version = await tx.trainingCourseVersion.create({ data: { courseId: course.id, version: 1, state: "DRAFT", title: COURSE_TITLE, description: "Founder-review demonstration version.", passingScore: 80, retakesAllowed: true, requiresKnowledgeTest: true, required: true, appliesToAll: true, videoStorageKey: REUSED_VIDEO_KEY, videoSha256: REUSED_VIDEO_SHA, videoMimeType: "video/mp4", videoSizeBytes: 49475360, videoDurationSec: 42 } });
    const cp1 = await tx.trainingCheckpoint.create({ data: { courseVersionId: version.id, atSecond: 15, label: "Checkpoint 1 — Hazard Identification", requiredToProceed: true, maxRetries: 2, displayOrder: 0 } });
    const cp2 = await tx.trainingCheckpoint.create({ data: { courseVersionId: version.id, atSecond: 28, label: "Checkpoint 2 — Response Protocol", requiredToProceed: true, maxRetries: 2, displayOrder: 1 } });
    const q1 = await tx.trainingQuestion.create({ data: { courseVersionId: version.id, checkpointId: cp1.id, prompt: "What color are safety cones typically?", displayOrder: 0, active: true, questionType: "SINGLE_CHOICE" } });
    await tx.trainingAnswerOption.createMany({ data: [{ questionId: q1.id, text: "Orange", isCorrect: true, displayOrder: 0 }, { questionId: q1.id, text: "Green", isCorrect: false, displayOrder: 1 }, { questionId: q1.id, text: "Blue", isCorrect: false, displayOrder: 2 }] });
    const q2 = await tx.trainingQuestion.create({ data: { courseVersionId: version.id, checkpointId: cp1.id, prompt: "Which of these are personal protective equipment? (Select all that apply)", displayOrder: 1, active: true, questionType: "MULTI_ANSWER" } });
    await tx.trainingAnswerOption.createMany({ data: [{ questionId: q2.id, text: "Hard hat", isCorrect: true, displayOrder: 0 }, { questionId: q2.id, text: "Safety goggles", isCorrect: true, displayOrder: 1 }, { questionId: q2.id, text: "Business suit", isCorrect: false, displayOrder: 2 }] });
    const q3 = await tx.trainingQuestion.create({ data: { courseVersionId: version.id, checkpointId: cp1.id, prompt: "Safety procedures should be followed consistently", displayOrder: 2, active: true, questionType: "TRUE_FALSE" } });
    await tx.trainingAnswerOption.createMany({ data: [{ questionId: q3.id, text: "True", isCorrect: true, displayOrder: 0 }, { questionId: q3.id, text: "False", isCorrect: false, displayOrder: 1 }] });
    const q4 = await tx.trainingQuestion.create({ data: { courseVersionId: version.id, checkpointId: cp2.id, prompt: "Who should you report a workplace hazard to?", displayOrder: 0, active: true, questionType: "SINGLE_CHOICE" } });
    await tx.trainingAnswerOption.createMany({ data: [{ questionId: q4.id, text: "Your supervisor immediately", isCorrect: true, displayOrder: 0 }, { questionId: q4.id, text: "Nobody", isCorrect: false, displayOrder: 1 }] });
    const fq1 = await tx.trainingQuestion.create({ data: { courseVersionId: version.id, checkpointId: null, prompt: "What is the first step in workplace safety?", displayOrder: 0, active: true, questionType: "SINGLE_CHOICE" } });
    await tx.trainingAnswerOption.createMany({ data: [{ questionId: fq1.id, text: "Risk assessment", isCorrect: true, displayOrder: 0 }, { questionId: fq1.id, text: "Doing nothing", isCorrect: false, displayOrder: 1 }] });
    const fq2 = await tx.trainingQuestion.create({ data: { courseVersionId: version.id, checkpointId: null, prompt: "Workplace safety is a shared responsibility", displayOrder: 1, active: true, questionType: "TRUE_FALSE" } });
    await tx.trainingAnswerOption.createMany({ data: [{ questionId: fq2.id, text: "True", isCorrect: true, displayOrder: 0 }, { questionId: fq2.id, text: "False", isCorrect: false, displayOrder: 1 }] });
    await tx.trainingCourseVersion.update({ where: { id: version.id }, data: { state: "PUBLISHED", publishedAt: new Date() } });
    await tx.trainingCourse.update({ where: { id: course.id }, data: { currentVersionId: version.id } });
    return { employeeId: emp.id, courseId: course.id, versionId: version.id };
  });
  await p.auditLog.create({ data: { clubId: CLUB_ID, userId: "cmrvdenz700034437agp7gqs5", action: "hr.training.provision.disposable.review-fixture", entityType: "Employee", entityId: result.employeeId, afterJson: JSON.stringify({ employeeNumber: EMPLOYEE_NUMBER, personalEmail: EMPLOYEE_EMAIL, courseId: result.courseId, courseVersionId: result.versionId, courseCode: COURSE_CODE, reason: "EP-TRAIN-3 Slice 3 founder-review preparation per directive 2026-10-30 §2" }) } });
  console.log("REVIEW_FIXTURE_PROVISIONED " + JSON.stringify({ employeeId: result.employeeId, employeeNumber: EMPLOYEE_NUMBER, email: EMPLOYEE_EMAIL, password, courseId: result.courseId, courseVersionId: result.versionId, courseCode: COURSE_CODE }));
  await p.$disconnect();
}
main().catch((e) => { console.error("ERR " + (e && e.message ? e.message : String(e))); process.exit(1); });
