// EP-TRAIN-6D-4T — promotion-service contract tests (SQLite).
//
// Directive §10 enumerates 18 scenarios. The ones that need true
// Postgres semantics (concurrent race, audit rollback) live in
// `scratchpad/ep-train-6d4t/integration-test.mjs`. The rest run here
// against the SQLite dev DB via Prisma.

import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./util/db";
import {
  promoteApprovedDraft,
  promotedQuestionContentHash,
  PromoteRejectedError,
} from "@/lib/hr/training/ai-review/promotion-service";
import type { Principal } from "@/lib/rbac";
import { canonicalise, sha256Hex } from "@/lib/hr/training/ai-review/content-hash";

const CLUB_ID = "club_4t_contract";
const CLUB_B = "club_4t_other";
const USER_ADMIN = "user_4t_admin";
const USER_OTHER = "user_4t_other";

function superAdmin(clubId = CLUB_ID): Principal {
  return {
    id: USER_ADMIN,
    name: "admin",
    email: "admin@t.local",
    status: "ACTIVE",
    memberships: [{ clubId: null, roleKey: "SUPER_ADMIN" }],
    activeClubId: clubId,
    memberId: null,
  };
}
function staff(clubId = CLUB_ID): Principal {
  return {
    id: USER_OTHER,
    name: "staff",
    email: "staff@t.local",
    status: "ACTIVE",
    memberships: [{ clubId, roleKey: "STAFF" }],
    activeClubId: clubId,
    memberId: null,
  };
}

const DRAFT_BODY = {
  questionType: "SINGLE_CHOICE",
  questionText: "What is the escalation policy?",
  options: [
    { text: "Confront the member directly", isCorrect: true }, // MODEL picked (wrong)
    { text: "Notify the manager on duty", isCorrect: false },  // VERIFIED (right)
    { text: "Call the police", isCorrect: false },
  ],
  explanation: "Per segment 2 the correct action is manager-on-duty.",
  sourceSegmentIds: [0, 1, 2],
};

const CONTENT_HASH = sha256Hex(canonicalise(DRAFT_BODY));
const VERIFIED_INDEX = 1;
const VIDEO_SHA = "v".repeat(64);

const PASSAGES = [0, 1, 2].map((i) => ({
  passageId: i,
  sourceSegmentIds: [i],
  sourceStartSec: i * 5,
  sourceEndSec: (i + 1) * 5,
  text: `Passage ${i}`,
  citationHandle: `C${i + 1}`,
  flags: { pendingReview: [], sourceOrgMismatch: [], uncertaintyWarning: null },
}));

function projectionSha(clubId: string, courseVersionId: string, buildId: string): string {
  return sha256Hex(
    canonicalise({
      schemaVersion: "training-grounding-v1",
      operation: "GENERATE_DRAFT_QUESTIONS",
      tenantId: clubId,
      courseVersionId,
      sourceVideoSha256: VIDEO_SHA,
      resolvedTranscriptBuildId: buildId,
      passages: PASSAGES,
      excludedPassages: [],
    }),
  );
}

interface SeedResult {
  draftId: string;
  validationId: string;
  versionId: string;
  checkpointId: string;
  projectionId: string;
  reviewId: string;
}

