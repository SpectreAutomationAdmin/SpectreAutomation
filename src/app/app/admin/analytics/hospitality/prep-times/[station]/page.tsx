// Per-station drilldown. Same KPI overview as the headline dashboard
// but scoped to one station, with a paginated chit-level table so
// managers can investigate outliers. Each row links back into the POS
// for the underlying check.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import {
  comparePrepTime,
  formatDuration,
  getDrilldownChits,
  getPrepTimeTrend,
  periodName,
  STATION_THRESHOLDS,
  stationName,
  thresholdToneClass,
  type Station,
  type ServicePeriod,
} from "@/lib/analytics/hospitality";
import { resolveRange } from "@/lib/analytics/ranges";
import { RangeSelector, type RangePreset } from "@/components/analytics/RangeSelector";
import { KpiCard } from "@/components/analytics/KpiCard";
import { TrendChart } from "@/components/analytics/TrendChart";
import { KPI_HELP } from "@/components/analytics/kpiHelp";

const VALID_STATIONS = new Set<Station>(["KITCHEN", "BAR", "DESSERT"]);

export default async function StationDrilldown({
  params,
  searchParams,
}: {
  params: { station: string };
  searchParams: { range?: string; period?: string; late?: string; cancelled?: string };
}) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = principal.activeClubId;
  if (!clubId || !hasPermission(principal, clubId, "kpi:read")) {
    redirect("/app/admin");
  }
  const station = params.station.toUpperCase() as Station;
  if (!VALID_STATIONS.has(station)) notFound();

  const preset = (searchParams.range as RangePreset) || "THIS_WEEK";
  const { current, prior, label } = resolveRange(preset);
  const servicePeriod = (searchParams.period as ServicePeriod) || undefined;
  const lateOnly = searchParams.late === "1";
  const cancelledOnly = searchParams.cancelled === "1";

  const [comp, trend, drill] = await Promise.all([
    comparePrepTime(principal, clubId, current, prior, station),
    getPrepTimeTrend(principal, clubId, { ...current, granularity: pickGranularity(current), station }),
    getDrilldownChits(principal, clubId, {
      ...current,
      station,
      servicePeriod,
      lateOnly,
      cancelledOnly,
      limit: 100,
    }),
  ]);

  const stats =
    station === "KITCHEN" ? comp.current.kitchen : station === "BAR" ? comp.current.bar : comp.current.dessert;
  const priorStats =
    station === "KITCHEN" ? comp.prior.kitchen : station === "BAR" ? comp.prior.bar : comp.prior.dessert;
  const t = STATION_THRESHOLDS[station];

  return (
    <div>
      <div className="text-xs text-stone-400">
        <Link href="/app/admin/analytics/hospitality/prep-times" className="hover:underline">
          Prep times
        </Link>{" "}
        / {stationName(station)}
      </div>
      <div className="mt-1 flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="page-title">{stationName(station)} prep times</h1>
          <p className="mt-1 text-sm text-stone-500">
            {label}. Target {formatDuration(t.greenMaxSec)} · amber over{" "}
            {formatDuration(t.greenMaxSec)} · red over {formatDuration(t.amberMaxSec)}.
          </p>
        </div>
        <RangeSelector defaultPreset="THIS_WEEK" />
      </div>

      {/* ----- KPI cards ----- */}
      <div className="mt-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        <KpiCard
          label="Average prep"
          value={formatDuration(stats.avgSec)}
          status={stats.status}
          delta={makeDelta(stats.avgSec, priorStats.avgSec)}
          help={KPI_HELP.drilldownAverage}
        />
        <KpiCard
          label="Median"
          value={formatDuration(stats.medianSec)}
          status={stats.medianSec === null ? null : stats.status}
          help={KPI_HELP.drilldownMedian}
        />
        <KpiCard label="p90" value={formatDuration(stats.p90Sec)} help={KPI_HELP.drilldownP90} />
        <KpiCard
          label="Total chits"
          value={String(stats.totalChits)}
          secondary={`${stats.completedChits} completed`}
          help={KPI_HELP.totalChits}
        />
        <KpiCard
          label="Late / cancelled"
          value={`${stats.lateChits} / ${stats.cancelledChits}`}
          status={stats.lateChits > 0 ? "RED" : stats.cancelledChits > 0 ? "AMBER" : "GREEN"}
          help={KPI_HELP.lateAndCancelled}
        />
      </div>

      <div className="mt-4">
        <TrendChart
          title={`${stationName(station)} prep — trend`}
          unit="duration"
          thresholdSec={t.greenMaxSec}
          points={trend.map((p) => ({
            label: p.bucket,
            bucketStart: p.bucketStart,
            valueSec: p.avgSec,
            totalChits: p.totalChits,
          }))}
        />
      </div>

      {/* ----- Filter row ----- */}
      <div className="mt-6 flex items-center gap-3 flex-wrap text-xs">
        <span className="text-stone-500">Filter:</span>
        <FilterChip label="All periods" param="period" value={null} active={!servicePeriod} preset={preset} />
        {(["BREAKFAST", "LUNCH", "AFTERNOON", "DINNER"] as ServicePeriod[]).map((p) => (
          <FilterChip key={p} label={periodName(p)} param="period" value={p} active={servicePeriod === p} preset={preset} />
        ))}
        <span className="text-stone-300">·</span>
        <FilterChip label="Late only" param="late" value={lateOnly ? null : "1"} active={lateOnly} preset={preset} />
        <FilterChip label="Cancelled only" param="cancelled" value={cancelledOnly ? null : "1"} active={cancelledOnly} preset={preset} />
      </div>

      {/* ----- Drilldown table ----- */}
      <div className="mt-3 card overflow-hidden">
        <div className="px-5 py-3 border-b border-stone-200 font-medium flex items-center justify-between">
          <span>Chits ({drill.rows.length})</span>
          {drill.rows.length === 100 && (
            <span className="text-xs text-stone-500">Showing first 100 — narrow the range to see more.</span>
          )}
        </div>
        <table className="table-base">
          <thead>
            <tr>
              <th>Time</th>
              <th>Check</th>
              <th>Server</th>
              <th>Member / Table</th>
              <th>Items</th>
              <th className="text-right">Prep</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {drill.rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-stone-500">
                  No chits match those filters.
                </td>
              </tr>
            )}
            {drill.rows.map((r) => {
              const tone = thresholdToneClass(r.prepStatus);
              const sentLabel = r.firedAt ?? r.sentAt;
              return (
                <tr key={r.chitId}>
                  <td className="text-xs whitespace-nowrap">
                    <div className="font-medium text-club-ink">{formatTime(sentLabel)}</div>
                    <div className="text-stone-400">{r.servicePeriod ? periodName(r.servicePeriod) : "—"}</div>
                  </td>
                  <td className="text-xs">
                    <Link
                      href={`/app/admin/ops/pos/lounge`}
                      className="font-mono text-club-green-700 hover:underline"
                      title={`Open check ${r.checkNumber}`}
                    >
                      {r.checkNumber}
                    </Link>
                    <div className="text-[10px] text-stone-400">Course {r.course}</div>
                  </td>
                  <td className="text-xs text-stone-600">{r.serverName ?? "—"}</td>
                  <td className="text-xs text-stone-600">
                    {r.memberName ?? r.tableNumber ?? "Guest"}
                  </td>
                  <td className="text-xs text-stone-600 max-w-[24rem] truncate" title={r.itemSummary}>
                    {r.itemSummary}
                  </td>
                  <td className="text-xs text-right">
                    <span className={`inline-block rounded-md border px-2 py-0.5 tabular-nums ${tone}`}>
                      {r.prepSeconds === null ? "—" : formatDuration(r.prepSeconds)}
                    </span>
                  </td>
                  <td className="text-xs">
                    {r.isCancelled ? (
                      <span className="inline-block rounded-md border border-stone-200 bg-stone-50 px-2 py-0.5 text-stone-500 text-[10px] uppercase tracking-wide">
                        Cancelled
                      </span>
                    ) : r.isLate ? (
                      <span className="inline-block rounded-md border border-red-200 bg-red-50 px-2 py-0.5 text-red-700 text-[10px] uppercase tracking-wide">
                        Late
                      </span>
                    ) : (
                      <span className="inline-block rounded-md border border-stone-200 bg-white px-2 py-0.5 text-stone-500 text-[10px] uppercase tracking-wide">
                        {r.status}
                      </span>
                    )}
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

function pickGranularity(r: { from: Date; to: Date }): "DAY" | "WEEK" | "MONTH" {
  const days = (r.to.getTime() - r.from.getTime()) / 86400000;
  if (days <= 21) return "DAY";
  if (days <= 90) return "WEEK";
  return "MONTH";
}

function makeDelta(current: number | null, prior: number | null) {
  if (current === null || prior === null) return null;
  const diff = current - prior;
  if (Math.abs(diff) < 1) return { value: "no change", direction: "flat" as const, intent: "neutral" as const };
  return {
    value: formatDuration(Math.abs(diff)),
    direction: diff > 0 ? ("up" as const) : ("down" as const),
    // lower prep time is better
    intent: diff < 0 ? ("good" as const) : ("bad" as const),
  };
}

function formatTime(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function FilterChip({
  label,
  param,
  value,
  active,
  preset,
}: {
  label: string;
  param: string;
  value: string | null;
  active: boolean;
  preset: RangePreset;
}) {
  // Build the href for this chip, preserving the current range.
  const search = new URLSearchParams({ range: preset });
  // For the all-periods chip, just don't set period.
  if (param === "period") {
    if (value) search.set("period", value);
  } else if (param === "late") {
    if (value === "1") search.set("late", "1");
  } else if (param === "cancelled") {
    if (value === "1") search.set("cancelled", "1");
  }
  return (
    <Link
      href={`?${search.toString()}`}
      className={`inline-flex items-center rounded-md border px-2.5 py-1 text-xs ${
        active
          ? "bg-club-green-700 text-white border-club-green-700"
          : "bg-white text-stone-600 border-stone-200 hover:border-club-green-400 hover:bg-stone-50"
      }`}
    >
      {label}
    </Link>
  );
}
