// EP-TRAIN-4Y-AX §2+§4 (2026-11-11) — PATCH / DELETE for manually-
// authored training questions. Wraps the existing `updateQuestion` +
// `deleteQuestion` services with the standard tenant / permission /
// 403→404 same-shape convention.
//
// This endpoint only accepts operations on MANAGER-AUTHORED questions
// (aiPromotion == null). An AI-promoted question is 404 here: the
// AI lifecycle has its own edit / discard routes and the manual
// endpoint must not be a backdoor into that pipeline.
//
// Body (PATCH, JSON):
//   {
//     prompt?: string,
//     options?: Array<{ id?: string; text: string; isCorrect: boolean }>,
//     questionType?: "SINGLE_CHOICE" | "MULTI_ANSWER" | "TRUE_FALSE",
//     active?: boolean,
//   }

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import {
  updateQuestion,
  deleteQuestion,
  TRAINING_QUESTION_TYPES,
  type TrainingQuestionType,
} from "@/lib/hr/training/questions";
import {
  AppError,
  ValidationError,
  ConflictError,
  NotFoundError,
} from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function same404() {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

function appErrorToResponse(err: AppError): NextResponse {
  if (err instanceof ValidationError) {
    return NextResponse.json(
      { error: "validation_failed", issues: err.issues, message: err.safeMessage },
      { status: 422 },
    );
  }
  if (err instanceof ConflictError) {
    return NextResponse.json({ error: "conflict", message: err.safeMessage }, { status: 409 });
  }
  if (err instanceof NotFoundError) return same404();
  return NextResponse.json(
    { error: "app_error", message: err.safeMessage },
    { status: 400 },
  );
}

async function authorizeAndLoad(
  versionId: string,
  questionId: string,
): Promise<
  | { status: "ok"; clubId: string }
  | { status: "same404" }
  | { status: "unauth" }
> {
  const principal = await getCurrentPrincipal();
  if (!principal) return { status: "unauth" };
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
    id: principal.id,
  });
  if (!hasPermission(principal, clubId, "hr:training:write")) {
    return { status: "same404" };
  }
  const q = await prisma.trainingQuestion.findFirst({
    where: {
      id: questionId,
      courseVersionId: versionId,
      courseVersion: { course: { clubId } },
    },
    select: { id: true, aiPromotion: { select: { questionId: true } } },
  });
  if (!q) return { status: "same404" };
  // Manager-authored only. AI-promoted questions have an aiPromotion row.
  if (q.aiPromotion) return { status: "same404" };
  return { status: "ok", clubId };
}

interface RawPatchBody {
  readonly prompt?: unknown;
  readonly options?: unknown;
  readonly questionType?: unknown;
  readonly active?: unknown;
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string; qid: string }> },
): Promise<NextResponse> {
  const { id: versionId, qid: questionId } = await context.params;
  if (!versionId || !questionId) return same404();

  const principal = await getCurrentPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const auth = await authorizeAndLoad(versionId, questionId);
  if (auth.status === "unauth") {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (auth.status === "same404") return same404();

  let body: RawPatchBody = {};
  try { body = (await req.json()) as RawPatchBody; } catch {
    return NextResponse.json(
      { error: "invalid_request", message: "Request body must be JSON." },
      { status: 400 },
    );
  }

  const input: {
    prompt?: string;
    options?: Array<{ id?: string; text: string; isCorrect: boolean }>;
    questionType?: TrainingQuestionType;
    active?: boolean;
  } = {};
  const issues: Array<{ path: string; message: string }> = [];
  if (body.prompt !== undefined) {
    if (typeof body.prompt !== "string") issues.push({ path: "prompt", message: "Prompt must be a string." });
    else input.prompt = body.prompt;
  }
  if (body.questionType !== undefined) {
    const qt = typeof body.questionType === "string" ? body.questionType : "";
    if (!TRAINING_QUESTION_TYPES.includes(qt as TrainingQuestionType)) {
      issues.push({
        path: "questionType",
        message: `questionType must be one of ${TRAINING_QUESTION_TYPES.join(", ")}.`,
      });
    } else {
      input.questionType = qt as TrainingQuestionType;
    }
  }
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") issues.push({ path: "active", message: "active must be boolean." });
    else input.active = body.active;
  }
  if (body.options !== undefined) {
    if (!Array.isArray(body.options)) {
      issues.push({ path: "options", message: "options must be an array." });
    } else {
      input.options = body.options.map((o, i) => {
        if (!o || typeof o !== "object") {
          issues.push({ path: `options[${i}]`, message: "Each option must be an object." });
          return { text: "", isCorrect: false };
        }
        const row = o as { id?: unknown; text?: unknown; isCorrect?: unknown };
        return {
          id: typeof row.id === "string" ? row.id : undefined,
          text: typeof row.text === "string" ? row.text : "",
          isCorrect: !!row.isCorrect,
        };
      });
    }
  }
  if (issues.length > 0) {
    return NextResponse.json({ error: "validation_failed", issues }, { status: 422 });
  }

  try {
    await updateQuestion(principal, questionId, input);
    return NextResponse.json({ ok: true, questionId });
  } catch (err) {
    if (err instanceof AppError) return appErrorToResponse(err);
    throw err;
  }
}

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ id: string; qid: string }> },
): Promise<NextResponse> {
  const { id: versionId, qid: questionId } = await context.params;
  if (!versionId || !questionId) return same404();

  const principal = await getCurrentPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const auth = await authorizeAndLoad(versionId, questionId);
  if (auth.status === "unauth") {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (auth.status === "same404") return same404();

  try {
    await deleteQuestion(principal, questionId);
    return NextResponse.json({ ok: true, questionId });
  } catch (err) {
    if (err instanceof AppError) return appErrorToResponse(err);
    throw err;
  }
}
