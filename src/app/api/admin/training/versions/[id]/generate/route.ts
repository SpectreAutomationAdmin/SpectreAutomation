// EP-TRAIN-6D-4W (2026-11-06) — POST /api/admin/training/versions/[id]/generate
//
// Admin-initiated question generation. Permission: existing
// hr:training:write. No new RBAC grant. Accepts an optional
// targetTotalQuestions (default 6) and builds a deterministic
// baseline assessment plan server-side.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import {
  buildPlanAndRequestGeneration,
  BuildAndEnqueueRejected,
} from "@/lib/hr/training/generation/enqueue-helper";
import { AppError, UnauthenticatedError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function same404() {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

interface RawBody {
  readonly targetTotalQuestions?: unknown;
  readonly resolvedTranscriptBuildId?: unknown;
  // EP-TRAIN-4Y-V (2026-11-09) — pilot-only plan-shape overrides.
  readonly checkpointCount?: unknown;
  readonly finalCount?: unknown;
  readonly checkpointGroupStrategy?: unknown;
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

  let body: RawBody = {};
  try {
    body = (await req.json()) as RawBody;
  } catch {
    // Allow empty body (use defaults).
  }
  const targetTotalQuestions =
    typeof body.targetTotalQuestions === "number" ? body.targetTotalQuestions : undefined;
  const resolvedTranscriptBuildId =
    typeof body.resolvedTranscriptBuildId === "string" ? body.resolvedTranscriptBuildId : undefined;
  const checkpointCount =
    typeof body.checkpointCount === "number" ? body.checkpointCount : undefined;
  const finalCount =
    typeof body.finalCount === "number" ? body.finalCount : undefined;
  const checkpointGroupStrategy =
    body.checkpointGroupStrategy === "DEFAULT" || body.checkpointGroupStrategy === "ONE_PER_GROUP"
      ? body.checkpointGroupStrategy
      : undefined;

  try {
    const result = await buildPlanAndRequestGeneration(principal, {
      clubId,
      courseVersionId: versionId,
      resolvedTranscriptBuildId,
      targetTotalQuestions,
      checkpointCount,
      finalCount,
      checkpointGroupStrategy,
    });
    return NextResponse.json({
      ok: true,
      generationRunId: result.generationRunId,
      state: result.state,
      idempotent: result.idempotent,
      planIdentity: result.planIdentity,
    });
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    if (err instanceof BuildAndEnqueueRejected) {
      if (err.rejectionCode === "VERSION_NOT_FOUND") return same404();
      return NextResponse.json(
        {
          error: "generation_rejected",
          rejectionCode: err.rejectionCode,
          message: err.message,
          detail: err.detail,
        },
        { status: err.httpStatus },
      );
    }
    if (err instanceof AppError) {
      return NextResponse.json(
        { error: err.code, message: err.safeMessage },
        { status: err.httpStatus },
      );
    }
    throw err;
  }
}