async function seedScenario(opts: {
  clubId?: string;
  state?: string;
  verifiedOptionIndex?: number;
  versionState?: "DRAFT" | "PUBLISHED" | "RETIRED";
  questionType?: string;
  noProjection?: boolean;
  unverified?: boolean;
} = {}): Promise<SeedResult> {
  const cid = opts.clubId ?? CLUB_ID;
  const ts = Date.now() + Math.floor(Math.random() * 1_000_000);
  // Club
  await prisma.club.upsert({
    where: { id: cid },
    create: { id: cid, name: cid, slug: `slug-${cid}-${ts}`, primaryColor: "#111" },
    update: {},
  });
  // User
  await prisma.user.upsert({
    where: { id: USER_ADMIN },
    create: { id: USER_ADMIN, email: `admin-${ts}@t.local`, name: "admin", status: "ACTIVE", passwordHash: "x", role: "SUPER_ADMIN" },
    update: {},
  });
  // Course + Version
  const course = await prisma.trainingCourse.create({
    data: { clubId: cid, code: `C-${ts}`, title: "T", category: "ORIENTATION" },
  });
  const version = await prisma.trainingCourseVersion.create({
    data: {
      courseId: course.id,
      version: 1,
      state: opts.versionState ?? "DRAFT",
      title: "V1",
      videoSha256: VIDEO_SHA,
      videoStorageKey: "k/v1",
      videoDurationSec: 120,
    },
  });
  // Checkpoint
  const checkpoint = await prisma.trainingCheckpoint.create({
    data: { courseVersionId: version.id, atSecond: 30 },
  });

  // Projection: must be created AFTER the build, with the real
  // server-recomputed canonical SHA-256.
  // We create the build first below, then the projection.

  // Build + segments (so evidence reader can resolve). Each seed
  // produces a unique build id so multi-club scenarios don't collide.
  const buildId = `bld_${ts}`;
  await prisma.trainingTranscriptBuild.create({
    data: {
      id: buildId,
      clubId: cid,
      sourceVideoSha256: VIDEO_SHA,
      resolvedTranscriptBuildId: buildId,
      transcriberName: "test",
      transcriberVersion: "1",
      transcriberModelName: "test",
      transcriberModelVersion: "1",
      transcriberConfigSha256: "a".repeat(64),
      producedAt: new Date(),
    },
  });
  for (let i = 0; i < 3; i++) {
    await prisma.trainingTranscriptSegment.create({
      data: {
        clubId: cid,
        transcriptBuildId: buildId,
        segmentIndex: i,
        text: `Segment ${i} text`,
        startSec: String(i * 5),
        endSec: String((i + 1) * 5),
      },
    });
  }

  // Projection: server-recomputed canonical SHA-256 + real passages
  // referencing the three segments so the 4M reader resolves them.
  let projection = null;
  const realProjectionSha = projectionSha(cid, version.id, buildId);
  if (!opts.noProjection) {
    projection = await prisma.trainingGroundingProjection.create({
      data: {
        clubId: cid,
        courseVersionId: version.id,
        sourceVideoSha256: VIDEO_SHA,
        resolvedTranscriptBuildId: buildId,
        sha256: realProjectionSha,
        passagesJson: JSON.stringify(PASSAGES),
        authoredAt: new Date(),
      },
    });
  }

  const draft = await prisma.trainingQuestionAiDraft.create({
    data: {
      clubId: cid,
      courseId: course.id,
      courseVersionId: version.id,
      draftJson: JSON.stringify({
        ...DRAFT_BODY,
        questionType: opts.questionType ?? DRAFT_BODY.questionType,
      }),
      contentHash: CONTENT_HASH,
      sourceVideoSha256: VIDEO_SHA,
      resolvedTranscriptBuildId: buildId,
      groundingProjectionSha256: opts.noProjection ? "fixture-x" : realProjectionSha,
      groundingProjectionId: opts.noProjection ? null : projection!.id,
      pilotAuthorizationId: "auth",
      pilotAuthorizationFingerprint: "fp",
      state: opts.state ?? "APPROVED_DRAFT",
      recordVersion: 1,
      generatedAt: new Date(),
    },
  });

  const validation = await prisma.trainingQuestionAiValidation.create({
    data: {
      clubId: cid,
      draftId: draft.id,
      draftContentHash: CONTENT_HASH,
      validatorVersion: "t",
      validatorSource: "integrated-pipeline",
      verdict: "REQUIRES_HUMAN_VERIFICATION",
      stage: "VALIDATE",
      errorsJson: "[]",
      warningsJson: "[]",
      flagsJson: "[]",
      verifiedCorrectAnswerSnapshotJson: opts.unverified ? null : JSON.stringify({
        schemaVersion: "verified-correct-answer-snapshot-v1",
        optionIndex: opts.verifiedOptionIndex ?? VERIFIED_INDEX,
        optionText: DRAFT_BODY.options[opts.verifiedOptionIndex ?? VERIFIED_INDEX].text,
        verifiedByUserId: USER_ADMIN,
        verifiedAt: new Date().toISOString(),
        draftContentHash: CONTENT_HASH,
        validationId: "placeholder",
      }),
    },
  });

  // Patch validationId into snapshot now that we have the real id.
  if (!opts.unverified) {
    const snapshot = JSON.parse(validation.verifiedCorrectAnswerSnapshotJson!) as Record<string, unknown>;
    snapshot.validationId = validation.id;
    await prisma.trainingQuestionAiValidation.update({
      where: { id: validation.id },
      data: { verifiedCorrectAnswerSnapshotJson: JSON.stringify(snapshot) },
    });
  }

  // Review row (records the reviewer identity).
  const review = await prisma.trainingQuestionAiReview.create({
    data: {
      clubId: cid,
      draftId: draft.id,
      draftContentHash: CONTENT_HASH,
      disposition: opts.unverified ? "COMMENTED" : "APPROVED",
      reviewedByUserId: USER_ADMIN,
      validationId: validation.id,
    },
  });

  return {
    draftId: draft.id,
    validationId: validation.id,
    versionId: version.id,
    checkpointId: checkpoint.id,
    projectionId: projection?.id ?? "",
    reviewId: review.id,
  };
}

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("EP-TRAIN-6D-4T — promotion-service contract", () => {
  it("T1 valid CHECKPOINT promotion creates question + options + sidecar", async () => {
    const s = await seedScenario();
    const r = await promoteApprovedDraft(superAdmin(), CLUB_ID, {
      draftId: s.draftId,
      destination: { kind: "CHECKPOINT", checkpointId: s.checkpointId },
      expectedDraftContentHash: CONTENT_HASH,
      expectedValidationId: s.validationId,
    });
    expect(r.ok).toBe(true);
    expect(r.replay).toBe(false);
    expect(r.destinationKind).toBe("CHECKPOINT");
    expect(r.checkpointId).toBe(s.checkpointId);
    const q = await prisma.trainingQuestion.findUnique({
      where: { id: r.questionId },
      include: { options: { orderBy: { displayOrder: "asc" } }, aiPromotion: true },
    });
    expect(q?.checkpointId).toBe(s.checkpointId);
    expect(q?.options.length).toBe(3);
    expect(q?.aiPromotion?.draftId).toBe(s.draftId);
    // HUMAN-VERIFIED (index 1) is correct, not the model's pick (index 0).
    expect(q?.options[0].isCorrect).toBe(false);
    expect(q?.options[1].isCorrect).toBe(true);
    expect(q?.options[2].isCorrect).toBe(false);
  });

  it("T2 valid FINAL_ASSESSMENT promotion (checkpointId null)", async () => {
    const s = await seedScenario();
    const r = await promoteApprovedDraft(superAdmin(), CLUB_ID, {
      draftId: s.draftId,
      destination: { kind: "FINAL_ASSESSMENT" },
      expectedDraftContentHash: CONTENT_HASH,
      expectedValidationId: s.validationId,
    });
    expect(r.destinationKind).toBe("FINAL_ASSESSMENT");
    expect(r.checkpointId).toBeNull();
    const q = await prisma.trainingQuestion.findUnique({ where: { id: r.questionId } });
    expect(q?.checkpointId).toBeNull();
  });

  it("T3 human-verified answer propagates to TrainingAnswerOption.isCorrect — model pick is ignored", async () => {
    const s = await seedScenario({ verifiedOptionIndex: 2 });
    const r = await promoteApprovedDraft(superAdmin(), CLUB_ID, {
      draftId: s.draftId,
      destination: { kind: "FINAL_ASSESSMENT" },
      expectedDraftContentHash: CONTENT_HASH,
      expectedValidationId: s.validationId,
    });
    const q = await prisma.trainingQuestion.findUnique({
      where: { id: r.questionId },
      include: { options: { orderBy: { displayOrder: "asc" } } },
    });
    expect(q?.options[0].isCorrect).toBe(false);
    expect(q?.options[1].isCorrect).toBe(false);
    expect(q?.options[2].isCorrect).toBe(true);
  });

  it("T4 cross-tenant refusal — 404 same-shape", async () => {
    const s = await seedScenario({ clubId: CLUB_B });
    await expect(
      promoteApprovedDraft(superAdmin(), CLUB_ID, {
        draftId: s.draftId,
        destination: { kind: "FINAL_ASSESSMENT" },
        expectedDraftContentHash: CONTENT_HASH,
        expectedValidationId: s.validationId,
      }),
    ).rejects.toMatchObject({ rejectionCode: "DRAFT_NOT_FOUND", httpStatus: 404 });
  });

  it("T5 cross-course checkpoint refusal", async () => {
    const s1 = await seedScenario();
    const s2 = await seedScenario();
    await expect(
      promoteApprovedDraft(superAdmin(), CLUB_ID, {
        draftId: s1.draftId,
        destination: { kind: "CHECKPOINT", checkpointId: s2.checkpointId },
        expectedDraftContentHash: CONTENT_HASH,
        expectedValidationId: s1.validationId,
      }),
    ).rejects.toMatchObject({ rejectionCode: "CHECKPOINT_CROSS_COURSE" });
  });

  it("T6 historical candidate (no groundingProjectionId) refused", async () => {
    const s = await seedScenario({ noProjection: true });
    await expect(
      promoteApprovedDraft(superAdmin(), CLUB_ID, {
        draftId: s.draftId,
        destination: { kind: "FINAL_ASSESSMENT" },
        expectedDraftContentHash: CONTENT_HASH,
        expectedValidationId: s.validationId,
      }),
    ).rejects.toMatchObject({ rejectionCode: "EVIDENCE_HISTORICAL_UNAVAILABLE" });
  });

  it("T7 rejected candidate refusal", async () => {
    const s = await seedScenario({ state: "REJECTED" });
    await expect(
      promoteApprovedDraft(superAdmin(), CLUB_ID, {
        draftId: s.draftId,
        destination: { kind: "FINAL_ASSESSMENT" },
        expectedDraftContentHash: CONTENT_HASH,
        expectedValidationId: s.validationId,
      }),
    ).rejects.toMatchObject({ rejectionCode: "DRAFT_NOT_APPROVED" });
  });

  it("T8 missing verified-answer snapshot on APPROVED_DRAFT refused", async () => {
    // State=APPROVED_DRAFT + snapshot=null is a declared-approved-but-
    // unverified integrity inconsistency. The 4N reader classifies
    // this as integrity-warning, the promotion service maps it to
    // VERIFIED_ANSWER_INTEGRITY_FAIL — either way the directive's
    // intent ("do not promote unverified candidates") is satisfied.
    const s = await seedScenario({ unverified: true });
    await expect(
      promoteApprovedDraft(superAdmin(), CLUB_ID, {
        draftId: s.draftId,
        destination: { kind: "FINAL_ASSESSMENT" },
        expectedDraftContentHash: CONTENT_HASH,
        expectedValidationId: s.validationId,
      }),
    ).rejects.toMatchObject({
      rejectionCode: expect.stringMatching(/VERIFIED_ANSWER_(MISSING|INTEGRITY_FAIL)/),
    });
  });

  it("T9 stale content hash refused", async () => {
    const s = await seedScenario();
    await expect(
      promoteApprovedDraft(superAdmin(), CLUB_ID, {
        draftId: s.draftId,
        destination: { kind: "FINAL_ASSESSMENT" },
        expectedDraftContentHash: "0".repeat(64),
        expectedValidationId: s.validationId,
      }),
    ).rejects.toMatchObject({ rejectionCode: "CONTENT_HASH_MISMATCH" });
  });

  it("T10 wrong validationId refused (VALIDATION_MISMATCH)", async () => {
    const s = await seedScenario();
    await expect(
      promoteApprovedDraft(superAdmin(), CLUB_ID, {
        draftId: s.draftId,
        destination: { kind: "FINAL_ASSESSMENT" },
        expectedDraftContentHash: CONTENT_HASH,
        expectedValidationId: "bogus",
      }),
    ).rejects.toMatchObject({ rejectionCode: "VALIDATION_MISMATCH" });
  });

  it("T11 invalid checkpointId refused", async () => {
    const s = await seedScenario();
    await expect(
      promoteApprovedDraft(superAdmin(), CLUB_ID, {
        draftId: s.draftId,
        destination: { kind: "CHECKPOINT", checkpointId: "does-not-exist" },
        expectedDraftContentHash: CONTENT_HASH,
        expectedValidationId: s.validationId,
      }),
    ).rejects.toMatchObject({ rejectionCode: "CHECKPOINT_NOT_FOUND" });
  });

  it("T12 published course-version refused (not DRAFT)", async () => {
    const s = await seedScenario({ versionState: "PUBLISHED" });
    await expect(
      promoteApprovedDraft(superAdmin(), CLUB_ID, {
        draftId: s.draftId,
        destination: { kind: "FINAL_ASSESSMENT" },
        expectedDraftContentHash: CONTENT_HASH,
        expectedValidationId: s.validationId,
      }),
    ).rejects.toMatchObject({ rejectionCode: "COURSE_VERSION_NOT_DRAFT" });
  });

  it("T13 duplicate promotion (same destination) returns replay", async () => {
    const s = await seedScenario();
    const r1 = await promoteApprovedDraft(superAdmin(), CLUB_ID, {
      draftId: s.draftId,
      destination: { kind: "FINAL_ASSESSMENT" },
      expectedDraftContentHash: CONTENT_HASH,
      expectedValidationId: s.validationId,
    });
    const r2 = await promoteApprovedDraft(superAdmin(), CLUB_ID, {
      draftId: s.draftId,
      destination: { kind: "FINAL_ASSESSMENT" },
      expectedDraftContentHash: CONTENT_HASH,
      expectedValidationId: s.validationId,
    });
    expect(r2.replay).toBe(true);
    expect(r2.questionId).toBe(r1.questionId);
    const count = await prisma.trainingQuestion.count({ where: { courseVersionId: s.versionId } });
    expect(count).toBe(1);
  });

  it("T14 conflicting destination refused (ALREADY_PROMOTED_DIFFERENT_DESTINATION)", async () => {
    const s = await seedScenario();
    await promoteApprovedDraft(superAdmin(), CLUB_ID, {
      draftId: s.draftId,
      destination: { kind: "FINAL_ASSESSMENT" },
      expectedDraftContentHash: CONTENT_HASH,
      expectedValidationId: s.validationId,
    });
    await expect(
      promoteApprovedDraft(superAdmin(), CLUB_ID, {
        draftId: s.draftId,
        destination: { kind: "CHECKPOINT", checkpointId: s.checkpointId },
        expectedDraftContentHash: CONTENT_HASH,
        expectedValidationId: s.validationId,
      }),
    ).rejects.toMatchObject({ rejectionCode: "ALREADY_PROMOTED_DIFFERENT_DESTINATION" });
  });

  it("T15 MULTI_ANSWER refused (QUESTION_TYPE_UNSUPPORTED)", async () => {
    const s = await seedScenario({ questionType: "MULTI_ANSWER" });
    await expect(
      promoteApprovedDraft(superAdmin(), CLUB_ID, {
        draftId: s.draftId,
        destination: { kind: "FINAL_ASSESSMENT" },
        expectedDraftContentHash: CONTENT_HASH,
        expectedValidationId: s.validationId,
      }),
    ).rejects.toMatchObject({ rejectionCode: "QUESTION_TYPE_UNSUPPORTED" });
  });

  it("T16 unauthenticated principal refused", async () => {
    await expect(
      promoteApprovedDraft(null, CLUB_ID, {
        draftId: "x",
        destination: { kind: "FINAL_ASSESSMENT" },
        expectedDraftContentHash: CONTENT_HASH,
        expectedValidationId: "y",
      }),
    ).rejects.toThrow(/Authentication/i);
  });

  it("T17 STAFF (no hr:training:write) refused", async () => {
    const s = await seedScenario();
    await expect(
      promoteApprovedDraft(staff(), CLUB_ID, {
        draftId: s.draftId,
        destination: { kind: "FINAL_ASSESSMENT" },
        expectedDraftContentHash: CONTENT_HASH,
        expectedValidationId: s.validationId,
      }),
    ).rejects.toThrow(/write/);
  });

  it("T18 divergence-detection hash is stable across equivalent inputs", () => {
    const options = [
      { text: "A", isCorrect: false },
      { text: "B", isCorrect: true },
    ];
    const h1 = promotedQuestionContentHash({
      prompt: "Q?", questionType: "SINGLE_CHOICE", checkpointId: null, options,
    });
    const h2 = promotedQuestionContentHash({
      prompt: "Q?", questionType: "SINGLE_CHOICE", checkpointId: null, options,
    });
    expect(h1).toBe(h2);
    // Prompt edit → different hash.
    const h3 = promotedQuestionContentHash({
      prompt: "Q edited?", questionType: "SINGLE_CHOICE", checkpointId: null, options,
    });
    expect(h3).not.toBe(h1);
    // Option isCorrect flip → different hash.
    const h4 = promotedQuestionContentHash({
      prompt: "Q?", questionType: "SINGLE_CHOICE", checkpointId: null,
      options: [
        { text: "A", isCorrect: true },
        { text: "B", isCorrect: false },
      ],
    });
    expect(h4).not.toBe(h1);
  });
});
