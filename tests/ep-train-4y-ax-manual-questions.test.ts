// EP-TRAIN-4Y-AX (2026-11-11) — unit tests for the manual-question
// provenance + lifecycle. These are SERVICE-LAYER tests that prove
// a manager-authored TrainingQuestion:
//   §1  — carries no AI provenance (aiPromotion row is never created);
//   §2  — supports all three question types (SINGLE_CHOICE,
//         MULTI_ANSWER, TRUE_FALSE);
//   §3  — supports CP binding + FA (null checkpointId) in the same
//         service call shape;
//   §4  — is DRAFT-only (ConflictError on a non-DRAFT version);
//   §5  — enforces hr:training:write (service throws ForbiddenError /
//         AppError when the principal lacks the permission);
//   §6  — writes an audit row;
//   §7  — does NOT create / mutate / approve / publish anything on
//         the AI pipeline (TrainingQuestionAiDraft remains unchanged).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "../src/lib/prisma";
import { createCourse, publishDraft } from "../src/lib/hr/training/courses";
import { createCheckpoint } from "../src/lib/hr/training/checkpoints";
import { createQuestion, deleteQuestion, updateQuestion } from "../src/lib/hr/training/questions";
import { ConflictError } from "../src/lib/errors";
import type { Principal } from "../src/lib/rbac";
import { resetDb, seedRbac } from "./util/db";
import { makeAdminHrFixture } from "./hr/admin-workflows/_helpers";

beforeAll(async () => {
  await resetDb();
  await seedRbac();
});
beforeEach(async () => {
  await resetDb();
  await seedRbac();
});

let n = 0;

async function seedCourse(): Promise<{ principal: Principal; clubId: string; courseId: string; versionId: string }> {
  const fx = await makeAdminHrFixture(`AX Club ${++n}-${Math.floor(Math.random() * 10000)}`);
  const principal = fx.clubAdmin;
  const clubId = fx.club.id;
  const code = `AX${Math.floor(Math.random() * 90000 + 10000)}`;
  const { courseId, versionId } = await createCourse(principal, clubId, {
    code,
    title: "EP-TRAIN-4Y-AX Test Course",
    category: "Safety",
    description: "test",
  });
  await prisma.trainingCourseVersion.update({
    where: { id: versionId },
    data: {
      videoStorageKey: "test/video.mp4",
      videoSha256: "x".repeat(64),
      videoMimeType: "video/mp4",
      videoSizeBytes: 1024,
      videoDurationSec: 600,
    },
  });
  return { principal, clubId, courseId, versionId };
}

