// EP-TRAIN-4Y-AY §2 — POST /api/admin/training/versions/[id]/start-preparation
//
// Controlled-recovery endpoint. A single, manager-authorised entry
// point that enqueues transcription for an uploaded video whose
// preparation is stalled.
//
// This exists because the historical auto-prepare endpoint reports
// WOULD_ENQUEUE without ever enqueueing (comment in that file: "In
// a non-mock build this is where enqueue() would run"). A manager
// who uploads a video today sees the preparation UI stuck on the
// "Preparing video" stage because no code path creates a
// TrainingTranscriptionJob row for the uploaded sha. This route is
// the mechanism the UI calls when the manager is ready to proceed
// AND the §2 preconditions are safe:
//
//   - version is DRAFT, tenant-scoped
//   - video sha256 is recorded
//   - Modal credentials present (gated)
//   - no live transcription job already running
//   - per-tenant daily cost cap intact
//   - per-pilot cumulative budget intact (enforced inside
//     requestTranscription + the worker pre-call guard)
//
// Permission: hr:training:write.
// Preconditions failing → 409 with rejectionCode.
// Idempotent on replay (returns the existing live row).

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
import { audit } from "@/lib/audit";
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

  try {
    const result = await requestTranscription(principal, clubId, {
      courseVersionId: versionId,
    });

    // First-time acceptance: mark QUEUED + enqueue. Idempotent replays
    // return the existing live row untouched.
    if (!result.idempotent) {
      await markQueued(clubId, result.jobId);
      await enqueue({
        kind: "TRAINING_TRANSCRIBE_VIDEO",
        clubId,
        payload: { jobId: result.jobId },
        maxAttempts: 2,
        idempotencyKey: `training-transcribe:${result.jobId}`,
      });
      void audit(principal, {
        action: "hr.training.preparation.start",
        entityType: "TrainingTranscriptionJob",
        entityId: result.jobId,
        clubId,
        after: { courseVersionId: versionId, source: "start-preparation" },
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
