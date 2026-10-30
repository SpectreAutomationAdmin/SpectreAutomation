// HR-2C §11-14, §27, §42 (2026-08-20) — Employee-side training service.
// EP-TRAIN-3 Slice 3 (2026-10-29) -- extended with checkpoint attempts
// + checkpoint-cleared progress + final-assessment gating + seek-
// forward prevention.
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
): Promise<{ percentComplete: number; videoCompleted: boolean; cappedAt?: number }> {
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
    select: {
      id: true,
      videoDurationSec: true,
      videoStorageKey: true,
      course: { select: { clubId: true } },
      checkpoints: {
        where: { requiredToProceed: true },
        select: { id: true, atSecond: true },
        orderBy: { atSecond: "asc" },
      },
    },
  });
  if (!version) throw new NotFoundError("TrainingCourseVersion", input.courseVersionId);
  if (!version.videoStorageKey) {
    throw new ConflictError("Version has no video attached.");
  }

  const existing = await prisma.trainingProgress.findFirst({
    where: { employeeId: actor.employeeId, courseVersionId: version.id },
  });

  // EP-TRAIN-3 Slice 3 (2026-10-29) -- seek-forward prevention.
  // Server caps farthestSecond at the position of the first un-cleared
  // required checkpoint. A client that seeks past an un-cleared
  // checkpoint cannot ratchet progress forward past the lock point.
  const cleared = parseClearedCheckpointIds(existing?.checkpointClearedJson ?? null);
  const firstUncleared = version.checkpoints.find((cp) => !cleared.has(cp.id));
  const seekCap = firstUncleared ? firstUncleared.atSecond : Number.POSITIVE_INFINITY;
  const cappedFarthestInput = Math.min(input.farthestSecond, seekCap);
  const cappedSecondsInput = Math.min(input.secondsWatched, seekCap);

  // Monotonic — never regress.
  const nextSeconds = Math.max(cappedSecondsInput, existing?.secondsWatched ?? 0);
  const nextFarthest = Math.max(cappedFarthestInput, existing?.farthestSecond ?? 0);
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
  // Record the cleared-set unchanged on the upsert.
  if (row.checkpointClearedJson !== (existing?.checkpointClearedJson ?? null)) {
    // Shouldn't happen -- upsert preserved the field.
  }
  return {
    percentComplete: row.percentComplete,
    videoCompleted,
    cappedAt: Number.isFinite(seekCap) ? (seekCap as number) : undefined,
  };
}

// ---------------------------------------------------------------------------
// EP-TRAIN-3 Slice 3: aggregated player state read helper
// ---------------------------------------------------------------------------

export interface PlayerCheckpointState {
  id: string;
  atSecond: number;
  label: string | null;
  requiredToProceed: boolean;
  maxRetries: number;
  cleared: boolean;
  attemptsUsed: number;
  attemptsRemaining: number;
}

export interface PlayerState {
  courseVersionId: string;
  videoDurationSec: number | null;
  secondsWatched: number;
  farthestSecond: number;
  percentComplete: number;
  videoCompleted: boolean;
  checkpoints: PlayerCheckpointState[];
  finalAssessmentUnlocked: boolean;
  finalAssessmentReasons: string[];
  completedAt: Date | null;
}

