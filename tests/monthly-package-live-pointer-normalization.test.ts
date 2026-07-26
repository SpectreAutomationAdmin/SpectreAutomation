// Live Pointer normalization — founder spec 2026-06-29.
//
// Rule under test (verbatim from the founder):
//   "For each club, the live/published Monthly Reporting Package must
//    always be the latest reporting period that exists and has been
//    published/generated for Board use. A prior month can never
//    remain Published if a later month exists."
//
// The canonical enforcer is `normalizeLivePointer(clubId)`. It is
// triggered after every write that could change which row is the
// greatest:
//   • publishMonthlyPackage
//   • generateDraftMonthlyPackage
//   • sendMonthlyPackage
//   • resendMonthlyPackage (in monthly-package-archive)
//   • listArchivedMonthlyPackages (defensive cleanup)
//
// These tests cover the founder's explicit acceptance criteria from
// the 2026-06-29 message:
//
//   1. With May + June present, June Published + May Archived.
//   2. With May...September present, September Published + all
//      prior months Archived.
//   3. Republishing May after June exists keeps May Archived.
//   4. Board tile points to June when June is the latest.
//   5. Board tile points to September when September is the latest.
//   6. Archive statuses match chronological order (latest = Published,
//      rest = Archived).
//   7. No duplicate package rows are created.
//   8. Defensive normalization on archive load fixes drifted state
//      (the founder's reported 2026-06-29 state: June Archived,
//       May Published).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";

import {
  generateDraftMonthlyPackage,
  getMostRecentBoardPackageForUser,
  normalizeLivePointer,
  publishMonthlyPackage,
} from "@/lib/reporting/monthly-package-lifecycle";
import { listArchivedMonthlyPackages } from "@/lib/reporting/monthly-package-archive";

