// Lounge dining reservations — host dashboard (today by default).

import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import {
  listReservationsForDate,
  listDiningAreas,
  getReservationSettings,
  isReservationStale,
  RESERVATION_ACTIVE_STATUSES,
} from "@/lib/hospitality/reservations";
import { tenantWhere } from "@/lib/services/tenant";
import { formatCurrency } from "@/lib/finance";
import { prisma } from "@/lib/prisma";
import { ReservationQuickAdd } from "./ReservationQuickAdd";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export default async function ReservationsPage({
  searchParams,
}: {
  searchParams: { date?: string; status?: string };
}) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "reservations:read")) redirect("/app/admin");
  const canManage = hasPermission(principal, clubId, "reservations:manage");

  const dateStr = searchParams.date ?? todayStr();
  const date = new Date(`${dateStr}T12:00:00Z`);

  const [reservations, areas, settings, members, staleActive] = await Promise.all([
    listReservationsForDate(principal, clubId, date),
    listDiningAreas(principal, clubId),
    getReservationSettings(clubId),
    canManage
      ? prisma.member.findMany({
          where: { clubId, status: { in: ["ACTIVE", "ONBOARDING"] } },
          select: { id: true, firstName: true, lastName: true, memberNumber: true },
          orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
          take: 500,
        })
      : Promise.resolve([]),
    // Step 15 — surface CONFIRMED / REQUESTED / SEATED reservations whose
    // window has elapsed (expectedEndTime + grace < now). These would
    // otherwise stay invisible behind the date filter even though they
    // block POS table reconciliation. The admin needs to resolve them
    // (mark no-show / completed / cancelled). SEATED is included so
    // overdue active parties don't disappear either.
    prisma.diningReservation.findMany({
      where: {
        ...tenantWhere(principal, clubId),
        status: { in: ["REQUESTED", "CONFIRMED", "SEATED"] },
        expectedEndTime: { lt: new Date(Date.now() - 120 * 60 * 1000) },
      },
      include: {
        member: { select: { firstName: true, lastName: true, memberNumber: true } },
        diningArea: { select: { name: true } },
        table: { select: { tableNumber: true, displayName: true } },
      },
      orderBy: { startTime: "asc" },
      take: 50,
    }),
  ]);
  // Re-confirm staleness through the canonical helper (we used a SQL
  // approximation above; the helper is the source of truth).
  const now = new Date();
  const staleReservations = staleActive.filter((r) =>
    isReservationStale({ status: r.status, startTime: r.startTime, expectedEndTime: r.expectedEndTime }, now),
  );
  void RESERVATION_ACTIVE_STATUSES;

  const status = (searchParams.status ?? "all").toLowerCase();
  const filtered = reservations.filter((r) => {
    if (status === "all") return true;
    if (status === "active") return ["CONFIRMED", "REQUESTED", "SEATED"].includes(r.status);
    if (status === "completed") return r.status === "COMPLETED";
    if (status === "no_show") return r.status === "NO_SHOW";
    if (status === "cancelled") return r.status === "CANCELLED";
    return r.status.toLowerCase() === status;
  });

  const todays = reservations;
  const counts = {
    seated: todays.filter((r) => r.status === "SEATED").length,
    confirmed: todays.filter((r) => r.status === "CONFIRMED").length,
    completed: todays.filter((r) => r.status === "COMPLETED").length,
    noShow: todays.filter((r) => r.status === "NO_SHOW").length,
    walkIns: todays.filter((r) => r.reservationType === "WALK_IN").length,
  };

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 justify-between">
        <div>
          <h1 className="page-title">Reservations</h1>
          <p className="mt-1 text-stone-500 max-w-2xl">
            Lounge dining reservations and walk-ins. Seat parties, open POS checks,
            mark departures, and track no-shows.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/app/admin/hospitality/reservations/floor" className="btn btn-secondary btn-sm">Floor view</Link>
          <Link href="/app/admin/hospitality/reservations/analytics" className="btn btn-secondary btn-sm">Analytics</Link>
        </div>
      </div>

      {/* Date + status filters */}
      <form method="get" className="mt-5 card card-body flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-stone-500 mb-1">Date</label>
          <input type="date" name="date" defaultValue={dateStr} className="input text-sm" />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-stone-500 mb-1">Status</label>
          <select name="status" defaultValue={status} className="input text-sm">
            <option value="all">All</option>
            <option value="active">Active (incl. seated)</option>
            <option value="completed">Completed</option>
            <option value="no_show">No-show</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
        <button className="btn btn-secondary btn-sm">Apply</button>
        <div className="ml-auto flex flex-wrap gap-3 text-xs">
          <Counter label="Seated"     n={counts.seated}     tone="green" />
          <Counter label="Confirmed"  n={counts.confirmed}  tone="blue"  />
          <Counter label="Completed"  n={counts.completed}  tone="stone" />
          <Counter label="Walk-ins"   n={counts.walkIns}    tone="amber" />
          <Counter label="No-show"    n={counts.noShow}     tone={counts.noShow > 0 ? "red" : "stone"} />
        </div>
      </form>

      {/* Quick add panel */}
      {canManage && (
        <ReservationQuickAdd
          areas={areas.map((a) => ({
            id: a.id,
            name: a.name,
            tables: a.tables.map((t) => ({ id: t.id, tableNumber: t.tableNumber, displayName: t.displayName, capacity: t.capacity })),
          }))}
          members={members}
          defaultDurationMin={settings.defaultReservationDurationMinutes}
          dateStr={dateStr}
        />
      )}

      {/* Step 15 — Stale active reservations. CONFIRMED / REQUESTED /
          SEATED whose window has elapsed beyond the 2-hour grace.
          These were previously invisible (date filter hid them) and
          would block POS table reconciliation. Surface them so a host
          can mark no-show / completed / cancelled. */}
      {staleReservations.length > 0 && (
        <section className="mt-6">
          <div className="flex items-baseline justify-between">
            <h2 className="font-serif text-xl text-club-ink">Needs attention</h2>
            <span className="text-xs text-stone-500">
              {staleReservations.length} stale reservation{staleReservations.length === 1 ? "" : "s"}
            </span>
          </div>
          <p className="mt-1 text-xs text-stone-500 max-w-3xl">
            These reservations are past their expected end time but still marked active.
            Mark them no-show, completed, or cancelled so the table can be reset.
          </p>
          <div className="mt-2 card overflow-hidden border-amber-200">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Start</th>
                  <th>Guest</th>
                  <th>Area / table</th>
                  <th>Status</th>
                  <th>Hours overdue</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {staleReservations.map((r) => {
                  const hoursOverdue = (now.getTime() - r.expectedEndTime.getTime()) / 3_600_000;
                  const guestName = r.member ? `${r.member.firstName} ${r.member.lastName}` : r.guestName ?? "—";
                  return (
                    <tr key={r.id} className="bg-amber-50/40">
                      <td className="text-xs font-mono">{r.startTime.toISOString().slice(0, 16).replace("T", " ")}</td>
                      <td className="text-sm">
                        {guestName}
                        {r.member?.memberNumber && <div className="text-[10px] text-stone-400">{r.member.memberNumber}</div>}
                      </td>
                      <td className="text-xs">
                        <div>{r.diningArea.name}</div>
                        {r.table && <div className="text-stone-500">{r.table.displayName ?? `Table ${r.table.tableNumber}`}</div>}
                      </td>
                      <td><StatusBadge status={r.status} /></td>
                      <td className="text-xs text-amber-800">{hoursOverdue.toFixed(1)}h</td>
                      <td className="text-right text-xs">
                        <Link href={`/app/admin/hospitality/reservations/${r.id}`} className="text-club-green-700 hover:underline">Open</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Reservations table */}
      <div className="mt-6 card overflow-hidden">
        <div className="px-5 py-3 border-b border-stone-200 font-medium">
          {dateStr} · {filtered.length} record{filtered.length === 1 ? "" : "s"}
        </div>
        <table className="table-base">
          <thead>
            <tr>
              <th>Time</th>
              <th>Guest</th>
              <th>Type</th>
              <th>Party</th>
              <th>Area / table</th>
              <th>Status</th>
              <th>Spend</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-10 text-center text-sm text-stone-500">No reservations for this filter.</td></tr>
            )}
            {filtered.map((r) => {
              const linkedSpend = r.checkLinks.reduce(
                (sum, l) => sum + (l.posSale?.grandTotal ? Number(l.posSale.grandTotal.toString()) : 0),
                0,
              );
              const time = new Date(r.startTime).toISOString().slice(11, 16);
              const guestName = r.member ? `${r.member.firstName} ${r.member.lastName}` : r.guestName ?? "—";
              return (
                <tr key={r.id}>
                  <td className="text-xs whitespace-nowrap font-mono">{time}</td>
                  <td className="text-sm">
                    {guestName}
                    {r.member?.memberNumber && <div className="text-[10px] text-stone-400">{r.member.memberNumber}</div>}
                  </td>
                  <td className="text-xs text-stone-600">{r.reservationType === "WALK_IN" ? "Walk-in" : r.reservationType === "GUEST" ? "Guest" : "Member"}</td>
                  <td className="text-sm">{r.partySize}</td>
                  <td className="text-xs">
                    <div>{r.diningArea.name}</div>
                    {r.table && <div className="text-stone-500">{r.table.displayName ?? `Table ${r.table.tableNumber}`}</div>}
                  </td>
                  <td><StatusBadge status={r.status} /></td>
                  <td className="text-xs text-right tabular-nums">{linkedSpend > 0 ? formatCurrency(linkedSpend) : "—"}</td>
                  <td className="text-right text-xs">
                    <Link href={`/app/admin/hospitality/reservations/${r.id}`} className="text-club-green-700 hover:underline">Open</Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Counter({ label, n, tone }: { label: string; n: number; tone: "stone" | "green" | "blue" | "amber" | "red" }) {
  const toneCls = {
    stone: "bg-stone-100 text-stone-700 border-stone-300",
    green: "bg-club-green-50 text-club-green-800 border-club-green-300",
    blue: "bg-blue-50 text-blue-800 border-blue-300",
    amber: "bg-amber-50 text-amber-800 border-amber-300",
    red: "bg-red-50 text-red-800 border-red-300",
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 ${toneCls}`}>
      <span className="text-[10px] uppercase tracking-wide">{label}</span>
      <span className="font-medium">{n}</span>
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const m: Record<string, string> = {
    REQUESTED: "bg-stone-100 text-stone-700 border-stone-300",
    CONFIRMED: "bg-blue-50 text-blue-800 border-blue-300",
    SEATED: "bg-club-green-50 text-club-green-800 border-club-green-300",
    COMPLETED: "bg-stone-100 text-stone-600 border-stone-300",
    CANCELLED: "bg-stone-100 text-stone-500 border-stone-300",
    NO_SHOW: "bg-red-50 text-red-800 border-red-300",
  };
  const tone = m[status] ?? "bg-stone-100 text-stone-700 border-stone-300";
  return (
    <span className={`inline-flex rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wide ${tone}`}>
      {status.replace("_", " ")}
    </span>
  );
}
