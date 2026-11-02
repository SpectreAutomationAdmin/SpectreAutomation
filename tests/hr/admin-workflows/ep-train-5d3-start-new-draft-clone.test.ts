// EP-TRAIN-5D-3 (2026-11-02) — Course Revision Checkpoint Integrity.
//
// The pre-5D-3 `startNewDraft` silently dropped three fields when
// cloning a PUBLISHED course version into a new DRAFT:
//   1. Every TrainingCheckpoint row (no checkpoints on the DRAFT).
//   2. TrainingQuestion.checkpointId (checkpoint-bound questions
//      became orphan final-assessment questions).
//   3. TrainingQuestion.questionType (every question defaulted to
//      SINGLE_CHOICE on the DRAFT regardless of source type).
//
// These tests pin the fixed semantics and must continue to pass to
// guarantee future revisions preserve the authored content.
//
// Note: the source course + v1 PUBLISHED fixture is seeded via direct
// Prisma writes.  The real publish path (`publishDraft`) requires
// `uploadTrainingVideo` which depends on ffprobe at runtime, and
// `acquireStorageKeyLock` which uses Postgres advisory locks — both
// are inappropriate for the SQLite-backed unit-test environment.
// `startNewDraft` itself IS the system-under-test and is called
// directly through the real service entry point.

import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { startNewDraft } from "@/lib/hr/training/courses";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture, type AdminHrFixture } from "./_helpers";

beforeAll(async () => { await resetDb(); await seedRbac(); });

/** Seed a PUBLISHED Course + v1 with: 2 checkpoints, 4 questions
 *  spanning all 3 question types + a null-checkpoint final-assessment
 *  question + each with answer options.  Direct Prisma writes avoid
 *  the video-upload + advisory-lock paths. */
async function seedPublishedV1(fx: AdminHrFixture): Promise<{
  courseId: string;
  v1Id: string;
  cp1Id: string;
  cp2Id: string;
  q1Id: string;
  q2Id: string;
  q3Id: string;
  q4Id: string;
}> {
  const course = await prisma.trainingCourse.create({
    data: {
      clubId: fx.club.id,
      code: `CLONE_FIX_5D3_${Math.floor(Math.random() * 90000 + 10000)}`,
      title: "Clone Fix 5D3",
      category: "Safety",
      description: "fixture",
    },
  });
  const v1 = await prisma.trainingCourseVersion.create({
    data: {
      courseId: course.id,
      version: 1,
      state: "PUBLISHED",
      title: "Revision Clone Fixture",
      description: "5D-3 fixture",
      passingScore: 80,
      retakesAllowed: true,
      requiresKnowledgeTest: true,
      required: true,
      appliesToAll: true,
      videoStorageKey: null, // skip advisory-lock path
      videoDurationSec: 60,
    },
  });
  // Flip the course's currentVersionId manually (publishDraft would
  // normally do this).
  await prisma.trainingCourse.update({
    where: { id: course.id },
    data: { currentVersionId: v1.id },
  });

  const cp1 = await prisma.trainingCheckpoint.create({
    data: {
      courseVersionId: v1.id,
      atSecond: 10, label: "First checkpoint",
      requiredToProceed: true, maxRetries: 2, displayOrder: 0,
    },
  });
  const cp2 = await prisma.trainingCheckpoint.create({
    data: {
      courseVersionId: v1.id,
      atSecond: 25, label: "Second checkpoint",
      requiredToProceed: false, maxRetries: 5, displayOrder: 1,
    },
  });

  const q1 = await prisma.trainingQuestion.create({
    data: {
      courseVersionId: v1.id,
      prompt: "What is the first rule?",
      displayOrder: 0,
      checkpointId: cp1.id,
      questionType: "SINGLE_CHOICE",
      options: {
        create: [
          { text: "Rule A", isCorrect: true, displayOrder: 0 },
          { text: "Rule B", isCorrect: false, displayOrder: 1 },
        ],
      },
    },
  });
  const q2 = await prisma.trainingQuestion.create({
    data: {
      courseVersionId: v1.id,
      prompt: "Which PPE items are required?",
      displayOrder: 1,
      checkpointId: cp2.id,
      questionType: "MULTI_ANSWER",
      options: {
        create: [
          { text: "Helmet", isCorrect: true, displayOrder: 0 },
          { text: "Gloves", isCorrect: true, displayOrder: 1 },
          { text: "Mittens", isCorrect: false, displayOrder: 2 },
        ],
      },
    },
  });
  const q3 = await prisma.trainingQuestion.create({
    data: {
      courseVersionId: v1.id,
      prompt: "Is safety first?",
      displayOrder: 2,
      checkpointId: cp1.id,
      questionType: "TRUE_FALSE",
      options: {
        create: [
          { text: "True", isCorrect: true, displayOrder: 0 },
          { text: "False", isCorrect: false, displayOrder: 1 },
        ],
      },
    },
  });
  const q4 = await prisma.trainingQuestion.create({
    data: {
      courseVersionId: v1.id,
      prompt: "What is the final-assessment question?",
      displayOrder: 3,
      checkpointId: null,
      questionType: "SINGLE_CHOICE",
      options: {
        create: [
          { text: "Answer A", isCorrect: true, displayOrder: 0 },
          { text: "Answer B", isCorrect: false, displayOrder: 1 },
        ],
      },
    },
  });

  return {
    courseId: course.id, v1Id: v1.id,
    cp1Id: cp1.id, cp2Id: cp2.id,
    q1Id: q1.id, q2Id: q2.id, q3Id: q3.id, q4Id: q4.id,
  };
}

