// EP-TRAIN-6D-4T — publish-gate divergence detection (founder condition 5).
//
// Verifies that `checkPublishReadiness` refuses publication when:
//   - a promoted TrainingQuestion has been edited (prompt / options)
//     since promotion, OR
//   - the underlying AI draft has moved out of APPROVED_DRAFT, OR
//   - the draft's contentHash has changed since approval.

import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./util/db";
import {
  promoteApprovedDraft,
  promotedQuestionContentHash,
} from "@/lib/hr/training/ai-review/promotion-service";
import { checkPublishReadiness } from "@/lib/hr/training/courses";
import type { Principal } from "@/lib/rbac";
import { canonicalise, sha256Hex } from "@/lib/hr/training/ai-review/content-hash";

const CLUB_ID = "club_4t_pub";
const USER_ADMIN = "user_4t_pub_admin";

function superAdmin(): Principal {
  return {
    id: USER_ADMIN,
    name: "admin",
    email: "admin@t.local",
    status: "ACTIVE",
    memberships: [{ clubId: null, roleKey: "SUPER_ADMIN" }],
    activeClubId: CLUB_ID,
    memberId: null,
  };
}

const DRAFT_BODY = {
  questionType: "SINGLE_CHOICE",
  questionText: "What is the policy?",
  options: [
    { text: "Wrong", isCorrect: true },
    { text: "Right (reviewer picked)", isCorrect: false },
    { text: "Distractor", isCorrect: false },
  ],
  explanation: "e",
  sourceSegmentIds: [0, 1, 2],
};
const CONTENT_HASH = sha256Hex(canonicalise(DRAFT_BODY));
const VIDEO_SHA = "v".repeat(64);
const PASSAGES = [0, 1, 2].map((i) => ({
  passageId: i,
  sourceSegmentIds: [i],
  sourceStartSec: i * 5,
  sourceEndSec: (i + 1) * 5,
  text: `P${i}`,
  citationHandle: `C${i + 1}`,
  flags: { pendingReview: [], sourceOrgMismatch: [], uncertaintyWarning: null },
}));

