// HR-2C (2026-08-20) — Training quiz question authoring service.
//
// Every write operates on a DRAFT version — published versions are
// frozen (§3, §8). Answer keys never leave the server (§27) — the
// employee-facing course payload is projected through the read helper
// in `employee.ts` which strips `isCorrect`.

import { prisma } from "../../prisma";
import { audit } from "../../audit";
import { requirePermission, type Principal } from "../../rbac";
import { assertPostingAllowed, withPostingGuard } from "../../posting-guard";
import { ConflictError, NotFoundError, ValidationError } from "../../errors";

const QUESTION_ENTITY = "TrainingQuestion";
const OPTION_ENTITY = "TrainingAnswerOption";

// EP-TRAIN-3 Slice 2 (2026-10-29) -- supported question types.
// SINGLE_CHOICE preserves every existing row's semantics.
export const TRAINING_QUESTION_TYPES = [
  "SINGLE_CHOICE",
  "MULTI_ANSWER",
  "TRUE_FALSE",
] as const;
export type TrainingQuestionType = (typeof TRAINING_QUESTION_TYPES)[number];

function normaliseQuestionType(input: string | undefined | null): TrainingQuestionType {
  if (input === undefined || input === null || input === "") return "SINGLE_CHOICE";
  if (!(TRAINING_QUESTION_TYPES as readonly string[]).includes(input)) {
    throw new ValidationError([{
      path: "questionType",
      message: `questionType must be one of ${TRAINING_QUESTION_TYPES.join(", ")}.`,
    }]);
  }
  return input as TrainingQuestionType;
}

function validateOptionsByType(
  questionType: TrainingQuestionType,
  options: Array<{ text: string; isCorrect: boolean }>,
): void {
  if (options.length < 2) {
    throw new ValidationError([{ path: "options", message: "At least 2 answer options are required." }]);
  }
  const correctCount = options.filter((o) => o.isCorrect).length;
  if (questionType === "SINGLE_CHOICE") {
    if (correctCount !== 1) {
      throw new ValidationError([{ path: "options", message: "Exactly one option must be marked correct." }]);
    }
  } else if (questionType === "MULTI_ANSWER") {
    if (correctCount < 1) {
      throw new ValidationError([{ path: "options", message: "At least one option must be marked correct." }]);
    }
    if (correctCount === options.length) {
      throw new ValidationError([{ path: "options", message: "At least one option must be marked incorrect." }]);
    }
  } else {
    // TRUE_FALSE
    if (options.length !== 2) {
      throw new ValidationError([{ path: "options", message: "True / False questions must have exactly 2 options." }]);
    }
    if (correctCount !== 1) {
      throw new ValidationError([{ path: "options", message: "Exactly one option must be marked correct." }]);
    }
  }
  for (const [i, o] of options.entries()) {
    if (!o.text || o.text.trim().length === 0) {
      throw new ValidationError([{ path: `options[${i}].text`, message: "Option text required." }]);
    }
    if (o.text.trim().length > 300) {
      throw new ValidationError([{ path: `options[${i}].text`, message: "Option text must be at most 300 characters." }]);
    }
  }
}

async function loadDraftVersion(versionId: string) {
  const v = await prisma.trainingCourseVersion.findUnique({
    where: { id: versionId },
    include: { course: { select: { clubId: true } } },
  });
  if (!v) throw new NotFoundError("TrainingCourseVersion", versionId);
  if (v.state !== "DRAFT") {
    throw new ConflictError(
      `Cannot modify questions on a ${v.state} version. Open a new draft first.`,
    );
  }
  return v;
}

async function assertCheckpointBelongsToVersion(
  checkpointId: string,
  versionId: string,
): Promise<void> {
  const cp = await prisma.trainingCheckpoint.findUnique({
    where: { id: checkpointId },
    select: { courseVersionId: true },
  });
  if (!cp) throw new NotFoundError("TrainingCheckpoint", checkpointId);
  if (cp.courseVersionId !== versionId) {
    throw new ValidationError([{
      path: "checkpointId",
      message: "Checkpoint does not belong to this course version.",
    }]);
  }
}

// ---------------------------------------------------------------------------
// Create question
// ---------------------------------------------------------------------------

export interface CreateQuestionInput {
  prompt: string;
  options: Array<{ text: string; isCorrect: boolean }>;
  /** EP-TRAIN-3 Slice 2: SINGLE_CHOICE | MULTI_ANSWER | TRUE_FALSE.
   *  Omitted = SINGLE_CHOICE (preserves existing caller behaviour). */
  questionType?: TrainingQuestionType;
  /** EP-TRAIN-3 Slice 2: optional checkpoint binding. null / omitted =
   *  final-assessment question (preserves existing caller behaviour). */
  checkpointId?: string | null;
}

