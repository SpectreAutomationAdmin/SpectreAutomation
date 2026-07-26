// Step 33 — scripted floor-plan editor workflow test.
//
// Runs the entire draft → publish → live POS cycle against the
// real dev database, twice (Lounge + Patio), so the founder can
// verify in seconds without poking through Prisma Studio.
//
// Usage:
//   npm run floor-plan:test-workflow -- --club silver-springs
//
// The script is idempotent: it looks up or creates L99 / P99 test
// tables, publishes them, verifies they're live, then leaves them
// in the live state (the manual click-path test path expects to
// see them). Re-running cleans up old test rows first.

import { prisma } from "@/lib/prisma";
import { loadPrincipal } from "@/lib/rbac";
import {
  getOrCreateDraftForArea,
  getLivePlanForArea,
  addDraftTable,
  publishDraft,
  getDraftForArea,
} from "@/lib/hospitality/floor-plan";

function flagValue(name: string): string | null {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) return argv[i + 1] ?? null;
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return null;
}

function pass(line: string) {
  console.log(`PASS ${line}`);
}
function fail(line: string, detail?: string) {
  console.log(`FAIL ${line}${detail ? `: ${detail}` : ""}`);
}

async function exerciseArea(opts: {
  clubId: string;
  diningAreaId: string;
  areaLabel: string; // "Lounge" / "Patio"
  testTableNumber: string; // "L99" / "P99"
  principalId: string;
}): Promise<{ ok: boolean; testTableLiveId: string | null }> {
  const principal = await loadPrincipal(opts.principalId, opts.clubId);
  if (!principal) return { ok: false, testTableLiveId: null };

  let allOk = true;

  // Cleanup any prior run's test table so the script is idempotent.
  await prisma.diningTable.deleteMany({
    where: { clubId: opts.clubId, tableNumber: opts.testTableNumber },
  });

  // 1. Get-or-create draft.
  let plan;
  try {
    plan = await getOrCreateDraftForArea(principal, opts.clubId, opts.diningAreaId);
  } catch (err) {
    fail(`${opts.areaLabel} draft open`, (err as Error).message);
    return { ok: false, testTableLiveId: null };
  }

  // 2. Add the test table.
  try {
    await addDraftTable(principal, plan.id, {
      tableNumber: opts.testTableNumber,
      shape: "SQUARE",
      capacity: 4,
      xPos: 250, yPos: 250, width: 80, height: 80,
    });
  } catch (err) {
    fail(`${opts.areaLabel} add ${opts.testTableNumber}`, (err as Error).message);
    return { ok: false, testTableLiveId: null };
  }

  // 3. Draft isolation: the test table is in the draft but NOT in live.
  const liveBeforePublish = await prisma.diningTable.findFirst({
    where: { clubId: opts.clubId, tableNumber: opts.testTableNumber },
  });
  if (liveBeforePublish) {
    fail(`${opts.areaLabel} draft isolation`, `${opts.testTableNumber} is already in DiningTable before publish`);
    allOk = false;
  } else {
    pass(`${opts.areaLabel} draft isolation — ${opts.testTableNumber} hidden from live DiningTable until publish`);
  }

  // 4. Publish.
  try {
    await publishDraft(principal, plan.id);
  } catch (err) {
    fail(`${opts.areaLabel} publish`, (err as Error).message);
    return { ok: false, testTableLiveId: null };
  }

  // 5. Verify live now has it.
  const liveAfterPublish = await prisma.diningTable.findFirst({
    where: { clubId: opts.clubId, tableNumber: opts.testTableNumber, active: true },
  });
  if (!liveAfterPublish) {
    fail(`${opts.areaLabel} publish`, `${opts.testTableNumber} not in DiningTable after publish`);
    allOk = false;
    return { ok: false, testTableLiveId: null };
  }
  pass(`${opts.areaLabel} publish — ${opts.testTableNumber} now in live DiningTable`);

  // 6. Plan is LIVE.
  const livePlan = await getLivePlanForArea(principal, opts.clubId, opts.diningAreaId);
  if (livePlan?.id !== plan.id) {
    fail(`${opts.areaLabel} plan status`, `expected plan ${plan.id} to be LIVE, got ${livePlan?.id ?? "none"}`);
    allOk = false;
  } else {
    pass(`${opts.areaLabel} plan promoted — DiningFloorPlan ${plan.id} is now LIVE`);
  }

  // 7. After publish, no DRAFT remains for the area until next edit.
  const drafts = await getDraftForArea(principal, opts.clubId, opts.diningAreaId);
  if (drafts && drafts.status === "DRAFT") {
    fail(`${opts.areaLabel} draft cleanup`, "DRAFT plan unexpectedly remains after publish");
    allOk = false;
  } else {
    pass(`${opts.areaLabel} draft cleanup — no DRAFT lingers after publish`);
  }

  return { ok: allOk, testTableLiveId: liveAfterPublish.id };
}

