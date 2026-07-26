// Hospitality prep-time analytics service.
//
// Computes manager-facing KPIs over POSChit timestamps captured by the
// open-check workflow. No snapshots, no aggregate tables — compute on
// demand. The dataset is bounded (chits per club per day) and the
// queries are indexed on `(clubId, station, status, sentAt)`.
//
// Mappings between the spec's vocabulary and the schema:
//   spec.createdAt   → POSChit.sentAt        (chit was created/sent)
//   spec.queuedAt    → POSChit.firedAt       (chit became active in kitchen view)
//   spec.printedAt   → POSChit.printedAt     (not currently populated — physical printer hook lands later)
//   spec.acknowledged→ POSChit.acknowledgedAt
//   spec.readyAt     → POSChit.readyAt
//   spec.cancelledAt → POSChit.cancelledAt
//
// Default prep-time KPI = readyAt − firedAt (queue-to-ready), per spec.
// Chits without both timestamps (HELD, CANCELLED, in-flight) are
// excluded from average/median/p90 KPIs but counted in the volume +
// cancelled buckets.
//
// Tenant safety: every public function requires a Principal and
// gates on `kpi:read` at the supplied clubId. All reads are scoped to
// that clubId via tenantWhere(). No analytics function writes — the
// module never posts, mutates balances, or settles checks.

import { prisma } from "../prisma";
import { requirePermission, type Principal } from "../rbac";

export type Station = "KITCHEN" | "BAR" | "DESSERT";
export type ServicePeriod = "BREAKFAST" | "LUNCH" | "AFTERNOON" | "DINNER";
export type ThresholdStatus = "GREEN" | "AMBER" | "RED";
export type Granularity = "DAY" | "WEEK" | "MONTH";

// ---------------------------------------------------------------------------
// Thresholds + service periods (defaults in code, configurable later).
// ---------------------------------------------------------------------------

// Seconds. Manager-facing targets. Kitchen is more forgiving; bar is
// expected to be quick. Dessert sits between.
export const STATION_THRESHOLDS: Record<Station, { greenMaxSec: number; amberMaxSec: number }> = {
  KITCHEN: { greenMaxSec: 12 * 60, amberMaxSec: 18 * 60 },
  BAR: { greenMaxSec: 5 * 60, amberMaxSec: 8 * 60 },
  DESSERT: { greenMaxSec: 8 * 60, amberMaxSec: 12 * 60 },
};

// Local-hour service periods. The hour is taken from the chit's firedAt
// in the server's local timezone — single-tenant clubs operate in one
// timezone, so this is correct in practice. A future iteration can move
// these to a per-club `ServicePeriodConfig` table.
export function classifyServicePeriod(d: Date): ServicePeriod {
  const h = d.getHours();
  if (h < 11) return "BREAKFAST";
  if (h < 15) return "LUNCH";
  if (h < 17) return "AFTERNOON";
  return "DINNER";
}

export function thresholdStatus(seconds: number, station: Station): ThresholdStatus {
  const t = STATION_THRESHOLDS[station];
  if (seconds <= t.greenMaxSec) return "GREEN";
  if (seconds <= t.amberMaxSec) return "AMBER";
  return "RED";
}

// ---------------------------------------------------------------------------
// Statistics helpers.
// ---------------------------------------------------------------------------

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  if (p <= 0) return values[0];
  if (p >= 100) return values[values.length - 1];
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank percentile — simple, deterministic, well-defined for
  // small samples. Avoids interpolation surprises in tests.
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function median(values: number[]): number {
  return percentile(values, 50);
}

// ---------------------------------------------------------------------------
// Chit shape used by the service. We only select the fields we need so
// the queries stay lean.
// ---------------------------------------------------------------------------
type ChitRow = {
  id: string;
  clubId: string;
  checkId: string;
  station: string;
  status: string;
  sentAt: Date;
  firedAt: Date | null;
  acknowledgedAt: Date | null;
  readyAt: Date | null;
  cancelledAt: Date | null;
};

function prepTimeSeconds(chit: { firedAt: Date | null; readyAt: Date | null }): number | null {
  if (!chit.firedAt || !chit.readyAt) return null;
  const diff = (chit.readyAt.getTime() - chit.firedAt.getTime()) / 1000;
  if (!Number.isFinite(diff) || diff < 0) return null;
  return diff;
}

