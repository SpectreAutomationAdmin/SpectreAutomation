// Hospitality prep-time analytics tests.
//
// Covers calculation correctness (avg / median / p90, cancellation
// exclusion, threshold colour, service-period classification),
// comparison + trend bucketing, drilldown filtering and tenant
// isolation, and rule-based insight generation.
//
// All fixtures build a complete tenant + lounge + menu via the same
// helper used by pos-checks.test.ts so the test data flows through
// the real schema (no shortcuts that skip joins).

import { describe, it, expect, beforeEach } from "vitest";
import { db, makeUser, makeMember, resetDb, principalFor } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import {
  classifyServicePeriod,
  comparePrepTime,
  formatDuration,
  generateInsights,
  getCategoryBreakdown,
  getDrilldownChits,
  getPrepTimeStats,
  getPrepTimeTrend,
  percentile,
  prepTimeSeconds,
  STATION_THRESHOLDS,
  thresholdStatus,
} from "@/lib/analytics/hospitality";
import { resolveRange } from "@/lib/analytics/ranges";
import { LOUNGE_LOCATION_CODE, LOUNGE_TERMINAL_CODE } from "@/lib/pos/lounge";

// ---------------------------------------------------------------------------
// Fixture — a club with the lounge + a minimal menu + a single member.
// ---------------------------------------------------------------------------
async function bootstrapLoungeForAnalytics(name = "Analytics Test Club") {
  const club = await bootstrapAPClub(name);
  const location = await db().pOSLocation.create({
    data: { clubId: club.id, code: LOUNGE_LOCATION_CODE, name: "Lounge" },
  });
  await db().pOSTerminal.create({
    data: { clubId: club.id, code: LOUNGE_TERMINAL_CODE, name: "Terminal", locationId: location.id },
  });
  const mainsCat = await db().pOSMenuCategory.create({
    data: { clubId: club.id, locationId: location.id, name: "Mains", sortOrder: 1, isActive: true, chitDestination: "KITCHEN" },
  });
  const beerCat = await db().pOSMenuCategory.create({
    data: { clubId: club.id, locationId: location.id, name: "Beer", sortOrder: 2, isActive: true, chitDestination: "BAR" },
  });
  const burger = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: mainsCat.id, name: "Burger", price: 20, taxable: true, isActive: true },
  });
  const beer = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: beerCat.id, name: "Lager", price: 8, taxable: true, isActive: true },
  });
  return { club, location, mainsCat, beerCat, items: { burger, beer } };
}

