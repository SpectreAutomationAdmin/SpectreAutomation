// EP-TRAIN-3 Slice 3D (2026-10-30) -- per-test fixture isolation.
//
// Replaces the prior shared `E-SLICE3-TEST` + `SLICE3_TEST` fixture that
// produced intermittent cross-test contamination via a shared
// `resetState()` SSH call.
//
// Design (per founder directive §1-§3):
//   - Each test generates a short unique `runId`.
//   - provisionIsolatedFixture(runId) creates:
//       employee E-SLICE3-{RUN_ID}
//       portal credential ep-train-3-slice3-{RUN_ID}@spectre.test / <random>
//       course SLICE3_{RUN_ID} + version + checkpoints + questions
//       (published, ready for the authenticated employee)
//   - teardownIsolatedFixture(runId) deletes ONLY the records tied to
//     that runId.  Legitimate employees, courses, completions, payroll
//     records, and audit history are never touched.
//   - Both scripts run on Fly via a 180s SSH exec and emit a single
//     JSON line to stdout.  No HTTP management endpoints are added.
//   - Idempotent per runId: a repeated provision for the same runId
//     surfaces the existing fixture; a repeated teardown is a no-op.
//
// Fixture ownership check: every delete is scoped to the specific
// employeeNumber + courseCode produced from the runId.  A simple
// substring prefix (`E-SLICE3-` / `SLICE3_`) further protects against
// an accidental broad query.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

const FLYCTL = process.env.FLYCTL_PATH ?? "C:/Users/cturcato/.fly/bin/flyctl.exe";
const FLY_APP = "spectre-staging";
const CLUB_ID = "cmrvdeny7000144372ktmmg9c"; // Coulee Ridge
const REUSED_VIDEO_KEY = "training/cmt28yaet005g114f43ybgw9f/2/40e9c31eda3520963d7089e80751efa33d82fb398d6a4b69b305d650f4045dad";
const REUSED_VIDEO_SHA = "40e9c31eda3520963d7089e80751efa33d82fb398d6a4b69b305d650f4045dad";

export type IsolatedFixture = {
  runId: string;
  employeeId: string;
  employeeNumber: string;
  email: string;
  password: string;
  courseId: string;
  courseVersionId: string;
  courseCode: string;
  courseTitle: string;
};

export function newRunId(prefix = "r"): string {
  const salt = crypto.randomBytes(4).toString("hex");
  return `${prefix}${Date.now().toString(36)}${salt}`.slice(0, 20);
}

