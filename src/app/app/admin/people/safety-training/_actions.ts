// HR-2C B2 (2026-08-20) — Safety & Training admin server actions.
//
// EVERY mutation flows through the canonical B1 service under
// `src/lib/hr/training/**`. No direct Prisma writes here (§25).
// Errors flow back either as a `{ ok: false, error }` result (for
// form-status wrappers) or via a `?err=` search param on redirect
// (for full-page navigations).

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { isAppError, ValidationError } from "@/lib/errors";
import {
  createCourse,
  updateDraft,
  publishDraft,
  retireCourse,
  startNewDraft,
  restoreCourse,
  deleteDraftCourse,
  deleteDraftVersion,
  permanentlyDeleteCourse,
} from "@/lib/hr/training/courses";
import { logger } from "@/lib/observability/logger";
import { remediateVideoFastStart } from "@/lib/hr/training/video";
import {
  createQuestion,
  updateQuestion,
  deleteQuestion,
  reorderQuestions,
  TRAINING_QUESTION_TYPES,
  type TrainingQuestionType,
} from "@/lib/hr/training/questions";
import {
  createCheckpoint,
  updateCheckpoint,
  deleteCheckpoint,
} from "@/lib/hr/training/checkpoints";
import {
  publishDraftWithPolicy,
  previewRetakeTargets,
  issueManualReinstatement,
  type RevisionPolicy,
  type RetakeConflictResolution,
} from "@/lib/hr/training/revisions";

