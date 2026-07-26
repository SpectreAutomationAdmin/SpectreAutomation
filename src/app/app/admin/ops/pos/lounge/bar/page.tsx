import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { listChitsForStation, listHeldChitsForStation, promoteDueHeldChits } from "@/lib/pos/checks";
import { StationView } from "../StationView";

// Bar prep-station view. Same shape as the kitchen view but filtered
// to BAR chits. Promotes due HELD chits before reading the active list.
export default async function LoungeBarPage() {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "inventory:read")) redirect("/app/admin");

  await promoteDueHeldChits(clubId, "BAR");

  const [chits, heldChits] = await Promise.all([
    listChitsForStation(p, clubId, "BAR", { includeReady: false, limit: 50 }),
    listHeldChitsForStation(p, clubId, "BAR", { limit: 25 }),
  ]);

  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="page-title">Bar — Lounge</h1>
          <p className="mt-1 text-sm text-stone-500">Active chits sent from the lounge POS. Refreshes after each action.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/app/admin/ops/pos/lounge" className="btn btn-secondary btn-sm">← Lounge POS</Link>
          <Link href="/app/admin/ops/pos/lounge/kitchen" className="btn btn-secondary btn-sm">Kitchen</Link>
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
          station="BAR"
        />
      </div>
    </div>
  );
}
