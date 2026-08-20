// HR-2C (2026-08-20) — Training quiz question authoring service.
//
// Every write operates on a DRAFT version — published versions are
// frozen (§3, §8). Answer keys never leave the server (§27) — the
// employee-facing course payload is projected through the read helper
// in `employee.ts` which strips `isCorrect`.

import { prisma } from "../../prisma";
import { audit } from "../../audit";
import { requirePermission, type Principal } from "../../rbac";
import { assertPostingAllowed } from "../../posting-guard";
import { ConflictError, NotFoundError, ValidationError } from "../../errors";

const QUESTION_ENTITY = "TrainingQuestion";
const OPTION_ENTITY = "TrainingAnswerOption";

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

// ---------------------------------------------------------------------------
// Create question
// ---------------------------------------------------------------------------

export interface CreateQuestionInput {
  prompt: string;
  options: Array<{ text: string; isCorrect: boolean }>;
}

export async function createQuestion(
  principal: Principal,
  versionId: string,
  input: CreateQuestionInput,
): Promise<{ questionId: string }> {
  const v = await loadDraftVersion(versionId);
  requirePermission(principal, v.course.clubId, "hr:training:write");
  await assertPostingAllowed(
    principal, v.course.clubId,
    "hr.training.question.create", QUESTION_ENTITY, versionId,
  );
  const prompt = input.prompt.trim();
  if (prompt.length < 3 || prompt.length > 500) {
    throw new ValidationError([{ path: "prompt", message: "Prompt must be 3-500 characters." }]);
  }
  if (input.options.length < 2) {
    throw new ValidationError([{ path: "options", message: "At least 2 answer options are required." }]);
  }
  const correctCount = input.options.filter((o) => o.isCorrect).length;
  if (correctCount !== 1) {
    throw new ValidationError([{ path: "options", message: "Exactly one option must be marked correct." }]);
  }
  for (const [i, o] of input.options.entries()) {
    if (!o.text || o.text.trim().length === 0) {
      throw new ValidationError([{ path: `options[${i}].text`, message: "Option text required." }]);
    }
    if (o.text.trim().length > 300) {
      throw new ValidationError([{ path: `options[${i}].text`, message: "Option text must be at most 300 characters." }]);
    }
  }
  const maxOrder = await prisma.trainingQuestion.aggregate({
    where: { courseVersionId: versionId },
    _max: { displayOrder: true },
  });
  const nextOrder = (maxOrder._max.displayOrder ?? -1) + 1;

  const result = await prisma.$transaction(async (tx) => {
    const q = await tx.trainingQuestion.create({
      data: { courseVersionId: versionId, prompt, displayOrder: nextOrder, active: true },
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
    after: { versionId, promptTail: prompt.slice(-40), optionCount: input.options.length },
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
  await assertPostingAllowed(principal, clubId, "hr.training.question.update", QUESTION_ENTITY, questionId);
  const questionData: { prompt?: string; active?: boolean } = {};
  if (input.prompt !== undefined) {
    const p = input.prompt.trim();
    if (p.length < 3 || p.length > 500) {
      throw new ValidationError([{ path: "prompt", message: "Prompt must be 3-500 characters." }]);
    }
    questionData.prompt = p;
  }
  if (input.active !== undefined) questionData.active = input.active;

  if (input.options !== undefined) {
    if (input.options.length < 2) {
      throw new ValidationError([{ path: "options", message: "At least 2 answer options are required." }]);
    }
    const correctCount = input.options.filter((o) => o.isCorrect).length;
    if (correctCount !== 1) {
      throw new ValidationError([{ path: "options", message: "Exactly one option must be marked correct." }]);
    }
  }

  await prisma.$transaction(async (tx) => {
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
  await assertPostingAllowed(principal, clubId, "hr.training.question.delete", QUESTION_ENTITY, questionId);
  await prisma.trainingQuestion.delete({ where: { id: questionId } });
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
  await assertPostingAllowed(
    principal, v.course.clubId,
    "hr.training.question.reorder", QUESTION_ENTITY, versionId,
  );
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
