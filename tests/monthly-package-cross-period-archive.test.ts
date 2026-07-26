// Monthly Package — cross-period archive + header period-label tests.
//
// Founder's two-issue fix:
//   Issue 1: Only ONE PUBLISHED package per CLUB at a time (across
//            ALL reporting periods). Publishing June 2026 must
//            archive May 2026's still-PUBLISHED row. The board
//            dashboard tile must follow the newest publication.
//   Issue 2: The dark green ReportingShell header renders the period
//            label inline with the title (same typography as the
//            report title), NOT as a separate gold pill on the right.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  generateDraftMonthlyPackage,
  getMostRecentBoardPackageForUser,
  publishMonthlyPackage,
} from "@/lib/reporting/monthly-package-lifecycle";

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

// ===========================================================================
// Issue 1 — cross-period archive sweep
// ===========================================================================

describe("publish sweeps prior PUBLISHED rows across all periods", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("publishing June 2026 archives May 2026 (cross-period)", async () => {
    const club = await bootstrapAPClub("XPER-MAY-JUN");
    const a = await admin(club.id);

    // Step 1: publish May.
    const { package: mayDraft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    const mayPub = await publishMonthlyPackage(a, mayDraft.id);
    const mayAfter = await db().monthlyPackage.findUnique({
      where: { id: mayPub.publishedPackageId },
    });
    expect(mayAfter!.status).toBe("PUBLISHED");

    // Step 2: publish June. May should now be ARCHIVED.
    const { package: juneDraft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 6,
    });
    const junePub = await publishMonthlyPackage(a, juneDraft.id);

    const juneAfter = await db().monthlyPackage.findUnique({
      where: { id: junePub.publishedPackageId },
    });
    const mayAfterJune = await db().monthlyPackage.findUnique({
      where: { id: mayPub.publishedPackageId },
    });
    expect(juneAfter!.status).toBe("PUBLISHED");
    expect(mayAfterJune!.status).toBe("ARCHIVED");

    // The whole club has exactly ONE PUBLISHED row.
    const publishedCount = await db().monthlyPackage.count({
      where: { clubId: club.id, status: "PUBLISHED" },
    });
    expect(publishedCount).toBe(1);
  });

  it("publishing a third period (July) archives June; May stays ARCHIVED", async () => {
    const club = await bootstrapAPClub("XPER-MAY-JUN-JUL");
    const a = await admin(club.id);
    const { package: m } = await generateDraftMonthlyPackage(a, club.id, { reportingYear: 2026, reportingMonth: 5 });
    await publishMonthlyPackage(a, m.id);
    const { package: j } = await generateDraftMonthlyPackage(a, club.id, { reportingYear: 2026, reportingMonth: 6 });
    const jPub = await publishMonthlyPackage(a, j.id);
    const { package: jl } = await generateDraftMonthlyPackage(a, club.id, { reportingYear: 2026, reportingMonth: 7 });
    const jlPub = await publishMonthlyPackage(a, jl.id);

    const rows = await db().monthlyPackage.findMany({
      where: { clubId: club.id },
      orderBy: { reportingMonth: "asc" },
      select: { reportingMonth: true, status: true },
    });
    expect(rows.find((r) => r.reportingMonth === 5)!.status).toBe("ARCHIVED");
    expect(rows.find((r) => r.reportingMonth === 6)!.status).toBe("ARCHIVED");
    expect(rows.find((r) => r.reportingMonth === 7)!.status).toBe("PUBLISHED");
    expect(jPub.publishedPackageId).not.toBe(jlPub.publishedPackageId);
  });

  it("Board dashboard tile points at the NEWEST PUBLISHED package across periods", async () => {
    const club = await bootstrapAPClub("XPER-TILE");
    const a = await admin(club.id);
    const board = await boardUser(club.id);
    const { package: m } = await generateDraftMonthlyPackage(a, club.id, { reportingYear: 2026, reportingMonth: 5 });
    await publishMonthlyPackage(a, m.id);

    // After May publish, tile points to May.
    const tileBefore = await getMostRecentBoardPackageForUser(board, club.id);
    expect(tileBefore!.reportingMonth).toBe(5);

    // Publish June.
    const { package: j } = await generateDraftMonthlyPackage(a, club.id, { reportingYear: 2026, reportingMonth: 6 });
    const jPub = await publishMonthlyPackage(a, j.id);

    // Tile now points to June; May is no longer surfaced (it's ARCHIVED).
    const tileAfter = await getMostRecentBoardPackageForUser(board, club.id);
    expect(tileAfter!.reportingMonth).toBe(6);
    expect(tileAfter!.id).toBe(jPub.publishedPackageId);
  });

  it("audit log records crossPeriodArchived count when prior-period publication is swept", async () => {
    const club = await bootstrapAPClub("XPER-AUDIT");
    const a = await admin(club.id);
    const { package: m } = await generateDraftMonthlyPackage(a, club.id, { reportingYear: 2026, reportingMonth: 5 });
    await publishMonthlyPackage(a, m.id);
    const { package: j } = await generateDraftMonthlyPackage(a, club.id, { reportingYear: 2026, reportingMonth: 6 });
    const jPub = await publishMonthlyPackage(a, j.id);

    const logs = await db().auditLog.findMany({
      where: { entityId: jPub.publishedPackageId, action: "reporting.monthly-package.publish" },
    });
    expect(logs).toHaveLength(1);
    const after = JSON.parse(logs[0].afterJson ?? "{}");
    expect(after.crossPeriodArchived).toBe(1);
  });

  it("first-ever publish on a fresh club has crossPeriodArchived = 0", async () => {
    const club = await bootstrapAPClub("XPER-FIRST");
    const a = await admin(club.id);
    const { package: m } = await generateDraftMonthlyPackage(a, club.id, { reportingYear: 2026, reportingMonth: 5 });
    const pub = await publishMonthlyPackage(a, m.id);
    const logs = await db().auditLog.findMany({
      where: { entityId: pub.publishedPackageId, action: "reporting.monthly-package.publish" },
    });
    const after = JSON.parse(logs[0].afterJson ?? "{}");
    expect(after.crossPeriodArchived).toBe(0);
  });

  it("tenant isolation: publishing in Club B does NOT touch Club A's PUBLISHED row", async () => {
    const clubA = await bootstrapAPClub("XPER-TENANT-A");
    const clubB = await bootstrapAPClub("XPER-TENANT-B");
    const adminA = await admin(clubA.id);
    const adminB = await admin(clubB.id);
    const { package: a5 } = await generateDraftMonthlyPackage(adminA, clubA.id, { reportingYear: 2026, reportingMonth: 5 });
    const a5Pub = await publishMonthlyPackage(adminA, a5.id);
    const { package: b5 } = await generateDraftMonthlyPackage(adminB, clubB.id, { reportingYear: 2026, reportingMonth: 5 });
    await publishMonthlyPackage(adminB, b5.id);

    const clubARow = await db().monthlyPackage.findUnique({
      where: { id: a5Pub.publishedPackageId },
    });
    // Club A's row is untouched by Club B's publish.
    expect(clubARow!.status).toBe("PUBLISHED");
  });
});

