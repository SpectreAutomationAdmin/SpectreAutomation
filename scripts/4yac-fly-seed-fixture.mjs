#!/usr/bin/env node
// EP-TRAIN-4Y-AC §8 acceptance — Fly-remote seeding of two disposable
// staging fixtures for the delete-draft acceptance test.
//
// Fixture A — plain disposable course, zero AI data. Exercises the
//             happy-path delete.
// Fixture B — disposable course WITH synthetic AI data:
//             - 1 TrainingQuestionAiGenerationRun (COMPLETED)
//             - 1 TrainingGroundingProjection
//             - 1 TrainingQuestionAiDraft (bound to the run + projection)
//             - 1 TrainingQuestionAiValidation (cascades from draft)
//             Exercises the AI-child cleanup end-to-end.
//
// Both fixtures are scoped to clubId = Coulee Ridge (the founder's
// active staging club). Course codes are prefixed `4YAC-ACCEPT-A-`
// and `4YAC-ACCEPT-B-` with a timestamp so re-runs don't collide.
//
// NOTHING IS DELETED by this script. It only creates rows. Cleanup
// is done via the admin UI in the sibling script
// `4yac-ui-delete-and-verify.mjs`.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Node on Windows can't spawn via a Unix-style /c/... path — use the
// native Windows path OR allow override via FLYCTL_BIN.
const FLYCTL =
  process.env.FLYCTL_BIN ??
  (process.platform === "win32"
    ? "C:\\Users\\cturcato\\.fly\\bin\\flyctl.exe"
    : "/usr/local/bin/flyctl");
const APP = "spectre-staging";
const CLUB_ID = "cmrvdeny7000144372ktmmg9c"; // Coulee Ridge (staging founder club)

// Safety: refuse to run if these ids appear in any seeded row.
const PROTECTED_COURSE_IDS = [
  "cmw8n6z8f0008z4nxck6uvms9", // 4Y-Z Silver Springs pilot
  "cmvzs3vz9000256qcu7lfysoz", // older Silver Springs pilot (historical AI evidence)
];

