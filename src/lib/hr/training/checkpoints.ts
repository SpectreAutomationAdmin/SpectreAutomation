// EP-TRAIN-3 Slice 2 (2026-10-29) -- Training checkpoint authoring service.
//
// Canonical writers for TrainingCheckpoint rows. Checkpoints are the
// authoring unit that attaches interactive knowledge checks at specific
// moments inside a training video. Every write operates on a DRAFT
// TrainingCourseVersion -- published versions are frozen (same rule
// that governs questions.ts).
//
// Lifecycle:
//   createCheckpoint   -- insert at atSecond. 1s minimum spacing against
//                         siblings + duration bound enforced.
//                         `hr:training:write`.
//   updateCheckpoint   -- move/relabel/toggle required/retries.
//                         `hr:training:write`.
//   deleteCheckpoint   -- removes checkpoint + cascades Prisma FK
//                         (ON DELETE SET NULL on TrainingQuestion.checkpointId
//                         and TrainingAttempt.checkpointId -- questions
//                         bound to the deleted checkpoint remain in
//                         place but become orphaned; validator forbids
//                         publish while orphans exist).
//                         `hr:training:write`.
//   listCheckpointsForVersion -- read helper for the authoring UI.
//
// Validation rules:
//   - atSecond >= 0 and (if the video has a known duration) atSecond <= videoDurationSec.
//   - 1s minimum spacing enforced against every sibling checkpoint,
//     exclusive of self on update. Founder decision 2026-10-29.
//   - maxRetries in [0, 10]; default 3.
//   - label is optional; <=100 chars.
//
// All writes go through assertPostingAllowed inside the mutating tx so
// training-mode / support-readonly / subscription-suspension gates
// fire exactly where they do for questions.

import { prisma } from "../../prisma";
import { audit } from "../../audit";
import { requirePermission, type Principal } from "../../rbac";
import { assertPostingAllowed } from "../../posting-guard";
import { ConflictError, NotFoundError, ValidationError } from "../../errors";

const CHECKPOINT_ENTITY = "TrainingCheckpoint";

export const CHECKPOINT_MIN_SPACING_SECONDS = 1;
export const CHECKPOINT_MAX_RETRIES_CEILING = 10;

async function loadDraftVersion(versionId: string) {
  const v = await prisma.trainingCourseVersion.findUnique({
    where: { id: versionId },
    include: { course: { select: { clubId: true } } },
  });
  if (!v) throw new NotFoundError("TrainingCourseVersion", versionId);
  if (v.state !== "DRAFT") {
    throw new ConflictError(
      `Cannot modify checkpoints on a ${v.state} version. Open a new draft first.`,
    );
  }
  return v;
}

function assertValidSpacing(
  atSecond: number,
  siblings: Array<{ atSecond: number }>,
) {
  for (const s of siblings) {
    if (Math.abs(s.atSecond - atSecond) < CHECKPOINT_MIN_SPACING_SECONDS) {
      throw new ValidationError([{
        path: "atSecond",
        message: `Checkpoints must be at least ${CHECKPOINT_MIN_SPACING_SECONDS}s apart. Nearest neighbour is at ${s.atSecond}s.`,
      }]);
    }
  }
}

function assertAtSecondWithinDuration(
  atSecond: number,
  durationSec: number | null,
) {
  if (atSecond < 0 || !Number.isFinite(atSecond)) {
    throw new ValidationError([{
      path: "atSecond",
      message: "Checkpoint position must be a non-negative number of seconds.",
    }]);
  }
  if (durationSec !== null && atSecond > durationSec) {
    throw new ValidationError([{
      path: "atSecond",
      message: `Checkpoint position (${atSecond}s) exceeds the video length (${durationSec}s).`,
    }]);
  }
}

function normaliseLabel(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 100) {
    throw new ValidationError([{ path: "label", message: "Label must be at most 100 characters." }]);
  }
  return trimmed;
}

function normaliseMaxRetries(input: number | undefined): number {
  if (input === undefined) return 3;
  if (!Number.isInteger(input) || input < 0 || input > CHECKPOINT_MAX_RETRIES_CEILING) {
    throw new ValidationError([{
      path: "maxRetries",
      message: `Maximum retries must be an integer between 0 and ${CHECKPOINT_MAX_RETRIES_CEILING}.`,
    }]);
  }
  return input;
}

// ---------------------------------------------------------------------------
// Create checkpoint
// ---------------------------------------------------------------------------

export interface CreateCheckpointInput {
  atSecond: number;
  label?: string | null;
  requiredToProceed?: boolean;
  maxRetries?: number;
}

export async function createCheckpoint(
  principal: Principal,
  versionId: string,
  input: CreateCheckpointInput,
): Promise<{ checkpointId: string }> {
  const v = await loadDraftVersion(versionId);
  requirePermission(principal, v.course.clubId, "hr:training:write");
  const atSecond = Math.round(input.atSecond);
  assertAtSecondWithinDuration(atSecond, v.videoDurationSec ?? null);
  const label = normaliseLabel(input.label ?? null);
  const requiredToProceed = input.requiredToProceed ?? true;
  const maxRetries = normaliseMaxRetries(input.maxRetries);

  const siblings = await prisma.trainingCheckpoint.findMany({
    where: { courseVersionId: versionId },
    select: { atSecond: true },
  });
  assertValidSpacing(atSecond, siblings);

  const maxOrder = await prisma.trainingCheckpoint.aggregate({
    where: { courseVersionId: versionId },
    _max: { displayOrder: true },
  });
  const nextOrder = (maxOrder._max.displayOrder ?? -1) + 1;

  const result = await prisma.$transaction(async (tx) => {
    await assertPostingAllowed(
      principal, v.course.clubId,
      "hr.training.checkpoint.create", CHECKPOINT_ENTITY, versionId, { tx },
    );
    const cp = await tx.trainingCheckpoint.create({
      data: {
        courseVersionId: versionId,
        atSecond,
        label,
        requiredToProceed,
        maxRetries,
        displayOrder: nextOrder,
      },
    });
    return { checkpointId: cp.id };
  });
  await audit(principal, {
    action: "hr.training.checkpoint.create",
    entityType: CHECKPOINT_ENTITY,
    entityId: result.checkpointId,
    clubId: v.course.clubId,
    after: { versionId, atSecond, requiredToProceed, maxRetries },
  });
  return result;
}

