// EP-TRAIN-6D-4N (2026-11-05) — POST /api/admin/ai-training/drafts/[id]/approve
//
// Server-authoritative approval endpoint. The only code path that can
// transition a draft to APPROVED_DRAFT + write the verified-correct
// answer snapshot.
//
// Response semantics:
//   200  — approved (ok: true, replay: false)  OR  replay (ok: true, replay: true)
//   400  — bad input (missing / malformed verified index / missing attestation)
//   401  — unauthenticated
//   403  — authenticated but lacks hr:training:ai:approve (mapped to 404 same-shape per directive §4)
//   404  — draft not found OR cross-tenant (indistinguishable)
//   409  — guard rejection (hash mismatch, stale version, fixture validation, …)
//          OR idempotency conflict
//   503  — validation service unhealthy
//
// This route does NOT perform publication or employee assignment —
// those are separately authorised slices.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import {
  approveTrainingQuestionCandidate,
  emitApprovalAudit,
  ApprovalRejectedError,
} from "@/lib/hr/training/ai-review/approval-service";
import {
  AppError,
  UnauthenticatedError,
  ValidationError,
} from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function same404(): NextResponse {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}
function unauthenticated(): NextResponse {
  return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
}

interface RawRequestBody {
  readonly expectedRecordVersion?: unknown;
  readonly expectedContentHash?: unknown;
  readonly expectedValidationId?: unknown;
  readonly verifiedCorrectAnswerIndex?: unknown;
  readonly expectedOptionText?: unknown;
  readonly evidenceAttestation?: unknown;
  readonly idempotencyKey?: unknown;
  readonly reviewerNote?: unknown;
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  if (!id || typeof id !== "string") return same404();

  const principal = await getCurrentPrincipal();
  if (!principal) return unauthenticated();

  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
    id: principal.id,
  });

  let body: RawRequestBody;
  try {
    body = (await req.json()) as RawRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    const result = await approveTrainingQuestionCandidate(principal, clubId, {
      draftId: id,
      expectedRecordVersion: Number(body.expectedRecordVersion),
      expectedContentHash: String(body.expectedContentHash ?? ""),
      expectedValidationId: String(body.expectedValidationId ?? ""),
      verifiedCorrectAnswerIndex:
        typeof body.verifiedCorrectAnswerIndex === "number"
          ? body.verifiedCorrectAnswerIndex
          : Number.NaN,
      expectedOptionText:
        typeof body.expectedOptionText === "string"
          ? body.expectedOptionText
          : undefined,
      evidenceAttestation: body.evidenceAttestation === true,
      idempotencyKey: String(body.idempotencyKey ?? ""),
      reviewerNote:
        typeof body.reviewerNote === "string" ? body.reviewerNote : undefined,
    });

    // Post-commit audit emission (non-blocking by contract). Only emit
    // on first-time success, not on an idempotent replay — the audit
    // row for the original approval already exists.
    if (!result.replay) {
      void emitApprovalAudit(principal, clubId, result);
    }

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof UnauthenticatedError) return unauthenticated();
    if (err instanceof ApprovalRejectedError) {
      // Per directive §4: FORBIDDEN (reviewer lacks permission) is
      // mapped to 404 same-shape so cross-tenant probes cannot
      // enumerate.
      if (err.httpStatus === 403) return same404();
      // Everything else returns its own status + structured body.
      return NextResponse.json(
        {
          error: "approval_rejected",
          rejectionCode: err.rejectionCode,
          message: err.safeMessage,
          detail: err.detail,
        },
        { status: err.httpStatus },
      );
    }
    if (err instanceof ValidationError) {
      return NextResponse.json(
        { error: "validation", issues: err.issues },
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
