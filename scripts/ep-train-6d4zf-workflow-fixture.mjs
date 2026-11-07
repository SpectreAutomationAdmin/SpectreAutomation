// EP-TRAIN-6D-4Z-F — two-role workflow-acceptance fixture seeder.
//
// Creates the complete two-role workflow setup on staging WITHOUT
// impersonating the founder and WITHOUT granting SUPER_ADMIN:
//
//  1. Synthetic REVIEWER user (TRAINING_AI_REVIEWER only, scoped to
//     Coulee Ridge). Password = random 32-byte hex.
//
//  2. Synthetic ADMIN user (CLUB_ADMIN only, scoped to Coulee Ridge
//     — NOT the founder). Password = random 32-byte hex.
//     Needed because §7 says the admin promote journey must happen
//     through the UI as a separate authenticated session, and §4
//     forbids modifying the founder's account.
//
//  3. ONE DRAFT TrainingCourseVersion with authentic synthetic
//     transcript evidence (full grounding projection, canonical
//     envelope hash, segments, transcription job, generation run).
//
//  4. TWO TrainingCheckpoint rows at distinct timestamps (115s + 190s)
//     so the admin can promote distinct checkpoint questions.
//
//  5. FOUR TrainingQuestionAiDraft rows in state REQUIRES_HUMAN_REVIEW
//     (per §6 the reviewer must drive the real approval transition —
//     NOT pre-seeded APPROVED_DRAFT). Each has a distinct contentHash
//     so dedup does not collide:
//       * Draft 1 — escalation question → intended for checkpoint #1
//       * Draft 2 — equipment-safety question → intended for checkpoint #2
//       * Draft 3 — food-safety question → intended for final assessment
//       * Draft 4 — member-service question → intended for final assessment
//
// All prefixed `4ZF-SYN-`.
//
// §3 note: this script does NOT seed the TRAINING_AI_REVIEWER role
// (already live on staging via sync-rbac.ts from the 4Z-E deploy).

import { PrismaClient } from "/app/node_modules/@prisma/client/default.js";
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "/app/node_modules/bcryptjs/index.js";

const prisma = new PrismaClient();
const PREFIX = "4ZF-SYN-";
const MARKER = "[SYNTHETIC — 4Z-F two-role workflow acceptance]";

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

async function createSyntheticUser(prefix, roleKey, clubId, legacyRole) {
  const ts = Date.now();
  const email = `4zf-syn-${prefix}-${ts}@example.test`;
  const pwd = randomBytes(32).toString("hex");
  const hash = await bcrypt.hash(pwd, 10);
  const u = await prisma.user.create({
    data: {
      name: tag(prefix),
      email,
      role: legacyRole,
      status: "ACTIVE",
      passwordHash: hash,
    },
    select: { id: true, email: true },
  });
  await prisma.userClubRole.create({
    data: { userId: u.id, clubId, roleKey },
  });
  return { id: u.id, email, password: pwd, roleKey };
}