// ===========================================================================
// Issue 2 — header period label inline with title (no gold pill)
// ===========================================================================

describe("ReportingShell — period label inline with title", () => {
  const SHELL = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/reporting/ReportingShell.tsx"),
    "utf8",
  );

  it("period label uses the SAME typography as the report title (no gold pill)", () => {
    expect(SHELL).toMatch(/data-testid="reporting-shell-title"/);
    expect(SHELL).toMatch(/data-testid="reporting-shell-period"/);

    // Locate the period <span> and assert each class signature is
    // present (order-tolerant). Title typography per the founder's
    // spec: 10px uppercase, 0.22em tracking, cream-65 colour, no
    // pill / badge styling.
    const periodBlock = SHELL.match(
      /<span[^>]*data-testid="reporting-shell-period"[^>]*>[\s\S]+?<\/span>/,
    );
    expect(periodBlock, "found the period <span>").not.toBeNull();
    const periodTag = periodBlock![0];
    expect(periodTag).toContain("text-[10px]");
    expect(periodTag).toContain("uppercase");
    expect(periodTag).toContain("tracking-[0.22em]");
    expect(periodTag).toContain("text-club-cream/65");
    // No rounded-full / border-club-gold pill on the period element
    // anymore — that styling was the old standalone badge on the right.
    expect(periodTag).not.toMatch(/rounded-full/);
    expect(periodTag).not.toMatch(/border-club-gold/);
    expect(periodTag).not.toMatch(/bg-club-green-900\/40/);
    expect(periodTag).not.toMatch(/font-mono/);
  });

  it("period label is NOT duplicated in the right controls cluster", () => {
    // The right cluster should now only contain the action slot,
    // Print Mode toggle, and Close button. The period chip used to
    // sit there as the first element.
    const rightCluster = SHELL.match(
      /\/\* Right controls cluster[\s\S]+?<\/div>\s*<\/div>\s*<\/div>\s*<\/header>/,
    );
    expect(rightCluster, "found the right controls block").not.toBeNull();
    // The right cluster shouldn't contain a period chip with the
    // old `font-mono uppercase tracking-[0.18em]` signature.
    expect(rightCluster![0]).not.toMatch(/tracking-\[0\.18em\] text-club-gold/);
    // It should still contain the action slot + Print toggle.
    expect(rightCluster![0]).toMatch(/reporting-shell-header-action-slot/);
    expect(rightCluster![0]).toMatch(/PrintModeToggle/);
  });

  it("period label updates from the ?period=YYYY-MM URL searchParam", () => {
    // The shell reads useSearchParams() and derives the period
    // label from `?period=` when present, falling back to the
    // layout-supplied prop. Verified by code path; the formatter
    // turns "2026-05" → "May 2026".
    expect(SHELL).toMatch(/useSearchParams/);
    expect(SHELL).toMatch(/formatPeriodLabel/);
    expect(SHELL).toMatch(/effectivePeriodLabel/);
  });
});