async function main() {
  const clubSlug = flagValue("club");
  if (!clubSlug) {
    console.error("Missing --club <slug>. Example:");
    console.error("  npm run floor-plan:test-workflow -- --club silver-springs");
    process.exit(2);
  }

  const club =
    (await prisma.club.findFirst({ where: { slug: clubSlug } })) ??
    (await prisma.club.findFirst({ where: { slug: clubSlug.replace(/-/g, "_") } })) ??
    (await prisma.club.findFirst({ where: { name: { contains: clubSlug.replace(/-/g, " ") } } }));
  if (!club) {
    console.error(`No club matched "${clubSlug}".`);
    process.exit(1);
  }
  const adminRole = await prisma.userClubRole.findFirst({
    where: { clubId: club.id, roleKey: "CLUB_ADMIN", user: { status: "ACTIVE" } },
    include: { user: { select: { id: true, email: true } } },
  });
  if (!adminRole) {
    console.error(`No active CLUB_ADMIN at ${club.name} (${club.id}).`);
    process.exit(1);
  }

  // Look up Lounge + Patio by name. If either is missing the script
  // gives a clear PASS/SKIP and continues — keeps it resilient on
  // seeds that haven't created both areas.
  // Match by `contains` so the script picks up area names that vary
  // by club ("Lounge" vs "Clubhouse Lounge"); same for Patio.
  const lounge = await prisma.diningArea.findFirst({
    where: { clubId: club.id, name: { contains: "Lounge" } },
    orderBy: { sortOrder: "asc" },
  });
  const patio = await prisma.diningArea.findFirst({
    where: { clubId: club.id, name: { contains: "Patio" } },
    orderBy: { sortOrder: "asc" },
  });

  console.log(`\nFloor-plan workflow test — ${club.name} (${club.id})`);
  console.log(`Actor: ${adminRole.user.email}\n`);

  let allOk = true;
  let loungeLiveId: string | null = null;
  let patioLiveId: string | null = null;

  if (lounge) {
    const r = await exerciseArea({
      clubId: club.id, diningAreaId: lounge.id,
      areaLabel: "Lounge", testTableNumber: "L99",
      principalId: adminRole.userId,
    });
    if (!r.ok) allOk = false;
    loungeLiveId = r.testTableLiveId;
  } else {
    console.log("SKIP Lounge — no DiningArea named 'Lounge' found");
  }

  if (patio) {
    const r = await exerciseArea({
      clubId: club.id, diningAreaId: patio.id,
      areaLabel: "Patio", testTableNumber: "P99",
      principalId: adminRole.userId,
    });
    if (!r.ok) allOk = false;
    patioLiveId = r.testTableLiveId;
  } else {
    console.log("SKIP Patio — no DiningArea named 'Patio' found");
  }

  // 8. Area isolation: after both publishes, the Lounge live tables
  //    don't include P99 and the Patio live tables don't include L99.
  if (lounge && patio) {
    const loungeLive = await prisma.diningTable.findMany({
      where: { clubId: club.id, diningAreaId: lounge.id, active: true },
      select: { tableNumber: true },
    });
    const patioLive = await prisma.diningTable.findMany({
      where: { clubId: club.id, diningAreaId: patio.id, active: true },
      select: { tableNumber: true },
    });
    if (loungeLive.some((t) => t.tableNumber === "P99")) {
      fail("area isolation", "Lounge has P99 in its live tables");
      allOk = false;
    } else if (patioLive.some((t) => t.tableNumber === "L99")) {
      fail("area isolation", "Patio has L99 in its live tables");
      allOk = false;
    } else {
      pass("area isolation — Lounge and Patio published independently");
    }
  }

  console.log("");
  if (allOk) {
    console.log("All floor-plan workflow checks passed.");
  } else {
    console.log("One or more checks FAILED — see above.");
  }
  console.log("");
  if (loungeLiveId) console.log(`L99 live id: ${loungeLiveId}`);
  if (patioLiveId) console.log(`P99 live id: ${patioLiveId}`);
  console.log("Open /app/admin/hospitality/reservations/floor to see the published layouts.");
  console.log("");

  process.exit(allOk ? 0 : 1);
}

main()
  .catch((err) => {
    console.error("[floor-plan:test-workflow] failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
