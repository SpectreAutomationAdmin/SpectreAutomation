// Seat-level POS workflow.
//
// Server-rendered shell that pulls the check + per-seat summary, then
// hands it to the SeatPOS client component. Adding items, sending to
// the kitchen, and split-bill settlement all run through server
// actions in ../_actions.ts so the existing posting / tenancy /
// audit pipeline stays the source of truth.

import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { tenantWhere } from "@/lib/services/tenant";
import { seatSummary } from "@/lib/pos/seat-checks";
import { SeatPOS } from "./SeatPOS";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function SeatLevelTablePage({ params }: { params: { checkId: string } }) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "inventory:write")) redirect("/app/admin");

  let summary: Awaited<ReturnType<typeof seatSummary>>;
  try { summary = await seatSummary(principal, params.checkId); }
  catch { notFound(); }

  const menu = await prisma.pOSMenuCategory.findMany({
    where: { ...tenantWhere(principal, clubId), isActive: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: {
      items: {
        where: { isActive: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: { id: true, name: true, price: true, description: true },
      },
      location: { select: { code: true } },
    },
  });
  const loungeMenu = menu.filter((c) => c.location?.code === "FB-LOUNGE");

  // Members for the host-charge dropdown. Top 200 by last name.
  const members = await prisma.member.findMany({
    where: { clubId, status: { in: ["ACTIVE", "ONBOARDING"] } },
    select: { id: true, firstName: true, lastName: true, memberNumber: true, accessStatus: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    take: 200,
  });

  const check = summary.check;
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-3">
          <Link href="/app/admin/ops/pos/lounge" className="text-sm text-stone-500 hover:text-club-ink">← Lounge POS</Link>
          <h1 className="font-serif text-2xl text-stone-900">
            {check.table?.displayName ?? `Table ${check.table?.tableNumber ?? check.tableNumber ?? "—"}`}
          </h1>
          <span className="text-xs text-stone-500">
            Check {check.checkNumber}
            {check.member ? ` · ${check.member.firstName} ${check.member.lastName}` : ""}
            {check.partySize ? ` · party of ${check.partySize}` : ""}
          </span>
        </div>
        <div className="flex gap-2 text-xs">
          <Link href="/app/admin/hospitality/reservations/floor" className="btn btn-secondary btn-sm">Floor map</Link>
        </div>
      </div>

      <div className="mt-4">
        <SeatPOS
          checkId={check.id}
          checkNumber={check.checkNumber}
          checkStatus={check.status}
          capacity={summary.seats.length}
          tableShape={(check.table?.shape as "ROUND" | "SQUARE" | "RECTANGLE" | undefined) ?? "SQUARE"}
          tableLabel={check.table?.displayName ?? `Table ${check.table?.tableNumber ?? check.tableNumber ?? ""}`}
          seats={summary.seats.map((s) => ({
            seatNumber: s.seatNumber,
            subtotal: s.subtotal,
            draftCount: s.draftCount,
            sentCount: s.sentCount,
            readyCount: s.readyCount,
            servedCount: s.servedCount,
            inGroupId: s.inGroupId,
            assignment: s.assignment,
            items: s.items.map((l) => ({
              id: l.id,
              menuItemId: l.menuItemId,
              description: l.description,
              quantity: Number(l.quantity.toString()),
              unitPrice: Number(l.unitPrice.toString()),
              status: l.status,
              seatNumber: l.seatNumber ?? null,
              hasAllergy: l.hasAllergy,
              modifiers: l.modifiers.map((m) => ({
                id: m.id,
                optionId: m.optionId,
                modifierType: m.modifierType as "REMOVE" | "ADD" | "SUBSTITUTE" | "ALLERGY" | "NOTE",
                label: m.label,
                printLabel: m.printLabel,
                priceDelta: Number(m.priceDelta.toString()),
              })),
            })),
          }))}
          tableLines={summary.tableLines.map((l) => ({
            id: l.id,
            menuItemId: l.menuItemId,
            description: l.description,
            quantity: Number(l.quantity.toString()),
            unitPrice: Number(l.unitPrice.toString()),
            status: l.status,
            hasAllergy: l.hasAllergy,
            modifiers: l.modifiers.map((m) => ({
              id: m.id,
              optionId: m.optionId,
              modifierType: m.modifierType as "REMOVE" | "ADD" | "SUBSTITUTE" | "ALLERGY" | "NOTE",
              label: m.label,
              printLabel: m.printLabel,
              priceDelta: Number(m.priceDelta.toString()),
            })),
          }))}
          menu={loungeMenu.map((c) => ({
            id: c.id,
            name: c.name,
            items: c.items.map((it) => ({
              id: it.id,
              name: it.name,
              price: Number(it.price.toString()),
              description: it.description,
            })),
          }))}
          members={members}
          defaultMemberId={check.memberId ?? null}
        />
      </div>
    </div>
  );
}
