// EP-TRAIN-6D-4V (2026-11-06) — POST /api/admin/training/versions/[id]/transcribe
//
// Admin-initiated transcription request. Permission: existing
// hr:training:write (no new RBAC grant).
//
// Response semantics:
//   200  — job accepted (new or idempotent); { jobId, state, idempotent }
//   400  — bad input
//   401  — unauthenticated
//   403  — authenticated but missing hr:training:write (mapped to 404 same-shape)
//   404  — version not found OR cross-tenant
//   409  — conflict (version not DRAFT, video missing, cost cap, duplicate live job)
//   503  — Modal credentials not configured on the environment

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import {
  requestTranscription,
  markQueued,
  JobRejectedError,
} from "@/lib/hr/training/transcription/job-service";
import { enqueue } from "@/lib/queue";
import { AppError, UnauthenticatedError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function same404() {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

export async function POST(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  if (!id) return same404();

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

  try {
    const result = await requestTranscription(principal, clubId, { courseVersionId: id });

    // Transition to QUEUED + enqueue a worker job (only when the row
    // was freshly created; replays leave the existing lifecycle state
    // intact).
    if (!result.idempotent) {
      await markQueued(clubId, result.jobId);
      await enqueue({
        kind: "TRAINING_TRANSCRIBE_VIDEO",
        clubId,
        payload: { jobId: result.jobId },
        maxAttempts: 2,
        idempotencyKey: `training-transcribe:${result.jobId}`,
      });
    }

    return NextResponse.json({
      ok: true,
      jobId: result.jobId,
      state: result.idempotent ? result.state : "QUEUED",
      idempotent: result.idempotent,
    });
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    if (err instanceof JobRejectedError) {
      if (err.rejectionCode === "VERSION_NOT_FOUND") return same404();
      return NextResponse.json(
        {
          error: "job_rejected",
          rejectionCode: err.rejectionCode,
          message: err.safeMessage,
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