async function seed() {
  const ts = Date.now() + Math.floor(Math.random() * 1_000_000);
  await prisma.club.upsert({
    where: { id: CLUB_ID },
    create: { id: CLUB_ID, name: CLUB_ID, slug: `s-${ts}`, primaryColor: "#111" },
    update: {},
  });
  await prisma.user.upsert({
    where: { id: USER_ADMIN },
    create: { id: USER_ADMIN, email: `a-${ts}@t.local`, name: "a", status: "ACTIVE", passwordHash: "x", role: "SUPER_ADMIN" },
    update: {},
  });
  const course = await prisma.trainingCourse.create({
    data: { clubId: CLUB_ID, code: `C-${ts}`, title: "T", category: "ORIENTATION" },
  });
  const version = await prisma.trainingCourseVersion.create({
    data: {
      courseId: course.id, version: 1, state: "DRAFT", title: "V1",
      videoSha256: VIDEO_SHA, videoStorageKey: "k/v1", videoDurationSec: 120,
    },
  });
  const buildId = `bld_${ts}`;
  await prisma.trainingTranscriptBuild.create({
    data: {
      id: buildId, clubId: CLUB_ID, sourceVideoSha256: VIDEO_SHA,
      resolvedTranscriptBuildId: buildId,
      transcriberName: "t", transcriberVersion: "1",
      transcriberModelName: "t", transcriberModelVersion: "1",
      transcriberConfigSha256: "a".repeat(64), producedAt: new Date(),
    },
  });
  for (let i = 0; i < 3; i++) {
    await prisma.trainingTranscriptSegment.create({
      data: {
        clubId: CLUB_ID, transcriptBuildId: buildId, segmentIndex: i,
        text: `Seg ${i}`, startSec: String(i * 5), endSec: String((i + 1) * 5),
      },
    });
  }
  const projSha = sha256Hex(canonicalise({
    schemaVersion: "training-grounding-v1",
    operation: "GENERATE_DRAFT_QUESTIONS",
    tenantId: CLUB_ID,
    courseVersionId: version.id,
    sourceVideoSha256: VIDEO_SHA,
    resolvedTranscriptBuildId: buildId,
    passages: PASSAGES,
    excludedPassages: [],
  }));
  const projection = await prisma.trainingGroundingProjection.create({
    data: {
      clubId: CLUB_ID, courseVersionId: version.id,
      sourceVideoSha256: VIDEO_SHA, resolvedTranscriptBuildId: buildId,
      sha256: projSha, passagesJson: JSON.stringify(PASSAGES),
      authoredAt: new Date(),
    },
  });
  const draft = await prisma.trainingQuestionAiDraft.create({
    data: {
      clubId: CLUB_ID, courseId: course.id, courseVersionId: version.id,
      draftJson: JSON.stringify(DRAFT_BODY),
      contentHash: CONTENT_HASH,
      sourceVideoSha256: VIDEO_SHA, resolvedTranscriptBuildId: buildId,
      groundingProjectionSha256: projSha, groundingProjectionId: projection.id,
      pilotAuthorizationId: "auth", pilotAuthorizationFingerprint: "fp",
      state: "APPROVED_DRAFT", recordVersion: 1, generatedAt: new Date(),
    },
  });
  const validation = await prisma.trainingQuestionAiValidation.create({
    data: {
      clubId: CLUB_ID, draftId: draft.id, draftContentHash: CONTENT_HASH,
      validatorVersion: "t", validatorSource: "integrated-pipeline",
      verdict: "REQUIRES_HUMAN_VERIFICATION", stage: "VALIDATE",
      errorsJson: "[]", warningsJson: "[]", flagsJson: "[]",
    },
  });
  // Patch snapshot with real validation id.
  const snapshot = {
    schemaVersion: "verified-correct-answer-snapshot-v1",
    optionIndex: 1,
    optionText: DRAFT_BODY.options[1].text,
    verifiedByUserId: USER_ADMIN,
    verifiedAt: new Date().toISOString(),
    draftContentHash: CONTENT_HASH,
    validationId: validation.id,
  };
  await prisma.trainingQuestionAiValidation.update({
    where: { id: validation.id },
    data: { verifiedCorrectAnswerSnapshotJson: JSON.stringify(snapshot) },
  });
  await prisma.trainingQuestionAiReview.create({
    data: {
      clubId: CLUB_ID, draftId: draft.id, draftContentHash: CONTENT_HASH,
      disposition: "APPROVED", reviewedByUserId: USER_ADMIN, validationId: validation.id,
    },
  });
  return { versionId: version.id, draftId: draft.id, validationId: validation.id };
}

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await prisma.$disconnect(); });