function withErr(path: string, safeMessage: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}err=${encodeURIComponent(safeMessage)}`;
}

function firstIssueMessage(err: unknown): string | null {
  if (isAppError(err) && "issues" in err) {
    const issues = (err as unknown as { issues: Array<{ message: string }> }).issues;
    if (Array.isArray(issues) && issues.length > 0) return issues[0]?.message ?? null;
  }
  return null;
}

async function requirePrincipal() {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  return p!;
}

// ---------------------------------------------------------------------------
// Create course
// ---------------------------------------------------------------------------

export async function createCourseAction(clubId: string, formData: FormData): Promise<void> {
  const principal = await requirePrincipal();
  const code = (formData.get("code") as string | null)?.trim() ?? "";
  const title = (formData.get("title") as string | null)?.trim() ?? "";
  const category = (formData.get("category") as string | null)?.trim() ?? "";
  const description = ((formData.get("description") as string | null) ?? "").trim() || null;
  const requiredRaw = (formData.get("required") as string | null) ?? "on";
  const applicabilityMode = (formData.get("applicabilityMode") as string | null) ?? "everyone";

  const backHref = "/app/admin/people/safety-training/new";
  if (!code || !title || !category) {
    redirect(withErr(backHref, "Course code, title, and category are all required."));
  }
  try {
    const { courseId, versionId } = await createCourse(principal, clubId, {
      code,
      title,
      category,
      description,
      version1Defaults: {
        required: requiredRaw === "on",
        appliesToAll: applicabilityMode === "everyone",
      },
    });
    revalidatePath("/app/admin/people/safety-training");
    redirect(`/app/admin/people/safety-training/${courseId}/${versionId}`);
  } catch (err) {
    if (isAppError(err)) {
      redirect(withErr(backHref, firstIssueMessage(err) ?? err.safeMessage));
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Update DRAFT (title/description/category/required/applicability/passingScore/retakes/requiresKnowledgeTest)
// ---------------------------------------------------------------------------

export async function updateDraftAction(
  courseId: string,
  versionId: string,
  formData: FormData,
): Promise<void> {
  const principal = await requirePrincipal();
  const patch: Parameters<typeof updateDraft>[2] = {};
  const backHref = `/app/admin/people/safety-training/${courseId}/${versionId}`;

  const title = formData.get("title");
  if (typeof title === "string") patch.title = title;
  const description = formData.get("description");
  if (typeof description === "string") patch.description = description || null;
  const passingScoreRaw = formData.get("passingScore");
  if (typeof passingScoreRaw === "string" && passingScoreRaw.length > 0) {
    const n = Number(passingScoreRaw);
    if (!Number.isFinite(n)) redirect(withErr(backHref, "Passing score must be a number."));
    patch.passingScore = Math.round(n);
  }
  const retakesRaw = formData.get("retakesAllowed");
  if (retakesRaw !== null) patch.retakesAllowed = retakesRaw === "on";
  const requiredRaw = formData.get("required");
  if (requiredRaw !== null) patch.required = requiredRaw === "on";
  const requiresKtRaw = formData.get("requiresKnowledgeTest");
  if (requiresKtRaw !== null) patch.requiresKnowledgeTest = requiresKtRaw === "on";

  const applicabilityMode = formData.get("applicabilityMode");
  if (typeof applicabilityMode === "string") {
    if (applicabilityMode === "everyone") {
      patch.appliesToAll = true;
      patch.appliesToDeptIds = null;
      patch.appliesToPositionIds = null;
    } else if (applicabilityMode === "scoped") {
      patch.appliesToAll = false;
      const dept = formData.getAll("appliesToDeptIds").map(String).filter(Boolean);
      const pos = formData.getAll("appliesToPositionIds").map(String).filter(Boolean);
      patch.appliesToDeptIds = dept.length ? dept : null;
      patch.appliesToPositionIds = pos.length ? pos : null;
    } else if (applicabilityMode === "explicit") {
      patch.appliesToAll = false;
      patch.appliesToDeptIds = null;
      patch.appliesToPositionIds = null;
    }
  }

  // EP-TRAIN-4Y-T §8 — allow callers to steer the post-save redirect
  // (e.g. the Training Requirements page wants to hand off to the
  // Publish Review step). Only accept in-app training paths to avoid
  // open-redirect risk.
  const nextHrefRaw = formData.get("_nextHref");
  const nextHref =
    typeof nextHrefRaw === "string" &&
    nextHrefRaw.startsWith("/app/admin/people/safety-training/")
      ? nextHrefRaw
      : backHref;

  try {
    await updateDraft(principal, versionId, patch);
    revalidatePath(backHref);
    redirect(nextHref);
  } catch (err) {
    if (isAppError(err)) {
      redirect(withErr(backHref, firstIssueMessage(err) ?? err.safeMessage));
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Publish + Retire + New Draft
// ---------------------------------------------------------------------------

export async function publishDraftAction(
  courseId: string,
  versionId: string,
): Promise<void> {
  const principal = await requirePrincipal();
  const backHref = `/app/admin/people/safety-training/${courseId}/${versionId}`;
  try {
    await publishDraft(principal, versionId);
    revalidatePath(`/app/admin/people/safety-training/${courseId}`);
    revalidatePath("/app/admin/people/safety-training");
    redirect(`/app/admin/people/safety-training/${courseId}`);
  } catch (err) {
    if (err instanceof ValidationError) {
      const first = err.issues[0]?.message ?? err.safeMessage;
      redirect(withErr(backHref, first));
    }
    if (isAppError(err)) redirect(withErr(backHref, err.safeMessage));
    throw err;
  }
}

export async function retireCourseAction(courseId: string): Promise<void> {
  const principal = await requirePrincipal();
  try {
    await retireCourse(principal, courseId);
    revalidatePath("/app/admin/people/safety-training");
    redirect("/app/admin/people/safety-training");
  } catch (err) {
    if (isAppError(err)) {
      redirect(withErr("/app/admin/people/safety-training", err.safeMessage));
    }
    throw err;
  }
}

// EP-TRAIN-4E B3 (2026-10-31): archive = the existing retire flow with
// no re-published side effect.  Separate action name so UI callers can
// label it "Archive" without changing the service's historical
// retireCourse semantics.
export async function archiveCourseAction(
  courseId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const principal = await requirePrincipal();
  try {
    await retireCourse(principal, courseId);
    revalidatePath("/app/admin/people/safety-training");
    return { ok: true };
  } catch (err) {
    if (isAppError(err)) return { ok: false, error: err.safeMessage };
    throw err;
  }
}

// EP-TRAIN-4E B3 (2026-10-31): restore = clear retiredAt, promote the
// most-recently-published version back to PUBLISHED.  Idempotent.
export async function restoreCourseAction(
  courseId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const principal = await requirePrincipal();
  try {
    await restoreCourse(principal, courseId);
    revalidatePath("/app/admin/people/safety-training");
    return { ok: true };
  } catch (err) {
    if (isAppError(err)) return { ok: false, error: err.safeMessage };
    throw err;
  }
}

// EP-TRAIN-4E B2 (2026-10-31): hard-delete a never-published draft
// with zero legitimate training history.  Server-side dependency check
// refuses any deletion that would destroy employee evidence.
//
// EP-TRAIN-4Y-AC §6 (2026-11-10): catch EVERY exception (not only
// AppError). An unhandled Prisma FK-restrict error here was the
// origin of digest 1445682726 — it bubbled past this handler and
// tripped the dashboard's error boundary, giving the manager the
// "Application error: a server-side exception has occurred" page
// instead of an actionable inline message. The service-layer fix in
// `deleteDraftCourse` cleans AI-generation children in-tx; this
// handler is the backstop so any FUTURE surprise (new child table
// added without a cascade, transient DB error, …) is logged with a
// correlation id and returned as a safe error to the client — never
// re-thrown to Next.js.
export async function deleteDraftCourseAction(
  courseId: string,
): Promise<{ ok: true } | { ok: false; error: string; correlationId?: string }> {
  const principal = await requirePrincipal();
  try {
    await deleteDraftCourse(principal, courseId);
    revalidatePath("/app/admin/people/safety-training");
    return { ok: true };
  } catch (err) {
    if (isAppError(err)) return { ok: false, error: err.safeMessage };
    const correlationId = `dd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    logger.error("hr.training.course.delete-draft.unexpected", {
      courseId,
      correlationId,
      errorName: (err as Error)?.name,
      errorMessage: (err as Error)?.message,
      errorCode: (err as { code?: string })?.code,
    });
    return {
      ok: false,
      error: `Delete failed due to an unexpected error. Please try again or share this reference with support: ${correlationId}`,
      correlationId,
    };
  }
}

