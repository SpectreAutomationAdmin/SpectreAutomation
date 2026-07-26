// Board Package Dashboard tile — visibility + content tests.
//
// Covers the founder's acceptance criteria:
//
//   1. Board users (BOARD_READ_ONLY) see the most recent
//      PUBLISHED/SENT package for their club.
//   2. Admins (CLUB_ADMIN) see the most recent PUBLISHED/SENT
//      package — they have reports:board too.
//   3. Regular members (MEMBER role) WITHOUT a recipient row see
//      NOTHING (null returned, tile not rendered).
//   4. Regular members WITH a recipient row see ONLY the package
//      they're a recipient of — not the most-recent club-wide one.
//   5. KPIs returned by the service exactly match the snapshot
//      stored at publish time (immutability).
//   6. Tenant isolation — Club A's board user doesn't see Club B's
//      packages.
//   7. DRAFT packages are NEVER returned (only PUBLISHED + SENT).
//   8. Returns null when no PUBLISHED/SENT package exists.
//   9. Reverse-chronological — newest period wins when multiple
//      exist.
//  10. Page-shape: the tile component renders the founder-named
//      elements (title / period / KPIs / See more link).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  generateDraftMonthlyPackage,
  getMostRecentBoardPackageForUser,
  publishMonthlyPackage,
  sendMonthlyPackage,
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

async function boardUser(clubId: string) {
  const email = `board-${Math.random().toString(36).slice(2, 10)}@example.com`;
  await makeUser({ email, role: "BOARD_READ_ONLY", clubId });
  return principalFor(email);
}

async function regularMember(clubId: string) {
  const email = `member-${Math.random().toString(36).slice(2, 10)}@example.com`;
  await makeUser({ email, role: "MEMBER", clubId });
  return principalFor(email);
}

async function seedPublishedPackage(
  generator: Awaited<ReturnType<typeof admin>>,
  clubId: string,
  year: number,
  month: number,
  kpis: Array<{ key: string; label: string; value: number | string }> = [],
) {
  const { package: draft } = await generateDraftMonthlyPackage(generator, clubId, {
    reportingYear: year,
    reportingMonth: month,
  });
  // For test isolation we don't trust `publishMonthlyPackage` to
  // capture deterministic KPIs (it builds the live report). We
  // overwrite the snapshot fields with the test's exact KPI list
  // so assertions remain stable.
  await publishMonthlyPackage(generator, draft.id);
  await db().monthlyPackage.update({
    where: { id: draft.id },
    data: { atAGlanceKpisJson: JSON.stringify(kpis) },
  });
  return draft.id;
}

// ===========================================================================
// Visibility matrix
// ===========================================================================

