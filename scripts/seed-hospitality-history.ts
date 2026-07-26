// Seed ~60 days of realistic lounge prep-time history so the
// hospitality analytics dashboard has something to show on first boot.
//
// Generates ~250 chits across kitchen + bar over the past 60 days,
// spanning lunch + dinner service, with most chits inside target,
// a tail of late chits, a sprinkling of cancellations, and weekend
// service slightly slower than weekday so the rule-based insights
// have material to surface.
//
// Idempotent: every chit gets a deterministic marker in
// `POSCheck.notes` so re-running the seed first deletes the previous
// history before creating fresh history. Other (live, hand-typed)
// checks are untouched.

import { prisma } from "@/lib/prisma";

const HISTORY_MARKER = "[hospitality-demo-history]";

// Tunables ------------------------------------------------------------
const DAYS_BACK = 60;
const TARGET_CHIT_COUNT = 260;

// Lunch + dinner service hours in local time.
const SERVICE_HOURS = [
  { start: 11, end: 14, weight: 0.45 },   // lunch
  { start: 18, end: 21, weight: 0.55 },   // dinner
];

// Prep-time distributions (seconds).
// Mean / stddev are tuned so kitchen averages ~9–10 min and bar ~3 min,
// with a long tail that yields ~12% late kitchen chits.
const KITCHEN_PREP = { mean: 9 * 60, stddev: 5 * 60, weekendMultiplier: 1.3 };
const BAR_PREP = { mean: 3 * 60, stddev: 90, weekendMultiplier: 1.1 };

// Cancellation rate per chit.
const CANCELLATION_RATE = 0.04;

// ---------------------------------------------------------------------
// Utility: cheap deterministic RNG so reruns produce the same shape
// without a vitest fixture leaking. We don't bother with crypto-grade
// random — this is demo data.
// ---------------------------------------------------------------------
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
// Box-Muller for a normal sample.
function gauss(rng: () => number, mean: number, stddev: number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  const r = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + r * stddev;
}
function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

