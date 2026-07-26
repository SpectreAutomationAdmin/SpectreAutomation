// Sprint 3 Checkpoint 15H-1 (2026-07-25) — Lightweight Mission
// Control snapshot summary for the client-side auto-refresh
// component. Returns just enough to detect NEW work items without
// re-fetching the whole snapshot.
//
// GET /api/mission-control/snapshot-summary
//
// Auth: authenticated principal + active club.
// Response:
//   {
//     syncedAt: ISO,
//     workItemCount: number,
//     workItemIds: string[],     // stable, sorted
//     briefing: { arrivedToday, ... }
//   }
// READ-ONLY.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { loadMissionControlSnapshot } from "@/lib/mission-control";

export const dynamic = "force-dynamic";

export async function GET() {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!clubId) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const snapshot = await loadMissionControlSnapshot(principal, clubId);
  const ids = snapshot.workItems.map((w) => w.id).sort();
  return NextResponse.json({
    syncedAt: snapshot.syncedAt.toISOString(),
    workItemCount: snapshot.workItems.length,
    workItemIds: ids,
    briefing: snapshot.briefing,
  });
}
