// Board / member-facing Monthly Package view — service + page tests.
//
// Covers the founder's acceptance criteria:
//
//   1. Board users can open published/sent packages.
//   2. The package renders in read-only mode (no PublishBar /
//      admin-only controls).
//   3. Board users do not need admin access — the route lives
//      OUTSIDE /app/admin so MEMBER role can reach it.
//   4. Visibility: board-perm OR recipient on this package; anyone
//      else gets null (page renders 404).
//   5. Regular members WITHOUT a recipient row are blocked.
//   6. DRAFT packages are NEVER viewable on this surface (only
//      PUBLISHED + SENT — the controller's prep flow is internal).
//   7. KPIs match the stored snapshot exactly.
//   8. Tenant isolation — another club's user is blocked.
//
// Service tests run against the real DB. Page tests are file-content
// contract checks (the page is a server component that pulls in
// next/navigation + auth — too heavy to render in vitest).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  generateDraftMonthlyPackage,
  getBoardPackageView,
  publishMonthlyPackage,
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
  kpis: Array<{ key: string; label: string; value: string | number }> = [],
) {
  const { package: draft } = await generateDraftMonthlyPackage(generator, clubId, {
    reportingYear: year,
    reportingMonth: month,
  });
  await publishMonthlyPackage(generator, draft.id);
  // Overwrite snapshot with deterministic test data.
  await db().monthlyPackage.update({
    where: { id: draft.id },
    data: {
      atAGlanceKpisJson: JSON.stringify(kpis),
      executiveOpeningSnapshotJson: JSON.stringify({
        club: { name: "Silver Springs Test", city: "Calgary", provinceState: "AB" },
        period: {
          label: `${["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][month]} ${year}`,
          periodEndedLabel: `For the period ended ${["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][month]} 31, ${year}`,
          fiscalYearLabel: `FY${year}`,
        },
        executiveSummary: {
          headline: "Test headline narrative for snapshot verification.",
          consideration: {
            headline: "No board action required.",
            rationale: "All metrics within tolerance.",
          },
        },
      }),
    },
  });
  return draft.id;
}

// ===========================================================================
// getBoardPackageView — visibility matrix
// ===========================================================================

describe("getBoardPackageView — visibility", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("BOARD_READ_ONLY user can view a SENT package without being a recipient", async () => {
    const club = await bootstrapAPClub("BPV-BOARD");
    const a = await admin(club.id);
    const b = await boardUser(club.id);
    const pkgId = await seedPublishedPackage(a, club.id, 2026, 5);
    const view = await getBoardPackageView(b, pkgId);
    expect(view).not.toBeNull();
    expect(view!.status).toBe("PUBLISHED");
    expect(view!.periodLabel).toBe("May 2026");
  });

  it("CLUB_ADMIN can view (has reports:board)", async () => {
    const club = await bootstrapAPClub("BPV-ADMIN");
    const a = await admin(club.id);
    const pkgId = await seedPublishedPackage(a, club.id, 2026, 5);
    expect(await getBoardPackageView(a, pkgId)).not.toBeNull();
  });

  it("MEMBER without recipient row is BLOCKED (returns null → page 404s)", async () => {
    const club = await bootstrapAPClub("BPV-MEMBER-BLOCKED");
    const a = await admin(club.id);
    const m = await regularMember(club.id);
    const pkgId = await seedPublishedPackage(a, club.id, 2026, 5);
    expect(await getBoardPackageView(m, pkgId)).toBeNull();
  });

  it("MEMBER WITH recipient row CAN view (the founder's primary recipient-access path)", async () => {
    const club = await bootstrapAPClub("BPV-MEMBER-ALLOWED");
    const a = await admin(club.id);
    const m = await regularMember(club.id);
    const pkgId = await seedPublishedPackage(a, club.id, 2026, 5);
    await db().monthlyPackageRecipient.create({
      data: {
        monthlyPackageId: pkgId,
        recipientUserId: m.id,
        recipientEmail: "m@example.com",
      },
    });
    const view = await getBoardPackageView(m, pkgId);
    expect(view).not.toBeNull();
    expect(view!.id).toBe(pkgId);
  });

  it("MEMBER cannot view a package they don't have a recipient row on", async () => {
    // Under the greatest-period-wins normalization rule (2026-06-29),
    // publishing a newer period AUTOMATICALLY archives older
    // periods, and archived packages are intentionally not
    // viewable by non-admin members. So this test exercises the
    // recipient-gate using ONE current Live package and a member
    // who's NOT on its recipient list — the cleanest scenario for
    // the contract under the new model.
    const club = await bootstrapAPClub("BPV-MEMBER-OTHER-PKG");
    const a = await admin(club.id);
    const recipient = await regularMember(club.id);
    const nonRecipient = await regularMember(club.id);
    const pkgId = await seedPublishedPackage(a, club.id, 2026, 5);
    // Only `recipient` has a recipient row.
    await db().monthlyPackageRecipient.create({
      data: { monthlyPackageId: pkgId, recipientUserId: recipient.id, recipientEmail: "m@example.com" },
    });
    expect(await getBoardPackageView(recipient, pkgId)).not.toBeNull();
    expect(await getBoardPackageView(nonRecipient, pkgId)).toBeNull();
  });

  it("DRAFT packages are NEVER viewable on the board surface", async () => {
    const club = await bootstrapAPClub("BPV-DRAFT-BLOCKED");
    const a = await admin(club.id);
    const { package: draft } = await generateDraftMonthlyPackage(a, club.id, {
      reportingYear: 2026,
      reportingMonth: 5,
    });
    // Even an admin can't view a DRAFT here — board view is for
    // distributed packages only.
    expect(await getBoardPackageView(a, draft.id)).toBeNull();
  });

  it("returns null for an unknown package id (does NOT leak existence)", async () => {
    const club = await bootstrapAPClub("BPV-UNKNOWN");
    const a = await admin(club.id);
    expect(await getBoardPackageView(a, "no-such-id")).toBeNull();
  });

  it("tenant isolation: another club's board user is blocked", async () => {
    const clubA = await bootstrapAPClub("BPV-TENANT-A");
    const clubB = await bootstrapAPClub("BPV-TENANT-B");
    const adminA = await admin(clubA.id);
    const boardB = await boardUser(clubB.id);
    const pkgId = await seedPublishedPackage(adminA, clubA.id, 2026, 5);
    // Board user on Club B has reports:board on B, not A. Cannot view.
    expect(await getBoardPackageView(boardB, pkgId)).toBeNull();
  });
});

