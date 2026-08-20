// HR-2C §11-14, §27, §42 (2026-08-20) — Employee-side training service.
//
// Called via server actions from the Employee Portal course page.
// Consumers pass an `EmployeePortalPrincipal` — NOT a Principal —
// because the employee portal auth is deliberately separate (§21).
// Every function tenants + own-identity checks; a portal actor can
// never act for another employee.
//
// Grading discipline:
//   - Client submits selectedOptionId only.
//   - Server joins against TrainingAnswerOption.isCorrect to grade.
//   - Never trust a client-provided score, wasCorrect flag, or
//     completion signal (§14, §27, §42).

import { prisma } from "../../prisma";
import { audit } from "../../audit";
import { ConflictError, NotFoundError, ValidationError } from "../../errors";
import type { EmployeePortalPrincipal } from "../../employee-portal-session";

const ATTEMPT_ENTITY = "TrainingAttempt";
const PROGRESS_ENTITY = "TrainingProgress";
const COMPLETION_ENTITY = "TrainingCompletion";

// ---------------------------------------------------------------------------
// Video progress — monotonic-only
// ---------------------------------------------------------------------------

export interface RecordVideoProgressInput {
  courseVersionId: string;
  /** How many seconds the employee has watched in total. Monotonic —
   *  the service refuses regressions. */
  secondsWatched: number;
  /** Furthest playback second reached (used to prevent "seek to
   *  end then claim 100%" cheating — the actual watch time must
   *  keep up). */
  farthestSecond: number;
}

/**
 * Persist watch progress. The service enforces:
 *   - secondsWatched >= existing.secondsWatched (never regress)
 *   - percentComplete = min(100, floor(100 * secondsWatched / videoDurationSec))
 *     — if videoDurationSec is null we fall back to a coarse
 *       secondsWatched-based estimate that's always ≤ 100.
 *   - seeking to the last second alone does NOT satisfy completion:
 *     watch-time must accumulate to at least VIDEO_COMPLETION_THRESHOLD.
 */
export const VIDEO_COMPLETION_THRESHOLD_PERCENT = 90;

export async function recordVideoProgress(
  actor: EmployeePortalPrincipal,
  input: RecordVideoProgressInput,
): Promise<{ percentComplete: number; videoCompleted: boolean }> {
  if (!Number.isFinite(input.secondsWatched) || input.secondsWatched < 0) {
    throw new ValidationError([{ path: "secondsWatched", message: "Must be a positive number." }]);
  }
  if (!Number.isFinite(input.farthestSecond) || input.farthestSecond < 0) {
    throw new ValidationError([{ path: "farthestSecond", message: "Must be a positive number." }]);
  }
  const version = await prisma.trainingCourseVersion.findFirst({
    where: {
      id: input.courseVersionId,
      state: "PUBLISHED",
      course: { clubId: actor.clubId, retiredAt: null },
    },
    select: { id: true, videoDurationSec: true, videoStorageKey: true, course: { select: { clubId: true } } },
  });
  if (!version) throw new NotFoundError("TrainingCourseVersion", input.courseVersionId);
  if (!version.videoStorageKey) {
    throw new ConflictError("Version has no video attached.");
  }

  const existing = await prisma.trainingProgress.findFirst({
    where: { employeeId: actor.employeeId, courseVersionId: version.id },
  });

  // Monotonic — never regress.
  const nextSeconds = Math.max(input.secondsWatched, existing?.secondsWatched ?? 0);
  const nextFarthest = Math.max(input.farthestSecond, existing?.farthestSecond ?? 0);
  // Coarse guard against "seek to last second then claim 100%": if
  // farthestSecond is >= duration but secondsWatched hasn't kept up,
  // the percent is still capped by secondsWatched.
  const duration = version.videoDurationSec ?? (Math.max(nextSeconds, nextFarthest) || 1);
  const percentComplete = Math.min(100, Math.floor((nextSeconds / duration) * 100));

  const row = await prisma.trainingProgress.upsert({
    where: { employeeId_courseVersionId: { employeeId: actor.employeeId, courseVersionId: version.id } },
    create: {
      clubId: actor.clubId,
      employeeId: actor.employeeId,
      courseVersionId: version.id,
      secondsWatched: nextSeconds,
      farthestSecond: nextFarthest,
      percentComplete,
    },
    update: {
      secondsWatched: nextSeconds,
      farthestSecond: nextFarthest,
      percentComplete,
    },
  });
  const videoCompleted = row.percentComplete >= VIDEO_COMPLETION_THRESHOLD_PERCENT;
  return { percentComplete: row.percentComplete, videoCompleted };
}

// ---------------------------------------------------------------------------
// Start attempt
// ---------------------------------------------------------------------------

