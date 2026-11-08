// EP-TRAIN-4Y-R §5 — lightweight read-only draft-state endpoint.
// Returns the handful of fields an authorised reviewer needs to
// construct an approve-draft payload (recordVersion, contentHash,
// latestValidationId, and the index + text of the correct option
// from the stored draft body). Tenant-scoped + permission-gated.
//
// No mutations. No evidence or transcript bodies — just the shape
// the approve-service's guard will check.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
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
  if (!hasPermission(principal, clubId, "hr:training:ai:read")) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const draft = await prisma.trainingQuestionAiDraft.findUnique({
    where: { id },
    select: {
      id: true,
      clubId: true,
      state: true,
      contentHash: true,
      recordVersion: true,
      draftJson: true,
      validations: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, verdict: true, stage: true },
      },
    },
  });
  if (!draft) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (draft.clubId !== clubId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Parse the draft body to surface the correct-option index + text —
  // what the approve route's `verifiedCorrectAnswerIndex` /
  // `expectedOptionText` fields need.
  let correctIndex: number | null = null;
  let correctText: string | null = null;
  let questionText: string | null = null;
  try {
    const body = JSON.parse(draft.draftJson);
    questionText = typeof body.questionText === "string" ? body.questionText : null;
    if (Array.isArray(body.options)) {
      for (let i = 0; i < body.options.length; i++) {
        if (body.options[i]?.isCorrect === true) {
          correctIndex = i;
          correctText = String(body.options[i].text ?? "");
          break;
        }
      }
    }
  } catch {}

  return NextResponse.json({
    ok: true,
    draftId: draft.id,
    state: draft.state,
    contentHash: draft.contentHash,
    recordVersion: draft.recordVersion,
    latestValidationId: draft.validations[0]?.id ?? null,
    latestValidationVerdict: draft.validations[0]?.verdict ?? null,
    latestValidationStage: draft.validations[0]?.stage ?? null,
    correctOptionIndex: correctIndex,
    correctOptionText: correctText,
    questionText,
  });
}