import { db, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";

async function admin(clubId: string) {
  const email = `admin-${Math.random().toString(36).slice(2, 10)}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}
async function boardUser(clubId: string) {
  const email = `board-${Math.random().toString(36).slice(2, 10)}@example.com`;
  await makeUser({ email, role: "BOARD_READ_ONLY", clubId });
  return principalFor(email);
}

async function statusOf(clubId: string, year: number, month: number) {
  const row = await db().monthlyPackage.findUnique({
    where: {
      clubId_reportingYear_reportingMonth: {
        clubId,
        reportingYear: year,
        reportingMonth: month,
      },
    },
    select: { status: true },
  });
  return row?.status ?? null;
}

async function publishPeriod(
  caller: Awaited<ReturnType<typeof admin>>,
  clubId: string,
  year: number,
  month: number,
) {
  const { package: draft } = await generateDraftMonthlyPackage(caller, clubId, {
    reportingYear: year,
    reportingMonth: month,
  });
  return publishMonthlyPackage(caller, draft.id);
}

describe("Live Pointer normalization — founder acceptance scenarios", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("Case 1: with May + June present, June shows Published and May shows Archived", async () => {
    const club = await bootstrapAPClub("LP-NORM-1");
    const a = await admin(club.id);
    await publishPeriod(a, club.id, 2026, 5);
    await publishPeriod(a, club.id, 2026, 6);
    expect(await statusOf(club.id, 2026, 5)).toBe("ARCHIVED");
    expect(await statusOf(club.id, 2026, 6)).toBe("PUBLISHED");
  });

  it("Case 2: with May...September present, September is Published and all earlier months are Archived", async () => {
    const club = await bootstrapAPClub("LP-NORM-2");
    const a = await admin(club.id);
    // Publish in non-monotonic order to confirm normalization
    // doesn't just "track last published" — it picks the greatest.
    await publishPeriod(a, club.id, 2026, 5);
    await publishPeriod(a, club.id, 2026, 9);
    await publishPeriod(a, club.id, 2026, 7);
    await publishPeriod(a, club.id, 2026, 6);
    await publishPeriod(a, club.id, 2026, 8);
    for (const m of [5, 6, 7, 8]) {
      expect(await statusOf(club.id, 2026, m)).toBe("ARCHIVED");
    }
    expect(await statusOf(club.id, 2026, 9)).toBe("PUBLISHED");
  });

  it("Case 3: republishing May after June exists keeps May Archived", async () => {
    const club = await bootstrapAPClub("LP-NORM-3");
    const a = await admin(club.id);
    const may = await publishPeriod(a, club.id, 2026, 5);
    await publishPeriod(a, club.id, 2026, 6);
    // May is now Archived. Republish May.
    const correction = await publishMonthlyPackage(a, may.publishedPackageId);
    expect(correction.transition).toBe("OVERWRITE_HISTORICAL");
    expect(correction.resultingStatus).toBe("ARCHIVED");
    expect(await statusOf(club.id, 2026, 5)).toBe("ARCHIVED");
    expect(await statusOf(club.id, 2026, 6)).toBe("PUBLISHED");
  });

  it("Case 4: Board dashboard tile points to June when June is the latest", async () => {
    const club = await bootstrapAPClub("LP-NORM-4");
    const a = await admin(club.id);
    const board = await boardUser(club.id);
    await publishPeriod(a, club.id, 2026, 5);
    await publishPeriod(a, club.id, 2026, 6);
    const tile = await getMostRecentBoardPackageForUser(board, club.id);
    expect(tile).not.toBeNull();
    expect(tile!.reportingMonth).toBe(6);
  });

  it("Case 5: Board dashboard tile points to September when September is the latest (in a 5-month archive)", async () => {
    const club = await bootstrapAPClub("LP-NORM-5");
    const a = await admin(club.id);
    const board = await boardUser(club.id);
    for (const m of [5, 6, 7, 8, 9]) {
      await publishPeriod(a, club.id, 2026, m);
    }
    const tile = await getMostRecentBoardPackageForUser(board, club.id);
    expect(tile).not.toBeNull();
    expect(tile!.reportingMonth).toBe(9);
  });

  it("Case 6: archive statuses match chronological order (latest = Published, all earlier = Archived)", async () => {
    const club = await bootstrapAPClub("LP-NORM-6");
    const a = await admin(club.id);
    for (const m of [4, 5, 6, 7, 8]) {
      await publishPeriod(a, club.id, 2026, m);
    }
    const rows = await listArchivedMonthlyPackages(a, club.id);
    // listArchivedMonthlyPackages returns periodEndDate-desc rows.
    expect(rows.map((r) => `${r.reportingMonth}:${r.status}`)).toEqual([
      "8:PUBLISHED",
      "7:ARCHIVED",
      "6:ARCHIVED",
      "5:ARCHIVED",
      "4:ARCHIVED",
    ]);
  });

  it("Case 7: no duplicate package rows are created (1 row per period)", async () => {
    const club = await bootstrapAPClub("LP-NORM-7");
    const a = await admin(club.id);
    // Publish each period multiple times in random order.
    await publishPeriod(a, club.id, 2026, 5);
    await publishPeriod(a, club.id, 2026, 5);
    await publishPeriod(a, club.id, 2026, 6);
    await publishPeriod(a, club.id, 2026, 5);
    await publishPeriod(a, club.id, 2026, 6);
    const total = await db().monthlyPackage.count({ where: { clubId: club.id } });
    expect(total).toBe(2); // exactly one per period
  });
});

describe("Live Pointer normalization — defensive cleanup", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("self-heals the founder's reported state (June Archived, May Published) on archive load", async () => {
    const club = await bootstrapAPClub("LP-NORM-HEAL");
    const a = await admin(club.id);
    // Set up: May Published, June Archived. Force the broken state
    // directly via Prisma (simulating data drift from an earlier bug).
    await publishPeriod(a, club.id, 2026, 5); // May → Published
    const { package: jun } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 6,
    });
    await db().monthlyPackage.update({
      where: { id: jun.id },
      data: { status: "ARCHIVED", atAGlanceKpisJson: "[]" },
    });
    // Pre-cleanup: confirm the broken state exists.
    expect(await statusOf(club.id, 2026, 5)).toBe("PUBLISHED");
    expect(await statusOf(club.id, 2026, 6)).toBe("ARCHIVED");

    // Loading the archive list MUST self-heal.
    await listArchivedMonthlyPackages(a, club.id);

    // Post-cleanup: greatest-period-wins enforced.
    expect(await statusOf(club.id, 2026, 5)).toBe("ARCHIVED");
    expect(await statusOf(club.id, 2026, 6)).toBe("PUBLISHED");
  });

  it("normalizeLivePointer is idempotent (running twice doesn't change anything)", async () => {
    const club = await bootstrapAPClub("LP-NORM-IDEM");
    const a = await admin(club.id);
    await publishPeriod(a, club.id, 2026, 5);
    await publishPeriod(a, club.id, 2026, 6);
    const r1 = await normalizeLivePointer(club.id);
    const r2 = await normalizeLivePointer(club.id);
    expect(r1.liveId).toBe(r2.liveId);
    expect(r1.promotedId).toBeNull();
    expect(r1.demotedIds).toEqual([]);
    expect(r2.promotedId).toBeNull();
    expect(r2.demotedIds).toEqual([]);
  });

  it("normalizeLivePointer no-ops on a club with zero non-DRAFT rows", async () => {
    const club = await bootstrapAPClub("LP-NORM-EMPTY");
    const a = await admin(club.id);
    await generateDraftMonthlyPackage(a, club.id, { reportingYear: 2026, reportingMonth: 5 });
    const r = await normalizeLivePointer(club.id);
    expect(r.liveId).toBeNull();
    expect(r.promotedId).toBeNull();
    expect(r.demotedIds).toEqual([]);
  });

  it("normalizeLivePointer promotes a lone ARCHIVED row to PUBLISHED (the only non-DRAFT row must be Live)", async () => {
    const club = await bootstrapAPClub("LP-NORM-PROMOTE");
    const a = await admin(club.id);
    const may = await publishPeriod(a, club.id, 2026, 5);
    // Manually flip May to ARCHIVED — the only non-DRAFT row.
    await db().monthlyPackage.update({
      where: { id: may.publishedPackageId },
      data: { status: "ARCHIVED" },
    });
    const r = await normalizeLivePointer(club.id);
    expect(r.liveId).toBe(may.publishedPackageId);
    expect(r.promotedId).toBe(may.publishedPackageId);
    expect(await statusOf(club.id, 2026, 5)).toBe("PUBLISHED");
  });

  it("normalizeLivePointer is tenant-isolated — Club A's rows don't affect Club B", async () => {
    const clubA = await bootstrapAPClub("LP-NORM-T-A");
    const clubB = await bootstrapAPClub("LP-NORM-T-B");
    const aA = await admin(clubA.id);
    const aB = await admin(clubB.id);
    await publishPeriod(aA, clubA.id, 2026, 5);
    await publishPeriod(aA, clubA.id, 2026, 6);
    await publishPeriod(aB, clubB.id, 2026, 7);
    // Normalize Club A — must not touch Club B.
    await normalizeLivePointer(clubA.id);
    expect(await statusOf(clubA.id, 2026, 5)).toBe("ARCHIVED");
    expect(await statusOf(clubA.id, 2026, 6)).toBe("PUBLISHED");
    expect(await statusOf(clubB.id, 2026, 7)).toBe("PUBLISHED");
  });
});
