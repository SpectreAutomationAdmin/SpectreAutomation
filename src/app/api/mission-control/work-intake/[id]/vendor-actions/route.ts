// Sprint 3 Checkpoint 15F (2026-07-24) — Vendor consolidation
// reviewer actions endpoint.
//
// POST /api/mission-control/work-intake/[id]/vendor-actions
//
// Body: { kind: VendorConsolidationAction, notes?, payload? }
// See src/lib/vendor-intelligence/types.ts for the closed enum.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { applyVendorAction } from "@/lib/vendor-intelligence/actions";
import { VENDOR_CONSOLIDATION_ACTIONS, type VendorConsolidationAction } from "@/lib/vendor-intelligence/types";

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
  if (!kind || !(VENDOR_CONSOLIDATION_ACTIONS as readonly string[]).includes(kind)) {
    return NextResponse.json({ error: "invalid_kind", allowed: VENDOR_CONSOLIDATION_ACTIONS }, { status: 400 });
  }
  if (body.notes && body.notes.length > 500) {
    return NextResponse.json({ error: "notes_too_long" }, { status: 400 });
  }

  const result = await applyVendorAction({
    principal,
    clubId,
    workIntakeItemId: params.id,
    kind: kind as VendorConsolidationAction,
    notes: body.notes,
    payload: body.payload as ActionArgsPayload | undefined,
  });
  if (!result.ok) {
    const status = result.reason === "not_found" ? 404 : 400;
    return NextResponse.json({ error: result.reason ?? "action_failed" }, { status });
  }
  return NextResponse.json(result);
}

type ActionArgsPayload = {
  chosenWinnerVendorId?: string;
  acceptInvoiceReferenceCollisions?: boolean;
  keepActiveBanking?: "WINNER" | "LOSER";
};
