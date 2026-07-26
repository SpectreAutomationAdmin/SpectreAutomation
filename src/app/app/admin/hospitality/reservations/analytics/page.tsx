// Lounge dining analytics — KPI cards + comparison vs prior window
// + a drilldown table. Direct queries against the reservation /
// POS sale / survey-response tables.

import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import {
  getOperationalKpisVsPrior,
  type OperationalKpis,
} from "@/lib/hospitality/dining-analytics";
import { listReservationsForDate, listDiningAreas } from "@/lib/hospitality/reservations";
import { formatCurrency } from "@/lib/finance";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function pickRange(searchParams: { from?: string; to?: string; preset?: string }): { from: Date; to: Date; label: string } {
  const now = new Date();
  if (searchParams.from && searchParams.to) {
    return {
      from: new Date(`${searchParams.from}T00:00:00Z`),
      to: new Date(`${searchParams.to}T23:59:59Z`),
      label: `${searchParams.from} → ${searchParams.to}`,
    };
  }
  const preset = searchParams.preset ?? "30d";
  if (preset === "7d") {
    return { from: addDays(now, -7), to: now, label: "Last 7 days" };
  }
  if (preset === "ytd") {
    return { from: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)), to: now, label: "Year-to-date" };
  }
  if (preset === "year") {
    return { from: addDays(now, -365), to: now, label: "Last 365 days" };
  }
  return { from: addDays(now, -30), to: now, label: "Last 30 days" };
}
function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string; preset?: string; areaId?: string; type?: string };
}) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "reservations:read")) redirect("/app/admin");

  const range = pickRange(searchParams);
  const areaId = searchParams.areaId || undefined;
  const type =
    searchParams.type === "MEMBER" || searchParams.type === "WALK_IN" || searchParams.type === "GUEST"
      ? (searchParams.type as "MEMBER" | "WALK_IN" | "GUEST")
      : undefined;

  const [{ current, prior }, areas, drilldown] = await Promise.all([
    getOperationalKpisVsPrior(principal, clubId, { from: range.from, to: range.to, diningAreaId: areaId, reservationType: type }),
    listDiningAreas(principal, clubId),
    prisma.diningReservation.findMany({
      where: {
        clubId,
        startTime: { gte: range.from, lt: range.to },
        ...(areaId ? { diningAreaId: areaId } : {}),
        ...(type ? { reservationType: type } : {}),
      },
      include: {
        member: { select: { firstName: true, lastName: true, memberNumber: true } },
        diningArea: { select: { name: true } },
        table: { select: { tableNumber: true } },
        checkLinks: { include: { posSale: { select: { grandTotal: true } } } },
      },
      orderBy: { startTime: "desc" },
      take: 200,
    }),
  ]);

  // Ratings index by reservation member+date so each drilldown row can
  // show the linked rating without a per-row round-trip.
  const memberIds = drilldown.map((r) => r.memberId).filter((id): id is string => !!id);
  const ratings = await prisma.hospitalitySurveyResponse.findMany({
    where: { clubId, memberId: { in: memberIds }, submittedAt: { gte: range.from, lt: range.to } },
    select: { memberId: true, rating: true, submittedAt: true },
  });

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Dining analytics</h1>
          <p className="mt-1 text-sm text-stone-500 max-w-2xl">
            {range.label}. Comparison against the same-length prior window.
          </p>
        </div>
        <div className="flex gap-2 text-xs">
          <Link href="/app/admin/hospitality/reservations" className="btn btn-secondary btn-sm">Reservations</Link>
          <Link href="/app/admin/hospitality/reservations/floor" className="btn btn-secondary btn-sm">Floor view</Link>
        </div>
      </div>

      {/* Filters */}
      <form method="get" className="mt-5 card card-body flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-stone-500 mb-1">Preset</label>
          <select name="preset" defaultValue={searchParams.preset ?? "30d"} className="input text-sm">
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="ytd">Year-to-date</option>
            <option value="year">Last 365 days</option>
          </select>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-stone-500 mb-1">Or pick a range</label>
          <div className="flex gap-2">
            <input type="date" name="from" defaultValue={searchParams.from ?? ""} className="input text-sm" />
            <input type="date" name="to" defaultValue={searchParams.to ?? ""} className="input text-sm" />
          </div>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-stone-500 mb-1">Area</label>
          <select name="areaId" defaultValue={areaId ?? ""} className="input text-sm">
            <option value="">All areas</option>
            {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-stone-500 mb-1">Type</label>
          <select name="type" defaultValue={type ?? ""} className="input text-sm">
            <option value="">All</option>
            <option value="MEMBER">Member reservation</option>
            <option value="WALK_IN">Walk-in</option>
            <option value="GUEST">Guest</option>
          </select>
        </div>
        <button className="btn btn-secondary btn-sm">Apply</button>
      </form>

      <KpiGrid current={current} prior={prior} />

      <PlainLanguageSummary current={current} prior={prior} />

      <div className="mt-6 card overflow-hidden">
        <div className="px-5 py-3 border-b border-stone-200 font-medium">Drilldown ({drilldown.length})</div>
        <table className="table-base">
          <thead>
            <tr>
              <th>Date / time</th>
              <th>Member / guest</th>
              <th>Type</th>
              <th>Party</th>
              <th>Area / table</th>
              <th>Duration</th>
              <th className="text-right">Spend</th>
              <th>Rating</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {drilldown.length === 0 && (
              <tr><td colSpan={9} className="px-4 py-10 text-center text-sm text-stone-500">Nothing for this filter.</td></tr>
            )}
            {drilldown.map((r) => {
              const duration =
                r.actualSeatedAt && r.actualDepartedAt
                  ? Math.round((r.actualDepartedAt.getTime() - r.actualSeatedAt.getTime()) / 60_000)
                  : null;
              const spend = r.checkLinks.reduce(
                (sum, l) => sum + (l.posSale?.grandTotal ? Number(l.posSale.grandTotal.toString()) : 0),
                0,
              );
              const memberRating = r.memberId
                ? ratings
                    .filter((rt) => rt.memberId === r.memberId)
                    .sort((a, b) => Math.abs(a.submittedAt.getTime() - r.startTime.getTime()) - Math.abs(b.submittedAt.getTime() - r.startTime.getTime()))[0]?.rating ?? null
                : null;
              return (
                <tr key={r.id}>
                  <td className="text-xs">{r.startTime.toISOString().slice(0, 16).replace("T", " ")}</td>
                  <td className="text-sm">
                    {r.member ? `${r.member.firstName} ${r.member.lastName}` : r.guestName ?? "—"}
                    {r.member?.memberNumber && <div className="text-[10px] text-stone-400">{r.member.memberNumber}</div>}
                  </td>
                  <td className="text-xs">{r.reservationType === "WALK_IN" ? "Walk-in" : r.reservationType === "GUEST" ? "Guest" : "Member"}</td>
                  <td className="text-sm">{r.partySize}</td>
                  <td className="text-xs">{r.diningArea.name}{r.table ? ` · ${r.table.tableNumber}` : ""}</td>
                  <td className="text-xs">{duration !== null ? `${duration} min` : "—"}</td>
                  <td className="text-xs text-right tabular-nums">{spend > 0 ? formatCurrency(spend) : "—"}</td>
                  <td className="text-xs">{memberRating !== null ? `${"⭐".repeat(memberRating)} ${memberRating}/5` : "—"}</td>
                  <td className="text-xs">{r.status.replace("_", " ")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function KpiGrid({ current, prior }: { current: OperationalKpis; prior: OperationalKpis }) {
  return (
    <div className="mt-6 grid grid-cols-2 md:grid-cols-5 gap-3">
      <Kpi label="Covers" value={String(current.totalCovers)} delta={delta(current.totalCovers, prior.totalCovers)} />
      <Kpi label="Reservations" value={String(current.totalReservations)} delta={delta(current.totalReservations, prior.totalReservations)} />
      <Kpi label="Walk-ins" value={String(current.totalWalkIns)} delta={delta(current.totalWalkIns, prior.totalWalkIns)} />
      <Kpi label="No-shows" value={`${(current.noShowRate * 100).toFixed(1)}%`} sub={`${current.noShows} this period`} delta={pctDelta(current.noShowRate, prior.noShowRate)} invertDelta />
      <Kpi label="Cancellation rate" value={`${(current.cancellationRate * 100).toFixed(1)}%`} sub={`${current.cancellations} this period`} delta={pctDelta(current.cancellationRate, prior.cancellationRate)} invertDelta />
      <Kpi label="Avg duration" value={current.avgTableDurationMinutes !== null ? `${Math.round(current.avgTableDurationMinutes)} min` : "—"} delta={current.avgTableDurationMinutes && prior.avgTableDurationMinutes ? delta(Math.round(current.avgTableDurationMinutes), Math.round(prior.avgTableDurationMinutes)) : null} />
      <Kpi label="Avg spend per cover" value={current.avgSpendPerCover !== null ? formatCurrency(current.avgSpendPerCover) : "—"} delta={current.avgSpendPerCover && prior.avgSpendPerCover ? delta(Math.round(current.avgSpendPerCover * 100), Math.round(prior.avgSpendPerCover * 100)) : null} />
      <Kpi label="Total spend" value={formatCurrency(current.totalSpend)} delta={delta(Math.round(current.totalSpend), Math.round(prior.totalSpend))} />
      <Kpi label="Avg rating" value={current.avgRating !== null ? current.avgRating.toFixed(2) : "—"} sub={current.avgRating !== null ? `out of 5` : undefined} />
      <Kpi label="Ratings < 5" value={String(current.ratingsBelow5)} sub={current.ratingsBelow5 > 0 ? "service recovery" : undefined} />
    </div>
  );
}

function PlainLanguageSummary({ current, prior }: { current: OperationalKpis; prior: OperationalKpis }) {
  const lines: string[] = [];
  if (current.avgTableDurationMinutes !== null && prior.avgTableDurationMinutes !== null) {
    const diff = Math.round(current.avgTableDurationMinutes - prior.avgTableDurationMinutes);
    if (diff !== 0) {
      lines.push(`Average table duration is ${Math.round(current.avgTableDurationMinutes)} minutes, ${diff > 0 ? "up" : "down"} ${Math.abs(diff)} from the prior window.`);
    }
  }
  const totalSeated = current.totalReservations + current.totalWalkIns;
  if (totalSeated > 0) {
    const walkInPct = (current.totalWalkIns / totalSeated) * 100;
    lines.push(`Walk-ins represented ${walkInPct.toFixed(0)}% of covers this period.`);
  }
  if (current.avgSpendPerCover !== null) {
    lines.push(`Average spend per cover this period is ${formatCurrency(current.avgSpendPerCover)}.`);
  }
  if (current.noShowRate > 0) {
    lines.push(`No-show rate is ${(current.noShowRate * 100).toFixed(1)}% this period.`);
  }
  if (lines.length === 0) return null;
  return (
    <div className="mt-4 rounded-md border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-700">
      <ul className="list-disc pl-5 space-y-1">
        {lines.map((l, i) => <li key={i}>{l}</li>)}
      </ul>
    </div>
  );
}

function Kpi({ label, value, sub, delta, invertDelta }: { label: string; value: string; sub?: string; delta?: { value: string; direction: "up" | "down" | "flat" } | null; invertDelta?: boolean }) {
  const dir = delta?.direction ?? "flat";
  const good = invertDelta ? dir === "down" : dir === "up";
  const bad = invertDelta ? dir === "up" : dir === "down";
  const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "■";
  const tone = dir === "flat" ? "text-stone-500" : good ? "text-club-green-700" : bad ? "text-red-700" : "text-stone-500";
  return (
    <div className="rounded-md border border-stone-200 bg-white px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-stone-500">{label}</div>
      <div className="mt-1 font-serif text-xl text-stone-900">{value}</div>
      <div className="mt-1 flex items-center justify-between text-[11px]">
        <span className="text-stone-500">{sub ?? ""}</span>
        {delta && <span className={tone}>{arrow} {delta.value}</span>}
      </div>
    </div>
  );
}

function delta(curr: number, prior: number): { value: string; direction: "up" | "down" | "flat" } {
  if (curr === prior) return { value: "0", direction: "flat" };
  const diff = curr - prior;
  return { value: `${Math.abs(diff)}`, direction: diff > 0 ? "up" : "down" };
}
function pctDelta(curr: number, prior: number): { value: string; direction: "up" | "down" | "flat" } {
  const diff = (curr - prior) * 100;
  if (Math.abs(diff) < 0.05) return { value: "0", direction: "flat" };
  return { value: `${Math.abs(diff).toFixed(1)} pp`, direction: diff > 0 ? "up" : "down" };
}
