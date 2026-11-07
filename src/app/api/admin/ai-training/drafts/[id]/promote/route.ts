// EP-TRAIN-6D-4Y (2026-11-06) — POST /api/admin/ai-training/drafts/[id]/promote
//
// Admin-only wrapper around the existing 4T promotion service. The
// endpoint does NOT add new logic — the service re-verifies evidence,
// verified answer, content hash, destination, and course state on
// every call.
//
// Permission: existing hr:training:write (no new RBAC grant).
//
// Request body shape:
//   {
//     destination: { kind: "CHECKPOINT", checkpointId: string }
//                 | { kind: "FINAL_ASSESSMENT" },
//     expectedDraftContentHash: string (64 hex chars),
//     expectedValidationId: string,
//   }
//
// Response semantics mirror the service:
//   200  — promoted (ok: true, replay: false) OR replay (ok: true, replay: true)
//   400  — bad input
//   401  — unauthenticated
//   403  — authenticated but missing hr:training:write (mapped to 404)
//   404  — draft not found OR cross-tenant
//   409  — guard rejection (not approved, hash mismatch, evidence
//          integrity, destination mismatch, etc.)

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import {
  promoteApprovedDraft,
  PromoteRejectedError,
  type PromotionDestination,
} from "@/lib/hr/training/ai-review/promotion-service";
import { AppError, UnauthenticatedError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function same404(): NextResponse {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}
function unauthenticated(): NextResponse {
  return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
}
function badRequest(code: string): NextResponse {
  return NextResponse.json({ error: code }, { status: 400 });
}

interface RawBody {
  readonly destination?: unknown;
  readonly expectedDraftContentHash?: unknown;
  readonly expectedValidationId?: unknown;
}

function parseDestination(raw: unknown): PromotionDestination | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (d.kind === "FINAL_ASSESSMENT") {
    return { kind: "FINAL_ASSESSMENT" };
  }
  if (
    d.kind === "CHECKPOINT" &&
    typeof d.checkpointId === "string" &&
    d.checkpointId.length > 0
  ) {
    return { kind: "CHECKPOINT", checkpointId: d.checkpointId };
  }
  return null;
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: draftId } = await context.params;
  if (!draftId || typeof draftId !== "string") return same404();

  const principal = await getCurrentPrincipal();
  if (!principal) return unauthenticated();
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
    id: principal.id,
  });

  let body: RawBody = {};
  try {
    body = (await req.json()) as RawBody;
  } catch {
    return badRequest("invalid_json");
  }

  const destination = parseDestination(body.destination);
  if (!destination) return badRequest("invalid_destination");
  if (
    typeof body.expectedDraftContentHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(body.expectedDraftContentHash)
  ) {
    return badRequest("invalid_expected_content_hash");
  }
  if (
    typeof body.expectedValidationId !== "string" ||
    body.expectedValidationId.length === 0
  ) {
    return badRequest("invalid_expected_validation_id");
  }

  try {
    const result = await promoteApprovedDraft(principal, clubId, {
      draftId,
      destination,
      expectedDraftContentHash: body.expectedDraftContentHash,
      expectedValidationId: body.expectedValidationId,
    });
    return NextResponse.json({
      ok: true,
      replay: result.replay,
      questionId: result.questionId,
      destinationKind: result.destinationKind,
      checkpointId: result.checkpointId,
      promotionId: result.promotionId,
    });
  } catch (err) {
    if (err instanceof UnauthenticatedError) return unauthenticated();
    if (err instanceof PromoteRejectedError) {
      if (err.rejectionCode === "DRAFT_NOT_FOUND") return same404();
      return NextResponse.json(
        {
          error: "promotion_rejected",
          rejectionCode: err.rejectionCode,
          message: err.safeMessage,
          detail: err.detail,
        },
        { status: err.httpStatus },
      );
    }
    if (err instanceof AppError) {
      if (err.code === "FORBIDDEN") return same404();
      return NextResponse.json(
        { error: err.code, message: err.safeMessage },
        { status: err.httpStatus },
      );
    }
    throw err;
  }
}
