// WI-SYNC-1e (2026-10-18) — POST /api/work-intake/[id]/restore-email
// WI-SYNC-1g (2026-10-18) — now delegates to restoreOutlookMessage-
//   ForWorkIntake, which inline-flips Spectre state after Graph
//   confirms the move + probe verifies PRESENT_INBOX.  No longer
//   relies on a subsequent delta tick to clear softDeletedAt.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { isMailboxIntegrationEnabled } from "@/lib/env";
import { restoreOutlookMessageForWorkIntake } from "@/lib/mailbox/restore-message";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  if (!isMailboxIntegrationEnabled()) {
    return NextResponse.json({ error: "mailbox_integration_disabled" }, { status: 404 });
  }
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
  const result = await restoreOutlookMessageForWorkIntake({
    clubId,
    workIntakeItemId: params.id,
    principal,
  });
  // Map service outcomes to HTTP status codes.  WI-SYNC-1g §4
  // requires that we DO NOT return an unconditional success when
  // the two systems disagree: GRAPH_OK_DB_PENDING + GRAPH_DESTINATION_UNVERIFIED
  // both get non-2xx responses that make the state mismatch visible.
  switch (result.status) {
    case "SUCCEEDED":
      return NextResponse.json(result, { status: 200 });
    case "ALREADY_RESTORED":
      return NextResponse.json(result, { status: 200 });
    case "NOT_APPLICABLE":
      return NextResponse.json(result, { status: 409 });
    case "GRAPH_ERROR":
      return NextResponse.json(result, { status: 502 });
    case "GRAPH_DESTINATION_UNVERIFIED":
      return NextResponse.json(result, { status: 502 });
    case "GRAPH_OK_DB_PENDING":
      return NextResponse.json(result, { status: 202 });
  }
}
