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
import { prisma } from "@/lib/prisma";
import {
  requestGeneration,
  markGenerationQueued,
  GenerationRejectedError,
} from "@/lib/hr/training/generation/generation-service";
import { buildBaselineAssessmentPlan } from "@/lib/hr/training/generation/assessment-plan";
import { buildTopicAwareAssessmentPlan } from "@/lib/hr/training/generation/placement";
import { enqueue } from "@/lib/queue";
import { AppError, UnauthenticatedError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function same404() {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

interface RawBody {
  readonly targetTotalQuestions?: unknown;
  readonly resolvedTranscriptBuildId?: unknown;
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

  // Load version + latest completed transcript build (or a caller-
  // specified one).
  const version = await prisma.trainingCourseVersion.findUnique({
    where: { id: versionId },
    select: {
      id: true, state: true, videoSha256: true, videoDurationSec: true,
      course: { select: { clubId: true } },
    },
  });
  if (!version || version.course.clubId !== clubId) return same404();
  if (version.state !== "DRAFT") {
    return NextResponse.json({ error: "version_not_draft" }, { status: 409 });
  }
  if (!version.videoSha256) {
    return NextResponse.json({ error: "video_sha_unrecorded" }, { status: 409 });
  }

  // Resolve the transcript build (caller-supplied or latest).
  const build = await prisma.trainingTranscriptBuild.findFirst({
    where: {
      clubId,
      sourceVideoSha256: version.videoSha256,
      ...(resolvedTranscriptBuildId
        ? { resolvedTranscriptBuildId }
        : {}),
    },
    orderBy: { producedAt: "desc" },
    select: { id: true, resolvedTranscriptBuildId: true },
  });
  if (!build) {
    return NextResponse.json({ error: "transcript_missing" }, { status: 409 });
  }
  const segments = await prisma.trainingTranscriptSegment.findMany({
    where: { clubId, transcriptBuildId: build.id },
    select: { segmentIndex: true, text: true, startSec: true, endSec: true },
    orderBy: [{ segmentIndex: "asc" }],
  });

  // 4X topic-aware placement is the default. When it can produce at
  // least one checkpoint OR learning objective, we prefer it; the
  // deterministic baseline remains as a fallback when the topic-aware
  // builder yields an empty plan (e.g. video too short).
  const placement = buildTopicAwareAssessmentPlan({
    courseVersionId: versionId,
    resolvedTranscriptBuildId: build.resolvedTranscriptBuildId,
    sourceVideoSha256: version.videoSha256,
    segments: segments.map((s) => ({
      segmentIndex: s.segmentIndex,
      text: s.text,
      startSec: Number(s.startSec),
      endSec: Number(s.endSec),
    })),
    videoDurationSec: version.videoDurationSec,
    targetTotalQuestions,
    generatedByUserId: principal.id,
  });

  const plan = placement.plan.learningObjectives.some((lo) => lo.segmentIds.length > 0)
    ? placement.plan
    : buildBaselineAssessmentPlan({
        courseVersionId: versionId,
        resolvedTranscriptBuildId: build.resolvedTranscriptBuildId,
        sourceVideoSha256: version.videoSha256,
        segments: segments.map((s) => ({ segmentIndex: s.segmentIndex, text: s.text })),
        videoDurationSec: version.videoDurationSec,
        targetTotalQuestions,
        generatedByUserId: principal.id,
      });

  try {
    const result = await requestGeneration(principal, clubId, {
      courseVersionId: versionId,
      plan,
    });
    if (!result.idempotent) {
      await markGenerationQueued(clubId, result.generationRunId);
      await enqueue({
        kind: "TRAINING_GENERATE_QUESTIONS",
        clubId,
        payload: { generationRunId: result.generationRunId },
        maxAttempts: 2,
        idempotencyKey: `training-generate:${result.generationRunId}`,
      });
    }
    return NextResponse.json({
      ok: true,
      generationRunId: result.generationRunId,
      state: result.idempotent ? result.state : "QUEUED",
      idempotent: result.idempotent,
      planIdentity: result.planIdentity,
    });
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    if (err instanceof GenerationRejectedError) {
      if (err.rejectionCode === "VERSION_NOT_FOUND") return same404();
      return NextResponse.json(
        {
          error: "generation_rejected",
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
