// EP-TRAIN-5C-3A (2026-11-02) — per-scenario obligation + completion
// seeding helpers for the authenticated-employee acceptance spec.
//
// Builds on the EP-TRAIN-3 Slice 3 isolated-fixture harness
// (tests/e2e/_lib/ep-train-3-fixture.ts) which already provides a
// disposable employee with a working EmployeePortalCredential +
// random password + a published course + checkpoints + questions.
//
// This module ONLY injects additional per-scenario data onto that
// fixture (historical completion, MANUAL_REINSTATE / REVISION
// obligation, optional v2 publication).  Every write is scoped to
// the fixture's `employeeId` + `courseId` so legitimate records are
// never touched.  Teardown is handled by `teardownIsolatedFixture`
// (the EP-TRAIN-3 harness) which cascades through completions +
// attempts + progress + obligations (added via EP-TRAIN-5A-1 the
// delete order was expanded in tests/util/db.ts; the staging
// teardown script in ep-train-3-fixture.ts was also updated to
// delete obligations alongside the other training rows).
//
// Each helper is small + self-contained; a scenario calls just the
// helpers it needs.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import type { IsolatedFixture } from "./ep-train-3-fixture";

const FLYCTL = process.env.FLYCTL_PATH ?? "C:/Users/cturcato/.fly/bin/flyctl.exe";
const FLY_APP = "spectre-staging";

function runSshScript(script: string, env: Record<string, string> = {}): string {
  const b64 = Buffer.from(script).toString("base64");
  const tmp = `/tmp/ep5c3a-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}.mjs`;
  const envExports = Object.entries(env)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
  const remoteCmd = `/bin/sh -c "echo ${b64} | base64 -d > ${tmp} && cd /app && ${envExports} node ${tmp}; rc=$?; rm -f ${tmp}; exit $rc"`;
  return execFileSync(
    FLYCTL,
    ["ssh", "console", "--app", FLY_APP, "-C", remoteCmd],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  );
}

/** Seed a passing historical completion against the current PUBLISHED
 *  version of the fixture course.  Returns the attempt + completion id. */
export function seedHistoricalCompletion(
  fixture: IsolatedFixture,
  opts: { score?: number; daysAgo?: number } = {},
): { attemptId: string; completionId: string; completedAt: string } {
  const score = opts.score ?? 100;
  const daysAgo = opts.daysAgo ?? 14;
  const script = `
import { createRequire } from "node:module";
const require = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
const empId = ${JSON.stringify(fixture.employeeId)};
const vId = ${JSON.stringify(fixture.courseVersionId)};
const courseId = ${JSON.stringify(fixture.courseId)};
const clubId = (await p.employee.findUnique({ where: { id: empId }, select: { clubId: true } })).clubId;
const completedAt = new Date(Date.now() - ${daysAgo} * 86400_000);
const maxAttempt = await p.trainingAttempt.aggregate({
  where: { employeeId: empId, courseVersionId: vId },
  _max: { attemptNumber: true },
});
const attemptNumber = (maxAttempt._max.attemptNumber ?? 0) + 1;
const attempt = await p.trainingAttempt.create({
  data: {
    clubId, employeeId: empId, courseVersionId: vId,
    attemptNumber, submittedAt: completedAt,
    score: ${score}, passed: true,
    kind: "FINAL",
  },
});
const completion = await p.trainingCompletion.create({
  data: {
    clubId, employeeId: empId, courseId, courseVersionId: vId,
    attemptId: attempt.id, score: ${score}, completedAt,
  },
});
console.log("SEEDED_COMPLETION " + JSON.stringify({
  attemptId: attempt.id, completionId: completion.id,
  completedAt: completedAt.toISOString(),
}));
await p.$disconnect();
process.exit(0);
`;
  const stdout = runSshScript(script);
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith("SEEDED_COMPLETION "));
  if (!line) throw new Error(`seedHistoricalCompletion failed: ${stdout.slice(-400)}`);
  return JSON.parse(line.slice(line.indexOf("{")));
}

/** Seed an OUTSTANDING TrainingObligation on the fixture's current
 *  PUBLISHED course version.  `reason` drives the UI label. */