// EP-TRAIN-4Y-AC §3B (2026-11-10): delete a single DRAFT version
// without touching its parent course. Preserves PUBLISHED versions +
// every employee-training evidence row attached to them.
export async function deleteDraftVersionAction(
  versionId: string,
): Promise<{ ok: true } | { ok: false; error: string; correlationId?: string }> {
  const principal = await requirePrincipal();
  try {
    await deleteDraftVersion(principal, versionId);
    revalidatePath("/app/admin/people/safety-training");
    return { ok: true };
  } catch (err) {
    if (isAppError(err)) return { ok: false, error: err.safeMessage };
    const correlationId = `ddv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    logger.error("hr.training.version.delete-draft.unexpected", {
      versionId,
      correlationId,
      errorName: (err as Error)?.name,
      errorMessage: (err as Error)?.message,
      errorCode: (err as { code?: string })?.code,
    });
    return {
      ok: false,
      error: `Delete failed due to an unexpected error. Please try again or share this reference with support: ${correlationId}`,
      correlationId,
    };
  }
}

// EP-TRAIN-4E B4 (2026-10-31): hard-delete a course regardless of
// state when (and ONLY when) zero legitimate training records
// reference it.  For disposable test courses on staging/dev.
//
// EP-TRAIN-4Y-AC §6 (2026-11-10): same catch-all pattern as
// deleteDraftCourseAction — never let an unhandled Prisma or runtime
// error bubble past the action.
export async function permanentlyDeleteCourseAction(
  courseId: string,
): Promise<{ ok: true } | { ok: false; error: string; correlationId?: string }> {
  const principal = await requirePrincipal();
  try {
    await permanentlyDeleteCourse(principal, courseId);
    revalidatePath("/app/admin/people/safety-training");
    return { ok: true };
  } catch (err) {
    if (isAppError(err)) return { ok: false, error: err.safeMessage };
    const correlationId = `pd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    logger.error("hr.training.course.delete-permanent.unexpected", {
      courseId,
      correlationId,
      errorName: (err as Error)?.name,
      errorMessage: (err as Error)?.message,
      errorCode: (err as { code?: string })?.code,
    });
    return {
      ok: false,
      error: `Permanent delete failed due to an unexpected error. Please try again or share this reference with support: ${correlationId}`,
      correlationId,
    };
  }
}

