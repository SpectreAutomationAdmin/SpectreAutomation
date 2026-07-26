// Governance — Board & Committees roster service tests.
//
// Covers the founder's acceptance matrix:
//
//   • assignBoardRole creates a row with title / committee /
//     term / status / source — input validated, member must
//     belong to the club, permission gated on packages:write.
//   • effectiveBoardStatus computes UPCOMING / ACTIVE / EXPIRED
//     from term dates against a supplied `now`; stored EXPIRED
//     status overrides.
//   • isActiveBoardMember resolves the principal → user.memberId
//     → ANY non-EXPIRED BoardRole covering today; returns false
//     for users without a member link or without a current role.
//   • Hook integration: getMostRecentBoardPackageForUser surfaces
//     the package to a member who holds an ACTIVE BoardRole, even
//     when they aren't a recipient and don't have reports:board.
//   • getBoardPackageView likewise unlocks PUBLISHED/SENT viewing
//     for active board-role holders.
//   • Cross-cutting: tenant isolation, audit log.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import {
  assignBoardRole,
  BOARD_ROLE_TITLES,
  deleteBoardRole,
  effectiveBoardStatus,
  isActiveBoardMember,
  listBoardRoster,
  updateBoardRole,
} from "@/lib/governance/board-roles";
import {
  generateDraftMonthlyPackage,
  getBoardPackageView,
  getMostRecentBoardPackageForUser,
  publishMonthlyPackage,
} from "@/lib/reporting/monthly-package-lifecycle";

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

async function regularMemberUser(
  clubId: string,
  opts?: { firstName?: string; lastName?: string },
) {
  // Member (the person) + the User that points at them.
  const member = await makeMember(clubId, {
    firstName: opts?.firstName ?? "Test",
    lastName: opts?.lastName ?? "Member",
  });
  const email = `mem-${Math.random().toString(36).slice(2, 10)}@example.com`;
  const user = await makeUser({ email, role: "MEMBER", clubId, memberId: member.id });
  return {
    member,
    user,
    principal: await principalFor(email),
  };
}

async function staff(clubId: string) {
  const email = `staff-${Math.random().toString(36).slice(2, 10)}@example.com`;
  await makeUser({ email, role: "STAFF", clubId });
  return principalFor(email);
}

const YEAR_BOUNDS = {
  yesterday: () => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d;
  },
  tomorrow: () => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    return d;
  },
  oneYearFromNow: () => {
    const d = new Date();
    d.setUTCFullYear(d.getUTCFullYear() + 1);
    return d;
  },
  oneYearAgo: () => {
    const d = new Date();
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    return d;
  },
};

// ===========================================================================
// effectiveBoardStatus — date math
// ===========================================================================

describe("effectiveBoardStatus", () => {
  const NOW = new Date(Date.UTC(2026, 5, 15)); // June 15, 2026

  it("UPCOMING when termStartDate is in the future", () => {
    expect(
      effectiveBoardStatus(
        {
          status: "UPCOMING",
          termStartDate: new Date(Date.UTC(2026, 6, 1)), // July 1
          termEndDate: new Date(Date.UTC(2027, 5, 30)),
        },
        NOW,
      ),
    ).toBe("UPCOMING");
  });

  it("ACTIVE when today sits inside the term window", () => {
    expect(
      effectiveBoardStatus(
        {
          status: "UPCOMING", // stored value irrelevant here
          termStartDate: new Date(Date.UTC(2026, 0, 1)),
          termEndDate: new Date(Date.UTC(2027, 0, 1)),
        },
        NOW,
      ),
    ).toBe("ACTIVE");
  });

  it("EXPIRED when termEndDate is in the past", () => {
    expect(
      effectiveBoardStatus(
        {
          status: "ACTIVE",
          termStartDate: new Date(Date.UTC(2025, 0, 1)),
          termEndDate: new Date(Date.UTC(2026, 5, 1)), // June 1, before NOW
        },
        NOW,
      ),
    ).toBe("EXPIRED");
  });

  it("stored EXPIRED overrides even when the term window covers today (manual revoke)", () => {
    expect(
      effectiveBoardStatus(
        {
          status: "EXPIRED",
          termStartDate: new Date(Date.UTC(2026, 0, 1)),
          termEndDate: new Date(Date.UTC(2027, 0, 1)),
        },
        NOW,
      ),
    ).toBe("EXPIRED");
  });
});

