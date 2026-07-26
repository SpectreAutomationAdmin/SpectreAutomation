// Monthly Package — publish workflow with the Live Pointer model
// (founder spec 2026-06-28).
//
// Acceptance matrix:
//
//   • Draft → Publish → Published (status flip in place, snapshot
//     captured, recipients populated, publishedPayloadHash stored).
//   • Exactly ONE MonthlyPackage row per (clubId, year, month) —
//     enforced by Prisma unique constraint. Re-publishing the same
//     period OVERWRITES that row; it never creates duplicates.
//   • The "Live Package" = the newest reporting period at status
//     PUBLISHED for the club. Exactly one Live at a time.
//   • Overwriting the CURRENT Live row (Case 1): row stays
//     PUBLISHED, snapshot refreshed, recipients re-issued (NEW
//     badge fires again). Live pointer does not move.
//   • Overwriting an OLDER archived row (Case 2): row stays
//     ARCHIVED, snapshot refreshed, recipients untouched. Live
//     pointer does NOT regress to the older period — the Board
//     dashboard continues pointing at the current Live.
//   • Publishing a NEWER period than the current Live: advances
//     the Live pointer. New row becomes PUBLISHED, prior Live
//     (a different period) becomes ARCHIVED. This is the ONLY
//     scenario where the Live pointer moves automatically.
//   • ARCHIVED rows: not surfaced to Board tile or board view;
//     remain visible in the admin archive; CAN be overwritten in
//     place by the Controller as a historical correction.
//   • generateDraftMonthlyPackage returns the existing row (any
//     status) for a period — never creates a duplicate.
//   • computePublishedPayloadHash is deterministic + matches when
//     stored vs. recomputed.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  computePublishedPayloadHash,
  generateDraftMonthlyPackage,
  getBoardPackageView,
  getMostRecentBoardPackageForUser,
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
async function boardUser(clubId: string, name?: string) {
  const email = `board-${Math.random().toString(36).slice(2, 10)}@example.com`;
  await makeUser({ email, role: "BOARD_READ_ONLY", clubId, name });
  return principalFor(email);
}

// ===========================================================================
// computePublishedPayloadHash — pure utility
// ===========================================================================

describe("computePublishedPayloadHash", () => {
  it("is deterministic for identical input", () => {
    const k = [{ key: "ytd-revenue", value: 1_823_000 }];
    expect(computePublishedPayloadHash(k)).toBe(computePublishedPayloadHash(k));
  });
  it("changes when the KPI values change", () => {
    const before = computePublishedPayloadHash([
      { key: "ytd-revenue", value: 1_823_000 },
    ]);
    const after = computePublishedPayloadHash([
      { key: "ytd-revenue", value: 1_900_000 },
    ]);
    expect(after).not.toBe(before);
  });
  it("treats null/undefined as the empty list", () => {
    const empty = computePublishedPayloadHash([]);
    expect(computePublishedPayloadHash(null)).toBe(empty);
    expect(computePublishedPayloadHash(undefined)).toBe(empty);
  });
});

// ===========================================================================
// State 1 → 2: DRAFT → PUBLISHED (first publication)
// ===========================================================================

describe("publishMonthlyPackage — DRAFT → PUBLISHED (first publication)", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("mutates the DRAFT row in place: status PUBLISHED, hash stored, recipients populated", async () => {
    const club = await bootstrapAPClub("PS-DRAFT-PUB");
    const a = await admin(club.id);
    await boardUser(club.id, "Alice");

    const { package: draft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    const result = await publishMonthlyPackage(a, draft.id);
    expect(result.transition).toBe("DRAFT->PUBLISHED");
    expect(result.publishedPackageId).toBe(draft.id); // same row mutated

    const reread = await db().monthlyPackage.findUnique({ where: { id: draft.id } });
    expect(reread!.status).toBe("PUBLISHED");
    expect(reread!.publishedPayloadHash).toBeTruthy();
    expect(reread!.publishedPayloadHash!.length).toBeGreaterThan(20);
    expect(
      await db().monthlyPackageRecipient.count({ where: { monthlyPackageId: draft.id } }),
    ).toBe(1);
  });
});

