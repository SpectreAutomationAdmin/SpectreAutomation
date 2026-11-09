// EP-TRAIN-6D-4Y (2026-11-06) — GET /api/admin/training/versions/[id]/transcription-status
//
// Admin-only authoritative read of the latest TrainingTranscriptionJob
// + resolved TrainingTranscriptBuild for the version's current video.
//
// Permission: existing hr:training:read (no new RBAC grant).
//
// Response invariants (§9 of 4Y design, mirrors §4 of 4V):
//   - Returns { state: "NOT_STARTED" } when no job row exists OR the
//     video on the version has no sha256 recorded.
//   - Returns { state: "COMPLETED", transcript: {...} } ONLY when the
//     job row's state == "COMPLETED" AND a matching
//     trainingTranscriptBuild row exists for the same clubId +
//     sourceVideoSha256. Otherwise returns { state: "WAITING_ON_INGEST" }
//     — this guards against fabricating a completed state during the
//     window where the Modal callback has recorded completion but
//     ingestion has not yet persisted the build.
//   - Cross-tenant version ids map to a same-shape 404.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function same404() {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}
function unauthenticated() {
  return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: versionId } = await context.params;
  if (!versionId) return same404();

  const principal = await getCurrentPrincipal();
  if (!principal) return unauthenticated();
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
    id: principal.id,
  });
  if (!hasPermission(principal, clubId, "hr:training:read")) {
    return same404();
  }

  const version = await prisma.trainingCourseVersion.findFirst({
    where: { id: versionId, course: { clubId } },
    select: {
      id: true,
      videoSha256: true,
      videoDurationSec: true,
      videoStorageKey: true,
    },
  });
  if (!version) return same404();

  if (!version.videoSha256 || !version.videoStorageKey) {
    return NextResponse.json({
      state: "NOT_STARTED",
      reason: "video_missing",
    });
  }

  const job = await prisma.trainingTranscriptionJob.findFirst({
    where: {
      clubId,
      courseVersionId: versionId,
      sourceVideoSha256: version.videoSha256,
    },
    orderBy: { requestedAt: "desc" },
    select: {
      id: true,
      state: true,
      attempts: true,
      maxAttempts: true,
      requestedAt: true,
      queuedAt: true,
      startedAt: true,
      completedAt: true,
      cancelledAt: true,
      failureCode: true,
      failureMessage: true,
      resolvedTranscriptBuildId: true,
      elapsedMsTotal: true,
    },
  });

  if (!job) {
    // EP-TRAIN-4Y-U §4 — when no job exists for this courseVersionId
    // but the uploaded video's sha256 already has a resolved transcript
    // build (e.g. the same video was previously transcribed under a
    // different course), surface COMPLETED so the UI treats transcript
    // as ready. Downstream metadata generation + the manual question-
    // generation trigger both operate off the build, not the job.
    const existingBuild = await prisma.trainingTranscriptBuild.findFirst({
      where: { clubId, sourceVideoSha256: version.videoSha256 },
      orderBy: { producedAt: "desc" },
      select: {
        id: true,
        resolvedTranscriptBuildId: true,
        producedAt: true,
        transcriberName: true,
        transcriberModelName: true,
      },
    });
    if (existingBuild) {
      const segmentCount = await prisma.trainingTranscriptSegment.count({
        where: { clubId, transcriptBuildId: existingBuild.id },
      });
      return NextResponse.json({
        state: "COMPLETED",
        jobId: null,
        reason: "existing_build_reused",
        transcript: {
          buildId: existingBuild.id,
          resolvedTranscriptBuildId: existingBuild.resolvedTranscriptBuildId,
          producedAt: existingBuild.producedAt,
          transcriberName: existingBuild.transcriberName,
          transcriberModelName: existingBuild.transcriberModelName,
          segmentCount,
        },
      });
    }
    return NextResponse.json({ state: "NOT_STARTED" });
  }

  // The never-fabricate rule: a COMPLETED job is only promoted to the
  // caller as COMPLETED when the authoritative transcript build row
  // exists for the same tenant + sha. Otherwise we surface
  // WAITING_ON_INGEST so the UI will not render a transcript-ready
  // affordance.
  if (job.state === "COMPLETED") {
    const build = job.resolvedTranscriptBuildId
      ? await prisma.trainingTranscriptBuild.findFirst({
          where: {
            clubId,
            id: job.resolvedTranscriptBuildId,
            sourceVideoSha256: version.videoSha256,
          },
          select: {
            id: true,
            resolvedTranscriptBuildId: true,
            producedAt: true,
            transcriberName: true,
            transcriberModelName: true,
          },
        })
      : null;

    if (!build) {
      return NextResponse.json({
        state: "WAITING_ON_INGEST",
        jobId: job.id,
        completedAt: job.completedAt,
        reason: "transcript_build_not_persisted",
      });
    }

    const segmentCount = await prisma.trainingTranscriptSegment.count({
      where: { clubId, transcriptBuildId: build.id },
    });

    return NextResponse.json({
      state: "COMPLETED",
      jobId: job.id,
      completedAt: job.completedAt,
      elapsedMsTotal: job.elapsedMsTotal,
      transcript: {
        buildId: build.id,
        resolvedTranscriptBuildId: build.resolvedTranscriptBuildId,
        producedAt: build.producedAt,
        transcriberName: build.transcriberName,
        transcriberModelName: build.transcriberModelName,
        segmentCount,
      },
    });
  }

  return NextResponse.json({
    state: job.state,
    jobId: job.id,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    requestedAt: job.requestedAt,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    cancelledAt: job.cancelledAt,
    failureCode: job.failureCode,
    failureMessage: job.failureMessage,
  });
}