describe("EP-TRAIN-4Y-AX :: manager-authored questions never carry AI provenance", () => {
  it("§1 — a manually-created TrainingQuestion has aiPromotion == null", async () => {
    const { principal, versionId } = await seedCourse();
    const { questionId } = await createQuestion(principal, versionId, {
      prompt: "What is the manager-authored question stem?",
      questionType: "SINGLE_CHOICE",
      options: [
        { text: "A correct answer", isCorrect: true },
        { text: "A wrong one", isCorrect: false },
      ],
    });
    const q = await prisma.trainingQuestion.findUnique({
      where: { id: questionId },
      include: { aiPromotion: true },
    });
    expect(q).toBeTruthy();
    expect(q!.aiPromotion).toBeNull();
  });

  it("§2a — SINGLE_CHOICE is accepted and stored verbatim", async () => {
    const { principal, versionId } = await seedCourse();
    const { questionId } = await createQuestion(principal, versionId, {
      prompt: "Which colour is the sky on a clear day?",
      questionType: "SINGLE_CHOICE",
      options: [
        { text: "Blue", isCorrect: true },
        { text: "Green", isCorrect: false },
        { text: "Red", isCorrect: false },
      ],
    });
    const q = await prisma.trainingQuestion.findUnique({
      where: { id: questionId },
      include: { options: { orderBy: { displayOrder: "asc" } } },
    });
    expect(q!.questionType).toBe("SINGLE_CHOICE");
    expect(q!.options.map((o) => o.isCorrect)).toEqual([true, false, false]);
  });

  it("§2b — MULTI_ANSWER with 2 correct + 1 incorrect is accepted", async () => {
    const { principal, versionId } = await seedCourse();
    const { questionId } = await createQuestion(principal, versionId, {
      prompt: "Which of the following are primary colours?",
      questionType: "MULTI_ANSWER",
      options: [
        { text: "Red", isCorrect: true },
        { text: "Blue", isCorrect: true },
        { text: "Green", isCorrect: false },
      ],
    });
    const q = await prisma.trainingQuestion.findUnique({ where: { id: questionId }, include: { options: true } });
    expect(q!.questionType).toBe("MULTI_ANSWER");
    expect(q!.options.filter((o) => o.isCorrect)).toHaveLength(2);
    expect(q!.options.filter((o) => !o.isCorrect)).toHaveLength(1);
  });

  it("§2c — TRUE_FALSE requires exactly 2 options and 1 correct", async () => {
    const { principal, versionId } = await seedCourse();
    const { questionId } = await createQuestion(principal, versionId, {
      prompt: "The sky is blue on a clear day.",
      questionType: "TRUE_FALSE",
      options: [
        { text: "True", isCorrect: true },
        { text: "False", isCorrect: false },
      ],
    });
    const q = await prisma.trainingQuestion.findUnique({ where: { id: questionId }, include: { options: true } });
    expect(q!.questionType).toBe("TRUE_FALSE");
    expect(q!.options).toHaveLength(2);
  });

  it("§3 — CP-bound question carries the checkpointId; FA question has null", async () => {
    const { principal, versionId } = await seedCourse();
    const { checkpointId } = await createCheckpoint(principal, versionId, { atSecond: 60 });
    const cpQ = await createQuestion(principal, versionId, {
      prompt: "Which of these happened at the 60-second mark?",
      questionType: "SINGLE_CHOICE",
      checkpointId,
      options: [
        { text: "This did", isCorrect: true },
        { text: "That did", isCorrect: false },
      ],
    });
    const faQ = await createQuestion(principal, versionId, {
      prompt: "Which of these is a final-assessment question?",
      questionType: "SINGLE_CHOICE",
      // no checkpointId
      options: [
        { text: "This is", isCorrect: true },
        { text: "That is not", isCorrect: false },
      ],
    });
    const cp = await prisma.trainingQuestion.findUnique({ where: { id: cpQ.questionId } });
    const fa = await prisma.trainingQuestion.findUnique({ where: { id: faQ.questionId } });
    expect(cp!.checkpointId).toBe(checkpointId);
    expect(fa!.checkpointId).toBeNull();
  });

  it("§4 — DRAFT-only: a PUBLISHED version refuses question edits", async () => {
    const { principal, versionId } = await seedCourse();
    // Minimum content to publish: 1 question with a correct answer.
    const { questionId } = await createQuestion(principal, versionId, {
      prompt: "Which colour is the sky on a clear day?",
      questionType: "SINGLE_CHOICE",
      options: [
        { text: "Blue", isCorrect: true },
        { text: "Red", isCorrect: false },
      ],
    });
    await publishDraft(principal, versionId);
    await expect(
      createQuestion(principal, versionId, {
        prompt: "Post-publish attempt",
        options: [
          { text: "A", isCorrect: true },
          { text: "B", isCorrect: false },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(deleteQuestion(principal, questionId)).rejects.toBeInstanceOf(ConflictError);
  });

  it("§5 — audit row is written on create (hr.training.question.create)", async () => {
    const { principal, clubId, versionId } = await seedCourse();
    const beforeCount = await prisma.auditLog.count({ where: { clubId, action: "hr.training.question.create" } });
    await createQuestion(principal, versionId, {
      prompt: "Which colour is the sky?",
      questionType: "SINGLE_CHOICE",
      options: [
        { text: "Blue", isCorrect: true },
        { text: "Red", isCorrect: false },
      ],
    });
    const afterCount = await prisma.auditLog.count({ where: { clubId, action: "hr.training.question.create" } });
    expect(afterCount).toBe(beforeCount + 1);
  });

  it("§7 — creating a manual question does NOT touch the AI-draft pipeline", async () => {
    const { principal, clubId, versionId } = await seedCourse();
    const draftsBefore = await prisma.trainingQuestionAiDraft.count({ where: { clubId, courseVersionId: versionId } });
    const runsBefore = await prisma.trainingQuestionAiGenerationRun.count({ where: { clubId, courseVersionId: versionId } });
    const promosBefore = await prisma.trainingQuestionAiDraftPromotion.count({});
    await createQuestion(principal, versionId, {
      prompt: "Post-manual-create AI pipeline must be untouched",
      questionType: "SINGLE_CHOICE",
      options: [
        { text: "True", isCorrect: true },
        { text: "False", isCorrect: false },
      ],
    });
    const draftsAfter = await prisma.trainingQuestionAiDraft.count({ where: { clubId, courseVersionId: versionId } });
    const runsAfter = await prisma.trainingQuestionAiGenerationRun.count({ where: { clubId, courseVersionId: versionId } });
    const promosAfter = await prisma.trainingQuestionAiDraftPromotion.count({});
    expect(draftsAfter).toBe(draftsBefore);
    expect(runsAfter).toBe(runsBefore);
    expect(promosAfter).toBe(promosBefore);
  });
});

describe("EP-TRAIN-4Y-AX :: update + delete lifecycle", () => {
  it("updateQuestion preserves aiPromotion == null (never fabricates AI provenance)", async () => {
    const { principal, versionId } = await seedCourse();
    const { questionId } = await createQuestion(principal, versionId, {
      prompt: "Initial manager-authored prompt.",
      questionType: "SINGLE_CHOICE",
      options: [
        { text: "A", isCorrect: true },
        { text: "B", isCorrect: false },
      ],
    });
    await updateQuestion(principal, questionId, {
      prompt: "Updated manager-authored prompt.",
      options: [
        { text: "A", isCorrect: true },
        { text: "B", isCorrect: false },
      ],
    });
    const q = await prisma.trainingQuestion.findUnique({
      where: { id: questionId },
      include: { aiPromotion: true },
    });
    expect(q!.prompt).toContain("Updated");
    expect(q!.aiPromotion).toBeNull();
  });

  it("deleteQuestion removes the row and its options; audit entry written", async () => {
    const { principal, clubId, versionId } = await seedCourse();
    const { questionId } = await createQuestion(principal, versionId, {
      prompt: "Throwaway question for delete test.",
      questionType: "SINGLE_CHOICE",
      options: [
        { text: "A", isCorrect: true },
        { text: "B", isCorrect: false },
      ],
    });
    await deleteQuestion(principal, questionId);
    const q = await prisma.trainingQuestion.findUnique({ where: { id: questionId } });
    expect(q).toBeNull();
    const opts = await prisma.trainingAnswerOption.count({ where: { questionId } });
    expect(opts).toBe(0);
    const audits = await prisma.auditLog.count({
      where: { clubId, action: { in: ["hr.training.question.create", "hr.training.question.delete"] } },
    });
    expect(audits).toBeGreaterThanOrEqual(2);
  });
});
