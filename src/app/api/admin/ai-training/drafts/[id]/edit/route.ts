// EP-TRAIN-4Y-AB §4 (2026-11-10) — POST /api/admin/ai-training/drafts/[id]/edit
//
// Manager inline-edit endpoint. Accepts a JSON body with the full
// edited question body (questionText / options / explanation) plus
// optimistic-concurrency tokens (expectedContentHash +
// expectedRecordVersion). Delegates to editAiDraft() which:
//
//   - re-checks the hr:training:ai:edit grant inside the transaction,
//   - re-runs the employee-facing text sanitiser,
//   - creates the new superseding draft in EDITED_VALIDATION_STALE
//     (NEVER APPROVED_DRAFT — separation of duties is preserved),
//   - archives the parent via writeStateTransition (lifecycle-enforced).
//
// Response:
//   200 — ok, with newDraftId + newContentHash + supersedesDraftId
//   400 — bad input / validation
//   401 — unauthenticated
//   403 — missing grant (mapped to same-shape 404 to prevent
//         cross-tenant enumeration)
//   404 — draft not found or cross-tenant
//   409 — content-hash mismatch, state not editable, sanitiser-leakage,
//         lifecycle-blocked, duplicate-of-parent

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import {
  editAiDraft,
  EditRejectedError,
} from "@/lib/hr/training/ai-review/edit-service";
import { AppError, UnauthenticatedError, ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function same404(): NextResponse {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}
function unauthenticated(): NextResponse {
  return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
}

interface RawBody {
  readonly questionText?: unknown;
  readonly options?: unknown;
  readonly explanation?: unknown;
  readonly expectedContentHash?: unknown;
  readonly expectedRecordVersion?: unknown;
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

  let body: RawBody;
  try {
    body = (await req.json()) as RawBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // Normalize + validate shape before calling the service.
  if (typeof body.questionText !== "string") {
    return NextResponse.json(
      { error: "invalid_field", path: "questionText", message: "string required" },
      { status: 400 },
    );
  }
  if (!Array.isArray(body.options)) {
    return NextResponse.json(
      { error: "invalid_field", path: "options", message: "array required" },
      { status: 400 },
    );
  }
  const options: Array<{ text: string; isCorrect: boolean }> = [];
  for (let i = 0; i < body.options.length; i++) {
    const o = body.options[i];
    if (!o || typeof o !== "object") {
      return NextResponse.json(
        { error: "invalid_field", path: `options[${i}]`, message: "object required" },
        { status: 400 },
      );
    }
    const r = o as { text?: unknown; isCorrect?: unknown };
    if (typeof r.text !== "string") {
      return NextResponse.json(
        { error: "invalid_field", path: `options[${i}].text`, message: "string required" },
        { status: 400 },
      );
    }
    options.push({ text: r.text, isCorrect: r.isCorrect === true });
  }
  if (typeof body.expectedContentHash !== "string" || !/^[0-9a-f]{64}$/.test(body.expectedContentHash)) {
    return NextResponse.json(
      {
        error: "invalid_field",
        path: "expectedContentHash",
        message: "64-char lowercase hex required",
      },
      { status: 400 },
    );
  }
  if (!Number.isInteger(body.expectedRecordVersion) || (body.expectedRecordVersion as number) < 0) {
    return NextResponse.json(
      {
        error: "invalid_field",
        path: "expectedRecordVersion",
        message: "non-negative integer required",
      },
      { status: 400 },
    );
  }
  const explanation = typeof body.explanation === "string" ? body.explanation : "";
  const reviewerNote = typeof body.reviewerNote === "string" ? body.reviewerNote : undefined;

  try {
    const result = await editAiDraft(principal, clubId, {
      draftId: id,
      questionText: body.questionText,
      options,
      explanation,
      expectedContentHash: body.expectedContentHash,
      expectedRecordVersion: body.expectedRecordVersion as number,
      reviewerNote,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof UnauthenticatedError) return unauthenticated();
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: "validation", issues: err.issues }, { status: 400 });
    }
    if (err instanceof EditRejectedError) {
      // "EDIT_FORBIDDEN" is mapped to 404 same-shape to prevent
      // cross-tenant enumeration.
      if (err.rejectionCode === "EDIT_FORBIDDEN" || err.rejectionCode === "EDIT_DRAFT_NOT_FOUND") {
        return same404();
      }
      return NextResponse.json(
        {
          ok: false,
          error: err.rejectionCode,
          message: err.message,
          detail: err.detail,
        },
        { status: err.httpStatus },
      );
    }
    if (err instanceof AppError) {
      return NextResponse.json(
        { ok: false, error: err.code, message: err.message },
        { status: err.httpStatus ?? 500 },
      );
    }
    return NextResponse.json(
      { ok: false, error: "internal", message: (err as Error)?.message ?? String(err) },
      { status: 500 },
    );
  }
}