// Node-in-Fly expression: runs inside the Fly web machine where
// Prisma + the app's generated client are already available.
const fixtureScript = `
import { PrismaClient } from "/app/node_modules/@prisma/client/default.js";
import { randomBytes, createHash } from "node:crypto";
const p = new PrismaClient();
const now = new Date();
const stamp = Math.floor(now.getTime() / 1000).toString(36).toUpperCase();
const CLUB_ID = "${CLUB_ID}";
try {
  // Fixture A — plain course.
  const codeA = "4YAC-ACCEPT-A-" + stamp;
  const courseA = await p.trainingCourse.create({
    data: {
      clubId: CLUB_ID,
      code: codeA,
      title: "4YAC acceptance A (safe-to-delete) " + stamp,
      category: "Other",
      description: "EP-TRAIN-4Y-AC acceptance fixture A. Delete me.",
    },
  });
  const versionA = await p.trainingCourseVersion.create({
    data: {
      courseId: courseA.id,
      version: 1,
      state: "DRAFT",
      title: courseA.title,
      description: courseA.description,
      passingScore: 80,
      retakesAllowed: true,
      requiresKnowledgeTest: true,
      appliesToAll: true,
      required: true,
    },
  });

  // Fixture B — course + version + synthetic AI children.
  const codeB = "4YAC-ACCEPT-B-" + stamp;
  const courseB = await p.trainingCourse.create({
    data: {
      clubId: CLUB_ID,
      code: codeB,
      title: "4YAC acceptance B (ai children, safe-to-delete) " + stamp,
      category: "Other",
      description: "EP-TRAIN-4Y-AC acceptance fixture B — synthetic AI data. Delete me.",
    },
  });
  const versionB = await p.trainingCourseVersion.create({
    data: {
      courseId: courseB.id,
      version: 1,
      state: "DRAFT",
      title: courseB.title,
      description: courseB.description,
      passingScore: 80,
      retakesAllowed: true,
      requiresKnowledgeTest: true,
      appliesToAll: true,
      required: true,
    },
  });
  // Synthetic hashes — all 64-hex per schema. No GPU, no transcription.
  const sourceVideoSha256 = createHash("sha256").update("4yac-synthetic-video-" + stamp).digest("hex");
  const projectionSha256  = createHash("sha256").update("4yac-synthetic-projection-" + stamp).digest("hex");
  const transcriptBuildId = "4yac-synthetic-tbuild-" + stamp;
  const projection = await p.trainingGroundingProjection.create({
    data: {
      clubId: CLUB_ID,
      courseVersionId: versionB.id,
      sha256: projectionSha256,
      sourceVideoSha256,
      resolvedTranscriptBuildId: transcriptBuildId,
      passagesJson: JSON.stringify([
        { segmentIds: [0, 1], text: "synthetic passage 4yac" },
      ]),
      excludedPassagesJson: JSON.stringify([]),
      authoredAt: now,
    },
  });
  // Dummy assessment plan - minimal valid shape.
  const assessmentPlanJson = JSON.stringify({
    schemaVersion: "assessment-plan-v1",
    sourceVideoSha256,
    resolvedTranscriptBuildId: transcriptBuildId,
    groundingProjectionSha256: projectionSha256,
    eligibleSegmentIds: [0, 1],
    totalTargetQuestionCount: 1,
    proposedCheckpointGroups: [],
    proposedFinalAssessment: {
      targetQuestionCount: 1,
      coverageLearningObjectiveIds: [],
    },
    learningObjectives: [],
    generationPromptContract: "ctx-v1",
  });
  const planIdentity = createHash("sha256").update(assessmentPlanJson).digest("hex");
  const run = await p.trainingQuestionAiGenerationRun.create({
    data: {
      clubId: CLUB_ID,
      courseId: courseB.id,
      courseVersionId: versionB.id,
      pilotAuthorizationId: "4yac-accept-" + stamp,
      pilotAuthorizationFingerprint: "4yac-fp-" + stamp,
      sourceVideoSha256,
      resolvedTranscriptBuildId: transcriptBuildId,
      groundingProjectionSha256: projectionSha256,
      modelName: "synthetic",
      modelBackend: "synthetic",
      modelFormatEnforcer: "none",
      executionStatus: "COMPLETED",
      requestedAt: now,
      completedAt: now,
      assessmentPlanJson,
      planIdentity,
      attempts: 1,
      maxAttempts: 2,
    },
  });
  // Synthetic draft row to exercise the full cleanup chain.
  const draftBody = {
    questionType: "SINGLE_CHOICE",
    questionText: "4yac synthetic question — safe to delete.",
    options: [
      { text: "Option A", isCorrect: true },
      { text: "Option B", isCorrect: false },
    ],
    explanation: "synthetic",
    sourceSegmentIds: [0, 1],
  };
  const draftJson = JSON.stringify(draftBody);
  const contentHash = createHash("sha256").update(draftJson).digest("hex");
  const draft = await p.trainingQuestionAiDraft.create({
    data: {
      clubId: CLUB_ID,
      courseId: courseB.id,
      courseVersionId: versionB.id,
      generationRunId: run.id,
      draftJson,
      contentHash,
      sourceVideoSha256,
      resolvedTranscriptBuildId: transcriptBuildId,
      groundingProjectionSha256: projectionSha256,
      groundingProjectionId: projection.id,
      pilotAuthorizationId: "4yac-accept-" + stamp,
      pilotAuthorizationFingerprint: "4yac-fp-" + stamp,
      state: "REQUIRES_HUMAN_REVIEW",
      recordVersion: 0,
      generatedAt: now,
    },
  });
  console.log(JSON.stringify({
    ok: true,
    stamp,
    fixtureA: { courseId: courseA.id, courseCode: courseA.code, title: courseA.title, versionId: versionA.id },
    fixtureB: {
      courseId: courseB.id,
      courseCode: courseB.code,
      title: courseB.title,
      versionId: versionB.id,
      aiRunId: run.id,
      aiDraftId: draft.id,
      projectionId: projection.id,
    },
  }, null, 2));
} finally {
  await p.$disconnect();
}
`;

async function runFly() {
  return new Promise((resolve, reject) => {
    // Shell newline-stripping breaks multi-line `node -e` payloads over
    // flyctl ssh. Base64-encode the script and decode it inside Fly
    // before piping to node --input-type=module.
    const b64 = Buffer.from(fixtureScript, "utf8").toString("base64");
    const remoteShell =
      "echo " + b64 + " | base64 -d | node --input-type=module";
    const args = [
      "ssh", "console", "--app", APP,
      "--command", "sh -c " + JSON.stringify(remoteShell),
    ];
    const child = spawn(FLYCTL, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; process.stdout.write(d); });
    child.stderr.on("data", (d) => { stderr += d; process.stderr.write(d); });
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error("flyctl exited " + code + "\n" + stderr));
    });
  });
}

const result = await runFly();
// Find the JSON blob in stdout.
const match = result.stdout.match(/\{[\s\S]*"ok": true[\s\S]*\}/);
if (!match) {
  console.error("\nCOULD NOT PARSE FIXTURE RESULT — see stdout above");
  process.exit(1);
}
const parsed = JSON.parse(match[0]);
// Protect-list guard: refuse if seeded ids collide.
for (const protectedId of PROTECTED_COURSE_IDS) {
  if (parsed.fixtureA.courseId === protectedId || parsed.fixtureB.courseId === protectedId) {
    console.error("\nREFUSING — seeded id collides with a protected pilot course: " + protectedId);
    process.exit(2);
  }
}
fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yac-fixture-ids.json", JSON.stringify(parsed, null, 2));
console.log("\n→ wrote test-results/4yac-fixture-ids.json");
console.log("  Fixture A courseId:", parsed.fixtureA.courseId);
console.log("  Fixture B courseId:", parsed.fixtureB.courseId);
console.log("  Fixture B aiRunId:  ", parsed.fixtureB.aiRunId);