async function clubAdmin(clubId: string, suffix = "") {
  const email = `analytics-admin${suffix}-${clubId}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

type ChitInput = {
  station: "KITCHEN" | "BAR";
  sentAt: Date;
  firedAt: Date | null;
  readyAt: Date | null;
  cancelled?: boolean;
  menuItemId?: string;
  checkMember?: string | null;
  serverUserId?: string | null;
};

// Insert a check + chit pair directly so we control every timestamp.
async function makeChit(
  clubId: string,
  locationId: string,
  opts: ChitInput & { checkNumberHint: number; itemDescription: string }
) {
  const check = await db().pOSCheck.create({
    data: {
      clubId,
      locationId,
      checkNumber: `T-${opts.checkNumberHint.toString().padStart(6, "0")}`,
      status: opts.cancelled ? "VOIDED" : "CLOSED",
      memberId: opts.checkMember ?? null,
      diningMode: "STAY",
      openedByUserId: opts.serverUserId ?? null,
    },
  });
  let checkLineId: string | undefined;
  if (opts.menuItemId) {
    const cl = await db().pOSCheckLine.create({
      data: {
        clubId,
        checkId: check.id,
        menuItemId: opts.menuItemId,
        description: opts.itemDescription,
        quantity: 1,
        unitPrice: 10,
        taxable: true,
        prepStation: opts.station,
        course: 1,
        status: opts.cancelled ? "VOIDED" : "SERVED",
        sentAt: opts.sentAt,
        readyAt: opts.readyAt ?? undefined,
        servedAt: opts.readyAt ?? undefined,
      },
    });
    checkLineId = cl.id;
  }
  const chit = await db().pOSChit.create({
    data: {
      clubId,
      checkId: check.id,
      station: opts.station,
      status: opts.cancelled ? "CANCELLED" : "READY",
      course: 1,
      sentAt: opts.sentAt,
      firedAt: opts.firedAt,
      readyAt: opts.readyAt,
      cancelledAt: opts.cancelled ? new Date(opts.sentAt.getTime() + 60_000) : null,
    },
  });
  if (checkLineId) {
    await db().pOSChitLine.create({
      data: {
        clubId,
        chitId: chit.id,
        checkLineId,
        displayDescription: opts.itemDescription,
        displayQuantity: 1,
      },
    });
  }
  return { check, chit };
}

beforeEach(async () => {
  await resetDb();
});

// ===========================================================================
// 1 — Prep-time duration calculation
// ===========================================================================
describe("prep-time math", () => {
  it("1: prepTimeSeconds returns readyAt − firedAt in seconds", () => {
    const fired = new Date("2026-05-19T12:00:00Z");
    const ready = new Date("2026-05-19T12:07:30Z");
    expect(prepTimeSeconds({ firedAt: fired, readyAt: ready })).toBe(450);
  });

  it("returns null when either timestamp is missing or readyAt is before firedAt", () => {
    expect(prepTimeSeconds({ firedAt: null, readyAt: new Date() })).toBeNull();
    expect(prepTimeSeconds({ firedAt: new Date(), readyAt: null })).toBeNull();
    const t = new Date();
    expect(prepTimeSeconds({ firedAt: t, readyAt: new Date(t.getTime() - 1000) })).toBeNull();
  });
});

// ===========================================================================
// 11/12 — Median + p90
// ===========================================================================
describe("statistical helpers", () => {
  it("11: median is the 50th percentile (nearest-rank)", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([10], 50)).toBe(10);
    expect(percentile([], 50)).toBe(0);
  });

  it("12: 90th percentile picks the high-end value (nearest-rank)", () => {
    // Nearest-rank p90 of N=10: rank = ceil(0.9 × 10) = 9, index 8.
    const values = [60, 90, 120, 180, 240, 300, 360, 420, 480, 540];
    expect(percentile(values, 90)).toBe(480);
    // Larger sample — p90 of 1..100 is 90.
    const big = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(big, 90)).toBe(90);
  });
});

// ===========================================================================
// 9 — Threshold green/amber/red
// ===========================================================================
describe("threshold classification", () => {
  it("9: kitchen thresholds — green ≤12m, amber ≤18m, red >18m", () => {
    expect(thresholdStatus(11 * 60, "KITCHEN")).toBe("GREEN");
    expect(thresholdStatus(12 * 60, "KITCHEN")).toBe("GREEN");
    expect(thresholdStatus(13 * 60, "KITCHEN")).toBe("AMBER");
    expect(thresholdStatus(18 * 60, "KITCHEN")).toBe("AMBER");
    expect(thresholdStatus(18 * 60 + 1, "KITCHEN")).toBe("RED");
  });
  it("bar thresholds — green ≤5m, amber ≤8m, red >8m", () => {
    expect(thresholdStatus(5 * 60, "BAR")).toBe("GREEN");
    expect(thresholdStatus(7 * 60, "BAR")).toBe("AMBER");
    expect(thresholdStatus(9 * 60, "BAR")).toBe("RED");
  });
});

// ===========================================================================
// 10 — Service period classification
// ===========================================================================
describe("service-period classification", () => {
  it("10: classifies by local hour", () => {
    expect(classifyServicePeriod(new Date(2026, 4, 19, 9, 0))).toBe("BREAKFAST");
    expect(classifyServicePeriod(new Date(2026, 4, 19, 12, 30))).toBe("LUNCH");
    expect(classifyServicePeriod(new Date(2026, 4, 19, 15, 30))).toBe("AFTERNOON");
    expect(classifyServicePeriod(new Date(2026, 4, 19, 18, 0))).toBe("DINNER");
  });
});

// ===========================================================================
// 2/3 — KPI stats incl. cancellation exclusion + station filtering
// ===========================================================================
describe("getPrepTimeStats", () => {
  it("2/3: cancelled chits are excluded from averages but counted separately; kitchen/bar are computed independently", async () => {
    const { club, location, items } = await bootstrapLoungeForAnalytics();
    const principal = await clubAdmin(club.id);
    const day = new Date();
    day.setHours(12, 0, 0, 0);

    // Three kitchen chits: 8m, 10m, 14m  → avg 32m/3 ≈ 10m40s
    // Plus one cancelled kitchen chit — must not pollute the average.
    const kitchenTimings = [8, 10, 14] as const;
    for (let i = 0; i < kitchenTimings.length; i++) {
      const sent = new Date(day);
      sent.setMinutes(sent.getMinutes() + i * 10);
      await makeChit(club.id, location.id, {
        station: "KITCHEN",
        sentAt: sent,
        firedAt: sent,
        readyAt: new Date(sent.getTime() + kitchenTimings[i] * 60_000),
        menuItemId: items.burger.id,
        itemDescription: "Burger",
        checkNumberHint: 100 + i,
      });
    }
    const cancelledSent = new Date(day);
    cancelledSent.setMinutes(cancelledSent.getMinutes() + 100);
    await makeChit(club.id, location.id, {
      station: "KITCHEN",
      sentAt: cancelledSent,
      firedAt: cancelledSent,
      readyAt: null,
      cancelled: true,
      menuItemId: items.burger.id,
      itemDescription: "Burger",
      checkNumberHint: 199,
    });
    // Two bar chits: 3m, 4m → avg 3m30s
    for (let i = 0; i < 2; i++) {
      const sent = new Date(day);
      sent.setMinutes(sent.getMinutes() + 5 + i * 7);
      await makeChit(club.id, location.id, {
        station: "BAR",
        sentAt: sent,
        firedAt: sent,
        readyAt: new Date(sent.getTime() + (3 + i) * 60_000),
        menuItemId: items.beer.id,
        itemDescription: "Lager",
        checkNumberHint: 300 + i,
      });
    }

    const stats = await getPrepTimeStats(principal, club.id, {
      from: new Date(day.getFullYear(), day.getMonth(), day.getDate()),
      to: new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1),
    });
    // Kitchen
    expect(stats.kitchen.totalChits).toBe(3);            // cancelled excluded
    expect(stats.kitchen.cancelledChits).toBe(1);
    expect(stats.kitchen.avgSec).toBeCloseTo((8 + 10 + 14) * 60 / 3, 1);
    expect(stats.kitchen.medianSec).toBe(10 * 60);
    expect(stats.kitchen.p90Sec).toBe(14 * 60);          // nearest-rank picks the top sample
    // Bar
    expect(stats.bar.totalChits).toBe(2);
    expect(stats.bar.avgSec).toBeCloseTo(3.5 * 60, 1);
  });

  it("station filter: KITCHEN-only returns empty bar stats", async () => {
    const { club, location, items } = await bootstrapLoungeForAnalytics();
    const principal = await clubAdmin(club.id);
    const day = new Date();
    day.setHours(13, 0, 0, 0);
    await makeChit(club.id, location.id, {
      station: "KITCHEN",
      sentAt: day,
      firedAt: day,
      readyAt: new Date(day.getTime() + 8 * 60_000),
      menuItemId: items.burger.id,
      itemDescription: "Burger",
      checkNumberHint: 1,
    });
    await makeChit(club.id, location.id, {
      station: "BAR",
      sentAt: day,
      firedAt: day,
      readyAt: new Date(day.getTime() + 4 * 60_000),
      menuItemId: items.beer.id,
      itemDescription: "Lager",
      checkNumberHint: 2,
    });
    const stats = await getPrepTimeStats(principal, club.id, {
      from: new Date(day.getFullYear(), day.getMonth(), day.getDate()),
      to: new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1),
      station: "KITCHEN",
    });
    expect(stats.kitchen.totalChits).toBe(1);
    expect(stats.bar.totalChits).toBe(0);
  });
});

// ===========================================================================
// 8 — Late-chit classification (avg above red threshold)
// ===========================================================================
describe("late chits", () => {
  it("8: chits exceeding red threshold count as late", async () => {
    const { club, location, items } = await bootstrapLoungeForAnalytics();
    const principal = await clubAdmin(club.id);
    const day = new Date();
    day.setHours(12, 0, 0, 0);
    // 22-minute kitchen prep — over the RED line (18m).
    const sent = new Date(day);
    await makeChit(club.id, location.id, {
      station: "KITCHEN",
      sentAt: sent,
      firedAt: sent,
      readyAt: new Date(sent.getTime() + 22 * 60_000),
      menuItemId: items.burger.id,
      itemDescription: "Burger",
      checkNumberHint: 1,
    });
    const stats = await getPrepTimeStats(principal, club.id, {
      from: new Date(day.getFullYear(), day.getMonth(), day.getDate()),
      to: new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1),
    });
    expect(stats.kitchen.lateChits).toBe(1);
    expect(stats.kitchen.status).toBe("RED");
  });
});

// ===========================================================================
// 4/5/6/7 — Trend + comparison + YoY
// ===========================================================================
describe("trends and comparisons", () => {
  it("4: daily bucketing groups chits by their fired date", async () => {
    const { club, location, items } = await bootstrapLoungeForAnalytics();
    const principal = await clubAdmin(club.id);
    const today = new Date();
    today.setHours(13, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    // Two on yesterday (10m, 12m), one on today (16m).
    for (const [dt, prep] of [
      [yesterday, 10],
      [yesterday, 12],
      [today, 16],
    ] as const) {
      await makeChit(club.id, location.id, {
        station: "KITCHEN",
        sentAt: dt,
        firedAt: dt,
        readyAt: new Date(dt.getTime() + prep * 60_000),
        menuItemId: items.burger.id,
        itemDescription: "Burger",
        checkNumberHint: prep,
      });
    }
    const trend = await getPrepTimeTrend(principal, club.id, {
      from: new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate()),
      to: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1),
      granularity: "DAY",
    });
    expect(trend).toHaveLength(2);
    expect(trend[0].avgSec).toBeCloseTo(11 * 60, 1);
    expect(trend[1].avgSec).toBeCloseTo(16 * 60, 1);
  });

  it("5/6/7: comparison computes delta and narrative between current and prior windows", async () => {
    const { club, location, items } = await bootstrapLoungeForAnalytics();
    const principal = await clubAdmin(club.id);
    const today = new Date();
    today.setHours(13, 0, 0, 0);
    const sevenAgo = new Date(today);
    sevenAgo.setDate(sevenAgo.getDate() - 7);
    // Current window: 14m kitchen
    await makeChit(club.id, location.id, {
      station: "KITCHEN",
      sentAt: today,
      firedAt: today,
      readyAt: new Date(today.getTime() + 14 * 60_000),
      menuItemId: items.burger.id,
      itemDescription: "Burger",
      checkNumberHint: 1,
    });
    // Prior window: 10m kitchen
    await makeChit(club.id, location.id, {
      station: "KITCHEN",
      sentAt: sevenAgo,
      firedAt: sevenAgo,
      readyAt: new Date(sevenAgo.getTime() + 10 * 60_000),
      menuItemId: items.burger.id,
      itemDescription: "Burger",
      checkNumberHint: 2,
    });
    const comp = await comparePrepTime(
      principal,
      club.id,
      { from: new Date(today.getFullYear(), today.getMonth(), today.getDate()), to: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1) },
      { from: new Date(sevenAgo.getFullYear(), sevenAgo.getMonth(), sevenAgo.getDate()), to: new Date(sevenAgo.getFullYear(), sevenAgo.getMonth(), sevenAgo.getDate() + 1) },
    );
    expect(comp.delta.kitchenAvgSec).toBeCloseTo(4 * 60, 1);
    expect(comp.narrative.join(" ")).toMatch(/Kitchen averaged/);
  });
});

// ===========================================================================
// 13/14 — Drilldown tenant safety + cross-tenant blocked
// ===========================================================================
describe("drilldown tenant safety", () => {
  it("13/14: drilldown only returns chits for the requested club, even when querying via a super-admin-ish principal", async () => {
    const { club: clubA, location: locA, items: itemsA } = await bootstrapLoungeForAnalytics("Club A");
    const { club: clubB, location: locB, items: itemsB } = await bootstrapLoungeForAnalytics("Club B");
    const adminA = await clubAdmin(clubA.id, "A");

    const day = new Date();
    day.setHours(13, 0, 0, 0);
    await makeChit(clubA.id, locA.id, {
      station: "KITCHEN", sentAt: day, firedAt: day,
      readyAt: new Date(day.getTime() + 10 * 60_000),
      menuItemId: itemsA.burger.id, itemDescription: "A-Burger",
      checkNumberHint: 1,
    });
    await makeChit(clubB.id, locB.id, {
      station: "KITCHEN", sentAt: day, firedAt: day,
      readyAt: new Date(day.getTime() + 14 * 60_000),
      menuItemId: itemsB.burger.id, itemDescription: "B-Burger",
      checkNumberHint: 1,
    });
    const drill = await getDrilldownChits(adminA, clubA.id, {
      from: new Date(day.getFullYear(), day.getMonth(), day.getDate()),
      to: new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1),
    });
    expect(drill.rows.every((r) => r.checkNumber.startsWith("T-"))).toBe(true);
    expect(drill.rows.some((r) => r.itemSummary.includes("A-Burger"))).toBe(true);
    expect(drill.rows.some((r) => r.itemSummary.includes("B-Burger"))).toBe(false);

    // Cross-tenant: club-A admin calling club-B's analytics throws.
    await expect(getPrepTimeStats(adminA, clubB.id, {
      from: new Date(day.getFullYear(), day.getMonth(), day.getDate()),
      to: new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1),
    })).rejects.toThrow();
  });
});

// ===========================================================================
// 16 — Empty state
// ===========================================================================
describe("empty state", () => {
  it("16: empty range returns null KPIs without throwing", async () => {
    const { club } = await bootstrapLoungeForAnalytics();
    const principal = await clubAdmin(club.id);
    const day = new Date();
    const stats = await getPrepTimeStats(principal, club.id, {
      from: new Date(day.getFullYear(), day.getMonth(), day.getDate()),
      to: new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1),
    });
    expect(stats.kitchen.avgSec).toBeNull();
    expect(stats.kitchen.totalChits).toBe(0);
    expect(stats.bar.totalChits).toBe(0);
    expect(stats.busiestPeriod).toBeNull();
  });
});

// ===========================================================================
// 15 — Manager insights generated deterministically
// ===========================================================================
describe("manager insights", () => {
  it("15: high late-rate triggers a WATCH/ALERT insight", async () => {
    const { club, location, items } = await bootstrapLoungeForAnalytics();
    const principal = await clubAdmin(club.id);
    const day = new Date();
    day.setHours(12, 0, 0, 0);
    // 6 chits, 5 of which exceed the red threshold → 83% late.
    for (let i = 0; i < 6; i++) {
      const sent = new Date(day);
      sent.setMinutes(sent.getMinutes() + i * 5);
      await makeChit(club.id, location.id, {
        station: "KITCHEN",
        sentAt: sent,
        firedAt: sent,
        readyAt: new Date(sent.getTime() + (i === 0 ? 9 : 25) * 60_000),
        menuItemId: items.burger.id,
        itemDescription: "Burger",
        checkNumberHint: 500 + i,
      });
    }
    const insights = await generateInsights(principal, club.id, {
      from: new Date(day.getFullYear(), day.getMonth(), day.getDate()),
      to: new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1),
    });
    const lateInsight = insights.find((i) => i.id === "late-rate-kitchen");
    expect(lateInsight).toBeDefined();
    expect(lateInsight?.severity).toBe("ALERT");
  });
});

// ===========================================================================
// 17 — Range presets produce expected windows
// ===========================================================================
describe("range presets", () => {
  it("17: THIS_WEEK gives Monday-start week and prior is the week before", () => {
    const now = new Date(2026, 4, 21, 10, 0); // Thursday May 21, 2026
    const r = resolveRange("THIS_WEEK", now);
    // Monday of that week is May 18, 2026.
    expect(r.current.from.getDay()).toBe(1);
    expect(r.current.from.getDate()).toBe(18);
    expect(r.current.to.getDate()).toBe(25);
    expect(r.prior.from.getDate()).toBe(11);
    expect(r.prior.to.getDate()).toBe(18);
  });
});

// ===========================================================================
// Formatting
// ===========================================================================
describe("formatting", () => {
  it("formatDuration renders seconds, minutes, m+s, and hours", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(180)).toBe("3m");
    expect(formatDuration(195)).toBe("3m 15s");
    expect(formatDuration(3660)).toBe("1h 1m");
  });
});

// ===========================================================================
// Category breakdown sanity
// ===========================================================================
describe("category breakdown", () => {
  it("attributes chit prep time to its menu item's category", async () => {
    const { club, location, items, mainsCat } = await bootstrapLoungeForAnalytics();
    const principal = await clubAdmin(club.id);
    const day = new Date();
    day.setHours(13, 0, 0, 0);
    await makeChit(club.id, location.id, {
      station: "KITCHEN",
      sentAt: day,
      firedAt: day,
      readyAt: new Date(day.getTime() + 11 * 60_000),
      menuItemId: items.burger.id,
      itemDescription: "Burger",
      checkNumberHint: 1,
    });
    const cats = await getCategoryBreakdown(principal, club.id, {
      from: new Date(day.getFullYear(), day.getMonth(), day.getDate()),
      to: new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1),
    });
    const mains = cats.find((c) => c.categoryName === mainsCat.name);
    expect(mains?.totalChits).toBe(1);
    expect(mains?.avgSec).toBeCloseTo(11 * 60, 1);
  });
});

// ===========================================================================
// Threshold thresholds export — sanity-check the seed defaults
// ===========================================================================
describe("default thresholds", () => {
  it("kitchen and bar thresholds match the spec defaults", () => {
    expect(STATION_THRESHOLDS.KITCHEN.greenMaxSec).toBe(12 * 60);
    expect(STATION_THRESHOLDS.KITCHEN.amberMaxSec).toBe(18 * 60);
    expect(STATION_THRESHOLDS.BAR.greenMaxSec).toBe(5 * 60);
    expect(STATION_THRESHOLDS.BAR.amberMaxSec).toBe(8 * 60);
  });
});