describe("EP-TRAIN-5D-3 :: startNewDraft clones checkpoints + question metadata", () => {
  let fx: AdminHrFixture;

  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    fx = await makeAdminHrFixture();
  });

  it("§1 — clones every checkpoint onto the new DRAFT with configuration preserved", async () => {
    const { courseId, cp1Id, cp2Id } = await seedPublishedV1(fx);
    const { versionId: v2Id } = await startNewDraft(fx.clubAdmin, courseId);

    const v2Checkpoints = await prisma.trainingCheckpoint.findMany({
      where: { courseVersionId: v2Id },
      orderBy: { displayOrder: "asc" },
      select: { id: true, atSecond: true, label: true, requiredToProceed: true, maxRetries: true, displayOrder: true },
    });

    expect(v2Checkpoints).toHaveLength(2);
    expect(v2Checkpoints[0]).toMatchObject({ atSecond: 10, label: "First checkpoint", requiredToProceed: true, maxRetries: 2, displayOrder: 0 });
    expect(v2Checkpoints[1]).toMatchObject({ atSecond: 25, label: "Second checkpoint", requiredToProceed: false, maxRetries: 5, displayOrder: 1 });

    // All cloned checkpoints MUST be new ids distinct from the source.
    const v2CheckpointIds = new Set(v2Checkpoints.map((c) => c.id));
    expect(v2CheckpointIds.has(cp1Id)).toBe(false);
    expect(v2CheckpointIds.has(cp2Id)).toBe(false);
  });

  it("§2 — clones question.questionType for SINGLE_CHOICE, MULTI_ANSWER, TRUE_FALSE", async () => {
    const { courseId } = await seedPublishedV1(fx);
    const { versionId: v2Id } = await startNewDraft(fx.clubAdmin, courseId);

    const v2Questions = await prisma.trainingQuestion.findMany({
      where: { courseVersionId: v2Id },
      orderBy: { displayOrder: "asc" },
      select: { prompt: true, questionType: true, checkpointId: true },
    });

    expect(v2Questions.map((q) => q.questionType)).toEqual([
      "SINGLE_CHOICE", "MULTI_ANSWER", "TRUE_FALSE", "SINGLE_CHOICE",
    ]);
  });

  it("§3 — translates question.checkpointId to the cloned checkpoint id (no cross-version FK)", async () => {
    const { courseId, cp1Id, cp2Id, v1Id } = await seedPublishedV1(fx);
    const { versionId: v2Id } = await startNewDraft(fx.clubAdmin, courseId);

    const v2Checkpoints = await prisma.trainingCheckpoint.findMany({
      where: { courseVersionId: v2Id },
      orderBy: { atSecond: "asc" },
      select: { id: true, atSecond: true },
    });
    const draftCp1 = v2Checkpoints.find((c) => c.atSecond === 10)!;
    const draftCp2 = v2Checkpoints.find((c) => c.atSecond === 25)!;

    const v2Questions = await prisma.trainingQuestion.findMany({
      where: { courseVersionId: v2Id },
      orderBy: { displayOrder: "asc" },
      select: { prompt: true, checkpointId: true },
    });

    // q1 (CP1-bound) + q3 (CP1-bound) now point at the DRAFT's CP1.
    expect(v2Questions[0].checkpointId).toBe(draftCp1.id);
    expect(v2Questions[2].checkpointId).toBe(draftCp1.id);
    // q2 (CP2-bound) now points at the DRAFT's CP2.
    expect(v2Questions[1].checkpointId).toBe(draftCp2.id);
    // q4 (final assessment) stays null.
    expect(v2Questions[3].checkpointId).toBeNull();

    // CRITICAL: NO question on the DRAFT may reference a source
    // checkpoint id — that would be a cross-version FK leak.
    const checkpointIdSet = new Set(v2Checkpoints.map((c) => c.id));
    for (const q of v2Questions) {
      if (q.checkpointId !== null) {
        expect(checkpointIdSet.has(q.checkpointId)).toBe(true);
        expect(q.checkpointId).not.toBe(cp1Id);
        expect(q.checkpointId).not.toBe(cp2Id);
      }
    }

    // Source version MUST remain byte-identical.
    const v1Questions = await prisma.trainingQuestion.findMany({
      where: { courseVersionId: v1Id },
      orderBy: { displayOrder: "asc" },
      select: { checkpointId: true },
    });
    expect(v1Questions[0].checkpointId).toBe(cp1Id);
    expect(v1Questions[1].checkpointId).toBe(cp2Id);
    expect(v1Questions[2].checkpointId).toBe(cp1Id);
    expect(v1Questions[3].checkpointId).toBeNull();
  });

  it("§4 — clones answer options with isCorrect + displayOrder preserved", async () => {
    const { courseId } = await seedPublishedV1(fx);
    const { versionId: v2Id } = await startNewDraft(fx.clubAdmin, courseId);

    const q2 = await prisma.trainingQuestion.findFirst({
      where: { courseVersionId: v2Id, questionType: "MULTI_ANSWER" },
      include: { options: { orderBy: { displayOrder: "asc" } } },
    });
    expect(q2).toBeDefined();
    expect(q2!.options.map((o) => ({ text: o.text, isCorrect: o.isCorrect, displayOrder: o.displayOrder }))).toEqual([
      { text: "Helmet", isCorrect: true, displayOrder: 0 },
      { text: "Gloves", isCorrect: true, displayOrder: 1 },
      { text: "Mittens", isCorrect: false, displayOrder: 2 },
    ]);
  });

  it("§5 — editing the DRAFT does NOT mutate the published source version", async () => {
    const { courseId, cp1Id } = await seedPublishedV1(fx);
    const { versionId: v2Id } = await startNewDraft(fx.clubAdmin, courseId);

    // Delete one checkpoint on the DRAFT.
    const draftCheckpoints = await prisma.trainingCheckpoint.findMany({
      where: { courseVersionId: v2Id }, select: { id: true, atSecond: true },
    });
    const draftCp1 = draftCheckpoints.find((c) => c.atSecond === 10)!;
    await prisma.trainingCheckpoint.delete({ where: { id: draftCp1.id } });

    // Source v1's CP1 MUST still exist with its original configuration.
    const sourceCp1 = await prisma.trainingCheckpoint.findUnique({
      where: { id: cp1Id },
      select: { id: true, atSecond: true, label: true, requiredToProceed: true, maxRetries: true },
    });
    expect(sourceCp1).not.toBeNull();
    expect(sourceCp1).toMatchObject({ atSecond: 10, label: "First checkpoint", requiredToProceed: true, maxRetries: 2 });
  });

  it("§6 — applicability flags + core version fields still clone correctly (regression on 5D-3 edit)", async () => {
    const { courseId } = await seedPublishedV1(fx);
    const { versionId: v2Id } = await startNewDraft(fx.clubAdmin, courseId);

    const v2 = await prisma.trainingCourseVersion.findUnique({
      where: { id: v2Id },
      select: {
        title: true, description: true, passingScore: true,
        retakesAllowed: true, requiresKnowledgeTest: true,
        appliesToAll: true, appliesToDeptIds: true, appliesToPositionIds: true,
        required: true, state: true,
      },
    });
    expect(v2).toMatchObject({
      title: "Revision Clone Fixture",
      description: "5D-3 fixture",
      passingScore: 80,
      retakesAllowed: true,
      requiresKnowledgeTest: true,
      appliesToAll: true,
      required: true,
      state: "DRAFT",
    });
  });

  it("§7 — rerunning startNewDraft when a DRAFT already exists reuses it (idempotency preserved)", async () => {
    const { courseId } = await seedPublishedV1(fx);
    const first = await startNewDraft(fx.clubAdmin, courseId);
    const second = await startNewDraft(fx.clubAdmin, courseId);
    expect(second.versionId).toBe(first.versionId);
    expect(second.version).toBe(first.version);
    // And no duplicate checkpoint rows get created on the rerun.
    const cpCount = await prisma.trainingCheckpoint.count({ where: { courseVersionId: first.versionId } });
    expect(cpCount).toBe(2);
  });
});
