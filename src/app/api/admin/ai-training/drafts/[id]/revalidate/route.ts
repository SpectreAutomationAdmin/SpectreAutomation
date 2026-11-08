// EP-TRAIN-4Y-Q §6 — re-run the deterministic validator for a single
// draft. Rebuilds the GroundingProjection (which reads current
// transcript-segment attestations) and writes a fresh
// TrainingQuestionAiValidation row reflecting the new verdict.
//
// Permission: hr:training:ai:revalidate (held by TRAINING_AI_REVIEWER +
// SUPER_ADMIN). The permission is already defined in permissions.ts
// (6D era); this route is the first to call `assertRevalidate`.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { revalidateDraft } from "@/lib/hr/training/ai-review/projection-and-validation-persistence";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
    id: principal.id,
  });

  // Revalidation is non-destructive — it re-runs the deterministic
  // validator and writes a fresh TrainingQuestionAiValidation row.
  // Accept any of: the dedicated revalidate perm, the approve perm,
  // OR the general training write perm (held by the course author).
  // The author needs to be able to revalidate after attesting segments
  // without needing full reviewer privileges. Separation of duties is
  // still enforced at APPROVE time, not at revalidate.
  const authorized =
    hasPermission(principal, clubId, "hr:training:ai:revalidate") ||
    hasPermission(principal, clubId, "hr:training:ai:approve") ||
    hasPermission(principal, clubId, "hr:training:write");
  if (!authorized) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Tenant assertion.
  const draft = await prisma.trainingQuestionAiDraft.findUnique({
    where: { id },
    select: { id: true, clubId: true, state: true },
  });
  if (!draft) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (draft.clubId !== clubId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const result = await revalidateDraft({ draftId: id });
    void audit(principal, {
      action: "hr.training.ai.draft.revalidate",
      entityType: "TrainingQuestionAiDraft",
      entityId: id,
      clubId,
      after: {
        projectionRowId: result.projectionRowId,
        validationId: result.validationId,
        verdict: result.verdict,
      },
    });
    return NextResponse.json({ ok: true, ...result }, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "revalidate_failed",
        message: (err as Error)?.message ?? String(err),
      },
      { status: 500 },
    );
  }
}