// Exported for tests + reuse in drilldown views.
export { prepTimeSeconds };

// ---------------------------------------------------------------------------
// Core fetcher. Pulls chits in a date range, optionally filtered by
// station. Always tenant-scoped. The caller is responsible for the
// permission check.
// ---------------------------------------------------------------------------
async function fetchChits(
  clubId: string,
  opts: { from: Date; to: Date; station?: Station; includeCancelled?: boolean }
): Promise<ChitRow[]> {
  // We range on `sentAt` rather than `firedAt` because every chit has
  // sentAt and the index `(clubId, station, status, sentAt)` is on it.
  // We filter HELD chits out by status — they haven't queued yet.
  const statuses = opts.includeCancelled
    ? ["QUEUED", "PRINTED", "ACKNOWLEDGED", "READY", "CANCELLED"]
    : ["QUEUED", "PRINTED", "ACKNOWLEDGED", "READY"];
  return prisma.pOSChit.findMany({
    where: {
      clubId,
      sentAt: { gte: opts.from, lt: opts.to },
      status: { in: statuses },
      ...(opts.station ? { station: opts.station } : {}),
    },
    select: {
      id: true,
      clubId: true,
      checkId: true,
      station: true,
      status: true,
      sentAt: true,
      firedAt: true,
      acknowledgedAt: true,
      readyAt: true,
      cancelledAt: true,
    },
    orderBy: { sentAt: "asc" },
  });
}

// ---------------------------------------------------------------------------
// 1. Prep-time stats — KPIs for a date range and (optional) station.
// ---------------------------------------------------------------------------

export type StationStats = {
  station: Station;
  // Volume counts
  totalChits: number;       // QUEUED through READY (excluding cancelled)
  completedChits: number;   // status = READY with both timestamps
  cancelledChits: number;
  lateChits: number;        // ready but exceeded amberMaxSec
  // Duration KPIs in seconds (null when no completed chits)
  avgSec: number | null;
  medianSec: number | null;
  p90Sec: number | null;
  // Threshold status of the average
  status: ThresholdStatus | null;
};

export type PrepTimeStats = {
  range: { from: Date; to: Date };
  kitchen: StationStats;
  bar: StationStats;
  dessert: StationStats;
  // Cross-station roll-ups
  busiestPeriod: ServicePeriod | null;
  fastestPeriod: ServicePeriod | null;
  slowestPeriod: ServicePeriod | null;
};

function emptyStats(station: Station): StationStats {
  return {
    station,
    totalChits: 0,
    completedChits: 0,
    cancelledChits: 0,
    lateChits: 0,
    avgSec: null,
    medianSec: null,
    p90Sec: null,
    status: null,
  };
}

function computeStationStats(station: Station, chits: ChitRow[]): StationStats {
  const filtered = chits.filter((c) => c.station === station);
  const cancelled = filtered.filter((c) => c.status === "CANCELLED");
  const noncancelled = filtered.filter((c) => c.status !== "CANCELLED");

  const durations: number[] = [];
  let lateChits = 0;
  for (const c of noncancelled) {
    const sec = prepTimeSeconds(c);
    if (sec === null) continue;
    durations.push(sec);
    if (thresholdStatus(sec, station) === "RED") lateChits++;
  }

  const avgSec = durations.length > 0 ? mean(durations) : null;
  const medianSec = durations.length > 0 ? median(durations) : null;
  const p90Sec = durations.length > 0 ? percentile(durations, 90) : null;
  const status = avgSec === null ? null : thresholdStatus(avgSec, station);

  return {
    station,
    totalChits: noncancelled.length,
    completedChits: durations.length,
    cancelledChits: cancelled.length,
    lateChits,
    avgSec,
    medianSec,
    p90Sec,
    status,
  };
}