export async function startNewDraftAction(courseId: string): Promise<void> {
  const principal = await requirePrincipal();
  try {
    const { versionId } = await startNewDraft(principal, courseId);
    revalidatePath(`/app/admin/people/safety-training/${courseId}`);
    redirect(`/app/admin/people/safety-training/${courseId}/${versionId}`);
  } catch (err) {
    if (isAppError(err)) {
      redirect(withErr(`/app/admin/people/safety-training/${courseId}`, err.safeMessage));
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Question authoring (draft-only)
// ---------------------------------------------------------------------------

function parseQuestionType(raw: string | null | undefined): TrainingQuestionType {
  if (!raw) return "SINGLE_CHOICE";
  return (TRAINING_QUESTION_TYPES as readonly string[]).includes(raw)
    ? (raw as TrainingQuestionType)
    : "SINGLE_CHOICE";
}

function parseCorrectIndices(raw: string | null | undefined): Set<number> {
  if (!raw) return new Set<number>();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isInteger(n)),
  );
}

export async function createQuestionAction(
  courseId: string,
  versionId: string,
  formData: FormData,
): Promise<void> {
  const principal = await requirePrincipal();
  const prompt = (formData.get("prompt") as string | null)?.trim() ?? "";
  const optionTexts = formData.getAll("optionText").map(String);
  const questionType = parseQuestionType(formData.get("questionType") as string | null);
  const checkpointId = (formData.get("checkpointId") as string | null)?.trim() || null;
  const correctIdxRaw = (formData.get("correctIdx") as string | null) ?? "";
  const correctIdxs = parseCorrectIndices(formData.get("correctIdxs") as string | null);
  const backHref = `/app/admin/people/safety-training/${courseId}/${versionId}`;
  // SINGLE_CHOICE + TRUE_FALSE use a single radio (correctIdx);
  // MULTI_ANSWER uses a comma-joined list (correctIdxs).
  const options = optionTexts.map((text, i) => ({
    text: text.trim(),
    isCorrect: questionType === "MULTI_ANSWER"
      ? correctIdxs.has(i)
      : String(i) === correctIdxRaw,
  }));
  try {
    await createQuestion(principal, versionId, { prompt, options, questionType, checkpointId });
    revalidatePath(backHref);
    redirect(backHref);
  } catch (err) {
    if (isAppError(err)) {
      redirect(withErr(backHref, firstIssueMessage(err) ?? err.safeMessage));
    }
    throw err;
  }
}

export async function updateQuestionAction(
  courseId: string,
  versionId: string,
  questionId: string,
  formData: FormData,
): Promise<void> {
  const principal = await requirePrincipal();
  const prompt = (formData.get("prompt") as string | null)?.trim();
  const optionIds = formData.getAll("optionId").map(String);
  const optionTexts = formData.getAll("optionText").map(String);
  const questionTypeRaw = formData.get("questionType") as string | null;
  const questionType = questionTypeRaw ? parseQuestionType(questionTypeRaw) : undefined;
  const effectiveType: TrainingQuestionType = questionType ?? "SINGLE_CHOICE";
  const correctIdxRaw = (formData.get("correctIdx") as string | null) ?? "";
  const correctIdxs = parseCorrectIndices(formData.get("correctIdxs") as string | null);
  const backHref = `/app/admin/people/safety-training/${courseId}/${versionId}`;
  const options = optionTexts.map((text, i) => ({
    id: optionIds[i] || undefined,
    text: text.trim(),
    isCorrect: effectiveType === "MULTI_ANSWER"
      ? correctIdxs.has(i)
      : String(i) === correctIdxRaw,
  }));
  try {
    await updateQuestion(principal, questionId, {
      prompt: prompt ?? undefined,
      options: options.length ? options : undefined,
      questionType,
    });
    revalidatePath(backHref);
    redirect(backHref);
  } catch (err) {
    if (isAppError(err)) {
      redirect(withErr(backHref, firstIssueMessage(err) ?? err.safeMessage));
    }
    throw err;
  }
}

export async function deleteQuestionAction(
  courseId: string,
  versionId: string,
  questionId: string,
): Promise<void> {
  const principal = await requirePrincipal();
  const backHref = `/app/admin/people/safety-training/${courseId}/${versionId}`;
  try {
    await deleteQuestion(principal, questionId);
    revalidatePath(backHref);
    redirect(backHref);
  } catch (err) {
    if (isAppError(err)) {
      redirect(withErr(backHref, err.safeMessage));
    }
    throw err;
  }
}

export async function reorderQuestionsAction(
  courseId: string,
  versionId: string,
  orderedIdsJson: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const principal = await requirePrincipal();
  try {
    const orderedIds = JSON.parse(orderedIdsJson) as string[];
    await reorderQuestions(principal, versionId, orderedIds);
    revalidatePath(`/app/admin/people/safety-training/${courseId}/${versionId}`);
    return { ok: true };
  } catch (err) {
    if (isAppError(err)) return { ok: false, error: err.safeMessage };
    return { ok: false, error: "Reorder failed" };
  }
}

// ---------------------------------------------------------------------------
// EP-TRAIN-3 Slice 2: Checkpoint authoring (draft-only)
// ---------------------------------------------------------------------------

export async function createCheckpointAction(
  courseId: string,
  versionId: string,
  formData: FormData,
): Promise<{ ok: true; checkpointId: string } | { ok: false; error: string }> {
  const principal = await requirePrincipal();
  const atSecondRaw = formData.get("atSecond");
  const atSecond = Number(atSecondRaw);
  if (!Number.isFinite(atSecond) || atSecond < 0) {
    return { ok: false, error: "Checkpoint position must be a non-negative number." };
  }
  const label = ((formData.get("label") as string | null) ?? "").trim() || null;
  const requiredToProceedRaw = formData.get("requiredToProceed");
  const requiredToProceed = requiredToProceedRaw === "false" ? false : true;
  const maxRetriesRaw = formData.get("maxRetries");
  const maxRetries = maxRetriesRaw !== null && maxRetriesRaw !== ""
    ? Number(maxRetriesRaw)
    : undefined;
  try {
    const result = await createCheckpoint(principal, versionId, {
      atSecond,
      label,
      requiredToProceed,
      maxRetries,
    });
    revalidatePath(`/app/admin/people/safety-training/${courseId}/${versionId}`);
    return { ok: true, checkpointId: result.checkpointId };
  } catch (err) {
    if (isAppError(err)) {
      return { ok: false, error: firstIssueMessage(err) ?? err.safeMessage };
    }
    throw err;
  }
}

export async function updateCheckpointAction(
  courseId: string,
  versionId: string,
  checkpointId: string,
  formData: FormData,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const principal = await requirePrincipal();
  const atSecondRaw = formData.get("atSecond");
  const labelRaw = formData.get("label");
  const requiredToProceedRaw = formData.get("requiredToProceed");
  const maxRetriesRaw = formData.get("maxRetries");
  const patch: Parameters<typeof updateCheckpoint>[2] = {};
  if (atSecondRaw !== null && atSecondRaw !== "") {
    const n = Number(atSecondRaw);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: "Checkpoint position must be a non-negative number." };
    }
    patch.atSecond = n;
  }
  if (labelRaw !== null) {
    const s = String(labelRaw).trim();
    patch.label = s.length === 0 ? null : s;
  }
  if (requiredToProceedRaw !== null) {
    patch.requiredToProceed = requiredToProceedRaw !== "false";
  }
  if (maxRetriesRaw !== null && maxRetriesRaw !== "") {
    const n = Number(maxRetriesRaw);
    if (!Number.isInteger(n) || n < 0) {
      return { ok: false, error: "Maximum retries must be a non-negative integer." };
    }
    patch.maxRetries = n;
  }
  try {
    await updateCheckpoint(principal, checkpointId, patch);
    revalidatePath(`/app/admin/people/safety-training/${courseId}/${versionId}`);
    return { ok: true };
  } catch (err) {
    if (isAppError(err)) {
      return { ok: false, error: firstIssueMessage(err) ?? err.safeMessage };
    }
    throw err;
  }
}

