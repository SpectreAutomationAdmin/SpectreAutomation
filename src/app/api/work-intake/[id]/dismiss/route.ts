// WI-SYNC-1c (2026-10-18) — POST /api/work-intake/[id]/dismiss
//
// Spectre-only Dismiss: removes a WI from the active feed without
// touching the source Outlook email.  Distinct from Delete (which
// moves the email) and from Archive (which moves it to Archive).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { dismissWorkIntakeItem } from "@/lib/mailbox/dismiss";

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
  const result = await dismissWorkIntakeItem({
    clubId,
    workIntakeItemId: params.id,
    principal,
  });
  if (result.status === "NOT_FOUND") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (result.status === "CROSS_TENANT") {
    return NextResponse.json({ error: "cross_tenant" }, { status: 403 });
  }
  return NextResponse.json(result, { status: 200 });
}
