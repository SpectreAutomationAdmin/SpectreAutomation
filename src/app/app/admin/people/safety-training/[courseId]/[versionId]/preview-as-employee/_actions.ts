// EP-TRAIN-4Y-Q §8 — preview-mode no-op server actions.
//
// Satisfies the CoursePlayer client component's action-prop contract
// without ever writing an employee-training row. The functions must
// be defined in a dedicated 'use server' module so the Next.js bundler
// marks them as transferable server actions.
"use server";

export async function previewRecordProgressAction(
  _courseVersionId: string,
  input: { secondsWatched: number; farthestSecond: number },
): Promise<
  | { ok: true; percentComplete: number; videoCompleted: boolean; hasAuthoritativeDuration: boolean }
  | { error: string }
> {
  // Report "progress" without persisting anything. Compute percent
  // from input values so the UI's progress-bar advances; completion
  // flag mirrors the client's local threshold.
  const percent = Math.min(100, Math.max(0, Math.round((input.secondsWatched ?? 0) / 6)));
  return {
    ok: true,
    percentComplete: percent,
    videoCompleted: percent >= 90,
    hasAuthoritativeDuration: true,
  };
}

export async function previewStartAttemptAction(
  _courseVersionId: string,
): Promise<{ ok: true; attemptId: string; attemptNumber: number } | { error: string }> {
  return {
    ok: true,
    attemptId: `preview-attempt-${Date.now()}`,
    attemptNumber: 1,
  };
}

export async function previewSubmitAttemptAction(
  _attemptId: string,
  _answers: Array<{ questionId: string; selectedOptionId?: string; selectedOptionIds?: string[] }>,
): Promise<
  | { ok: true; score: number; passed: boolean; completionId: string | null; checkpointCleared?: boolean; attemptsRemaining?: number }
  | { error: string }
> {
  // Fake pass. Preview explicitly does NOT mint completion rows — the
  // `completionId` is null so the player renders "preview completed"
  // without touching the TrainingCompletion table.
  return {
    ok: true,
    score: 100,
    passed: true,
    completionId: null,
    checkpointCleared: true,
    attemptsRemaining: 3,
  };
}

export async function previewStartCheckpointAttemptAction(
  _courseVersionId: string,
  _checkpointId: string,
): Promise<
  | { ok: true; attemptId: string; attemptNumber: number; attemptsRemaining: number; maxRetries: number }
  | { error: string }
> {
  return {
    ok: true,
    attemptId: `preview-cp-${Date.now()}`,
    attemptNumber: 1,
    attemptsRemaining: 3,
    maxRetries: 3,
  };
}
