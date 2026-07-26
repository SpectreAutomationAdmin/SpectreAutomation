// Monthly Package — refined publish + NEW-badge behavior.
//
// Covers the founder's spec for this slice:
//
//   1. publishMonthlyPackage now ALSO populates recipients from the
//      BOARD_READ_ONLY roster on every publish (the single action
//      that replaced "Publish + Send to Board"). Wipe + recreate
//      semantics — a re-publish refreshes the NEW badge for every
//      board member.
//   2. markPackageViewedByUser sets `viewedAt` on the current user's
//      recipient row + flips deliveryStatus to OPENED.
//   3. getMostRecentBoardPackageForUser now returns `isNewForUser`
//      computed from the recipient's `viewedAt`.
//   4. NEW badge is per-user — one board member viewing the package
//      does NOT clear the badge for any other board member.
//   5. Page-shape contract: the white PublishBar is gone, the new
//      PublishHeaderButton portals into the dark green header, the
//      report page renders no second header band, the tile renders
//      a NEW badge when `isNewForUser`, the board view marks-viewed
//      on render.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  generateDraftMonthlyPackage,
  getMostRecentBoardPackageForUser,
  markPackageViewedByUser,
  publishMonthlyPackage,
} from "@/lib/reporting/monthly-package-lifecycle";

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
// 1. publishMonthlyPackage populates recipients in one action
// ===========================================================================