describe("EP-TRAIN-6D-4T — publish-gate divergence detection", () => {
  it("promoted question in pristine state: publish gate reports no promotion-related reasons", async () => {
    const s = await seed();
    await promoteApprovedDraft(superAdmin(), CLUB_ID, {
      draftId: s.draftId,
      destination: { kind: "FINAL_ASSESSMENT" },
      expectedDraftContentHash: CONTENT_HASH,
      expectedValidationId: s.validationId,
    });
    // The version has NO checkpoints + requiresKnowledgeTest=false by
    // default, so there might be legitimate non-promotion reasons that
    // keep it from being "ready". We only assert zero promotion
    // divergence reasons.
    const r = await checkPublishReadiness(s.versionId);
    const promotionReasons = r.reasons.filter(
      (s) => /edited since approval|no longer in APPROVED_DRAFT|draft body has changed/.test(s),
    );
    expect(promotionReasons).toEqual([]);
  });

  it("promoted question whose prompt is edited fails publish with divergence reason", async () => {
    const s = await seed();
    const r = await promoteApprovedDraft(superAdmin(), CLUB_ID, {
      draftId: s.draftId,
      destination: { kind: "FINAL_ASSESSMENT" },
      expectedDraftContentHash: CONTENT_HASH,
      expectedValidationId: s.validationId,
    });
    await prisma.trainingQuestion.update({
      where: { id: r.questionId },
      data: { prompt: "EDITED PROMPT" },
    });
    const gate = await checkPublishReadiness(s.versionId);
    expect(gate.ready).toBe(false);
    expect(gate.reasons.some((x) => /edited since approval/.test(x))).toBe(true);
  });

  it("promoted question whose option text is edited fails publish with divergence reason", async () => {
    const s = await seed();
    const r = await promoteApprovedDraft(superAdmin(), CLUB_ID, {
      draftId: s.draftId,
      destination: { kind: "FINAL_ASSESSMENT" },
      expectedDraftContentHash: CONTENT_HASH,
      expectedValidationId: s.validationId,
    });
    const opts = await prisma.trainingAnswerOption.findMany({
      where: { questionId: r.questionId },
      orderBy: { displayOrder: "asc" },
    });
    await prisma.trainingAnswerOption.update({
      where: { id: opts[0].id },
      data: { text: "EDITED OPTION" },
    });
    const gate = await checkPublishReadiness(s.versionId);
    expect(gate.reasons.some((x) => /edited since approval/.test(x))).toBe(true);
  });

  it("upstream draft state moved out of APPROVED_DRAFT fails publish", async () => {
    const s = await seed();
    await promoteApprovedDraft(superAdmin(), CLUB_ID, {
      draftId: s.draftId,
      destination: { kind: "FINAL_ASSESSMENT" },
      expectedDraftContentHash: CONTENT_HASH,
      expectedValidationId: s.validationId,
    });
    await prisma.trainingQuestionAiDraft.update({
      where: { id: s.draftId },
      data: { state: "ARCHIVED" },
    });
    const gate = await checkPublishReadiness(s.versionId);
    expect(gate.reasons.some((x) => /no longer in APPROVED_DRAFT/.test(x))).toBe(true);
  });

  it("upstream draft contentHash changed fails publish (immutable binding broken)", async () => {
    const s = await seed();
    await promoteApprovedDraft(superAdmin(), CLUB_ID, {
      draftId: s.draftId,
      destination: { kind: "FINAL_ASSESSMENT" },
      expectedDraftContentHash: CONTENT_HASH,
      expectedValidationId: s.validationId,
    });
    await prisma.trainingQuestionAiDraft.update({
      where: { id: s.draftId },
      data: { contentHash: "z".repeat(64) },
    });
    const gate = await checkPublishReadiness(s.versionId);
    expect(gate.reasons.some((x) => /draft body has changed/.test(x))).toBe(true);
  });

  it("manually-authored questions are NOT subject to divergence check (regression safety)", async () => {
    const s = await seed();
    // Insert a hand-authored question (no aiPromotion sidecar).
    const q = await prisma.trainingQuestion.create({
      data: {
        courseVersionId: s.versionId,
        prompt: "Hand-authored Q?",
        questionType: "SINGLE_CHOICE",
        displayOrder: 0,
        active: true,
      },
    });
    await prisma.trainingAnswerOption.create({
      data: { questionId: q.id, text: "A", isCorrect: true, displayOrder: 0 },
    });
    await prisma.trainingAnswerOption.create({
      data: { questionId: q.id, text: "B", isCorrect: false, displayOrder: 1 },
    });
    const gate = await checkPublishReadiness(s.versionId);
    const divergenceReasons = gate.reasons.filter((x) =>
      /edited since approval|no longer in APPROVED_DRAFT|draft body has changed/.test(x),
    );
    expect(divergenceReasons).toEqual([]);
  });
});
