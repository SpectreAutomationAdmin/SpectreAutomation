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
} from "@/lib/hr/training/courses";
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

  try {
    await updateDraft(principal, versionId, patch);
    revalidatePath(backHref);
    redirect(backHref);
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