describe("publishMonthlyPackage — single action populates BOARD_READ_ONLY recipients", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("creates a recipient row for every BOARD_READ_ONLY user at the club", async () => {
    const club = await bootstrapAPClub("PB-RECIP");
    const a = await admin(club.id);
    await boardUser(club.id, "Alice");
    await boardUser(club.id, "Boris");
    await boardUser(club.id, "Cora");

    const { package: draft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    const result = await publishMonthlyPackage(a, draft.id);
    expect(result.recipientCount).toBe(3);

    const recipients = await db().monthlyPackageRecipient.findMany({
      where: { monthlyPackageId: draft.id },
      select: { recipientUserId: true, recipientRole: true, deliveryStatus: true, viewedAt: true },
    });
    expect(recipients).toHaveLength(3);
    for (const r of recipients) {
      expect(r.recipientUserId).not.toBeNull(); // all three are real users
      expect(r.recipientRole).toBe("Board Member");
      expect(r.deliveryStatus).toBe("PENDING");
      expect(r.viewedAt).toBeNull();
    }
  });

  it("re-publish replaces the recipient set + resets viewedAt for all (fresh NEW for everyone)", async () => {
    const club = await bootstrapAPClub("PB-RECIP-RESET");
    const a = await admin(club.id);
    const alice = await boardUser(club.id, "Alice");
    await boardUser(club.id, "Boris");

    const { package: draft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    await publishMonthlyPackage(a, draft.id);

    // Alice opens it.
    await markPackageViewedByUser(alice, draft.id);
    const aliceFirst = await db().monthlyPackageRecipient.findFirst({
      where: { monthlyPackageId: draft.id, recipientUserId: alice.id },
    });
    expect(aliceFirst!.viewedAt).not.toBeNull();

    // Re-publish (e.g. operator updated upstream data and clicked
    // Publish again). Every board member gets a fresh row, viewedAt
    // unset — including Alice.
    //
    // To re-publish we have to roll the row back to DRAFT first.
    await db().monthlyPackage.update({
      where: { id: draft.id },
      data: {
        status: "DRAFT",
        publishedAt: null,
        publishedByUserId: null,
        atAGlanceKpisJson: null,
        executiveOpeningSnapshotJson: null,
        packagePayloadJson: null,
      },
    });
    await publishMonthlyPackage(a, draft.id);

    const aliceSecond = await db().monthlyPackageRecipient.findFirst({
      where: { monthlyPackageId: draft.id, recipientUserId: alice.id },
    });
    expect(aliceSecond!.viewedAt).toBeNull(); // reset
    expect(
      await db().monthlyPackageRecipient.count({ where: { monthlyPackageId: draft.id } }),
    ).toBe(2);
  });

  it("club with zero board members → publish succeeds, recipientCount = 0", async () => {
    const club = await bootstrapAPClub("PB-RECIP-EMPTY");
    const a = await admin(club.id);
    const { package: draft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    const result = await publishMonthlyPackage(a, draft.id);
    expect(result.recipientCount).toBe(0);
    expect(
      await db().monthlyPackage.findUnique({ where: { id: draft.id } }),
    ).toMatchObject({ status: "PUBLISHED" });
  });
});

// ===========================================================================
// 2. markPackageViewedByUser sets viewedAt + OPENED
// ===========================================================================

describe("markPackageViewedByUser — per-user first-view tracking", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("sets viewedAt + flips deliveryStatus to OPENED on first view", async () => {
    const club = await bootstrapAPClub("PB-VIEW-FIRST");
    const a = await admin(club.id);
    const board = await boardUser(club.id);
    const { package: draft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    await publishMonthlyPackage(a, draft.id);

    const before = await db().monthlyPackageRecipient.findFirst({
      where: { monthlyPackageId: draft.id, recipientUserId: board.id },
    });
    expect(before!.viewedAt).toBeNull();
    expect(before!.deliveryStatus).toBe("PENDING");

    const r = await markPackageViewedByUser(board, draft.id);
    expect(r.updated).toBe(1);

    const after = await db().monthlyPackageRecipient.findFirst({
      where: { monthlyPackageId: draft.id, recipientUserId: board.id },
    });
    expect(after!.viewedAt).not.toBeNull();
    expect(after!.deliveryStatus).toBe("OPENED");
  });

  it("subsequent views are no-ops (does not overwrite first-view timestamp)", async () => {
    const club = await bootstrapAPClub("PB-VIEW-NOOP");
    const a = await admin(club.id);
    const board = await boardUser(club.id);
    const { package: draft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    await publishMonthlyPackage(a, draft.id);
    await markPackageViewedByUser(board, draft.id);
    const firstView = (
      await db().monthlyPackageRecipient.findFirst({
        where: { monthlyPackageId: draft.id, recipientUserId: board.id },
      })
    )!.viewedAt!;
    // Second call must not change viewedAt.
    const r = await markPackageViewedByUser(board, draft.id);
    expect(r.updated).toBe(0);
    const second = (
      await db().monthlyPackageRecipient.findFirst({
        where: { monthlyPackageId: draft.id, recipientUserId: board.id },
      })
    )!.viewedAt!;
    expect(second.getTime()).toBe(firstView.getTime());
  });

  it("only affects the calling user's recipient row (not other board members)", async () => {
    const club = await bootstrapAPClub("PB-VIEW-PER-USER");
    const a = await admin(club.id);
    const alice = await boardUser(club.id, "Alice");
    const boris = await boardUser(club.id, "Boris");
    const { package: draft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    await publishMonthlyPackage(a, draft.id);

    await markPackageViewedByUser(alice, draft.id);

    const aliceRow = await db().monthlyPackageRecipient.findFirst({
      where: { monthlyPackageId: draft.id, recipientUserId: alice.id },
    });
    const borisRow = await db().monthlyPackageRecipient.findFirst({
      where: { monthlyPackageId: draft.id, recipientUserId: boris.id },
    });
    expect(aliceRow!.viewedAt).not.toBeNull();
    expect(borisRow!.viewedAt).toBeNull(); // Boris's row untouched
    expect(borisRow!.deliveryStatus).toBe("PENDING");
  });

  it("no-op for users WITHOUT a recipient row (e.g. admins reaching the page via board-perm)", async () => {
    const club = await bootstrapAPClub("PB-VIEW-NORECIP");
    const a = await admin(club.id);
    const { package: draft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    // No board members at this club → no recipient rows.
    await publishMonthlyPackage(a, draft.id);
    // Admin has reports:board, can view, but isn't a recipient.
    const r = await markPackageViewedByUser(a, draft.id);
    expect(r.updated).toBe(0);
  });
});

// ===========================================================================
// 3. isNewForUser flag on the tile
// ===========================================================================

describe("getMostRecentBoardPackageForUser — isNewForUser per user", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("isNewForUser=true when the user has an unviewed recipient row", async () => {
    const club = await bootstrapAPClub("PB-NEW-TRUE");
    const a = await admin(club.id);
    const board = await boardUser(club.id);
    const { package: draft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    await publishMonthlyPackage(a, draft.id);

    const tile = await getMostRecentBoardPackageForUser(board, club.id);
    expect(tile).not.toBeNull();
    expect(tile!.isNewForUser).toBe(true);
  });

  it("isNewForUser=false after THIS user opens the package", async () => {
    const club = await bootstrapAPClub("PB-NEW-FALSE-AFTER-VIEW");
    const a = await admin(club.id);
    const board = await boardUser(club.id);
    const { package: draft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    await publishMonthlyPackage(a, draft.id);
    await markPackageViewedByUser(board, draft.id);

    const tile = await getMostRecentBoardPackageForUser(board, club.id);
    expect(tile!.isNewForUser).toBe(false);
  });

  it("per-user: Alice opens it → Boris still sees NEW", async () => {
    const club = await bootstrapAPClub("PB-NEW-PER-USER");
    const a = await admin(club.id);
    const alice = await boardUser(club.id, "Alice");
    const boris = await boardUser(club.id, "Boris");
    const { package: draft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    await publishMonthlyPackage(a, draft.id);
    await markPackageViewedByUser(alice, draft.id);

    const aliceTile = await getMostRecentBoardPackageForUser(alice, club.id);
    const borisTile = await getMostRecentBoardPackageForUser(boris, club.id);
    expect(aliceTile!.isNewForUser).toBe(false);
    expect(borisTile!.isNewForUser).toBe(true);
  });

  it("isNewForUser=false for board-perm users without a recipient row (admins)", async () => {
    const club = await bootstrapAPClub("PB-NEW-NORECIP-ADMIN");
    const a = await admin(club.id);
    const { package: draft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    await publishMonthlyPackage(a, draft.id);
    // Admin has board-perm → tile renders. But no recipient row →
    // not a "notified" board member → no NEW badge.
    const tile = await getMostRecentBoardPackageForUser(a, club.id);
    expect(tile).not.toBeNull();
    expect(tile!.isNewForUser).toBe(false);
  });
});

// ===========================================================================
// 4. Page-shape contract
// ===========================================================================

describe("Refined publish UI — page-shape contract", () => {
  const REPORT_PAGE = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/reporting/monthly/page.tsx"),
    "utf8",
  );
  const HEADER_BUTTON = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "src/app/app/admin/reporting/monthly/PublishHeaderButton.tsx",
    ),
    "utf8",
  );
  const SHELL = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/reporting/ReportingShell.tsx"),
    "utf8",
  );
  const TILE = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/dashboard/BoardPackageTile.tsx"),
    "utf8",
  );
  const VIEW_PAGE = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "src/app/app/reports/monthly-package/[id]/page.tsx",
    ),
    "utf8",
  );

  it("the legacy white PublishBar is GONE (no import, no usage)", () => {
    expect(REPORT_PAGE).not.toMatch(/import.*PublishBar/);
    expect(REPORT_PAGE).not.toMatch(/<PublishBar\b/);
    expect(REPORT_PAGE).not.toMatch(/from "\.\/PublishBar"/);
    // And the file itself was deleted.
    expect(
      fs.existsSync(
        path.resolve(
          process.cwd(),
          "src/app/app/admin/reporting/monthly/PublishBar.tsx",
        ),
      ),
    ).toBe(false);
  });

  it("the report page renders a SINGLE publish action (PublishHeaderButton)", () => {
    expect(REPORT_PAGE).toMatch(/import \{ PublishHeaderButton \} from "\.\/PublishHeaderButton"/);
    expect(REPORT_PAGE).toMatch(/<PublishHeaderButton\b/);
    // No second Send button on the report — check imports and JSX
    // usage, not free-form comment text.
    expect(REPORT_PAGE).not.toMatch(/import\s+\{[^}]*sendMonthlyPackageAction/);
    expect(REPORT_PAGE).not.toMatch(/<PublishBar\b/);
    expect(REPORT_PAGE).not.toMatch(/onClick=\{[^}]*handleSend/);
  });

  it("ReportingShell exposes a stable portal-target slot for the header action", () => {
    expect(SHELL).toMatch(/id="reporting-shell-header-action-slot"/);
    expect(SHELL).toMatch(/data-testid="reporting-shell-header-action-slot"/);
  });

  it("PublishHeaderButton portals into the slot + branches on status", () => {
    expect(HEADER_BUTTON).toMatch(/createPortal\(/);
    expect(HEADER_BUTTON).toMatch(/reporting-shell-header-action-slot/);
    // 2026-06-28: under the Live-pointer model the button renders
    // status-branched UI:
    //   • DRAFT → "Publish" action
    //   • PUBLISHED + matching hash → "Published" info pill
    //   • PUBLISHED + drift → "Overwrite Package" action + dialog
    //   • ARCHIVED → "Overwrite Package" action + dialog
    // "Update Publication" (the prior label) is gone.
    expect(HEADER_BUTTON).toMatch(/status === "DRAFT"/);
    expect(HEADER_BUTTON).toMatch(/status === "ARCHIVED"/);
    expect(HEADER_BUTTON).toMatch(/data-testid="reporting-header-publish-btn"/);
    expect(HEADER_BUTTON).toContain("Publishing…");
    expect(HEADER_BUTTON).toContain("Publish");
    expect(HEADER_BUTTON).toContain("Overwrite Package");
    expect(HEADER_BUTTON).not.toContain("Update Publication");
    // No second action label like "Send" — Send is a separate
    // workflow. Check JSX (not comment text).
    const jsxLines = HEADER_BUTTON
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(jsxLines).not.toMatch(/Send to Board/i);
    expect(jsxLines).not.toMatch(/Publish and send/i);
  });

  it("tile renders the NEW badge when isNewForUser", () => {
    expect(TILE).toMatch(/data-testid="board-package-tile-new-badge"/);
    expect(TILE).toMatch(/\{pkg\.isNewForUser && \(/);
    // Badge label is the literal "New" between the open and close
    // tags. Whitespace-tolerant.
    expect(TILE).toMatch(/>\s*New\s*</);
  });

  it("board view page marks the package as viewed for the current user", () => {
    expect(VIEW_PAGE).toMatch(/markPackageViewedByUser/);
    expect(VIEW_PAGE).toMatch(/await markPackageViewedByUser\(principal, pkg\.id\)/);
  });
});