export async function getPlayerState(
  actor: EmployeePortalPrincipal,
  courseVersionId: string,
): Promise<PlayerState> {
  const version = await prisma.trainingCourseVersion.findFirst({
    where: {
      id: courseVersionId,
      state: "PUBLISHED",
      course: { clubId: actor.clubId, retiredAt: null },
    },
    select: {
      id: true,
      videoDurationSec: true,
      checkpoints: {
        orderBy: { atSecond: "asc" },
        select: { id: true, atSecond: true, label: true, requiredToProceed: true, maxRetries: true },
      },
    },
  });
  if (!version) throw new NotFoundError("TrainingCourseVersion", courseVersionId);

  const progress = await prisma.trainingProgress.findFirst({
    where: { employeeId: actor.employeeId, courseVersionId: version.id },
    select: { secondsWatched: true, farthestSecond: true, percentComplete: true, checkpointClearedJson: true },
  });
  const cleared = parseClearedCheckpointIds(progress?.checkpointClearedJson ?? null);

  // Per-checkpoint attempt counts in one query.
  const attemptCounts = await prisma.trainingAttempt.groupBy({
    by: ["checkpointId"],
    where: {
      employeeId: actor.employeeId,
      courseVersionId: version.id,
      kind: "CHECKPOINT",
      checkpointId: { not: null },
      submittedAt: { not: null },
    },
    _count: { _all: true },
  });
  const attemptCountByCp = new Map<string, number>();
  for (const row of attemptCounts) if (row.checkpointId) attemptCountByCp.set(row.checkpointId, row._count._all);

  const checkpoints: PlayerCheckpointState[] = version.checkpoints.map((cp) => {
    const used = attemptCountByCp.get(cp.id) ?? 0;
    const totalAllowed = cp.maxRetries + 1;
    return {
      id: cp.id,
      atSecond: cp.atSecond,
      label: cp.label,
      requiredToProceed: cp.requiredToProceed,
      maxRetries: cp.maxRetries,
      cleared: cleared.has(cp.id),
      attemptsUsed: used,
      attemptsRemaining: Math.max(0, totalAllowed - used),
    };
  });

  const videoCompleted = (progress?.percentComplete ?? 0) >= VIDEO_COMPLETION_THRESHOLD_PERCENT;
  const requiredNotCleared = checkpoints.filter((c) => c.requiredToProceed && !c.cleared);
  const reasons: string[] = [];
  if (!videoCompleted) reasons.push(`Watch at least ${VIDEO_COMPLETION_THRESHOLD_PERCENT}% of the video.`);
  if (requiredNotCleared.length > 0) {
    reasons.push(`Clear ${requiredNotCleared.length} required checkpoint${requiredNotCleared.length === 1 ? "" : "s"}.`);
  }
  const completion = await prisma.trainingCompletion.findUnique({
    where: { employeeId_courseVersionId: { employeeId: actor.employeeId, courseVersionId: version.id } },
    select: { completedAt: true },
  });

  return {
    courseVersionId: version.id,
    videoDurationSec: version.videoDurationSec,
    secondsWatched: progress?.secondsWatched ?? 0,
    farthestSecond: progress?.farthestSecond ?? 0,
    percentComplete: progress?.percentComplete ?? 0,
    videoCompleted,
    checkpoints,
    finalAssessmentUnlocked: reasons.length === 0 && completion === null,
    finalAssessmentReasons: reasons,
    completedAt: completion?.completedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// EP-TRAIN-3 Slice 3 helpers
// ---------------------------------------------------------------------------

function parseClearedCheckpointIds(json: string | null): Set<string> {
  if (!json) return new Set();
  try {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((x): x is string => typeof x === "string"));
    }
  } catch {
    // malformed JSON -- treat as empty
  }
  return new Set();
}

function serialiseClearedCheckpointIds(ids: Set<string>): string {
  return JSON.stringify(Array.from(ids).sort());
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
      select: { percentComplete: true, checkpointClearedJson: true },
    });
    if (!progress || progress.percentComplete < VIDEO_COMPLETION_THRESHOLD_PERCENT) {
      throw new ConflictError(
        `Complete the training video (at least ${VIDEO_COMPLETION_THRESHOLD_PERCENT}%) before starting the knowledge test.`,
      );
    }
    // EP-TRAIN-3 Slice 3 (2026-10-29) -- final-assessment gating.
    // All REQUIRED checkpoints must be cleared before the final
    // assessment unlocks.  Non-required checkpoints are skippable.
    const required = await prisma.trainingCheckpoint.findMany({
      where: { courseVersionId: version.id, requiredToProceed: true },
      select: { id: true, label: true, atSecond: true },
    });
    if (required.length > 0) {
      const cleared = parseClearedCheckpointIds(progress.checkpointClearedJson ?? null);
      const missing = required.filter((cp) => !cleared.has(cp.id));
      if (missing.length > 0) {
        throw new ConflictError(
          `${missing.length} required checkpoint${missing.length === 1 ? "" : "s"} must be cleared before the final assessment unlocks.`,
        );
      }
    }
  }
  // Refuse if the employee has already passed this version.
  const completion = await prisma.trainingCompletion.findFirst({
    where: { employeeId: actor.employeeId, courseVersionId: version.id },
    select: { id: true },
  });
  if (completion) throw new ConflictError("This course version is already completed.");
  // Refuse if retakes disabled AND there's already a submitted FINAL attempt.
  if (!version.retakesAllowed) {
    const priorSubmitted = await prisma.trainingAttempt.findFirst({
      where: {
        employeeId: actor.employeeId,
        courseVersionId: version.id,
        kind: "FINAL",
        submittedAt: { not: null },
      },
      select: { id: true },
    });
    if (priorSubmitted) {
      throw new ConflictError("Retakes are not allowed on this course.");
    }
  }
  // Refuse if there is an OPEN FINAL attempt (started but not submitted) —
  // return the existing attempt id so the employee resumes.
  const openAttempt = await prisma.trainingAttempt.findFirst({
    where: {
      employeeId: actor.employeeId,
      courseVersionId: version.id,
      kind: "FINAL",
      submittedAt: null,
    },
    select: { id: true, attemptNumber: true },
    orderBy: { attemptNumber: "desc" },
  });
  if (openAttempt) return { attemptId: openAttempt.id, attemptNumber: openAttempt.attemptNumber };

  // attemptNumber must be globally unique per (employee, version) --
  // the DB unique constraint doesn't partition by kind, so aggregate
  // across every kind to pick the next number.
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
      kind: "FINAL",
    },
  });
  return { attemptId: row.id, attemptNumber };
}

