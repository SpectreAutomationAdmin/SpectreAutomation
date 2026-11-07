// EP-TRAIN-6D-4Y (2026-11-06) — AI-Assisted Course Creation Workspace.
//
// Server component that composes the existing 4A-4X services into a
// linear eight-stage workflow. Reads authoritative state from
// Prisma; no fabricated completion states.
//
// All services and permissions are existing. No schema change.
// Not deployed. Not pushed. Dormant until a separate authorised
// staging activation slice.

import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactElement } from "react";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { listCheckpointsForVersion } from "@/lib/hr/training/checkpoints";
import { buildTopicAwareAssessmentPlan } from "@/lib/hr/training/generation/placement";
import { buildBaselineAssessmentPlan } from "@/lib/hr/training/generation/assessment-plan";
import {
  listCandidates,
  type CandidateQueueRow,
} from "@/lib/hr/training/ai-review/read-service";
import AiWorkspaceClient from "./AiWorkspaceClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PageProps {
  readonly params: Promise<{ courseId: string; versionId: string }>;
}

export default async function AiWorkspacePage({
  params,
}: PageProps): Promise<ReactElement> {
  const { courseId, versionId } = await params;

  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");

  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
    id: principal.id,
  });
  if (!hasPermission(principal, clubId, "hr:training:read")) {
    redirect("/app/admin/people/employees");
  }

  const version = await prisma.trainingCourseVersion.findFirst({
    where: { id: versionId, course: { id: courseId, clubId } },
    include: { course: true },
  });
  if (!version) redirect("/app/admin/people/safety-training");

  const canAuthor = hasPermission(principal, clubId, "hr:training:write");
  const canReview = hasPermission(principal, clubId, "hr:training:ai:read");
  const canPublish = hasPermission(principal, clubId, "hr:training:publish");

  const checkpoints = await listCheckpointsForVersion(version.id);

  // Latest transcript build for this video, if any — the plan
  // preview + Stage 2 state depend on it.
  const latestBuild = version.videoSha256
    ? await prisma.trainingTranscriptBuild.findFirst({
        where: { clubId, sourceVideoSha256: version.videoSha256 },
        orderBy: { producedAt: "desc" },
        select: {
          id: true,
          resolvedTranscriptBuildId: true,
          producedAt: true,
          transcriberName: true,
        },
      })
    : null;

  // Build Stage 3 plan preview (deterministic, offline, no Modal call).
  // Matches the logic in POST .../generate so the manager previews the
  // same plan that generation will actually run.
  let planPreview: {
    kind: "topic-aware" | "baseline" | "none";
    learningObjectiveCount: number;
    checkpointCount: number;
    finalAssessmentCount: number;
    boundaries: Array<{ atSec: number; rationale: string }>;
  } = {
    kind: "none",
    learningObjectiveCount: 0,
    checkpointCount: 0,
    finalAssessmentCount: 0,
    boundaries: [],
  };

  if (latestBuild && version.videoSha256) {
    const segments = await prisma.trainingTranscriptSegment.findMany({
      where: { clubId, transcriptBuildId: latestBuild.id },
      select: { segmentIndex: true, text: true, startSec: true, endSec: true },
      orderBy: [{ segmentIndex: "asc" }],
    });
    const mapped = segments.map((s: {
      segmentIndex: number;
      text: string;
      startSec: unknown;
      endSec: unknown;
    }) => ({
      segmentIndex: s.segmentIndex,
      text: s.text,
      startSec: Number(s.startSec),
      endSec: Number(s.endSec),
    }));
    const topicAware = buildTopicAwareAssessmentPlan({
      courseVersionId: versionId,
      resolvedTranscriptBuildId: latestBuild.resolvedTranscriptBuildId,
      sourceVideoSha256: version.videoSha256,
      segments: mapped,
      videoDurationSec: version.videoDurationSec,
      generatedByUserId: principal.id,
    });
    const chosen = topicAware.plan.learningObjectives.some(
      (lo) => lo.segmentIds.length > 0,
    )
      ? topicAware.plan
      : buildBaselineAssessmentPlan({
          courseVersionId: versionId,
          resolvedTranscriptBuildId: latestBuild.resolvedTranscriptBuildId,
          sourceVideoSha256: version.videoSha256,
          segments: segments.map((s: { segmentIndex: number; text: string }) => ({
            segmentIndex: s.segmentIndex,
            text: s.text,
          })),
          videoDurationSec: version.videoDurationSec,
          generatedByUserId: principal.id,
        });
    const kind = chosen === topicAware.plan ? "topic-aware" : "baseline";
    planPreview = {
      kind,
      learningObjectiveCount: chosen.learningObjectives.length,
      checkpointCount: chosen.proposedCheckpointGroups.length,
      finalAssessmentCount: chosen.proposedFinalAssessment.targetQuestionCount,
      boundaries: topicAware.boundaries.slice(0, 10).map((b) => ({
        atSec: b.atSec,
        rationale: b.rationale,
      })),
    };
  }

  // Candidate queue scoped to this version (Stage 5 + 6).
  let candidates: readonly CandidateQueueRow[] = [];
  if (canReview) {
    const page = await listCandidates(principal, clubId, { limit: 50 });
    candidates = page.rows.filter(
      (r) => r.courseVersionId === version.id,
    );
  }

  const approvedDraftIds = candidates
    .filter((c) => c.state === "APPROVED_DRAFT")
    .map((c) => c.draftId);

  // For approved drafts, resolve the current validationId +
  // contentHash the promote endpoint will require.
  const approvedDrafts =
    approvedDraftIds.length > 0
      ? await prisma.trainingQuestionAiDraft.findMany({
          where: { clubId, id: { in: approvedDraftIds } },
          select: {
            id: true,
            contentHash: true,
            draftJson: true,
            validations: {
              orderBy: { createdAt: "desc" },
              take: 1,
              select: { id: true, verdict: true },
            },
            promotion: { select: { id: true, destination: true } },
          },
        })
      : [];

  const checkpointOptions = checkpoints.map((c) => ({
    id: c.id,
    label: `${Math.round(c.atSecond)}s · ${c.label ?? "checkpoint"}`,
    atSecond: c.atSecond,
  }));

  return (
    <div>
      <Link
        href={`/app/admin/people/safety-training/${courseId}/${versionId}`}
        className="text-sm text-stone-500 hover:text-club-ink"
      >
        ← Back to version editor
      </Link>
      <div className="mt-3 mb-6">
        <h1 className="page-title">AI Workspace · {version.title}</h1>
        <p className="mt-1 text-sm text-stone-500">
          Guided workflow: upload → transcribe → plan → generate → review →
          assemble → preview → publish. Every stage reads live, authoritative
          state — nothing is fabricated.
        </p>
      </div>

      <AiWorkspaceClient
        courseId={courseId}
        versionId={versionId}
        clubWordmark={version.course.title}
        version={{
          state: version.state as "DRAFT" | "PUBLISHED" | "RETIRED",
          title: version.title,
          videoSha256: version.videoSha256,
          videoStorageKey: version.videoStorageKey,
          videoDurationSec: version.videoDurationSec,
          videoSizeBytes: version.videoSizeBytes,
        }}
        checkpoints={checkpointOptions}
        latestBuildPresent={Boolean(latestBuild)}
        latestBuildProducedAt={latestBuild?.producedAt ?? null}
        planPreview={planPreview}
        candidates={candidates}
        approvedDrafts={approvedDrafts.map((d) => ({
          id: d.id,
          contentHash: d.contentHash,
          validationId: d.validations[0]?.id ?? null,
          verdict: d.validations[0]?.verdict ?? null,
          alreadyPromoted: Boolean(d.promotion),
          promotionDestinationKind: d.promotion?.destination ?? null,
        }))}
        permissions={{ canAuthor, canReview, canPublish }}
        initialStageHints={{
          // EP-TRAIN-6D-4Z-D §7 — informative first-paint badge.
          // "NOT_STARTED" when the server can see no supporting state
          // (no video, no build, no candidates); otherwise defer to the
          // first poll which paints COMPLETED/WAITING/RUNNING etc.
          transcription:
            !version.videoSha256 || !version.videoStorageKey
              ? "NOT_STARTED"
              : undefined,
          generation: candidates.length === 0 ? "NOT_STARTED" : undefined,
        }}
      />
    </div>
  );
}