function runSshScript(script: string, env: Record<string, string>): string {
  // execFileSync spawns flyctl directly without going through cmd.exe,
  // so the long -C argument is not subject to the 8191-char Windows
  // cmd line limit.  Each per-run temp file name keeps parallel calls
  // non-overlapping (we never run parallel in practice but the cost
  // is zero).
  const b64 = Buffer.from(script).toString("base64");
  const tmp = `/tmp/ep3f-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}.mjs`;
  const envExports = Object.entries(env)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
  const remoteCmd = `/bin/sh -c "echo ${b64} | base64 -d > ${tmp} && cd /app && ${envExports} node ${tmp}; rc=$?; rm -f ${tmp}; exit $rc"`;
  return execFileSync(
    FLYCTL,
    ["ssh", "console", "--app", FLY_APP, "-C", remoteCmd],
    { encoding: "utf8", timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
  );
}

const PROVISION_SCRIPT = `
import { createRequire } from "node:module";
const require = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const crypto = require("node:crypto");

const CLUB_ID = ${JSON.stringify(CLUB_ID)};
const RUN_ID = process.env.RUN_ID;
if (!RUN_ID || !/^[a-z0-9]{4,20}$/.test(RUN_ID)) { console.error("BAD_RUN_ID"); process.exit(2); }
const EMPLOYEE_NUMBER = "E-SLICE3-" + RUN_ID;
const EMPLOYEE_EMAIL = "ep-train-3-slice3-" + RUN_ID + "@spectre.test";
const COURSE_CODE = "SLICE3_" + RUN_ID;
const COURSE_TITLE = "Slice 3 Interactive Playback Test (" + RUN_ID + ")";

const p = new PrismaClient();
function randomPassword() {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(24); let out = "";
  for (let i = 0; i < 24; i++) out += chars[bytes[i] % chars.length];
  return out;
}
async function main() {
  const existing = await p.employee.findFirst({ where: { clubId: CLUB_ID, employeeNumber: EMPLOYEE_NUMBER } });
  if (existing) {
    const existCourse = await p.trainingCourse.findFirst({ where: { clubId: CLUB_ID, code: COURSE_CODE }, include: { versions: { select: { id: true, state: true } } } });
    const existCred = await p.employeePortalCredential.findFirst({ where: { employeeId: existing.id } });
    console.log("PROVISIONED_EXISTING " + JSON.stringify({ runId: RUN_ID, employeeId: existing.id, employeeNumber: EMPLOYEE_NUMBER, email: EMPLOYEE_EMAIL, courseId: existCourse?.id ?? null, courseVersionId: existCourse?.versions?.[0]?.id ?? null, courseCode: COURSE_CODE, courseTitle: COURSE_TITLE, hasCred: !!existCred }));
    await p.$disconnect(); return;
  }
  const password = randomPassword();
  const hash = await bcrypt.hash(password, 10);
  const result = await p.$transaction(async (tx) => {
    const emp = await tx.employee.create({ data: { clubId: CLUB_ID, employeeNumber: EMPLOYEE_NUMBER, firstName: "Slice3", lastName: RUN_ID.slice(-6), personalEmail: EMPLOYEE_EMAIL, status: "ACTIVE", employeeLifecycle: "ACTIVE", onboardingState: "APPROVED", payrollReadiness: "NOT_READY", hireDate: new Date(), activatedAt: new Date() } });
    await tx.employeePortalCredential.create({ data: { clubId: CLUB_ID, employeeId: emp.id, passwordHash: hash } });
    const course = await tx.trainingCourse.create({ data: { clubId: CLUB_ID, code: COURSE_CODE, title: COURSE_TITLE, category: "Safety", description: "Disposable fixture for EP-TRAIN-3 Slice 3 isolated-journey test." } });
    const version = await tx.trainingCourseVersion.create({ data: { courseId: course.id, version: 1, state: "DRAFT", title: COURSE_TITLE, description: "Disposable fixture.", passingScore: 80, retakesAllowed: true, requiresKnowledgeTest: true, required: true, appliesToAll: true, videoStorageKey: ${JSON.stringify(REUSED_VIDEO_KEY)}, videoSha256: ${JSON.stringify(REUSED_VIDEO_SHA)}, videoMimeType: "video/mp4", videoSizeBytes: 49475360, videoDurationSec: 42 } });
    const cp1 = await tx.trainingCheckpoint.create({ data: { courseVersionId: version.id, atSecond: 15, label: "Checkpoint 1 - Hazard Identification", requiredToProceed: true, maxRetries: 2, displayOrder: 0 } });
    const cp2 = await tx.trainingCheckpoint.create({ data: { courseVersionId: version.id, atSecond: 28, label: "Checkpoint 2 - Response Protocol", requiredToProceed: true, maxRetries: 2, displayOrder: 1 } });
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
  await p.auditLog.create({ data: { clubId: CLUB_ID, userId: "cmrvdenz700034437agp7gqs5", action: "hr.training.provision.disposable.isolated", entityType: "Employee", entityId: result.employeeId, afterJson: JSON.stringify({ runId: RUN_ID, employeeNumber: EMPLOYEE_NUMBER, personalEmail: EMPLOYEE_EMAIL, courseId: result.courseId, courseVersionId: result.versionId, courseCode: COURSE_CODE, reason: "EP-TRAIN-3 Slice 3 isolated-fixture per founder directive 2026-10-30 §1" }) } });
  console.log("PROVISIONED " + JSON.stringify({ runId: RUN_ID, employeeId: result.employeeId, employeeNumber: EMPLOYEE_NUMBER, email: EMPLOYEE_EMAIL, password, courseId: result.courseId, courseVersionId: result.versionId, courseCode: COURSE_CODE, courseTitle: COURSE_TITLE }));
  await p.$disconnect();
}
main().catch((e) => { console.error("ERR " + (e && e.message ? e.message : String(e))); process.exit(1); });
`;

const TEARDOWN_SCRIPT = `
import { createRequire } from "node:module";
const require = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = require("@prisma/client");

const CLUB_ID = ${JSON.stringify(CLUB_ID)};
const RUN_ID = process.env.RUN_ID;
if (!RUN_ID || !/^[a-z0-9]{4,20}$/.test(RUN_ID)) { console.error("BAD_RUN_ID"); process.exit(2); }
const EMPLOYEE_NUMBER = "E-SLICE3-" + RUN_ID;
const COURSE_CODE = "SLICE3_" + RUN_ID;

// Belt-and-suspenders ownership check: never delete employees or
// courses whose identifier doesn't match the "E-SLICE3-" / "SLICE3_"
// prefix for a RUN_ID of the exact expected shape.
if (!EMPLOYEE_NUMBER.startsWith("E-SLICE3-") || !COURSE_CODE.startsWith("SLICE3_")) {
  console.error("REFUSE_UNSCOPED"); process.exit(3);
}

const p = new PrismaClient();
async function main() {
  const emp = await p.employee.findFirst({ where: { clubId: CLUB_ID, employeeNumber: EMPLOYEE_NUMBER } });
  const course = await p.trainingCourse.findFirst({ where: { clubId: CLUB_ID, code: COURSE_CODE }, include: { versions: { select: { id: true } } } });
  const summary = { runId: RUN_ID, employeeDeleted: false, courseDeleted: false, versionIds: [], attempts: 0, progress: 0, completions: 0, responses: 0 };
  if (course) {
    for (const v of course.versions) {
      summary.versionIds.push(v.id);
      // FK ordering: TrainingCompletion.attemptId has ON DELETE RESTRICT,
      // so TrainingCompletion must be deleted BEFORE TrainingAttempt.
      const cp = await p.trainingCompletion.deleteMany({ where: { courseVersionId: v.id } });
      summary.completions += cp.count;
      const r = await p.trainingQuestionResponse.deleteMany({ where: { attempt: { courseVersionId: v.id } } });
      summary.responses += r.count;
      const a = await p.trainingAttempt.deleteMany({ where: { courseVersionId: v.id } });
      summary.attempts += a.count;
      const pr = await p.trainingProgress.deleteMany({ where: { courseVersionId: v.id } });
      summary.progress += pr.count;
      await p.trainingQuestion.deleteMany({ where: { courseVersionId: v.id } });
      await p.trainingCheckpoint.deleteMany({ where: { courseVersionId: v.id } });
    }
    await p.trainingCourse.update({ where: { id: course.id }, data: { currentVersionId: null } });
    await p.trainingCourseVersion.deleteMany({ where: { courseId: course.id } });
    await p.trainingCourse.delete({ where: { id: course.id } });
    summary.courseDeleted = true;
  }
  if (emp) {
    await p.employeePortalCredential.deleteMany({ where: { employeeId: emp.id } });
    await p.trainingAssignment.deleteMany({ where: { employeeId: emp.id } });
    // Same FK ordering: TrainingCompletion → TrainingAttempt → TrainingProgress.
    await p.trainingCompletion.deleteMany({ where: { employeeId: emp.id } });
    await p.trainingAttempt.deleteMany({ where: { employeeId: emp.id } });
    await p.trainingProgress.deleteMany({ where: { employeeId: emp.id } });
    await p.employee.delete({ where: { id: emp.id } });
    summary.employeeDeleted = true;
  }
  await p.auditLog.create({ data: { clubId: CLUB_ID, userId: "cmrvdenz700034437agp7gqs5", action: "hr.training.teardown.disposable.isolated", entityType: "Employee", entityId: emp?.id ?? "unknown", beforeJson: JSON.stringify({ employeeNumber: EMPLOYEE_NUMBER, courseCode: COURSE_CODE, summary, reason: "EP-TRAIN-3 Slice 3 isolated-fixture teardown per founder directive 2026-10-30 §3" }) } });
  console.log("TEARDOWN " + JSON.stringify({ ok: true, summary }));
  await p.$disconnect();
}
main().catch((e) => { console.error("ERR " + (e && e.message ? e.message : String(e))); process.exit(1); });
`;

export function provisionIsolatedFixture(runId: string): IsolatedFixture {
  if (!/^[a-z0-9]{4,20}$/.test(runId)) throw new Error(`invalid runId: ${runId}`);
  const stdout = runSshScript(PROVISION_SCRIPT, { RUN_ID: runId });
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.startsWith("PROVISIONED ") || l.startsWith("PROVISIONED_EXISTING "));
  if (!line) throw new Error(`provision failed: stdout had no PROVISIONED line.\n${stdout.slice(-800)}`);
  const payload = JSON.parse(line.slice(line.indexOf("{")));
  if (!payload.password && line.startsWith("PROVISIONED_EXISTING")) {
    throw new Error(`fixture ${runId} already exists but credentials cannot be re-read. Tear down first.`);
  }
  return payload as IsolatedFixture;
}

export function teardownIsolatedFixture(runId: string): {
  ok: boolean;
  summary: { employeeDeleted: boolean; courseDeleted: boolean; attempts: number; progress: number; completions: number; responses: number };
} {
  if (!/^[a-z0-9]{4,20}$/.test(runId)) throw new Error(`invalid runId: ${runId}`);
  const stdout = runSshScript(TEARDOWN_SCRIPT, { RUN_ID: runId });
  const line = stdout.split(/\r?\n/).reverse().find((l) => l.startsWith("TEARDOWN "));
  if (!line) throw new Error(`teardown failed: stdout had no TEARDOWN line.\n${stdout.slice(-800)}`);
  return JSON.parse(line.slice(line.indexOf("{")));
}
