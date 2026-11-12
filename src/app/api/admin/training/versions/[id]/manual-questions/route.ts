// EP-TRAIN-4Y-AX §2+§3+§4 (2026-11-11) — POST manually-authored
// training questions directly from the /review workspace.
//
// Manager-authored questions:
//   - Write to TrainingQuestion (NOT TrainingQuestionAiDraft), so the
//     manual question has NO fabricated AI provenance (no grounding
//     projection, no generation run, no pilot authorization).
//   - aiPromotion remains NULL, which is the inherent, structural
//     marker that distinguishes a manager-authored question from an
//     AI-promoted question in every downstream reader.
//   - Reuse the canonical `createQuestion` + `createCheckpoint`
//     services so all existing guarantees apply unchanged: tenant
//     scope, DRAFT-only, `hr:training:write`, posting-guard, structural
//     validation, destination validation, audit entry, draft-version
//     governance. Reviewer SoD is NOT altered (approve / publish gates
//     untouched); manual creation does NOT approve or publish anything.
//
// Body (JSON):
//   {
//     prompt: string,
//     options: Array<{ text: string; isCorrect: boolean }>,
//     questionType: "SINGLE_CHOICE" | "MULTI_ANSWER" | "TRUE_FALSE",
//     destination: "CHECKPOINT" | "FINAL_ASSESSMENT",
//     // When destination === "CHECKPOINT": either checkpointId (to
//     // bind to an existing CP) OR newCheckpoint (to create one).
//     checkpointId?: string,
//     newCheckpoint?: {
//       atSecond: number,              // required, non-negative int
//       label?: string | null,
//       requiredToProceed?: boolean,   // default true
//       maxRetries?: number,           // default 3 (0-10)
//     },
//   }
//
// 200 { ok: true, questionId, checkpointId? }
// 400 { error: "invalid_request", detail: … }
// 401 { error: "unauthenticated" }
// 404 { error: "not_found" }  (cross-tenant, or missing version, or
//                              missing hr:training:write — same-shape
//                              403→404 per the house convention)
// 409 { error: "conflict", message: "Cannot modify questions on a …" }
// 422 { error: "validation_failed", issues: [{path,message},...] }

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import {
  createQuestion,
  TRAINING_QUESTION_TYPES,
  type TrainingQuestionType,
} from "@/lib/hr/training/questions";
import { createCheckpoint } from "@/lib/hr/training/checkpoints";
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

interface RawOption {
  readonly text?: unknown;
  readonly isCorrect?: unknown;
}
interface RawNewCheckpoint {
  readonly atSecond?: unknown;
  readonly label?: unknown;
  readonly requiredToProceed?: unknown;
  readonly maxRetries?: unknown;
}
interface RawBody {
  readonly prompt?: unknown;
  readonly options?: unknown;
  readonly questionType?: unknown;
  readonly destination?: unknown;
  readonly checkpointId?: unknown;
  readonly newCheckpoint?: unknown;
}