// ---------------------------------------------------------------------------
// EP-TRAIN-3 Slice 3 (2026-10-29): checkpoint attempt lifecycle
// ---------------------------------------------------------------------------

export interface StartCheckpointAttemptInput {
  courseVersionId: string;
  checkpointId: string;
}

export interface StartCheckpointAttemptResult {
  attemptId: string;
  attemptNumber: number;
  attemptsRemaining: number;
  maxRetries: number;
}

export async function startCheckpointAttempt(
  actor: EmployeePortalPrincipal,
  input: StartCheckpointAttemptInput,
): Promise<StartCheckpointAttemptResult> {
  const version = await loadApplicablePublishedVersion(actor, input.courseVersionId);
  const checkpoint = await prisma.trainingCheckpoint.findFirst({
    where: { id: input.checkpointId, courseVersionId: version.id },
    select: { id: true, atSecond: true, requiredToProceed: true, maxRetries: true, label: true },
  });
  if (!checkpoint) throw new NotFoundError("TrainingCheckpoint", input.checkpointId);

  // Gating: employee must have reached this checkpoint in the video.
  const progressRow = await prisma.trainingProgress.findFirst({
    where: { employeeId: actor.employeeId, courseVersionId: version.id },
    select: { farthestSecond: true, checkpointClearedJson: true },
  });
  const farthestSecond = progressRow?.farthestSecond ?? 0;
  if (farthestSecond < checkpoint.atSecond) {
    throw new ConflictError(
      `Reach ${checkpoint.atSecond}s in the video before answering this checkpoint.`,
    );
  }

  // Already-cleared short-circuit: idempotent "no-op" — the client
  // should not re-ask a cleared checkpoint; if it does, return the
  // last cleared attempt rather than consuming a retry.
  const cleared = parseClearedCheckpointIds(progressRow?.checkpointClearedJson ?? null);
  if (cleared.has(checkpoint.id)) {
    const lastCleared = await prisma.trainingAttempt.findFirst({
      where: {
        employeeId: actor.employeeId,
        courseVersionId: version.id,
        kind: "CHECKPOINT",
        checkpointId: checkpoint.id,
        passed: true,
      },
      orderBy: { attemptNumber: "desc" },
      select: { id: true, attemptNumber: true },
    });
    if (lastCleared) {
      return {
        attemptId: lastCleared.id,
        attemptNumber: lastCleared.attemptNumber,
        attemptsRemaining: 0,
        maxRetries: checkpoint.maxRetries,
      };
    }
  }

  // Retry budget: count prior submitted attempts for this checkpoint.
  const priorAttempts = await prisma.trainingAttempt.count({
    where: {
      employeeId: actor.employeeId,
      courseVersionId: version.id,
      kind: "CHECKPOINT",
      checkpointId: checkpoint.id,
      submittedAt: { not: null },
    },
  });
  // maxRetries is the number of RETRIES after the initial attempt --
  // so total allowed submissions = maxRetries + 1.
  const totalAllowed = checkpoint.maxRetries + 1;
  if (priorAttempts >= totalAllowed) {
    throw new ConflictError(
      `No retries remaining for this checkpoint. Contact your manager to reset.`,
    );
  }

  // Resume an OPEN checkpoint attempt if one exists.
  const openAttempt = await prisma.trainingAttempt.findFirst({
    where: {
      employeeId: actor.employeeId,
      courseVersionId: version.id,
      kind: "CHECKPOINT",
      checkpointId: checkpoint.id,
      submittedAt: null,
    },
    orderBy: { attemptNumber: "desc" },
    select: { id: true, attemptNumber: true },
  });
  if (openAttempt) {
    return {
      attemptId: openAttempt.id,
      attemptNumber: openAttempt.attemptNumber,
      attemptsRemaining: totalAllowed - priorAttempts,
      maxRetries: checkpoint.maxRetries,
    };
  }

  // Pick next attemptNumber across ALL kinds (schema unique is per
  // (employee, version, attemptNumber), not partitioned by kind).
  const maxAttemptNum = await prisma.trainingAttempt.aggregate({
    where: { employeeId: actor.employeeId, courseVersionId: version.id },
    _max: { attemptNumber: true },
  });
  const attemptNumber = (maxAttemptNum._max.attemptNumber ?? 0) + 1;
  const row = await prisma.trainingAttempt.create({
    data: {
      clubId: actor.clubId,
      employeeId: actor.employeeId,
      courseVersionId: version.id,
      attemptNumber,
      kind: "CHECKPOINT",
      checkpointId: checkpoint.id,
    },
  });
  return {
    attemptId: row.id,
    attemptNumber,
    attemptsRemaining: totalAllowed - priorAttempts - 1,
    maxRetries: checkpoint.maxRetries,
  };
}

