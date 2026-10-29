// EP-TRAIN-3 Slice 2 (2026-10-29) -- checkpoint service + question-type
// extension + publish-readiness regression tests.
//
// Uses the live SQLite dev DB (same pattern as other hr/training tests).
// Each test creates its own course + draft version + principal; no
// cross-test state.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "../src/lib/prisma";
import { createCourse, checkPublishReadiness, publishDraft } from "../src/lib/hr/training/courses";
import {
  createCheckpoint,
  updateCheckpoint,
  deleteCheckpoint,
  listCheckpointsForVersion,
  CHECKPOINT_MIN_SPACING_SECONDS,
} from "../src/lib/hr/training/checkpoints";
import { createQuestion, updateQuestion } from "../src/lib/hr/training/questions";
import { ConflictError, ValidationError } from "../src/lib/errors";
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

let fixtureCounter = 0;

async function seedPrincipalAndCourse(): Promise<{
  principal: Principal;
  clubId: string;
  courseId: string;
  versionId: string;
}> {
  const fx = await makeAdminHrFixture(`Nightingale HR Club ${++fixtureCounter}-${Math.floor(Math.random() * 10000)}`);
  const principal = fx.clubAdmin;
  const clubId = fx.club.id;
  const code = `TST${Math.floor(Math.random() * 90000 + 10000)}`;
  const { courseId, versionId } = await createCourse(principal, clubId, {
    code,
    title: "EP-TRAIN-3 Slice 2 Test Course",
    category: "Safety",
    description: "test",
  });
  // Attach a known video so duration + storageKey publish-readiness
  // checks pass.
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

describe("EP-TRAIN-3 Slice 2 :: checkpoints service", () => {
  it("creates a checkpoint with defaults", async () => {
    const { principal, versionId } = await seedPrincipalAndCourse();
    const { checkpointId } = await createCheckpoint(principal, versionId, { atSecond: 10 });
    const row = await prisma.trainingCheckpoint.findUnique({ where: { id: checkpointId } });
    expect(row).toBeTruthy();
    expect(row!.atSecond).toBe(10);
    expect(row!.requiredToProceed).toBe(true);
    expect(row!.maxRetries).toBe(3);
  });

  async function expectValidationIssue(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const first = (err as ValidationError).issues[0]?.message ?? "";
      expect(first).toMatch(pattern);
      return;
    }
    throw new Error("Expected ValidationError but promise resolved");
  }

  it("rejects a checkpoint within 1s of a sibling", async () => {
    const { principal, versionId } = await seedPrincipalAndCourse();
    await createCheckpoint(principal, versionId, { atSecond: 30 });
    await expectValidationIssue(
      createCheckpoint(principal, versionId, { atSecond: 30 }),
      /1s apart/,
    );
    await expectValidationIssue(
      createCheckpoint(principal, versionId, { atSecond: 30 + CHECKPOINT_MIN_SPACING_SECONDS - 1 }),
      /1s apart/,
    );
  });

  it("rejects a checkpoint beyond video duration", async () => {
    const { principal, versionId } = await seedPrincipalAndCourse();
    await expectValidationIssue(
      createCheckpoint(principal, versionId, { atSecond: 601 }),
      /exceeds the video length/,
    );
  });

  it("rejects a negative position", async () => {
    const { principal, versionId } = await seedPrincipalAndCourse();
    await expectValidationIssue(
      createCheckpoint(principal, versionId, { atSecond: -1 }),
      /non-negative/,
    );
  });

  it("updates position but re-validates 1s spacing", async () => {
    const { principal, versionId } = await seedPrincipalAndCourse();
    const a = await createCheckpoint(principal, versionId, { atSecond: 10 });
    const b = await createCheckpoint(principal, versionId, { atSecond: 20 });
    await updateCheckpoint(principal, b.checkpointId, { atSecond: 15 });
    const row = await prisma.trainingCheckpoint.findUnique({ where: { id: b.checkpointId } });
    expect(row!.atSecond).toBe(15);
    await expectValidationIssue(
      updateCheckpoint(principal, b.checkpointId, { atSecond: 10 }),
      /1s apart/,
    );
    expect(a).toBeTruthy();
  });

  it("deletes a checkpoint", async () => {
    const { principal, versionId } = await seedPrincipalAndCourse();
    const { checkpointId } = await createCheckpoint(principal, versionId, { atSecond: 50 });
    await deleteCheckpoint(principal, checkpointId);
    const row = await prisma.trainingCheckpoint.findUnique({ where: { id: checkpointId } });
    expect(row).toBeNull();
  });

  it("lists checkpoints with question counts in time order", async () => {
    const { principal, versionId } = await seedPrincipalAndCourse();
    const a = await createCheckpoint(principal, versionId, { atSecond: 90 });
    const b = await createCheckpoint(principal, versionId, { atSecond: 30 });
    await createQuestion(principal, versionId, {
      prompt: "Checkpoint Q1 prompt",
      questionType: "SINGLE_CHOICE",
      checkpointId: a.checkpointId,
      options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }],
    });
    const list = await listCheckpointsForVersion(versionId);
    expect(list.map((r) => r.id)).toEqual([b.checkpointId, a.checkpointId]);
    expect(list.find((r) => r.id === a.checkpointId)!.questionCount).toBe(1);
    expect(list.find((r) => r.id === b.checkpointId)!.questionCount).toBe(0);
  });

  it("refuses writes against PUBLISHED versions", async () => {
    const { principal, versionId } = await seedPrincipalAndCourse();
    const { checkpointId } = await createCheckpoint(principal, versionId, { atSecond: 60 });
    await createQuestion(principal, versionId, {
      prompt: "Checkpoint Q1 prompt",
      questionType: "SINGLE_CHOICE",
      checkpointId,
      options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }],
    });
    // Add a final-assessment question so requiresKnowledgeTest passes
    await createQuestion(principal, versionId, {
      prompt: "Final assessment prompt",
      questionType: "SINGLE_CHOICE",
      options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }],
    });
    await publishDraft(principal, versionId);
    await expect(
      createCheckpoint(principal, versionId, { atSecond: 120 }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      updateCheckpoint(principal, checkpointId, { atSecond: 70 }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      deleteCheckpoint(principal, checkpointId),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("EP-TRAIN-3 Slice 2 :: question type extension", () => {
  it("accepts MULTI_ANSWER with >=1 correct and >=1 incorrect", async () => {
    const { principal, versionId } = await seedPrincipalAndCourse();
    const { questionId } = await createQuestion(principal, versionId, {
      prompt: "Which of these are tools?",
      questionType: "MULTI_ANSWER",
      options: [
        { text: "Hammer", isCorrect: true },
        { text: "Wrench", isCorrect: true },
        { text: "Banana", isCorrect: false },
      ],
    });
    const q = await prisma.trainingQuestion.findUnique({
      where: { id: questionId },
      include: { options: true },
    });
    expect(q!.questionType).toBe("MULTI_ANSWER");
    expect(q!.options.filter((o) => o.isCorrect).length).toBe(2);
  });

  it("rejects MULTI_ANSWER with zero correct", async () => {
    const { principal, versionId } = await seedPrincipalAndCourse();
    await expect(
      createQuestion(principal, versionId, {
        prompt: "Zero correct?",
        questionType: "MULTI_ANSWER",
        options: [{ text: "A", isCorrect: false }, { text: "B", isCorrect: false }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects MULTI_ANSWER with all options correct", async () => {
    const { principal, versionId } = await seedPrincipalAndCourse();
    await expect(
      createQuestion(principal, versionId, {
        prompt: "All correct?",
        questionType: "MULTI_ANSWER",
        options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: true }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("accepts TRUE_FALSE with exactly two options", async () => {
    const { principal, versionId } = await seedPrincipalAndCourse();
    const { questionId } = await createQuestion(principal, versionId, {
      prompt: "The sky is blue",
      questionType: "TRUE_FALSE",
      options: [{ text: "True", isCorrect: true }, { text: "False", isCorrect: false }],
    });
    const q = await prisma.trainingQuestion.findUnique({ where: { id: questionId } });
    expect(q!.questionType).toBe("TRUE_FALSE");
  });

  it("rejects TRUE_FALSE with three options", async () => {
    const { principal, versionId } = await seedPrincipalAndCourse();
    await expect(
      createQuestion(principal, versionId, {
        prompt: "Three options?",
        questionType: "TRUE_FALSE",
        options: [
          { text: "True", isCorrect: true },
          { text: "False", isCorrect: false },
          { text: "Maybe", isCorrect: false },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("accepts a checkpointId that belongs to the same version", async () => {
    const { principal, versionId } = await seedPrincipalAndCourse();
    const { checkpointId } = await createCheckpoint(principal, versionId, { atSecond: 25 });
    const { questionId } = await createQuestion(principal, versionId, {
      prompt: "At the checkpoint",
      questionType: "SINGLE_CHOICE",
      checkpointId,
      options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }],
    });
    const q = await prisma.trainingQuestion.findUnique({ where: { id: questionId } });
    expect(q!.checkpointId).toBe(checkpointId);
  });

  it("rejects a checkpointId that belongs to a different version", async () => {
    const { principal, versionId } = await seedPrincipalAndCourse();
    const other = await seedPrincipalAndCourse();
    const { checkpointId: otherCpId } = await createCheckpoint(other.principal, other.versionId, { atSecond: 15 });
    await expect(
      createQuestion(principal, versionId, {
        prompt: "Cross-version checkpoint",
        questionType: "SINGLE_CHOICE",
        checkpointId: otherCpId,
        options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("legacy createQuestion without questionType defaults to SINGLE_CHOICE", async () => {
    const { principal, versionId } = await seedPrincipalAndCourse();
    const { questionId } = await createQuestion(principal, versionId, {
      prompt: "Legacy question",
      options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }],
    });
    const q = await prisma.trainingQuestion.findUnique({ where: { id: questionId } });
    expect(q!.questionType).toBe("SINGLE_CHOICE");
    expect(q!.checkpointId).toBeNull();
  });

  it("updateQuestion re-validates options against new type", async () => {
    const { principal, versionId } = await seedPrincipalAndCourse();
    const { questionId } = await createQuestion(principal, versionId, {
      prompt: "Will become multi",
      options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }],
    });
    await expect(
      updateQuestion(principal, questionId, {
        questionType: "MULTI_ANSWER",
        options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: true }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await updateQuestion(principal, questionId, {
      questionType: "MULTI_ANSWER",
      options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: true }, { text: "C", isCorrect: false }],
    });
    const q = await prisma.trainingQuestion.findUnique({ where: { id: questionId } });
    expect(q!.questionType).toBe("MULTI_ANSWER");
  });
});

describe("EP-TRAIN-3 Slice 2 :: publish readiness extensions", () => {
  async function seedWithQuestionAndVideo(): Promise<ReturnType<typeof seedPrincipalAndCourse>> {
    return seedPrincipalAndCourse();
  }

  it("passes when a draft has only a final assessment and no checkpoints (legacy path)", async () => {
    const { principal, versionId } = await seedWithQuestionAndVideo();
    await createQuestion(principal, versionId, {
      prompt: "Final assessment prompt",
      options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }],
    });
    const r = await checkPublishReadiness(versionId);
    expect(r.ready).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("fails when a checkpoint has zero active questions", async () => {
    const { principal, versionId } = await seedWithQuestionAndVideo();
    await createCheckpoint(principal, versionId, { atSecond: 60 });
    await createQuestion(principal, versionId, {
      prompt: "Final assessment prompt",
      options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }],
    });
    const r = await checkPublishReadiness(versionId);
    expect(r.ready).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/needs at least one active question/);
  });

  it("fails when final-assessment questions are missing but requiresKnowledgeTest=true", async () => {
    const { principal, versionId } = await seedWithQuestionAndVideo();
    const { checkpointId } = await createCheckpoint(principal, versionId, { atSecond: 60 });
    await createQuestion(principal, versionId, {
      prompt: "Checkpoint prompt",
      checkpointId,
      options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }],
    });
    const r = await checkPublishReadiness(versionId);
    expect(r.ready).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/Final assessment requires at least one active question/);
  });

  it("passes with a checkpoint + question + final-assessment question", async () => {
    const { principal, versionId } = await seedWithQuestionAndVideo();
    const { checkpointId } = await createCheckpoint(principal, versionId, { atSecond: 60, label: "C1" });
    await createQuestion(principal, versionId, {
      prompt: "Checkpoint prompt",
      checkpointId,
      options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }],
    });
    await createQuestion(principal, versionId, {
      prompt: "Final assessment prompt",
      options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }],
    });
    const r = await checkPublishReadiness(versionId);
    expect(r.ready).toBe(true);
  });

  it("Slice 2A: deleting a checkpoint with bound active questions is REFUSED by default", async () => {
    const { principal, versionId } = await seedWithQuestionAndVideo();
    const { checkpointId } = await createCheckpoint(principal, versionId, { atSecond: 60 });
    await createQuestion(principal, versionId, {
      prompt: "Checkpoint prompt",
      checkpointId,
      options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }],
    });
    await createQuestion(principal, versionId, {
      prompt: "Final assessment prompt",
      options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }],
    });
    await expect(deleteCheckpoint(principal, checkpointId)).rejects.toBeInstanceOf(ConflictError);
    // The checkpoint survives.
    const stillThere = await prisma.trainingCheckpoint.findUnique({ where: { id: checkpointId } });
    expect(stillThere).not.toBeNull();
  });

  it("Slice 2A: deleting a checkpoint with no active bound questions is allowed", async () => {
    const { principal, versionId } = await seedWithQuestionAndVideo();
    const { checkpointId } = await createCheckpoint(principal, versionId, { atSecond: 60 });
    await deleteCheckpoint(principal, checkpointId);
    const gone = await prisma.trainingCheckpoint.findUnique({ where: { id: checkpointId } });
    expect(gone).toBeNull();
  });

  it("Slice 2A: cascade-delete option removes bound questions AND the checkpoint, never silently promoting them", async () => {
    const { principal, versionId } = await seedWithQuestionAndVideo();
    const { checkpointId } = await createCheckpoint(principal, versionId, { atSecond: 60 });
    const { questionId } = await createQuestion(principal, versionId, {
      prompt: "Checkpoint prompt",
      checkpointId,
      options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }],
    });
    await createQuestion(principal, versionId, {
      prompt: "Final assessment prompt",
      options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }],
    });
    await deleteCheckpoint(principal, checkpointId, { deleteBoundQuestions: true });
    // The checkpoint is gone.
    const cpGone = await prisma.trainingCheckpoint.findUnique({ where: { id: checkpointId } });
    expect(cpGone).toBeNull();
    // The bound question is also gone (NOT silently promoted to final assessment).
    const qGone = await prisma.trainingQuestion.findUnique({ where: { id: questionId } });
    expect(qGone).toBeNull();
    // Final-assessment question count is unchanged (still 1).
    const finalQs = await prisma.trainingQuestion.count({ where: { courseVersionId: versionId, checkpointId: null } });
    expect(finalQs).toBe(1);
  });

  it("Slice 2A: manager can preserve a checkpoint question by moving it to the final assessment first", async () => {
    const { principal, versionId } = await seedWithQuestionAndVideo();
    const { checkpointId } = await createCheckpoint(principal, versionId, { atSecond: 60 });
    const { questionId } = await createQuestion(principal, versionId, {
      prompt: "Checkpoint prompt to preserve",
      checkpointId,
      options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }],
    });
    // Move the question to the final assessment by clearing its checkpointId.
    await prisma.trainingQuestion.update({
      where: { id: questionId },
      data: { checkpointId: null },
    });
    // Now the delete succeeds without the cascade option.
    await deleteCheckpoint(principal, checkpointId);
    const q = await prisma.trainingQuestion.findUnique({ where: { id: questionId } });
    expect(q).not.toBeNull();
    expect(q!.checkpointId).toBeNull();
  });
});