export interface StartAttemptInput {
  courseVersionId: string;
}

export async function startAttempt(
  actor: EmployeePortalPrincipal,
  input: StartAttemptInput,
): Promise<{ attemptId: string; attemptNumber: number }> {
  const version = await loadApplicablePublishedVersion(actor, input.courseVersionId);
  // Refuse if video threshold isn't met (§11 — quiz cannot open until
  // video is watched).
  if (version.videoStorageKey) {
    const progress = await prisma.trainingProgress.findFirst({
      where: { employeeId: actor.employeeId, courseVersionId: version.id },
      select: { percentComplete: true },
    });
    if (!progress || progress.percentComplete < VIDEO_COMPLETION_THRESHOLD_PERCENT) {
      throw new ConflictError(
        `Complete the training video (at least ${VIDEO_COMPLETION_THRESHOLD_PERCENT}%) before starting the knowledge test.`,
      );
    }
  }
  // Refuse if the employee has already passed this version.
  const completion = await prisma.trainingCompletion.findFirst({
    where: { employeeId: actor.employeeId, courseVersionId: version.id },
    select: { id: true },
  });
  if (completion) throw new ConflictError("This course version is already completed.");
  // Refuse if retakes disabled AND there's already a submitted attempt.
  if (!version.retakesAllowed) {
    const priorSubmitted = await prisma.trainingAttempt.findFirst({
      where: { employeeId: actor.employeeId, courseVersionId: version.id, submittedAt: { not: null } },
      select: { id: true },
    });
    if (priorSubmitted) {
      throw new ConflictError("Retakes are not allowed on this course.");
    }
  }
  // Refuse if there is an OPEN attempt (started but not submitted) —
  // return the existing attempt id so the employee resumes.
  const openAttempt = await prisma.trainingAttempt.findFirst({
    where: { employeeId: actor.employeeId, courseVersionId: version.id, submittedAt: null },
    select: { id: true, attemptNumber: true },
    orderBy: { attemptNumber: "desc" },
  });
  if (openAttempt) return { attemptId: openAttempt.id, attemptNumber: openAttempt.attemptNumber };

  const priorMax = await prisma.trainingAttempt.aggregate({
    where: { employeeId: actor.employeeId, courseVersionId: version.id },
    _max: { attemptNumber: true },
  });
  const attemptNumber = (priorMax._max.attemptNumber ?? 0) + 1;
  const row = await prisma.trainingAttempt.create({
    data: {
      clubId: actor.clubId,
      employeeId: actor.employeeId,
      courseVersionId: version.id,
      attemptNumber,
    },
  });
  return { attemptId: row.id, attemptNumber };
}

// ---------------------------------------------------------------------------
// Submit attempt — server grades
// ---------------------------------------------------------------------------

export interface SubmitAttemptInput {
  attemptId: string;
  /** Map of questionId → selectedOptionId. Server verifies both
   *  belong to the attempt's courseVersion. */
  answers: Array<{ questionId: string; selectedOptionId: string }>;
}

export interface SubmitAttemptResult {
  attemptId: string;
  score: number;
  passed: boolean;
  completionId: string | null;
}

