// EP-TRAIN-4Y-AR §2 — admin-only diagnostic read endpoint for
// retained rejected AI question candidates.
//
//   GET /api/admin/ai-training/runs/[runId]/rejected-proposals
//
// Returns the full retained text (original + normalised) + options
// + explanation + source segment ids + rejection stage + finding
// codes for every proposal the worker dropped at any validation
// stage during the given generation run.
//
// Access control:
//   - Authenticated (401 otherwise).
//   - Same `hr:training:write` permission that gates the recover-FA
//     endpoint (sibling route) so there is no new RBAC surface.
//   - Cross-tenant 404: the run must belong to the caller's active
//     club. Even an authenticated admin cannot read another club's
//     retained proposals.
//   - Expired records (`retentionExpiresAt <= now`) are pruned from
//     the response payload (DB row is unchanged — scheduled
//     cleanup is a separate concern).
//
// This endpoint is NEVER called by any employee-facing surface.
// The `rejectedProposals` field it returns never flows to any
// `/app/member/*`, `/app/employee/*`, or un-authed API. This is
// enforced structurally by the data model (field lives only inside
// `TrainingQuestionAiGenerationRun.shortfallReasonJson`, which no
// employee-facing module imports) and by test
// `tests/ep-train-4y-ar-retention.test.ts` §4.3.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import {
  pruneExpiredRetainedProposals,
  flattenRetainedFromDiagnostics,
  type RetainedRejectedProposal,
} from "@/lib/hr/training/generation/rejected-proposal-retention";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PerGroupDiagnosticWithRetention {
  group: string;
  rejectedProposals?: readonly RetainedRejectedProposal[];
}

interface ShortfallReasonJsonShape {
  perGroupDiagnostics?: readonly PerGroupDiagnosticWithRetention[];
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const { runId } = await context.params;
  if (!runId || typeof runId !== "string") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

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
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const run = await prisma.trainingQuestionAiGenerationRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      clubId: true,
      courseVersionId: true,
      executionStatus: true,
      shortfallReasonJson: true,
      requestedAt: true,
      completedAt: true,
    },
  });
  if (!run) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (run.clubId !== clubId) {
    // Cross-tenant — treat as not found, never leak existence.
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let payload: ShortfallReasonJsonShape = {};
  if (run.shortfallReasonJson && typeof run.shortfallReasonJson === "string") {
    try {
      payload = JSON.parse(run.shortfallReasonJson) as ShortfallReasonJsonShape;
    } catch {
      payload = {};
    }
  } else if (run.shortfallReasonJson && typeof run.shortfallReasonJson === "object") {
    payload = run.shortfallReasonJson as unknown as ShortfallReasonJsonShape;
  }

  const diagnostics = payload.perGroupDiagnostics ?? [];
  const all = flattenRetainedFromDiagnostics(diagnostics);
  const active = pruneExpiredRetainedProposals(all, new Date());

  return NextResponse.json({
    ok: true,
    runId: run.id,
    clubId: run.clubId,
    courseVersionId: run.courseVersionId,
    executionStatus: run.executionStatus,
    totalRetained: all.length,
    activeRetained: active.length,
    expiredCount: all.length - active.length,
    retainedProposals: active,
  });
}
