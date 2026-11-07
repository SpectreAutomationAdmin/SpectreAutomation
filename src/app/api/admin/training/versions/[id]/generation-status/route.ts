// EP-TRAIN-6D-4Y (2026-11-06) — GET /api/admin/training/versions/[id]/generation-status
//
// Admin-only authoritative read of the latest
// TrainingQuestionAiGenerationRun for the version + the current
// per-lifecycle breakdown of TrainingQuestionAiDraft rows generated
// from that run.
//
// Permission: existing hr:training:read (no new RBAC grant).
//
// Response invariants:
//   - Returns { state: "NOT_STARTED" } when no run row exists.
//   - Never fabricates a COMPLETED breakdown: the breakdown is
//     computed from authoritative AiDraft rows for that run; if a run
//     claims COMPLETED but has zero drafts, the response surfaces
//     shortfall + draft count = 0 so the UI treats it as a shortfall
//     rather than a success.
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

const DRAFT_LIFECYCLE_STATES = [
  "GENERATED",
  "VALIDATION_PENDING",
  "REQUIRES_HUMAN_REVIEW",
  "APPROVED_DRAFT",
  "REJECTED",
  "EDITED_VALIDATION_STALE",
  "VALIDATION_FAILED",
  "ARCHIVED",
] as const;

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
    select: { id: true },
  });
  if (!version) return same404();

  const run = await prisma.trainingQuestionAiGenerationRun.findFirst({
    where: { clubId, courseVersionId: versionId },
    orderBy: { requestedAt: "desc" },
    select: {
      id: true,
      executionStatus: true,
      requestedAt: true,
      queuedAt: true,
      startedAt: true,
      completedAt: true,
      attempts: true,
      maxAttempts: true,
      leaseExpiresAt: true,
      executionErrorCode: true,
      executionErrorMessage: true,
      shortfallReasonJson: true,
      planIdentity: true,
      resolvedTranscriptBuildId: true,
      modelName: true,
      modelBackend: true,
    },
  });

  if (!run) {
    return NextResponse.json({ state: "NOT_STARTED" });
  }

  // Authoritative draft breakdown (never fabricated — reads the live
  // rows). Only the current run's drafts.
  const grouped = await prisma.trainingQuestionAiDraft.groupBy({
    by: ["state"],
    where: { clubId, courseVersionId: versionId, generationRunId: run.id },
    _count: { state: true },
  });

  const breakdown: Record<string, number> = Object.fromEntries(
    DRAFT_LIFECYCLE_STATES.map((s) => [s, 0]),
  );
  let total = 0;
  for (const row of grouped) {
    const s = row.state as string;
    if (s in breakdown) breakdown[s] = row._count.state;
    total += row._count.state;
  }

  let shortfall: unknown = null;
  if (run.shortfallReasonJson) {
    try {
      shortfall = JSON.parse(run.shortfallReasonJson);
    } catch {
      shortfall = { raw: run.shortfallReasonJson };
    }
  }

  return NextResponse.json({
    state: run.executionStatus,
    runId: run.id,
    requestedAt: run.requestedAt,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    attempts: run.attempts,
    maxAttempts: run.maxAttempts,
    leaseExpiresAt: run.leaseExpiresAt,
    executionErrorCode: run.executionErrorCode,
    executionErrorMessage: run.executionErrorMessage,
    planIdentity: run.planIdentity,
    resolvedTranscriptBuildId: run.resolvedTranscriptBuildId,
    model: { name: run.modelName, backend: run.modelBackend },
    draftCount: total,
    draftBreakdown: breakdown,
    shortfall,
  });
}