export function seedObligation(
  fixture: IsolatedFixture,
  opts: {
    reason: "INITIAL" | "REVISION" | "MANUAL_REINSTATE";
    reasonNote?: string;
    dueAt?: Date | null;
    issuanceKeySuffix?: string;
  },
): { obligationId: string } {
  const reasonNote = (opts.reasonNote ?? "").replace(/"/g, '\\"');
  const dueAtIso = opts.dueAt ? opts.dueAt.toISOString() : null;
  const script = `
import { createRequire } from "node:module";
const require = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
const empId = ${JSON.stringify(fixture.employeeId)};
const vId = ${JSON.stringify(fixture.courseVersionId)};
const courseId = ${JSON.stringify(fixture.courseId)};
const clubId = (await p.employee.findUnique({ where: { id: empId }, select: { clubId: true } })).clubId;
const obligation = await p.trainingObligation.create({
  data: {
    clubId, employeeId: empId, courseId, courseVersionId: vId,
    reason: ${JSON.stringify(opts.reason)},
    reasonNote: ${JSON.stringify(opts.reasonNote ?? null)},
    issuedByUserId: null,
    issuedAt: new Date(),
    dueAt: ${dueAtIso ? `new Date("${dueAtIso}")` : "null"},
    status: "OUTSTANDING",
    issuanceKey: "test-5c3a:" + ${JSON.stringify(opts.reason)} + ":" + ${JSON.stringify(opts.issuanceKeySuffix ?? "")} + ":" + Math.random().toString(36).slice(2, 10),
  },
});
console.log("SEEDED_OBLIGATION " + JSON.stringify({ obligationId: obligation.id }));
await p.$disconnect();
process.exit(0);
`;
  const stdout = runSshScript(script);
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith("SEEDED_OBLIGATION "));
  if (!line) throw new Error(`seedObligation failed: ${stdout.slice(-400)}`);
  return JSON.parse(line.slice(line.indexOf("{")));
}

/** Snapshot the fixture's current obligation + completion row counts
 *  for before/after assertions. */
export function snapshotFixtureCounts(
  fixture: IsolatedFixture,
): {
  completions: number;
  attempts: number;
  progress: number;
  outstandingObligations: number;
  satisfiedObligations: number;
} {
  const script = `
import { createRequire } from "node:module";
const require = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
const empId = ${JSON.stringify(fixture.employeeId)};
const vId = ${JSON.stringify(fixture.courseVersionId)};
const [completions, attempts, progress, outstandingOb, satisfiedOb] = await Promise.all([
  p.trainingCompletion.count({ where: { employeeId: empId, courseVersionId: vId } }),
  p.trainingAttempt.count({ where: { employeeId: empId, courseVersionId: vId } }),
  p.trainingProgress.count({ where: { employeeId: empId, courseVersionId: vId } }),
  p.trainingObligation.count({ where: { employeeId: empId, courseVersionId: vId, status: "OUTSTANDING" } }),
  p.trainingObligation.count({ where: { employeeId: empId, courseVersionId: vId, status: "SATISFIED" } }),
]);
console.log("SNAPSHOT " + JSON.stringify({ completions, attempts, progress, outstandingObligations: outstandingOb, satisfiedObligations: satisfiedOb }));
await p.$disconnect();
process.exit(0);
`;
  const stdout = runSshScript(script);
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith("SNAPSHOT "));
  if (!line) throw new Error(`snapshotFixtureCounts failed: ${stdout.slice(-400)}`);
  return JSON.parse(line.slice(line.indexOf("{")));
}

/** Snapshot the founder's training-row counts for preservation audit. */
export function snapshotFounderCounts(): {
  completions: number;
  attempts: number;
  progress: number;
} {
  const script = `
import { createRequire } from "node:module";
const require = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
const employees = await p.employee.findMany({
  where: { club: { name: { contains: "Coulee", mode: "insensitive" } } },
  select: { id: true, firstName: true, lastName: true },
});
const chris = employees.find((e) => /turcato/i.test(e.lastName ?? ""));
if (!chris) { console.log("SNAPSHOT_FOUNDER " + JSON.stringify({ completions: 0, attempts: 0, progress: 0, note: "no Chris" })); await p.$disconnect(); process.exit(0); }
const [c, a, pr] = await Promise.all([
  p.trainingCompletion.count({ where: { employeeId: chris.id } }),
  p.trainingAttempt.count({ where: { employeeId: chris.id } }),
  p.trainingProgress.count({ where: { employeeId: chris.id } }),
]);
console.log("SNAPSHOT_FOUNDER " + JSON.stringify({ completions: c, attempts: a, progress: pr }));
await p.$disconnect();
process.exit(0);
`;
  const stdout = runSshScript(script);
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith("SNAPSHOT_FOUNDER "));
  if (!line) throw new Error(`snapshotFounderCounts failed: ${stdout.slice(-400)}`);
  return JSON.parse(line.slice(line.indexOf("{")));
}

/** EP-TRAIN-5C-3C — seed a DRAFT Version 2 of the fixture course by
 *  cloning v1's content (video, checkpoints, questions, options).
 *  Does NOT publish — the test subsequently drives the real admin UI's
 *  "Publish this version" dialog so publishDraftWithPolicy runs for
 *  real (REVISION obligations issued, auto-supersession applied,
 *  audit written, currentVersionId flipped — all through the real
 *  server action).
 *
 *  Returns the new v2 id so the test can navigate to it. */
