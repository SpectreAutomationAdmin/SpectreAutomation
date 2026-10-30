// HR-2C B3 §5-14 (2026-08-20) — Employee Portal training server actions.
//
// Thin wrappers over the canonical B1 attempt service. Every action:
//   1. Loads the EmployeePortalPrincipal from the permanent cookie.
//      Absent principal → refuse; the client sees the same not-found
//      shape it would see for any other unauthenticated write.
//   2. Delegates to `@/lib/hr/training/attempts` — the service is the
//      only place that decides pass/fail, enforces the video threshold,
//      persists progress, or writes a TrainingCompletion. This file
//      NEVER grades, NEVER touches prisma directly, and NEVER trusts
//      a browser-provided score / passed / wasCorrect flag (§10, §27).
//   3. On success returns a small shape the player can render off; on
//      failure returns { error } so the client can show it inline.
//
// revalidatePath("/employee/safety-training") is called on any state
// transition (progress crossing the video threshold, attempt submission)
// so the dashboard's grouped counts reflect the change immediately (§11).

"use server";

import { revalidatePath } from "next/cache";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import {
  recordVideoProgress,
  startAttempt,
  submitAttempt,
  startCheckpointAttempt,
} from "@/lib/hr/training/attempts";
import { isAppError, ValidationError } from "@/lib/errors";

interface ActionErr { error: string }

async function requirePortal() {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) throw new Error("PORTAL_REQUIRED");
  return principal;
}

function toErr(e: unknown): ActionErr {
  if (e instanceof ValidationError) {
    return { error: e.issues[0]?.message ?? e.safeMessage };
  }
  if (isAppError(e)) return { error: e.safeMessage };
  if (e instanceof Error && e.message === "PORTAL_REQUIRED") {
    return { error: "Your session has expired. Please sign in again." };
  }
  return { error: "Something went wrong. Please try again." };
}

// ---------------------------------------------------------------------------
// Video progress
// ---------------------------------------------------------------------------

export async function recordVideoProgressAction(
  courseVersionId: string,
  input: { secondsWatched: number; farthestSecond: number },
): Promise<
  | { ok: true; percentComplete: number; videoCompleted: boolean }
  | ActionErr
> {
  try {
    const actor = await requirePortal();
    const result = await recordVideoProgress(actor, {
      courseVersionId,
      secondsWatched: input.secondsWatched,
      farthestSecond: input.farthestSecond,
    });
    // If crossing the threshold, refresh the dashboard so the
    // status flips from "In progress" → "Ready for knowledge test".
    if (result.videoCompleted) {
      revalidatePath("/employee/safety-training");
    }
    return { ok: true, ...result };
  } catch (e) {
    return toErr(e);
  }
}

// ---------------------------------------------------------------------------
// Start attempt
// ---------------------------------------------------------------------------

export async function startAttemptAction(
  courseVersionId: string,
): Promise<
  | { ok: true; attemptId: string; attemptNumber: number }
  | ActionErr
> {
  try {
    const actor = await requirePortal();
    const result = await startAttempt(actor, { courseVersionId });
    return { ok: true, ...result };
  } catch (e) {
    return toErr(e);
  }
}

// ---------------------------------------------------------------------------
// Submit attempt (server grades)
// ---------------------------------------------------------------------------

export async function submitAttemptAction(
  attemptId: string,
  answers: Array<{
    questionId: string;
    selectedOptionId?: string;
    selectedOptionIds?: string[];
  }>,
): Promise<
  | { ok: true; score: number; passed: boolean; completionId: string | null; checkpointCleared?: boolean; attemptsRemaining?: number }
  | ActionErr
> {
  try {
    const actor = await requirePortal();
    // Coerce shape (defense against a doctored payload): drop anything
    // the browser tried to slip in (score, wasCorrect, passed, etc.).
    const clean = Array.isArray(answers)
      ? answers
          .filter((a) => a && typeof a.questionId === "string")
          .map((a) => ({
            questionId: a.questionId,
            selectedOptionId: typeof a.selectedOptionId === "string" ? a.selectedOptionId : undefined,
            selectedOptionIds: Array.isArray(a.selectedOptionIds)
              ? a.selectedOptionIds.filter((x): x is string => typeof x === "string")
              : undefined,
          }))
      : [];
    const result = await submitAttempt(actor, { attemptId, answers: clean });
    revalidatePath("/employee/safety-training");
    return {
      ok: true,
      score: result.score,
      passed: result.passed,
      completionId: result.completionId,
      checkpointCleared: result.checkpointCleared,
      attemptsRemaining: result.attemptsRemaining,
    };
  } catch (e) {
    return toErr(e);
  }
}

// EP-TRAIN-3 Slice 3 (2026-10-29): checkpoint attempt lifecycle
export async function startCheckpointAttemptAction(
  courseVersionId: string,
  checkpointId: string,
): Promise<
  | { ok: true; attemptId: string; attemptNumber: number; attemptsRemaining: number; maxRetries: number }
  | ActionErr
> {
  try {
    const actor = await requirePortal();
    const result = await startCheckpointAttempt(actor, { courseVersionId, checkpointId });
    return { ok: true, ...result };
  } catch (e) {
    return toErr(e);
  }
}
