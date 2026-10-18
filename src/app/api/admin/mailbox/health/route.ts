// WI-SYNC-1b (2026-10-18) — GET /api/admin/mailbox/health
//
// Returns the current MailboxHealthReport for the caller's active
// club.  Tenant-scoped (never leaks data from another club).
// Available to any authenticated user with an active club — the
// metrics only reveal state about mailboxes the caller already
// has access to via mailbox ownership or MailboxAccess rows.
// Super-admin callers see every mailbox in the active club.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { isMailboxIntegrationEnabled } from "@/lib/env";
import { getMailboxSyncHealthForClub } from "@/lib/mailbox/sync-health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  if (!isMailboxIntegrationEnabled()) {
    return NextResponse.json(
      { error: "mailbox_integration_disabled" },
      { status: 404 },
    );
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
  const report = await getMailboxSyncHealthForClub(clubId);
  return NextResponse.json(report, { status: 200 });
}
