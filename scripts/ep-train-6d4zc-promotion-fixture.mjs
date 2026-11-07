// EP-TRAIN-6D-4Z-C — promotion-acceptance fixture seeder.
//
// Creates everything needed to exercise the manager-facing promote
// flow on staging WITHOUT impersonating the founder and WITHOUT
// granting any new permissions:
//
//  1. ONE dedicated synthetic reviewer user:
//     `4z-syn-reviewer-<timestamp>@example.test`
//     - name: "4Z-SYN Reviewer"
//     - role: CLUB_ADMIN (the LEAST permission needed for the review
//       fields; the user gets NO UserClubRole and therefore NO active
//       permissions in the running app — the fixture only needs the
//       User.id for FK attribution on synthetic review rows).
//     - passwordHash: an unrecoverable random bcrypt — this account
//       CANNOT log in. Login is explicitly impossible.
//     This user exists solely so TrainingQuestionAiReview.reviewedByUserId
//     has a legitimate, clearly-synthetic attribution target instead of
//     the founder.
//
//  2. ONE synthetic DRAFT TrainingCourseVersion with:
//     - synthetic videoSha256 + duration + storageKey
//     - 6 transcript segments
//     - COMPLETED TrainingTranscriptionJob
//     - grounding projection
//     - COMPLETED generation run
//     - 1 TrainingCheckpoint (115s)
//     - TWO drafts in APPROVED_DRAFT state, each with a validation
//       row carrying verifiedCorrectAnswerSnapshotJson, and an
//       APPROVED TrainingQuestionAiReview attributed to the synthetic
//       reviewer (NOT the founder).
//
// All records prefixed `4Z-SYN-` so the cleanup script can anchor on
// the prefix.
//
// Idempotent + prefix-anchored. Output includes the two draft ids +
// the version + the checkpoint id + URL path for the Playwright spec.
//
// Usage on staging:
//   flyctl ssh console -a spectre-staging -C \
//     "sh -c 'cat > /tmp/seed.mjs && node /tmp/seed.mjs'" \
//     < scripts/ep-train-6d4zc-promotion-fixture.mjs

import { PrismaClient } from "/app/node_modules/@prisma/client/default.js";
import { randomUUID, createHash, randomBytes } from "node:crypto";