// ===========================================================================
// State 2 → 3: PUBLISHED matches → "Published"; differs → "Update"
// ===========================================================================

describe("Published vs Update Publication — hash drift detection", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("right after publish, the stored hash matches a recomputation of the same KPIs", async () => {
    const club = await bootstrapAPClub("PS-HASH-MATCH");
    const a = await admin(club.id);
    const { package: draft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    await publishMonthlyPackage(a, draft.id);
    const row = await db().monthlyPackage.findUnique({ where: { id: draft.id } });
    const stored = row!.publishedPayloadHash!;
    const liveAtAGlance = JSON.parse(row!.atAGlanceKpisJson!);
    const recomputed = computePublishedPayloadHash(liveAtAGlance);
    expect(recomputed).toBe(stored);
  });

  it("when the live KPIs drift, the hash recomputed from the live data differs from the stored", async () => {
    const club = await bootstrapAPClub("PS-HASH-DRIFT");
    const a = await admin(club.id);
    const { package: draft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    await publishMonthlyPackage(a, draft.id);
    const row = await db().monthlyPackage.findUnique({ where: { id: draft.id } });
    const stored = row!.publishedPayloadHash!;
    // Simulate a live KPI change (e.g. a journal entry moved the NOI).
    const driftedHash = computePublishedPayloadHash([
      { key: "ytd-revenue", value: 999_999 },
    ]);
    expect(driftedHash).not.toBe(stored);
  });
});

// ===========================================================================
// CASE 1 — Overwrite the CURRENT Live row (period stays Live)
// ===========================================================================

describe("publishMonthlyPackage — Overwrite the current Live row", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("re-publishing the current Live period overwrites the row IN PLACE (no new row, no duplicates)", async () => {
    const club = await bootstrapAPClub("PS-OVERWRITE-LIVE");
    const a = await admin(club.id);
    await boardUser(club.id);
    const { package: draft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    const first = await publishMonthlyPackage(a, draft.id);
    const second = await publishMonthlyPackage(a, first.publishedPackageId);
    // Same row id — overwrite never creates a duplicate.
    expect(second.transition).toBe("OVERWRITE_LIVE");
    expect(second.publishedPackageId).toBe(first.publishedPackageId);
    expect(second.resultingStatus).toBe("PUBLISHED");
    expect(second.liveAdvanced).toBe(false);
    expect(second.overwroteExisting).toBe(true);

    // Founder rule: exactly ONE row per (clubId, year, month).
    const all = await db().monthlyPackage.findMany({
      where: { clubId: club.id, reportingYear: 2026, reportingMonth: 5 },
    });
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("PUBLISHED");
  });

  it("OVERWRITE_LIVE refreshes recipients (every Board member gets a fresh NEW badge)", async () => {
    const club = await bootstrapAPClub("PS-OVERWRITE-LIVE-RECIPS");
    const a = await admin(club.id);
    await boardUser(club.id);
    await boardUser(club.id);
    const { package: draft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    const first = await publishMonthlyPackage(a, draft.id);
    // Pretend one of the recipients viewed it.
    await db().monthlyPackageRecipient.updateMany({
      where: { monthlyPackageId: first.publishedPackageId },
      data: { viewedAt: new Date(), deliveryStatus: "OPENED" },
    });
    await publishMonthlyPackage(a, first.publishedPackageId);

    const recipients = await db().monthlyPackageRecipient.findMany({
      where: { monthlyPackageId: first.publishedPackageId },
    });
    expect(recipients).toHaveLength(2);
    for (const r of recipients) {
      expect(r.viewedAt).toBeNull(); // wiped + recreated
      expect(r.deliveryStatus).toBe("PENDING");
    }
  });

  it("audit log captures the OVERWRITE_LIVE transition with priorStatus=PUBLISHED", async () => {
    const club = await bootstrapAPClub("PS-OVERWRITE-LIVE-AUDIT");
    const a = await admin(club.id);
    const { package: draft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    const first = await publishMonthlyPackage(a, draft.id);
    await publishMonthlyPackage(a, first.publishedPackageId);

    const logs = await db().auditLog.findMany({
      where: {
        entityId: first.publishedPackageId,
        action: "reporting.monthly-package.publish",
      },
      orderBy: { createdAt: "asc" },
    });
    // Two publishes against the same row id.
    expect(logs).toHaveLength(2);
    const second = JSON.parse(logs[1].afterJson ?? "{}");
    expect(second.transition).toBe("OVERWRITE_LIVE");
    expect(second.priorStatus).toBe("PUBLISHED");
    expect(second.resultingStatus).toBe("PUBLISHED");
    expect(second.becameLive).toBe(true);
    expect(second.liveAdvanced).toBe(false);
  });
});

// ===========================================================================
// CASE 2 — Overwrite an OLDER archived row (Live pointer does NOT regress)
// ===========================================================================

describe("publishMonthlyPackage — Overwrite a historical archived row", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("re-publishing an OLDER period keeps the row ARCHIVED — Live pointer does not regress", async () => {
    const club = await bootstrapAPClub("PS-OVERWRITE-HIST");
    const a = await admin(club.id);
    await boardUser(club.id);
    // May is published first.
    const { package: mayDraft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    const may = await publishMonthlyPackage(a, mayDraft.id);
    // June is published — advances Live, archives May.
    const { package: junDraft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 6,
    });
    const jun = await publishMonthlyPackage(a, junDraft.id);
    expect(jun.transition).toBe("ADVANCE_LIVE");
    // Confirm setup: May is ARCHIVED, June is PUBLISHED.
    const mayAfterJune = await db().monthlyPackage.findUnique({ where: { id: may.publishedPackageId } });
    expect(mayAfterJune!.status).toBe("ARCHIVED");

    // Controller now corrects May (historical fix).
    const correction = await publishMonthlyPackage(a, may.publishedPackageId);
    expect(correction.transition).toBe("OVERWRITE_HISTORICAL");
    expect(correction.resultingStatus).toBe("ARCHIVED");
    expect(correction.liveAdvanced).toBe(false);

    // May's snapshot was refreshed but status stayed ARCHIVED.
    const mayFinal = await db().monthlyPackage.findUnique({ where: { id: may.publishedPackageId } });
    expect(mayFinal!.status).toBe("ARCHIVED");
    expect(mayFinal!.publishedPayloadHash).toBeTruthy();
    // June still Live, untouched.
    const junFinal = await db().monthlyPackage.findUnique({ where: { id: jun.publishedPackageId } });
    expect(junFinal!.status).toBe("PUBLISHED");
  });

  it("Board dashboard tile continues pointing at June after May is overwritten (no regression)", async () => {
    const club = await bootstrapAPClub("PS-OVERWRITE-HIST-TILE");
    const a = await admin(club.id);
    const board = await boardUser(club.id);
    // Set up: May then June (June becomes Live).
    const { package: mayDraft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    const may = await publishMonthlyPackage(a, mayDraft.id);
    const { package: junDraft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 6,
    });
    const jun = await publishMonthlyPackage(a, junDraft.id);
    // Overwrite May (historical correction).
    await publishMonthlyPackage(a, may.publishedPackageId);
    // Board tile still resolves to June.
    const tile = await getMostRecentBoardPackageForUser(board, club.id);
    expect(tile).not.toBeNull();
    expect(tile!.id).toBe(jun.publishedPackageId);
    expect(tile!.reportingMonth).toBe(6);
  });

  it("overwriting an older archived row does NOT touch the Live row's recipients", async () => {
    const club = await bootstrapAPClub("PS-OVERWRITE-HIST-RECIPS");
    const a = await admin(club.id);
    await boardUser(club.id);
    // Set up.
    const { package: mayDraft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    const may = await publishMonthlyPackage(a, mayDraft.id);
    const { package: junDraft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 6,
    });
    const jun = await publishMonthlyPackage(a, junDraft.id);
    // Mark June's recipient as VIEWED.
    await db().monthlyPackageRecipient.updateMany({
      where: { monthlyPackageId: jun.publishedPackageId },
      data: { viewedAt: new Date(), deliveryStatus: "OPENED" },
    });
    // Overwrite May.
    const correction = await publishMonthlyPackage(a, may.publishedPackageId);
    expect(correction.recipientCount).toBe(0); // no recipients touched

    // June's recipient still marked as viewed (NOT re-issued).
    const juneRecips = await db().monthlyPackageRecipient.findMany({
      where: { monthlyPackageId: jun.publishedPackageId },
    });
    expect(juneRecips).toHaveLength(1);
    expect(juneRecips[0].viewedAt).not.toBeNull();
    expect(juneRecips[0].deliveryStatus).toBe("OPENED");
  });
});

// ===========================================================================
// ADVANCE LIVE — publishing a NEWER period moves the Live pointer forward
// ===========================================================================

describe("publishMonthlyPackage — Advance Live (new period publication)", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("publishing a newer period archives the prior Live and advances the pointer", async () => {
    const club = await bootstrapAPClub("PS-ADVANCE-LIVE");
    const a = await admin(club.id);
    await boardUser(club.id);
    const { package: mayDraft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    const may = await publishMonthlyPackage(a, mayDraft.id);
    expect(may.transition).toBe("DRAFT->PUBLISHED");
    expect(may.liveAdvanced).toBe(false); // first-publish-into-empty isn't an "advance"

    const { package: junDraft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 6,
    });
    const jun = await publishMonthlyPackage(a, junDraft.id);
    expect(jun.transition).toBe("ADVANCE_LIVE");
    expect(jun.resultingStatus).toBe("PUBLISHED");
    expect(jun.liveAdvanced).toBe(true);

    // May → ARCHIVED, June → PUBLISHED. Exactly one row per period.
    const mayRow = await db().monthlyPackage.findUnique({ where: { id: may.publishedPackageId } });
    const junRow = await db().monthlyPackage.findUnique({ where: { id: jun.publishedPackageId } });
    expect(mayRow!.status).toBe("ARCHIVED");
    expect(junRow!.status).toBe("PUBLISHED");
    expect(mayRow!.id).not.toBe(junRow!.id);
  });

  it("audit log records the ADVANCE_LIVE transition + priorLiveArchivedId", async () => {
    const club = await bootstrapAPClub("PS-ADVANCE-AUDIT");
    const a = await admin(club.id);
    const { package: mayDraft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    const may = await publishMonthlyPackage(a, mayDraft.id);
    const { package: junDraft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 6,
    });
    const jun = await publishMonthlyPackage(a, junDraft.id);
    const logs = await db().auditLog.findMany({
      where: {
        entityId: jun.publishedPackageId,
        action: "reporting.monthly-package.publish",
      },
    });
    expect(logs).toHaveLength(1);
    const after = JSON.parse(logs[0].afterJson ?? "{}");
    expect(after.transition).toBe("ADVANCE_LIVE");
    expect(after.liveAdvanced).toBe(true);
    expect(after.priorLiveArchivedId).toBe(may.publishedPackageId);
  });
});

// ===========================================================================
// ARCHIVED rows — recipient-side visibility (Board never reads them)
// ===========================================================================

describe("ARCHIVED rows — board access", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("ARCHIVED rows do NOT surface on the Board dashboard tile (newer Live wins)", async () => {
    const club = await bootstrapAPClub("PS-ARCHIVED-NO-TILE");
    const a = await admin(club.id);
    const board = await boardUser(club.id);
    // May then June — May becomes archived, June is Live.
    const { package: mayDraft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    await publishMonthlyPackage(a, mayDraft.id);
    const { package: junDraft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 6,
    });
    const jun = await publishMonthlyPackage(a, junDraft.id);

    const tile = await getMostRecentBoardPackageForUser(board, club.id);
    expect(tile).not.toBeNull();
    expect(tile!.id).toBe(jun.publishedPackageId);
  });

  it("ARCHIVED rows are NOT viewable via the board view (404 even with board perm)", async () => {
    const club = await bootstrapAPClub("PS-ARCHIVED-NO-VIEW");
    const a = await admin(club.id);
    const board = await boardUser(club.id);
    const { package: mayDraft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    const may = await publishMonthlyPackage(a, mayDraft.id);
    const { package: junDraft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 6,
    });
    await publishMonthlyPackage(a, junDraft.id);
    // Board user tries to open the now-archived May row directly.
    expect(await getBoardPackageView(board, may.publishedPackageId)).toBeNull();
  });

  it("ARCHIVED rows ARE listed on the admin archive surface", async () => {
    const club = await bootstrapAPClub("PS-ARCHIVED-IN-ADMIN");
    const a = await admin(club.id);
    const { package: mayDraft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    await publishMonthlyPackage(a, mayDraft.id);
    const { package: junDraft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 6,
    });
    await publishMonthlyPackage(a, junDraft.id);

    const rows = await listArchivedMonthlyPackages(a, club.id);
    const statuses = rows.map((r) => r.status).sort();
    // One ARCHIVED (May) + one PUBLISHED (June).
    expect(statuses).toEqual(["ARCHIVED", "PUBLISHED"]);
  });
});