export function seedDraftV2WithCheckpoints(fixture: IsolatedFixture): { v2Id: string; v2VersionNumber: number } {
  const script = `
import { createRequire } from "node:module";
const req = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = req("@prisma/client");
const p = new PrismaClient();
const courseId = ${JSON.stringify(fixture.courseId)};
const v1Id = ${JSON.stringify(fixture.courseVersionId)};
const v1 = await p.trainingCourseVersion.findUnique({
  where: { id: v1Id },
  include: { questions: { include: { options: true } }, checkpoints: true },
});
const nextVersion = (await p.trainingCourseVersion.aggregate({ where: { courseId }, _max: { version: true } }))._max.version + 1;
const v2 = await p.trainingCourseVersion.create({
  data: {
    courseId, version: nextVersion, state: "DRAFT",
    title: v1.title + " (v" + nextVersion + ")",
    description: v1.description,
    passingScore: v1.passingScore, retakesAllowed: v1.retakesAllowed,
    requiresKnowledgeTest: v1.requiresKnowledgeTest, required: v1.required,
    appliesToAll: v1.appliesToAll,
    appliesToDeptIds: v1.appliesToDeptIds, appliesToPositionIds: v1.appliesToPositionIds,
    videoStorageKey: v1.videoStorageKey, videoSha256: v1.videoSha256,
    videoMimeType: v1.videoMimeType, videoSizeBytes: v1.videoSizeBytes,
    videoDurationSec: v1.videoDurationSec,
  },
});
const cpIdMap = new Map();
for (const cp of v1.checkpoints) {
  const newCp = await p.trainingCheckpoint.create({
    data: {
      courseVersionId: v2.id, atSecond: cp.atSecond, label: cp.label,
      requiredToProceed: cp.requiredToProceed, maxRetries: cp.maxRetries,
      displayOrder: cp.displayOrder,
    },
  });
  cpIdMap.set(cp.id, newCp.id);
}
for (const q of v1.questions) {
  const newQ = await p.trainingQuestion.create({
    data: {
      courseVersionId: v2.id,
      checkpointId: q.checkpointId ? cpIdMap.get(q.checkpointId) ?? null : null,
      prompt: q.prompt, displayOrder: q.displayOrder,
      active: q.active, questionType: q.questionType,
    },
  });
  for (const o of q.options) {
    await p.trainingAnswerOption.create({
      data: { questionId: newQ.id, text: o.text, isCorrect: o.isCorrect, displayOrder: o.displayOrder },
    });
  }
}
console.log("SEEDED_DRAFT_V2 " + JSON.stringify({ v2Id: v2.id, v2VersionNumber: nextVersion }));
await p.$disconnect();
process.exit(0);
`;
  const stdout = runSshScript(script);
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith("SEEDED_DRAFT_V2 "));
  if (!line) throw new Error(`seedDraftV2WithCheckpoints failed: ${stdout.slice(-500)}`);
  return JSON.parse(line.slice(line.indexOf("{")));
}

/** Snapshot every TrainingObligation row for the fixture employee —
 *  returns per-row {reason, status, courseVersionId} so the test can
 *  assert supersession transitions + per-version routing. */
export function snapshotObligationsForEmployee(
  fixture: IsolatedFixture,
): Array<{ id: string; reason: string; status: string; courseVersionId: string; issuedAt: string; satisfiedByCompletionId: string | null }> {
  const script = `
import { createRequire } from "node:module";
const req = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = req("@prisma/client");
const p = new PrismaClient();
const rows = await p.trainingObligation.findMany({
  where: { employeeId: ${JSON.stringify(fixture.employeeId)}, courseId: ${JSON.stringify(fixture.courseId)} },
  orderBy: { issuedAt: "asc" },
  select: { id: true, reason: true, status: true, courseVersionId: true, issuedAt: true, satisfiedByCompletionId: true },
});
console.log("OBLIGATIONS " + JSON.stringify(rows.map((r) => ({
  id: r.id, reason: r.reason, status: r.status, courseVersionId: r.courseVersionId,
  issuedAt: r.issuedAt.toISOString(), satisfiedByCompletionId: r.satisfiedByCompletionId,
}))));
await p.$disconnect();
process.exit(0);
`;
  const stdout = runSshScript(script);
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith("OBLIGATIONS "));
  if (!line) throw new Error(`snapshotObligationsForEmployee failed: ${stdout.slice(-400)}`);
  return JSON.parse(line.slice(line.indexOf("[")));
}

