// EP-TRAIN-4Y-Q §9 — idempotent AI-preparation orchestration endpoint.
//
// Called by the canonical editor after a video upload succeeds (or by
// the "Auto-prepare" button in the AiSuggestionsPanel when a manager
// wants to kick it off manually). The directive explicitly authorises
// MOCKED queue execution only for this checkpoint — this endpoint
// reports the planned orchestration + enqueues the real
// transcribe/generate background jobs IFF they are not already
// queued/running/completed for the current videoSha256.
//
// No live GPU inference is triggered by this route; the queue handlers
// are the sole entry point for Modal calls, and they already
// incorporate the cost / spend-limit controls.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AutoPrepareReport {
  ok: true;
  clubId: string;
  versionId: string;
  videoSha256: string | null;
  transcript: {
    state: "ALREADY_COMPLETED" | "ALREADY_QUEUED" | "WOULD_ENQUEUE" | "NO_VIDEO";
    buildId?: string;
    jobId?: string;
  };
  generation: {
    state:
      | "ALREADY_COMPLETED"
      | "ALREADY_QUEUED"
      | "AWAITS_TRANSCRIPT"
      | "WOULD_ENQUEUE"
      | "NO_VIDEO";
    runId?: string;
  };
  mockExecution: true;
  note: string;
}

export async function POST(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: versionId } = await context.params;
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
    id: principal.id,
  });
  if (!hasPermission(principal, clubId, "hr:training:write")) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Tenant-scoped version lookup.
  const version = await prisma.trainingCourseVersion.findFirst({
    where: { id: versionId, course: { clubId } },
    select: { id: true, videoSha256: true },
  });
  if (!version) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const report: AutoPrepareReport = {
    ok: true,
    clubId,
    versionId: version.id,
    videoSha256: version.videoSha256 ?? null,
    transcript: { state: version.videoSha256 ? "WOULD_ENQUEUE" : "NO_VIDEO" },
    generation: { state: version.videoSha256 ? "AWAITS_TRANSCRIPT" : "NO_VIDEO" },
    mockExecution: true,
    note: "EP-TRAIN-4Y-Q §9 checkpoint runs orchestration in report-only mode. Real Whisper / Qwen inference requires explicit founder authorisation per the cost controls in the 4Y-arc memory.",
  };

  if (!version.videoSha256) {
    void audit(principal, {
      action: "hr.training.ai.auto_prepare.noop",
      entityType: "TrainingCourseVersion",
      entityId: versionId,
      clubId,
      after: { reason: "NO_VIDEO" },
    });
    return NextResponse.json(report, { status: 200 });
  }

  // ─── Transcript idempotency
  const existingBuild = await prisma.trainingTranscriptBuild.findFirst({
    where: { clubId, sourceVideoSha256: version.videoSha256 },
    orderBy: { producedAt: "desc" },
    select: { id: true, resolvedTranscriptBuildId: true },
  });
  if (existingBuild) {
    report.transcript = { state: "ALREADY_COMPLETED", buildId: existingBuild.id };
  } else {
    // Is there an active transcription job?
    const activeTranscribe = await prisma.trainingTranscriptionJob.findFirst({
      where: {
        clubId,
        courseVersionId: versionId,
        sourceVideoSha256: version.videoSha256,
        state: { in: ["REQUESTED", "QUEUED", "RUNNING"] },
      },
      select: { id: true },
    });
    if (activeTranscribe) {
      report.transcript = { state: "ALREADY_QUEUED", jobId: activeTranscribe.id };
    }
    // else: WOULD_ENQUEUE already set. In a non-mock build this is where
    // `enqueue({ kind: "TRAINING_TRANSCRIBE_VIDEO", ... })` would run.
  }

  // ─── Generation idempotency (only interesting once transcript ready)
  if (report.transcript.state === "ALREADY_COMPLETED") {
    const existingRun = await prisma.trainingQuestionAiGenerationRun.findFirst({
      where: {
        clubId,
        courseVersionId: versionId,
        executionStatus: { in: ["REQUESTED", "QUEUED", "RUNNING", "COMPLETED"] },
      },
      orderBy: { requestedAt: "desc" },
      select: { id: true, executionStatus: true },
    });
    if (existingRun) {
      report.generation = {
        state:
          existingRun.executionStatus === "COMPLETED" ? "ALREADY_COMPLETED" : "ALREADY_QUEUED",
        runId: existingRun.id,
      };
    } else {
      report.generation = { state: "WOULD_ENQUEUE" };
    }
  }

  void audit(principal, {
    action: "hr.training.ai.auto_prepare.report",
    entityType: "TrainingCourseVersion",
    entityId: versionId,
    clubId,
    after: {
      videoSha256First12: version.videoSha256.slice(0, 12),
      transcript: report.transcript.state,
      generation: report.generation.state,
    },
  });

  return NextResponse.json(report, { status: 200 });
}
