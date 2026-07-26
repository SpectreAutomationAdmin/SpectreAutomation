// Visual hostess floor map.
//
// Server-renders the dining areas, their decorative elements (the bar),
// every table with its shape + position, and any reservations the table
// is hosting right now or in the next two hours. Hands it all to the
// FloorMap client component, which paints the SVG canvas and runs the
// hostess interactions.

import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { tenantWhere } from "@/lib/services/tenant";
import { deriveSeatedParty } from "@/lib/hospitality/seated-party";
import { FloorMap, type FloorArea, type FloorElement, type FloorMember } from "./FloorMap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseFloorElements(raw: string | null): FloorElement[] {
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    if (!Array.isArray(j)) return [];
    return j
      .filter((e) => e && typeof e === "object" && typeof e.kind === "string")
      .map((e) => ({
        kind: e.kind,
        x: Number(e.x ?? 0),
        y: Number(e.y ?? 0),
        width: Number(e.width ?? 100),
        height: Number(e.height ?? 30),
        rotation: e.rotation !== undefined ? Number(e.rotation) : undefined,
        label: typeof e.label === "string" ? e.label : undefined,
      }));
  } catch {
    return [];
  }
}

export default async function FloorPage() {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "reservations:read")) redirect("/app/admin");

  // Reservations within the next two hours surface as "upcoming"; anything
  // currently seated comes through the SEATED status filter.
  const now = new Date();
  const upcomingHorizon = new Date(now.getTime() + 2 * 60 * 60 * 1000);

  // Members list for the seating form's primary-member picker. Top 500
  // active members by last name keeps the datalist responsive.
  const memberRows = await prisma.member.findMany({
    where: { clubId, status: { in: ["ACTIVE", "ONBOARDING"] } },
    select: { id: true, firstName: true, lastName: true, memberNumber: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    take: 500,
  });
  const members: FloorMember[] = memberRows.map((m) => ({
    id: m.id, firstName: m.firstName, lastName: m.lastName, memberNumber: m.memberNumber,
  }));

  const areas = await prisma.diningArea.findMany({
    where: { ...tenantWhere(principal, clubId), active: true },
    orderBy: { sortOrder: "asc" },
    include: {
      tables: {
        where: { active: true },
        orderBy: { tableNumber: "asc" },
        include: {
          reservations: {
            where: {
              OR: [
                { status: "SEATED" },
                {
                  status: { in: ["CONFIRMED", "REQUESTED"] },
                  startTime: { gte: new Date(now.getTime() - 30 * 60 * 1000), lt: upcomingHorizon },
                },
              ],
            },
            orderBy: { startTime: "asc" },
            include: {
              member: { select: { firstName: true, lastName: true } },
              checkLinks: {
                include: {
                  posCheck: { select: { id: true, status: true } },
                  posSale:  { select: { grandTotal: true } },
                },
              },
            },
          },
          // Phase 18E + Step 18 — server-led self-seating: when a waiter
          // marks a table seated from the floor map, the POSCheck is
          // stamped with `tableId` but no DiningReservation is created.
          // Pull enough of the check to render the same seated-party
          // detail card a reservation-backed table gets (host name,
          // party size, seated-since timestamp).
          posChecks: {
            where: { status: { notIn: ["CLOSED", "VOIDED"] } },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              id: true,
              checkNumber: true,
              status: true,
              partySize: true,
              createdAt: true,
              guestName: true,
              member: { select: { firstName: true, lastName: true } },
              seats: {
                where: { isPrimary: true },
                orderBy: { seatNumber: "asc" },
                take: 1,
                select: {
                  guestName: true,
                  member: { select: { firstName: true, lastName: true } },
                },
              },
              _count: { select: { seats: true } },
            },
          },
        },
      },
    },
  });

  const payload: FloorArea[] = areas.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    canvasWidth: a.canvasWidth,
    canvasHeight: a.canvasHeight,
    floorElements: parseFloorElements(a.floorElementsJson),
    tables: a.tables.map((t) => {
      const live = t.reservations.find((r) => r.status === "SEATED") ?? null;
      const upcoming = !live ? (t.reservations.find((r) => r.status === "CONFIRMED" || r.status === "REQUESTED") ?? null) : null;
      function reservationDto(r: typeof t.reservations[number] | null) {
        if (!r) return null;
        const spend = r.checkLinks.reduce(
          (sum, l) => sum + (l.posSale?.grandTotal ? Number(l.posSale.grandTotal.toString()) : 0),
          0,
        );
        return {
          id: r.id,
          status: r.status,
          startTimeIso: r.startTime.toISOString(),
          actualSeatedAtIso: r.actualSeatedAt ? r.actualSeatedAt.toISOString() : null,
          partySize: r.partySize,
          memberName: r.member ? `${r.member.firstName} ${r.member.lastName}` : null,
          guestName: r.guestName,
          linkedSpend: spend,
          hasOpenCheck: r.checkLinks.length > 0,
        };
      }
      const openCheck = t.posChecks[0] ?? null;
      // Step 18 — unified seated-party derivation. A SEATED table
      // shows the same host/party/elapsed card regardless of seating
      // source. See src/lib/hospitality/seated-party.ts.
      const seatedParty = deriveSeatedParty({
        reservation: live,
        openCheck,
        tableStatus: t.status,
      });
      return {
        id: t.id,
        tableNumber: t.tableNumber,
        displayName: t.displayName,
        capacity: t.capacity,
        status: t.status,
        shape: (t.shape as "ROUND" | "SQUARE" | "RECTANGLE") ?? "ROUND",
        openCheckId: openCheck?.id ?? null,
        openCheckNumber: openCheck?.checkNumber ?? null,
        xPos: t.xPos,
        yPos: t.yPos,
        width: t.width,
        height: t.height,
        rotation: t.rotation,
        active: t.active,
        liveReservation: reservationDto(live),
        upcomingReservation: reservationDto(upcoming),
        seatedParty,
      };
    }),
  }));

  return (
    // Compact header keeps the map above the fold. The floor map owns
    // its own bounded height (calc(100vh - 220px)) so the page itself
    // does NOT scroll for normal hostess work.
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-3">
          <h1 className="font-serif text-2xl text-stone-900">Floor view</h1>
          <span className="text-xs text-stone-500 hidden md:inline">
            Click a table to seat a reservation, open a POS check, or reset the table.
          </span>
        </div>
        <div className="flex gap-2 text-xs">
          <Link href="/app/admin/hospitality/reservations" className="btn btn-secondary btn-sm">Reservations</Link>
          <Link href="/app/admin/hospitality/reservations/analytics" className="btn btn-secondary btn-sm">Analytics</Link>
          {hasPermission(principal, clubId, "hospitality:floor:edit") && (
            <Link href="/app/admin/ops/floor-plans" className="btn btn-secondary btn-sm">Edit Layout</Link>
          )}
        </div>
      </div>

      {areas.length === 0 ? (
        <div className="card card-body text-stone-500">
          No dining areas configured for this club yet. Add an area to get started.
        </div>
      ) : (
        <FloorMap areas={payload} members={members} />
      )}
    </div>
  );
}
