// Prep-time analytics dashboard.
//
// Server-rendered: pulls everything for the selected range, computes
// KPIs, comparison vs prior period, daily trend, distribution per
// station, service-period heatmap, and manager insights — then renders.
// No client-side data fetching; the RangeSelector navigates with a
// query param and the server recomputes.

import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import {
  comparePrepTime,
  formatDuration,
  generateInsights,
  getCategoryBreakdown,
  getPrepTimeTrend,
  getServicePeriodMatrix,
  periodName,
  prepTimeSeconds,
  STATION_THRESHOLDS,
  stationName,
  thresholdToneClass,
  type Station,
} from "@/lib/analytics/hospitality";
import { resolveRange } from "@/lib/analytics/ranges";
import { RangeSelector, type RangePreset } from "@/components/analytics/RangeSelector";
import { KpiCard } from "@/components/analytics/KpiCard";
import { TrendChart } from "@/components/analytics/TrendChart";
import { Distribution } from "@/components/analytics/Distribution";
import { ServiceHeatmap } from "@/components/analytics/ServiceHeatmap";
import { InsightsList } from "@/components/analytics/InsightsList";
import { KPI_HELP } from "@/components/analytics/kpiHelp";
import { prisma } from "@/lib/prisma";

export default async function PrepTimesDashboard({
  searchParams,
}: {
  searchParams: { range?: string };
}) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = principal.activeClubId;
  if (!clubId || !hasPermission(principal, clubId, "kpi:read")) {
    redirect("/app/admin");
  }

  const preset = (searchParams.range as RangePreset) || "THIS_WEEK";
  const { current, prior, label } = resolveRange(preset);

  // Server work in parallel.
  const [comp, dailyTrend, heatmap, categories, insights, durationsForDistribution] = await Promise.all([
    comparePrepTime(principal, clubId, current, prior),
    getPrepTimeTrend(principal, clubId, { ...current, granularity: pickGranularity(current) }),
    getServicePeriodMatrix(principal, clubId, current),
    getCategoryBreakdown(principal, clubId, current),
    generateInsights(principal, clubId, current),
    loadDurations(clubId, current.from, current.to),
  ]);

  const k = comp.current.kitchen;
  const b = comp.current.bar;
  const d = comp.current.dessert;
  const totalCancelled = k.cancelledChits + b.cancelledChits + d.cancelledChits;

  return (
    <div>
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="page-title">Kitchen &amp; Bar prep times</h1>
          <p className="mt-1 text-sm text-stone-500">
            Operational performance from the lounge POS check workflow.{" "}
            <span className="text-stone-400">{label}.</span>
          </p>
        </div>
        <RangeSelector defaultPreset="THIS_WEEK" />
      </div>

      {/* ----- Headline KPI cards ----- */}
      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Avg kitchen prep"
          value={formatDuration(k.avgSec)}
          secondary={k.completedChits === 0 ? "No data" : `${k.completedChits} chits`}
          status={k.status}
          delta={makeDelta(k.avgSec, comp.prior.kitchen.avgSec, "duration", "lower-is-better")}
          href="/app/admin/analytics/hospitality/prep-times/KITCHEN"
          help={KPI_HELP.avgKitchen}
        />
        <KpiCard
          label="Avg bar prep"
          value={formatDuration(b.avgSec)}
          secondary={b.completedChits === 0 ? "No data" : `${b.completedChits} chits`}
          status={b.status}
          delta={makeDelta(b.avgSec, comp.prior.bar.avgSec, "duration", "lower-is-better")}
          href="/app/admin/analytics/hospitality/prep-times/BAR"
          help={KPI_HELP.avgBar}
        />
        <KpiCard
          label="Median kitchen"
          value={formatDuration(k.medianSec)}
          secondary={`p90 ${formatDuration(k.p90Sec)}`}
          status={k.medianSec === null ? null : k.status}
          help={KPI_HELP.medianKitchen}
        />
        <KpiCard
          label="Median bar"
          value={formatDuration(b.medianSec)}
          secondary={`p90 ${formatDuration(b.p90Sec)}`}
          status={b.medianSec === null ? null : b.status}
          help={KPI_HELP.medianBar}
        />
      </div>

      {/* ----- Volume + exception cards ----- */}
      <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <KpiCard label="Kitchen chits" value={String(k.totalChits)} help={KPI_HELP.kitchenChits} />
        <KpiCard label="Bar chits" value={String(b.totalChits)} help={KPI_HELP.barChits} />
        <KpiCard label="Late kitchen" value={String(k.lateChits)} status={k.lateChits > 0 ? "RED" : "GREEN"} help={KPI_HELP.lateKitchen} />
        <KpiCard label="Late bar" value={String(b.lateChits)} status={b.lateChits > 0 ? "RED" : "GREEN"} help={KPI_HELP.lateBar} />
        <KpiCard label="Cancelled" value={String(totalCancelled)} status={totalCancelled > 0 ? "AMBER" : "GREEN"} help={KPI_HELP.cancelled} />
        <KpiCard
          label="Busiest period"
          value={comp.current.busiestPeriod ? periodName(comp.current.busiestPeriod) : "—"}
          secondary={comp.current.slowestPeriod ? `Slowest: ${periodName(comp.current.slowestPeriod)}` : null}
          help={KPI_HELP.busiestPeriod}
        />
      </div>

      {/* ----- Narrative comparison ----- */}
      {comp.narrative.length > 0 && (
        <div className="mt-4 card card-body">
          <div className="font-medium text-club-ink">Period comparison</div>
          <ul className="mt-2 space-y-1 text-sm text-stone-700">
            {comp.narrative.map((line, i) => (
              <li key={i}>· {line}</li>
            ))}
          </ul>
        </div>
      )}

      {/* ----- Trend + heatmap ----- */}
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TrendChart
          title={`Kitchen prep — ${granularityLabel(pickGranularity(current))} average`}
          unit="duration"
          thresholdSec={STATION_THRESHOLDS.KITCHEN.greenMaxSec}
          points={dailyTrend.map((p) => ({
            label: p.bucket,
            bucketStart: p.bucketStart,
            valueSec: p.avgSec,
            totalChits: p.totalChits,
          }))}
        />
        <TrendChart
          title="Bar prep — same window"
          unit="duration"
          thresholdSec={STATION_THRESHOLDS.BAR.greenMaxSec}
          // We computed a single trend across both stations above; pull
          // a bar-only series in parallel for the second chart.
          // To keep the page lean, we re-bucket from the same data:
          points={await loadStationTrend(principal, clubId, current, "BAR")}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Distribution
          title="Kitchen prep-time distribution"
          station="KITCHEN"
          durations={durationsForDistribution.kitchen}
        />
        <Distribution
          title="Bar prep-time distribution"
          station="BAR"
          durations={durationsForDistribution.bar}
        />
        <InsightsList insights={insights} />
      </div>

      <div className="mt-4">
        <ServiceHeatmap cells={heatmap} />
      </div>

      {/* ----- Category breakdown ----- */}
      {categories.length > 0 && (
        <div className="mt-4 card overflow-hidden">
          <div className="px-5 py-3 border-b border-stone-200 font-medium">Menu categories — slowest first</div>
          <table className="table-base">
            <thead>
              <tr>
                <th>Category</th>
                <th className="text-right">Chits</th>
                <th className="text-right">Late</th>
                <th className="text-right">Avg prep</th>
                <th className="text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => {
                const station: Station = "KITCHEN"; // categories are mostly kitchen; status colour reflects K threshold
                const status = c.avgSec !== null
                  ? c.avgSec <= STATION_THRESHOLDS[station].greenMaxSec
                    ? "GREEN"
                    : c.avgSec <= STATION_THRESHOLDS[station].amberMaxSec
                    ? "AMBER"
                    : "RED"
                  : null;
                return (
                  <tr key={c.categoryName}>
                    <td className="text-sm text-club-ink">{c.categoryName}</td>
                    <td className="text-sm text-right tabular-nums">{c.totalChits}</td>
                    <td className={`text-sm text-right tabular-nums ${c.lateChits > 0 ? "text-red-700" : "text-stone-500"}`}>
                      {c.lateChits}
                    </td>
                    <td className="text-sm text-right tabular-nums">{formatDuration(c.avgSec)}</td>
                    <td className="text-right">
                      <span className={`inline-block rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wide ${thresholdToneClass(status)}`}>
                        {status ?? "—"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-6 text-xs text-stone-500">
        Drill into station detail:{" "}
        <Link href="/app/admin/analytics/hospitality/prep-times/KITCHEN" className="text-club-green-700 hover:underline">
          Kitchen
        </Link>
        {" · "}
        <Link href="/app/admin/analytics/hospitality/prep-times/BAR" className="text-club-green-700 hover:underline">
          Bar
        </Link>
        {" · "}
        <Link href="/app/admin/analytics/hospitality/prep-times/DESSERT" className="text-club-green-700 hover:underline">
          Dessert
        </Link>
      </div>
    </div>
  );
}

// Choose a trend granularity that's manager-readable for the given
// window. <= 21 days → daily. <= 90 days → weekly. Else monthly.
function pickGranularity(r: { from: Date; to: Date }): "DAY" | "WEEK" | "MONTH" {
  const days = (r.to.getTime() - r.from.getTime()) / 86400000;
  if (days <= 21) return "DAY";
  if (days <= 90) return "WEEK";
  return "MONTH";
}

function granularityLabel(g: "DAY" | "WEEK" | "MONTH"): string {
  if (g === "DAY") return "daily";
  if (g === "WEEK") return "weekly";
  return "monthly";
}

function makeDelta(
  current: number | null,
  prior: number | null,
  kind: "duration" | "count",
  polarity: "lower-is-better" | "higher-is-better"
): { value: string; direction: "up" | "down" | "flat"; intent: "good" | "bad" | "neutral" } | null {
  if (current === null || prior === null) return null;
  const diff = current - prior;
  if (Math.abs(diff) < 1 && kind === "duration") {
    return { value: "no change", direction: "flat", intent: "neutral" };
  }
  const value = kind === "duration" ? formatDuration(Math.abs(diff)) : String(Math.abs(Math.round(diff)));
  const direction: "up" | "down" = diff > 0 ? "up" : "down";
  const isImprovement = polarity === "lower-is-better" ? diff < 0 : diff > 0;
  return { value, direction, intent: isImprovement ? "good" : "bad" };
}

// Load raw durations for the distribution histogram. This is one more
// read but it lets the Distribution component stay pure (just a list
// of numbers) without re-fetching chits in the client.
async function loadDurations(clubId: string, from: Date, to: Date): Promise<{ kitchen: number[]; bar: number[] }> {
  const chits = await prisma.pOSChit.findMany({
    where: {
      clubId,
      sentAt: { gte: from, lt: to },
      status: { in: ["QUEUED", "PRINTED", "ACKNOWLEDGED", "READY"] },
      firedAt: { not: null },
      readyAt: { not: null },
    },
    select: { station: true, firedAt: true, readyAt: true },
  });
  const kitchen: number[] = [];
  const bar: number[] = [];
  for (const c of chits) {
    const sec = prepTimeSeconds(c);
    if (sec === null) continue;
    if (c.station === "KITCHEN") kitchen.push(sec);
    else if (c.station === "BAR") bar.push(sec);
  }
  return { kitchen, bar };
}

async function loadStationTrend(
  principal: Awaited<ReturnType<typeof getCurrentPrincipal>>,
  clubId: string,
  range: { from: Date; to: Date },
  station: Station
) {
  if (!principal) return [];
  const trend = await getPrepTimeTrend(principal, clubId, {
    ...range,
    granularity: pickGranularity(range),
    station,
  });
  return trend.map((p) => ({
    label: p.bucket,
    bucketStart: p.bucketStart,
    valueSec: p.avgSec,
    totalChits: p.totalChits,
  }));
}
