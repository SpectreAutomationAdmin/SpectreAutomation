// WI-SYNC-1c (2026-10-18) — POST /api/work-intake/[id]/delete-email
//
// Moves the WI's source Outlook email to Deleted Items + flips the
// WI to SUPPRESSED.  The route name is `delete-email` (not `delete`)
// because `DELETE` HTTP verbs on `/api/work-intake/[id]` could be
// confused with hard-deleting the WI itself (which this does NOT
// do — financial / audit history is preserved).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { deleteOutlookMessageForWorkIntake } from "@/lib/mailbox/delete-message";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const clubId = await getActiveClubId({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clubId: (principal as any).activeClubId ?? null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    role: (principal as any).role ?? "",
  });
  if (!clubId) {
    return NextResponse.json({ error: "no_active_club" }, { status: 400 });
  }
  const result = await deleteOutlookMessageForWorkIntake({
    clubId,
    workIntakeItemId: params.id,
    principal,
  });
  if (result.status === "NOT_APPLICABLE") {
    return NextResponse.json(result, { status: 409 });
  }
  if (result.status === "GRAPH_ERROR") {
    return NextResponse.json(result, { status: 502 });
  }
  return NextResponse.json(result, { status: 200 });
}