// ===========================================================================
// assignBoardRole — input validation + permission + tenant
// ===========================================================================

describe("assignBoardRole", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("creates a role with the supplied title + dates + source defaults to MANUAL", async () => {
    const club = await bootstrapAPClub("BR-ASSIGN");
    const a = await admin(club.id);
    const m = await regularMemberUser(club.id);
    const row = await assignBoardRole(a, {
      clubId: club.id,
      memberId: m.member.id,
      roleTitle: "President",
      termStartDate: YEAR_BOUNDS.yesterday(),
      termEndDate: YEAR_BOUNDS.oneYearFromNow(),
    });
    expect(row.roleTitle).toBe("President");
    expect(row.source).toBe("MANUAL");
    expect(row.status).toBe("UPCOMING"); // default
    expect(row.memberId).toBe(m.member.id);
  });

  it("AGM_ELECTION source is preserved (future AGM module path)", async () => {
    const club = await bootstrapAPClub("BR-AGM");
    const a = await admin(club.id);
    const m = await regularMemberUser(club.id);
    const row = await assignBoardRole(a, {
      clubId: club.id,
      memberId: m.member.id,
      roleTitle: "Director",
      termStartDate: YEAR_BOUNDS.tomorrow(),
      termEndDate: YEAR_BOUNDS.oneYearFromNow(),
      source: "AGM_ELECTION",
      status: "UPCOMING",
    });
    expect(row.source).toBe("AGM_ELECTION");
    expect(row.status).toBe("UPCOMING");
  });

  it("rejects termEnd < termStart with ValidationError", async () => {
    const club = await bootstrapAPClub("BR-VAL-DATES");
    const a = await admin(club.id);
    const m = await regularMemberUser(club.id);
    await expect(
      assignBoardRole(a, {
        clubId: club.id,
        memberId: m.member.id,
        roleTitle: "Director",
        termStartDate: YEAR_BOUNDS.oneYearFromNow(),
        termEndDate: YEAR_BOUNDS.yesterday(),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects empty roleTitle", async () => {
    const club = await bootstrapAPClub("BR-VAL-TITLE");
    const a = await admin(club.id);
    const m = await regularMemberUser(club.id);
    await expect(
      assignBoardRole(a, {
        clubId: club.id,
        memberId: m.member.id,
        roleTitle: "   ",
        termStartDate: YEAR_BOUNDS.yesterday(),
        termEndDate: YEAR_BOUNDS.oneYearFromNow(),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects cross-tenant member id (Member from Club B can't be assigned in Club A)", async () => {
    const clubA = await bootstrapAPClub("BR-TENANT-A");
    const clubB = await bootstrapAPClub("BR-TENANT-B");
    const adminA = await admin(clubA.id);
    const mB = await regularMemberUser(clubB.id);
    await expect(
      assignBoardRole(adminA, {
        clubId: clubA.id,
        memberId: mB.member.id,
        roleTitle: "President",
        termStartDate: YEAR_BOUNDS.yesterday(),
        termEndDate: YEAR_BOUNDS.oneYearFromNow(),
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects callers without packages:write (STAFF role)", async () => {
    const club = await bootstrapAPClub("BR-PERM");
    const other = await bootstrapAPClub("BR-PERM-OTHER");
    const stf = await staff(club.id);
    const m = await regularMemberUser(other.id);
    await expect(
      assignBoardRole(stf, {
        clubId: other.id,
        memberId: m.member.id,
        roleTitle: "Director",
        termStartDate: YEAR_BOUNDS.yesterday(),
        termEndDate: YEAR_BOUNDS.oneYearFromNow(),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("audit log captures the assignment", async () => {
    const club = await bootstrapAPClub("BR-AUDIT");
    const a = await admin(club.id);
    const m = await regularMemberUser(club.id, { firstName: "Helena", lastName: "Chair" });
    const row = await assignBoardRole(a, {
      clubId: club.id,
      memberId: m.member.id,
      roleTitle: "President",
      termStartDate: YEAR_BOUNDS.yesterday(),
      termEndDate: YEAR_BOUNDS.oneYearFromNow(),
    });
    const logs = await db().auditLog.findMany({
      where: { entityId: row.id, action: "governance.board-role.assign" },
    });
    expect(logs).toHaveLength(1);
  });
});

// ===========================================================================
// updateBoardRole + deleteBoardRole
// ===========================================================================

describe("updateBoardRole / deleteBoardRole", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("update can flip status to EXPIRED (manual revoke)", async () => {
    const club = await bootstrapAPClub("BR-EXPIRE");
    const a = await admin(club.id);
    const m = await regularMemberUser(club.id);
    const row = await assignBoardRole(a, {
      clubId: club.id,
      memberId: m.member.id,
      roleTitle: "Director",
      termStartDate: YEAR_BOUNDS.yesterday(),
      termEndDate: YEAR_BOUNDS.oneYearFromNow(),
      status: "ACTIVE",
    });
    const updated = await updateBoardRole(a, row.id, { status: "EXPIRED" });
    expect(updated.status).toBe("EXPIRED");
  });

  it("update rejects termEnd < termStart", async () => {
    const club = await bootstrapAPClub("BR-UPDATE-VAL");
    const a = await admin(club.id);
    const m = await regularMemberUser(club.id);
    const row = await assignBoardRole(a, {
      clubId: club.id,
      memberId: m.member.id,
      roleTitle: "Director",
      termStartDate: YEAR_BOUNDS.yesterday(),
      termEndDate: YEAR_BOUNDS.oneYearFromNow(),
    });
    await expect(
      updateBoardRole(a, row.id, { termEndDate: YEAR_BOUNDS.oneYearAgo() }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("delete removes the row + writes audit log", async () => {
    const club = await bootstrapAPClub("BR-DEL");
    const a = await admin(club.id);
    const m = await regularMemberUser(club.id);
    const row = await assignBoardRole(a, {
      clubId: club.id,
      memberId: m.member.id,
      roleTitle: "Director",
      termStartDate: YEAR_BOUNDS.yesterday(),
      termEndDate: YEAR_BOUNDS.oneYearFromNow(),
    });
    await deleteBoardRole(a, row.id);
    expect(await db().boardRole.findUnique({ where: { id: row.id } })).toBeNull();
    const logs = await db().auditLog.findMany({
      where: { entityId: row.id, action: "governance.board-role.delete" },
    });
    expect(logs).toHaveLength(1);
  });

  it("delete throws NotFoundError for unknown id", async () => {
    const club = await bootstrapAPClub("BR-DEL-404");
    const a = await admin(club.id);
    await expect(deleteBoardRole(a, "no-such-id")).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ===========================================================================
// listBoardRoster — effective status visible per row
// ===========================================================================

describe("listBoardRoster", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("returns rows with computed effective status (date-aware)", async () => {
    const club = await bootstrapAPClub("BR-LIST");
    const a = await admin(club.id);
    const m1 = await regularMemberUser(club.id, { lastName: "Pres" });
    const m2 = await regularMemberUser(club.id, { lastName: "Future" });
    const m3 = await regularMemberUser(club.id, { lastName: "Past" });
    await assignBoardRole(a, {
      clubId: club.id,
      memberId: m1.member.id,
      roleTitle: "President",
      termStartDate: YEAR_BOUNDS.yesterday(),
      termEndDate: YEAR_BOUNDS.oneYearFromNow(),
    });
    await assignBoardRole(a, {
      clubId: club.id,
      memberId: m2.member.id,
      roleTitle: "Director",
      termStartDate: YEAR_BOUNDS.tomorrow(),
      termEndDate: YEAR_BOUNDS.oneYearFromNow(),
    });
    await assignBoardRole(a, {
      clubId: club.id,
      memberId: m3.member.id,
      roleTitle: "Past President",
      termStartDate: new Date(Date.UTC(2023, 0, 1)),
      termEndDate: YEAR_BOUNDS.oneYearAgo(),
    });
    const rows = await listBoardRoster(a, club.id);
    const byTitle = Object.fromEntries(rows.map((r) => [r.roleTitle, r.effectiveStatus]));
    expect(byTitle.President).toBe("ACTIVE");
    expect(byTitle.Director).toBe("UPCOMING");
    expect(byTitle["Past President"]).toBe("EXPIRED");
  });

  it("rejects callers without packages:read", async () => {
    const club = await bootstrapAPClub("BR-LIST-PERM");
    const other = await bootstrapAPClub("BR-LIST-PERM-OTHER");
    const stf = await staff(club.id);
    await expect(listBoardRoster(stf, other.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ===========================================================================
// isActiveBoardMember — date-aware access predicate
// ===========================================================================

describe("isActiveBoardMember", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("true when user has an ACTIVE BoardRole today", async () => {
    const club = await bootstrapAPClub("IAB-ACTIVE");
    const a = await admin(club.id);
    const m = await regularMemberUser(club.id);
    await assignBoardRole(a, {
      clubId: club.id,
      memberId: m.member.id,
      roleTitle: "Director",
      termStartDate: YEAR_BOUNDS.yesterday(),
      termEndDate: YEAR_BOUNDS.oneYearFromNow(),
      status: "ACTIVE",
    });
    expect(await isActiveBoardMember(m.principal, club.id)).toBe(true);
  });

  it("false when role is UPCOMING (term hasn't started)", async () => {
    const club = await bootstrapAPClub("IAB-UPCOMING");
    const a = await admin(club.id);
    const m = await regularMemberUser(club.id);
    await assignBoardRole(a, {
      clubId: club.id,
      memberId: m.member.id,
      roleTitle: "Director",
      termStartDate: YEAR_BOUNDS.tomorrow(),
      termEndDate: YEAR_BOUNDS.oneYearFromNow(),
    });
    expect(await isActiveBoardMember(m.principal, club.id)).toBe(false);
  });

  it("false when role is EXPIRED (term ended)", async () => {
    const club = await bootstrapAPClub("IAB-EXPIRED");
    const a = await admin(club.id);
    const m = await regularMemberUser(club.id);
    await assignBoardRole(a, {
      clubId: club.id,
      memberId: m.member.id,
      roleTitle: "Director",
      termStartDate: new Date(Date.UTC(2023, 0, 1)),
      termEndDate: YEAR_BOUNDS.oneYearAgo(),
    });
    expect(await isActiveBoardMember(m.principal, club.id)).toBe(false);
  });

  it("false when role was manually revoked (stored EXPIRED, term still covers today)", async () => {
    const club = await bootstrapAPClub("IAB-REVOKED");
    const a = await admin(club.id);
    const m = await regularMemberUser(club.id);
    await assignBoardRole(a, {
      clubId: club.id,
      memberId: m.member.id,
      roleTitle: "Director",
      termStartDate: YEAR_BOUNDS.yesterday(),
      termEndDate: YEAR_BOUNDS.oneYearFromNow(),
      status: "EXPIRED",
    });
    expect(await isActiveBoardMember(m.principal, club.id)).toBe(false);
  });

  it("false when user has no member link (admin-only user)", async () => {
    const club = await bootstrapAPClub("IAB-NO-MEMBER");
    const a = await admin(club.id);
    expect(await isActiveBoardMember(a, club.id)).toBe(false);
  });

  it("false across tenants — member with active role in Club A is not on board in Club B", async () => {
    const clubA = await bootstrapAPClub("IAB-TENANT-A");
    const clubB = await bootstrapAPClub("IAB-TENANT-B");
    const adminA = await admin(clubA.id);
    const m = await regularMemberUser(clubA.id);
    await assignBoardRole(adminA, {
      clubId: clubA.id,
      memberId: m.member.id,
      roleTitle: "Director",
      termStartDate: YEAR_BOUNDS.yesterday(),
      termEndDate: YEAR_BOUNDS.oneYearFromNow(),
    });
    expect(await isActiveBoardMember(m.principal, clubA.id)).toBe(true);
    expect(await isActiveBoardMember(m.principal, clubB.id)).toBe(false);
  });
});

// ===========================================================================
// Integration — board access grants Monthly Package tile + board view
// ===========================================================================

describe("Board-role access integration with Monthly Reporting Package", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("Member with ACTIVE BoardRole sees the most-recent PUBLISHED package (no recipient row required)", async () => {
    const club = await bootstrapAPClub("BR-TILE");
    const a = await admin(club.id);
    const m = await regularMemberUser(club.id);
    // Grant active board role.
    await assignBoardRole(a, {
      clubId: club.id,
      memberId: m.member.id,
      roleTitle: "Director",
      termStartDate: YEAR_BOUNDS.yesterday(),
      termEndDate: YEAR_BOUNDS.oneYearFromNow(),
    });
    // Publish a package.
    const { package: draft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    const pub = await publishMonthlyPackage(a, draft.id);

    // Member who is NOT in the recipient table for this specific
    // package still sees the tile via their active board role.
    await db().monthlyPackageRecipient.deleteMany({
      where: { monthlyPackageId: pub.publishedPackageId, recipientUserId: m.user.id },
    });

    const tile = await getMostRecentBoardPackageForUser(m.principal, club.id);
    expect(tile).not.toBeNull();
    expect(tile!.id).toBe(pub.publishedPackageId);
  });

  it("Member WITHOUT any BoardRole and not a recipient sees nothing", async () => {
    const club = await bootstrapAPClub("BR-TILE-NONE");
    const a = await admin(club.id);
    const m = await regularMemberUser(club.id);
    const { package: draft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    const pub = await publishMonthlyPackage(a, draft.id);
    await db().monthlyPackageRecipient.deleteMany({
      where: { monthlyPackageId: pub.publishedPackageId, recipientUserId: m.user.id },
    });
    expect(await getMostRecentBoardPackageForUser(m.principal, club.id)).toBeNull();
  });

  it("Member with EXPIRED role sees nothing (auto-revoked after term end)", async () => {
    const club = await bootstrapAPClub("BR-TILE-EXPIRED");
    const a = await admin(club.id);
    const m = await regularMemberUser(club.id);
    await assignBoardRole(a, {
      clubId: club.id,
      memberId: m.member.id,
      roleTitle: "Past President",
      termStartDate: new Date(Date.UTC(2023, 0, 1)),
      termEndDate: YEAR_BOUNDS.oneYearAgo(),
    });
    const { package: draft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    const pub = await publishMonthlyPackage(a, draft.id);
    await db().monthlyPackageRecipient.deleteMany({
      where: { monthlyPackageId: pub.publishedPackageId, recipientUserId: m.user.id },
    });
    expect(await getMostRecentBoardPackageForUser(m.principal, club.id)).toBeNull();
  });

  it("Member with ACTIVE BoardRole can open the read-only board view directly", async () => {
    const club = await bootstrapAPClub("BR-VIEW");
    const a = await admin(club.id);
    const m = await regularMemberUser(club.id);
    await assignBoardRole(a, {
      clubId: club.id,
      memberId: m.member.id,
      roleTitle: "Treasurer",
      termStartDate: YEAR_BOUNDS.yesterday(),
      termEndDate: YEAR_BOUNDS.oneYearFromNow(),
    });
    const { package: draft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    const pub = await publishMonthlyPackage(a, draft.id);
    await db().monthlyPackageRecipient.deleteMany({
      where: { monthlyPackageId: pub.publishedPackageId, recipientUserId: m.user.id },
    });
    const view = await getBoardPackageView(m.principal, pub.publishedPackageId);
    expect(view).not.toBeNull();
    expect(view!.id).toBe(pub.publishedPackageId);
  });
});

// ===========================================================================
// Page-shape contract
// ===========================================================================

describe("Board & Committees admin page — shape", () => {
  const PAGE = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "src/app/app/admin/governance/board-committees/page.tsx",
    ),
    "utf8",
  );
  const HUB = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/governance/page.tsx"),
    "utf8",
  );
  const SIDEBAR = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/sidebar-nav-data.ts"),
    "utf8",
  );

  it("page is gated on packages:read", () => {
    expect(PAGE).toMatch(/hasPermission\(principal, clubId, "packages:read"\)/);
  });

  it("renders founder-named title + roster table headers", () => {
    expect(PAGE).toMatch(/Board &amp; Committees/);
    for (const h of ["Member", "Role", "Committee", "Term", "Status", "Source", "Action"]) {
      expect(PAGE).toContain(`>${h}<`);
    }
  });

  it("Governance hub tile + sidebar link both target the new module", () => {
    expect(HUB).toMatch(/\/app\/admin\/governance\/board-committees/);
    expect(HUB).toMatch(/Board & Committees/);
    expect(SIDEBAR).toMatch(/\/app\/admin\/governance\/board-committees/);
    expect(SIDEBAR).toMatch(/label: "Board & Committees"/);
  });

  it("canonical role titles include every founder-specified entry", () => {
    for (const t of [
      "President",
      "Vice President",
      "Treasurer",
      "Secretary",
      "Director",
      "Past President",
      "Finance Committee Chair",
    ]) {
      expect(BOARD_ROLE_TITLES).toContain(t);
    }
  });
});
