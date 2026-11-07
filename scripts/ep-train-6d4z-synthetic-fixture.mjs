// EP-TRAIN-6D-4Z — synthetic workflow fixture seeder.
//
// Creates disposable test data that exercises the 4Y AI workspace
// without running any Modal / Qwen / Whisper inference. Prefixes
// every record with `4Z-SYN-` so a founder visually inspecting the
// workspace cannot confuse synthetic data with real AI-generated
// content.
//
// What this script creates:
//  1. One synthetic DRAFT TrainingCourseVersion attached to an
//     EXISTING tenant (first club found).
//  2. A representative videoSha256 + duration + storageKey (no
//     real bytes uploaded — the workspace only reads the metadata).
//  3. A COMPLETED TrainingTranscriptionJob with 6 transcript
//     segments.
//  4. One COMPLETED TrainingQuestionAiGenerationRun with an
//     assessment plan covering 2 learning objectives + 1 checkpoint
//     group + 2 final-assessment questions.
//  5. 3 TrainingQuestionAiDraft rows in different lifecycle states
//     so the workspace surfaces REVIEW + COURSE ASSEMBLY stages:
//       - 1 x APPROVED_DRAFT with a verified-answer snapshot
//       - 1 x REQUIRES_HUMAN_REVIEW
//       - 1 x REJECTED
//  6. One TrainingCheckpoint at the plan's checkpoint timestamp so
//     the assembly panel's CHECKPOINT dropdown is populated.
//
// Everything is tagged with the `4Z-SYN-` prefix so the cleanup
// script can safely tear it down without touching any founder /
// member / historical data.
//
// Usage on staging (via flyctl ssh console):
//   flyctl ssh console -a spectre-staging -C \
//     "sh -c 'cat > /tmp/seed.mjs && node /tmp/seed.mjs'" < scripts/ep-train-6d4z-synthetic-fixture.mjs
//
// Idempotent: re-running with the same prefix returns the existing
// IDs without duplication.

import { PrismaClient } from "/app/node_modules/@prisma/client/default.js";
import { randomUUID, createHash } from "node:crypto";

const prisma = new PrismaClient();
const PREFIX = "4Z-SYN-";
const SYNTHETIC_MARKER = "[SYNTHETIC — 4Z acceptance fixture]";

function tag(s) { return `${PREFIX}${s}`; }

