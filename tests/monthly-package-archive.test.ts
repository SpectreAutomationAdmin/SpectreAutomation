// Monthly Package archive — service-layer + page-shape tests.
//
// Service tests exercise the three operations against the real DB:
//   • listArchivedMonthlyPackages — reverse-chronological listing,
//     recipient roll-up counts, tenant scoping, permission gate.
//   • deleteDraftMonthlyPackage — DRAFT-only, cascades recipients,
//     tenant-scoped, audit-logged.
//   • resendMonthlyPackage — refuses DRAFT, refreshes sentAt + sentBy,
//     resets recipient delivery state to PENDING, snapshot untouched.
//   • getMonthlyPackageRecipients — recipients with delivery state.
//
// Page-shape tests read the rendered files and assert the founder's
// column / action contract via regex (vitest can't render the page
// directly — it pulls in next/headers).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@/lib/errors";
import {
  deleteDraftMonthlyPackage,
  getMonthlyPackageRecipients,
  listArchivedMonthlyPackages,
  resendMonthlyPackage,
} from "@/lib/reporting/monthly-package-archive";

import { assignBoardRole } from "@/lib/governance/board-roles";

import { db, makeMember, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function admin(clubId: string) {
  const email = `admin-${Math.random().toString(36).slice(2, 10)}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

async function staffNoBoardReports(clubId: string) {
  // STAFF role does NOT carry reports:board. Use this principal to
  // prove the permission gate fires.
  const email = `staff-${Math.random().toString(36).slice(2, 10)}@example.com`;
  await makeUser({ email, role: "STAFF", clubId });
  return principalFor(email);
}

function periodEndDate(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 0));
}

async function createDraftPackage(
  clubId: string,
  generatorId: string,
  opts: { year: number; month: number; title?: string },
) {
  return db().monthlyPackage.create({
    data: {
      clubId,
      reportingYear: opts.year,
      reportingMonth: opts.month,
      periodEndDate: periodEndDate(opts.year, opts.month),
      status: "DRAFT",
      title: opts.title ?? `${opts.year}-${String(opts.month).padStart(2, "0")} Package`,
      generatedByUserId: generatorId,
    },
  });
}

async function createPublishedPackage(
  clubId: string,
  userId: string,
  opts: { year: number; month: number; title?: string },
) {
  return db().monthlyPackage.create({
    data: {
      clubId,
      reportingYear: opts.year,
      reportingMonth: opts.month,
      periodEndDate: periodEndDate(opts.year, opts.month),
      status: "PUBLISHED",
      title: opts.title ?? `${opts.year}-${String(opts.month).padStart(2, "0")} Package`,
      generatedByUserId: userId,
      publishedAt: new Date(Date.UTC(opts.year, opts.month - 1, 5)),
      publishedByUserId: userId,
      atAGlanceKpisJson: JSON.stringify([{ key: "ytd-noi", value: 412500 }]),
    },
  });
}

// ===========================================================================
// listArchivedMonthlyPackages
// ===========================================================================

describe("listArchivedMonthlyPackages", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("returns rows in reverse chronological order (newest period first)", async () => {
    const club = await bootstrapAPClub("MPA-ORDER");
    const p = await admin(club.id);
    await createDraftPackage(club.id, p.id, { year: 2026, month: 3, title: "Mar" });
    await createDraftPackage(club.id, p.id, { year: 2026, month: 5, title: "May" });
    await createDraftPackage(club.id, p.id, { year: 2026, month: 4, title: "Apr" });

    const rows = await listArchivedMonthlyPackages(p, club.id);
    expect(rows.map((r) => r.title)).toEqual(["May", "Apr", "Mar"]);
  });

  it("rolls up recipient counts (total / delivered / viewed)", async () => {
    const club = await bootstrapAPClub("MPA-COUNTS");
    const p = await admin(club.id);
    const pkg = await createPublishedPackage(club.id, p.id, { year: 2026, month: 5 });

    // Five recipients in mixed states.
    for (let i = 0; i < 5; i++) {
      const status = i < 2 ? "OPENED" : i < 4 ? "SENT" : "PENDING";
      await db().monthlyPackageRecipient.create({
        data: {
          monthlyPackageId: pkg.id,
          recipientEmail: `r${i}@example.com`,
          deliveryStatus: status,
          sentAt: status !== "PENDING" ? new Date() : null,
          viewedAt: status === "OPENED" ? new Date() : null,
        },
      });
    }

    const [row] = await listArchivedMonthlyPackages(p, club.id);
    expect(row.recipientCount).toBe(5);
    expect(row.recipientDeliveredCount).toBe(4); // SENT + OPENED
    expect(row.recipientViewedCount).toBe(2);    // OPENED only
  });

  it("scopes by clubId — Club A never sees Club B's archive", async () => {
    const clubA = await bootstrapAPClub("MPA-TENANT-A");
    const clubB = await bootstrapAPClub("MPA-TENANT-B");
    const adminA = await admin(clubA.id);
    const adminB = await admin(clubB.id);
    await createDraftPackage(clubA.id, adminA.id, { year: 2026, month: 5, title: "A May" });
    await createDraftPackage(clubB.id, adminB.id, { year: 2026, month: 5, title: "B May" });

    const aRows = await listArchivedMonthlyPackages(adminA, clubA.id);
    expect(aRows).toHaveLength(1);
    expect(aRows[0].title).toBe("A May");

    const bRows = await listArchivedMonthlyPackages(adminB, clubB.id);
    expect(bRows).toHaveLength(1);
    expect(bRows[0].title).toBe("B May");
  });

  it("refuses callers without reports:board (STAFF) for someone else's club", async () => {
    const club = await bootstrapAPClub("MPA-PERM");
    const otherClub = await bootstrapAPClub("MPA-PERM-OTHER");
    const staff = await staffNoBoardReports(club.id);
    await expect(
      listArchivedMonthlyPackages(staff, otherClub.id),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ===========================================================================
// deleteDraftMonthlyPackage
// ===========================================================================

describe("deleteDraftMonthlyPackage", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("deletes a DRAFT row and cascades its recipients", async () => {
    const club = await bootstrapAPClub("MPA-DEL-1");
    const p = await admin(club.id);
    const pkg = await createDraftPackage(club.id, p.id, { year: 2026, month: 5 });
    await db().monthlyPackageRecipient.create({
      data: { monthlyPackageId: pkg.id, recipientEmail: "r@example.com" },
    });
    await db().monthlyPackageRecipient.create({
      data: { monthlyPackageId: pkg.id, recipientEmail: "r2@example.com" },
    });

    await deleteDraftMonthlyPackage(p, pkg.id);
    expect(await db().monthlyPackage.findUnique({ where: { id: pkg.id } })).toBeNull();
    expect(
      await db().monthlyPackageRecipient.count({ where: { monthlyPackageId: pkg.id } }),
    ).toBe(0);
  });

  it("refuses to delete a PUBLISHED package (audit history)", async () => {
    const club = await bootstrapAPClub("MPA-DEL-PUB");
    const p = await admin(club.id);
    const pkg = await createPublishedPackage(club.id, p.id, { year: 2026, month: 5 });
    let caught: unknown;
    try {
      await deleteDraftMonthlyPackage(p, pkg.id);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).safeMessage.toLowerCase()).toContain("only draft");
    expect(await db().monthlyPackage.findUnique({ where: { id: pkg.id } })).not.toBeNull();
  });

  it("refuses to delete a SENT package", async () => {
    const club = await bootstrapAPClub("MPA-DEL-SENT");
    const p = await admin(club.id);
    const pkg = await createPublishedPackage(club.id, p.id, { year: 2026, month: 5 });
    await db().monthlyPackage.update({
      where: { id: pkg.id },
      data: { status: "SENT", sentAt: new Date(), sentByUserId: p.id },
    });
    await expect(deleteDraftMonthlyPackage(p, pkg.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("returns NotFoundError for an unknown package id", async () => {
    const club = await bootstrapAPClub("MPA-DEL-404");
    const p = await admin(club.id);
    await expect(deleteDraftMonthlyPackage(p, "not-a-real-id")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("tenant: another club's admin cannot delete the draft", async () => {
    const clubA = await bootstrapAPClub("MPA-DEL-TENANT-A");
    const clubB = await bootstrapAPClub("MPA-DEL-TENANT-B");
    const adminA = await admin(clubA.id);
    const adminB = await admin(clubB.id);
    const pkg = await createDraftPackage(clubA.id, adminA.id, { year: 2026, month: 5 });
    await expect(deleteDraftMonthlyPackage(adminB, pkg.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await db().monthlyPackage.findUnique({ where: { id: pkg.id } })).not.toBeNull();
  });

  it("audit log entry written with `reporting.monthly-package.delete-draft`", async () => {
    const club = await bootstrapAPClub("MPA-DEL-AUDIT");
    const p = await admin(club.id);
    const pkg = await createDraftPackage(club.id, p.id, { year: 2026, month: 5, title: "Audit me" });
    await deleteDraftMonthlyPackage(p, pkg.id);
    const logs = await db().auditLog.findMany({
      where: { entityId: pkg.id, action: "reporting.monthly-package.delete-draft" },
    });
    expect(logs).toHaveLength(1);
    const before = JSON.parse(logs[0].beforeJson ?? "{}");
    expect(before.title).toBe("Audit me");
    expect(before.status).toBe("DRAFT");
  });
});

// ===========================================================================
// resendMonthlyPackage
// ===========================================================================

describe("resendMonthlyPackage", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("refuses to resend a DRAFT", async () => {
    const club = await bootstrapAPClub("MPA-RES-DRAFT");
    const p = await admin(club.id);
    const pkg = await createDraftPackage(club.id, p.id, { year: 2026, month: 5 });
    let caught: unknown;
    try {
      await resendMonthlyPackage(p, pkg.id);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).safeMessage.toLowerCase()).toContain("cannot resend a draft");
  });

  it("from PUBLISHED â†’ SENT: status flips, sentAt + sentByUserId set, snapshot untouched", async () => {
    const club = await bootstrapAPClub("MPA-RES-PUB");
    const p = await admin(club.id);
    const sender = await admin(club.id);
    const pkg = await createPublishedPackage(club.id, p.id, { year: 2026, month: 5 });
    const snapshotBefore = pkg.atAGlanceKpisJson;

    const result = await resendMonthlyPackage(sender, pkg.id);
    expect(result.resent).toBe(true);

    const reread = await db().monthlyPackage.findUnique({ where: { id: pkg.id } });
    expect(reread!.status).toBe("SENT");
    expect(reread!.sentAt).toBeInstanceOf(Date);
    expect(reread!.sentByUserId).toBe(sender.id);
    // Snapshot byte-identical — the founder's immutability rule.
    expect(reread!.atAGlanceKpisJson).toBe(snapshotBefore);
  });

  it("rebuilds recipients from the CURRENT Board roster (founder fix 2026-06-29): every fresh row is PENDING + unviewed", async () => {
    // Under the founder's 2026-06-29 fix, resend wipes + recreates
    // recipients from the live Board roster — NOT preserves the
    // prior list. So a manually-seeded recipient that no longer
    // matches the current roster is REPLACED, not reset in place.
    const club = await bootstrapAPClub("MPA-RES-REBUILD");
    const p = await admin(club.id);
    // Set up an active Board member via Governance â†’ Board & Committees.
    const m = await makeMember(club.id, { firstName: "Sarah", lastName: "Vice" });
    const memberUser = await makeUser({
      email: `sarah-${Math.random().toString(36).slice(2, 8)}@example.com`,
      role: "MEMBER",
      clubId: club.id,
      memberId: m.id,
    });
    void memberUser;
    const start = new Date(); start.setUTCMonth(start.getUTCMonth() - 1);
    const end = new Date(); end.setUTCMonth(end.getUTCMonth() + 11);
    await assignBoardRole(p, { clubId: club.id,
      memberId: m.id,
      roleTitle: "Vice President",
      termStartDate: start,
      termEndDate: end,
    });

    const pkg = await createPublishedPackage(club.id, p.id, { year: 2026, month: 5 });
    // Seed a stale recipient that is NOT on the live roster — the
    // rebuild should drop it.
    await db().monthlyPackageRecipient.create({
      data: {
        monthlyPackageId: pkg.id,
        recipientEmail: "stale-no-longer-on-board@example.com",
        deliveryStatus: "OPENED",
        sentAt: new Date(Date.UTC(2026, 4, 5)),
        viewedAt: new Date(Date.UTC(2026, 4, 7)),
      },
    });

    const result = await resendMonthlyPackage(p, pkg.id);
    expect(result.recipientCount).toBe(1);

    const recipients = await db().monthlyPackageRecipient.findMany({
      where: { monthlyPackageId: pkg.id },
    });
    // Exactly one row — the stale one was dropped, the live Board
    // member (Sarah) is the only recipient.
    expect(recipients).toHaveLength(1);
    expect(recipients[0].recipientUserId).not.toBeNull();
    expect(recipients[0].recipientRole).toBe("Vice President");
    expect(recipients[0].deliveryStatus).toBe("PENDING");
    expect(recipients[0].sentAt).toBeNull();
    expect(recipients[0].viewedAt).toBeNull(); // NEW badge fires
  });

  it("a Board member elected AFTER the original publish IS included on resend (the founder's James-Whitfield case)", async () => {
    // Reproduces the 2026-06-29 bug: package published before James
    // got the President role â†’ 0 recipients. After the founder's
    // fix, resending rebuilds from the live roster and James
    // appears with role=President.
    const club = await bootstrapAPClub("MPA-RES-JAMES");
    const p = await admin(club.id);
    const pkg = await createPublishedPackage(club.id, p.id, { year: 2026, month: 6 });
    // At publish time, no Board members existed â†’ 0 recipients.
    expect(
      await db().monthlyPackageRecipient.count({ where: { monthlyPackageId: pkg.id } }),
    ).toBe(0);

    // AFTER publish, the controller assigns James as President.
    const james = await makeMember(club.id, { firstName: "James", lastName: "Whitfield" });
    const jamesUser = await makeUser({
      email: `james-${Math.random().toString(36).slice(2, 8)}@example.com`,
      role: "MEMBER",
      clubId: club.id,
      memberId: james.id,
    });
    const start = new Date(); start.setUTCMonth(start.getUTCMonth() - 1);
    const end = new Date(); end.setUTCMonth(end.getUTCMonth() + 11);
    await assignBoardRole(p, { clubId: club.id,
      memberId: james.id,
      roleTitle: "President",
      termStartDate: start,
      termEndDate: end,
    });

    // Resend the June package.
    const result = await resendMonthlyPackage(p, pkg.id);
    expect(result.recipientCount).toBe(1);

    const recipients = await db().monthlyPackageRecipient.findMany({
      where: { monthlyPackageId: pkg.id },
    });
    expect(recipients).toHaveLength(1);
    expect(recipients[0].recipientUserId).toBe(jamesUser.id);
    expect(recipients[0].recipientEmail).toBe(jamesUser.email);
    expect(recipients[0].recipientRole).toBe("President"); // not "Board Member"
    expect(recipients[0].viewedAt).toBeNull(); // NEW badge fires for James
  });

  it("excludes inactive / expired / upcoming Board members on resend", async () => {
    const club = await bootstrapAPClub("MPA-RES-EXCLUDE");
    const p = await admin(club.id);
    // A: ACTIVE (current term).
    const memA = await makeMember(club.id, { firstName: "Active", lastName: "Director" });
    await makeUser({
      email: `a-${Math.random().toString(36).slice(2, 8)}@example.com`,
      role: "MEMBER", clubId: club.id, memberId: memA.id,
    });
    const startA = new Date(); startA.setUTCMonth(startA.getUTCMonth() - 1);
    const endA = new Date(); endA.setUTCMonth(endA.getUTCMonth() + 11);
    await assignBoardRole(p, { clubId: club.id,
      memberId: memA.id, roleTitle: "Director",
      termStartDate: startA, termEndDate: endA,
    });
    // B: UPCOMING (term hasn't started).
    const memB = await makeMember(club.id, { firstName: "Future", lastName: "Treasurer" });
    await makeUser({
      email: `b-${Math.random().toString(36).slice(2, 8)}@example.com`,
      role: "MEMBER", clubId: club.id, memberId: memB.id,
    });
    const startB = new Date(); startB.setUTCMonth(startB.getUTCMonth() + 1);
    const endB = new Date(); endB.setUTCMonth(endB.getUTCMonth() + 13);
    await assignBoardRole(p, { clubId: club.id,
      memberId: memB.id, roleTitle: "Treasurer",
      termStartDate: startB, termEndDate: endB,
    });
    // C: EXPIRED (term ended).
    const memC = await makeMember(club.id, { firstName: "Past", lastName: "Secretary" });
    await makeUser({
      email: `c-${Math.random().toString(36).slice(2, 8)}@example.com`,
      role: "MEMBER", clubId: club.id, memberId: memC.id,
    });
    const startC = new Date(); startC.setUTCMonth(startC.getUTCMonth() - 13);
    const endC = new Date(); endC.setUTCMonth(endC.getUTCMonth() - 1);
    await assignBoardRole(p, { clubId: club.id,
      memberId: memC.id, roleTitle: "Secretary",
      termStartDate: startC, termEndDate: endC,
    });
    // D: ACTIVE term window BUT manually revoked (stored=EXPIRED).
    const memD = await makeMember(club.id, { firstName: "Revoked", lastName: "Member" });
    await makeUser({
      email: `d-${Math.random().toString(36).slice(2, 8)}@example.com`,
      role: "MEMBER", clubId: club.id, memberId: memD.id,
    });
    const startD = new Date(); startD.setUTCMonth(startD.getUTCMonth() - 1);
    const endD = new Date(); endD.setUTCMonth(endD.getUTCMonth() + 11);
    const roleD = await assignBoardRole(p, { clubId: club.id,
      memberId: memD.id, roleTitle: "Director",
      termStartDate: startD, termEndDate: endD,
    });
    await db().boardRole.update({ where: { id: roleD.id }, data: { status: "EXPIRED" } });

    const pkg = await createPublishedPackage(club.id, p.id, { year: 2026, month: 5 });
    const result = await resendMonthlyPackage(p, pkg.id);
    expect(result.recipientCount).toBe(1); // ONLY A

    const recipients = await db().monthlyPackageRecipient.findMany({
      where: { monthlyPackageId: pkg.id },
    });
    expect(recipients).toHaveLength(1);
    expect(recipients[0].recipientRole).toBe("Director");
    // B (upcoming), C (expired), D (revoked) all excluded.
  });

  it("deduplicates: a board member who's ALSO BOARD_READ_ONLY appears exactly once", async () => {
    const club = await bootstrapAPClub("MPA-RES-DEDUP");
    const p = await admin(club.id);
    // Set up: a user who has BOTH a BOARD_READ_ONLY clubRole AND
    // an active BoardRole. The roster should include them once.
    const member = await makeMember(club.id, { firstName: "Dup", lastName: "Director" });
    const dupUser = await makeUser({
      email: `dup-${Math.random().toString(36).slice(2, 8)}@example.com`,
      role: "BOARD_READ_ONLY", // primary role grants BOARD_READ_ONLY
      clubId: club.id,
      memberId: member.id,
    });
    void dupUser;
    const start = new Date(); start.setUTCMonth(start.getUTCMonth() - 1);
    const end = new Date(); end.setUTCMonth(end.getUTCMonth() + 11);
    await assignBoardRole(p, { clubId: club.id,
      memberId: member.id,
      roleTitle: "Director",
      termStartDate: start,
      termEndDate: end,
    });

    const pkg = await createPublishedPackage(club.id, p.id, { year: 2026, month: 5 });
    const result = await resendMonthlyPackage(p, pkg.id);
    expect(result.recipientCount).toBe(1); // dedup — not 2

    const recipients = await db().monthlyPackageRecipient.findMany({
      where: { monthlyPackageId: pkg.id },
    });
    expect(recipients).toHaveLength(1);
  });

  it("from already-SENT: status stays SENT, sentAt + sentByUserId update to the new send", async () => {
    const club = await bootstrapAPClub("MPA-RES-SENT");
    const p = await admin(club.id);
    const original = await admin(club.id);
    const second = await admin(club.id);
    const pkg = await createPublishedPackage(club.id, p.id, { year: 2026, month: 5 });
    const firstSentAt = new Date(Date.UTC(2026, 4, 6));
    await db().monthlyPackage.update({
      where: { id: pkg.id },
      data: {
        status: "SENT",
        sentAt: firstSentAt,
        sentByUserId: original.id,
      },
    });

    await resendMonthlyPackage(second, pkg.id);
    const reread = await db().monthlyPackage.findUnique({ where: { id: pkg.id } });
    expect(reread!.status).toBe("SENT");
    expect(reread!.sentByUserId).toBe(second.id);
    expect(reread!.sentAt!.getTime()).toBeGreaterThan(firstSentAt.getTime());
  });
});

// ===========================================================================
// getMonthlyPackageRecipients
// ===========================================================================

describe("getMonthlyPackageRecipients", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("returns the package header + recipient list", async () => {
    const club = await bootstrapAPClub("MPA-RECIP");
    const p = await admin(club.id);
    const pkg = await createPublishedPackage(club.id, p.id, { year: 2026, month: 5 });
    await db().monthlyPackageRecipient.create({
      data: {
        monthlyPackageId: pkg.id,
        recipientEmail: "chair@example.com",
        recipientRole: "Finance Chair",
        deliveryStatus: "OPENED",
        sentAt: new Date(),
        viewedAt: new Date(),
      },
    });

    const detail = await getMonthlyPackageRecipients(p, pkg.id);
    expect(detail.pkg.id).toBe(pkg.id);
    expect(detail.pkg.reportingMonth).toBe(5);
    expect(detail.recipients).toHaveLength(1);
    expect(detail.recipients[0].recipientEmail).toBe("chair@example.com");
    expect(detail.recipients[0].deliveryStatus).toBe("OPENED");
    expect(detail.recipients[0].recipientRole).toBe("Finance Chair");
  });
});

// ===========================================================================
// Page shape — contract test against the rendered files.
// ===========================================================================

describe("Monthly Package Archive page — column + action contract", () => {
  const PAGE = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/governance/monthly-package/archive/page.tsx"),
    "utf8",
  );
  const ROW_ACTIONS = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/governance/monthly-package/archive/RowActions.tsx"),
    "utf8",
  );
  const RECIPIENTS_PAGE = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/governance/monthly-package/archive/[id]/recipients/page.tsx"),
    "utf8",
  );
  const LAUNCHER = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/governance/monthly-package/page.tsx"),
    "utf8",
  );

  it("renders all 8 columns the founder specified", () => {
    for (const col of [
      "Reporting period",
      "Package title",
      "Status",
      "Published",
      "Sent",
      "Sent by",
      "Recipients",
      "Actions",
    ]) {
      expect(PAGE).toContain(`>${col}<`);
    }
  });

  it("uses the Badge component for status (DRAFT / PUBLISHED / SENT render distinct colours)", () => {
    expect(PAGE).toMatch(/import \{ Badge \} from "@\/components\/Badge"/);
    expect(PAGE).toMatch(/<Badge\s+status=\{r\.status\}/);
  });

  it("View package link routes to the reporting page with ?period=YYYY-MM", () => {
    expect(PAGE).toMatch(/\/app\/admin\/reporting\/monthly\?period=\$\{period\}/);
  });

  it("View Recipients link routes to /archive/[id]/recipients", () => {
    expect(PAGE).toMatch(/\/app\/admin\/governance\/monthly-package\/archive\/\$\{r\.id\}\/recipients/);
  });

  it("Re-send action is shown ONLY for PUBLISHED or SENT (not DRAFT)", () => {
    expect(ROW_ACTIONS).toMatch(/status === "PUBLISHED" \|\| status === "SENT"/);
    expect(ROW_ACTIONS).toMatch(/Re-send/);
  });

  it("Delete action is shown ONLY for DRAFT", () => {
    expect(ROW_ACTIONS).toMatch(/status === "DRAFT"/);
    expect(ROW_ACTIONS).toMatch(/Delete/);
  });

  it("Both row actions are confirm()-gated", () => {
    expect(ROW_ACTIONS).toMatch(/window\.confirm\(/);
    expect(ROW_ACTIONS.match(/window\.confirm\(/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("Service is ordered by periodEndDate DESC then generatedAt DESC", () => {
    const SERVICE = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/reporting/monthly-package-archive.ts"),
      "utf8",
    );
    expect(SERVICE).toMatch(/periodEndDate: "desc"/);
    expect(SERVICE).toMatch(/generatedAt: "desc"/);
  });

  it("Launcher's View Archive button targets the new dedicated archive route", () => {
    expect(LAUNCHER).toMatch(
      /ARCHIVE_HREF\s*=\s*"\/app\/admin\/governance\/monthly-package\/archive"/,
    );
  });

  it("Recipients page renders the founder's expected columns", () => {
    for (const col of [
      "Recipient",
      "Email",
      "Role",
      "Delivery",
      "Sent",
      "Viewed",
    ]) {
      expect(RECIPIENTS_PAGE).toContain(`>${col}<`);
    }
  });
});

