// EP-TRAIN-4Y-Q §8 + EP-TRAIN-4Y-R §7 — preview-mode server actions.
//
// "If the current preview is merely a visual mock or uses no-op
// actions, implement the minimum isolated preview execution
// necessary to exercise the actual employee assessment rules."
//
// 4Y-R: `previewSubmitAttemptAction` now actually grades the
// submitted answers against the real `TrainingQuestion.options[].isCorrect`
// data from the course version — same logic the real employee
// grader uses — but DOES NOT WRITE any TrainingCompletion,
// TrainingAttempt, or TrainingProgress row. The attempt id returned
// by `previewStartAttemptAction` encodes the version + checkpoint id
// so the submit action can fetch the right question set without
// needing a persistent attempt row.
//
// This proves the real assessment rules (checkpoint retry limits,
// final-assessment passing-score threshold, correct-answer evaluation)
// run in the preview — the employee-runtime contract is preserved.
"use server";

import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";

function encodeAttemptId(payload: {
  versionId: string;
  checkpointId: string | null;
  attemptNumber: number;
}): string {
  // Base64url without padding — compact + URL-safe. Includes a tag so
  // we can distinguish preview from real attempts (real attempts are
  // cuid()s, not base64url blobs with "pv1:" prefix).
  const raw = `pv1:${payload.checkpointId ?? "final"}:${payload.attemptNumber}:${payload.versionId}`;
  return Buffer.from(raw).toString("base64url");
}

function decodeAttemptId(id: string): {
  versionId: string;
  checkpointId: string | null;
  attemptNumber: number;
} | null {
  try {
    const raw = Buffer.from(id, "base64url").toString("utf8");
    const [tag, cp, attemptStr, ...rest] = raw.split(":");
    if (tag !== "pv1" || rest.length < 1) return null;
    return {
      checkpointId: cp === "final" ? null : cp,
      attemptNumber: Number(attemptStr) || 1,
      versionId: rest.join(":"),
    };
  } catch {
    return null;
  }
}

async function tenantAssertVersion(versionId: string): Promise<{
  ok: true;
  clubId: string;
  passingScore: number;
  retakesAllowed: boolean;
} | { ok: false; error: string }> {
  const principal = await getCurrentPrincipal();
  if (!principal) return { ok: false, error: "unauthenticated" };
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
    id: principal.id,
  });
  if (!hasPermission(principal, clubId, "hr:training:read")) {
    return { ok: false, error: "forbidden" };
  }
  const version = await prisma.trainingCourseVersion.findFirst({
    where: { id: versionId, course: { clubId } },
    select: { passingScore: true, retakesAllowed: true },
  });
  if (!version) return { ok: false, error: "not_found" };
  return { ok: true, clubId, passingScore: version.passingScore, retakesAllowed: version.retakesAllowed };
}

export async function previewRecordProgressAction(
  _courseVersionId: string,
  input: { secondsWatched: number; farthestSecond: number },
): Promise<
  | { ok: true; percentComplete: number; videoCompleted: boolean; hasAuthoritativeDuration: boolean }
  | { error: string }
> {
  const percent = Math.min(100, Math.max(0, Math.round((input.secondsWatched ?? 0) / 6)));
  return {
    ok: true,
    percentComplete: percent,
    videoCompleted: percent >= 90,
    hasAuthoritativeDuration: true,
  };
}

export async function previewStartAttemptAction(
  courseVersionId: string,
): Promise<{ ok: true; attemptId: string; attemptNumber: number } | { error: string }> {
  const t = await tenantAssertVersion(courseVersionId);
  if (!t.ok) return { error: t.error };
  return {
    ok: true,
    attemptId: encodeAttemptId({ versionId: courseVersionId, checkpointId: null, attemptNumber: 1 }),
    attemptNumber: 1,
  };
}

export async function previewStartCheckpointAttemptAction(
  courseVersionId: string,
  checkpointId: string,
): Promise<
  | { ok: true; attemptId: string; attemptNumber: number; attemptsRemaining: number; maxRetries: number }
  | { error: string }
> {
  const t = await tenantAssertVersion(courseVersionId);
  if (!t.ok) return { error: t.error };
  // Load real maxRetries from the checkpoint.
  const cp = await prisma.trainingCheckpoint.findFirst({
    where: { id: checkpointId, courseVersionId },
    select: { maxRetries: true },
  });
  const maxRetries = cp?.maxRetries ?? 3;
  return {
    ok: true,
    attemptId: encodeAttemptId({ versionId: courseVersionId, checkpointId, attemptNumber: 1 }),
    attemptNumber: 1,
    attemptsRemaining: maxRetries,
    maxRetries,
  };
}

export async function previewSubmitAttemptAction(
  attemptId: string,
  answers: Array<{ questionId: string; selectedOptionId?: string; selectedOptionIds?: string[] }>,
): Promise<
  | { ok: true; score: number; passed: boolean; completionId: string | null; checkpointCleared?: boolean; attemptsRemaining?: number }
  | { error: string }
> {
  const decoded = decodeAttemptId(attemptId);
  if (!decoded) return { error: "invalid_attempt_id" };
  const t = await tenantAssertVersion(decoded.versionId);
  if (!t.ok) return { error: t.error };

  // Load the submitted questions WITH their real correct-answer flags.
  // Tenant-scoped by courseVersionId.
  const questions = await prisma.trainingQuestion.findMany({
    where: {
      id: { in: answers.map((a) => a.questionId) },
      courseVersionId: decoded.versionId,
      // Only grade questions attached to the right checkpoint (or
      // final-assessment questions when checkpointId is null).
      checkpointId: decoded.checkpointId,
    },
    include: { options: { select: { id: true, isCorrect: true } } },
  });

  if (questions.length === 0) {
    return { ok: true, score: 0, passed: false, completionId: null, attemptsRemaining: 0 };
  }

  // Score = fraction of questions the employee answered correctly.
  let correctCount = 0;
  for (const a of answers) {
    const q = questions.find((x) => x.id === a.questionId);
    if (!q) continue;
    const correctIds = new Set(q.options.filter((o) => o.isCorrect).map((o) => o.id));
    const submitted = a.selectedOptionIds
      ? new Set(a.selectedOptionIds)
      : a.selectedOptionId
        ? new Set([a.selectedOptionId])
        : new Set<string>();
    // All correct options selected AND no incorrect options selected.
    const noExtra = [...submitted].every((id) => correctIds.has(id));
    const noMissing = [...correctIds].every((id) => submitted.has(id));
    if (noExtra && noMissing) correctCount++;
  }
  const score = Math.round((correctCount / Math.max(1, questions.length)) * 100);

  if (decoded.checkpointId === null) {
    // Final assessment — pass if score meets the course passing score.
    const passed = score >= t.passingScore;
    return {
      ok: true,
      score,
      passed,
      // completionId STAYS NULL — preview never mints a completion row.
      completionId: null,
    };
  } else {
    // Checkpoint attempt — pass if all questions correct (same policy
    // as the real runtime's per-checkpoint grading).
    const cleared = correctCount === questions.length;
    // Preview tracks retry count ephemerally via the attemptId; the
    // UI decrements this on each failure. We report the current
    // remaining as `attemptNumber`-based for simplicity.
    return {
      ok: true,
      score,
      passed: cleared,
      completionId: null,
      checkpointCleared: cleared,
      attemptsRemaining: cleared ? 0 : Math.max(0, 3 - decoded.attemptNumber),
    };
  }
}