async function main() {
  const now = new Date();
  const ts = Date.now();

  // Tenant = founder's active club. Reviewer + Admin are SYNTHETIC.
  const founder = await prisma.user.findUnique({
    where: { email: "cturcato@spectreautomation.com" },
    select: { id: true, clubId: true },
  });
  if (!founder || !founder.clubId) throw new Error("Founder/club not found");
  const club = await prisma.club.findUnique({
    where: { id: founder.clubId },
    select: { id: true, name: true, wordmark: true },
  });
  console.log("TENANT_CLUB_ID:", club.id);
  console.log("TENANT_LABEL:", club.wordmark ?? club.name);

  // Verify TRAINING_AI_REVIEWER role exists (from the 4Z-E deploy).
  const role = await prisma.role.findUnique({
    where: { key: "TRAINING_AI_REVIEWER" },
    select: { key: true },
  });
  if (!role) throw new Error("TRAINING_AI_REVIEWER role missing on staging");

  // Create both synthetic users.
  const reviewer = await createSyntheticUser(
    "reviewer", "TRAINING_AI_REVIEWER", club.id, "STAFF",
  );
  const admin = await createSyntheticUser(
    "admin", "CLUB_ADMIN", club.id, "CLUB_ADMIN",
  );
  console.log("REVIEWER_USER_ID:", reviewer.id);
  console.log("REVIEWER_EMAIL:", reviewer.email);
  console.log("REVIEWER_PASSWORD:", reviewer.password);
  console.log("ADMIN_USER_ID:", admin.id);
  console.log("ADMIN_EMAIL:", admin.email);
  console.log("ADMIN_PASSWORD:", admin.password);

  // Course + version.
  const course = await prisma.trainingCourse.create({
    data: {
      clubId: club.id,
      code: tag(`SAFETY-${ts}`),
      title: tag("Full workflow acceptance course"),
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
      title: tag("Workflow draft v1"),
      description: MARKER + " — DO NOT PUBLISH, DO NOT ASSIGN.",
      videoSha256: videoSha,
      videoStorageKey: `synthetic/4zf/${videoSha.slice(0, 16)}.mp4`,
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

  // Transcript build + segments.
  const build = await prisma.trainingTranscriptBuild.create({
    data: {
      clubId: club.id,
      sourceVideoSha256: videoSha,
      resolvedTranscriptBuildId: buildId,
      transcriberName: tag("synthetic-transcriber"),
      transcriberVersion: "1",
      transcriberModelName: "4ZF-SYN-no-model",
      transcriberModelVersion: "stable",
      transcriberConfigSha256: createHash("sha256").update(`${PREFIX}config-${ts}`).digest("hex"),
      producedAt: now,
    },
    select: { id: true, resolvedTranscriptBuildId: true },
  });

  const segments = [
    { segmentIndex: 0, startSec: 0.0,  endSec: 15.0,  text: tag("Welcome and overview of safety policies.") },
    { segmentIndex: 1, startSec: 15.5, endSec: 55.0,  text: tag("Member escalation protocol: always notify a supervisor.") },
    { segmentIndex: 2, startSec: 60.0, endSec: 110.0, text: tag("Equipment safety: never run the industrial dishwasher empty.") },
    { segmentIndex: 3, startSec: 115.0,endSec: 160.0, text: tag("Food safety temperatures stay below 4 degrees Celsius.") },
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

  // Canonical grounding projection.
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

  // Transcription job (TranscriptionJob FK is on build.id).
  await prisma.trainingTranscriptionJob.create({
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
      modelVariant: "4ZF-SYN",
      elapsedMsTotal: 180_000,
    },
  });

  // Two checkpoints.
  const checkpoint1 = await prisma.trainingCheckpoint.create({
    data: {
      courseVersionId: version.id,
      atSecond: 115,
      label: tag("Checkpoint 1 — escalation"),
      requiredToProceed: false,
      maxRetries: 2,
      displayOrder: 0,
    },
    select: { id: true, atSecond: true },
  });
  const checkpoint2 = await prisma.trainingCheckpoint.create({
    data: {
      courseVersionId: version.id,
      atSecond: 190,
      label: tag("Checkpoint 2 — equipment"),
      requiredToProceed: false,
      maxRetries: 2,
      displayOrder: 1,
    },
    select: { id: true, atSecond: true },
  });
  console.log("CHECKPOINT_1_ID:", checkpoint1.id);
  console.log("CHECKPOINT_2_ID:", checkpoint2.id);

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
      { id: "lo-2", title: "Equipment safety", segmentIds: [2] },
      { id: "lo-3", title: "Food safety", segmentIds: [3] },
      { id: "lo-4", title: "Member service", segmentIds: [4] },
    ],
    topicBoundaries: [
      { atSec: 60, rationale: "SENTENCE" },
      { atSec: 115, rationale: "PAUSE" },
    ],
    eligibleSegmentIds: [0, 1, 2, 3, 4, 5],
    proposedCheckpointGroups: [
      { id: "cg-1", atSec: 115, learningObjectiveIds: ["lo-1"], targetQuestionCount: 1 },
      { id: "cg-2", atSec: 190, learningObjectiveIds: ["lo-2"], targetQuestionCount: 1 },
    ],
    proposedFinalAssessment: {
      targetQuestionCount: 2,
      coverageLearningObjectiveIds: ["lo-3", "lo-4"],
    },
    totalTargetQuestionCount: 4,
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
      modelName: "4ZF-SYN-no-model",
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
        targetCount: 4,
        generatedCount: 4,
        shortfall: 0,
        dedupDropCount: 0,
        dedupRulesVersion: "dedup-v1",
        dedupDecisions: [],
        reason: MARKER,
      }),
    },
    select: { id: true },
  });

  // Four distinct drafts in REQUIRES_HUMAN_REVIEW.
  const draftTemplates = [
    {
      key: "escalation",
      questionText: tag("What should you do when a member dispute escalates?"),
      options: [
        { text: tag("Always notify a supervisor."), isCorrect: true },
        { text: tag("Ignore the complaint."), isCorrect: false },
        { text: tag("Argue with the member."), isCorrect: false },
      ],
      verifiedIndex: 0,
      sourceSegmentIds: [1],
      destination: "CHECKPOINT",
      checkpointId: checkpoint1.id,
    },
    {
      key: "equipment",
      questionText: tag("Should the industrial dishwasher ever run empty?"),
      options: [
        { text: tag("Never."), isCorrect: true },
        { text: tag("Only on Sundays."), isCorrect: false },
      ],
      verifiedIndex: 0,
      sourceSegmentIds: [2],
      destination: "CHECKPOINT",
      checkpointId: checkpoint2.id,
    },
    {
      key: "food-safety",
      questionText: tag("At what temperature must food be kept?"),
      options: [
        { text: tag("Below 4 degrees Celsius."), isCorrect: true },
        { text: tag("Below 15 degrees Celsius."), isCorrect: false },
      ],
      verifiedIndex: 0,
      sourceSegmentIds: [3],
      destination: "FINAL_ASSESSMENT",
      checkpointId: null,
    },
    {
      key: "service",
      questionText: tag("Within how many seconds should members be greeted?"),
      options: [
        { text: tag("Five seconds."), isCorrect: true },
        { text: tag("Thirty seconds."), isCorrect: false },
        { text: tag("Only after they wave."), isCorrect: false },
      ],
      verifiedIndex: 0,
      sourceSegmentIds: [4],
      destination: "FINAL_ASSESSMENT",
      checkpointId: null,
    },
  ];

  const drafts = [];
  for (const t of draftTemplates) {
    const draftBody = {
      schemaVersion: "training-question-draft-v1",
      questionType: "SINGLE_CHOICE",
      questionText: t.questionText,
      options: t.options,
      explanation: MARKER + " " + t.key,
      sourceSegmentIds: t.sourceSegmentIds,
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
        state: "REQUIRES_HUMAN_REVIEW",
        stateChangedAt: now,
        recordVersion: 1,
        modelSelectedAnswerSnapshotJson: canonStr(t.options),
        generatedAt: now,
      },
      select: { id: true, contentHash: true, recordVersion: true },
    });

    // Validation row (integrated-pipeline so 4N guard accepts).
    const validation = await prisma.trainingQuestionAiValidation.create({
      data: {
        draftId: draft.id,
        clubId: club.id,
        draftContentHash: contentHash,
        validatorVersion: "4ZF-SYN-1",
        validatorSource: "integrated-pipeline",
        verdict: "GROUNDED",
        stage: "VALIDATE",
        errorsJson: "[]",
        warningsJson: "[]",
        flagsJson: "[]",
        runAt: now,
        runByUserId: null,
      },
      select: { id: true },
    });

    drafts.push({
      key: t.key,
      id: draft.id,
      contentHash: draft.contentHash,
      recordVersion: draft.recordVersion,
      validationId: validation.id,
      verifiedIndex: t.verifiedIndex,
      destination: t.destination,
      checkpointId: t.checkpointId,
    });
  }

  console.log("DRAFTS:" + JSON.stringify(drafts));
  console.log("FIXTURE COMPLETE");
  console.log("URL_PATH_WORKSPACE:", `/app/admin/people/safety-training/${course.id}/${version.id}/ai-workspace`);
  console.log("URL_PATH_EDITOR:", `/app/admin/people/safety-training/${course.id}/${version.id}`);
}

main()
  .catch((err) => { console.error("FATAL:", err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