// EP-TRAIN-3 Slice 3B (2026-10-30): legacy video fast-start remediation
export async function optimizeVideoAction(
  courseId: string,
  versionId: string,
): Promise<{ ok: true; state: string; previousSizeBytes: number; newSizeBytes: number | null; note: string } | { ok: false; error: string }> {
  const principal = await requirePrincipal();
  try {
    const result = await remediateVideoFastStart(principal, versionId);
    revalidatePath(`/app/admin/people/safety-training/${courseId}/${versionId}`);
    return {
      ok: true,
      state: result.state,
      previousSizeBytes: result.previousSizeBytes,
      newSizeBytes: result.newSizeBytes,
      note: result.note,
    };
  } catch (err) {
    if (isAppError(err)) return { ok: false, error: err.safeMessage };
    throw err;
  }
}

export async function deleteCheckpointAction(
  courseId: string,
  versionId: string,
  checkpointId: string,
  opts: { deleteBoundQuestions?: boolean } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const principal = await requirePrincipal();
  try {
    await deleteCheckpoint(principal, checkpointId, {
      deleteBoundQuestions: opts.deleteBoundQuestions === true,
    });
    revalidatePath(`/app/admin/people/safety-training/${courseId}/${versionId}`);
    return { ok: true };
  } catch (err) {
    if (isAppError(err)) {
      return { ok: false, error: err.safeMessage };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// EP-TRAIN-5B (2026-11-01) — Revise Training (publish-with-policy) +
// Require Retake administrative workflows.
// ---------------------------------------------------------------------------

/** Publish a DRAFT with one of three policies.  Issues REVISION
 *  obligations per the resolved target set.  v1 publishes record the
 *  policy in audit but do not issue obligations (no prior to supersede). */
export async function publishDraftWithPolicyAction(
  courseId: string,
  versionId: string,
  formData: FormData,
): Promise<{ ok: true; eventId: string; affectedCount: number; skippedCount: number } | { ok: false; error: string }> {
  const principal = await requirePrincipal();
  const policyRaw = (formData.get("policy") as string | null)?.trim() ?? "";
  const validPolicies: RevisionPolicy[] = ["ALL_APPLICABLE", "NON_COMPLETERS", "SELECTED"];
  if (!(validPolicies as string[]).includes(policyRaw)) {
    return { ok: false, error: `Select a publication policy.` };
  }
  const policy = policyRaw as RevisionPolicy;
  const selectedRaw = formData.getAll("selectedEmployeeId").map(String).filter(Boolean);
  try {
    const result = await publishDraftWithPolicy({
      principal,
      versionId,
      policy,
      selectedEmployeeIds: policy === "SELECTED" ? selectedRaw : undefined,
    });
    revalidatePath(`/app/admin/people/safety-training/${courseId}`);
    revalidatePath(`/app/admin/people/safety-training`);
    return {
      ok: true,
      eventId: result.eventId,
      affectedCount: result.affectedEmployeeIds.length,
      skippedCount: result.skippedEmployeeIds.length,
    };
  } catch (err) {
    if (isAppError(err)) {
      return { ok: false, error: firstIssueMessage(err) ?? err.safeMessage };
    }
    throw err;
  }
}

/** Read-only preview for the Require Retake confirmation dialog.
 *  Returns per-employee latest completion + any OUTSTANDING
 *  obligations currently in place, so the manager sees the full
 *  conflict picture before confirming. */
export async function previewRetakeAction(
  courseId: string,
  employeeIdsJson: string,
): Promise<
  | { ok: true; preview: Awaited<ReturnType<typeof previewRetakeTargets>> }
  | { ok: false; error: string }
> {
  const principal = await requirePrincipal();
  let employeeIds: string[] = [];
  try {
    const parsed = JSON.parse(employeeIdsJson);
    if (Array.isArray(parsed)) employeeIds = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return { ok: false, error: "Invalid employee selection payload." };
  }
  try {
    const preview = await previewRetakeTargets({ principal, courseId, employeeIds });
    return { ok: true, preview };
  } catch (err) {
    if (isAppError(err)) return { ok: false, error: firstIssueMessage(err) ?? err.safeMessage };
    throw err;
  }
}

/** Issue MANUAL_REINSTATE obligations for the selected employees
 *  with a mandatory reason + optional due date.  One server-side
 *  event id per confirmed submission -> idempotent against double-
 *  click; a separate submission creates a separate authorized event
 *  per EP-TRAIN-5A-1 semantics.
 *
 *  EP-TRAIN-5B-1 — accepts a per-employee conflictResolution map
 *  for employees who already have an OUTSTANDING obligation on the
 *  course.  The form fields are named "conflictResolution:<employeeId>"
 *  and hold "KEEP_BOTH" or "REPLACE".
 */
export async function requireRetakeAction(
  courseId: string,
  formData: FormData,
): Promise<
  | { ok: true; eventId: string; obligationCount: number; canceledPriorCount: number; keptBothCount: number }
  | { ok: false; error: string }
> {
  const principal = await requirePrincipal();
  const employeeIds = formData.getAll("employeeId").map(String).filter(Boolean);
  const reason = ((formData.get("reason") as string | null) ?? "").trim();
  const dueAtRaw = ((formData.get("dueAt") as string | null) ?? "").trim();
  const dueAt = dueAtRaw ? new Date(dueAtRaw) : null;
  if (dueAt && Number.isNaN(dueAt.getTime())) {
    return { ok: false, error: "Due date is not a valid date." };
  }
  // EP-TRAIN-5B-1 — collect per-employee conflict resolutions from
  // "conflictResolution:<employeeId>" form entries.
  const conflictResolution: Record<string, RetakeConflictResolution> = {};
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("conflictResolution:")) continue;
    const empId = key.slice("conflictResolution:".length);
    const v = String(value).trim();
    if (v === "KEEP_BOTH" || v === "REPLACE") conflictResolution[empId] = v;
  }
  try {
    const result = await issueManualReinstatement({
      principal, courseId, employeeIds, reason, dueAt,
      conflictResolution,
    });
    revalidatePath(`/app/admin/people/safety-training/${courseId}`);
    return {
      ok: true,
      eventId: result.eventId,
      obligationCount: result.obligationIds.length,
      canceledPriorCount: result.perEmployee.reduce((n, p) => n + p.canceledObligationIds.length, 0),
      keptBothCount: result.perEmployee.filter((p) => p.conflictResolution === "KEEP_BOTH").length,
    };
  } catch (err) {
    if (isAppError(err)) return { ok: false, error: firstIssueMessage(err) ?? err.safeMessage };
    throw err;
  }
}
