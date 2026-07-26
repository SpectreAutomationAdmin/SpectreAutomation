// Monthly Reporting Package — lifecycle service tests.
//
// Covers the founder's spec for the generate → publish → send
// workflow and its snapshot capture:
//
//   1. generateDraftMonthlyPackage is idempotent — calling it twice
//      for the same (clubId, year, month) returns the SAME row.
//   2. publish captures all three snapshot JSON fields against the
//      live reporting service output, flips status, records
//      publishedAt + publishedByUserId.
//   3. send auto-publishes a DRAFT, populates recipients from the
//      BOARD_READ_ONLY roster, and writes audit entries.
//   4. The atAGlanceKpis snapshot stays byte-identical after the
//      send step (the founder's headline requirement: history must
//      not silently change when ledger data later shifts).
//   5. Tenant + permission gates fire (board-only).
//   6. listSentPackagesForBoard returns SENT rows only.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";

import {
  ForbiddenError,
  NotFoundError,
} from "@/lib/errors";
import {
  generateDraftMonthlyPackage,
  publishMonthlyPackage,
  sendMonthlyPackage,
  listSentPackagesForBoard,
} from "@/lib/reporting/monthly-package-lifecycle";

import { db, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function admin(clubId: string) {
  const email = `admin-${Math.random().toString(36).slice(2, 10)}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

async function boardMember(clubId: string, opts?: { name?: string }) {
  const email = `board-${Math.random().toString(36).slice(2, 10)}@example.com`;
  await makeUser({
    email,
    role: "BOARD_READ_ONLY",
    clubId,
    name: opts?.name,
  });
  return principalFor(email);
}

async function staff(clubId: string) {
  const email = `staff-${Math.random().toString(36).slice(2, 10)}@example.com`;
  await makeUser({ email, role: "STAFF", clubId });
  return principalFor(email);
}

// ===========================================================================
// generateDraftMonthlyPackage
// ===========================================================================

describe("generateDraftMonthlyPackage", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("creates a DRAFT row with the period + title set", async () => {
    const club = await bootstrapAPClub("MPL-GEN-1");
    const p = await admin(club.id);
    const res = await generateDraftMonthlyPackage(p, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    expect(res.created).toBe(true);
    expect(res.package.status).toBe("DRAFT");
    expect(res.package.reportingYear).toBe(2026);
    expect(res.package.reportingMonth).toBe(5);
    expect(res.package.title).toContain("May 2026");

    const row = await db().monthlyPackage.findUnique({ where: { id: res.package.id } });
    expect(row).not.toBeNull();
    expect(row!.generatedByUserId).toBe(p.id);
    expect(row!.periodEndDate.toISOString().slice(0, 10)).toBe("2026-05-31");
  });

  it("is idempotent — second call for the same period returns the existing row", async () => {
    const club = await bootstrapAPClub("MPL-GEN-IDEMPOTENT");
    const p = await admin(club.id);
    const first = await generateDraftMonthlyPackage(p, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    const second = await generateDraftMonthlyPackage(p, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.package.id).toBe(first.package.id);
    expect(
      await db().monthlyPackage.count({
        where: { clubId: club.id, reportingYear: 2026, reportingMonth: 5 },
      }),
    ).toBe(1);
  });

  it("returns an existing PUBLISHED row unchanged (does not regress it to DRAFT)", async () => {
    const club = await bootstrapAPClub("MPL-GEN-PUBKEEP");
    const p = await admin(club.id);
    const draft = await generateDraftMonthlyPackage(p, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    // Bypass publish helper for speed; we only need the row's
    // status set to PUBLISHED for this test.
    await db().monthlyPackage.update({
      where: { id: draft.package.id },
      data: {
        status: "PUBLISHED",
        publishedAt: new Date(),
        publishedByUserId: p.id,
        atAGlanceKpisJson: "[]",
      },
    });
    const second = await generateDraftMonthlyPackage(p, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    expect(second.created).toBe(false);
    expect(second.package.status).toBe("PUBLISHED");
  });

  it("rejects callers without reports:board", async () => {
    const club = await bootstrapAPClub("MPL-GEN-PERM");
    const otherClub = await bootstrapAPClub("MPL-GEN-PERM-OTHER");
    const stf = await staff(club.id);
    await expect(
      generateDraftMonthlyPackage(stf, otherClub.id, {
        reportingYear: 2026,
        reportingMonth: 5,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ===========================================================================
// publishMonthlyPackage
// ===========================================================================

describe("publishMonthlyPackage", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("captures snapshot JSON from the live report + flips status to PUBLISHED", async () => {
    const club = await bootstrapAPClub("MPL-PUB-1");
    const p = await admin(club.id);
    const { package: draft } = await generateDraftMonthlyPackage(p, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });

    const res = await publishMonthlyPackage(p, draft.id);
    expect(res.packageId).toBe(draft.id);
    expect(res.publishedAt).toBeInstanceOf(Date);

    const reread = await db().monthlyPackage.findUnique({ where: { id: draft.id } });
    expect(reread!.status).toBe("PUBLISHED");
    expect(reread!.publishedByUserId).toBe(p.id);
    // All three snapshot fields are populated.
    expect(reread!.executiveOpeningSnapshotJson).toBeTruthy();
    expect(reread!.atAGlanceKpisJson).toBeTruthy();
    expect(reread!.packagePayloadJson).toBeTruthy();

    // atAGlanceKpisJson is a JSON array (the four cover KPIs may be
    // empty in test environments where the reporting service has
    // no demo data, but it MUST be a valid JSON array regardless).
    const kpis = JSON.parse(reread!.atAGlanceKpisJson!);
    expect(Array.isArray(kpis)).toBe(true);
    // executiveOpeningSnapshotJson is a JSON object with club +
    // period at minimum.
    const exec = JSON.parse(reread!.executiveOpeningSnapshotJson!);
    expect(exec).toHaveProperty("club");
    expect(exec).toHaveProperty("period");
    // packagePayloadJson is the full report payload.
    const full = JSON.parse(reread!.packagePayloadJson!);
    expect(full).toHaveProperty("club");
    expect(full).toHaveProperty("period");
    expect(full).toHaveProperty("executiveSummary");
  });

  it("overwrites an ARCHIVED package in place — does NOT regress the Live pointer", async () => {
    // Founder spec (2026-06-28): historical corrections never move
    // the Live pointer. The Controller may regenerate + republish
    // an older archived period (e.g. fix an error in May while
    // June is Live) — the row's snapshot is refreshed in place but
    // status STAYS Archived, and the prior Live remains the Live.
    const club = await bootstrapAPClub("MPL-PUB-ARCHIVED-OVERWRITE");
    const p = await admin(club.id);
    // June is the current Live.
    const { package: june } = await generateDraftMonthlyPackage(p, club.id, {
      reportingYear: 2026,
      reportingMonth: 6,
    });
    await publishMonthlyPackage(p, june.id);
    // May was a prior publication, now Archived.
    const { package: may } = await generateDraftMonthlyPackage(p, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    await db().monthlyPackage.update({
      where: { id: may.id },
      data: { status: "ARCHIVED", atAGlanceKpisJson: "[]" },
    });
    const before = await db().monthlyPackage.findUnique({ where: { id: may.id } });

    const result = await publishMonthlyPackage(p, may.id);
    expect(result.transition).toBe("OVERWRITE_HISTORICAL");
    expect(result.resultingStatus).toBe("ARCHIVED");
    expect(result.liveAdvanced).toBe(false);

    // May's snapshot got refreshed but its status stayed ARCHIVED.
    const after = await db().monthlyPackage.findUnique({ where: { id: may.id } });
    expect(after!.status).toBe("ARCHIVED");
    expect(after!.atAGlanceKpisJson).not.toBe(before!.atAGlanceKpisJson);
    expect(after!.publishedPayloadHash).toBeTruthy();
    // June remains the unchanged Live.
    const juneAfter = await db().monthlyPackage.findUnique({ where: { id: june.id } });
    expect(juneAfter!.status).toBe("PUBLISHED");
  });

  it("NotFoundError for an unknown package id", async () => {
    const club = await bootstrapAPClub("MPL-PUB-404");
    const p = await admin(club.id);
    await expect(publishMonthlyPackage(p, "no-such-id")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("tenant: another club's admin cannot publish this club's draft", async () => {
    const clubA = await bootstrapAPClub("MPL-PUB-TENANT-A");
    const clubB = await bootstrapAPClub("MPL-PUB-TENANT-B");
    const adminA = await admin(clubA.id);
    const adminB = await admin(clubB.id);
    const { package: draft } = await generateDraftMonthlyPackage(adminA, clubA.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    await expect(publishMonthlyPackage(adminB, draft.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("writes an audit entry on publish", async () => {
    const club = await bootstrapAPClub("MPL-PUB-AUDIT");
    const p = await admin(club.id);
    const { package: draft } = await generateDraftMonthlyPackage(p, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    await publishMonthlyPackage(p, draft.id);
    const logs = await db().auditLog.findMany({
      where: { entityId: draft.id, action: "reporting.monthly-package.publish" },
    });
    expect(logs).toHaveLength(1);
  });
});

// ===========================================================================
// sendMonthlyPackage
// ===========================================================================

describe("sendMonthlyPackage", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("auto-publishes a DRAFT then sends (status SENT, snapshot present, recipients populated)", async () => {
    const club = await bootstrapAPClub("MPL-SEND-AUTO-PUB");
    const p = await admin(club.id);
    // Two board members.
    await boardMember(club.id, { name: "Helena Boardchair" });
    await boardMember(club.id, { name: "Walter Director" });

    const { package: draft } = await generateDraftMonthlyPackage(p, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    const res = await sendMonthlyPackage(p, draft.id);
    expect(res.recipientCount).toBe(2);

    const reread = await db().monthlyPackage.findUnique({ where: { id: draft.id } });
    expect(reread!.status).toBe("SENT");
    expect(reread!.publishedAt).toBeInstanceOf(Date); // auto-published
    expect(reread!.sentAt).toBeInstanceOf(Date);
    expect(reread!.sentByUserId).toBe(p.id);
    expect(reread!.atAGlanceKpisJson).toBeTruthy();

    const recipients = await db().monthlyPackageRecipient.findMany({
      where: { monthlyPackageId: draft.id },
    });
    expect(recipients).toHaveLength(2);
    for (const r of recipients) {
      expect(r.deliveryStatus).toBe("PENDING"); // no adapter yet
      expect(r.recipientUserId).not.toBeNull();
      expect(r.recipientRole).toBe("Board Member");
    }
  });

  it("snapshot is byte-identical after send (immutability)", async () => {
    const club = await bootstrapAPClub("MPL-SEND-IMMUTABLE");
    const p = await admin(club.id);
    await boardMember(club.id);
    const { package: draft } = await generateDraftMonthlyPackage(p, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    await publishMonthlyPackage(p, draft.id);
    const afterPublish = await db().monthlyPackage.findUnique({ where: { id: draft.id } });
    const snapshotAfterPublish = afterPublish!.atAGlanceKpisJson;

    await sendMonthlyPackage(p, draft.id);
    const afterSend = await db().monthlyPackage.findUnique({ where: { id: draft.id } });
    expect(afterSend!.atAGlanceKpisJson).toBe(snapshotAfterPublish);
    expect(afterSend!.executiveOpeningSnapshotJson).toBe(afterPublish!.executiveOpeningSnapshotJson);
    expect(afterSend!.packagePayloadJson).toBe(afterPublish!.packagePayloadJson);
  });

  it("send replaces the recipient list (does not duplicate)", async () => {
    const club = await bootstrapAPClub("MPL-SEND-REPLACE");
    const p = await admin(club.id);
    await boardMember(club.id);
    await boardMember(club.id);
    const { package: draft } = await generateDraftMonthlyPackage(p, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    await sendMonthlyPackage(p, draft.id);
    expect(await db().monthlyPackageRecipient.count({ where: { monthlyPackageId: draft.id } })).toBe(2);

    // Send again.
    await sendMonthlyPackage(p, draft.id);
    expect(await db().monthlyPackageRecipient.count({ where: { monthlyPackageId: draft.id } })).toBe(2);
  });

  it("zero board members → send succeeds with empty recipient list", async () => {
    const club = await bootstrapAPClub("MPL-SEND-EMPTY");
    const p = await admin(club.id);
    const { package: draft } = await generateDraftMonthlyPackage(p, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    const res = await sendMonthlyPackage(p, draft.id);
    expect(res.recipientCount).toBe(0);
    expect(await db().monthlyPackageRecipient.count({ where: { monthlyPackageId: draft.id } })).toBe(0);
    expect(
      (await db().monthlyPackage.findUnique({ where: { id: draft.id } }))!.status,
    ).toBe("SENT");
  });

  it("explicit opts.recipients overrides the board-role roster", async () => {
    const club = await bootstrapAPClub("MPL-SEND-EXPLICIT");
    const p = await admin(club.id);
    await boardMember(club.id); // should be ignored
    const { package: draft } = await generateDraftMonthlyPackage(p, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    await sendMonthlyPackage(p, draft.id, {
      recipients: [
        { email: "external-auditor@firm.example.com", role: "External Auditor" },
      ],
    });
    const recipients = await db().monthlyPackageRecipient.findMany({
      where: { monthlyPackageId: draft.id },
    });
    expect(recipients).toHaveLength(1);
    expect(recipients[0].recipientEmail).toBe("external-auditor@firm.example.com");
    expect(recipients[0].recipientUserId).toBeNull();
  });
});

// ===========================================================================
// listSentPackagesForBoard
// ===========================================================================

describe("listSentPackagesForBoard", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("returns only the greatest-period SENT row (normalization demotes older SENT to ARCHIVED)", async () => {
    // Founder's greatest-period-wins rule (2026-06-29):
    // normalizeLivePointer runs after `send` and demotes any SENT
    // row that is NOT the greatest non-DRAFT period back to ARCHIVED.
    // The only way a row can keep status SENT is if its period IS
    // the greatest (i.e. it IS the Live). This test exercises that
    // exact contract — send the Live period, confirm SENT survives;
    // send an older period, confirm normalization demotes it.
    const club = await bootstrapAPClub("MPL-BOARD-LIST");
    const p = await admin(club.id);
    // April DRAFT (never published/sent, stays DRAFT)
    await generateDraftMonthlyPackage(p, club.id, { reportingYear: 2026, reportingMonth: 4 });
    // May → publish → Live.
    const { package: may } = await generateDraftMonthlyPackage(p, club.id, { reportingYear: 2026, reportingMonth: 5 });
    await publishMonthlyPackage(p, may.id);
    // Send May (the Live period). Normalization preserves SENT on
    // the greatest row.
    await sendMonthlyPackage(p, may.id);

    const board = await boardMember(club.id);
    const rows = await listSentPackagesForBoard(board, club.id);
    expect(rows.map((r) => r.reportingMonth)).toEqual([5]);

    // Sending an older period after a newer Live exists: the SENT
    // row gets demoted back to ARCHIVED by normalization.
    const { package: mar } = await generateDraftMonthlyPackage(p, club.id, { reportingYear: 2026, reportingMonth: 3 });
    await sendMonthlyPackage(p, mar.id);
    const after = await listSentPackagesForBoard(board, club.id);
    // March doesn't appear — it was demoted to ARCHIVED.
    expect(after.find((r) => r.reportingMonth === 3)).toBeUndefined();
    // May is still SENT (still the greatest non-DRAFT period).
    expect(after.find((r) => r.reportingMonth === 5)).toBeDefined();
  });

  it("rejects callers without reports:board", async () => {
    const club = await bootstrapAPClub("MPL-BOARD-PERM");
    const other = await bootstrapAPClub("MPL-BOARD-PERM-OTHER");
    const stf = await staff(club.id);
    await expect(listSentPackagesForBoard(stf, other.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