describe("getMostRecentBoardPackageForUser — visibility matrix", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("BOARD_READ_ONLY user sees the most recent PUBLISHED/SENT package", async () => {
    const club = await bootstrapAPClub("BPT-BOARD");
    const a = await admin(club.id);
    const b = await boardUser(club.id);
    await seedPublishedPackage(a, club.id, 2026, 5);

    const tile = await getMostRecentBoardPackageForUser(b, club.id);
    expect(tile).not.toBeNull();
    expect(tile!.reportingMonth).toBe(5);
    expect(tile!.periodKey).toBe("2026-05");
    expect(tile!.periodLabel).toBe("May 2026");
  });

  it("CLUB_ADMIN sees the most recent package (has reports:board too)", async () => {
    const club = await bootstrapAPClub("BPT-ADMIN");
    const a = await admin(club.id);
    await seedPublishedPackage(a, club.id, 2026, 6);

    const tile = await getMostRecentBoardPackageForUser(a, club.id);
    expect(tile).not.toBeNull();
    expect(tile!.reportingMonth).toBe(6);
  });

  it("MEMBER WITHOUT recipient link sees NOTHING (null returned)", async () => {
    const club = await bootstrapAPClub("BPT-MEMBER-NONE");
    const a = await admin(club.id);
    const m = await regularMember(club.id);
    await seedPublishedPackage(a, club.id, 2026, 5);

    const tile = await getMostRecentBoardPackageForUser(m, club.id);
    expect(tile).toBeNull();
  });

  it("MEMBER WITH recipient link sees ONLY their recipient package", async () => {
    const club = await bootstrapAPClub("BPT-MEMBER-RECIP");
    const a = await admin(club.id);
    const m = await regularMember(club.id);

    // Club has two SENT packages: April + May.
    const aprId = await seedPublishedPackage(a, club.id, 2026, 4);
    const mayId = await seedPublishedPackage(a, club.id, 2026, 5);
    // Member is a recipient ONLY on April. They should see April,
    // NOT May (even though May is more recent club-wide).
    await db().monthlyPackageRecipient.create({
      data: {
        monthlyPackageId: aprId,
        recipientUserId: m.id,
        recipientEmail: "member@example.com",
        recipientRole: "Honorary Member",
      },
    });
    // Mark both as SENT so the recipient lookup is meaningful.
    await db().monthlyPackage.updateMany({
      where: { id: { in: [aprId, mayId] } },
      data: { status: "SENT", sentAt: new Date() },
    });

    const tile = await getMostRecentBoardPackageForUser(m, club.id);
    expect(tile).not.toBeNull();
    expect(tile!.id).toBe(aprId);
    expect(tile!.reportingMonth).toBe(4);
  });

  it("returns null when no PUBLISHED/SENT package exists (only DRAFT)", async () => {
    const club = await bootstrapAPClub("BPT-DRAFT-ONLY");
    const a = await admin(club.id);
    await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    expect(await getMostRecentBoardPackageForUser(a, club.id)).toBeNull();
    expect(await getMostRecentBoardPackageForUser(await boardUser(club.id), club.id)).toBeNull();
  });

  it("DRAFT packages are NEVER returned even when they're the most recent row", async () => {
    const club = await bootstrapAPClub("BPT-DRAFT-NEWER");
    const a = await admin(club.id);
    // April is PUBLISHED.
    await seedPublishedPackage(a, club.id, 2026, 4);
    // May is just a DRAFT.
    await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });

    const tile = await getMostRecentBoardPackageForUser(a, club.id);
    expect(tile).not.toBeNull();
    expect(tile!.reportingMonth).toBe(4); // April PUBLISHED, not May DRAFT
  });

  it("the tile points at the NEWEST-period PUBLISHED row (historical re-publishes never regress the Live pointer)", async () => {
    // Founder's Live Pointer rule (2026-06-28): the Live Package =
    // the newest reporting period that is PUBLISHED. Publishing an
    // older period (3 or 4) when a newer one (5) is already Live
    // does NOT regress the Live pointer — the older row stays
    // ARCHIVED and the Board tile continues to resolve to the
    // newest PUBLISHED period.
    const club = await bootstrapAPClub("BPT-ORDER");
    const a = await admin(club.id);
    // March is published first → becomes Live (no prior Live).
    await seedPublishedPackage(a, club.id, 2026, 3);
    // May is published next → ADVANCE_LIVE; March → ARCHIVED.
    await seedPublishedPackage(a, club.id, 2026, 5);
    // April is published last → OVERWRITE_HISTORICAL (4 < 5);
    // April stays ARCHIVED; May remains Live.
    await seedPublishedPackage(a, club.id, 2026, 4);

    const tile = await getMostRecentBoardPackageForUser(a, club.id);
    // Newest PUBLISHED period (5) wins — NOT the last-published (4).
    expect(tile!.reportingMonth).toBe(5);
  });

  it("tenant isolation — Club A board user never sees Club B's packages", async () => {
    const clubA = await bootstrapAPClub("BPT-TENANT-A");
    const clubB = await bootstrapAPClub("BPT-TENANT-B");
    const adminA = await admin(clubA.id);
    const adminB = await admin(clubB.id);
    const boardA = await boardUser(clubA.id);
    await seedPublishedPackage(adminB, clubB.id, 2026, 5);
    // Club A has no packages.
    const tile = await getMostRecentBoardPackageForUser(boardA, clubA.id);
    expect(tile).toBeNull();
    // And Club B's admin doesn't see Club A's nothing.
    expect(await getMostRecentBoardPackageForUser(adminB, clubA.id)).toBeNull();
  });
});

// ===========================================================================
// KPI snapshot fidelity (the founder's headline acceptance)
// ===========================================================================

describe("getMostRecentBoardPackageForUser — KPI snapshot", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("returns the SNAPSHOT atAGlanceKpis exactly as stored (not a re-computation)", async () => {
    const club = await bootstrapAPClub("BPT-KPIS-EXACT");
    const a = await admin(club.id);
    const kpis = [
      { key: "ytd-revenue", label: "YTD Revenue", value: 1_823_000 },
      { key: "noi", label: "YTD NOI", value: 412_500 },
      { key: "capital-income", label: "Capital Income", value: 150_000 },
      { key: "reserve-coverage", label: "Reserve Coverage", value: "9.6 mo" },
    ];
    await seedPublishedPackage(a, club.id, 2026, 5, kpis);

    const tile = await getMostRecentBoardPackageForUser(a, club.id);
    expect(tile!.atAGlanceKpis).toEqual(kpis);
  });

  it("returns [] when the snapshot is missing or malformed (does not crash)", async () => {
    const club = await bootstrapAPClub("BPT-KPIS-EMPTY");
    const a = await admin(club.id);
    const { package: draft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    await db().monthlyPackage.update({
      where: { id: draft.id },
      data: {
        status: "PUBLISHED",
        publishedAt: new Date(),
        publishedByUserId: a.id,
        atAGlanceKpisJson: "not-valid-json",
      },
    });

    const tile = await getMostRecentBoardPackageForUser(a, club.id);
    expect(tile).not.toBeNull();
    expect(tile!.atAGlanceKpis).toEqual([]);
  });
});