// ---------------------------------------------------------------------------
// Submit attempt — server grades
// ---------------------------------------------------------------------------

export interface SubmitAttemptInput {
  attemptId: string;
  /** Per-question answers. For SINGLE_CHOICE / TRUE_FALSE: exactly one
   *  selected option id. For MULTI_ANSWER: pass selectedOptionIds (an
   *  array). The service accepts either shape per question. */
  answers: Array<{
    questionId: string;
    selectedOptionId?: string;
    selectedOptionIds?: string[];
  }>;
}

export interface SubmitAttemptResult {
  attemptId: string;
  score: number;
  passed: boolean;
  completionId: string | null;
  checkpointCleared?: boolean;
  attemptsRemaining?: number;
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
              questionType: true,
              checkpointId: true,
              options: { select: { id: true, isCorrect: true } },
            },
          },
        },
      },
    },
  });
  if (!attempt) throw new NotFoundError(ATTEMPT_ENTITY, input.attemptId);
  if (attempt.employeeId !== actor.employeeId) {
    throw new NotFoundError(ATTEMPT_ENTITY, input.attemptId);
  }
  if (attempt.clubId !== actor.clubId) {
    throw new NotFoundError(ATTEMPT_ENTITY, input.attemptId);
  }
  if (attempt.submittedAt) throw new ConflictError("Attempt already submitted.");
  if (attempt.courseVersion.course.retiredAt) {
    throw new ConflictError("Course has been retired.");
  }

  // EP-TRAIN-3 Slice 3 (2026-10-29) -- filter questions by attempt kind.
  const kind = (attempt.kind as string) ?? "FINAL";
  const relevantQuestions = attempt.courseVersion.questions.filter((q) =>
    kind === "CHECKPOINT"
      ? q.checkpointId === attempt.checkpointId
      : q.checkpointId === null,
  );

  const questionMap = new Map(relevantQuestions.map((q) => [q.id, q]));
  const submittedMap = new Map(input.answers.map((a) => [a.questionId, a]));

  let correctCount = 0;
  const responseRows: Array<{
    questionId: string;
    selectedOptionId: string;
    selectedOptionIdsJson: string | null;
    wasCorrect: boolean;
  }> = [];
  for (const q of relevantQuestions) {
    const answer = submittedMap.get(q.id);
    if (!answer) {
      throw new ValidationError([{ path: `answers.${q.id}`, message: "Every question must have a selected option." }]);
    }
    const qType = (q.questionType as string) ?? "SINGLE_CHOICE";
    const correctSet = new Set(q.options.filter((o) => o.isCorrect).map((o) => o.id));
    const validSet = new Set(q.options.map((o) => o.id));
    if (qType === "MULTI_ANSWER") {
      const chosen = (answer.selectedOptionIds ?? (answer.selectedOptionId ? [answer.selectedOptionId] : [])).filter(Boolean);
      if (chosen.length === 0) {
        throw new ValidationError([{ path: `answers.${q.id}`, message: "At least one option must be selected." }]);
      }
      for (const id of chosen) {
        if (!validSet.has(id)) {
          throw new ValidationError([{ path: `answers.${q.id}`, message: "Selected option is not valid for this question." }]);
        }
      }
      const chosenSet = new Set(chosen);
      const wasCorrect = chosenSet.size === correctSet.size && [...correctSet].every((id) => chosenSet.has(id));
      if (wasCorrect) correctCount++;
      // EP-TRAIN-3 Slice 3C (2026-10-30): single durable row per
      // (attempt, question) per the unique constraint, BUT the full
      // selected-option set is preserved in selectedOptionIdsJson so
      // audit + employee-facing evidence can reconstruct every choice.
      // selectedOptionId still carries the FIRST chosen option for
      // backward-compatible display in legacy consumers.
      const sortedChosen = [...chosen].sort();
      const primary = sortedChosen[0]!;
      responseRows.push({
        questionId: q.id,
        selectedOptionId: primary,
        selectedOptionIdsJson: JSON.stringify(sortedChosen),
        wasCorrect,
      });
    } else {
      const chosen = answer.selectedOptionId ?? (answer.selectedOptionIds?.[0]);
      if (!chosen) {
        throw new ValidationError([{ path: `answers.${q.id}`, message: "An option must be selected." }]);
      }
      if (!validSet.has(chosen)) {
        throw new ValidationError([{ path: `answers.${q.id}`, message: "Selected option is not valid for this question." }]);
      }
      const option = q.options.find((o) => o.id === chosen)!;
      const wasCorrect = option.isCorrect;
      if (wasCorrect) correctCount++;
      responseRows.push({
        questionId: q.id,
        selectedOptionId: chosen,
        selectedOptionIdsJson: null, // SINGLE_CHOICE / TRUE_FALSE -> null (legacy single-row)
        wasCorrect,
      });
    }
  }
  for (const [qId] of submittedMap) {
    if (!questionMap.has(qId)) {
      throw new ValidationError([{ path: `answers.${qId}`, message: "Question is not part of this attempt." }]);
    }
  }

  const total = relevantQuestions.length;
  const score = total === 0 ? 100 : Math.round((correctCount / total) * 100);
  // Checkpoint attempts pass only on 100% (all answers correct for that checkpoint).
  // Final attempts pass on the configured passingScore.
  const passed = kind === "CHECKPOINT"
    ? score === 100
    : score >= attempt.courseVersion.passingScore;
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
          selectedOptionIdsJson: r.selectedOptionIdsJson,
          wasCorrect: r.wasCorrect,
        },
      });
    }
    let completionId: string | null = null;
    // Checkpoint attempts update TrainingProgress.checkpointClearedJson,
    // never TrainingCompletion.
    if (kind === "CHECKPOINT" && passed && attempt.checkpointId) {
      const progress = await tx.trainingProgress.findFirst({
        where: { employeeId: actor.employeeId, courseVersionId: attempt.courseVersion.id },
      });
      const cleared = parseClearedCheckpointIds(progress?.checkpointClearedJson ?? null);
      cleared.add(attempt.checkpointId);
      await tx.trainingProgress.upsert({
        where: { employeeId_courseVersionId: { employeeId: actor.employeeId, courseVersionId: attempt.courseVersion.id } },
        create: {
          clubId: actor.clubId,
          employeeId: actor.employeeId,
          courseVersionId: attempt.courseVersion.id,
          secondsWatched: 0,
          farthestSecond: 0,
          percentComplete: 0,
          checkpointClearedJson: serialiseClearedCheckpointIds(cleared),
        },
        update: { checkpointClearedJson: serialiseClearedCheckpointIds(cleared) },
      });
    }
    // Final attempts create TrainingCompletion on pass.
    if (kind === "FINAL" && passed) {
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
  let attemptsRemaining: number | undefined;
  if (kind === "CHECKPOINT" && attempt.checkpointId) {
    const cp = await prisma.trainingCheckpoint.findUnique({
      where: { id: attempt.checkpointId },
      select: { maxRetries: true },
    });
    if (cp) {
      const totalAllowed = cp.maxRetries + 1;
      const used = await prisma.trainingAttempt.count({
        where: {
          employeeId: actor.employeeId,
          courseVersionId: attempt.courseVersion.id,
          kind: "CHECKPOINT",
          checkpointId: attempt.checkpointId,
          submittedAt: { not: null },
        },
      });
      attemptsRemaining = Math.max(0, totalAllowed - used);
    }
  }
  return {
    attemptId: attempt.id,
    score,
    passed,
    completionId: result.completionId,
    checkpointCleared: kind === "CHECKPOINT" ? passed : undefined,
    attemptsRemaining,
  };
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