// ===========================================================================
// Unique constraint — one row per period
// ===========================================================================

describe("Unique constraint — exactly one MonthlyPackage row per (club, period)", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("publishing the same period twice never creates a duplicate row", async () => {
    const club = await bootstrapAPClub("PS-UNIQUE-1");
    const a = await admin(club.id);
    const { package: draft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    await publishMonthlyPackage(a, draft.id);
    await publishMonthlyPackage(a, draft.id);
    await publishMonthlyPackage(a, draft.id);
    const all = await db().monthlyPackage.findMany({
      where: { clubId: club.id, reportingYear: 2026, reportingMonth: 5 },
    });
    expect(all).toHaveLength(1);
  });

  it("attempting to create a second row for the same period directly violates the constraint", async () => {
    const club = await bootstrapAPClub("PS-UNIQUE-2");
    const a = await admin(club.id);
    const { package: draft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    await publishMonthlyPackage(a, draft.id);
    // Direct INSERT — should fail at the Prisma layer.
    await expect(
      db().monthlyPackage.create({
        data: {
          clubId: club.id,
          reportingYear: 2026,
          reportingMonth: 5,
          periodEndDate: new Date(Date.UTC(2026, 5, 0)),
          status: "DRAFT",
          title: "duplicate-should-fail",
        },
      }),
    ).rejects.toThrow();
  });
});

// ===========================================================================
// generateDraftMonthlyPackage — prefers PUBLISHED, never returns ARCHIVED
// ===========================================================================

describe("generateDraftMonthlyPackage — live-row resolution", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("returns the PUBLISHED row when one exists (does not regress to DRAFT)", async () => {
    const club = await bootstrapAPClub("PS-RESOLVE-PUB");
    const a = await admin(club.id);
    const { package: draft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    await publishMonthlyPackage(a, draft.id);
    const again = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    expect(again.created).toBe(false);
    expect(again.package.id).toBe(draft.id);
    expect(again.package.status).toBe("PUBLISHED");
  });

  it("returns the SAME row after overwrite (one row per period; overwrite is in-place)", async () => {
    const club = await bootstrapAPClub("PS-RESOLVE-AFTER-OVERWRITE");
    const a = await admin(club.id);
    const { package: draft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    const first = await publishMonthlyPackage(a, draft.id);
    const second = await publishMonthlyPackage(a, first.publishedPackageId);
    // Same id — overwrite never creates a successor row.
    expect(second.publishedPackageId).toBe(first.publishedPackageId);

    const resolved = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    expect(resolved.created).toBe(false);
    expect(resolved.package.id).toBe(first.publishedPackageId);
    expect(resolved.package.status).toBe("PUBLISHED");
  });

  it("returns the ARCHIVED row when only an archived row exists for the period (controller can overwrite from there)", async () => {
    // After June advances Live, May is ARCHIVED. The Controller
    // navigating back to May via the launcher must land on that
    // exact row — there's only one row per period and the unique
    // constraint prevents creating a second.
    const club = await bootstrapAPClub("PS-RESOLVE-ARCHIVED");
    const a = await admin(club.id);
    const { package: mayDraft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    const may = await publishMonthlyPackage(a, mayDraft.id);
    const { package: junDraft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 6,
    });
    await publishMonthlyPackage(a, junDraft.id);
    // May is now ARCHIVED.
    const resolved = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    expect(resolved.created).toBe(false);
    expect(resolved.package.id).toBe(may.publishedPackageId);
    expect(resolved.package.status).toBe("ARCHIVED");
  });
});

// ===========================================================================
// Page-shape contract — 4-mode button + page wiring
// ===========================================================================

describe("PublishHeaderButton — Live-pointer-aware contract", () => {
  const BTN = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "src/app/app/admin/reporting/monthly/PublishHeaderButton.tsx",
    ),
    "utf8",
  );
  const PAGE = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/reporting/monthly/page.tsx"),
    "utf8",
  );

  it("button branches on DRAFT / PUBLISHED+match / PUBLISHED+drift / ARCHIVED", () => {
    expect(BTN).toMatch(/status === "DRAFT"/);
    expect(BTN).toMatch(/status === "PUBLISHED" \|\| status === "SENT"/);
    expect(BTN).toMatch(/status === "ARCHIVED"/);
    expect(BTN).toMatch(/hasUnpublishedEdits/);
  });

  it("renders the founder-spec labels: Publish (DRAFT) + Published (info) + Overwrite Package (action)", () => {
    expect(BTN).toContain("Publish"); // DRAFT first-publish button label
    expect(BTN).toContain("Published"); // matching-hash informational pill
    expect(BTN).toContain("Overwrite Package"); // overwrite action (PUBLISHED+drift OR ARCHIVED)
    // The legacy "Update Publication" label is gone — replaced by
    // "Overwrite Package" per the founder's Live-pointer spec.
    expect(BTN).not.toContain("Update Publication");
  });

  it("ARCHIVED rows present an Overwrite action (controller can correct history)", () => {
    // Under the new model, the controller can overwrite a
    // historical archived row to refresh its snapshot. The row
    // STAYS Archived; the Board dashboard does not regress.
    expect(BTN).toMatch(/data-mode="overwrite-archived"/);
  });

  it("matching-hash Published is informational only (role=\"status\")", () => {
    // The PUBLISHED + matching-hash branch renders an informational
    // <span> with role="status" — no button to click, signals
    // "this is what the Board is reading right now".
    expect(BTN).toMatch(/data-mode="published"[\s\S]+role="status"/);
  });

  it("Overwrite dialog uses the founder-spec copy + buttons", () => {
    expect(BTN).toContain("Overwrite existing package?");
    expect(BTN).toContain(
      "A Monthly Reporting Package already exists for ${periodLabel}.",
    );
    expect(BTN).toContain(
      "Publishing this version will replace the existing package for ${periodLabel}.",
    );
    expect(BTN).toContain(
      "This will not change the Monthly Reporting Package currently displayed on Board member dashboards unless ${periodLabel} is already the current live package.",
    );
    expect(BTN).toContain("This action cannot be undone.");
    expect(BTN).toContain("Cancel");
    // The Overwrite Package label appears for both the action
    // button and the dialog confirm button.
    expect(BTN).toMatch(/Overwrite Package/);
  });

  it("page computes hash from live KPIs + passes hasUnpublishedEdits + isCurrentLive to the button", () => {
    expect(PAGE).toMatch(/computePublishedPayloadHash/);
    expect(PAGE).toMatch(/hasUnpublishedEdits=\{hasUnpublishedEdits\}/);
    expect(PAGE).toMatch(/isCurrentLive=\{isCurrentLive\}/);
    expect(PAGE).toMatch(/periodLabel=\{periodLabel\}/);
  });
});
