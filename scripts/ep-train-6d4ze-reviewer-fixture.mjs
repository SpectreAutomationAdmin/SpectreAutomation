// EP-TRAIN-6D-4Z-E — reviewer-acceptance fixture seeder.
//
// Creates everything needed for the §6 reviewer acceptance journey
// WITHOUT impersonating the founder:
//
//  1. Dedicated synthetic reviewer user (login-capable, bcrypt hash of
//     a random fixture password — time-boxed, removed post-acceptance):
//     `4ze-syn-reviewer-<ts>@example.test`
//     Role: TRAINING_AI_REVIEWER on the founder's active club ONLY.
//     Prints the password back so the Playwright spec can log in.
//
//  2. ONE DRAFT TrainingCourseVersion with authentic synthetic
//     transcript evidence (full grounding projection, canonical
//     envelope hash, segments, transcription job).
//
//  3. ONE draft in state REQUIRES_HUMAN_REVIEW (NOT APPROVED_DRAFT —
//     per §6 "do not pre-seed APPROVED_DRAFT for the positive approval
//     test"). The reviewer's Playwright session must drive the real
//     approval transition.
//
//  4. One TrainingCheckpoint attached to the version so the
//     downstream manager flow (out of this slice's scope) has a
//     destination — not touched by the reviewer.
//
// All records prefixed `4ZE-SYN-` so the cleanup script can anchor
// on the prefix.
//
// §3 note: this script does NOT seed the TRAINING_AI_REVIEWER Role
// row. That role is registered on staging via the existing
// `scripts/sync-rbac.ts` release_command invocation — the DRH-1
// deploy of the 4Z-D code is what makes the role available.
//
// Usage on staging:
//   flyctl ssh console -a spectre-staging -C \
//     "sh -c 'cat > /tmp/seed.mjs && node /tmp/seed.mjs'" \
//     < scripts/ep-train-6d4ze-reviewer-fixture.mjs

import { PrismaClient } from "/app/node_modules/@prisma/client/default.js";
import { randomUUID, createHash, randomBytes } from "node:crypto";
// bcryptjs is already an app dependency (used by prisma/seed.ts + auth).
import bcrypt from "/app/node_modules/bcryptjs/index.js";

const prisma = new PrismaClient();
const PREFIX = "4ZE-SYN-";
const MARKER = "[SYNTHETIC — 4Z-E reviewer acceptance]";

function tag(s) { return `${PREFIX}${s}`; }
function canon(obj) {
  if (Array.isArray(obj)) return obj.map(canon);
  if (obj && typeof obj === "object") {
    const out = {};
    for (const k of Object.keys(obj).sort()) out[k] = canon(obj[k]);
    return out;
  }
  return obj;
}
function canonStr(obj) { return JSON.stringify(canon(obj)); }