// ---------------------------------------------------------------------------
// Update checkpoint
// ---------------------------------------------------------------------------

export interface UpdateCheckpointInput {
  atSecond?: number;
  label?: string | null;
  requiredToProceed?: boolean;
  maxRetries?: number;
}

export async function updateCheckpoint(
  principal: Principal,
  checkpointId: string,
  input: UpdateCheckpointInput,
): Promise<void> {
  const cp = await prisma.trainingCheckpoint.findUnique({
    where: { id: checkpointId },
    include: {
      courseVersion: { include: { course: { select: { clubId: true } } } },
    },
  });
  if (!cp) throw new NotFoundError(CHECKPOINT_ENTITY, checkpointId);
  const clubId = cp.courseVersion.course.clubId;
  if (cp.courseVersion.state !== "DRAFT") {
    throw new ConflictError(`Cannot modify a ${cp.courseVersion.state} version's checkpoints.`);
  }
  requirePermission(principal, clubId, "hr:training:write");

  const data: {
    atSecond?: number;
    label?: string | null;
    requiredToProceed?: boolean;
    maxRetries?: number;
  } = {};
  if (input.atSecond !== undefined) {
    const atSecond = Math.round(input.atSecond);
    assertAtSecondWithinDuration(atSecond, cp.courseVersion.videoDurationSec ?? null);
    const siblings = await prisma.trainingCheckpoint.findMany({
      where: {
        courseVersionId: cp.courseVersionId,
        NOT: { id: checkpointId },
      },
      select: { atSecond: true },
    });
    assertValidSpacing(atSecond, siblings);
    data.atSecond = atSecond;
  }
  if (input.label !== undefined) data.label = normaliseLabel(input.label);
  if (input.requiredToProceed !== undefined) data.requiredToProceed = input.requiredToProceed;
  if (input.maxRetries !== undefined) data.maxRetries = normaliseMaxRetries(input.maxRetries);
  if (Object.keys(data).length === 0) return;

  await prisma.$transaction(async (tx) => {
    await assertPostingAllowed(
      principal, clubId,
      "hr.training.checkpoint.update", CHECKPOINT_ENTITY, checkpointId, { tx },
    );
    await tx.trainingCheckpoint.update({ where: { id: checkpointId }, data });
  });
  await audit(principal, {
    action: "hr.training.checkpoint.update",
    entityType: CHECKPOINT_ENTITY,
    entityId: checkpointId,
    clubId,
    after: data,
  });
}

// ---------------------------------------------------------------------------
// Delete checkpoint
// ---------------------------------------------------------------------------

export async function deleteCheckpoint(
  principal: Principal,
  checkpointId: string,
): Promise<void> {
  const cp = await prisma.trainingCheckpoint.findUnique({
    where: { id: checkpointId },
    include: { courseVersion: { include: { course: { select: { clubId: true } } } } },
  });
  if (!cp) throw new NotFoundError(CHECKPOINT_ENTITY, checkpointId);
  const clubId = cp.courseVersion.course.clubId;
  if (cp.courseVersion.state !== "DRAFT") {
    throw new ConflictError(`Cannot delete a ${cp.courseVersion.state} version's checkpoints.`);
  }
  requirePermission(principal, clubId, "hr:training:write");

  await prisma.$transaction(async (tx) => {
    await assertPostingAllowed(
      principal, clubId,
      "hr.training.checkpoint.delete", CHECKPOINT_ENTITY, checkpointId, { tx },
    );
    await tx.trainingCheckpoint.delete({ where: { id: checkpointId } });
  });
  await audit(principal, {
    action: "hr.training.checkpoint.delete",
    entityType: CHECKPOINT_ENTITY,
    entityId: checkpointId,
    clubId,
    before: { atSecond: cp.atSecond, label: cp.label },
  });
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export async function listCheckpointsForVersion(
  versionId: string,
): Promise<Array<{
  id: string;
  atSecond: number;
  label: string | null;
  requiredToProceed: boolean;
  maxRetries: number;
  displayOrder: number;
  questionCount: number;
}>> {
  const checkpoints = await prisma.trainingCheckpoint.findMany({
    where: { courseVersionId: versionId },
    orderBy: [{ atSecond: "asc" }, { displayOrder: "asc" }],
    select: {
      id: true,
      atSecond: true,
      label: true,
      requiredToProceed: true,
      maxRetries: true,
      displayOrder: true,
      _count: { select: { questions: true } },
    },
  });
  return checkpoints.map((cp) => ({
    id: cp.id,
    atSecond: cp.atSecond,
    label: cp.label,
    requiredToProceed: cp.requiredToProceed,
    maxRetries: cp.maxRetries,
    displayOrder: cp.displayOrder,
    questionCount: cp._count.questions,
  }));
}