function pickPeriodExtremes(chits: ChitRow[]): { busiest: ServicePeriod | null; fastest: ServicePeriod | null; slowest: ServicePeriod | null } {
  const buckets = new Map<ServicePeriod, { count: number; durations: number[] }>();
  for (const c of chits) {
    if (c.status === "CANCELLED" || !c.firedAt) continue;
    const period = classifyServicePeriod(c.firedAt);
    const bucket = buckets.get(period) ?? { count: 0, durations: [] };
    bucket.count++;
    const sec = prepTimeSeconds(c);
    if (sec !== null) bucket.durations.push(sec);
    buckets.set(period, bucket);
  }
  if (buckets.size === 0) {
    return { busiest: null, fastest: null, slowest: null };
  }
  let busiest: ServicePeriod | null = null;
  let busiestCount = -1;
  let fastest: ServicePeriod | null = null;
  let fastestAvg = Infinity;
  let slowest: ServicePeriod | null = null;
  let slowestAvg = -Infinity;
  for (const [period, b] of buckets.entries()) {
    if (b.count > busiestCount) {
      busiestCount = b.count;
      busiest = period;
    }
    if (b.durations.length > 0) {
      const avg = mean(b.durations);
      if (avg < fastestAvg) {
        fastestAvg = avg;
        fastest = period;
      }
      if (avg > slowestAvg) {
        slowestAvg = avg;
        slowest = period;
      }
    }
  }
  return { busiest, fastest, slowest };
}

export async function getPrepTimeStats(
  principal: Principal,
  clubId: string,
  opts: { from: Date; to: Date; station?: Station }
): Promise<PrepTimeStats> {
  requirePermission(principal, clubId, "kpi:read");
  // We need to assert tenancy here too — Principal.activeClubId might
  // not match the requested clubId for SUPER_ADMIN. tenantWhere is for
  // queries; for a guard we just check membership directly.
  // (kpi:read on a club implies cross-tenant access for super-admin
  // is allowed; otherwise the call must be at a club the user holds
  // a role at.)
  if (!isSuperAdmin(principal) && !principal.memberships.some((m) => m.clubId === clubId)) {
    throw new Error(`Forbidden: principal has no access to club ${clubId}`);
  }
  const chits = await fetchChits(clubId, { ...opts, includeCancelled: true });

  const stationFilter = opts.station;
  const kitchen = stationFilter && stationFilter !== "KITCHEN" ? emptyStats("KITCHEN") : computeStationStats("KITCHEN", chits);
  const bar = stationFilter && stationFilter !== "BAR" ? emptyStats("BAR") : computeStationStats("BAR", chits);
  const dessert = stationFilter && stationFilter !== "DESSERT" ? emptyStats("DESSERT") : computeStationStats("DESSERT", chits);

  const periods = pickPeriodExtremes(chits);

  return {
    range: { from: opts.from, to: opts.to },
    kitchen,
    bar,
    dessert,
    busiestPeriod: periods.busiest,
    fastestPeriod: periods.fastest,
    slowestPeriod: periods.slowest,
  };
}

// ---------------------------------------------------------------------------
// 2. Trend — bucketed average prep time over time.
// ---------------------------------------------------------------------------

export type TrendPoint = {
  // Bucket label (e.g. "2026-05-19" for DAY, "2026-W21" for WEEK,
  // "2026-05" for MONTH).
  bucket: string;
  // Inclusive bucket start (for charting positions).
  bucketStart: Date;
  avgSec: number | null;
  medianSec: number | null;
  totalChits: number;
  lateChits: number;
};

function bucketKey(d: Date, granularity: Granularity): { key: string; start: Date } {
  if (granularity === "DAY") {
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const key = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
    return { key, start };
  }
  if (granularity === "WEEK") {
    // Week starts Monday. ISO-ish week labels (YYYY-Www).
    const start = startOfIsoWeek(d);
    const key = `${start.getFullYear()}-W${pad(isoWeekNumber(start))}`;
    return { key, start };
  }
  // MONTH
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const key = `${start.getFullYear()}-${pad(start.getMonth() + 1)}`;
  return { key, start };
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function startOfIsoWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = x.getDay(); // 0=Sun..6=Sat
  const diff = (day + 6) % 7; // back to Monday
  x.setDate(x.getDate() - diff);
  return x;
}