async function main() {
  const now = new Date();
  const ts = Date.now();

  // Target tenant = the founder's active club. Reviewer = NEW
  // synthetic user granted ONLY TRAINING_AI_REVIEWER on this club.
  const founder = await prisma.user.findUnique({
    where: { email: "cturcato@spectreautomation.com" },
    select: { id: true, clubId: true },
  });
  if (!founder || !founder.clubId) throw new Error("Founder account/club not found");
  const club = await prisma.club.findUnique({
    where: { id: founder.clubId },
    select: { id: true, name: true, wordmark: true },
  });
  if (!club) throw new Error("Founder's active club not found");
  console.log("TENANT_CLUB_ID:", club.id);
  console.log("TENANT_LABEL:", club.wordmark ?? club.name);

  // Verify the TRAINING_AI_REVIEWER role exists on staging (via
  // sync-rbac.ts release_command). If it doesn't, the deploy didn't
  // complete successfully.
  const role = await prisma.role.findUnique({
    where: { key: "TRAINING_AI_REVIEWER" },
    select: { key: true, name: true },
  });
  if (!role) {
    throw new Error(
      "TRAINING_AI_REVIEWER role is not registered on this staging DB. " +
        "The sync-rbac.ts release_command may not have run — redeploy or check logs.",
    );
  }
  console.log("ROLE_REGISTERED:", role.name);

  // Reviewer identity. Password = random 32-byte hex. Bcrypt-hashed.
  const reviewerEmail = `4ze-syn-reviewer-${ts}@example.test`;
  const reviewerPasswordPlain = randomBytes(32).toString("hex");
  const reviewerPasswordHash = await bcrypt.hash(reviewerPasswordPlain, 10);
  const reviewer = await prisma.user.create({
    data: {
      name: tag("Reviewer"),
      email: reviewerEmail,
      // Legacy `role` column — set to STAFF so a fallback lookup
      // doesn't accidentally grant admin privileges; the AUTHORITATIVE
      // grants live on UserClubRole.
      role: "STAFF",
      status: "ACTIVE",
      passwordHash: reviewerPasswordHash,
    },
    select: { id: true, email: true },
  });
  // Grant ONLY the TRAINING_AI_REVIEWER role at the target club.
  await prisma.userClubRole.create({
    data: {
      userId: reviewer.id,
      clubId: club.id,
      roleKey: "TRAINING_AI_REVIEWER",
    },
  });
  console.log("REVIEWER_USER_ID:", reviewer.id);
  console.log("REVIEWER_EMAIL:", reviewer.email);
  console.log("REVIEWER_PASSWORD:", reviewerPasswordPlain);
  console.log("REVIEWER_ROLE:", "TRAINING_AI_REVIEWER");

  // Synthetic course + version.
  const code = tag(`SAFETY-${ts}`);
  const course = await prisma.trainingCourse.create({
    data: {
      clubId: club.id,
      code,
      title: tag("Reviewer acceptance course"),
      category: "ORIENTATION",
    },
    select: { id: true },
  });
  console.log("COURSE_ID:", course.id);

  const videoBytes = Buffer.from(`${PREFIX}video-${ts}`, "utf-8");
  const videoSha = createHash("sha256").update(videoBytes).digest("hex");
  const buildId = createHash("sha256").update(`${PREFIX}build-${videoSha}`).digest("hex");

  const version = await prisma.trainingCourseVersion.create({
    data: {
      courseId: course.id,
      version: 1,
      state: "DRAFT",
      title: tag("Reviewer draft v1"),
      description: MARKER + " — DO NOT PUBLISH, DO NOT ASSIGN.",
      videoSha256: videoSha,
      videoStorageKey: `synthetic/4ze/${videoSha.slice(0, 16)}.mp4`,
      videoMimeType: "video/mp4",
      videoSizeBytes: 12_345_678,
      videoDurationSec: 240,
      passingScore: 80,
      retakesAllowed: true,
      requiresKnowledgeTest: true,
      required: false,
      appliesToAll: false,
    },
    select: { id: true },
  });
  console.log("VERSION_ID:", version.id);

  // Transcript build + 6 segments.
  const build = await prisma.trainingTranscriptBuild.create({
    data: {
      clubId: club.id,
      sourceVideoSha256: videoSha,
      resolvedTranscriptBuildId: buildId,
      transcriberName: tag("synthetic-transcriber"),
      transcriberVersion: "1",
      transcriberModelName: "4ZE-SYN-no-model",
      transcriberModelVersion: "stable",
      transcriberConfigSha256: createHash("sha256").update(`${PREFIX}config-${ts}`).digest("hex"),
      producedAt: now,
    },
    select: { id: true, resolvedTranscriptBuildId: true },
  });
  console.log("BUILD_ID:", build.id);

  const segments = [
    { segmentIndex: 0, startSec: 0.0,  endSec: 15.0,  text: tag("Welcome and overview of safety policies.") },
    { segmentIndex: 1, startSec: 15.5, endSec: 55.0,  text: tag("Member escalation protocol: always notify a supervisor.") },
    { segmentIndex: 2, startSec: 60.0, endSec: 110.0, text: tag("Equipment safety: never run the industrial dishwasher empty.") },
    { segmentIndex: 3, startSec: 115.0,endSec: 160.0, text: tag("Food safety temperatures stay below 4 degrees.") },
    { segmentIndex: 4, startSec: 165.0,endSec: 200.0, text: tag("Member service standard: greet within five seconds.") },
    { segmentIndex: 5, startSec: 205.0,endSec: 240.0, text: tag("Shift closeout: initial the checklist.") },
  ];
  for (const s of segments) {
    await prisma.trainingTranscriptSegment.create({
      data: {
        clubId: club.id,
        transcriptBuildId: build.id,
        segmentIndex: s.segmentIndex,
        startSec: s.startSec,
        endSec: s.endSec,
        text: s.text,
        pendingReviewJson: "[]",
        sourceOrgMismatchJson: "[]",
      },
    });
  }
  console.log("SEGMENTS: 6");

  // Grounding projection — canonical envelope shape.
  const canonicalPassages = segments.map((s, i) => ({
    passageId: `p-${i}`,
    sourceSegmentIds: [s.segmentIndex],
    sourceStartSec: s.startSec,
    sourceEndSec: s.endSec,
    text: s.text,
    citationHandle: `cite-${s.segmentIndex}`,
    flags: { pendingReview: [], sourceOrgMismatch: [], uncertaintyWarning: null },
  }));
  const canonicalEnvelope = {
    schemaVersion: "training-grounding-v1",
    operation: "GENERATE_DRAFT_QUESTIONS",
    tenantId: club.id,
    courseVersionId: version.id,
    sourceVideoSha256: videoSha,
    resolvedTranscriptBuildId: build.resolvedTranscriptBuildId,
    passages: canonicalPassages,
    excludedPassages: [],
  };
  const projectionSha = createHash("sha256")
    .update(canonStr(canonicalEnvelope), "utf-8")
    .digest("hex");

  const projection = await prisma.trainingGroundingProjection.create({
    data: {
      clubId: club.id,
      courseVersionId: version.id,
      sha256: projectionSha,
      sourceVideoSha256: videoSha,
      resolvedTranscriptBuildId: build.resolvedTranscriptBuildId,
      passagesJson: JSON.stringify(canonicalPassages),
      excludedPassagesJson: "[]",
      sourceOrgMismatchFlagsPresent: false,
      pendingReviewPresent: false,
      authoredAt: now,
    },
    select: { id: true },
  });
  console.log("PROJECTION_ID:", projection.id);

  // Transcription job COMPLETED (TranscriptionJob FK is on build.id).
  const tjob = await prisma.trainingTranscriptionJob.create({
    data: {
      clubId: club.id,
      courseVersionId: version.id,
      sourceVideoSha256: videoSha,
      state: "COMPLETED",
      resolvedTranscriptBuildId: build.id,
      requestedAt: new Date(now.getTime() - 30 * 60 * 1000),
      queuedAt: new Date(now.getTime() - 29 * 60 * 1000),
      startedAt: new Date(now.getTime() - 28 * 60 * 1000),
      completedAt: new Date(now.getTime() - 25 * 60 * 1000),
      attempts: 1,
      maxAttempts: 2,
      modelVariant: "4ZE-SYN",
      elapsedMsTotal: 180_000,
    },
    select: { id: true },
  });
  console.log("TRANSCRIPTION_JOB_ID:", tjob.id);

  // Generation run COMPLETED.
  const pilotAuthId = tag(`pilot-auth-${ts}`);
  const pilotFingerprint = createHash("sha256").update(`${PREFIX}pilot-${version.id}`).digest("hex");
  const planBody = {
    schemaVersion: "training-assessment-plan-v1",
    courseVersionId: version.id,
    resolvedTranscriptBuildId: build.resolvedTranscriptBuildId,
    sourceVideoSha256: videoSha,
    learningObjectives: [
      { id: "lo-1", title: "Escalation", segmentIds: [1] },
    ],
    topicBoundaries: [{ atSec: 60, rationale: "SENTENCE" }],
    eligibleSegmentIds: [0, 1, 2, 3, 4, 5],
    proposedCheckpointGroups: [
      { id: "cg-1", atSec: 115, learningObjectiveIds: ["lo-1"], targetQuestionCount: 1 },
    ],
    proposedFinalAssessment: { targetQuestionCount: 1, coverageLearningObjectiveIds: ["lo-1"] },
    totalTargetQuestionCount: 1,
    sourceEvidenceRequirements: {
      mustCiteAtLeastOneSegmentPerQuestion: true,
      excludedSegmentIndices: [16, 17],
    },
    generatedAt: now.toISOString(),
    generatedByUserId: null,
  };
  const planIdentity = createHash("sha256").update(canonStr(planBody)).digest("hex");

  const run = await prisma.trainingQuestionAiGenerationRun.create({
    data: {
      clubId: club.id,
      courseId: course.id,
      courseVersionId: version.id,
      pilotAuthorizationId: pilotAuthId,
      pilotAuthorizationFingerprint: pilotFingerprint,
      sourceVideoSha256: videoSha,
      resolvedTranscriptBuildId: build.resolvedTranscriptBuildId,
      groundingProjectionSha256: projectionSha,
      modelName: "4ZE-SYN-no-model",
      modelBackend: "synthetic",
      modelFormatEnforcer: "none",
      requestedAt: new Date(now.getTime() - 20 * 60 * 1000),
      queuedAt: new Date(now.getTime() - 19 * 60 * 1000),
      startedAt: new Date(now.getTime() - 18 * 60 * 1000),
      completedAt: new Date(now.getTime() - 10 * 60 * 1000),
      executionStatus: "COMPLETED",
      attempts: 1,
      maxAttempts: 2,
      assessmentPlanJson: canonStr(planBody),
      planIdentity,
      shortfallReasonJson: JSON.stringify({
        schemaVersion: "shortfall-v1",
        targetCount: 1,
        generatedCount: 1,
        shortfall: 0,
        dedupDropCount: 0,
        dedupRulesVersion: "dedup-v1",
        dedupDecisions: [],
        reason: MARKER,
      }),
    },
    select: { id: true },
  });
  console.log("GENERATION_RUN_ID:", run.id);

  // Checkpoint @115s for completeness (manager flow destination).
  const checkpoint = await prisma.trainingCheckpoint.create({
    data: {
      courseVersionId: version.id,
      atSecond: 115,
      label: tag("Mid-video checkpoint"),
      requiredToProceed: false,
      maxRetries: 2,
      displayOrder: 0,
    },
    select: { id: true },
  });
  console.log("CHECKPOINT_ID:", checkpoint.id);

  // THE DRAFT — REQUIRES_HUMAN_REVIEW state. The reviewer's
  // Playwright journey must transition this to APPROVED_DRAFT via
  // the real UI + the 4N service. We DO NOT pre-seed APPROVED_DRAFT.
  const draftBody = {
    schemaVersion: "training-question-draft-v1",
    questionType: "SINGLE_CHOICE",
    questionText: tag("What should you do when a member dispute escalates?"),
    options: [
      { text: tag("Always notify a supervisor."), isCorrect: true },
      { text: tag("Ignore the complaint."), isCorrect: false },
      { text: tag("Argue with the member."), isCorrect: false },
    ],
    explanation: MARKER + " escalation",
    sourceSegmentIds: [1],
  };
  const contentHash = createHash("sha256").update(canonStr(draftBody)).digest("hex");

  const draft = await prisma.trainingQuestionAiDraft.create({
    data: {
      clubId: club.id,
      courseId: course.id,
      courseVersionId: version.id,
      generationRunId: run.id,
      draftJson: canonStr(draftBody),
      contentHash,
      sourceVideoSha256: videoSha,
      resolvedTranscriptBuildId: build.resolvedTranscriptBuildId,
      groundingProjectionSha256: projectionSha,
      groundingProjectionId: projection.id,
      pilotAuthorizationId: pilotAuthId,
      pilotAuthorizationFingerprint: pilotFingerprint,
      // NOT APPROVED_DRAFT — per §6.
      state: "REQUIRES_HUMAN_REVIEW",
      stateChangedAt: now,
      recordVersion: 1,
      modelSelectedAnswerSnapshotJson: canonStr(draftBody.options),
      generatedAt: now,
    },
    select: { id: true, contentHash: true, recordVersion: true },
  });

  // Validation row — GROUNDED verdict so eligibility passes but
  // NO verifiedCorrectAnswerSnapshotJson (the reviewer must attest
  // to the correct answer during approval).
  const validation = await prisma.trainingQuestionAiValidation.create({
    data: {
      draftId: draft.id,
      clubId: club.id,
      draftContentHash: contentHash,
      validatorVersion: "4ZE-SYN-1",
      // Approval guard requires "integrated-pipeline" source — this
      // row represents a synthetic-grounded validation and must pass
      // the guard's authorisation check. The downstream 4N service
      // still re-verifies evidence + verified-answer bindings.
      validatorSource: "integrated-pipeline",
      verdict: "GROUNDED",
      stage: "VALIDATE",
      errorsJson: "[]",
      warningsJson: "[]",
      flagsJson: "[]",
      runAt: now,
      runByUserId: null,
      // verifiedCorrectAnswerSnapshotJson is intentionally NULL — the
      // reviewer's approval must attest + populate this.
    },
    select: { id: true },
  });

  console.log("DRAFT:" + JSON.stringify({
    id: draft.id,
    contentHash: draft.contentHash,
    recordVersion: draft.recordVersion,
    validationId: validation.id,
    verifiedIndex: 0,
    verifiedOptionText: draftBody.options[0].text,
    state: "REQUIRES_HUMAN_REVIEW",
  }));
  console.log("FIXTURE COMPLETE");
  console.log("URL_PATH_PERSISTED_REVIEW:", `/app/admin/ai-training/review/persisted?candidate=${draft.id}`);
}

main()
  .catch((err) => { console.error("FATAL:", err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
