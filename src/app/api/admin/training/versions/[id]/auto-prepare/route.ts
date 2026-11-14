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
import {
  buildPlanAndRequestGeneration,
  BuildAndEnqueueRejected,
} from "@/lib/hr/training/generation/enqueue-helper";
import {
  requestTranscription,
  markQueued,
  JobRejectedError,
} from "@/lib/hr/training/transcription/job-service";
import { enqueue } from "@/lib/queue";
import { logger } from "@/lib/observability/logger";

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
  // EP-TRAIN-4Y-R §8 — stale-draft detection. If a run exists whose
  // sourceVideoSha256 differs from the version's current videoSha256,
  // the AI suggestions for that run are now grounded in a previous
  // upload. The directive §8 "Replacing a video invalidates stale
  // AI suggestions" — this field surfaces that fact so the editor
  // can present a clear warning / cleanup action.
  staleRuns: Array<{
    runId: string;
    runSourceVideoSha256: string;
    draftCount: number;
  }>;
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
    staleRuns: [],
    mockExecution: true,
    note: "EP-TRAIN-4Y-Q §9 / EP-TRAIN-4Y-R §8 — orchestration report. Real Whisper / Qwen inference requires explicit founder authorisation per the cost controls in the 4Y-arc memory.",
  };

  // EP-TRAIN-4Y-R §8 — stale-run detection, regardless of current
  // video state. A run whose sourceVideoSha256 does not match the
  // version's current videoSha256 means the video was replaced
  // after that run completed.
  if (version.videoSha256) {
    const runsOnVersion = await prisma.trainingQuestionAiGenerationRun.findMany({
      where: { clubId, courseVersionId: versionId },
      select: {
        id: true,
        sourceVideoSha256: true,
        _count: { select: { drafts: true } },
      },
    });
    for (const r of runsOnVersion) {
      if (r.sourceVideoSha256 && r.sourceVideoSha256 !== version.videoSha256) {
        report.staleRuns.push({
          runId: r.id,
          runSourceVideoSha256: r.sourceVideoSha256,
          draftCount: r._count.drafts,
        });
      }
    }
  }

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
    } else {
      // EP-TRAIN-4Y-AZ §3 — actually enqueue. Prior to AZ this branch
      // only reported WOULD_ENQUEUE (the source comment said "In a
      // non-mock build this is where enqueue() would run"), which left
      // every new upload stalled at "Preparing video" indefinitely.
      // The enqueue is governed by the existing gates inside
      // requestTranscription (tenant scope, DRAFT-only, cost cap,
      // credential precheck) — automation does NOT bypass them.
      try {
        const result = await requestTranscription(principal, clubId, {
          courseVersionId: versionId,
        });
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
        report.transcript = {
          state: result.idempotent ? "ALREADY_QUEUED" : "WOULD_ENQUEUE",
          jobId: result.jobId,
        };
      } catch (err) {
        if (err instanceof JobRejectedError) {
          // Legitimate rejection (cost cap, credential absent, etc.)
          // — surface for operator visibility but do NOT 4xx the
          // orchestration report. The /preparation-status GET will
          // reflect the actual DB state next poll.
          logger.info("training.auto_prepare.transcribe_auto_enqueue.rejected", {
            clubId,
            courseVersionId: versionId,
            rejectionCode: err.rejectionCode,
          });
          report.transcript = { state: "WOULD_ENQUEUE" };
        } else {
          throw err;
        }
      }
    }
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
      // EP-TRAIN-4Y-V §5 — auto-trigger. Transcript is ready AND no
      // run exists → enqueue the default-plan generation run NOW so
      // the manager does not have to click a button. Idempotency is
      // guaranteed by the (clubId, courseVersionId, transcriptBuildId,
      // planIdentity) partial-unique index: repeated polls from the
      // browser never create duplicate runs.
      //
      // The default plan (targetTotalQuestions=6) is used. The pilot
      // 5+10 plan is NOT auto-triggered — pilot calls go through
      // /generate with explicit overrides. When this auto-trigger
      // wins the planIdentity race over an explicit pilot call, the
      // pilot caller sees a DUPLICATE_LIVE_RUN rejection and must
      // cancel the default run first.
      try {
        const result = await buildPlanAndRequestGeneration(principal, {
          clubId,
          courseVersionId: versionId,
        });
        report.generation = {
          state: result.idempotent ? "ALREADY_QUEUED" : "WOULD_ENQUEUE",
          runId: result.generationRunId,
        };
      } catch (err) {
        if (err instanceof BuildAndEnqueueRejected) {
          // Non-fatal: a legitimate rejection (missing transcript,
          // version not draft, cost cap) is reported as WOULD_ENQUEUE
          // for the UI's progress indicator, and the rejection code
          // gets logged for operator diagnosis. We don't propagate
          // the 4xx — the orchestration report is informational.
          logger.info("training.auto_prepare.auto_trigger.rejected", {
            clubId,
            courseVersionId: versionId,
            rejectionCode: err.rejectionCode,
          });
          report.generation = { state: "WOULD_ENQUEUE" };
        } else {
          throw err;
        }
      }
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