// ===========================================================================
// Snapshot fidelity
// ===========================================================================

describe("getBoardPackageView — snapshot fidelity", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("returns the stored atAGlanceKpis verbatim (immutability)", async () => {
    const club = await bootstrapAPClub("BPV-KPIS-EXACT");
    const a = await admin(club.id);
    const kpis = [
      { key: "ytd-revenue", label: "YTD Revenue", value: 1_823_000 },
      { key: "noi", label: "YTD NOI", value: 412_500 },
      { key: "capital-income", label: "Capital Income", value: 150_000 },
      { key: "reserve-coverage", label: "Reserve Coverage", value: "9.6 mo" },
    ];
    const pkgId = await seedPublishedPackage(a, club.id, 2026, 5, kpis);
    const view = await getBoardPackageView(a, pkgId);
    expect(view!.atAGlanceKpis).toEqual(kpis);
  });

  it("returns executiveOpening + fullPayload parsed (or null for malformed JSON)", async () => {
    const club = await bootstrapAPClub("BPV-PARSE-OK");
    const a = await admin(club.id);
    const pkgId = await seedPublishedPackage(a, club.id, 2026, 5);
    const view = await getBoardPackageView(a, pkgId);
    expect(view!.executiveOpening).toBeTruthy();
    expect(view!.executiveOpening).toHaveProperty("club");
    expect(view!.fullPayload).toBeTruthy();
  });

  it("handles bad-JSON snapshot fields without crashing (returns null parts)", async () => {
    const club = await bootstrapAPClub("BPV-PARSE-BAD");
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
        atAGlanceKpisJson: "bad-json",
        executiveOpeningSnapshotJson: "{not-valid",
        packagePayloadJson: "also-bad",
      },
    });
    const view = await getBoardPackageView(a, draft.id);
    expect(view).not.toBeNull();
    expect(view!.atAGlanceKpis).toEqual([]);
    expect(view!.executiveOpening).toBeNull();
    expect(view!.fullPayload).toBeNull();
  });
});

// ===========================================================================
// Page contract
// ===========================================================================