function isoWeekNumber(d: Date): number {
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayNr = (target.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const diff = (target.getTime() - firstThursday.getTime()) / 86400000;
  return 1 + Math.round((diff - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);
}

export async function getPrepTimeTrend(
  principal: Principal,
  clubId: string,
  opts: { from: Date; to: Date; granularity: Granularity; station?: Station }
): Promise<TrendPoint[]> {
  requirePermission(principal, clubId, "kpi:read");
  const chits = await fetchChits(clubId, { ...opts, includeCancelled: false });

  type Acc = { bucketStart: Date; durations: number[]; total: number; late: number };
  const buckets = new Map<string, Acc>();
  const station = opts.station;
  for (const c of chits) {
    if (station && c.station !== station) continue;
    if (!c.firedAt) continue;
    const { key, start } = bucketKey(c.firedAt, opts.granularity);
    const acc = buckets.get(key) ?? { bucketStart: start, durations: [], total: 0, late: 0 };
    acc.total++;
    const sec = prepTimeSeconds(c);
    if (sec !== null) {
      acc.durations.push(sec);
      if (thresholdStatus(sec, c.station as Station) === "RED") acc.late++;
    }
    buckets.set(key, acc);
  }
  // Sort by bucketStart asc.
  const out: TrendPoint[] = Array.from(buckets.entries()).map(([key, acc]) => ({
    bucket: key,
    bucketStart: acc.bucketStart,
    avgSec: acc.durations.length > 0 ? mean(acc.durations) : null,
    medianSec: acc.durations.length > 0 ? median(acc.durations) : null,
    totalChits: acc.total,
    lateChits: acc.late,
  }));
  out.sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime());
  return out;
}

// ---------------------------------------------------------------------------
// 3. Service-period × day-of-week matrix.
// ---------------------------------------------------------------------------

export type ServicePeriodCell = {
  period: ServicePeriod;
  dayOfWeek: number; // 0=Sun..6=Sat
  count: number;
  avgSec: number | null;
  status: ThresholdStatus | null;
};

export async function getServicePeriodMatrix(
  principal: Principal,
  clubId: string,
  opts: { from: Date; to: Date; station?: Station }
): Promise<ServicePeriodCell[]> {
  requirePermission(principal, clubId, "kpi:read");
  const chits = await fetchChits(clubId, { ...opts, includeCancelled: false });
  const station = opts.station;
  const buckets = new Map<string, { period: ServicePeriod; dow: number; durations: number[]; count: number }>();
  for (const c of chits) {
    if (station && c.station !== station) continue;
    if (!c.firedAt) continue;
    const period = classifyServicePeriod(c.firedAt);
    const dow = c.firedAt.getDay();
    const key = `${period}::${dow}`;
    const acc = buckets.get(key) ?? { period, dow, durations: [], count: 0 };
    acc.count++;
    const sec = prepTimeSeconds(c);
    if (sec !== null) acc.durations.push(sec);
    buckets.set(key, acc);
  }
  // Average station weighting — use kitchen threshold for heatmap when
  // we don't have a specific station (matches the headline KPI).
  const tStation: Station = station ?? "KITCHEN";
  return Array.from(buckets.values()).map((b) => ({
    period: b.period,
    dayOfWeek: b.dow,
    count: b.count,
    avgSec: b.durations.length > 0 ? mean(b.durations) : null,
    status: b.durations.length > 0 ? thresholdStatus(mean(b.durations), tStation) : null,
  }));
}

// ---------------------------------------------------------------------------
// 4. Category breakdown — slowest menu categories.
// ---------------------------------------------------------------------------

export type CategoryStat = {
  categoryName: string;
  totalChits: number;       // chits that contained ≥1 line from this category
  lateChits: number;
  avgSec: number | null;
};

export async function getCategoryBreakdown(
  principal: Principal,
  clubId: string,
  opts: { from: Date; to: Date; station?: Station }
): Promise<CategoryStat[]> {
  requirePermission(principal, clubId, "kpi:read");
  // Join chit → chitLines → checkLine → menuItem → category.
  // A chit can contain multiple lines spanning categories; we attribute
  // the chit's prep time to each category it touched.
  const rows = await prisma.pOSChit.findMany({
    where: {
      clubId,
      sentAt: { gte: opts.from, lt: opts.to },
      status: { in: ["QUEUED", "PRINTED", "ACKNOWLEDGED", "READY"] },
      ...(opts.station ? { station: opts.station } : {}),
      readyAt: { not: null },
      firedAt: { not: null },
    },
    select: {
      id: true,
      station: true,
      firedAt: true,
      readyAt: true,
      lines: {
        select: {
          checkLine: {
            select: {
              menuItem: { select: { category: { select: { name: true } } } },
            },
          },
        },
      },
    },
  });

  const buckets = new Map<string, { durations: number[]; count: number; late: number }>();
  for (const chit of rows) {
    const sec = prepTimeSeconds(chit);
    if (sec === null) continue;
    const isLate = thresholdStatus(sec, chit.station as Station) === "RED";
    // Touched categories — dedupe per chit so a chit with 3 lines all
    // in "Mains" only counts as 1 mains chit.
    const cats = new Set<string>();
    for (const l of chit.lines) {
      const name = l.checkLine?.menuItem?.category?.name;
      if (name) cats.add(name);
    }
    if (cats.size === 0) cats.add("Uncategorised");
    for (const cat of cats) {
      const acc = buckets.get(cat) ?? { durations: [], count: 0, late: 0 };
      acc.count++;
      acc.durations.push(sec);
      if (isLate) acc.late++;
      buckets.set(cat, acc);
    }
  }
  return Array.from(buckets.entries())
    .map(([categoryName, b]) => ({
      categoryName,
      totalChits: b.count,
      lateChits: b.late,
      avgSec: b.durations.length > 0 ? mean(b.durations) : null,
    }))
    .sort((a, b) => (b.avgSec ?? 0) - (a.avgSec ?? 0));
}

// ---------------------------------------------------------------------------
// 5. Drilldown — paginated chit table with filters.
// ---------------------------------------------------------------------------

export type DrilldownChit = {
  chitId: string;
  checkId: string;
  checkNumber: string;
  station: Station;
  status: string;
  course: number;
  sentAt: Date;
  firedAt: Date | null;
  readyAt: Date | null;
  prepSeconds: number | null;
  prepStatus: ThresholdStatus | null;
  servicePeriod: ServicePeriod | null;
  serverName: string | null;
  memberName: string | null;
  tableNumber: string | null;
  itemSummary: string;       // "2× Burger, 1× Stella"
  isLate: boolean;
  isCancelled: boolean;
};

export async function getDrilldownChits(
  principal: Principal,
  clubId: string,
  opts: {
    from: Date;
    to: Date;
    station?: Station;
    servicePeriod?: ServicePeriod;
    lateOnly?: boolean;
    cancelledOnly?: boolean;
    limit?: number;
    cursor?: string;
  }
): Promise<{ rows: DrilldownChit[]; nextCursor: string | null }> {
  requirePermission(principal, clubId, "kpi:read");
  const limit = Math.min(opts.limit ?? 100, 500);
  const rows = await prisma.pOSChit.findMany({
    where: {
      clubId,
      sentAt: { gte: opts.from, lt: opts.to },
      status: opts.cancelledOnly
        ? "CANCELLED"
        : { in: ["QUEUED", "PRINTED", "ACKNOWLEDGED", "READY", "CANCELLED"] },
      ...(opts.station ? { station: opts.station } : {}),
      ...(opts.cursor ? { sentAt: { lt: new Date(opts.cursor) } } : {}),
    },
    select: {
      id: true,
      checkId: true,
      station: true,
      status: true,
      course: true,
      sentAt: true,
      firedAt: true,
      readyAt: true,
      cancelledAt: true,
      check: {
        select: {
          checkNumber: true,
          tableNumber: true,
          openedByUserId: true,
          member: { select: { firstName: true, lastName: true, memberNumber: true } },
        },
      },
      lines: {
        select: { displayDescription: true, displayQuantity: true },
      },
    },
    orderBy: { sentAt: "desc" },
    take: limit + 1,
  });

  // Resolve server names in a single batch.
  const serverIds = Array.from(
    new Set(rows.map((r) => r.check.openedByUserId).filter((id): id is string => !!id))
  );
  const servers = serverIds.length
    ? await prisma.user.findMany({
        where: { id: { in: serverIds } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const serverById = new Map(servers.map((s) => [s.id, s.name || s.email || null]));

  const sliced = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? rows[limit - 1].sentAt.toISOString() : null;

  let filtered = sliced;
  if (opts.servicePeriod) {
    filtered = filtered.filter(
      (r) => r.firedAt && classifyServicePeriod(r.firedAt) === opts.servicePeriod
    );
  }
  if (opts.lateOnly) {
    filtered = filtered.filter((r) => {
      const sec = prepTimeSeconds(r);
      if (sec === null) return false;
      return thresholdStatus(sec, r.station as Station) === "RED";
    });
  }

  const out: DrilldownChit[] = filtered.map((r) => {
    const prep = prepTimeSeconds(r);
    const station = r.station as Station;
    const isCancelled = r.status === "CANCELLED";
    const isLate = prep !== null && thresholdStatus(prep, station) === "RED";
    return {
      chitId: r.id,
      checkId: r.checkId,
      checkNumber: r.check.checkNumber,
      station,
      status: r.status,
      course: r.course,
      sentAt: r.sentAt,
      firedAt: r.firedAt,
      readyAt: r.readyAt,
      prepSeconds: prep,
      prepStatus: prep === null ? null : thresholdStatus(prep, station),
      servicePeriod: r.firedAt ? classifyServicePeriod(r.firedAt) : null,
      serverName: r.check.openedByUserId ? serverById.get(r.check.openedByUserId) ?? null : null,
      memberName: r.check.member ? `${r.check.member.firstName} ${r.check.member.lastName}` : null,
      tableNumber: r.check.tableNumber,
      itemSummary: r.lines
        .map((l) => `${Number(l.displayQuantity.toString())}× ${l.displayDescription}`)
        .join(", "),
      isLate,
      isCancelled,
    };
  });

  return { rows: out, nextCursor };
}

// ---------------------------------------------------------------------------
// 6. Comparison — current vs prior period.
// ---------------------------------------------------------------------------

export type Comparison = {
  current: PrepTimeStats;
  prior: PrepTimeStats;
  delta: {
    kitchenAvgSec: number | null;
    barAvgSec: number | null;
    kitchenLateCount: number;
    barLateCount: number;
  };
  // Plain-language summary lines suitable for a header card.
  narrative: string[];
};

export async function comparePrepTime(
  principal: Principal,
  clubId: string,
  current: { from: Date; to: Date },
  prior: { from: Date; to: Date },
  station?: Station
): Promise<Comparison> {
  const [c, p] = await Promise.all([
    getPrepTimeStats(principal, clubId, { ...current, station }),
    getPrepTimeStats(principal, clubId, { ...prior, station }),
  ]);
  const delta = {
    kitchenAvgSec:
      c.kitchen.avgSec !== null && p.kitchen.avgSec !== null
        ? c.kitchen.avgSec - p.kitchen.avgSec
        : null,
    barAvgSec:
      c.bar.avgSec !== null && p.bar.avgSec !== null
        ? c.bar.avgSec - p.bar.avgSec
        : null,
    kitchenLateCount: c.kitchen.lateChits - p.kitchen.lateChits,
    barLateCount: c.bar.lateChits - p.bar.lateChits,
  };
  const narrative: string[] = [];
  if (c.kitchen.avgSec !== null && p.kitchen.avgSec !== null) {
    const diffMin = (c.kitchen.avgSec - p.kitchen.avgSec) / 60;
    const direction = diffMin >= 0 ? "up" : "down";
    narrative.push(
      `Kitchen averaged ${formatDuration(c.kitchen.avgSec)} this period, ${direction} ${formatDuration(Math.abs(diffMin * 60))} from the prior period.`
    );
  }
  if (c.bar.avgSec !== null && p.bar.avgSec !== null) {
    const diffMin = (c.bar.avgSec - p.bar.avgSec) / 60;
    const direction = diffMin >= 0 ? "up" : "down";
    narrative.push(
      `Bar averaged ${formatDuration(c.bar.avgSec)} this period, ${direction} ${formatDuration(Math.abs(diffMin * 60))} from the prior period.`
    );
  }
  return { current: c, prior: p, delta, narrative };
}

// ---------------------------------------------------------------------------
// 7. Manager insights — deterministic rules over the analytics data.
// ---------------------------------------------------------------------------

export type Insight = {
  id: string;             // stable, hashable id (rule + slice)
  severity: "INFO" | "WATCH" | "ALERT";
  station?: Station;
  message: string;
};

export async function generateInsights(
  principal: Principal,
  clubId: string,
  opts: { from: Date; to: Date }
): Promise<Insight[]> {
  requirePermission(principal, clubId, "kpi:read");
  const chits = await fetchChits(clubId, { from: opts.from, to: opts.to, includeCancelled: true });
  const insights: Insight[] = [];

  // Rule 1 — late-chit rate over threshold.
  for (const station of ["KITCHEN", "BAR"] as const) {
    const stats = computeStationStats(station, chits);
    if (stats.completedChits < 5) continue;
    const lateRate = stats.lateChits / stats.completedChits;
    if (lateRate >= 0.25) {
      insights.push({
        id: `late-rate-${station.toLowerCase()}`,
        severity: lateRate >= 0.4 ? "ALERT" : "WATCH",
        station,
        message: `${stationName(station)} exceeded target on ${pct(lateRate)} of chits this period.`,
      });
    }
  }

  // Rule 2 — slowest service period.
  const periods = pickPeriodExtremes(chits);
  if (periods.slowest && periods.fastest && periods.slowest !== periods.fastest) {
    insights.push({
      id: "slowest-period",
      severity: "INFO",
      message: `${periodName(periods.slowest)} is the slowest service period; ${periodName(periods.fastest)} is the fastest.`,
    });
  }

  // Rule 3 — weekend slower than weekday (per station).
  for (const station of ["KITCHEN", "BAR"] as const) {
    const weekday: number[] = [];
    const weekend: number[] = [];
    for (const c of chits) {
      if (c.status === "CANCELLED" || c.station !== station) continue;
      const sec = prepTimeSeconds(c);
      if (sec === null || !c.firedAt) continue;
      const dow = c.firedAt.getDay();
      (dow === 0 || dow === 6 ? weekend : weekday).push(sec);
    }
    if (weekend.length < 5 || weekday.length < 5) continue;
    const wAvg = mean(weekend);
    const dAvg = mean(weekday);
    if (dAvg === 0) continue;
    const pctSlower = (wAvg - dAvg) / dAvg;
    if (pctSlower >= 0.15) {
      insights.push({
        id: `weekend-slow-${station.toLowerCase()}`,
        severity: "WATCH",
        station,
        message: `${stationName(station)} averaged ${pct(pctSlower)} slower on weekends than weekdays.`,
      });
    }
  }

  // Rule 4 — high cancellation volume.
  const cancelled = chits.filter((c) => c.status === "CANCELLED").length;
  const active = chits.filter((c) => c.status !== "CANCELLED").length;
  if (active >= 20 && cancelled / (cancelled + active) >= 0.1) {
    insights.push({
      id: "high-cancellations",
      severity: "WATCH",
      message: `${cancelled} chits were cancelled (${pct(cancelled / (cancelled + active))} of total) — worth reviewing.`,
    });
  }

  return insights;
}

// ---------------------------------------------------------------------------
// Formatting + naming helpers (exported for UI reuse).
// ---------------------------------------------------------------------------

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r === 0 ? `${m}m` : `${m}m ${r}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function stationName(s: Station): string {
  if (s === "KITCHEN") return "Kitchen";
  if (s === "BAR") return "Bar";
  return "Dessert";
}

export function periodName(p: ServicePeriod): string {
  if (p === "BREAKFAST") return "Breakfast";
  if (p === "LUNCH") return "Lunch";
  if (p === "AFTERNOON") return "Afternoon";
  return "Dinner";
}

export function thresholdToneClass(t: ThresholdStatus | null): string {
  if (t === "GREEN") return "text-club-green-700 bg-club-green-50 border-club-green-200";
  if (t === "AMBER") return "text-amber-800 bg-amber-50 border-amber-200";
  if (t === "RED") return "text-red-700 bg-red-50 border-red-200";
  return "text-stone-500 bg-stone-50 border-stone-200";
}

function isSuperAdmin(p: Principal): boolean {
  return p.memberships.some((m) => m.clubId === null && m.roleKey === "SUPER_ADMIN");
}
