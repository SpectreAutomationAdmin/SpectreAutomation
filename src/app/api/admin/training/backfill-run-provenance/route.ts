// EP-TRAIN-4Y-P §6 — authorised one-off repair endpoint.
//
// Calls the `backfillRunProvenance` service on a given generation run,
// writing the TrainingGroundingProjection row + TrainingQuestionAiValidation
// rows that the pre-4Y-P worker never created. Idempotent: re-running on
// a run whose drafts are already bound is a no-op.
//
// Permission: hr:training:write (founder on staging; CLUB_ADMIN on prod).
// This endpoint does NOT approve any draft, does NOT mutate draft content,
// and does NOT promote. It only backfills provenance artefacts whose
// absence currently blocks the review workflow.
//
// Not callable from the public UI; invoked by the founder via curl /
// Playwright during 4Y-P staging acceptance.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { backfillRunProvenance } from "@/lib/hr/training/ai-review/projection-and-validation-persistence";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
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
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let body: { runId?: unknown; dryRun?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const runId = typeof body.runId === "string" ? body.runId : "";
  const dryRun = body.dryRun === true;
  if (!runId) {
    return NextResponse.json({ error: "runId_required" }, { status: 400 });
  }

  // Tenant assertion: the run must belong to the active club.
  const run = await prisma.trainingQuestionAiGenerationRun.findUnique({
    where: { id: runId },
    select: { id: true, clubId: true, executionStatus: true, courseVersionId: true },
  });
  if (!run) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (run.clubId !== clubId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const summary = await backfillRunProvenance({ runId }, { dryRun });
    void audit(principal, {
      action: "hr.training.ai.backfill_run_provenance",
      entityType: "TrainingQuestionAiGenerationRun",
      entityId: runId,
      clubId,
      after: {
        runId,
        projectionRowId: summary.projectionRowId,
        validationsCreated: summary.validationsCreated,
        verdictCounts: summary.verdictCounts,
        draftsAlreadyBound: summary.draftsAlreadyBound,
        errorCount: summary.errors.length,
        dryRun,
      },
    });
    return NextResponse.json(
      {
        ok: true,
        clubId,
        ...summary,
      },
      { status: 200 },
    );
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        runId,
        error: "backfill_failed",
        message: (err as Error)?.message ?? String(err),
      },
      { status: 500 },
    );
  }
}
