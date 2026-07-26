// Dining reservation analytics.
//
// Direct queries against DiningReservation + linked POSSale grand
// totals + HospitalitySurveyResponse ratings. No snapshot table; the
// dataset is small enough per club that a few aggregate-on-read calls
// stay fast.
//
// Every function is tenant-scoped and read-permission-gated. The
// queries deliberately exclude REQUESTED / CANCELLED reservations
// from "cover" tallies — covers only count visits that actually
// happened.

import { prisma } from "../prisma";
import { requirePermission, type Principal } from "../rbac";
import { tenantWhere } from "../services/tenant";

// ---------------------------------------------------------------------------
// Operational KPIs (admin dashboard).
// ---------------------------------------------------------------------------

export type OperationalFilter = {
  from: Date;
  to: Date;
  diningAreaId?: string;
  reservationType?: "MEMBER" | "WALK_IN" | "GUEST";
};

export type OperationalKpis = {
  range: { from: Date; to: Date };
  totalReservations: number;
  totalWalkIns: number;
  totalCovers: number;            // sum of partySize for COMPLETED+SEATED visits
  completedVisits: number;
  noShows: number;
  cancellations: number;
  noShowRate: number;             // noShows / (confirmedOrSeated + noShows) — between 0 and 1
  cancellationRate: number;
  avgTableDurationMinutes: number | null;
  avgSpendPerCover: number | null;
  totalSpend: number;
  avgRating: number | null;
  ratingsBelow5: number;
  peakHour: number | null;         // 0–23
  peakHourCount: number;
};

function pct(num: number, denom: number): number {
  return denom > 0 ? num / denom : 0;
}

export async function getOperationalKpis(
  principal: Principal,
  clubId: string,
  filter: OperationalFilter,
): Promise<OperationalKpis> {
  requirePermission(principal, clubId, "reservations:read");
  const baseWhere = {
    ...tenantWhere(principal, clubId),
    startTime: { gte: filter.from, lt: filter.to },
    ...(filter.diningAreaId ? { diningAreaId: filter.diningAreaId } : {}),
    ...(filter.reservationType ? { reservationType: filter.reservationType } : {}),
  };

  const reservations = await prisma.diningReservation.findMany({
    where: baseWhere,
    include: {
      checkLinks: {
        include: { posSale: { select: { grandTotal: true } } },
      },
    },
  });

  let completedVisits = 0;
  let totalCovers = 0;
  let totalWalkIns = 0;
  let totalReservations = 0;
  let noShows = 0;
  let cancellations = 0;
  let totalDuration = 0;
  let durationCount = 0;
  let totalSpend = 0;
  let spendCovers = 0; // covers attached to a settled sale
  const hourBuckets = new Array(24).fill(0);
  const reservationIds: string[] = [];

  for (const r of reservations) {
    if (r.reservationType === "WALK_IN") totalWalkIns += 1;
    else totalReservations += 1;
    if (r.status === "NO_SHOW") noShows += 1;
    if (r.status === "CANCELLED") cancellations += 1;
    if (r.status === "COMPLETED" || r.status === "SEATED") {
      completedVisits += 1;
      totalCovers += r.partySize;
      hourBuckets[new Date(r.startTime).getUTCHours()] += 1;
      reservationIds.push(r.id);

      if (r.actualSeatedAt && r.actualDepartedAt) {
        totalDuration += (r.actualDepartedAt.getTime() - r.actualSeatedAt.getTime()) / 60_000;
        durationCount += 1;
      }
      for (const link of r.checkLinks) {
        if (link.posSale?.grandTotal) {
          totalSpend += Number(link.posSale.grandTotal.toString());
          spendCovers += r.partySize;
        }
      }
    }
  }

  // Ratings linked to the same reservations via the receipt-flow check link.
  const ratingsAgg = await prisma.hospitalitySurveyResponse.aggregate({
    where: {
      clubId,
      submittedAt: { gte: filter.from, lt: filter.to },
    },
    _avg: { rating: true },
    _count: { _all: true },
  });
  const belowFiveCount = await prisma.hospitalitySurveyResponse.count({
    where: {
      clubId,
      submittedAt: { gte: filter.from, lt: filter.to },
      rating: { lt: 5 },
    },
  });

  // Peak hour over the window — the bucket with the most starts.
  let peakHour: number | null = null;
  let peakHourCount = 0;
  for (let h = 0; h < 24; h++) {
    if (hourBuckets[h] > peakHourCount) {
      peakHour = h;
      peakHourCount = hourBuckets[h];
    }
  }

  // Honest no-show rate: of every reservation that actually moved past
  // REQUESTED, what share were ultimately marked no-show.
  const confirmedOrLater = reservations.filter(
    (r) => r.status === "CONFIRMED" || r.status === "SEATED" || r.status === "COMPLETED" || r.status === "NO_SHOW",
  ).length;
  return {
    range: { from: filter.from, to: filter.to },
    totalReservations,
    totalWalkIns,
    totalCovers,
    completedVisits,
    noShows,
    cancellations,
    noShowRate: pct(noShows, confirmedOrLater),
    cancellationRate: pct(cancellations, totalReservations + totalWalkIns + cancellations),
    avgTableDurationMinutes: durationCount > 0 ? totalDuration / durationCount : null,
    avgSpendPerCover: spendCovers > 0 ? totalSpend / spendCovers : null,
    totalSpend,
    avgRating: ratingsAgg._count._all > 0 ? Number(ratingsAgg._avg.rating ?? 0) : null,
    ratingsBelow5: belowFiveCount,
    peakHour,
    peakHourCount,
  };
}