export async function seedHospitalityHistory(opts: { clubId: string; verbose?: boolean }): Promise<{ chits: number; checks: number }> {
  const { clubId, verbose = false } = opts;
  const log = verbose ? (m: string) => console.log(`  ${m}`) : () => {};

  const lounge = await prisma.pOSLocation.findFirst({ where: { clubId, code: "FB-LOUNGE" } });
  if (!lounge) {
    log("No FB-LOUNGE location — skipping hospitality history seed.");
    return { chits: 0, checks: 0 };
  }
  const terminal = await prisma.pOSTerminal.findFirst({ where: { clubId, locationId: lounge.id } });

  // Need at least a few menu items per station to attach lines.
  const menuItems = await prisma.pOSMenuItem.findMany({
    where: { clubId, category: { locationId: lounge.id }, isActive: true },
    include: { category: { select: { name: true, chitDestination: true } } },
  });
  const kitchenItems = menuItems.filter((m) => m.category.chitDestination === "KITCHEN");
  const barItems = menuItems.filter((m) => m.category.chitDestination === "BAR");
  if (kitchenItems.length === 0 || barItems.length === 0) {
    log("Menu not seeded yet — skipping hospitality history.");
    return { chits: 0, checks: 0 };
  }

  // Active members at the club, for realistic check.memberId.
  const members = await prisma.member.findMany({
    where: { clubId, status: "ACTIVE" },
    select: { id: true },
    take: 12,
  });
  if (members.length === 0) {
    log("No active members — skipping hospitality history.");
    return { chits: 0, checks: 0 };
  }

  // The "server" user — any club admin or general manager will do.
  const server = await prisma.user.findFirst({
    where: { clubRoles: { some: { clubId, roleKey: { in: ["CLUB_ADMIN", "GENERAL_MANAGER", "FINANCE_ADMIN"] } } } },
  });

  // Idempotency: wipe any prior demo-history chits + checks before
  // creating new ones. Live checks (without the marker) are untouched.
  const priorChecks = await prisma.pOSCheck.findMany({
    where: { clubId, notes: { contains: HISTORY_MARKER } },
    select: { id: true },
  });
  if (priorChecks.length > 0) {
    const ids = priorChecks.map((c) => c.id);
    await prisma.pOSChitLine.deleteMany({ where: { chit: { checkId: { in: ids } } } });
    await prisma.pOSChit.deleteMany({ where: { checkId: { in: ids } } });
    await prisma.pOSCheckEvent.deleteMany({ where: { checkId: { in: ids } } });
    await prisma.pOSCheckLine.deleteMany({ where: { checkId: { in: ids } } });
    await prisma.pOSCheck.deleteMany({ where: { id: { in: ids } } });
    log(`Cleared ${priorChecks.length} prior demo-history checks before reseeding.`);
  }

  const rng = makeRng(clubId.split("").reduce((a, c) => a + c.charCodeAt(0), 0));
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let chitCount = 0;
  let checkCount = 0;
  const checkNumberPrefix = `HDH-${today.getFullYear()}-`;

  for (let daysAgo = 1; daysAgo <= DAYS_BACK && chitCount < TARGET_CHIT_COUNT; daysAgo++) {
    const dayDate = new Date(today);
    dayDate.setDate(dayDate.getDate() - daysAgo);
    const isWeekend = dayDate.getDay() === 0 || dayDate.getDay() === 6;
    // 3–6 checks per day, biased higher on weekends.
    const checksToday = 3 + Math.floor(rng() * 3) + (isWeekend ? 1 : 0);
    for (let i = 0; i < checksToday && chitCount < TARGET_CHIT_COUNT; i++) {
      const period = rng() < SERVICE_HOURS[0].weight ? SERVICE_HOURS[0] : SERVICE_HOURS[1];
      const hour = period.start + Math.floor(rng() * (period.end - period.start));
      const minute = Math.floor(rng() * 60);
      const sentAt = new Date(dayDate);
      sentAt.setHours(hour, minute, Math.floor(rng() * 60), 0);

      const member = pick(rng, members);
      const checkNumber = `${checkNumberPrefix}${String(checkCount + 1).padStart(6, "0")}`;
      const check = await prisma.pOSCheck.create({
        data: {
          clubId,
          locationId: lounge.id,
          terminalId: terminal?.id ?? null,
          memberId: member.id,
          checkNumber,
          status: "CLOSED",
          diningMode: "STAY",
          openedByUserId: server?.id ?? null,
          notes: HISTORY_MARKER,
          createdAt: sentAt,
          updatedAt: sentAt,
          settledAt: sentAt,
          settledByUserId: server?.id ?? null,
        },
      });
      checkCount++;

      // 1–2 kitchen chits, 0–1 bar chits per check.
      const kitchenChitCount = 1 + (rng() < 0.35 ? 1 : 0);
      const barChitCount = rng() < 0.65 ? 1 : 0;

      for (let kc = 0; kc < kitchenChitCount; kc++) {
        await createDemoChit({
          checkId: check.id,
          clubId,
          station: "KITCHEN",
          sentAt: addJitter(sentAt, rng, kc),
          rng,
          isWeekend,
          serverUserId: server?.id ?? null,
          items: kitchenItems,
        });
        chitCount++;
      }
      for (let bc = 0; bc < barChitCount; bc++) {
        await createDemoChit({
          checkId: check.id,
          clubId,
          station: "BAR",
          sentAt: addJitter(sentAt, rng, kitchenChitCount + bc),
          rng,
          isWeekend,
          serverUserId: server?.id ?? null,
          items: barItems,
        });
        chitCount++;
      }
    }
  }

  log(`Seeded ${checkCount} checks and ${chitCount} chits across ${DAYS_BACK} days.`);
  return { chits: chitCount, checks: checkCount };
}

function addJitter(base: Date, rng: () => number, offsetIdx: number): Date {
  // Multiple chits on the same check get slightly different sent times
  // so the order is realistic.
  const d = new Date(base);
  d.setSeconds(d.getSeconds() + offsetIdx * 5 + Math.floor(rng() * 4));
  return d;
}