describe("Board view page — contract", () => {
  const PAGE = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/reports/monthly-package/[id]/page.tsx"),
    "utf8",
  );
  const LAYOUT = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/reports/layout.tsx"),
    "utf8",
  );
  const TILE = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/dashboard/BoardPackageTile.tsx"),
    "utf8",
  );

  it("layout is auth-only (no role gate) so MEMBER role can reach it", () => {
    expect(LAYOUT).toMatch(/getCurrentUser/);
    expect(LAYOUT).toMatch(/if \(!user\) redirect\("\/login"\)/);
    // No ADMIN_ROLES check — that's the whole point of having this
    // layout outside /app/admin.
    expect(LAYOUT).not.toMatch(/ADMIN_ROLES/);
    expect(LAYOUT).not.toMatch(/BOARD_READ_ONLY/);
  });

  it("page calls notFound() when the visibility check rejects the user", () => {
    expect(PAGE).toMatch(/import.*notFound.*from "next\/navigation"/);
    expect(PAGE).toMatch(/if \(!pkg\) notFound\(\)/);
    expect(PAGE).toMatch(/getBoardPackageView\(principal, params\.id\)/);
  });

  it("page renders the FULL admin body via the shared MonthlyReportingPackageBody component", () => {
    // 2026-06-29: the board view no longer ships its own simplified
    // header / KPIs / executive-summary. It renders the SAME
    // MonthlyReportingPackageBody the admin route renders, so all
    // 14 chapters (cover + Chair's Dashboard + Stewardship KPIs +
    // Statement of Activities + Capital Fund + Capital Projects +
    // Statement of Financial Position + AR Aging + Operating
    // Statistics + Departmental P&L + Weather + Payroll Analysis
    // + F&B Statistics + Inventory Analysis) appear here too.
    expect(PAGE).toMatch(/from "@\/app\/app\/admin\/reporting\/monthly\/MonthlyReportingPackageBody"/);
    expect(PAGE).toContain("MonthlyReportingPackageBody");
    expect(PAGE).toMatch(/<MonthlyReportingPackageBody\s+pkg=\{snapshotPayload\}/);
    // The page wraps the shared body in a board-view container.
    expect(PAGE).toMatch(/data-testid="board-package-view"/);
  });

  it("page reads the FROZEN snapshot from pkg.fullPayload, NOT the live reporting service", () => {
    // Board members must always see the document they were given —
    // never a re-rendered live version that could drift from what
    // they were notified about.
    expect(PAGE).toContain("pkg.fullPayload");
    expect(PAGE).not.toMatch(/getMonthlyReportingPackage\(/);
    // Empty-snapshot fallback for legacy packages without a stored
    // payload.
    expect(PAGE).toMatch(/data-testid="board-package-view-empty"/);
  });

  it("page does NOT pass an adminHeader prop (no Publish/Overwrite/Archived controls render)", () => {
    // Check JSX + imports only — comment lines that document the
    // absence of admin controls intentionally name the components
    // they're calling out, and don't constitute usage. Strip
    // single-line comments before assertion.
    const codeOnly = PAGE
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(codeOnly).not.toMatch(/adminHeader=/);
    expect(codeOnly).not.toMatch(/PublishHeaderButton/);
    expect(codeOnly).not.toMatch(/import\s+\{[^}]*PublishBar/);
    expect(codeOnly).not.toMatch(/<PublishBar\b/);
    expect(codeOnly).not.toMatch(/import\s+\{[^}]*publishMonthlyPackageAction/);
    expect(codeOnly).not.toMatch(/import\s+\{[^}]*sendMonthlyPackageAction/);
    expect(codeOnly).not.toMatch(/import\s+\{[^}]*deleteDraftMonthlyPackageAction/);
  });

  it("page still marks the package as viewed for the current user (NEW badge clears)", () => {
    // viewedAt update preserved across the rewrite — the NEW badge
    // behaviour on the dashboard tile depends on it.
    expect(PAGE).toMatch(/markPackageViewedByUser\(principal, pkg\.id\)/);
  });

  it("board layout wraps the page in a ReportingShell with closeHrefOverride=/app/member", () => {
    const BOARD_LAYOUT = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "src/app/app/reports/monthly-package/[id]/layout.tsx",
      ),
      "utf8",
    );
    const REGISTRY = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "src/lib/reporting/monthly-package-chapters.ts",
      ),
      "utf8",
    );
    // Same shell the admin reporting layout uses — visual parity.
    expect(BOARD_LAYOUT).toMatch(/ReportingShell/);
    // Closes to the member dashboard, NOT the admin launcher.
    expect(BOARD_LAYOUT).toMatch(/closeHrefOverride="\/app\/member"/);
    // Chapter rail wired through the SHARED registry (2026-06-30
    // refactor) — see src/lib/reporting/monthly-package-chapters.ts.
    // The literal chapter list no longer lives inline in either
    // reporting layout; the test verifies (a) the board layout
    // imports the registry and passes it as chapters, AND (b) the
    // registry itself still carries all 14 founder-named chapters.
    expect(BOARD_LAYOUT).toMatch(
      /import \{ MONTHLY_REPORTING_CHAPTERS \} from "@\/lib\/reporting\/monthly-package-chapters"/,
    );
    expect(BOARD_LAYOUT).toMatch(/chapters=\{MONTHLY_REPORTING_CHAPTERS\}/);
    for (const chapter of [
      "Executive Opening",
      "Financial Performance",
      "Stewardship Dashboard",
      "Statement of Activities",
      "Capital Fund",
      "Capital Projects",
      "Financial Position",
      "AR Aging",
      "Operating Statistics",
      "Departmental P&L",
      "Weather & Utilization",
      "Payroll Analysis",
      "F&B Statistics",
      "Inventory Analysis",
    ]) {
      expect(REGISTRY).toContain(`label: "${chapter}"`);
    }
  });

  it("board layout derives the header period label from the DB row, not a hardcoded string (founder fix 2026-06-30)", () => {
    // The previous fallback `periodLabel="Monthly Reporting Package"`
    // showed up as the third header segment (duplicating the
    // reportTitle). The fix looks up the MonthlyPackage row by id
    // and formats `${MonthLong} ${YYYY}` — same shape ReportingShell's
    // `formatPeriodLabel` produces from the admin route's
    // `?period=YYYY-MM` query.
    const BOARD_LAYOUT = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "src/app/app/reports/monthly-package/[id]/layout.tsx",
      ),
      "utf8",
    );
    // params.id flows from the dynamic segment into the layout.
    expect(BOARD_LAYOUT).toMatch(/params: \{ id: string \}/);
    // We look up reportingYear + reportingMonth by package id.
    expect(BOARD_LAYOUT).toMatch(
      /prisma\.monthlyPackage\.findUnique\([\s\S]+where: \{ id: params\.id \}[\s\S]+select: \{ reportingYear: true, reportingMonth: true \}/,
    );
    // The display format is "Month YYYY" — same as the admin route's
    // `formatPeriodLabel`. Walk the 12 month names so the format
    // can't drift.
    for (const month of [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ]) {
      expect(BOARD_LAYOUT).toContain(`"${month}"`);
    }
    // periodLabel is the computed string, not a hardcoded literal.
    expect(BOARD_LAYOUT).toMatch(/periodLabel=\{periodLabel\}/);
    // The OLD broken hardcoded fallback as a periodLabel PROP is
    // gone (the string can still appear as a defensive local
    // fallback variable, but not as the literal value of
    // `periodLabel=`).
    expect(BOARD_LAYOUT).not.toMatch(/periodLabel="Monthly Reporting Package"/);
  });

  it("tile see-more link targets the new board-view route (not admin)", () => {
    expect(TILE).toMatch(/\/app\/reports\/monthly-package\/\$\{pkg\.id\}/);
    expect(TILE).not.toMatch(/\/app\/admin\/reporting\/monthly\?period=/);
  });

  it("MonthlyReportingPackageBody is exported from the admin reporting page directory so the board route can import it", () => {
    const BODY = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "src/app/app/admin/reporting/monthly/MonthlyReportingPackageBody.tsx",
      ),
      "utf8",
    );
    // The body must be exported (Next.js page.tsx files can't
    // export additional named exports — that's why the body lives
    // in its own file).
    expect(BODY).toMatch(/export function MonthlyReportingPackageBody/);
    // Body accepts an optional adminHeader slot (the publish-button
    // portal source) so admin AND board routes share one body.
    expect(BODY).toMatch(/adminHeader\?:.*ReactNode/s);
    // Body still emits the same canonical section anchors used by
    // the rail in BOTH layouts.
    for (const id of [
      "executive-opening",
      "financial-performance",
      "stewardship-dashboard",
      "statement-of-activities",
      "capital-fund",
      "capital-projects",
      "financial-position",
      "ar-aging",
      "operating-statistics",
      "departmental-p-and-l",
      "weather-and-utilization",
      "payroll-analysis",
      "f-and-b-statistics",
      "inventory-analysis",
    ]) {
      expect(BODY).toMatch(new RegExp(`id="${id}"`));
    }
  });

  it("admin page is unchanged: still gates on reports:board + still passes a PublishHeaderButton as adminHeader", () => {
    const ADMIN_PAGE = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "src/app/app/admin/reporting/monthly/page.tsx",
      ),
      "utf8",
    );
    expect(ADMIN_PAGE).toMatch(/hasPermission\(principal, clubId, "reports:board"\)/);
    expect(ADMIN_PAGE).toMatch(/<MonthlyReportingPackageBody/);
    expect(ADMIN_PAGE).toMatch(/adminHeader=\{/);
    expect(ADMIN_PAGE).toMatch(/<PublishHeaderButton/);
  });
});