const prisma = new PrismaClient();
const PREFIX = "4Z-SYN-";
const MARKER = "[SYNTHETIC — 4Z-C promotion acceptance]";

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

  // Target tenant = the founder's active club. Reviewer = NEW synthetic
  // user (never the founder).
  const founder = await prisma.user.findUnique({
    where: { email: "cturcato@spectreautomation.com" },
    select: { id: true, clubId: true },
  });
  if (!founder || !founder.clubId) {
    throw new Error("Founder account/club not found — cannot resolve tenant");
  }
  const club = await prisma.club.findUnique({
    where: { id: founder.clubId },
    select: { id: true, name: true, wordmark: true },
  });
  if (!club) throw new Error("Founder's active club not found");
  console.log("TENANT_CLUB_ID:", club.id);
  console.log("TENANT_LABEL:", club.wordmark ?? club.name);

  // Synthetic reviewer user — fixture-only, cannot log in.
  const reviewerEmail = `4z-syn-reviewer-${ts}@example.test`;
  const reviewer = await prisma.user.create({
    data: {
      name: tag("Reviewer"),
      email: reviewerEmail,
      role: "CLUB_ADMIN",
      status: "ACTIVE",
      passwordHash: `UNRECOVERABLE-4Z-SYN-${randomBytes(32).toString("base64")}`,
    },
    select: { id: true, email: true },
  });
  console.log("REVIEWER_USER_ID:", reviewer.id);
  console.log("REVIEWER_EMAIL:", reviewer.email);

  // Synthetic course + version.
  const code = tag(`SAFETY-${ts}`);
  const course = await prisma.trainingCourse.create({
    data: {
      clubId: club.id,
      code,
      title: tag("Promotion acceptance course"),
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
      title: tag("Promotion draft v1"),
      description: MARKER + " — DO NOT PUBLISH, DO NOT ASSIGN.",
      videoSha256: videoSha,
      videoStorageKey: `synthetic/4zc/${videoSha.slice(0, 16)}.mp4`,
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
      transcriberModelName: "4Z-SYN-no-model",
      transcriberModelVersion: "stable",
      transcriberConfigSha256: createHash("sha256").update(`${PREFIX}config-${ts}`).digest("hex"),
      producedAt: now,
    },
    select: { id: true, resolvedTranscriptBuildId: true },
  });
  console.log("BUILD_ID:", build.id);

  const segments = [
    { segmentIndex: 0, startSec: 0.0,  endSec: 15.0,  text: tag("Welcome and overview of policies.") },
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

  // Build passages in the canonical shape the 4M evidence reader
  // recomputes against (schemaVersion/operation/tenantId/… envelope +
  // passage objects with passageId/sourceSegmentIds/sourceStartSec/
  // sourceEndSec/text/citationHandle/flags). The projection row's
  // sha256 column + the draft's groundingProjectionSha256 scalar must
  // both equal sha256(canonicalise(envelope)).
  const canonicalPassages = segments.map((s, i) => ({
    passageId: `p-${i}`,
    sourceSegmentIds: [s.segmentIndex],
    sourceStartSec: s.startSec,
    sourceEndSec: s.endSec,
    text: s.text,
    citationHandle: `cite-${s.segmentIndex}`,
    flags: {
      pendingReview: [],
      sourceOrgMismatch: [],
      uncertaintyWarning: null,
    },
  }));
  const canonicalEnvelope = {
    schemaVersion: "training-grounding-v1",
    operation: "GENERATE_DRAFT_QUESTIONS",
    tenantId: club.id,
    courseVersionId: version.id,
    sourceVideoSha256: videoSha,
    // resolvedTranscriptBuildId is the content-addressable HASH of the
    // transcript build, NOT the DB primary key of the build row.
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
      // Hash, not Prisma PK.
      resolvedTranscriptBuildId: build.resolvedTranscriptBuildId,
      // Writer stores JSON.stringify(input.passages) RAW — just the
      // passages array, not the envelope — per the 4L writer's
      // documented contract.
      passagesJson: JSON.stringify(canonicalPassages),
      excludedPassagesJson: "[]",
      sourceOrgMismatchFlagsPresent: false,
      pendingReviewPresent: false,
      authoredAt: now,
    },
    select: { id: true },
  });
  console.log("PROJECTION_ID:", projection.id);

  // Transcription job (COMPLETED). NOTE: TrainingTranscriptionJob's
  // resolvedTranscriptBuildId has an actual @relation FK to
  // TrainingTranscriptBuild.id (the Prisma PK), unlike the other
  // training-AI tables where the same-named column is a content hash.
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
      modelVariant: "4Z-SYN",
      elapsedMsTotal: 180_000,
    },
    select: { id: true },
  });
  console.log("TRANSCRIPTION_JOB_ID:", tjob.id);

  // Generation run (COMPLETED).
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
    ],
    topicBoundaries: [
      { atSec: 60, rationale: "SENTENCE" },
      { atSec: 115, rationale: "PAUSE" },
    ],
    eligibleSegmentIds: [0, 1, 2, 3, 4, 5],
    proposedCheckpointGroups: [
      { id: "cg-1", atSec: 115, learningObjectiveIds: ["lo-1", "lo-2"], targetQuestionCount: 1 },
    ],
    proposedFinalAssessment: {
      targetQuestionCount: 2,
      coverageLearningObjectiveIds: ["lo-1", "lo-2"],
    },
    totalTargetQuestionCount: 3,
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
      modelName: "4Z-SYN-no-model",
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
        targetCount: 2,
        generatedCount: 2,
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

  // Checkpoint @115s.
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

  // TWO approved drafts.
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
    },
    {
      key: "food-safety",
      questionText: tag("What temperature must food be kept below?"),
      options: [
        { text: tag("Below 4 degrees Celsius."), isCorrect: true },
        { text: tag("Below 15 degrees Celsius."), isCorrect: false },
      ],
      verifiedIndex: 0,
      sourceSegmentIds: [3],
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
        state: "APPROVED_DRAFT",
        stateChangedAt: now,
        recordVersion: 1,
        modelSelectedAnswerSnapshotJson: canonStr(t.options),
        generatedAt: now,
      },
      select: { id: true, contentHash: true },
    });

    // Two-pass validation row create: insert without the snapshot
    // first, read the real row id, then UPDATE the snapshot JSON to
    // carry that id — the 4N verified-answer reader enforces
    // snapshot.validationId == review.validation.id (check 5).
    const validationRow = await prisma.trainingQuestionAiValidation.create({
      data: {
        draftId: draft.id,
        clubId: club.id,
        draftContentHash: contentHash,
        validatorVersion: "4Z-SYN-1",
        validatorSource: "fixture",
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
    await prisma.trainingQuestionAiValidation.update({
      where: { id: validationRow.id },
      data: {
        verifiedCorrectAnswerSnapshotJson: canonStr({
          optionIndex: t.verifiedIndex,
          optionText: t.options[t.verifiedIndex].text,
          verifiedByUserId: reviewer.id,
          verifiedAt: now.toISOString(),
          draftContentHash: contentHash,
          validationId: validationRow.id,
        }),
      },
    });
    const validation = validationRow;

    // Review row attributed to the SYNTHETIC reviewer (NOT the founder).
    await prisma.trainingQuestionAiReview.create({
      data: {
        draftId: draft.id,
        clubId: club.id,
        disposition: "APPROVED",
        reviewerNote: MARKER + " auto-approved for promotion test",
        reviewedByUserId: reviewer.id,
        reviewedAt: now,
        draftContentHash: contentHash,
        validationId: validation.id,
      },
    });

    drafts.push({
      key: t.key,
      id: draft.id,
      contentHash: draft.contentHash,
      validationId: validation.id,
      verifiedIndex: t.verifiedIndex,
    });
  }

  console.log("DRAFTS:" + JSON.stringify(drafts));
  console.log("FIXTURE COMPLETE");
  console.log("URL_PATH:", `/app/admin/people/safety-training/${course.id}/${version.id}/ai-workspace`);
  console.log("EDITOR_URL_PATH:", `/app/admin/people/safety-training/${course.id}/${version.id}`);
}

main()
  .catch((err) => { console.error("FATAL:", err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
