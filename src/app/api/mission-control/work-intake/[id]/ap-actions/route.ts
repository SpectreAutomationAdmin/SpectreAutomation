// Sprint 3 Checkpoint 15E (2026-07-24) — AP-invoice reviewer actions.
//
// POST /api/mission-control/work-intake/[id]/ap-actions
//
// Body: { kind: <ApCorrectionKind>, notes?, payload? }
// See src/lib/ap-intelligence/types.ts for the closed enum.
//
// Auth: authenticated principal + active club. Tenant guard inside
// applyApAction. NEVER posts / approves / pays.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { applyApAction } from "@/lib/ap-intelligence/actions";
import { AP_CORRECTION_KINDS, type ApCorrectionKind } from "@/lib/ap-intelligence/types";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!clubId) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: { kind?: string; notes?: string; payload?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const kind = body.kind;
  if (!kind || !(AP_CORRECTION_KINDS as readonly string[]).includes(kind)) {
    return NextResponse.json({ error: "invalid_kind", allowed: AP_CORRECTION_KINDS }, { status: 400 });
  }
  if (body.notes && body.notes.length > 500) {
    return NextResponse.json({ error: "notes_too_long" }, { status: 400 });
  }

  const result = await applyApAction({
    principal,
    clubId,
    workIntakeItemId: params.id,
    kind: kind as ApCorrectionKind,
    notes: body.notes,
    payload: body.payload,
  });
  if (!result.ok) {
    const status = result.reason === "not_found" ? 404 : 400;
    return NextResponse.json({ error: result.reason ?? "action_failed" }, { status });
  }
  return NextResponse.json(result);
}