// ===========================================================================
// Tile component shape
// ===========================================================================

describe("BoardPackageTile — rendered shape", () => {
  const TILE = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/dashboard/BoardPackageTile.tsx"),
    "utf8",
  );
  const ADMIN_PAGE = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/page.tsx"),
    "utf8",
  );
  const MEMBER_PAGE = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/member/page.tsx"),
    "utf8",
  );

  it("tile renders the founder-named title 'Monthly Reporting Package'", () => {
    // Whitespace-tolerant: the title lives inside an <h2> with the
    // founder-named copy. The surrounding markup changed when the
    // NEW badge was added beside it.
    expect(TILE).toMatch(/<h2[\s\S]+?>\s*Monthly Reporting Package\s*<\/h2>/);
  });

  it("tile renders the period label", () => {
    expect(TILE).toMatch(/data-testid="board-package-tile-period"/);
  });

  it("tile does NOT render a Published / status pill (per founder spec)", () => {
    // 2026-06-28: the Published status pill was removed from the
    // widget. If the tile renders on a board member's dashboard,
    // it's understood to be the current live package — no second
    // status indicator. Only the NEW badge remains.
    expect(TILE).not.toMatch(/data-testid="board-package-tile-status"/);
    expect(TILE).not.toMatch(/statusPillClass/);
    // No standalone "Published" / "Sent" status text rendered.
    expect(TILE).not.toMatch(/>\s*PUBLISHED\s*</);
    expect(TILE).not.toMatch(/>\s*SENT\s*</);
  });

  it("tile reuses the shared AtAGlanceBlock (no bespoke KPI grid)", () => {
    // The widget MUST render via the shared component so the
    // cover + widget stay visually identical. Asserting the
    // import + JSX usage.
    expect(TILE).toMatch(
      /import\s+\{[\s\S]*AtAGlanceBlock[\s\S]*\}\s+from\s+"@\/components\/reporting\/AtAGlanceBlock"/,
    );
    expect(TILE).toMatch(/<AtAGlanceBlock\b/);
    // Empty-state copy still present.
    expect(TILE).toMatch(/data-testid="board-package-tile-kpis-empty"/);
  });

  it("tile exposes a 'See more' link pointing at the read-only board view", () => {
    expect(TILE).toMatch(/data-testid="board-package-tile-see-more"/);
    expect(TILE).toMatch(/See more/);
    // 2026-06-26: tile now routes to /app/reports/monthly-package/[id]
    // (the read-only board surface) instead of the admin route, so
    // regular members who are recipients can follow the link without
    // needing admin access.
    expect(TILE).toMatch(/\/app\/reports\/monthly-package\/\$\{pkg\.id\}/);
    // And explicitly NOT the admin route — regression guard.
    expect(TILE).not.toMatch(/\/app\/admin\/reporting\/monthly\?period=/);
  });

  it("admin dashboard does NOT mount the Monthly Reporting Package widget (founder spec 2026-06-30)", () => {
    // Design principle the founder named:
    //   "The Administration dashboard is an operational workspace.
    //    The Board dashboard is a governance workspace.
    //    The Monthly Reporting Package widget belongs exclusively
    //    in the governance workspace."
    // Strip single-line comments before assertion so a documentation
    // mention doesn't false-positive this guard.
    const codeOnly = ADMIN_PAGE
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(codeOnly).not.toMatch(/<BoardPackageTile/);
    expect(codeOnly).not.toMatch(/import.*BoardPackageTile/);
    expect(codeOnly).not.toMatch(/getMostRecentBoardPackageForUser/);
  });

  it("member portal mounts the tile gated on getMostRecentBoardPackageForUser (single governance surface)", () => {
    expect(MEMBER_PAGE).toMatch(/getMostRecentBoardPackageForUser\(principal, member\.clubId\)/);
    expect(MEMBER_PAGE).toMatch(/\{boardPackage && \(/);
    expect(MEMBER_PAGE).toMatch(/<BoardPackageTile pkg=\{boardPackage\} \/>/);
  });
});
