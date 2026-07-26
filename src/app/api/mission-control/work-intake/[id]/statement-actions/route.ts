// Sprint 3 Checkpoint 15G (2026-07-24) — Vendor statement reviewer
// actions.
//
// POST /api/mission-control/work-intake/[id]/statement-actions
// Body: { kind: StatementReviewerAction, notes?, payload? }

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { applyStatementAction } from "@/lib/ap-statement-intelligence/actions";
import { STATEMENT_REVIEWER_ACTIONS, type StatementReviewerAction } from "@/lib/ap-statement-intelligence/types";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!clubId) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: { kind?: string; notes?: string; payload?: Record<string, unknown> };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  const kind = body.kind;
  if (!kind || !(STATEMENT_REVIEWER_ACTIONS as readonly string[]).includes(kind)) {
    return NextResponse.json({ error: "invalid_kind", allowed: STATEMENT_REVIEWER_ACTIONS }, { status: 400 });
  }
  if (body.notes && body.notes.length > 500) {
    return NextResponse.json({ error: "notes_too_long" }, { status: 400 });
  }

  const result = await applyStatementAction({
    principal,
    clubId,
    workIntakeItemId: params.id,
    kind: kind as StatementReviewerAction,
    notes: body.notes,
    payload: body.payload as {
      statementLineId?: string;
      linkToApInvoiceId?: string;
      linkToVendorPaymentId?: string;
      canonicalVendorId?: string;
    } | undefined,
  });
  if (!result.ok) {
    const status = result.reason === "not_found" || result.reason === "no_reconciliation" || result.reason === "no_document_origin" ? 404 : 400;
    return NextResponse.json({ error: result.reason ?? "action_failed" }, { status });
  }
  return NextResponse.json(result);
}