export async function createQuestion(
  principal: Principal,
  versionId: string,
  input: CreateQuestionInput,
): Promise<{ questionId: string }> {
  const v = await loadDraftVersion(versionId);
  requirePermission(principal, v.course.clubId, "hr:training:write");
  const prompt = input.prompt.trim();
  if (prompt.length < 3 || prompt.length > 500) {
    throw new ValidationError([{ path: "prompt", message: "Prompt must be 3-500 characters." }]);
  }
  const questionType = normaliseQuestionType(input.questionType);
  validateOptionsByType(questionType, input.options);
  const checkpointId = input.checkpointId ?? null;
  if (checkpointId) {
    await assertCheckpointBelongsToVersion(checkpointId, versionId);
  }
  const maxOrder = await prisma.trainingQuestion.aggregate({
    where: { courseVersionId: versionId, checkpointId },
    _max: { displayOrder: true },
  });
  const nextOrder = (maxOrder._max.displayOrder ?? -1) + 1;

  const result = await prisma.$transaction(async (tx) => {
    // M1d (2026-10-27) -- posting-guard INSIDE the tx so FOR UPDATE on ClubSubscription serializes against suspension.
    await assertPostingAllowed(
      principal, v.course.clubId,
      "hr.training.question.create", QUESTION_ENTITY, versionId, { tx },
    );
    const q = await tx.trainingQuestion.create({
      data: {
        courseVersionId: versionId,
        prompt,
        displayOrder: nextOrder,
        active: true,
        questionType,
        checkpointId,
      },
    });
    for (const [i, o] of input.options.entries()) {
      await tx.trainingAnswerOption.create({
        data: {
          questionId: q.id,
          text: o.text.trim(),
          isCorrect: o.isCorrect,
          displayOrder: i,
        },
      });
    }
    return { questionId: q.id };
  });
  await audit(principal, {
    action: "hr.training.question.create",
    entityType: QUESTION_ENTITY,
    entityId: result.questionId,
    clubId: v.course.clubId,
    after: {
      versionId,
      promptTail: prompt.slice(-40),
      optionCount: input.options.length,
      questionType,
      checkpointId,
    },
  });
  return result;
}

// ---------------------------------------------------------------------------
// Update question (prompt + options + correct-answer flip)
// ---------------------------------------------------------------------------

export interface UpdateQuestionInput {
  prompt?: string;
  options?: Array<{
    /** Optional id — if present + on the question, updates that row. */
    id?: string;
    text: string;
    isCorrect: boolean;
  }>;
  active?: boolean;
  /** EP-TRAIN-3 Slice 2: change question type (also re-validates options
   *  against the new type's correct-count rule). */
  questionType?: TrainingQuestionType;
}

export async function updateQuestion(
  principal: Principal,
  questionId: string,
  input: UpdateQuestionInput,
): Promise<void> {
  const q = await prisma.trainingQuestion.findUnique({
    where: { id: questionId },
    include: {
      courseVersion: { include: { course: { select: { clubId: true } } } },
      options: true,
    },
  });
  if (!q) throw new NotFoundError(QUESTION_ENTITY, questionId);
  const clubId = q.courseVersion.course.clubId;
  if (q.courseVersion.state !== "DRAFT") {
    throw new ConflictError(`Cannot modify a ${q.courseVersion.state} version's questions.`);
  }
  requirePermission(principal, clubId, "hr:training:write");
  const questionData: { prompt?: string; active?: boolean; questionType?: TrainingQuestionType } = {};
  if (input.prompt !== undefined) {
    const p = input.prompt.trim();
    if (p.length < 3 || p.length > 500) {
      throw new ValidationError([{ path: "prompt", message: "Prompt must be 3-500 characters." }]);
    }
    questionData.prompt = p;
  }
  if (input.active !== undefined) questionData.active = input.active;
  const effectiveType = input.questionType !== undefined
    ? normaliseQuestionType(input.questionType)
    : (q.questionType as TrainingQuestionType);
  if (input.questionType !== undefined) questionData.questionType = effectiveType;

  if (input.options !== undefined) {
    validateOptionsByType(effectiveType, input.options);
  }

  await prisma.$transaction(async (tx) => {
    // M1d (2026-10-27) -- posting-guard INSIDE the tx so FOR UPDATE on ClubSubscription serializes against suspension.
    await assertPostingAllowed(principal, clubId, "hr.training.question.update", QUESTION_ENTITY, questionId, { tx });
    if (Object.keys(questionData).length > 0) {
      await tx.trainingQuestion.update({ where: { id: questionId }, data: questionData });
    }
    if (input.options) {
      // Replace-and-reinsert semantics for simplicity — question row
      // is DRAFT, no responses reference these options yet (attempts
      // only reference PUBLISHED-version options).
      const existingIds = new Set(q.options.map((o) => o.id));
      const keepIds = new Set(input.options.filter((o) => o.id).map((o) => o.id!));
      const toDelete = [...existingIds].filter((id) => !keepIds.has(id));
      if (toDelete.length > 0) {
        await tx.trainingAnswerOption.deleteMany({ where: { id: { in: toDelete } } });
      }
      for (const [i, o] of input.options.entries()) {
        if (o.id && existingIds.has(o.id)) {
          await tx.trainingAnswerOption.update({
            where: { id: o.id },
            data: { text: o.text.trim(), isCorrect: o.isCorrect, displayOrder: i },
          });
        } else {
          await tx.trainingAnswerOption.create({
            data: {
              questionId,
              text: o.text.trim(),
              isCorrect: o.isCorrect,
              displayOrder: i,
            },
          });
        }
      }
    }
  });
  await audit(principal, {
    action: "hr.training.question.update",
    entityType: QUESTION_ENTITY,
    entityId: questionId,
    clubId,
    after: Object.keys(input),
  });
}

