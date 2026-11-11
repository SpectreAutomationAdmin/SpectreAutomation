// EP-TRAIN-4Y-AS §2 — POST endpoint for authorised manager-driven
// recovery of a retained rejected AI proposal.
//
//   POST /api/admin/ai-training/runs/[runId]/recover-rejected-proposal
//   Body: {
//     groupId: string;             // e.g. "fa-1"
//     proposalIndex: number;       // retained proposal position
//     editedQuestionText: string;
//     editedOptions?: Array<{ text: string; isCorrect: boolean }>;
//     editedExplanation?: string | null;
//   }
//
// Auth: `hr:training:write`. Cross-tenant → 404.
//
// Response:
//   200 — { ok: true, newDraftId, newContentHash, groupId, idempotent, validation }
//   401 — unauthenticated
//   403 — forbidden
//   404 — run / group / proposal not found or cross-tenant
//   409 — dedup rejected
//   410 — retention expired
//   422 — sanitiser / structural / correct-answer-integrity rejected

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import {
  recoverRejectedProposal,
  RejectedProposalRecoveryError,
} from "@/lib/hr/training/generation/rejected-proposal-recovery";
import { AppError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RawRequestBody {
  readonly groupId?: unknown;
  readonly proposalIndex?: unknown;
  readonly editedQuestionText?: unknown;
  readonly editedOptions?: unknown;
  readonly editedExplanation?: unknown;
}

function coerceOptions(raw: unknown): ReadonlyArray<{ text: string; isCorrect: boolean }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  if (raw.length === 0) return undefined;
  const out: Array<{ text: string; isCorrect: boolean }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return undefined;
    const e = entry as Record<string, unknown>;
    if (typeof e.text !== "string" || typeof e.isCorrect !== "boolean") return undefined;
    out.push({ text: e.text, isCorrect: e.isCorrect });
  }
  return out;
}

export async function POST(
  req: Request,
  context: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const { runId } = await context.params;
  if (!runId || typeof runId !== "string") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
    id: principal.id,
  });

  let body: RawRequestBody;
  try {
    const raw = (await req.text()).trim();
    body = raw.length === 0 ? {} : (JSON.parse(raw) as RawRequestBody);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (typeof body.groupId !== "string" || !body.groupId) {
    return NextResponse.json({ error: "missing_group_id" }, { status: 400 });
  }
  if (typeof body.proposalIndex !== "number" || !Number.isInteger(body.proposalIndex) || body.proposalIndex < 0) {
    return NextResponse.json({ error: "missing_proposal_index" }, { status: 400 });
  }
  if (typeof body.editedQuestionText !== "string" || body.editedQuestionText.trim().length === 0) {
    return NextResponse.json({ error: "missing_edited_question_text" }, { status: 400 });
  }
  const editedOptions = coerceOptions(body.editedOptions);
  const editedExplanation = body.editedExplanation === null
    ? null
    : typeof body.editedExplanation === "string" ? body.editedExplanation : undefined;

  try {
    const result = await recoverRejectedProposal(principal, clubId, {
      runId,
      groupId: body.groupId,
      proposalIndex: body.proposalIndex,
      edits: {
        editedQuestionText: body.editedQuestionText,
        editedOptions,
        editedExplanation,
      },
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof RejectedProposalRecoveryError) {
      return NextResponse.json(
        { error: err.code, message: err.safeMessage, detail: err.detail ?? null },
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
