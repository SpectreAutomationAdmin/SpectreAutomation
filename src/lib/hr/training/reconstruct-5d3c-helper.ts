// EP-TRAIN-5D-3C-B (2026-11-02) — one-time Orientation v4 reconstruction helper.
//
// Narrow, temporary helper that clones a specified source TrainingCourseVersion
// into a new DRAFT at version = max(existing) + 1, preserving:
//   - checkpoint rows (new ids), via a Map<sourceId -> draftId>
//   - question.questionType (EP-TRAIN-5D-3 preservation requirement)
//   - question.checkpointId FK remapped to the newly created checkpoints
//   - answer options
// Writes the standard "hr.training.version.draft" audit event via audit().
//
// Does NOT publish; `publishDraft` from courses.ts handles publication.
//
// Intended consumer: the EP-TRAIN-5D-3C-B temporary admin endpoint at
// /api/dev/5d3c-reconstruct. Removed in the Deploy #2 cleanup slice.

import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Principal } from "@/lib/rbac";
import { assertTenantOwned } from "@/lib/services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";

export interface ReconstructV4Args {
  courseId: string;
  sourceVersionId: string;
  expectedPassingScore: number;
  slice: string;
}

export interface ReconstructV4Result {
  draftId: string;
  version: number;
  checkpointCount: number;
  questionCount: number;
  passingScore: number;
  clonedFromVersion: number;
}

export async function reconstructTrainingDraftFromSource(
  principal: Principal,
  args: ReconstructV4Args,
): Promise<ReconstructV4Result> {
  const source = await prisma.trainingCourseVersion.findUnique({
    where: { id: args.sourceVersionId },
    include: {
      checkpoints: { orderBy: { displayOrder: "asc" } },
      questions: { include: { options: { orderBy: { displayOrder: "asc" } } }, orderBy: { displayOrder: "asc" } },
      course: { select: { id: true, clubId: true, retiredAt: true } },
    },
  });
  if (!source) throw new NotFoundError("TrainingCourseVersion", args.sourceVersionId);
  if (source.course.id !== args.courseId) {
    throw new ValidationError([{ path: "sourceVersionId", message: "Source version does not belong to the specified course" }]);
  }
  if (source.course.retiredAt) {
    throw new ValidationError([{ path: "courseId", message: "Course is retired" }]);
  }
  assertTenantOwned({ clubId: source.course.clubId }, principal);
  if (source.passingScore !== args.expectedPassingScore) {
    throw new ValidationError([{ path: "expectedPassingScore", message: `Source passingScore=${source.passingScore}, expected ${args.expectedPassingScore}` }]);
  }
  if (!source.videoStorageKey || !source.videoDurationSec) {
    throw new ValidationError([{ path: "sourceVersionId", message: "Source version missing video metadata" }]);
  }

  // Compute next version number.
  const latest = await prisma.trainingCourseVersion.findFirst({
    where: { courseId: args.courseId },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const nextNumber = (latest?.version ?? 0) + 1;

  // Idempotence: refuse if any version >= nextNumber already exists.
  const higher = await prisma.trainingCourseVersion.findFirst({
    where: { courseId: args.courseId, version: { gte: nextNumber } },
    select: { id: true, version: true, state: true },
  });
  if (higher) {
    throw new ConflictError(`Version ${higher.version} already exists (state=${higher.state})`);
  }

  const result = await prisma.$transaction(async (tx) => {
    const draft = await tx.trainingCourseVersion.create({
      data: {
        courseId: source.course.id,
        version: nextNumber,
        state: "DRAFT",
        title: source.title,
        description: source.description,
        passingScore: source.passingScore,
        retakesAllowed: source.retakesAllowed,
        requiresKnowledgeTest: source.requiresKnowledgeTest,
        videoStorageKey: source.videoStorageKey,
        videoMimeType: source.videoMimeType,
        videoSizeBytes: source.videoSizeBytes,
        videoSha256: source.videoSha256,
        videoDurationSec: source.videoDurationSec,
        appliesToAll: source.appliesToAll,
        appliesToDeptIds: source.appliesToDeptIds,
        appliesToPositionIds: source.appliesToPositionIds,
        required: source.required,
      },
    });

    const checkpointIdMap = new Map<string, string>();
    const sortedCheckpoints = [...source.checkpoints].sort((a, b) => a.displayOrder - b.displayOrder);
    for (const cp of sortedCheckpoints) {
      const cloned = await tx.trainingCheckpoint.create({
        data: {
          courseVersionId: draft.id,
          atSecond: cp.atSecond,
          label: cp.label,
          requiredToProceed: cp.requiredToProceed,
          maxRetries: cp.maxRetries,
          displayOrder: cp.displayOrder,
        },
      });
      checkpointIdMap.set(cp.id, cloned.id);
    }

    for (const q of source.questions) {
      const clonedQ = await tx.trainingQuestion.create({
        data: {
          courseVersionId: draft.id,
          prompt: q.prompt,
          displayOrder: q.displayOrder,
          active: q.active,
          checkpointId: q.checkpointId ? checkpointIdMap.get(q.checkpointId) ?? null : null,
          questionType: q.questionType,
        },
      });
      for (const o of q.options) {
        await tx.trainingAnswerOption.create({
          data: {
            questionId: clonedQ.id,
            text: o.text,
            isCorrect: o.isCorrect,
            displayOrder: o.displayOrder,
          },
        });
      }
    }

    return { draftId: draft.id, version: draft.version };
  });

  await audit(principal, {
    action: "hr.training.version.draft",
    entityType: "TrainingCourseVersion",
    entityId: result.draftId,
    clubId: source.course.clubId,
    after: {
      courseId: source.course.id,
      version: result.version,
      clonedFrom: args.sourceVersionId,
      clonedFromVersion: source.version,
      slice: args.slice,
      passingScore: source.passingScore,
      checkpointCount: source.checkpoints.length,
      questionCount: source.questions.length,
    },
  });

  return {
    draftId: result.draftId,
    version: result.version,
    checkpointCount: source.checkpoints.length,
    questionCount: source.questions.length,
    passingScore: source.passingScore,
    clonedFromVersion: source.version,
  };
}