// ---------------------------------------------------------------------------
// Delete question (draft-only)
// ---------------------------------------------------------------------------

export async function deleteQuestion(
  principal: Principal,
  questionId: string,
): Promise<void> {
  const q = await prisma.trainingQuestion.findUnique({
    where: { id: questionId },
    include: { courseVersion: { include: { course: { select: { clubId: true } } } } },
  });
  if (!q) throw new NotFoundError(QUESTION_ENTITY, questionId);
  const clubId = q.courseVersion.course.clubId;
  if (q.courseVersion.state !== "DRAFT") {
    throw new ConflictError(`Cannot delete questions from a ${q.courseVersion.state} version.`);
  }
  requirePermission(principal, clubId, "hr:training:write");
  // M1d (2026-10-27) -- posting-guard INSIDE the tx so FOR UPDATE on ClubSubscription serializes against suspension.
  await withPostingGuard(
    principal,
    clubId,
    "hr.training.question.delete",
    async (tx) => tx.trainingQuestion.delete({ where: { id: questionId } }),
    { entityType: QUESTION_ENTITY, entityId: questionId },
  );
  await audit(principal, {
    action: "hr.training.question.delete",
    entityType: QUESTION_ENTITY,
    entityId: questionId,
    clubId,
    before: { promptTail: q.prompt.slice(-40) },
  });
}

// ---------------------------------------------------------------------------
// Reorder questions
// ---------------------------------------------------------------------------

export async function reorderQuestions(
  principal: Principal,
  versionId: string,
  orderedQuestionIds: string[],
): Promise<void> {
  const v = await loadDraftVersion(versionId);
  requirePermission(principal, v.course.clubId, "hr:training:write");
  const rows = await prisma.trainingQuestion.findMany({
    where: { courseVersionId: versionId }, select: { id: true },
  });
  const existing = new Set(rows.map((r) => r.id));
  if (orderedQuestionIds.length !== rows.length) {
    throw new ValidationError([{
      path: "orderedQuestionIds",
      message: "Order list must include every question exactly once.",
    }]);
  }
  for (const id of orderedQuestionIds) {
    if (!existing.has(id)) {
      throw new ValidationError([{ path: "orderedQuestionIds", message: `Unknown question ${id}.` }]);
    }
  }
  await prisma.$transaction(async (tx) => {
    // M1d (2026-10-27) -- posting-guard INSIDE the tx so FOR UPDATE on ClubSubscription serializes against suspension.
    await assertPostingAllowed(
      principal, v.course.clubId,
      "hr.training.question.reorder", QUESTION_ENTITY, versionId, { tx },
    );
    for (const [i, id] of orderedQuestionIds.entries()) {
      await tx.trainingQuestion.update({ where: { id }, data: { displayOrder: i } });
    }
  });
  await audit(principal, {
    action: "hr.training.question.reorder",
    entityType: QUESTION_ENTITY,
    entityId: versionId,
    clubId: v.course.clubId,
    after: { count: orderedQuestionIds.length },
  });
}
