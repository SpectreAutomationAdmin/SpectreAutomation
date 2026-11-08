// EP-TRAIN-4Y-Q §6 — reviewer rejection route. Wires the
// REVIEWER_REJECTED lifecycle transition that the UI had as a
// disabled stub since 4Y-O.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import {
  rejectDraft,
  RejectError,
} from "@/lib/hr/training/ai-review/reject-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
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
  let body: { reason?: unknown; expectedRecordVersion?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  try {
    const result = await rejectDraft(principal, clubId, {
      draftId: id,
      reason: typeof body.reason === "string" ? body.reason : "",
      expectedRecordVersion:
        typeof body.expectedRecordVersion === "number"
          ? body.expectedRecordVersion
          : undefined,
    });
    return NextResponse.json({ ok: true, ...result }, { status: 200 });
  } catch (err) {
    if (err instanceof RejectError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.httpStatus });
    }
    return NextResponse.json(
      { error: "internal_error", message: (err as Error)?.message ?? String(err) },
      { status: 500 },
    );
  }
}