function canonicaliseForHash(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

async function main() {
  const now = new Date();

  // Target tenant = the founder's active club. Reviewer = the founder.
  // We do NOT modify the founder's record; we only READ its id + clubId
  // for attribution on the synthetic review row. Everything we create
  // is tagged with the 4Z-SYN- prefix and torn down by the cleanup
  // script.
  const founderEmail = process.env.FIXTURE_FOUNDER_EMAIL
    ?? "cturcato@spectreautomation.com";
  const founder = await prisma.user.findUnique({
    where: { email: founderEmail },
    select: { id: true, clubId: true, status: true },
  });
  if (!founder) throw new Error("Founder account not found on staging");
  if (founder.status !== "ACTIVE") throw new Error("Founder account not ACTIVE");
  if (!founder.clubId) throw new Error("Founder has no active clubId");

  const club = await prisma.club.findUnique({
    where: { id: founder.clubId },
    select: { id: true, name: true, wordmark: true },
  });
  if (!club) throw new Error("Founder's active club not found");

  console.log("TENANT_CLUB_ID:", club.id);
  console.log("TENANT_LABEL:", club.wordmark ?? club.name);

  const reviewer = { id: founder.id };
  console.log("REVIEWER_USER_ID:", reviewer.id);

  // Find or create the course.
  const code = tag("SAFETY");
  let course = await prisma.trainingCourse.findFirst({
    where: { clubId: club.id, code },
    select: { id: true },
  });
  if (!course) {
    course = await prisma.trainingCourse.create({
      data: {
        clubId: club.id,
        code,
        title: tag("Workspace acceptance course"),
        category: "ORIENTATION",
      },
      select: { id: true },
    });
  }
  console.log("COURSE_ID:", course.id);

  // Find or create the DRAFT version.
  const videoBytes = Buffer.from(`${PREFIX}video-placeholder`, "utf-8");
  const videoSha = createHash("sha256").update(videoBytes).digest("hex");
  const buildId = createHash("sha256").update(`${PREFIX}build:${videoSha}`).digest("hex");

  let version = await prisma.trainingCourseVersion.findFirst({
    where: { courseId: course.id, version: 1 },
    select: { id: true },
  });
  if (!version) {
    version = await prisma.trainingCourseVersion.create({
      data: {
        courseId: course.id,
        version: 1,
        state: "DRAFT",
        title: tag("Workspace draft v1"),
        description: SYNTHETIC_MARKER + " — this version is safe to inspect but must not be published or assigned to employees.",
        videoSha256: videoSha,
        videoStorageKey: `synthetic/4z/${videoSha.slice(0, 16)}.mp4`,
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
  }
  console.log("VERSION_ID:", version.id);

  // Transcript build + segments (pre-seeded, not from a Modal call).
  let build = await prisma.trainingTranscriptBuild.findFirst({
    where: { clubId: club.id, sourceVideoSha256: videoSha },
    select: { id: true, resolvedTranscriptBuildId: true },
  });
  if (!build) {
    build = await prisma.trainingTranscriptBuild.create({
      data: {
        clubId: club.id,
        sourceVideoSha256: videoSha,
        resolvedTranscriptBuildId: buildId,
        transcriberName: tag("synthetic-transcriber"),
        transcriberVersion: "1",
        transcriberModelName: "4Z-SYN-no-model",
        transcriberModelVersion: "stable",
        transcriberConfigSha256: createHash("sha256").update(`${PREFIX}config`).digest("hex"),
        producedAt: now,
      },
      select: { id: true, resolvedTranscriptBuildId: true },
    });
  }
  console.log("BUILD_ID:", build.id);

  // Six synthetic transcript segments covering the 4-minute run.
  const segments = [
    { segmentIndex: 0, startSec: 0.0, endSec: 15.0, text: tag("Welcome and overview of policies.") },
    { segmentIndex: 1, startSec: 15.5, endSec: 55.0, text: tag("Member escalation protocol: always notify a supervisor.") },
    { segmentIndex: 2, startSec: 60.0, endSec: 110.0, text: tag("Equipment safety: never run the industrial dishwasher empty.") },
    { segmentIndex: 3, startSec: 115.0, endSec: 160.0, text: tag("Food safety temperatures stay below 4 degrees.") },
    { segmentIndex: 4, startSec: 165.0, endSec: 200.0, text: tag("Member service standard: greet within five seconds.") },
    { segmentIndex: 5, startSec: 205.0, endSec: 240.0, text: tag("Shift closeout: initial the checklist.") },
  ];

  for (const s of segments) {
    const existing = await prisma.trainingTranscriptSegment.findFirst({
      where: { clubId: club.id, transcriptBuildId: build.id, segmentIndex: s.segmentIndex },
      select: { id: true },
    });
    if (!existing) {
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
  }
  console.log("SEGMENTS: 6");

  // Transcription job (COMPLETED).
  let tjob = await prisma.trainingTranscriptionJob.findFirst({
    where: { clubId: club.id, courseVersionId: version.id, sourceVideoSha256: videoSha },
    select: { id: true, state: true },
  });
  if (!tjob) {
    tjob = await prisma.trainingTranscriptionJob.create({
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
      select: { id: true, state: true },
    });
  }
  console.log("TRANSCRIPTION_JOB_ID:", tjob.id);

  // Grounding projection + generation run (COMPLETED).
  const projectionSha = createHash("sha256").update(`${PREFIX}projection:${build.id}`).digest("hex");
  let projection = await prisma.trainingGroundingProjection.findFirst({
    where: { clubId: club.id, courseVersionId: version.id, sha256: projectionSha },
    select: { id: true },
  });
  if (!projection) {
    projection = await prisma.trainingGroundingProjection.create({
      data: {
        clubId: club.id,
        courseVersionId: version.id,
        sha256: projectionSha,
        sourceVideoSha256: videoSha,
        resolvedTranscriptBuildId: build.id,
        passagesJson: JSON.stringify(
          segments.map((s) => ({
            segmentIndex: s.segmentIndex,
            text: s.text,
            sourceSegmentIds: [s.segmentIndex],
          })),
        ),
        excludedPassagesJson: "[]",
        sourceOrgMismatchFlagsPresent: false,
        pendingReviewPresent: false,
        authoredAt: now,
      },
      select: { id: true },
    });
  }
  console.log("PROJECTION_ID:", projection.id);

  const pilotAuthId = tag("pilot-auth-id");
  const pilotFingerprint = createHash("sha256").update(`${PREFIX}pilot:${version.id}`).digest("hex");

  const planBody = {
    schemaVersion: "training-assessment-plan-v1",
    courseVersionId: version.id,
    resolvedTranscriptBuildId: build.id,
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
  const planIdentity = createHash("sha256").update(canonicaliseForHash(planBody)).digest("hex");

  let run = await prisma.trainingQuestionAiGenerationRun.findFirst({
    where: { clubId: club.id, courseVersionId: version.id, planIdentity },
    select: { id: true },
  });
  if (!run) {
    run = await prisma.trainingQuestionAiGenerationRun.create({
      data: {
        clubId: club.id,
        courseId: course.id,
        courseVersionId: version.id,
        pilotAuthorizationId: pilotAuthId,
        pilotAuthorizationFingerprint: pilotFingerprint,
        sourceVideoSha256: videoSha,
        resolvedTranscriptBuildId: build.id,
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
        assessmentPlanJson: canonicaliseForHash(planBody),
        planIdentity,
        shortfallReasonJson: JSON.stringify({
          schemaVersion: "shortfall-v1",
          targetCount: 3,
          generatedCount: 3,
          shortfall: 0,
          dedupDropCount: 0,
          dedupRulesVersion: "dedup-v1",
          dedupDecisions: [],
          reason: SYNTHETIC_MARKER,
        }),
      },
      select: { id: true },
    });
  }
  console.log("GENERATION_RUN_ID:", run.id);

  // Create a checkpoint on the version so the assembly dropdown is
  // populated (aligned to the plan's checkpoint timestamp).
  let checkpoint = await prisma.trainingCheckpoint.findFirst({
    where: { courseVersionId: version.id, atSecond: 115 },
    select: { id: true },
  });
  if (!checkpoint) {
    checkpoint = await prisma.trainingCheckpoint.create({
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
  }
  console.log("CHECKPOINT_ID:", checkpoint.id);

  // Three synthetic AI draft rows in different lifecycle states.
  const draftTemplates = [
    {
      state: "APPROVED_DRAFT",
      topic: "What is the escalation policy for a member dispute?",
      options: [
        { text: tag("Always notify a supervisor."), isCorrect: true },
        { text: tag("Ignore the member."), isCorrect: false },
      ],
      verifiedIndex: 0,
      sourceSegmentIds: [1],
    },
    {
      state: "REQUIRES_HUMAN_REVIEW",
      topic: "At what temperature should food be kept?",
      options: [
        { text: tag("Below 4 degrees."), isCorrect: true },
        { text: tag("Below 10 degrees."), isCorrect: false },
      ],
      verifiedIndex: null,
      sourceSegmentIds: [3],
    },
    {
      state: "REJECTED",
      topic: "Should the dishwasher ever run empty?",
      options: [
        { text: tag("Never."), isCorrect: true },
        { text: tag("Only on Sundays."), isCorrect: false },
      ],
      verifiedIndex: null,
      sourceSegmentIds: [2],
    },
  ];

  const draftIds = [];
  for (const t of draftTemplates) {
    const draftBody = {
      schemaVersion: "training-question-draft-v1",
      questionType: "SINGLE_CHOICE",
      questionText: t.topic,
      options: t.options,
      explanation: SYNTHETIC_MARKER,
      sourceSegmentIds: t.sourceSegmentIds,
    };
    const contentHash = createHash("sha256").update(canonicaliseForHash(draftBody)).digest("hex");

    let draft = await prisma.trainingQuestionAiDraft.findFirst({
      where: { clubId: club.id, courseVersionId: version.id, contentHash },
      select: { id: true, state: true },
    });
    if (!draft) {
      draft = await prisma.trainingQuestionAiDraft.create({
        data: {
          clubId: club.id,
          courseId: course.id,
          courseVersionId: version.id,
          generationRunId: run.id,
          draftJson: canonicaliseForHash(draftBody),
          contentHash,
          sourceVideoSha256: videoSha,
          resolvedTranscriptBuildId: build.id,
          groundingProjectionSha256: projectionSha,
          groundingProjectionId: projection.id,
          pilotAuthorizationId: pilotAuthId,
          pilotAuthorizationFingerprint: pilotFingerprint,
          state: t.state,
          stateChangedAt: now,
          recordVersion: 1,
          modelSelectedAnswerSnapshotJson: canonicaliseForHash(t.options),
          generatedAt: now,
        },
        select: { id: true, state: true },
      });
    }
    draftIds.push({ id: draft.id, state: draft.state });

    // Minimal validation row per draft.
    let validation = await prisma.trainingQuestionAiValidation.findFirst({
      where: { draftId: draft.id },
      select: { id: true },
    });
    if (!validation) {
      validation = await prisma.trainingQuestionAiValidation.create({
        data: {
          draftId: draft.id,
          clubId: club.id,
          draftContentHash: contentHash,
          validatorVersion: "4Z-SYN-1",
          validatorSource: "fixture",
          verdict: t.state === "REJECTED" ? "REJECTED" : t.state === "APPROVED_DRAFT" ? "GROUNDED" : "REQUIRES_HUMAN_VERIFICATION",
          stage: "VALIDATE",
          errorsJson: "[]",
          warningsJson: "[]",
          flagsJson: "[]",
          runAt: now,
          runByUserId: null,
          verifiedCorrectAnswerSnapshotJson: t.verifiedIndex !== null
            ? canonicaliseForHash({
                optionIndex: t.verifiedIndex,
                optionText: t.options[t.verifiedIndex].text,
                verifiedByUserId: reviewer.id,
                verifiedAt: now.toISOString(),
                draftContentHash: contentHash,
                validationId: "<self>",
              })
            : null,
        },
        select: { id: true },
      });
    }

    if (t.state === "APPROVED_DRAFT") {
      let review = await prisma.trainingQuestionAiReview.findFirst({
        where: { draftId: draft.id },
        select: { id: true },
      });
      if (!review) {
        await prisma.trainingQuestionAiReview.create({
          data: {
            draftId: draft.id,
            clubId: club.id,
            disposition: "APPROVED",
            reviewerNote: SYNTHETIC_MARKER,
            reviewedByUserId: reviewer.id,
            reviewedAt: now,
            draftContentHash: contentHash,
            validationId: validation.id,
          },
        });
      }
    }
  }
  console.log("DRAFT_IDS:", JSON.stringify(draftIds));

  console.log("\nFIXTURE COMPLETE");
  console.log("URL_PATH:", `/app/admin/people/safety-training/${course.id}/${version.id}/ai-workspace`);
  console.log("CLEANUP_HINT: delete rows where clubId = " + club.id + " AND label/code/text starts with '" + PREFIX + "'");
}

main()
  .catch((err) => { console.error("FATAL:", err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