// ---------------------------------------------------------------------------
// Comparison helper — same-window-prior. Returns { current, prior }.
// ---------------------------------------------------------------------------
export async function getOperationalKpisVsPrior(
  principal: Principal,
  clubId: string,
  filter: OperationalFilter,
): Promise<{ current: OperationalKpis; prior: OperationalKpis }> {
  const windowMs = filter.to.getTime() - filter.from.getTime();
  const priorTo = filter.from;
  const priorFrom = new Date(filter.from.getTime() - windowMs);
  const [current, prior] = await Promise.all([
    getOperationalKpis(principal, clubId, filter),
    getOperationalKpis(principal, clubId, { ...filter, from: priorFrom, to: priorTo }),
  ]);
  return { current, prior };
}

// ---------------------------------------------------------------------------
// Member dining summary — for member-profile tab and member hub.
// ---------------------------------------------------------------------------

export type MemberDiningSummary = {
  visitsYtd: number;
  totalSpendYtd: number;
  avgSpendPerVisit: number | null;
  avgRating: number | null;
  ratingCount: number;
  lastVisit: Date | null;
  noShows: number;
  cancellations: number;
  avgPartySize: number | null;
  upcomingReservationCount: number;
};

export async function getMemberDiningSummary(memberId: string): Promise<MemberDiningSummary> {
  const yearStart = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));

  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { id: true, clubId: true },
  });
  if (!member) {
    return {
      visitsYtd: 0, totalSpendYtd: 0, avgSpendPerVisit: null,
      avgRating: null, ratingCount: 0, lastVisit: null,
      noShows: 0, cancellations: 0, avgPartySize: null,
      upcomingReservationCount: 0,
    };
  }

  const ytd = await prisma.diningReservation.findMany({
    where: {
      memberId,
      startTime: { gte: yearStart },
    },
    include: {
      checkLinks: { include: { posSale: { select: { grandTotal: true } } } },
    },
  });

  let visits = 0;
  let totalSpend = 0;
  let partyTotal = 0;
  let lastVisit: Date | null = null;
  let noShows = 0;
  let cancellations = 0;
  for (const r of ytd) {
    if (r.status === "COMPLETED") {
      visits += 1;
      partyTotal += r.partySize;
      if (!lastVisit || r.startTime > lastVisit) lastVisit = r.startTime;
      for (const link of r.checkLinks) {
        if (link.posSale?.grandTotal) totalSpend += Number(link.posSale.grandTotal.toString());
      }
    } else if (r.status === "NO_SHOW") {
      noShows += 1;
    } else if (r.status === "CANCELLED") {
      cancellations += 1;
    }
  }

  // Ratings tied to a reservation via its receipt check — but those
  // are easier to surface as the member's overall lounge ratings.
  const ratingAgg = await prisma.hospitalitySurveyResponse.aggregate({
    where: { memberId, submittedAt: { gte: yearStart } },
    _avg: { rating: true },
    _count: { _all: true },
  });

  const upcoming = await prisma.diningReservation.count({
    where: {
      memberId,
      status: { in: ["REQUESTED", "CONFIRMED", "SEATED"] },
      startTime: { gte: new Date() },
    },
  });

  return {
    visitsYtd: visits,
    totalSpendYtd: totalSpend,
    avgSpendPerVisit: visits > 0 ? totalSpend / visits : null,
    avgRating: ratingAgg._count._all > 0 ? Number(ratingAgg._avg.rating ?? 0) : null,
    ratingCount: ratingAgg._count._all,
    lastVisit,
    noShows,
    cancellations,
    avgPartySize: visits > 0 ? partyTotal / visits : null,
    upcomingReservationCount: upcoming,
  };
}

// ---------------------------------------------------------------------------
// Table-utilization-right-now (host floor view).
// ---------------------------------------------------------------------------
export async function getFloorSnapshot(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "reservations:read");
  const areas = await prisma.diningArea.findMany({
    where: { ...tenantWhere(principal, clubId), active: true },
    orderBy: { sortOrder: "asc" },
    include: {
      tables: {
        where: { active: true },
        orderBy: { tableNumber: "asc" },
        include: {
          reservations: {
            where: { status: { in: ["SEATED", "CONFIRMED"] } },
            orderBy: { startTime: "asc" },
            include: {
              member: { select: { firstName: true, lastName: true } },
              checkLinks: { include: { posSale: { select: { grandTotal: true } }, posCheck: { select: { id: true, checkNumber: true } } } },
            },
          },
        },
      },
    },
  });
  return areas;
}