/** EP-TRAIN-5C-3C — issue an OUTSTANDING MANUAL_REINSTATE obligation on
 *  the same (employee, courseVersion) a second time with
 *  conflictResolution=KEEP_BOTH.  Directly inserting a second obligation
 *  skips the EP-TRAIN-5B `issueManualReinstatement` conflict guard — we
 *  therefore emulate the service's exact DB effect: create another
 *  OUTSTANDING row with a fresh issuanceKey.  (The service's semantics
 *  for KEEP_BOTH are "insert alongside"; the only extra work the service
 *  does on top of insert is the ConflictError throw when the caller
 *  omits conflictResolution — not relevant to a direct test.)
 *
 *  Alternative implementations considered: driving the admin UI's
 *  "Require Retake" dialog twice as the authenticated founder.  That
 *  path is covered by the ADMIN-driven v2 publish flow in
 *  ep-train-5c3c-admin-ui.ts for the REVISION scenario, where routing
 *  through the UI is the only way to exercise auto-supersession.  For
 *  MANUAL_REINSTATE the service writes exactly one row per call; direct
 *  insert of a second OUTSTANDING row with a distinct issuanceKey is
 *  the identical DB state. */
export function seedSecondObligationKeepBoth(
  fixture: IsolatedFixture,
  opts: {
    reasonNote?: string;
    issuanceKeySuffix?: string;
  } = {},
): { obligationId: string } {
  return seedObligation(fixture, {
    reason: "MANUAL_REINSTATE",
    reasonNote: opts.reasonNote ?? "KEEP_BOTH second obligation",
    issuanceKeySuffix: opts.issuanceKeySuffix ?? "keep-both",
  });
}

/** Returns the course's CURRENTLY PUBLISHED version id (after a v2
 *  publish, the EP-TRAIN-3 fixture's `fixture.courseVersionId` becomes
 *  stale — callers need the latest). */
export function getCurrentPublishedVersionId(fixture: IsolatedFixture): string {
  const script = `
import { createRequire } from "node:module";
const req = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = req("@prisma/client");
const p = new PrismaClient();
const course = await p.trainingCourse.findUnique({
  where: { id: ${JSON.stringify(fixture.courseId)} },
  select: { currentVersionId: true },
});
console.log("CURRENT_VERSION " + JSON.stringify({ versionId: course.currentVersionId }));
await p.$disconnect();
process.exit(0);
`;
  const stdout = runSshScript(script);
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith("CURRENT_VERSION "));
  if (!line) throw new Error(`getCurrentPublishedVersionId failed: ${stdout.slice(-400)}`);
  return JSON.parse(line.slice(line.indexOf("{"))).versionId;
}

/** Clean up every TrainingObligation row scoped to this fixture.
 *  teardownIsolatedFixture doesn't touch obligations because the
 *  EP-TRAIN-3 fixture harness pre-dates EP-TRAIN-5A-1; this helper
 *  wipes them before teardown so the delete chain remains clean.
 *
 *  CRITICAL: TrainingProgress + TrainingAttempt have the obligation
 *  FK onDelete: SetNull.  If a scenario has >1 obligation with its
 *  own scoped progress row, deleting the obligations would null-ify
 *  BOTH progress rows' obligationId → the partial-UNIQUE on
 *  (employeeId, courseVersionId) WHERE obligationId IS NULL would
 *  reject the second null.  Fix: null the FKs explicitly BEFORE the
 *  obligations are deleted — but even that collides with the
 *  partial-UNIQUE.  So we DELETE the obligation-scoped
 *  TrainingProgress + TrainingAttempt rows first, THEN delete the
 *  obligations.  Legacy singleton progress rows (obligationId=NULL)
 *  are untouched. */
export function cleanupFixtureObligations(fixture: IsolatedFixture): { deleted: number } {
  const script = `
import { createRequire } from "node:module";
const require = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
const empId = ${JSON.stringify(fixture.employeeId)};
// Delete obligation-scoped TrainingProgress FIRST.  Progress has a
// partial-UNIQUE on (employeeId, courseVersionId) WHERE obligationId
// IS NULL; without this pre-delete, the obligation.id FK's SetNull
// cascade would collide when >1 obligation-scoped row exists on the
// same (employeeId, courseVersionId).  Attempts cascade cleanly (no
// equivalent unique index) so they're left to the standard teardown.
await p.trainingProgress.deleteMany({ where: { employeeId: empId, obligationId: { not: null } } });
const result = await p.trainingObligation.deleteMany({ where: { employeeId: empId } });
console.log("CLEANED_OBLIGATIONS " + JSON.stringify({ deleted: result.count }));
await p.$disconnect();
process.exit(0);
`;
  const stdout = runSshScript(script);
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith("CLEANED_OBLIGATIONS "));
  if (!line) throw new Error(`cleanupFixtureObligations failed: ${stdout.slice(-400)}`);
  return JSON.parse(line.slice(line.indexOf("{")));
}