function appErrorToResponse(err: AppError): NextResponse {
  if (err instanceof ValidationError) {
    return NextResponse.json(
      { error: "validation_failed", issues: err.issues, message: err.safeMessage },
      { status: 422 },
    );
  }
  if (err instanceof ConflictError) {
    return NextResponse.json(
      { error: "conflict", message: err.safeMessage },
      { status: 409 },
    );
  }
  if (err instanceof NotFoundError) {
    return same404();
  }
  return NextResponse.json(
    { error: "app_error", message: err.safeMessage },
    { status: 400 },
  );
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: versionId } = await context.params;
  if (!versionId) return same404();

  const principal = await getCurrentPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
    id: principal.id,
  });
  if (!hasPermission(principal, clubId, "hr:training:write")) {
    return same404();
  }

  // Tenant ownership: the version must belong to this club. Mismatches
  // are 404 (same-shape as missing) so cross-tenant probing cannot
  // enumerate ids.
  const v = await prisma.trainingCourseVersion.findFirst({
    where: { id: versionId, course: { clubId } },
    select: { id: true, state: true, videoDurationSec: true },
  });
  if (!v) return same404();

  let body: RawBody = {};
  try {
    body = (await req.json()) as RawBody;
  } catch {
    return NextResponse.json(
      { error: "invalid_request", message: "Request body must be JSON." },
      { status: 400 },
    );
  }

  // ─ Validate shape BEFORE the services (they'd throw ValidationError
  //   too, but we want structured 422 for the UI).
  const issues: Array<{ path: string; message: string }> = [];
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt.trim()) issues.push({ path: "prompt", message: "Prompt is required." });
  const questionTypeRaw = typeof body.questionType === "string" ? body.questionType : "";
  if (!TRAINING_QUESTION_TYPES.includes(questionTypeRaw as TrainingQuestionType)) {
    issues.push({
      path: "questionType",
      message: `questionType must be one of ${TRAINING_QUESTION_TYPES.join(", ")}.`,
    });
  }
  const destinationRaw = typeof body.destination === "string" ? body.destination : "";
  if (destinationRaw !== "CHECKPOINT" && destinationRaw !== "FINAL_ASSESSMENT") {
    issues.push({
      path: "destination",
      message: `destination must be CHECKPOINT or FINAL_ASSESSMENT.`,
    });
  }
  const rawOptions = Array.isArray(body.options) ? (body.options as RawOption[]) : [];
  const options = rawOptions.map((o, i) => {
    if (!o || typeof o !== "object") {
      issues.push({ path: `options[${i}]`, message: "Each option must be an object." });
      return { text: "", isCorrect: false };
    }
    return {
      text: typeof o.text === "string" ? o.text : "",
      isCorrect: !!o.isCorrect,
    };
  });
  if (options.length < 2) {
    issues.push({ path: "options", message: "At least 2 options are required." });
  }
  const checkpointIdRaw =
    typeof body.checkpointId === "string" && body.checkpointId.trim().length > 0
      ? body.checkpointId
      : null;
  const newCpRaw =
    body.newCheckpoint && typeof body.newCheckpoint === "object"
      ? (body.newCheckpoint as RawNewCheckpoint)
      : null;

  if (destinationRaw === "CHECKPOINT") {
    if (!checkpointIdRaw && !newCpRaw) {
      issues.push({
        path: "destination",
        message:
          "Checkpoint destination requires either an existing checkpointId or newCheckpoint.atSecond.",
      });
    }
    if (checkpointIdRaw && newCpRaw) {
      issues.push({
        path: "destination",
        message:
          "Provide exactly one of checkpointId or newCheckpoint — not both.",
      });
    }
    if (newCpRaw) {
      if (typeof newCpRaw.atSecond !== "number" || !Number.isFinite(newCpRaw.atSecond) || newCpRaw.atSecond < 0) {
        issues.push({
          path: "newCheckpoint.atSecond",
          message: "newCheckpoint.atSecond must be a non-negative number.",
        });
      }
    }
  }
  if (destinationRaw === "FINAL_ASSESSMENT" && (checkpointIdRaw || newCpRaw)) {
    issues.push({
      path: "destination",
      message:
        "Final-assessment questions must not include a checkpointId or newCheckpoint.",
    });
  }

  if (issues.length > 0) {
    return NextResponse.json({ error: "validation_failed", issues }, { status: 422 });
  }

  const questionType = questionTypeRaw as TrainingQuestionType;

  try {
    // Step 1 (if applicable): create the checkpoint.
    let resolvedCheckpointId: string | null = checkpointIdRaw;
    if (destinationRaw === "CHECKPOINT" && newCpRaw) {
      const cp = await createCheckpoint(principal, versionId, {
        atSecond: Number(newCpRaw.atSecond),
        label:
          typeof newCpRaw.label === "string" && newCpRaw.label.trim().length > 0
            ? newCpRaw.label.trim()
            : null,
        requiredToProceed:
          typeof newCpRaw.requiredToProceed === "boolean" ? newCpRaw.requiredToProceed : true,
        maxRetries:
          typeof newCpRaw.maxRetries === "number" && Number.isFinite(newCpRaw.maxRetries)
            ? Math.max(0, Math.round(newCpRaw.maxRetries))
            : undefined,
      });
      resolvedCheckpointId = cp.checkpointId;
    }

    // Step 2: create the question (manager-authored — aiPromotion stays NULL).
    const result = await createQuestion(principal, versionId, {
      prompt,
      options,
      questionType,
      checkpointId: destinationRaw === "CHECKPOINT" ? resolvedCheckpointId : null,
    });

    return NextResponse.json({
      ok: true,
      questionId: result.questionId,
      checkpointId: resolvedCheckpointId ?? null,
      destination: destinationRaw,
    });
  } catch (err) {
    if (err instanceof AppError) return appErrorToResponse(err);
    throw err;
  }
}
