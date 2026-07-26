import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { listChitsForStation, listHeldChitsForStation, promoteDueHeldChits } from "@/lib/pos/checks";
import { StationView } from "../StationView";

// Kitchen prep-station view. Lists active KITCHEN chits with
// Acknowledge / Mark Ready / Print actions per chit. Data refreshes
// on revalidatePath() after each action.
//
// Before reading the active list, sweep any HELD chits whose fireAt
// has passed and promote them to QUEUED — this is the auto-pace
// mechanic. No background job needed; the page already revalidates.
export default async function LoungeKitchenPage() {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "inventory:read")) redirect("/app/admin");

  await promoteDueHeldChits(clubId, "KITCHEN");

  const [chits, heldChits] = await Promise.all([
    listChitsForStation(p, clubId, "KITCHEN", { includeReady: false, limit: 50 }),
    listHeldChitsForStation(p, clubId, "KITCHEN", { limit: 25 }),
  ]);

  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="page-title">Kitchen — Lounge</h1>
          <p className="mt-1 text-sm text-stone-500">Active chits sent from the lounge POS. Refreshes after each action.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/app/admin/ops/pos/lounge" className="btn btn-secondary btn-sm">← Lounge POS</Link>
          <Link href="/app/admin/ops/pos/lounge/bar" className="btn btn-secondary btn-sm">Bar</Link>
        </div>
      </div>
      <div className="mt-6">
        <StationView
          chits={chits.map((c) => ({
            id: c.id,
            station: c.station,
            status: c.status,
            course: c.course,
            sentAt: c.sentAt,
            firedAt: c.firedAt,
            fireAt: c.fireAt,
            acknowledgedAt: c.acknowledgedAt,
            readyAt: c.readyAt,
            lines: c.lines.map((l) => ({
              id: l.id,
              displayDescription: l.displayDescription,
              displayQuantity: Number(l.displayQuantity.toString()),
              displayNote: l.displayNote,
              displaySeatNumber: l.displaySeatNumber,
              displayTableLevel: l.displayTableLevel,
              hasAllergy: l.checkLine?.hasAllergy ?? false,
              modifiers: (l.checkLine?.modifiers ?? []).map((m) => ({
                id: m.id,
                modifierType: m.modifierType,
                label: m.label,
                printLabel: m.printLabel,
              })),
            })),
            check: {
              id: c.check.id,
              checkNumber: c.check.checkNumber,
              diningMode: c.check.diningMode,
              tableNumber: c.check.tableNumber,
              member: c.check.member,
            },
          }))}
          heldChits={heldChits.map((c) => ({
            id: c.id,
            station: c.station,
            status: c.status,
            course: c.course,
            sentAt: c.sentAt,
            firedAt: c.firedAt,
            fireAt: c.fireAt,
            acknowledgedAt: c.acknowledgedAt,
            readyAt: c.readyAt,
            lines: c.lines.map((l) => ({
              id: l.id,
              displayDescription: l.displayDescription,
              displayQuantity: Number(l.displayQuantity.toString()),
              displayNote: l.displayNote,
              displaySeatNumber: l.displaySeatNumber,
              displayTableLevel: l.displayTableLevel,
              hasAllergy: l.checkLine?.hasAllergy ?? false,
              modifiers: (l.checkLine?.modifiers ?? []).map((m) => ({
                id: m.id,
                modifierType: m.modifierType,
                label: m.label,
                printLabel: m.printLabel,
              })),
            })),
            check: {
              id: c.check.id,
              checkNumber: c.check.checkNumber,
              diningMode: c.check.diningMode,
              tableNumber: c.check.tableNumber,
              member: c.check.member,
            },
          }))}
          station="KITCHEN"
        />
      </div>
    </div>
  );
}