async function createDemoChit(opts: {
  checkId: string;
  clubId: string;
  station: "KITCHEN" | "BAR";
  sentAt: Date;
  rng: () => number;
  isWeekend: boolean;
  serverUserId: string | null;
  items: Array<{ id: string; name: string; price: { toString(): string } }>;
}) {
  const { checkId, clubId, station, sentAt, rng, isWeekend, serverUserId, items } = opts;
  // Cancellation? Cancelled chits never reach READY.
  const cancelled = rng() < CANCELLATION_RATE;
  // Prep-time draw.
  const dist = station === "KITCHEN" ? KITCHEN_PREP : BAR_PREP;
  const mult = isWeekend ? dist.weekendMultiplier : 1;
  let prepSec = Math.max(20, Math.round(gauss(rng, dist.mean * mult, dist.stddev * mult)));
  // 8% chance of a longer outlier so the histogram tail is realistic.
  if (rng() < 0.08) prepSec = Math.round(prepSec * (1.4 + rng() * 0.8));

  // Firing happens immediately after Send for course-1 chits.
  const firedAt = new Date(sentAt.getTime() + 2_000 + Math.floor(rng() * 4_000));
  const acknowledgedAt = new Date(firedAt.getTime() + 30_000 + Math.floor(rng() * 60_000));
  const readyAt = cancelled ? null : new Date(firedAt.getTime() + prepSec * 1000);
  const cancelledAt = cancelled ? new Date(firedAt.getTime() + 60_000 + Math.floor(rng() * 120_000)) : null;

  // 1–3 items on this chit.
  const lineCount = 1 + Math.floor(rng() * 3);
  const pickedItems = Array.from({ length: lineCount }, () => pick(rng, items));

  // Underlying check-lines first (analytics joins through to category).
  const checkLineIds: string[] = [];
  for (const it of pickedItems) {
    const line = await prisma.pOSCheckLine.create({
      data: {
        clubId,
        checkId,
        menuItemId: it.id,
        description: it.name,
        quantity: 1,
        unitPrice: it.price.toString(),
        discountPct: 0,
        taxable: true,
        prepStation: station,
        course: 1,
        status: cancelled ? "VOIDED" : "SERVED",
        sentAt,
        readyAt: readyAt ?? undefined,
        servedAt: readyAt ?? undefined,
      },
    });
    checkLineIds.push(line.id);
  }

  const chit = await prisma.pOSChit.create({
    data: {
      clubId,
      checkId,
      station,
      status: cancelled ? "CANCELLED" : "READY",
      course: 1,
      sentByUserId: serverUserId,
      sentAt,
      firedAt,
      acknowledgedAt,
      acknowledgedByUserId: cancelled ? null : serverUserId,
      readyAt,
      readyByUserId: readyAt ? serverUserId : null,
      cancelledAt,
      cancelledByUserId: cancelled ? serverUserId : null,
      cancelledReason: cancelled ? "Demo data — cancelled chit" : null,
    },
  });
  for (let i = 0; i < pickedItems.length; i++) {
    await prisma.pOSChitLine.create({
      data: {
        clubId,
        chitId: chit.id,
        checkLineId: checkLineIds[i],
        displayDescription: pickedItems[i].name,
        displayQuantity: 1,
        displayNote: null,
      },
    });
  }
}

// Stand-alone runner — `npx tsx scripts/seed-hospitality-history.ts`
// against a single club for ad-hoc demos.
async function main() {
  const club = await prisma.club.findFirst({ orderBy: { createdAt: "asc" } });
  if (!club) {
    console.error("No club in DB — run `npm run db:reset` first.");
    process.exit(1);
  }
  console.log(`Seeding hospitality history for ${club.name} (${club.id})…`);
  const r = await seedHospitalityHistory({ clubId: club.id, verbose: true });
  console.log(`Done. ${r.checks} checks · ${r.chits} chits.`);
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