export async function submitAttempt(
  actor: EmployeePortalPrincipal,
  input: SubmitAttemptInput,
): Promise<SubmitAttemptResult> {
  const attempt = await prisma.trainingAttempt.findUnique({
    where: { id: input.attemptId },
    include: {
      courseVersion: {
        select: {
          id: true, passingScore: true, retakesAllowed: true, requiresKnowledgeTest: true,
          course: { select: { id: true, clubId: true, retiredAt: true } },
          questions: {
            where: { active: true },
            select: {
              id: true,
              options: { select: { id: true, isCorrect: true } },
            },
          },
        },
      },
    },
  });
  if (!attempt) throw new NotFoundError(ATTEMPT_ENTITY, input.attemptId);
  if (attempt.employeeId !== actor.employeeId) {
    // Cross-employee guard — same-shape not-found so an actor can't
    // enumerate other attempt ids (§21).
    throw new NotFoundError(ATTEMPT_ENTITY, input.attemptId);
  }
  if (attempt.clubId !== actor.clubId) {
    throw new NotFoundError(ATTEMPT_ENTITY, input.attemptId);
  }
  if (attempt.submittedAt) throw new ConflictError("Attempt already submitted.");
  if (attempt.courseVersion.course.retiredAt) {
    throw new ConflictError("Course has been retired.");
  }

  const questionMap = new Map(attempt.courseVersion.questions.map((q) => [q.id, q]));
  const submittedMap = new Map(input.answers.map((a) => [a.questionId, a.selectedOptionId]));

  let correctCount = 0;
  const responseRows: Array<{ questionId: string; selectedOptionId: string; wasCorrect: boolean }> = [];
  for (const q of attempt.courseVersion.questions) {
    const chosen = submittedMap.get(q.id);
    if (!chosen) {
      // Un-answered — treat as an incorrect selection with a
      // placeholder response row so the audit trail is complete.
      // Server enforces "answer every question" as validation.
      throw new ValidationError([{ path: `answers.${q.id}`, message: "Every question must have a selected option." }]);
    }
    const option = q.options.find((o) => o.id === chosen);
    if (!option) {
      throw new ValidationError([{ path: `answers.${q.id}`, message: "Selected option is not valid for this question." }]);
    }
    const wasCorrect = option.isCorrect;
    if (wasCorrect) correctCount++;
    responseRows.push({ questionId: q.id, selectedOptionId: chosen, wasCorrect });
  }
  // Any submitted answers for questions NOT on this attempt's version
  // are refused (defence against a doctored payload).
  for (const [qId] of submittedMap) {
    if (!questionMap.has(qId)) {
      throw new ValidationError([{ path: `answers.${qId}`, message: "Question is not part of this attempt." }]);
    }
  }

  const total = attempt.courseVersion.questions.length;
  const score = total === 0 ? 100 : Math.round((correctCount / total) * 100);
  const passed = score >= attempt.courseVersion.passingScore;
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    await tx.trainingAttempt.update({
      where: { id: attempt.id },
      data: { submittedAt: now, score, passed },
    });
    for (const r of responseRows) {
      await tx.trainingQuestionResponse.create({
        data: {
          attemptId: attempt.id,
          questionId: r.questionId,
          selectedOptionId: r.selectedOptionId,
          wasCorrect: r.wasCorrect,
        },
      });
    }
    let completionId: string | null = null;
    if (passed) {
      // Idempotent — completion is unique per (employee, version).
      const existing = await tx.trainingCompletion.findUnique({
        where: { employeeId_courseVersionId: { employeeId: actor.employeeId, courseVersionId: attempt.courseVersion.id } },
      });
      if (!existing) {
        const c = await tx.trainingCompletion.create({
          data: {
            clubId: actor.clubId,
            employeeId: actor.employeeId,
            courseId: attempt.courseVersion.course.id,
            courseVersionId: attempt.courseVersion.id,
            attemptId: attempt.id,
            score,
          },
        });
        completionId = c.id;
      } else {
        completionId = existing.id;
      }
    }
    return { completionId };
  });

  await audit(null, {
    action: "hr.training.attempt.submit",
    entityType: ATTEMPT_ENTITY,
    entityId: attempt.id,
    clubId: attempt.clubId,
    after: {
      score, passed, questionCount: total,
      actorSource: "EMPLOYEE",
      employeeIdTail: actor.employeeId.slice(-8),
    },
  });
  if (result.completionId) {
    await audit(null, {
      action: "hr.training.completion.record",
      entityType: COMPLETION_ENTITY,
      entityId: result.completionId,
      clubId: attempt.clubId,
      after: {
        courseId: attempt.courseVersion.course.id,
        courseVersionId: attempt.courseVersion.id,
        actorSource: "EMPLOYEE",
      },
    });
  }
  return { attemptId: attempt.id, score, passed, completionId: result.completionId };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadApplicablePublishedVersion(
  actor: EmployeePortalPrincipal,
  versionId: string,
) {
  const v = await prisma.trainingCourseVersion.findFirst({
    where: {
      id: versionId,
      state: "PUBLISHED",
      course: { clubId: actor.clubId, retiredAt: null },
    },
    select: {
      id: true,
      videoStorageKey: true,
      videoDurationSec: true,
      retakesAllowed: true,
      requiresKnowledgeTest: true,
    },
  });
  if (!v) throw new NotFoundError("TrainingCourseVersion", versionId);
  return v;
}

/** Progress row lookup for the employee-portal actor. Returns null
 *  when no row exists yet (fresh start). Tenant-scoped. */
export async function getProgress(
  actor: EmployeePortalPrincipal,
  courseVersionId: string,
): Promise<{ secondsWatched: number; farthestSecond: number; percentComplete: number; videoCompleted: boolean } | null> {
  const row = await prisma.trainingProgress.findFirst({
    where: { employeeId: actor.employeeId, clubId: actor.clubId, courseVersionId },
    select: { secondsWatched: true, farthestSecond: true, percentComplete: true },
  });
  if (!row) return null;
  return {
    secondsWatched: row.secondsWatched,
    farthestSecond: row.farthestSecond,
    percentComplete: row.percentComplete,
    videoCompleted: row.percentComplete >= VIDEO_COMPLETION_THRESHOLD_PERCENT,
  };
}
