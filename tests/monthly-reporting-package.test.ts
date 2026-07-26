// Monthly Reporting Package tests.
//
// Covers:
//  - service shape (every documented section is present)
//  - tenant scoping (clubId drives the returned `club.name`)
//  - explicit demo-data labelling
//  - export controls report disabled until renderer ships
//  - page renders all nine section testids
//  - sidebar navigation entry exists with the right permission
//  - Reports hub page links to the new route

import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { db, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import { getMonthlyReportingPackage } from "@/lib/reporting/monthly-package";

// One reset at file start. The 33 DB-using tests in this file each
// `bootstrapAPClub("unique name")` to create their own club, so they
// are isolated by club-id rather than by per-test resetDb. The other
// ~135 tests are source-string contract assertions that don't touch
// the DB at all — paying the resetDb tax (~2.4s × 168 ≈ 400s) on those
// was the dominant cost of this file before the test-stability pass.
beforeAll(async () => { await resetDb(); await seedRbac(); });

// -----------------------------------------------------------------
// Service shape
// -----------------------------------------------------------------
describe("Monthly Reporting Package — service shape", () => {
  it("returns every documented section for an active club", async () => {
    const club = await bootstrapAPClub("Silver Springs Reporting");
    const pkg = await getMonthlyReportingPackage(club.id);

    // Tenant scope: club name is propagated from the active club.
    expect(pkg.club.id).toBe(club.id);
    expect(pkg.club.name).toBe("Silver Springs Reporting");

    // Period metadata.
    expect(pkg.period.label).toMatch(/[A-Z][a-z]+ \d{4}/); // e.g. "May 2026"
    expect(pkg.period.fiscalYearLabel).toBeTruthy();
    expect(pkg.preparedFor).toMatch(/Finance Committee/i);

    // Required top-level sections.
    expect(pkg.executiveSummary.kpis.length).toBeGreaterThanOrEqual(6);
    expect(pkg.boardBriefing.operations.chips.length).toBeGreaterThan(0);
    expect(pkg.boardBriefing.financialHealth.chips.length).toBeGreaterThan(0);
    expect(pkg.boardBriefing.capitalProgram.chips.length).toBeGreaterThan(0);
    expect(pkg.visualSummary.equityTrend.length).toBe(12);
    expect(pkg.visualSummary.noiTrend.length).toBe(12);
    expect(pkg.visualSummary.duesSubsidyTrend.length).toBe(12);
    expect(pkg.operatingKPIs.cards.length).toBe(8);
    expect(pkg.capitalKPIs.cards.length).toBe(8);
    expect(pkg.statementOfActivities.lines.length).toBeGreaterThan(0);
    expect(pkg.capitalFund.lines.length).toBeGreaterThan(0);
    expect(pkg.capitalProjects.rows.length).toBeGreaterThan(0);
    expect(pkg.financialPosition.lines.length).toBeGreaterThan(0);
    expect(pkg.arAging.buckets.length).toBe(4);
    expect(pkg.operatingStats.rounds.ytd).toBeGreaterThan(0);
    expect(pkg.departmentPnL.rows.length).toBeGreaterThan(0);
    expect(pkg.payroll.monthlyRatioTrend.length).toBe(12);
    expect(pkg.fbStats.salesByOutlet.length).toBeGreaterThan(0);
    expect(pkg.inventory.foodOnHand).toBeTruthy();
  });

  it("uses Silver Springs club name when bootstrapped with that label", async () => {
    const club = await bootstrapAPClub("Silver Springs Golf & CC");
    const pkg = await getMonthlyReportingPackage(club.id);
    expect(pkg.club.name).toBe("Silver Springs Golf & CC");
  });

  it("isolates per-tenant — two clubs return their own names", async () => {
    const a = await bootstrapAPClub("Club Alpha Reporting");
    const b = await bootstrapAPClub("Club Beta Reporting");
    const [pkgA, pkgB] = await Promise.all([
      getMonthlyReportingPackage(a.id),
      getMonthlyReportingPackage(b.id),
    ]);
    expect(pkgA.club.name).toBe("Club Alpha Reporting");
    expect(pkgB.club.name).toBe("Club Beta Reporting");
    expect(pkgA.club.id).not.toBe(pkgB.club.id);
  });

  it("throws when the club id is unknown (no silent demo data leak)", async () => {
    await expect(getMonthlyReportingPackage("club_does_not_exist")).rejects.toThrow();
  });

  it("AR aging flips to live source when MemberAccount rows exist", async () => {
    const club = await bootstrapAPClub("Club AR Live");
    // Create a member + MemberAccount row so the service detects live data.
    const member = await db().member.create({
      data: {
        clubId: club.id, memberNumber: "M9001", firstName: "A", lastName: "Live",
        email: `ar-live-${club.id}@example.com`,
        status: "ACTIVE", joinDate: new Date("2024-01-01"),
      },
    });
    await db().memberAccount.create({
      data: { clubId: club.id, memberId: member.id, currentBalance: 1234 },
    });
    const pkg = await getMonthlyReportingPackage(club.id);
    expect(pkg.arAging.dataSource).toBe("live");
    expect(pkg.dataSourcesPresent).toContain("live");
  });
});

// -----------------------------------------------------------------
// Export controls — must NOT report success while the renderer is unbuilt
// -----------------------------------------------------------------
describe("Monthly Reporting Package — honest export state", () => {
  it("flags exports.enabled=false with a human-readable reason", async () => {
    const club = await bootstrapAPClub("Export Honest");
    const pkg = await getMonthlyReportingPackage(club.id);
    expect(pkg.exports.enabled).toBe(false);
    expect(pkg.exports.reason).toMatch(/not wired|follow-up/i);
  });
});

// -----------------------------------------------------------------
// Demo-data labelling
// -----------------------------------------------------------------
describe("Monthly Reporting Package — demo data is labelled", () => {
  it("most sections report dataSource=demo until live wiring lands", async () => {
    const club = await bootstrapAPClub("Demo Labels");
    const pkg = await getMonthlyReportingPackage(club.id);
    expect(pkg.executiveSummary.dataSource).toBe("demo");
    expect(pkg.visualSummary.dataSource).toBe("demo");
    expect(pkg.operatingKPIs.dataSource).toBe("demo");
    expect(pkg.capitalKPIs.dataSource).toBe("demo");
    expect(pkg.statementOfActivities.dataSource).toBe("demo");
    expect(pkg.capitalFund.dataSource).toBe("demo");
    expect(pkg.capitalProjects.dataSource).toBe("demo");
    expect(pkg.financialPosition.dataSource).toBe("demo");
    expect(pkg.payroll.dataSource).toBe("demo");
    expect(pkg.fbStats.dataSource).toBe("demo");
    expect(pkg.inventory.dataSource).toBe("demo");
  });
});

// -----------------------------------------------------------------
// Page source contract — every section testid is wired.
// (Rendering the React page in jsdom is heavy; we pin the testid
// strings since they are the assertion surface for downstream e2e.)
// -----------------------------------------------------------------
describe("Monthly Reporting Package — page source contract", () => {
  const SRC = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/reporting/monthly/page.tsx"),
    "utf8",
  );

  // Testids are emitted via two paths in this page:
  //   (a) literal `data-testid="..."` on raw JSX elements
  //   (b) a `testId="..."` prop forwarded to a sub-component (which
  //       then emits `data-testid={testId}`)
  // Match either form so structural tests survive small refactors.
  // Some components ship a lowercase `testid` prop (StewardshipScorecardCard);
  // others use camelCase `testId` (StewardshipBlock). The paired-row
  // grid passes its panel testid via an object literal (`testid: "..."`)
  // so we also match that shape.
  function hasTestId(id: string): boolean {
    return SRC.includes(`data-testid="${id}"`)
      || SRC.includes(`testId="${id}"`)
      || SRC.includes(`testid="${id}"`)
      || SRC.includes(`testid: "${id}"`);
  }

  // The six headline executive KPIs are defined in the service. We
  // pin them there — the page renders them via `kpi.key`.
  it("legacy Operations & Analytics catch-all surfaces no longer ship in the page (chapter retired 2026-06-19)", () => {
    // The Operations & Analytics chapter (id: operations) was retired
    // 2026-06-19 — every load-bearing reading now ships in one of the
    // six dedicated operational chapters (Operating Statistics →
    // Inventory Analysis). The catch-all headline tiles, grouped
    // operating-metric blocks, and closing utilization sparkline that
    // used to live inside it MUST NOT come back.
    for (const id of [
      "operations-headline",
      "operations-active-members",
      "operations-rounds-ytd",
      "operations-fb-covers",
      "operations-waitlist",
      "operations-group-membership",
      "operations-group-course",
      "operations-group-fb",
      "operations-group-context",
      "operations-utilization-trend",
    ]) {
      expect(hasTestId(id), `legacy ${id} testid MUST NOT render`).toBe(false);
    }
    // Pre-retirement guards still apply — none of the legacy raw-
    // table cards can come back either.
    expect(SRC).not.toMatch(/data-testid="operating-stats"/);
    expect(SRC).not.toMatch(/data-testid="departmental-pnl"/);
    expect(SRC).not.toMatch(/data-testid="weather-utilization"/);
  });

  it("F&B section does NOT render the outlet-mix block (KPI curation)", () => {
    // The fb-sales-by-outlet group was removed in the KPI curation
    // pass — operational outlet sales reporting does not belong in a
    // board package. Service data preserved.
    expect(SRC).not.toMatch(/testId="fb-sales-by-outlet"/);
  });

  it("page does NOT ship the old export-controls strip beneath the cover", () => {
    // Audit C1: the disabled <select> + four admin buttons
    // ("Generate package", "Export PDF", "Export Excel", "Mark reviewed")
    // shipped the wrong feel — a working tool's affordance under a
    // ceremonial cover. The strip and its helper components were
    // removed in the body-polish pass. The contract now asserts they
    // stay gone (regression guard).
    expect(SRC).not.toMatch(/data-testid="monthly-export-controls"/);
    expect(SRC).not.toMatch(/Generate package/);
    expect(SRC).not.toMatch(/Export PDF/);
    expect(SRC).not.toMatch(/Export Excel/);
    expect(SRC).not.toMatch(/Mark reviewed/);
    expect(SRC).not.toMatch(/data-testid="monthly-cover-controls-strip"/);
  });

  it("page is gated on the reports:board permission (no silent leak to lower roles)", () => {
    expect(SRC).toMatch(/hasPermission\(principal, clubId, "reports:board"\)/);
    expect(SRC).toMatch(/redirect\("\/app\/admin"\)/);
  });
});

// -----------------------------------------------------------------
// Sidebar nav + Reports hub
// -----------------------------------------------------------------
describe("Monthly Reporting Package — discoverability", () => {
  // 2026-06-26: the sidebar nav data was extracted to a pure .ts
  // module so vitest can read it without dragging the React/JSX
  // through the bundler. The Monthly Package link was also pointed
  // at the new period-selection LAUNCHER instead of deep-linking
  // straight into the May 2026 board document. Both files have to
  // surface the launcher href + the reports:board gate.
  const SIDEBAR_DATA = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/sidebar-nav-data.ts"),
    "utf8",
  );
  const REPORTS_HUB = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/reports/page.tsx"),
    "utf8",
  );

  it("Admin sidebar links the Monthly Package LAUNCHER (not a hardcoded report period)", () => {
    // New: routes to the launcher under /governance/monthly-package
    // so the controller picks the period before the document loads.
    expect(SIDEBAR_DATA).toMatch(/href: "\/app\/admin\/governance\/monthly-package"/);
    expect(SIDEBAR_DATA).toMatch(/label: "Monthly Package"/);
    expect(SIDEBAR_DATA).toMatch(/perm: "reports:board"/);
    // Regression guard — the dashboard must NOT deep-link into the
    // hardcoded May 2026 document.
    expect(SIDEBAR_DATA).not.toMatch(
      /href: "\/app\/admin\/reporting\/monthly", label: "Monthly Package"/,
    );
  });

  it("Reports hub page still links the existing direct route (legacy access path preserved)", () => {
    expect(REPORTS_HUB).toMatch(/\/app\/admin\/reporting\/monthly/);
    expect(REPORTS_HUB).toMatch(/Monthly Board Package/);
  });
});

// -----------------------------------------------------------------
// Reporting shell — strips admin chrome and provides chapter rail.
// -----------------------------------------------------------------
describe("Monthly Reporting Package — board-package shell", () => {
  const SHELL = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/reporting/ReportingShell.tsx"),
    "utf8",
  );
  const ADMIN_SHELL = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/admin/AdminShell.tsx"),
    "utf8",
  );
  const REPORTING_LAYOUT = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/reporting/layout.tsx"),
    "utf8",
  );
  const MONTHLY_PAGE = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/reporting/monthly/page.tsx"),
    "utf8",
  );
  const MONTHLY_PACKAGE = fs.readFileSync(
    path.resolve(process.cwd(), "src/lib/reporting/monthly-package.ts"),
    "utf8",
  );

  it("AdminShell strips its admin chrome on /app/admin/reporting paths", () => {
    expect(ADMIN_SHELL).toMatch(/REPORTING_MODE_PREFIXES = \["\/app\/admin\/reporting"\]/);
    expect(ADMIN_SHELL).toMatch(/function isReportingPath/);
    expect(ADMIN_SHELL).toMatch(/data-testid="reporting-mode-shell"/);
  });

  it("ReportingShell exposes the documented testid surface", () => {
    for (const id of [
      "reporting-shell",
      "reporting-shell-header",
      "reporting-shell-exit",
      "reporting-shell-chapters",
      "reporting-shell-body",
    ]) {
      expect(SHELL.includes(`data-testid="${id}"`), `${id} testid missing in ReportingShell`).toBe(true);
    }
  });

  it("Chapter II's left-rail label is 'Financial Performance' (chapter id derived by slugify, no manual id field allowed)", () => {
    // 2026-06-19 naming-convention enforcement: chapter entries
    // declare only `number`, `label`, and `group`. The chapter id is
    // derived from the label by `chapterIdFor()` so manually entered
    // ids cannot diverge from the visible label.
    expect(REPORTING_LAYOUT).toMatch(/number:\s*"II",\s*label:\s*"Financial Performance"/);
    // The prior chapter II label must not reappear.
    expect(REPORTING_LAYOUT).not.toMatch(/label:\s*"Chair's Dashboard"/);
    // No chapter entry carries a manually-entered `id:` field.
    expect(REPORTING_LAYOUT, "MONTHLY_CHAPTERS entries MUST NOT declare an `id:` field — the id is derived from the label").not.toMatch(/\{\s*id:\s*"/);
  });

  it("ReportingShell wires deterministic majority-visible scrollspy + smooth scroll + active-state highlighting on chapter clicks", () => {
    // 2026-06-19 — the active-section detection went through three
    // iterations:
    //   (1) IntersectionObserver. Rejected — produced premature
    //       / stuck active rows in the founder's browser.
    //   (2) Reading-line (last section whose top ≤ 140 px).
    //       Rejected — felt laggy because activation waited for the
    //       next heading to cross the line.
    //   (3) MAJORITY-VISIBLE (current). The next section activates
    //       when its visible-pixel ratio exceeds 60 % of the usable
    //       viewport AND its visible area exceeds the current
    //       active's. Hysteresis: hold current unless a challenger
    //       qualifies, or current drops below the 10 % "meaningfully
    //       visible" floor (then fall back to largest-visible).
    expect(SHELL).toMatch(/ACTIVATE_THRESHOLD\s*=\s*0\.60/);
    expect(SHELL).toMatch(/RELEASE_THRESHOLD\s*=\s*0\.10/);
    expect(SHELL).toMatch(/visible\s*\/\s*usable/);
    expect(SHELL).toMatch(/getBoundingClientRect\(\)/);
    expect(SHELL).toMatch(/requestAnimationFrame/);
    expect(SHELL).toMatch(/addEventListener\("scroll",\s*onScrollOrResize,\s*\{\s*passive:\s*true\s*\}\)/);
    expect(SHELL).toMatch(/addEventListener\("resize",\s*onScrollOrResize,\s*\{\s*passive:\s*true\s*\}\)/);
    // The legacy IntersectionObserver implementation must NOT come
    // back — it was the source of the founder-reported bug.
    expect(SHELL, "IntersectionObserver MUST NOT be the active-section source").not.toMatch(/new IntersectionObserver/);
    // The earlier reading-line algorithm must not regress back
    // either — majority-visible is the only sanctioned approach now.
    expect(SHELL, "reading-line constant MUST NOT regress back as the algorithm source").not.toMatch(/const READING_LINE/);
    // Click handler attached to chapter anchors with preventDefault +
    // window.scrollTo + behavior smooth. Chapter id is derived from
    // the label inside the render closure (2026-06-19 convention) so
    // the handler binds to `id`, not `c.id`.
    expect(SHELL).toMatch(/onClick=\{\(e\)\s*=>\s*onClickChapter\(e,\s*id\)\}/);
    expect(SHELL).toMatch(/window\.scrollTo\(\{\s*top[\s\S]*?behavior:[\s\S]*?"smooth"/);
    // preventDefault on click — prevents the browser's native anchor
    // jump from competing with our smooth scroll.
    expect(SHELL).toMatch(/e\.preventDefault\(\)/);
    // Reduced-motion preference respected.
    expect(SHELL).toMatch(/prefers-reduced-motion/);
    // Sticky header offset accounted for so the heading isn't hidden.
    expect(SHELL).toMatch(/headerOffset/);
    // Active row carries a data-active attribute for measurement,
    // a muted sand background, and a stable transition. Style choices
    // are pinned so the active state can't silently regress to a
    // SaaS-style harsh highlight.
    expect(SHELL).toMatch(/data-active=\{activeId === id \? "true" : undefined\}/);
    expect(SHELL).toMatch(/bg-club-sand\/60/);
    expect(SHELL).toMatch(/transition-colors/);
  });

  it("ReportingShell close-report link points at /app/admin with document-shaped label", () => {
    // Step / shell redesign: the link still routes operators back to
    // admin (the URL contract is the operator's escape hatch) but the
    // visible affordance is a quiet close glyph labelled "Close report"
    // — the word "admin" has been removed from the document chrome per
    // docs/monthly-reporting-chrome-audit.md C4.
    expect(SHELL).toMatch(/href="\/app\/admin"/);
    expect(SHELL).toMatch(/aria-label="Close report"/);
    expect(SHELL).not.toMatch(/Back to admin/);
  });

  it("reporting layout wires fourteen roman-numeral chapters in board-reading order", () => {
    // Layout uses the ReportingShell wrapper.
    expect(REPORTING_LAYOUT).toMatch(/ReportingShell/);
    // Roman-numeral markers I-XIV reinforce document feel.
    // 2026-06-19 removals (all on the same day):
    //  - Legacy "Payroll" chapter (id: payroll) — duplicated chapter
    //    XII "Payroll Analysis".
    //  - Legacy "F&B / Hospitality" chapter (id: fb-hospitality) —
    //    duplicated chapter XIII "F&B Statistics".
    //  - Legacy "Membership Stewardship" chapter (id:
    //    membership-stewardship) — load-bearing surfaces migrated
    //    into the Stewardship KPI Dashboard (chapter III); standalone
    //    chapter retired.
    //  - Legacy "Experience Stewardship" chapter (id:
    //    experience-stewardship) — Rounds YTD / Course Utilization /
    //    Spend per Member / Spend per Round lifted into Weather &
    //    Utilization (chapter XI); F&B covers + F&B subsidy already
    //    live in F&B Statistics + the Stewardship KPI Dashboard;
    //    standalone chapter retired.
    //  - Legacy "Operations & Analytics" chapter (id: operations) —
    //    the narrative-first headline tiles + grouped operating-metric
    //    tables were the original Pillar-1/4/5 catch-all surface,
    //    but every load-bearing reading now ships in one of the six
    //    chapters above (Operating Statistics → Inventory Analysis).
    //    The standalone chapter became redundant. The "Operations &
    //    Analytics" group label persists as the rail heading above
    //    the six surviving operational chapters.
    // Net rail = 14 chapters; STEWARDSHIP group no longer renders.
    for (const numeral of ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV"]) {
      expect(REPORTING_LAYOUT).toMatch(new RegExp(`number: "${numeral}"`));
    }
    // No leftover XV / XVI / XVII / XVIII / XIX markers after the cascade.
    expect(REPORTING_LAYOUT, "no leftover XV numeral").not.toMatch(/number: "XV"[^I]/);
    expect(REPORTING_LAYOUT, "no leftover XVI numeral").not.toMatch(/number: "XVI"/);
    expect(REPORTING_LAYOUT, "no leftover XVII numeral").not.toMatch(/number: "XVII"/);
    expect(REPORTING_LAYOUT, "no leftover XVIII numeral").not.toMatch(/number: "XVIII"/);
    expect(REPORTING_LAYOUT, "no leftover XIX numeral").not.toMatch(/number: "XIX"/);
    // The 14 chapter ids in the new board-reading order.
    //   I    cover                          — Executive Opening
    //   II   financial-performance               — Financial Performance
    //   III  stewardship-dashboard          — Stewardship KPI Dashboard
    //   IV   statement-of-activities        — Statement of Activities
    //   V    capital-fund                   — Capital Fund Statement
    //   VI   capital-projects        — Capital Projects
    //   VII  financial-position — Financial Position
    //   VIII ar-aging      — AR Aging
    //   IX   operating-statistics           — Operating Statistics & Focus Areas
    //   X    departmental-p-and-l        — Departmental P&L Summary
    //   XI   weather-and-utilization        — Monthly Weather Summary
    //   XII  payroll-analysis  — Departmental Payroll Analysis
    //   XIII f-and-b-statistics       — Food & Beverage Statistics
    //   XIV  inventory-analysis             — Inventory Analysis
    //   (the entire STEWARDSHIP group was retired 2026-06-19; the
    //    standalone Operations & Analytics chapter was retired the
    //    same day. The "Operations & Analytics" group label survives
    //    as the rail heading above the six operational chapters.)
    const SECTION_IDS = [
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
    ];
    // Legacy "capital-projects" id MUST NOT appear in the rail or as
    // a top-level body section (Capital Projects lives ONLY at
    // chapter VI / capital-projects now). Legacy "payroll"
    // (the standalone "Payroll" chapter — distinct from the
    // canonical chapter XII "Payroll Analysis" / id
    // "payroll-analysis") was removed 2026-06-19.
    // Legacy "fb-hospitality" (distinct from the canonical chapter
    // XIII "F&B Statistics" / id "f-and-b-statistics") was
    // also removed 2026-06-19.
    expect(
      REPORTING_LAYOUT,
      "legacy 'payroll' rail entry MUST NOT exist",
    ).not.toMatch(/id: "payroll"/);
    expect(
      MONTHLY_PAGE,
      "legacy '<section id=\"payroll\">' MUST NOT render",
    ).not.toMatch(/<section id="payroll"/);
    expect(
      MONTHLY_PAGE,
      "legacy 'PayrollAnalysis' component MUST NOT exist",
    ).not.toMatch(/function PayrollAnalysis\(/);
    expect(
      REPORTING_LAYOUT,
      "legacy 'fb-hospitality' rail entry MUST NOT exist",
    ).not.toMatch(/id: "fb-hospitality"/);
    expect(
      MONTHLY_PAGE,
      "legacy '<section id=\"fb-hospitality\">' MUST NOT render",
    ).not.toMatch(/<section id="fb-hospitality"/);
    expect(
      MONTHLY_PAGE,
      "legacy 'FbHospitality' component MUST NOT exist",
    ).not.toMatch(/function FbHospitality\(/);
    expect(
      REPORTING_LAYOUT,
      "legacy 'membership-stewardship' rail entry MUST NOT exist",
    ).not.toMatch(/id: "membership-stewardship"/);
    expect(
      MONTHLY_PAGE,
      "legacy '<section id=\"membership-stewardship\">' MUST NOT render",
    ).not.toMatch(/<section id="membership-stewardship"/);
    expect(
      MONTHLY_PAGE,
      "legacy 'MembershipStewardship' component MUST NOT exist",
    ).not.toMatch(/function MembershipStewardship\(/);
    expect(
      MONTHLY_PAGE,
      "legacy 'membership-stewardship-lead' testid MUST NOT render",
    ).not.toMatch(/data-testid="membership-stewardship-lead"/);
    expect(
      MONTHLY_PAGE,
      "legacy 'membership-attrition-trend' testid MUST NOT render",
    ).not.toMatch(/data-testid="membership-attrition-trend"/);
    expect(
      REPORTING_LAYOUT,
      "legacy 'experience-stewardship' rail entry MUST NOT exist",
    ).not.toMatch(/id: "experience-stewardship"/);
    expect(
      MONTHLY_PAGE,
      "legacy '<section id=\"experience-stewardship\">' MUST NOT render",
    ).not.toMatch(/<section id="experience-stewardship"/);
    expect(
      MONTHLY_PAGE,
      "legacy 'ExperienceStewardship' component MUST NOT exist",
    ).not.toMatch(/function ExperienceStewardship\(/);
    expect(
      MONTHLY_PAGE,
      "legacy 'ExperienceReading' helper MUST NOT exist (only used by the removed chapter)",
    ).not.toMatch(/function ExperienceReading\(/);
    expect(
      MONTHLY_PAGE,
      "legacy 'experience-stewardship-lead' testid MUST NOT render",
    ).not.toMatch(/data-testid="experience-stewardship-lead"/);
    expect(
      MONTHLY_PAGE,
      "legacy 'experience-readings' testid MUST NOT render",
    ).not.toMatch(/data-testid="experience-readings"/);
    expect(
      MONTHLY_PAGE,
      "legacy 'experience-utilization-trend' testid MUST NOT render",
    ).not.toMatch(/data-testid="experience-utilization-trend"/);
    expect(
      MONTHLY_PAGE,
      "legacy 'experience-subsidy-trend' testid MUST NOT render",
    ).not.toMatch(/data-testid="experience-subsidy-trend"/);
    expect(
      REPORTING_LAYOUT,
      "legacy 'operations' rail entry MUST NOT exist",
    ).not.toMatch(/id: "operations"/);
    expect(
      MONTHLY_PAGE,
      "legacy '<section id=\"operations\">' MUST NOT render",
    ).not.toMatch(/<section id="operations"/);
    expect(
      MONTHLY_PAGE,
      "legacy 'OperationsAnalytics' component MUST NOT exist",
    ).not.toMatch(/function OperationsAnalytics\(/);
    expect(
      MONTHLY_PAGE,
      "legacy 'OperatingMetricGroup' helper MUST NOT exist",
    ).not.toMatch(/function OperatingMetricGroup\(/);
    expect(
      MONTHLY_PAGE,
      "legacy 'OperatingMetric' helper MUST NOT exist (singular form only — OperatingMetricGroup also removed above)",
    ).not.toMatch(/function OperatingMetric\(/);
    expect(
      MONTHLY_PAGE,
      "legacy 'operations-headline' testid MUST NOT render",
    ).not.toMatch(/data-testid="operations-headline"/);
    expect(
      MONTHLY_PAGE,
      "legacy 'operations-utilization-trend' testid MUST NOT render",
    ).not.toMatch(/data-testid="operations-utilization-trend"/);
    // Legacy "capital-projects" id used to refer to the duplicate
    // chapter retired 2026-06-17. Capital Projects now lives ONLY
    // at chapter VI under the same id (2026-06-19 naming-convention
    // refactor — the section id was renamed from "capital-project-
    // tracker" → "capital-projects" to match the visible label).
    // So `capital-projects` is now legitimately present, not legacy.
    // The "must not render Approved capital plan" guard stays, since
    // that was the legacy duplicate chapter's title.
    expect(
      MONTHLY_PAGE,
      "legacy 'Approved capital plan' title MUST NOT appear",
    ).not.toMatch(/title="Approved capital plan"/);
    // Chapter I (cover / Executive Opening) renders as a `<div id>`
    // not a `<section id>`; its id is derived from the label
    // "Executive Opening" via `chapterIdFor()` → "executive-opening".
    expect(REPORTING_LAYOUT).toMatch(/label: "Executive Opening"/);
    expect(MONTHLY_PAGE).toMatch(/<div id="executive-opening"/);
    for (const id of SECTION_IDS) {
      expect(MONTHLY_PAGE).toMatch(new RegExp(`<section id="${id}"`));
    }
    // Old chapter X removed — must not render or be wired in the rail.
    expect(REPORTING_LAYOUT, "old chapter X 'stewardship' must not wire").not.toMatch(/id: "stewardship"[^-]/);
    expect(MONTHLY_PAGE,      "old chapter X 'stewardship' section must not render").not.toMatch(/<section id="stewardship"[^-]/);
  });

  it("reading order: stewardship dashboard (chapter III) combines operating + capital under one chapter", () => {
    // The new chapter III section is a thin wrapper:
    //   <section id="stewardship-dashboard"> <StewardshipKpiDashboard pkg={pkg} /> </section>
    // The actual Operating + Capital panel testids live INSIDE the
    // StewardshipKpiDashboard component definition. Source-contract
    // assertions therefore target the component body, not the section.
    const section = MONTHLY_PAGE.match(/<section id="stewardship-dashboard"[\s\S]+?<\/section>/);
    expect(section, "stewardship-dashboard section must exist").toBeTruthy();
    expect(section![0]).toMatch(/<StewardshipKpiDashboard\s+pkg=\{pkg\}/);

    // Chapter III ships the EXPLANATORY KPI presentation layer
    // (StewardshipMetricCard rows carrying What it is / Why it
    // matters / Policy or Target / Benchmark) — NOT the chapter II
    // detailed StewardshipScorecardCard tables. Both surfaces share
    // their reporting-service backing (chapter II reads
    // `pkg.stewardshipDashboard.scorecards.*`; chapter III reads
    // `pkg.operatingKPIs.cards` / `pkg.capitalKPIs.cards` — both
    // produced by the same service). The chapter-III panels render
    // via the dedicated StewardshipKpiPairedGrid wrapper (paired-row
    // CSS grid: dark-green header pair + description pair + paired
    // KPI explanatory cards, each row stretched so corresponding
    // KPIs share row height).
    const body = sliceFn("StewardshipKpiDashboard");
    expect(body.length, "StewardshipKpiDashboard body must be findable").toBeGreaterThan(0);
    expect(body).toMatch(/<StewardshipKpiPairedGrid/);
    expect(body).toMatch(/testid:\s*"stewardship-kpi-panel-operating"/);
    expect(body).toMatch(/testid:\s*"stewardship-kpi-panel-capital"/);
    expect(body).toMatch(/cards:\s*pkg\.operatingKPIs\.cards/);
    expect(body).toMatch(/cards:\s*pkg\.capitalKPIs\.cards/);
    // The detailed scorecard tables (chapter II) MUST NOT render
    // inside chapter III's body.
    expect(body, "chapter III must NOT duplicate the chapter II scorecard tables")
      .not.toMatch(/<StewardshipScorecardCard/);
  });

  it("Statement of Activities chapter IV — Saguaro-style header chrome + 8-column table + section bands + NOI band + capital divider + CFO commentary", () => {
    // Section wrapper.
    const section = MONTHLY_PAGE.match(/<section id="statement-of-activities"[\s\S]+?<\/section>/);
    expect(section, "statement-of-activities section must exist").toBeTruthy();
    expect(section![0]).toMatch(/<StatementOfActivitiesPanel\s+pkg=\{pkg\}/);

    // Panel body — header chrome, both tables, CFO commentary, footer.
    const panel = sliceFn("StatementOfActivitiesPanel");
    expect(panel.length, "StatementOfActivitiesPanel body must be findable").toBeGreaterThan(0);
    expect(panel).toMatch(/data-testid="statement-of-activities-v2"/);
    expect(panel).toMatch(/data-testid="soa-eyebrow"/);
    expect(panel).toMatch(/data-testid="soa-title"/);
    expect(panel).toMatch(/data-testid="soa-period"/);
    expect(panel).toMatch(/data-testid="soa-intro"/);
    expect(panel).toMatch(/data-testid="soa-statement-number"/);
    expect(panel).toMatch(/data-testid="soa-document-chip"/);
    expect(panel).toMatch(/data-testid="soa-prepared-for"/);
    expect(panel).toMatch(/data-testid="soa-table-operating"/);
    expect(panel).toMatch(/data-testid="soa-table-capital"/);
    expect(panel).toMatch(/data-testid="soa-cfo-commentary"/);
    expect(panel).toMatch(/data-testid="soa-cfo-list"/);
    // Reference attribution footer REMOVED 2026-06-15 (production
    // package, not a Saguaro reference illustration). The chapter
    // must not ship any "Hypothetical Illustration" / "Financially
    // Astute Clubs" / "financiallyastuteclubs.com" / "Saguaro" text.
    expect(panel, "soa-footer testid must not render").not.toMatch(/data-testid="soa-footer"/);
    expect(panel, "no Hypothetical Illustration attribution").not.toMatch(/Hypothetical Illustration/);
    expect(panel, "no Financially Astute attribution").not.toMatch(/Financially Astute/);
    expect(panel, "no financiallyastuteclubs.com link").not.toMatch(/financiallyastuteclubs/);
    expect(panel).toMatch(/soa\.operatingRows\.map/);
    expect(panel).toMatch(/soa\.capitalRows/);

    // Row renderer handles every row kind the service ships.
    const row = sliceFn("StatementRow");
    expect(row.length, "StatementRow body must be findable").toBeGreaterThan(0);
    for (const kind of [
      "section-band", "capital-band", "capital-divider",
      "capital-intro", "commentary", "noi-band", "noi-after",
      "capital-total", "net-combined",
    ]) {
      expect(row, `StatementRow must handle kind="${kind}"`).toMatch(new RegExp(`case "${kind}"`));
    }
    // NOI band uses the locked dark-green hex `bg-club-green-900`
    // matching chapter II's scorecard header — single source of truth
    // for the dark-green band colour on the page.
    expect(row).toMatch(/bg-club-green-900/);

    // Variance formatting helpers — parens for negatives, em-dash
    // for null / zero, tone class driven by sign.
    const valueFn = sliceFn("formatStatementValue");
    expect(valueFn).toMatch(/return "—"/);
    expect(valueFn).toMatch(/return value < 0 \? `\(\$\{str\}\)` : str/);
    const pctFn = sliceFn("formatStatementPct");
    expect(pctFn).toMatch(/return value > 0 \? `\+\$\{pct\}%` : `\$\{pct\}%`/);
    const toneFn = sliceFn("statementVarianceClass");
    expect(toneFn).toMatch(/text-\[#3f7042\]/);
    expect(toneFn).toMatch(/text-\[#8b3520\]/);
  });

  it("Capital Fund chapter V — header chrome + Sources/Uses table + reserve coverage + adequacy + stress test cards", () => {
    // Section wrapper.
    const section = MONTHLY_PAGE.match(/<section id="capital-fund"[\s\S]+?<\/section>/);
    expect(section, "capital-fund section must exist").toBeTruthy();
    expect(section![0]).toMatch(/<CapitalFundPanel\s+pkg=\{pkg\}/);

    // Panel body — header chrome + table + cards + footer.
    const panel = sliceFn("CapitalFundPanel");
    expect(panel.length, "CapitalFundPanel body must be findable").toBeGreaterThan(0);
    expect(panel).toMatch(/data-testid="capital-fund-statement"/);
    expect(panel).toMatch(/data-testid="cf-eyebrow"/);
    expect(panel).toMatch(/data-testid="cf-title"/);
    expect(panel).toMatch(/data-testid="cf-period"/);
    expect(panel).toMatch(/data-testid="cf-intro"/);
    expect(panel).toMatch(/data-testid="cf-statement-number"/);
    expect(panel).toMatch(/data-testid="cf-document-chip"/);
    expect(panel).toMatch(/data-testid="cf-prepared-for"/);
    expect(panel).toMatch(/data-testid="cf-table"/);
    expect(panel).toMatch(/data-testid="cf-column-headers"/);
    expect(panel).toMatch(/data-testid="cf-card-reserve-coverage"/);
    expect(panel).toMatch(/data-testid="cf-card-reserve-adequacy"/);
    expect(panel).toMatch(/data-testid="cf-card-stress-test"/);
    // Reference attribution footer REMOVED 2026-06-15 (production
    // package, not a Saguaro reference illustration).
    expect(panel, "cf-footer testid must not render").not.toMatch(/data-testid="cf-footer"/);
    expect(panel, "no Hypothetical Illustration attribution").not.toMatch(/Hypothetical Illustration/);
    expect(panel, "no Financially Astute attribution").not.toMatch(/Financially Astute/);
    expect(panel, "no financiallyastuteclubs.com link").not.toMatch(/financiallyastuteclubs/);
    // Body reads from cf.rows + cf.reserveCoverage + cf.reserveAdequacy + cf.stressTest.
    expect(panel).toMatch(/cf\.rows\.map/);
    expect(panel).toMatch(/cf\.reserveCoverage\.markers\.map/);
    expect(panel).toMatch(/cf\.reserveAdequacy\.map/);
    // Column headers flow from cf.columnHeaders (NOT inline strings).
    expect(panel).toMatch(/\{cf\.columnHeaders\.annualBudget\}/);
    expect(panel).toMatch(/\{cf\.columnHeaders\.ytdActual\}/);
    expect(panel).toMatch(/\{cf\.columnHeaders\.remaining\}/);
    // Period label is sourced from the package field, NOT hardcoded.
    expect(panel).toMatch(/\{cf\.periodLabel\}/);

    // Row renderer handles every row kind.
    const row = sliceFn("CapitalFundRowRender");
    expect(row.length, "CapitalFundRowRender body must be findable").toBeGreaterThan(0);
    for (const kind of [
      "section-band", "analysis-band", "commentary",
      "summary-band", "subtotal", "net-line",
    ]) {
      expect(row, `CapitalFundRowRender must handle kind="${kind}"`).toMatch(new RegExp(`case "${kind}"`));
    }
    // Pale-blue capital section band hex.
    expect(row).toMatch(/bg-\[#d4e0ec\]/);

    // Value-formatting helper — em-dash for null + zero, parens for
    // negatives, thousands separator for positives.
    const fn = sliceFn("formatCapitalValue");
    expect(fn).toMatch(/return "—"/);
    expect(fn).toMatch(/return value < 0 \? `\(\$\{str\}\)` : str/);

    // Adequacy tone class — favorable green, risk clay-red, neutral.
    const tone = sliceFn("capitalAdequacyToneClass");
    expect(tone).toMatch(/text-\[#3f7042\]/);
    expect(tone).toMatch(/text-\[#8b3520\]/);
  });

  it("Statement of Financial Position chapter VII — vertical layout + Assets + Liabilities + Ratios + Notes (period-derived, reconciliation, no Saguaro footer)", () => {
    const section = MONTHLY_PAGE.match(/<section id="financial-position"[\s\S]+?<\/section>/);
    expect(section, "financial-position section must exist").toBeTruthy();
    expect(section![0]).toMatch(/<StatementOfFinancialPositionPanel\s+pkg=\{pkg\}/);

    const panel = sliceFn("StatementOfFinancialPositionPanel");
    expect(panel.length, "StatementOfFinancialPositionPanel body must be findable").toBeGreaterThan(0);

    // Header chrome.
    expect(panel).toMatch(/data-testid="financial-position"/);
    expect(panel).toMatch(/data-testid="sofp-eyebrow"/);
    expect(panel).toMatch(/data-testid="sofp-title"/);
    expect(panel).toMatch(/data-testid="sofp-period"/);
    expect(panel).toMatch(/data-testid="sofp-intro"/);
    expect(panel).toMatch(/data-testid="sofp-statement-number"/);
    expect(panel).toMatch(/data-testid="sofp-document-chip"/);
    expect(panel).toMatch(/data-testid="sofp-prepared-for"/);

    // Vertical layout — both tables + ratios card + notes.
    expect(panel).toMatch(/data-testid="sofp-assets-table"/);
    expect(panel).toMatch(/data-testid="sofp-assets-column-headers"/);
    expect(panel).toMatch(/data-testid="sofp-liabilities-table"/);
    expect(panel).toMatch(/data-testid="sofp-liabilities-column-headers"/);
    expect(panel).toMatch(/data-testid="sofp-stewardship-ratios"/);
    expect(panel).toMatch(/data-testid="sofp-balance-sheet-notes"/);

    // Bound to service fields, NOT hardcoded.
    expect(panel).toMatch(/sofp\.assetsRows\.map/);
    expect(panel).toMatch(/sofp\.liabilitiesEquityRows\.map/);
    expect(panel).toMatch(/sofp\.stewardshipRatios\.rows\.map/);
    expect(panel).toMatch(/sofp\.balanceSheetNotes\.notes\.map/);
    expect(panel).toMatch(/\{sofp\.periodLabel\}/);
    expect(panel).toMatch(/\{sofp\.assetsColumnHeaders\.current\}/);
    expect(panel).toMatch(/\{sofp\.assetsColumnHeaders\.comparative\}/);
    expect(panel).toMatch(/\{sofp\.liabilitiesColumnHeaders\.current\}/);

    // Reference attribution must NOT appear.
    expect(panel, "no Hypothetical Illustration attribution").not.toMatch(/Hypothetical Illustration/);
    expect(panel, "no Financially Astute attribution").not.toMatch(/Financially Astute/);
    expect(panel, "no financiallyastuteclubs.com link").not.toMatch(/financiallyastuteclubs/);

    // Row renderer handles all 5 row kinds.
    const row = sliceFn("SoFPRowRender");
    expect(row.length, "SoFPRowRender body must be findable").toBeGreaterThan(0);
    for (const kind of [
      "section-band-operating", "section-band-capital",
      "subtotal", "total-mid", "total", "detail",
    ]) {
      expect(row, `SoFPRowRender must handle kind="${kind}"`).toMatch(new RegExp(`case "${kind}"`));
    }

    // Ratio bar tone helper covers the 3 SoFPRatioTone variants.
    const ratioTone = sliceFn("sofpRatioBarFillClass");
    expect(ratioTone).toMatch(/case "favorable"/);
    expect(ratioTone).toMatch(/case "risk"/);
    expect(ratioTone).toMatch(/case "capital"/);
    // Brand-palette hexes match the rest of the package.
    expect(ratioTone).toMatch(/bg-\[#3f7042\]/);
    expect(ratioTone).toMatch(/bg-\[#8b3520\]/);
    expect(ratioTone).toMatch(/bg-\[#3a5a78\]/);
  });

  it("Accounts Receivable Aging chapter VIII — header chrome + 4 KPIs + aging table + membership table + collection notes (period-derived, no Saguaro footer)", () => {
    // Chapter VIII (2026-06-16) sits immediately after Statement of
    // Financial Position and renders the Saguaro-style AR Aging
    // package: 4 KPI cards, a 7-column aging table with status
    // pills, a 5-column membership activity table, and a reactive
    // collection-notes block.
    const section = MONTHLY_PAGE.match(/<section id="ar-aging"[\s\S]+?<\/section>/);
    expect(section, "ar-aging section must exist").toBeTruthy();
    expect(section![0]).toMatch(/<AccountsReceivableAgingPanel\s+pkg=\{pkg\}/);

    const panel = sliceFn("AccountsReceivableAgingPanel");
    expect(panel.length, "AccountsReceivableAgingPanel body must be findable").toBeGreaterThan(0);

    // Header chrome.
    expect(panel).toMatch(/data-testid="ar-aging"/);
    expect(panel).toMatch(/data-testid="ara-eyebrow"/);
    expect(panel).toMatch(/data-testid="ara-title"/);
    expect(panel).toMatch(/data-testid="ara-period"/);
    expect(panel).toMatch(/data-testid="ara-intro"/);
    expect(panel).toMatch(/data-testid="ara-statement-number"/);
    expect(panel).toMatch(/data-testid="ara-document-chip"/);
    expect(panel).toMatch(/data-testid="ara-prepared-for"/);

    // 4 KPI cards + 2 tables + reactive collection notes.
    expect(panel).toMatch(/data-testid="ara-kpi-cards"/);
    expect(panel).toMatch(/data-testid="ara-aging-table"/);
    expect(panel).toMatch(/data-testid="ara-aging-column-headers"/);
    expect(panel).toMatch(/data-testid="ara-membership-table"/);
    expect(panel).toMatch(/data-testid="ara-membership-column-headers"/);
    expect(panel).toMatch(/data-testid="ara-collection-notes"/);
    expect(panel).toMatch(/data-testid="ara-collection-notes-eyebrow"/);
    expect(panel).toMatch(/data-testid="ara-collection-notes-list"/);

    // Bound to service fields, NOT hardcoded.
    expect(panel).toMatch(/ara\.kpiCards\.map/);
    expect(panel).toMatch(/ara\.agingRows\.map/);
    expect(panel).toMatch(/ara\.membershipRows\.map/);
    expect(panel).toMatch(/ara\.collectionNotes\.notes\.map/);
    expect(panel).toMatch(/\{ara\.periodLabel\}/);
    expect(panel).toMatch(/\{ara\.agingColumnHeaders\.current\}/);
    expect(panel).toMatch(/\{ara\.agingColumnHeaders\.days31to60\}/);
    expect(panel).toMatch(/\{ara\.agingColumnHeaders\.over90\}/);
    expect(panel).toMatch(/\{ara\.agingColumnHeaders\.totalBalance\}/);
    expect(panel).toMatch(/\{ara\.membershipColumnHeaders\.current\}/);
    expect(panel).toMatch(/\{ara\.membershipColumnHeaders\.comparative\}/);
    expect(panel).toMatch(/\{ara\.membershipColumnHeaders\.annualForecast\}/);

    // Reference attribution must NOT appear.
    expect(panel, "no Hypothetical Illustration attribution").not.toMatch(/Hypothetical Illustration/);
    expect(panel, "no Financially Astute attribution").not.toMatch(/Financially Astute/);
    expect(panel, "no financiallyastuteclubs.com link").not.toMatch(/financiallyastuteclubs/);

    // Status pill class function covers all 5 tones.
    const pill = sliceFn("arAgingStatusPillClass");
    expect(pill.length, "arAgingStatusPillClass body must be findable").toBeGreaterThan(0);
    for (const tone of ["current", "watch", "collection", "suspended", "write-off-review"]) {
      expect(pill, `arAgingStatusPillClass must handle tone="${tone}"`).toMatch(new RegExp(`case "${tone}"`));
    }

    // KPI tone helper covers favorable + neutral + empty tones.
    const kpi = sliceFn("arKpiToneClass");
    expect(kpi.length, "arKpiToneClass body must be findable").toBeGreaterThan(0);
    expect(kpi).toMatch(/case "favorable"/);
    expect(kpi).toMatch(/case "empty"/);

    // Aging row renderer handles section-band + category + total kinds.
    const row = sliceFn("ARAgingRowRender");
    expect(row.length, "ARAgingRowRender body must be findable").toBeGreaterThan(0);
    for (const kind of ["section-band", "category", "total"]) {
      expect(row, `ARAgingRowRender must handle kind="${kind}"`).toMatch(new RegExp(`case "${kind}"`));
    }
    // Status pill renders with the whitespace-nowrap class so labels
    // never wrap mid-pill (regression guard from the earlier pill bug).
    expect(row).toMatch(/whitespace-nowrap[\s\S]{0,200}arAgingStatusPillClass\(row\.status\.tone\)/);

    // Membership row renderer is wired.
    const mrow = sliceFn("ARMembershipRowRender");
    expect(mrow.length, "ARMembershipRowRender body must be findable").toBeGreaterThan(0);
  });

  it("Operating Statistics chapter IX — header chrome + 6-column table + 4 section bands + 2 focus cards (period-derived month-over-prior-year, no Saguaro footer)", () => {
    // Chapter IX (2026-06-16) opens the Operations & Analytics group.
    // It sits immediately after AR Aging and renders the Saguaro-style
    // Operating Statistics surface: a 6-column statistics table with
    // section bands (Golf Operations / Food & Beverage / Member
    // Engagement / Payroll & Labor) plus two Focus Area cards
    // (Operating Focus + Capital Focus) that close the chapter.
    const section = MONTHLY_PAGE.match(/<section id="operating-statistics"[\s\S]+?<\/section>/);
    expect(section, "operating-statistics section must exist").toBeTruthy();
    expect(section![0]).toMatch(/<OperatingStatisticsPanel\s+pkg=\{pkg\}/);

    const panel = sliceFn("OperatingStatisticsPanel");
    expect(panel.length, "OperatingStatisticsPanel body must be findable").toBeGreaterThan(0);

    // Header chrome.
    expect(panel).toMatch(/data-testid="operating-statistics"/);
    expect(panel).toMatch(/data-testid="os-eyebrow"/);
    expect(panel).toMatch(/data-testid="os-title"/);
    expect(panel).toMatch(/data-testid="os-period"/);
    expect(panel).toMatch(/data-testid="os-intro"/);
    expect(panel).toMatch(/data-testid="os-statement-number"/);
    expect(panel).toMatch(/data-testid="os-document-chip"/);
    expect(panel).toMatch(/data-testid="os-prepared-for"/);

    // Statistics table + focus grid.
    expect(panel).toMatch(/data-testid="os-table"/);
    expect(panel).toMatch(/data-testid="os-column-headers"/);
    expect(panel).toMatch(/data-testid="os-focus-grid"/);

    // Bound to service fields, NOT hardcoded.
    expect(panel).toMatch(/os\.rows\.map/);
    expect(panel).toMatch(/os\.focusCards\.map/);
    expect(panel).toMatch(/\{os\.periodLabel\}/);
    expect(panel).toMatch(/\{os\.columnHeaders\.currentActual\}/);
    expect(panel).toMatch(/\{os\.columnHeaders\.priorYearActual\}/);
    expect(panel).toMatch(/\{os\.columnHeaders\.change\}/);
    expect(panel).toMatch(/\{os\.columnHeaders\.budget\}/);
    expect(panel).toMatch(/\{os\.columnHeaders\.vsBudget\}/);

    // Reference attribution must NOT appear.
    expect(panel, "no Saguaro attribution").not.toMatch(/Saguaro/i);
    expect(panel, "no Hypothetical Illustration attribution").not.toMatch(/Hypothetical Illustration/);
    expect(panel, "no Financially Astute attribution").not.toMatch(/Financially Astute/);
    expect(panel, "no financiallyastuteclubs.com link").not.toMatch(/financiallyastuteclubs/);

    // Row renderer handles section-band + stat kinds.
    const row = sliceFn("OperatingStatRowRender");
    expect(row.length, "OperatingStatRowRender body must be findable").toBeGreaterThan(0);
    expect(row).toMatch(/kind === "section-band"/);
    // Stat-row branch references tones + values.
    expect(row).toMatch(/row\.values/);
    expect(row).toMatch(/row\.tones/);

    // Tone class covers all three tones (favorable / risk / neutral).
    const tone = sliceFn("operatingStatToneClass");
    expect(tone.length, "operatingStatToneClass body must be findable").toBeGreaterThan(0);
    for (const t of ["favorable", "risk", "neutral"]) {
      expect(tone, `operatingStatToneClass must handle "${t}"`).toMatch(new RegExp(`case "${t}"`));
    }

    // Focus card renderer + class function cover both accent palettes.
    const fcrender = sliceFn("FocusCardRender");
    expect(fcrender.length, "FocusCardRender body must be findable").toBeGreaterThan(0);
    const fcclass = sliceFn("focusCardClass");
    expect(fcclass.length, "focusCardClass body must be findable").toBeGreaterThan(0);
    expect(fcclass).toMatch(/"rust"/);
    // Slate is the else branch — confirm the slate-tinted background
    // class string is referenced.
    expect(fcclass).toMatch(/#4a6280/);
  });

  it("Departmental P&L Summary chapter X — header chrome + management notice + 6 cards in responsive grid + department notes (period-derived copy, no Saguaro footer)", () => {
    // Chapter X (2026-06-16) is the second chapter of the Operations
    // & Analytics group and sits immediately after Operating
    // Statistics. Six dark-green department cards in a 1 / 2 / 3-col
    // responsive grid, a warm management-document notice, and an
    // arrow-bullet department-notes list.
    const section = MONTHLY_PAGE.match(/<section id="departmental-p-and-l"[\s\S]+?<\/section>/);
    expect(section, "departmental-p-and-l section must exist").toBeTruthy();
    expect(section![0]).toMatch(/<DepartmentalPLSummaryPanel\s+pkg=\{pkg\}/);

    const panel = sliceFn("DepartmentalPLSummaryPanel");
    expect(panel.length, "DepartmentalPLSummaryPanel body must be findable").toBeGreaterThan(0);

    // Header chrome.
    expect(panel).toMatch(/data-testid="departmental-p-and-l"/);
    expect(panel).toMatch(/data-testid="dpl-eyebrow"/);
    expect(panel).toMatch(/data-testid="dpl-title"/);
    expect(panel).toMatch(/data-testid="dpl-period"/);
    expect(panel).toMatch(/data-testid="dpl-intro"/);
    expect(panel).toMatch(/data-testid="dpl-statement-number"/);
    expect(panel).toMatch(/data-testid="dpl-document-chip"/);
    expect(panel).toMatch(/data-testid="dpl-prepared-for"/);

    // Management notice + card grid + notes block.
    expect(panel).toMatch(/data-testid="dpl-management-notice"/);
    expect(panel).toMatch(/data-testid="dpl-management-notice-eyebrow"/);
    expect(panel).toMatch(/data-testid="dpl-card-grid"/);
    expect(panel).toMatch(/data-testid="dpl-notes"/);
    expect(panel).toMatch(/data-testid="dpl-notes-eyebrow"/);
    expect(panel).toMatch(/data-testid="dpl-notes-list"/);

    // Responsive grid — 1 / 2 / 3 cols breakpoints.
    expect(panel).toMatch(/grid-cols-1[\s\S]{0,80}md:grid-cols-2[\s\S]{0,80}lg:grid-cols-3/);

    // Bound to service fields, NOT hardcoded.
    expect(panel).toMatch(/dpl\.cards\.map/);
    expect(panel).toMatch(/dpl\.notes\.items\.map/);
    expect(panel).toMatch(/\{dpl\.periodLabel\}/);
    expect(panel).toMatch(/\{dpl\.managementNotice\.eyebrow\}/);
    expect(panel).toMatch(/\{dpl\.managementNotice\.body\}/);

    // Reference attribution must NOT appear.
    expect(panel, "no Saguaro attribution").not.toMatch(/Saguaro/i);
    expect(panel, "no Hypothetical Illustration attribution").not.toMatch(/Hypothetical Illustration/);
    expect(panel, "no Financially Astute attribution").not.toMatch(/Financially Astute/);
    expect(panel, "no financiallyastuteclubs.com link").not.toMatch(/financiallyastuteclubs/);

    // Card renderer renders pre-formatted row labels + tone-coloured
    // values + the dark-green header band with the pill on the right.
    const cardRender = sliceFn("DepartmentCardRender");
    expect(cardRender.length, "DepartmentCardRender body must be findable").toBeGreaterThan(0);
    expect(cardRender).toMatch(/card\.rows\.map/);
    expect(cardRender).toMatch(/bg-club-green-900/);
    expect(cardRender).toMatch(/card\.pill/);

    // Pill class covers all 3 tones.
    const pill = sliceFn("departmentPillClass");
    expect(pill.length, "departmentPillClass body must be findable").toBeGreaterThan(0);
    for (const tone of ["favorable", "risk", "neutral"]) {
      expect(pill, `departmentPillClass must handle tone="${tone}"`).toMatch(new RegExp(`case "${tone}"`));
    }

    // Metric-row class covers all 3 tones.
    const tone = sliceFn("departmentalToneClass");
    expect(tone.length, "departmentalToneClass body must be findable").toBeGreaterThan(0);
    expect(tone).toMatch(/case "favorable"/);
    expect(tone).toMatch(/case "risk"/);
  });

  it("Monthly Weather Summary chapter XI — header chrome + 4 KPI cards + donut + bar chart + events table + 3 correlation cards (premium SVG icons, no emoji, no Saguaro footer)", () => {
    // Chapter XI (2026-06-16) is the third chapter of the Operations
    // & Analytics group and sits immediately after Departmental P&L
    // Summary. 4 dark-green weather KPI cards + a weather-pattern
    // donut + a rounds-by-condition bar chart + a notable weather
    // events table + 3 weather-utilization correlation cards.
    const section = MONTHLY_PAGE.match(/<section id="weather-and-utilization"[\s\S]+?<\/section>/);
    expect(section, "weather-and-utilization section must exist").toBeTruthy();
    expect(section![0]).toMatch(/<MonthlyWeatherSummaryPanel\s+pkg=\{pkg\}/);

    const panel = sliceFn("MonthlyWeatherSummaryPanel");
    expect(panel.length, "MonthlyWeatherSummaryPanel body must be findable").toBeGreaterThan(0);

    // Header chrome.
    expect(panel).toMatch(/data-testid="weather-and-utilization"/);
    expect(panel).toMatch(/data-testid="mws-eyebrow"/);
    expect(panel).toMatch(/data-testid="mws-title"/);
    expect(panel).toMatch(/data-testid="mws-period"/);
    expect(panel).toMatch(/data-testid="mws-intro"/);
    expect(panel).toMatch(/data-testid="mws-statement-number"/);
    expect(panel).toMatch(/data-testid="mws-document-chip"/);
    expect(panel).toMatch(/data-testid="mws-prepared-for"/);

    // KPI grid + events table + correlation grid render in the
    // server panel. The two interactive chart cards (donut + bar)
    // live in the WeatherChartCards client island and are pinned by
    // the separate "interactive WeatherChartCards client island" test.
    expect(panel).toMatch(/data-testid="mws-kpi-grid"/);
    expect(panel).toMatch(/<WeatherChartCards\s+pattern=\{mws\.patternCard\}\s+rounds=\{mws\.roundsCard\}/);
    expect(panel).toMatch(/data-testid="mws-events-table"/);
    expect(panel).toMatch(/data-testid="mws-events-headers"/);
    expect(panel).toMatch(/data-testid="mws-correlation"/);
    expect(panel).toMatch(/data-testid="mws-correlation-grid"/);
    // Utilization-outcome KPI row lifted from Experience Stewardship
    // (2026-06-19): Rounds YTD, Course Utilization, Spend per Member,
    // Spend per Round. Sits directly under the correlation summary,
    // above the closing spacer. Data bindings unchanged: rounds +
    // utilization + spend reads come from the SAME pkg.operatingStats
    // and pkg.weatherUtilization fields the Experience chapter used.
    expect(panel).toMatch(/data-testid="mws-utilization-extension"/);
    expect(panel).toMatch(/data-testid="mws-utilization-extension-grid"/);
    expect(panel).toMatch(/testId="weather-rounds-ytd"/);
    expect(panel).toMatch(/testId="weather-course-utilization"/);
    expect(panel).toMatch(/testId="weather-spend-per-member"/);
    expect(panel).toMatch(/testId="weather-spend-per-round"/);
    // Bindings are pkg.operatingStats / pkg.weatherUtilization, not
    // weather-summary fields.
    expect(panel).toMatch(/value=\{stats\.rounds\.ytd\.toLocaleString\(\)\}/);
    expect(panel).toMatch(/value=\{wx\.courseUtilizationPct\}/);
    expect(panel).toMatch(/value=\{stats\.derived\.spendPerMember\}/);
    expect(panel).toMatch(/value=\{stats\.derived\.spendPerRound\}/);
    // Responsive grid: 1-up mobile, 2-up tablet, 4-up desktop.
    expect(panel).toMatch(/grid-cols-1[\s\S]{0,80}sm:grid-cols-2[\s\S]{0,80}lg:grid-cols-4/);
    // Source-order check: utilization-extension sits AFTER the
    // correlation summary and BEFORE the closing spacer.
    {
      const corrIdx = panel.indexOf('data-testid="mws-correlation"');
      const extIdx  = panel.indexOf('data-testid="mws-utilization-extension"');
      const spacerIdx = panel.indexOf('aria-hidden="true"');
      expect(corrIdx, "correlation summary must render").toBeGreaterThan(0);
      expect(extIdx, "utilization extension must render after correlation summary").toBeGreaterThan(corrIdx);
      expect(spacerIdx, "closing spacer must render after utilization extension").toBeGreaterThan(extIdx);
    }

    // Bound to service fields, NOT hardcoded.
    expect(panel).toMatch(/mws\.kpiCards\.map/);
    expect(panel).toMatch(/mws\.eventsTable\.rows\.map/);
    expect(panel).toMatch(/mws\.correlationSummary\.cards\.map/);
    expect(panel).toMatch(/\{mws\.periodLabel\}/);

    // Reference attribution must NOT appear.
    expect(panel, "no Hypothetical Illustration attribution").not.toMatch(/Hypothetical Illustration/);
    expect(panel, "no Financially Astute attribution").not.toMatch(/Financially Astute/);
    expect(panel, "no financiallyastuteclubs.com link").not.toMatch(/financiallyastuteclubs/);

    // Premium SVG icons — the WeatherIcon component wraps a switch
    // over WeatherIconKey and renders inline <svg>, NOT emoji text.
    const icon = sliceFn("WeatherIcon");
    expect(icon.length, "WeatherIcon body must be findable").toBeGreaterThan(0);
    for (const key of ["sun", "rain-cloud", "thermometer", "wind", "golf-flag", "tennis", "dining"]) {
      expect(icon, `WeatherIcon must handle icon="${key}"`).toMatch(new RegExp(`case "${key}"`));
    }
    expect(icon).toMatch(/<svg/);
    // stroke / fill inherit from the surrounding text colour so the
    // icon can be re-tinted by the parent container without a prop
    // change — the spread props pass these as object literals.
    expect(icon).toMatch(/stroke:\s*"currentColor"|stroke="currentColor"/);
    // Hard guard against emoji bytes in the chapter's source slice.
    expect(panel, "panel must not render emoji weather glyphs").not.toMatch(
      /[☀-➿\u{1F300}-\u{1FAFF}]/u,
    );

    // Event pill class covers all 5 documented tones.
    const pill = sliceFn("weatherEventPillClass");
    expect(pill.length, "weatherEventPillClass body must be findable").toBeGreaterThan(0);
    for (const tone of ["heavy-rain", "cold-frost", "high-wind", "prime-conditions", "course-impact"]) {
      expect(pill, `weatherEventPillClass must handle tone="${tone}"`).toMatch(new RegExp(`case "${tone}"`));
    }

    // Correlation card accent helper covers all 3 accent palettes.
    const corrClass = sliceFn("correlationCardClass");
    expect(corrClass.length, "correlationCardClass body must be findable").toBeGreaterThan(0);
    for (const accent of ["green", "slate", "rust"]) {
      expect(corrClass, `correlationCardClass must handle accent="${accent}"`).toMatch(new RegExp(`case "${accent}"`));
    }
  });

  it("Monthly Weather Summary chapter XI — WeatherChartCards client island uses the SHARED chart primitives (2026-06-19 canonical chart system)", () => {
    // The donut + bar chart cards are extracted into a client island
    // (`WeatherChartCards.tsx`) so they can carry hover state +
    // tooltip rendering + the per-datum emphasis treatment. As of
    // 2026-06-19 the island MUST consume the shared chart primitives
    // (`EditorialDonut`, `EditorialInteractiveBarChart`,
    // `ChartTooltip`) rather than hand-roll SVG / hover / tooltip
    // logic. Hand-rolled chart code is forbidden — chart geometry,
    // stroke widths, tooltip styling, and the active-shadow filter
    // all live in `chart-theme.ts` + the primitives.
    const CHARTS_CARD = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/reporting/monthly/WeatherChartCards.tsx"),
      "utf8",
    );
    // Client directive (the wrapper renders hover-state-bearing
    // primitives, which are client components themselves).
    expect(CHARTS_CARD).toMatch(/^"use client";/);
    // Both chart card containers + the grid wrapper. The card
    // testids are passed via the `testid` prop on the inline
    // FpChartCard wrapper (which emits `data-testid={testid}`).
    expect(CHARTS_CARD).toMatch(/testid="mws-pattern-card"/);
    expect(CHARTS_CARD).toMatch(/testid="mws-rounds-card"/);
    expect(CHARTS_CARD).toMatch(/data-testid="mws-charts-grid"/);
    // The wrapper consumes the SHARED primitives.
    expect(CHARTS_CARD).toMatch(/from "@\/components\/reporting\/EditorialDonut"/);
    expect(CHARTS_CARD).toMatch(/from "@\/components\/reporting\/EditorialInteractiveBarChart"/);
    expect(CHARTS_CARD).toMatch(/<EditorialDonut\b/);
    expect(CHARTS_CARD).toMatch(/<EditorialInteractiveBarChart\b/);
    // FP chrome adoption: dark-green header band + KPI ribbon +
    // pill chip on the right. The Weather cards must look like
    // they come from the same product family as the FP cards.
    expect(CHARTS_CARD).toMatch(/bg-club-green-900/);
    expect(CHARTS_CARD).toMatch(/pillLabel="WEATHER PATTERN"/);
    expect(CHARTS_CARD).toMatch(/pillLabel="ROUNDS BY CONDITION"/);
    // Card chrome is static — no lift, no hover-driven outline, no
    // hover shadow. The hover model is per-datum only.
    expect(
      CHARTS_CARD,
      "card container MUST NOT carry the green outline class",
    ).not.toMatch(/border-club-green-700\/70/);
    expect(
      CHARTS_CARD,
      "card container MUST NOT carry the lift transform",
    ).not.toMatch(/-translate-y-0\.5/);
    expect(
      CHARTS_CARD,
      "card container MUST NOT carry a data-hovered attribute (per-datum emphasis instead)",
    ).not.toMatch(/data-hovered=/);
    // Hand-rolled chart code is forbidden — primitives own it now.
    expect(
      CHARTS_CARD,
      "WeatherChartCards MUST NOT hand-roll an SVG <svg viewBox> — primitives own geometry",
    ).not.toMatch(/<svg\s/);
    expect(
      CHARTS_CARD,
      "WeatherChartCards MUST NOT hand-roll feDropShadow — primitives own the active-shadow filter",
    ).not.toMatch(/feDropShadow/);
    expect(
      CHARTS_CARD,
      "WeatherChartCards MUST NOT declare its own radius / stroke / activeStroke constants — chart-theme.ts owns donut geometry",
    ).not.toMatch(/const (radius|restStroke|activeStroke)\s*=/);
    expect(
      CHARTS_CARD,
      "WeatherChartCards MUST NOT carry a local ChartTooltip implementation — the shared ChartTooltip is the single tooltip",
    ).not.toMatch(/function ChartTooltip\b/);
    // Tooltip styling itself moved to the SHARED ChartTooltip
    // primitive (see tests/reporting-chart-system.test.ts for the
    // glass-overlay / 85% bg / no-backdrop-blur / cream-typography
    // contract). The chapter XI wrapper just supplies the per-chart
    // testidPrefix and the buildTooltip callback that produces the
    // string body.
    expect(CHARTS_CARD).toMatch(/testidPrefix="mws-pattern"/);
    expect(CHARTS_CARD).toMatch(/testidPrefix="mws-rounds"/);
    expect(CHARTS_CARD, "no native <title> SVG tooltip — premium overlay only").not.toMatch(/<title>/);
    // Tooltip body strings are still composed in the wrapper since
    // they are chapter-specific copy. The primitives accept a
    // `buildTooltip` callback that returns { label, rows } — this is
    // where the chapter XI tooltip strings live.
    // Donut tooltip surfaces: condition + days + percentage of period.
    expect(CHARTS_CARD).toMatch(/% of period/);
    // Bar tooltip surfaces: condition + avg rounds + variance vs.
    // period average.
    expect(CHARTS_CARD).toMatch(/avg rounds\/day/);
    expect(CHARTS_CARD).toMatch(/vs\. period avg/);
  });

  it("Monthly Weather Summary chapter XI — events table column template gives the pill column enough room (no overlap with description)", () => {
    // Event pill column must hold the widest pill text ("PRIME
    // CONDITIONS" at ~9.5rem rendered) without bleeding into the
    // adjacent description column. Date is compact, Description is
    // the only flexible track, Golf / F&B / Follow-Up are fixed.
    expect(MONTHLY_PAGE).toMatch(/const WEATHER_EVENTS_GRID\s*=\s*\n?\s*"5rem 11rem minmax\(0, 2fr\) 7rem 7rem 9rem"/);
    // Column gap pinned at 1rem so the pill never butts up against
    // the description text.
    expect(MONTHLY_PAGE).toMatch(/const WEATHER_EVENTS_GRID_GAP\s*=\s*"1rem"/);
  });

  it("Monthly Weather Summary chapter XI — KPI cards use one uniform white/cream treatment (no per-tone colored icons, values, or labels)", () => {
    // Every weather KPI card MUST render identically: same icon
    // color, value color, label color. The service-side `tone` field
    // is retained as a future-proofing handle but the panel renders
    // every card with the Sunny Days treatment as the standard.
    const kpiRender = sliceFn("WeatherKpiCardRender");
    expect(kpiRender.length, "WeatherKpiCardRender body must be findable").toBeGreaterThan(0);
    // Icon, value, and label all use the same cream color tokens —
    // no per-card branching off `card.tone`.
    expect(kpiRender).toMatch(/className="h-9 w-9 text-club-cream"/);
    expect(kpiRender).toMatch(/text-\[32px\] leading-none tabular-nums text-club-cream/);
    expect(kpiRender).toMatch(/uppercase tracking-\[0\.22em\] text-\[10px\] text-club-cream\/75/);
    expect(
      kpiRender,
      "KPI render MUST NOT call the per-tone class helper",
    ).not.toMatch(/weatherKpiValueClass/);
    // The dead per-tone helper has been removed from the page.
    expect(
      MONTHLY_PAGE,
      "the per-tone color helper has been deleted (uniform treatment instead)",
    ).not.toMatch(/function weatherKpiValueClass/);
    // No category-specific accent colours appear in the KPI card
    // body — favourable green / risk clay must not leak into the
    // icon, value, or label.
    expect(kpiRender, "no favourable-green KPI accent").not.toMatch(/text-\[#a6c39a\]/);
    expect(kpiRender, "no risk-clay KPI accent").not.toMatch(/text-\[#e5b4a4\]/);
  });

  it("Monthly Weather Summary chapter XI — rail label is 'Weather & Utilization' but the section title remains 'Monthly Weather Summary'", () => {
    expect(REPORTING_LAYOUT).toMatch(/label: "Weather & Utilization"/);
    expect(REPORTING_LAYOUT, "rail label MUST NOT include 'Monthly'").not.toMatch(/label: "Monthly Weather/);
  });

  it("Departmental Payroll Analysis chapter XII — header chrome + 4 KPI cards + interactive chart island + summary table with dark-green Club Total band", () => {
    // Chapter XII (2026-06-17) sits immediately after Monthly Weather
    // Summary as the fourth chapter of the Operations & Analytics
    // group. 4 KPI cards + 2×2 interactive chart grid (in the
    // `PayrollChartCards` client island) + a detailed MTD/YTD
    // summary table with a Club Total row rendered in the dark-green
    // band.
    const section = MONTHLY_PAGE.match(/<section id="payroll-analysis"[\s\S]+?<\/section>/);
    expect(section, "payroll-analysis section must exist").toBeTruthy();
    expect(section![0]).toMatch(/<DepartmentalPayrollAnalysisPanel\s+pkg=\{pkg\}/);

    const panel = sliceFn("DepartmentalPayrollAnalysisPanel");
    expect(panel.length, "DepartmentalPayrollAnalysisPanel body must be findable").toBeGreaterThan(0);

    // Header chrome.
    expect(panel).toMatch(/data-testid="payroll-analysis"/);
    expect(panel).toMatch(/data-testid="dpa-eyebrow"/);
    expect(panel).toMatch(/data-testid="dpa-title"/);
    expect(panel).toMatch(/data-testid="dpa-period"/);
    expect(panel).toMatch(/data-testid="dpa-intro"/);
    expect(panel).toMatch(/data-testid="dpa-statement-number"/);
    expect(panel).toMatch(/data-testid="dpa-document-chip"/);
    expect(panel).toMatch(/data-testid="dpa-prepared-for"/);
    expect(panel).toMatch(/data-testid="dpa-kpi-grid"/);
    expect(panel).toMatch(/data-testid="dpa-table"/);
    expect(panel).toMatch(/data-testid="dpa-table-eyebrow"/);
    expect(panel).toMatch(/data-testid="dpa-table-headers"/);

    // Bound to service fields, NOT hardcoded.
    expect(panel).toMatch(/dpa\.kpiCards\.map/);
    expect(panel).toMatch(/dpa\.table\.rows\.map/);
    expect(panel).toMatch(/dpa\.table\.total/);
    expect(panel).toMatch(/dpa\.charts/);
    expect(panel).toMatch(/\{dpa\.periodLabel\}/);

    // Interactive 4-chart grid lives in the client island.
    expect(panel).toMatch(/<PayrollChartCards\s+charts=\{dpa\.charts\}/);

    // Reference attribution must NOT appear.
    expect(panel, "no Saguaro attribution").not.toMatch(/Saguaro/i);
    expect(panel, "no Hypothetical Illustration attribution").not.toMatch(/Hypothetical Illustration/);
    expect(panel, "no Financially Astute attribution").not.toMatch(/Financially Astute/);
    expect(panel, "no financiallyastuteclubs.com link").not.toMatch(/financiallyastuteclubs/);

    // Table row renderer handles department + total kinds, with the
    // Club Total band painted dark green + cream text.
    const rowRender = sliceFn("PayrollTableRowRender");
    expect(rowRender.length, "PayrollTableRowRender body must be findable").toBeGreaterThan(0);
    expect(rowRender).toMatch(/row\.kind === "total"/);
    expect(rowRender).toMatch(/bg-club-green-900/);
    expect(rowRender).toMatch(/text-club-cream/);
    // Variance cells expose data-tone for runtime + favourable/risk
    // tints.
    expect(rowRender).toMatch(/data-testid=\{`dpa-row-\$\{row\.key\}-mtd-var`\}/);
    expect(rowRender).toMatch(/data-testid=\{`dpa-row-\$\{row\.key\}-ytd-var`\}/);

    // KPI card render handles all 4 treatments + tone-driven value
    // colour for non-primary cards.
    const kpiClass = sliceFn("payrollKpiCardClass");
    expect(kpiClass.length, "payrollKpiCardClass body must be findable").toBeGreaterThan(0);
    for (const t of ["primary", "favorable", "neutral", "info"]) {
      expect(kpiClass, `payrollKpiCardClass must handle treatment="${t}"`).toMatch(new RegExp(`case "${t}"`));
    }
  });

  it("Departmental Payroll Analysis chapter XII — PayrollChartCards consumes SHARED editorial-chart primitives (founder rule 2026-07-05 v15.6)", () => {
    const CHARTS_CARD = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/reporting/monthly/PayrollChartCards.tsx"),
      "utf8",
    );
    // Client directive.
    expect(CHARTS_CARD).toMatch(/^"use client";/);
    // Four chart card testids + the 2×2 grid.
    expect(CHARTS_CARD).toMatch(/data-testid="payroll-charts-grid"/);
    expect(CHARTS_CARD).toMatch(/data-testid="payroll-grouped-card"/);
    expect(CHARTS_CARD).toMatch(/data-testid="payroll-variance-card"/);
    expect(CHARTS_CARD).toMatch(/data-testid="payroll-distribution-card"/);
    expect(CHARTS_CARD).toMatch(/data-testid="payroll-stacked-card"/);
    // Four chart wrappers (preserved so downstream selectors keep working).
    expect(CHARTS_CARD).toMatch(/data-testid="payroll-grouped-bar-chart"/);
    expect(CHARTS_CARD).toMatch(/data-testid="payroll-variance-bar-chart"/);
    expect(CHARTS_CARD).toMatch(/data-testid="payroll-stacked-bar-chart"/);
    // v15.6 — the SHARED primitives are the single source of truth for
    // typography, gridlines, axes, legends, and tooltip styling. The
    // previous bespoke SVG implementations of the four payroll charts
    // are retired.
    expect(CHARTS_CARD).toMatch(
      /from "@\/components\/reporting\/EditorialGroupedBarChart"/,
    );
    expect(CHARTS_CARD).toMatch(
      /from "@\/components\/reporting\/EditorialBarChart"/,
    );
    expect(CHARTS_CARD).toMatch(
      /from "@\/components\/reporting\/EditorialDonut"/,
    );
    // Donut delegates to EditorialDonut with the payroll testid prefix.
    expect(CHARTS_CARD).toMatch(/testidPrefix="payroll-distribution-donut"/);
    // Card chrome is static — no hover lift, no green outline.
    expect(CHARTS_CARD).toMatch(/const cardClass\s*=/);
    expect(CHARTS_CARD, "card MUST NOT carry hover lift").not.toMatch(/-translate-y-0\.5/);
    expect(CHARTS_CARD, "card MUST NOT carry the green outline class").not.toMatch(/border-club-green-700\/70/);
    expect(CHARTS_CARD, "no data-hovered attribute on the card").not.toMatch(/data-hovered=/);
    // v15.6 — no bespoke tooltip; the shared ChartTooltip owns hover
    // via EditorialDonut. Payroll must NOT hand-roll its own tooltip
    // Tailwind classes anymore.
    expect(CHARTS_CARD, "no bespoke bg-club-green-900/85 tooltip").not.toMatch(/bg-club-green-900\/85/);
    expect(
      CHARTS_CARD,
      "tooltip MUST NOT carry a backdrop-blur className",
    ).not.toMatch(/className="[^"]*backdrop-blur/);
    // No native SVG title element — premium overlay only.
    expect(CHARTS_CARD, "no native <title> SVG tooltip").not.toMatch(/<title>/);
    // v15.6 — no bespoke SVG geometry constants (radius / stroke are
    // now sourced from DONUT_GEOMETRY via EditorialDonut).
    expect(CHARTS_CARD, "donut radius must be sourced from DONUT_GEOMETRY").not.toMatch(/const radius\s*=\s*80/);
    expect(CHARTS_CARD, "donut stroke must be sourced from DONUT_GEOMETRY").not.toMatch(/const restStroke\s*=\s*36/);
  });

  it("Departmental Payroll Analysis chapter XII — rail label is 'Payroll Analysis' but the section title remains 'Departmental Payroll Analysis'", () => {
    expect(REPORTING_LAYOUT).toMatch(/label: "Payroll Analysis"/);
    expect(REPORTING_LAYOUT, "rail label MUST NOT include 'Departmental'").not.toMatch(/label: "Departmental Payroll/);
  });

  it("Food & Beverage Statistics chapter XIII — header chrome + 4 KPI cards + interactive 4-chart island", () => {
    // Chapter XIII (2026-06-18) sits immediately after Departmental
    // Payroll Analysis as the fifth chapter of the Operations &
    // Analytics group. 4 KPI cards + 2×2 interactive chart grid
    // (Monthly Revenue vs Cost / Revenue by Category donut / Monthly
    // Cover Counts / Food Cost % by Month line) hosted in the
    // `FoodBeverageChartCards` client island.
    const section = MONTHLY_PAGE.match(/<section id="f-and-b-statistics"[\s\S]+?<\/section>/);
    expect(section, "f-and-b-statistics section must exist").toBeTruthy();
    expect(section![0]).toMatch(/<FoodBeverageStatisticsPanel\s+pkg=\{pkg\}/);

    const panel = sliceFn("FoodBeverageStatisticsPanel");
    expect(panel.length, "FoodBeverageStatisticsPanel body must be findable").toBeGreaterThan(0);

    // Header chrome.
    expect(panel).toMatch(/data-testid="f-and-b-statistics"/);
    expect(panel).toMatch(/data-testid="fbs-eyebrow"/);
    expect(panel).toMatch(/data-testid="fbs-title"/);
    expect(panel).toMatch(/data-testid="fbs-period"/);
    expect(panel).toMatch(/data-testid="fbs-intro"/);
    expect(panel).toMatch(/data-testid="fbs-statement-number"/);
    expect(panel).toMatch(/data-testid="fbs-document-chip"/);
    expect(panel).toMatch(/data-testid="fbs-prepared-for"/);
    expect(panel).toMatch(/data-testid="fbs-kpi-grid"/);
    // Secondary KPI row sits directly below the primary row and uses
    // the same grid template so the cards column-align.
    expect(panel).toMatch(/data-testid="fbs-kpi-grid-secondary"/);
    // Same grid + breakpoints + gap on both rows so they read as one
    // continuous strip.
    expect(panel).toMatch(/grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4[\s\S]*fbs\.kpiCards\.map[\s\S]*grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4[\s\S]*fbs\.secondaryKpiCards\.map/);

    // Bound to service fields, NOT hardcoded.
    expect(panel).toMatch(/fbs\.kpiCards\.map/);
    expect(panel).toMatch(/fbs\.secondaryKpiCards\.map/);
    expect(panel).toMatch(/\{fbs\.periodLabel\}/);

    // Interactive 4-chart grid lives in the client island.
    expect(panel).toMatch(/<FoodBeverageChartCards\s+charts=\{fbs\.charts\}/);

    // Reference attribution must NOT appear.
    expect(panel, "no Saguaro attribution").not.toMatch(/Saguaro/i);
    expect(panel, "no Hypothetical Illustration attribution").not.toMatch(/Hypothetical Illustration/);
    expect(panel, "no Financially Astute attribution").not.toMatch(/Financially Astute/);
    expect(panel, "no financiallyastuteclubs.com link").not.toMatch(/financiallyastuteclubs/);

    // KPI card render handles all 4 treatments (primary / favorable /
    // neutral / watch).
    const kpiClass = sliceFn("fbKpiCardClass");
    expect(kpiClass.length, "fbKpiCardClass body must be findable").toBeGreaterThan(0);
    for (const t of ["primary", "favorable", "neutral", "watch"]) {
      expect(kpiClass, `fbKpiCardClass must handle treatment="${t}"`).toMatch(new RegExp(`case "${t}"`));
    }
  });

  it("Food & Beverage Statistics chapter XIII — interactive FoodBeverageChartCards client island (per-datum hover + translucent tooltip)", () => {
    const CHARTS_CARD = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/reporting/monthly/FoodBeverageChartCards.tsx"),
      "utf8",
    );
    // Client directive.
    expect(CHARTS_CARD).toMatch(/^"use client";/);
    // Four chart cards + the 2×2 grid.
    expect(CHARTS_CARD).toMatch(/data-testid="fb-charts-grid"/);
    expect(CHARTS_CARD).toMatch(/data-testid="fb-monthly-card"/);
    expect(CHARTS_CARD).toMatch(/data-testid="fb-category-card"/);
    expect(CHARTS_CARD).toMatch(/data-testid="fb-covers-card"/);
    expect(CHARTS_CARD).toMatch(/data-testid="fb-food-cost-card"/);
    // Four chart SVG testids.
    expect(CHARTS_CARD).toMatch(/data-testid="fb-monthly-revenue-cost-chart"/);
    expect(CHARTS_CARD).toMatch(/data-testid="fb-category-donut"/);
    expect(CHARTS_CARD).toMatch(/data-testid="fb-monthly-covers-chart"/);
    expect(CHARTS_CARD).toMatch(/data-testid="fb-food-cost-line-chart"/);
    // Card chrome is static.
    expect(CHARTS_CARD).toMatch(/const cardClass\s*=/);
    expect(CHARTS_CARD, "card MUST NOT carry hover lift").not.toMatch(/-translate-y-0\.5/);
    expect(CHARTS_CARD, "card MUST NOT carry the green outline class").not.toMatch(/border-club-green-700\/70/);
    expect(CHARTS_CARD, "no data-hovered attribute on the card").not.toMatch(/data-hovered=/);
    // Per-datum emphasis: data-active toggled on the hovered bar /
    // slice / point.
    expect(CHARTS_CARD).toMatch(/data-active=/);
    // Bar y + height are unchanged on hover (no liftPx).
    expect(CHARTS_CARD, "bars must NOT lift on hover").not.toMatch(/liftPx/);
    // Donut geometry matches the established standard (r=80,
    // stroke=36 at rest).
    expect(CHARTS_CARD).toMatch(/const radius\s*=\s*80/);
    expect(CHARTS_CARD).toMatch(/const restStroke\s*=\s*36/);
    // Tooltip glass-overlay treatment.
    expect(CHARTS_CARD).toMatch(/data-testid="fb-chart-tooltip"/);
    expect(CHARTS_CARD).toMatch(/bg-club-green-900\/85/);
    expect(
      CHARTS_CARD,
      "tooltip MUST NOT carry a backdrop-blur className",
    ).not.toMatch(/className="[^"]*backdrop-blur/);
    expect(CHARTS_CARD, "no native <title> SVG tooltip").not.toMatch(/<title>/);
  });

  it("Food & Beverage Statistics chapter XIII — rail label is 'F&B Statistics' but the section title remains 'Food & Beverage Statistics'", () => {
    expect(REPORTING_LAYOUT).toMatch(/label: "F&B Statistics"/);
    expect(REPORTING_LAYOUT, "rail label MUST NOT include 'Food & Beverage'").not.toMatch(/label: "Food & Beverage/);
  });

  it("Inventory Analysis chapter XIV — header chrome + 4 KPI cards + 2-up interactive chart island + flags/action table with priority pills", () => {
    // Chapter XIV (2026-06-19) sits immediately after Food & Beverage
    // Statistics as the sixth and final chapter of the Operations &
    // Analytics group. 4 KPI cards + 2-up interactive chart grid
    // (Inventory Turnover by Category bars + F&B Inventory Balances
    // monthly multi-line) + Inventory Management Flags & Action
    // Items table with priority pills.
    const section = MONTHLY_PAGE.match(/<section id="inventory-analysis"[\s\S]+?<\/section>/);
    expect(section, "inventory-analysis section must exist").toBeTruthy();
    expect(section![0]).toMatch(/<InventoryAnalysisPanel\s+pkg=\{pkg\}/);

    const panel = sliceFn("InventoryAnalysisPanel");
    expect(panel.length, "InventoryAnalysisPanel body must be findable").toBeGreaterThan(0);

    // Header chrome.
    expect(panel).toMatch(/data-testid="inventory-analysis"/);
    expect(panel).toMatch(/data-testid="inv-eyebrow"/);
    expect(panel).toMatch(/data-testid="inv-title"/);
    expect(panel).toMatch(/data-testid="inv-period"/);
    expect(panel).toMatch(/data-testid="inv-intro"/);
    expect(panel).toMatch(/data-testid="inv-statement-number"/);
    expect(panel).toMatch(/data-testid="inv-document-chip"/);
    expect(panel).toMatch(/data-testid="inv-prepared-for"/);
    expect(panel).toMatch(/data-testid="inv-kpi-grid"/);
    expect(panel).toMatch(/data-testid="inv-action-table"/);
    expect(panel).toMatch(/data-testid="inv-action-eyebrow"/);
    expect(panel).toMatch(/data-testid="inv-action-headers"/);

    // Bound to service fields, NOT hardcoded.
    expect(panel).toMatch(/inv\.kpiCards\.map/);
    expect(panel).toMatch(/inv\.actionTable\.rows\.map/);
    expect(panel).toMatch(/\{inv\.periodLabel\}/);

    // Interactive 2-up chart grid lives in the client island.
    expect(panel).toMatch(/<InventoryChartCards\s+charts=\{inv\.charts\}/);

    // Reference attribution must NOT appear.
    expect(panel, "no Hypothetical Illustration attribution").not.toMatch(/Hypothetical Illustration/);
    expect(panel, "no Financially Astute attribution").not.toMatch(/Financially Astute/);
    expect(panel, "no financiallyastuteclubs.com link").not.toMatch(/financiallyastuteclubs/);

    // KPI card render handles all 4 treatments.
    const kpiClass = sliceFn("inventoryKpiCardClass");
    expect(kpiClass.length, "inventoryKpiCardClass body must be findable").toBeGreaterThan(0);
    for (const t of ["primary", "favorable", "neutral", "watch"]) {
      expect(kpiClass, `inventoryKpiCardClass must handle treatment="${t}"`).toMatch(new RegExp(`case "${t}"`));
    }

    // Priority pill handles all 3 documented priorities + uses
    // whitespace-nowrap so the pill never wraps mid-pill.
    const pillClass = sliceFn("inventoryPriorityPillClass");
    expect(pillClass.length, "inventoryPriorityPillClass body must be findable").toBeGreaterThan(0);
    for (const p of ["action", "watch", "positive"]) {
      expect(pillClass, `inventoryPriorityPillClass must handle priority="${p}"`).toMatch(new RegExp(`case "${p}"`));
    }

    // Action row renderer attaches whitespace-nowrap to the pill so it
    // never wraps (regression guard from the AR Aging pill bug).
    const actionRow = sliceFn("InventoryActionRowRender");
    expect(actionRow.length, "InventoryActionRowRender body must be findable").toBeGreaterThan(0);
    expect(actionRow).toMatch(/whitespace-nowrap[\s\S]{0,200}inventoryPriorityPillClass\(row\.priority\)/);
  });

  it("Inventory Analysis chapter XIV — interactive InventoryChartCards client island (per-datum hover + translucent tooltip)", () => {
    const CHARTS_CARD = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/reporting/monthly/InventoryChartCards.tsx"),
      "utf8",
    );
    expect(CHARTS_CARD).toMatch(/^"use client";/);
    expect(CHARTS_CARD).toMatch(/data-testid="inv-charts-grid"/);
    expect(CHARTS_CARD).toMatch(/data-testid="inv-turnover-card"/);
    expect(CHARTS_CARD).toMatch(/data-testid="inv-balances-card"/);
    expect(CHARTS_CARD).toMatch(/data-testid="inv-turnover-chart"/);
    expect(CHARTS_CARD).toMatch(/data-testid="inv-balances-chart"/);
    // Static card chrome.
    expect(CHARTS_CARD).toMatch(/const cardClass\s*=/);
    expect(CHARTS_CARD, "card MUST NOT carry hover lift").not.toMatch(/-translate-y-0\.5/);
    expect(CHARTS_CARD, "card MUST NOT carry the green outline class").not.toMatch(/border-club-green-700\/70/);
    expect(CHARTS_CARD, "no data-hovered attribute on the card").not.toMatch(/data-hovered=/);
    // Per-datum emphasis; bar y + height unchanged on hover.
    expect(CHARTS_CARD).toMatch(/data-active=/);
    expect(CHARTS_CARD, "bars must NOT lift on hover").not.toMatch(/liftPx/);
    // Three multi-line series for the F&B balances chart (food, wine,
    // liquor) — locked by the SERIES constant.
    expect(CHARTS_CARD).toMatch(/const SERIES:/);
    // Tooltip uses the 85% glass-overlay treatment.
    expect(CHARTS_CARD).toMatch(/data-testid="inv-chart-tooltip"/);
    expect(CHARTS_CARD).toMatch(/bg-club-green-900\/85/);
    expect(
      CHARTS_CARD,
      "tooltip MUST NOT carry a backdrop-blur className",
    ).not.toMatch(/className="[^"]*backdrop-blur/);
    expect(CHARTS_CARD, "no native <title> SVG tooltip").not.toMatch(/<title>/);
  });

  it("Inventory Analysis chapter XIV — rail label matches the section title ('Inventory Analysis')", () => {
    expect(REPORTING_LAYOUT).toMatch(/label: "Inventory Analysis"/);
  });

  it("Departmental P&L chapter X — rail label is 'Departmental P&L' but the section title remains 'Departmental P&L Summary'", () => {
    // Per founder direction the rail uses the concise short form
    // while the on-page chapter title carries the formal long form.
    expect(REPORTING_LAYOUT).toMatch(/label: "Departmental P&L"/);
    expect(REPORTING_LAYOUT, "rail label MUST NOT include 'Summary'").not.toMatch(/label: "Departmental P&L Summary"/);
    // The chapter title is preserved by the service contract; this
    // is asserted in tests/departmental-p-and-l.test.ts.
  });

  it("Operating Statistics chapter IX — does NOT reintroduce the removed legacy 'operations-panel' chapter", () => {
    // Guard: the old `operations-panel` / OperationsPanel surface was
    // removed 2026-06-16. The new chapter IX is `operating-statistics`,
    // not the old `operations-panel`. The rail entry under chapter X
    // is "Operations & Analytics" (id `operations`), which is the
    // OperationsAnalytics deep-dive — a different chapter.
    expect(MONTHLY_PAGE).not.toMatch(/<section id="operations-panel"/);
    expect(MONTHLY_PAGE).not.toMatch(/function OperationsPanel\(/);
    expect(MONTHLY_PAGE).not.toMatch(/<OperationsPanel\s/);
  });

  it("Capital Project Tracker chapter VI — header chrome + 9-column table + exception report + project notes (period-derived, no Saguaro footer)", () => {
    const section = MONTHLY_PAGE.match(/<section id="capital-projects"[\s\S]+?<\/section>/);
    expect(section, "capital-projects section must exist").toBeTruthy();
    expect(section![0]).toMatch(/<CapitalProjectTrackerPanel\s+pkg=\{pkg\}/);

    const panel = sliceFn("CapitalProjectTrackerPanel");
    expect(panel.length, "CapitalProjectTrackerPanel body must be findable").toBeGreaterThan(0);
    expect(panel).toMatch(/data-testid="capital-projects"/);
    expect(panel).toMatch(/data-testid="cpt-eyebrow"/);
    expect(panel).toMatch(/data-testid="cpt-title"/);
    expect(panel).toMatch(/data-testid="cpt-period"/);
    expect(panel).toMatch(/data-testid="cpt-intro"/);
    expect(panel).toMatch(/data-testid="cpt-statement-number"/);
    expect(panel).toMatch(/data-testid="cpt-document-chip"/);
    expect(panel).toMatch(/data-testid="cpt-prepared-for"/);
    expect(panel).toMatch(/data-testid="cpt-table"/);
    expect(panel).toMatch(/data-testid="cpt-column-headers"/);
    expect(panel).toMatch(/data-testid="cpt-exception-report"/);
    expect(panel).toMatch(/data-testid="cpt-exception-report-eyebrow"/);
    expect(panel).toMatch(/data-testid="cpt-exception-report-body"/);
    expect(panel).toMatch(/data-testid="cpt-project-notes"/);
    expect(panel).toMatch(/data-testid="cpt-project-notes-list"/);
    expect(panel).toMatch(/cpt\.rows\.map/);
    expect(panel).toMatch(/cpt\.projectNotes\.map/);
    // Period header MUST flow from cpt.periodLabel (not hardcoded).
    expect(panel).toMatch(/\{cpt\.periodLabel\}/);
    // 9 column headers all bind to cpt.columnHeaders fields.
    expect(panel).toMatch(/\{cpt\.columnHeaders\.percentDone\}/);
    expect(panel).toMatch(/\{cpt\.columnHeaders\.estComplete\}/);
    expect(panel).toMatch(/\{cpt\.columnHeaders\.status\}/);

    // Reference attribution must NOT appear in the panel.
    expect(panel, "no Hypothetical Illustration attribution").not.toMatch(/Hypothetical Illustration/);
    expect(panel, "no Financially Astute attribution").not.toMatch(/Financially Astute/);
    expect(panel, "no financiallyastuteclubs.com link").not.toMatch(/financiallyastuteclubs/);

    // Row renderer handles all four row kinds.
    const row = sliceFn("CapitalProjectRowRender");
    expect(row.length, "CapitalProjectRowRender body must be findable").toBeGreaterThan(0);
    for (const kind of ["section-band", "commentary", "total", "project"]) {
      expect(row, `CapitalProjectRowRender must handle kind="${kind}"`).toMatch(new RegExp(`case "${kind}"`));
    }

    // Status pill class function returns a class per tone.
    const pill = sliceFn("capitalProjectStatusPillClass");
    expect(pill).toMatch(/case "on-track"/);
    expect(pill).toMatch(/case "pre-install"/);
    expect(pill).toMatch(/case "planning"/);
    expect(pill).toMatch(/case "at-risk"/);
    expect(pill).toMatch(/case "over-budget"/);

    // Pill markup MUST carry `whitespace-nowrap` so the longer
    // labels ("PRE-INSTALL" / "OVER BUDGET") never wrap onto two
    // lines. Regression pin added 2026-06-15.
    expect(row, "status pill must render with whitespace-nowrap").toMatch(
      /data-testid=\{`cpt-row-\$\{row\.key\}-status`\}[\s\S]+?whitespace-nowrap/,
    );

    // Status column on the grid template must be wide enough to fit
    // the longest standard label without wrapping.
    expect(panel).toMatch(/CAPITAL_PROJECT_GRID/);
    const grid = sliceFn("CAPITAL_PROJECT_GRID");
    // The last column (status) sits at 7.5rem — enough for the
    // longest pill at the project-tracker typography.
    expect(panel.includes('CAPITAL_PROJECT_GRID') || grid.length > 0).toBe(true);
  });

  it("CAPITAL_PROJECT_GRID status column ships at 7.5rem so the longest pill never wraps", () => {
    // The grid-template constant lives at module scope; assert
    // directly against the page source.
    expect(MONTHLY_PAGE).toMatch(
      /const CAPITAL_PROJECT_GRID =[\s\S]+?"minmax\(0, 1\.4fr\) 5\.2rem 5\.2rem 5\.2rem 5\.6rem 5rem 4rem 5\.4rem 7\.5rem"/,
    );
  });

  it("Stewardship KPI Dashboard chapter III restores the explanatory KPI cards", () => {
    // The chapter-III paired-row grid composes the dark-green header
    // band (title + subordinate rhetorical question) over a row
    // carrying the section-level explanatory paragraph, then the
    // paired StewardshipMetricCard rows. Each metric card surfaces
    // the four explanatory fields the founder named: What it is,
    // Why it matters, Policy / Target, Benchmark.
    const header = sliceFn("StewardshipKpiPanelHeader");
    expect(header.length, "StewardshipKpiPanelHeader body must be findable").toBeGreaterThan(0);
    // Dark-green header band (matches chapter II scorecard chrome).
    expect(header).toMatch(/bg-club-green-900/);
    // Title in serif cream.
    expect(header).toMatch(/data-testid=\{`\$\{testid\}-title`\}/);
    expect(header).toMatch(/font-serif text-club-cream/);
    // Subordinate rhetorical question — italic + smaller than title.
    expect(header).toMatch(/data-testid=\{`\$\{testid\}-question`\}/);
    expect(header).toMatch(/font-serif italic/);

    // Section-level explanatory paragraph in dedicated description atom.
    const description = sliceFn("StewardshipKpiPanelDescription");
    expect(description.length, "StewardshipKpiPanelDescription body must be findable").toBeGreaterThan(0);
    expect(description).toMatch(/data-testid=\{`\$\{testid\}-description`\}/);
    expect(description).toMatch(/font-serif italic/);

    // Paired-row grid wrapper renders the metric cards alongside
    // an aria-hidden empty cell when one side runs out of items.
    const grid = sliceFn("StewardshipKpiPairedGrid");
    expect(grid.length, "StewardshipKpiPairedGrid body must be findable").toBeGreaterThan(0);
    expect(grid).toMatch(/<StewardshipMetricCard/);
    expect(grid).toMatch(/grid grid-cols-1 gap-x-5 gap-y-4 xl:grid-cols-2/);
    expect(grid).toMatch(/<StewardshipKpiPanelHeader/);
    expect(grid).toMatch(/<StewardshipKpiPanelDescription/);
    // Empty-cell placeholder for uneven KPI counts (no masonry).
    expect(grid).toMatch(/aria-hidden="true"/);

    // StewardshipMetricCard atom surfaces the four explanatory fields.
    const metricCard = sliceFn("StewardshipMetricCard");
    expect(metricCard.length, "StewardshipMetricCard body must be findable").toBeGreaterThan(0);
    expect(metricCard).toMatch(/What it is/);
    expect(metricCard).toMatch(/Why it matters/);
    expect(metricCard).toMatch(/Policy \/ target/i);
    expect(metricCard).toMatch(/Benchmark/);
  });

  it("Stewardship KPI Dashboard chapter III restores the panel-level explanatory paragraphs", () => {
    // The two section-level explanatory sentences (Operating + Capital)
    // are wired as the `description` prop on the chapter-III paired-row
    // grid invocation in StewardshipKpiDashboard.
    const body = sliceFn("StewardshipKpiDashboard");
    expect(body, "operating description must reach chapter III").toMatch(
      /description:\s*"These metrics confirm the operating model is sustaining the member experience without borrowing from capital or future years\."/,
    );
    expect(body, "capital description must reach chapter III").toMatch(
      /These metrics confirm capital obligations are being funded, projects are executing on plan, and the club’s long-range asset position is moving in the right direction\./,
    );
  });

  it("Stewardship KPI Dashboard chapter III applies a brand-clear status dot palette + compacted card padding", () => {
    // Compaction pass — card padding tightened from p-7 (28px) to
    // p-5 (20px). Status dot upsized from h-2 w-2 (8px) to
    // h-2.5 w-2.5 (10px) so on-track / monitor / action read at
    // normal viewing distance.
    const card = sliceFn("StewardshipMetricCard");
    expect(card).toMatch(/className="flex h-full flex-col rounded-lg bg-white p-5"/);
    expect(card).toMatch(/h-2\.5 w-2\.5/);
    expect(card).toMatch(/stewardshipBrandDotClass\(tone\)/);

    // Brand-clear dot palette — chapter II's scorecard brand hexes,
    // not the desaturated dotForTone steps. Restrained editorial
    // brand palette, NOT SaaS stoplights.
    const dotFn = sliceFn("stewardshipBrandDotClass");
    expect(dotFn.length, "stewardshipBrandDotClass body must be findable").toBeGreaterThan(0);
    expect(dotFn).toMatch(/bg-\[#3f7042\]/); // club-green-500 (fairway green)
    expect(dotFn).toMatch(/bg-\[#b08a4a\]/); // club-gold (monitor)
    expect(dotFn).toMatch(/bg-\[#8b3520\]/); // Saguaro clay (action)
  });

  it("Stewardship KPI Dashboard chapter III applies data-driven variance colour ONLY to the variance amount", () => {
    // Per the data integrity rule, the React surface does NOT inspect
    // the sign of the amount string. It reads `varianceTone` from
    // the reporting service and applies a brand-palette class
    // (club-green-500 / Saguaro clay / muted) to ONLY the variance
    // amount span — the surrounding label + trailing margin context
    // stay in muted body colour.
    const summaryCard = sliceFn("StewardshipKpiSummaryCard");
    expect(summaryCard).toMatch(/varianceAmountClass\(variance\.varianceTone\)/);
    expect(summaryCard).toMatch(/data-testid=\{`\$\{testId\}-variance-amount`\}/);
    expect(summaryCard).toMatch(/data-tone=\{variance\.varianceTone\}/);

    const toneFn = sliceFn("varianceAmountClass");
    expect(toneFn.length, "varianceAmountClass body must be findable").toBeGreaterThan(0);
    expect(toneFn).toMatch(/positive[\s\S]+?#3f7042/);
    expect(toneFn).toMatch(/negative[\s\S]+?#8b3520/);

    // Wired call-sites: revenue + NOI pass a variance prop; capital
    // fund + reserve coverage still pass plain `sub`.
    const dash = sliceFn("StewardshipKpiDashboard");
    expect(dash).toMatch(/testId="stewardship-summary-revenue"[\s\S]+?variance=\{[\s\S]+?varianceTone:\s*dashboard\.summaryCards\.revenue\.varianceTone/);
    expect(dash).toMatch(/testId="stewardship-summary-noi"[\s\S]+?variance=\{[\s\S]+?varianceTone:\s*dashboard\.summaryCards\.noiBeforeDep\.varianceTone/);
    expect(dash).toMatch(/testId="stewardship-summary-capital-fund-income"[\s\S]+?sub=\{dashboard\.summaryCards\.capitalFundIncome\.subtext\}/);
    expect(dash).toMatch(/testId="stewardship-summary-reserve-coverage"[\s\S]+?sub=\{`\$\{dashboard\.summaryCards\.reserveCoverage\.balance/);
  });

  it("Stewardship KPI summary cards — service ships data-driven varianceTone for revenue + NOI (favourable vs unfavourable)", () => {
    // Per CLAUDE.md Financial Reporting Data Integrity, the
    // favourable/unfavourable decision is made in the reporting
    // service, not in React.
    expect(MONTHLY_PACKAGE).toMatch(/varianceTone:\s*"positive"/);
    expect(MONTHLY_PACKAGE).toMatch(/varianceTone:\s*"negative"/);
    // Revenue card seeds favourable (positive); NOI card seeds
    // unfavourable (negative) — matches the founder's spec.
    expect(MONTHLY_PACKAGE).toMatch(
      /revenue:\s*\{[\s\S]*?varianceTone:\s*"positive"[\s\S]*?\}/,
    );
    expect(MONTHLY_PACKAGE).toMatch(
      /noiBeforeDep:\s*\{[\s\S]*?varianceTone:\s*"negative"[\s\S]*?\}/,
    );
    // VarianceTone type is exported by the service for the React
    // surface to type-check against — single source of truth.
    expect(MONTHLY_PACKAGE).toMatch(/export type VarianceTone\s*=/);
  });

  // ---------------------------------------------------------------
  // Board Briefing — three executive memos for the Finance Chair.
  // ---------------------------------------------------------------
  // ---------------------------------------------------------------
  // Payroll (chapter XIII) — board-readable redesign.
  // ---------------------------------------------------------------
  it("payroll service shape carries department split + overtime + dues cushion + seasonal pressure", async () => {
    const club = await bootstrapAPClub("Payroll Service Shape");
    const pkg = await getMonthlyReportingPackage(club.id);
    expect(pkg.payroll.byDepartment.length).toBeGreaterThanOrEqual(6);
    for (const d of pkg.payroll.byDepartment) {
      expect(d.name).toBeTruthy();
      expect(d.ytd).toBeTruthy();
      expect(d.sharePct).toBeTruthy();
    }
    expect(pkg.payroll.overtimeHoursYTD).toBeGreaterThan(0);
    expect(pkg.payroll.overtimePctOfHours).toBeTruthy();
    expect(pkg.payroll.peakOvertimeMonth).toBeTruthy();
    expect(pkg.payroll.seasonalLaborEstimate).toBeTruthy();
    expect(pkg.payroll.duesCushion).toBeTruthy();
  });

  // Test "Payroll chapter XIII opens with italic-serif interpretation
  // + 4 headline tiles + 2 groups + trend chart" was removed
  // 2026-06-19 alongside the legacy Payroll chapter the assertion
  // guarded. The canonical Payroll Analysis surface (chapter XII /
  // DepartmentalPayrollAnalysisPanel) is pinned by its own dedicated
  // source-contract test elsewhere in this file. The
  // `pkg.payroll.*` service fields are still produced for the
  // export path and asserted in the commentary-shape tests above.

  // ---------------------------------------------------------------
  // F&B / Hospitality — REMOVED 2026-06-19.
  //
  // The legacy F&B / Hospitality chapter and `FbHospitality`
  // component were deleted because they duplicated the canonical
  // chapter XIII "Food & Beverage Statistics"
  // (id: `f-and-b-statistics`). The shared
  // `pkg.fb` / `pkg.fbStats` service fields remain available — they
  // back the canonical chapter XIII's Average Check and Member
  // Satisfaction KPI cards, the export path, and the per-section
  // commentary.
  // ---------------------------------------------------------------
  it("fbStats service shape stays available for the canonical chapter XIII surface", async () => {
    const club = await bootstrapAPClub("F&B Service Shape");
    const pkg = await getMonthlyReportingPackage(club.id);
    // Data must remain on the service even though the legacy chapter
    // is gone — the canonical chapter XIII (F&B Statistics) and the
    // export path both consume these fields.
    expect(pkg.fbStats.revenueYTD).toBeTruthy();
    expect(pkg.fbStats.revenueVarPct).toBeTruthy();
    expect(pkg.fbStats.subsidyAmount).toBeTruthy();
    expect(pkg.fbStats.subsidyPctOfDues).toBeTruthy();
    expect(pkg.fbStats.subsidyTrend.length).toBe(12);
  });

  it("legacy FbHospitality component no longer ships in the page", () => {
    // Hard regression guard: the dead component must not return —
    // its testids and section anchor are forbidden on the page.
    expect(MONTHLY_PAGE).not.toMatch(/function FbHospitality\(/);
    expect(MONTHLY_PAGE).not.toMatch(/<section id="fb-hospitality"/);
    expect(MONTHLY_PAGE).not.toMatch(/data-testid="fb-lead"/);
    expect(MONTHLY_PAGE).not.toMatch(/data-testid="fb-headline"/);
    expect(MONTHLY_PAGE).not.toMatch(/data-testid="fb-subsidy-trend"/);
  });

  // ---------------------------------------------------------------
  // Operations & Analytics — private-club operating metrics.
  // ---------------------------------------------------------------
  it("operatingStats service shape carries the new private-club fields", async () => {
    const club = await bootstrapAPClub("Operations Stats Shape");
    const pkg = await getMonthlyReportingPackage(club.id);
    expect(pkg.operatingStats.members.waitlist).toBeGreaterThan(0);
    expect(pkg.operatingStats.members.waitlistConversionPct).toBeTruthy();
    expect(pkg.operatingStats.rounds.guestYTD).toBeGreaterThan(0);
    expect(pkg.operatingStats.rounds.guestSharePct).toBeTruthy();
    expect(pkg.operatingStats.fbCovers.averageCheck).toBeTruthy();
    expect(pkg.operatingStats.derived.spendPerMember).toBeTruthy();
    expect(pkg.operatingStats.derived.spendPerRound).toBeTruthy();
  });

  it("weatherUtilization service shape carries weather impact + utilization trend", async () => {
    const club = await bootstrapAPClub("Weather Impact Shape");
    const pkg = await getMonthlyReportingPackage(club.id);
    expect(pkg.weatherUtilization.daysLostYTD).toBeGreaterThanOrEqual(0);
    expect(pkg.weatherUtilization.revenueImpactEstimate).toBeTruthy();
    expect(pkg.weatherUtilization.utilizationTrend.length).toBe(12);
  });

  it("inventory service shape carries food + beverage turns", async () => {
    const club = await bootstrapAPClub("Inventory Turns Shape");
    const pkg = await getMonthlyReportingPackage(club.id);
    expect(pkg.inventory.turnsFood).toBeTruthy();
    expect(pkg.inventory.turnsBeverage).toBeTruthy();
  });

  it("legacy Operations & Analytics chapter no longer ships in the page (retired 2026-06-19)", () => {
    // The standalone Operations & Analytics chapter (catch-all Pillar-
    // 1/4/5 surface) was retired 2026-06-19. Every load-bearing
    // reading now ships in one of the six dedicated operational
    // chapters (Operating Statistics → Inventory Analysis). The
    // `pkg.operatingStats` + `pkg.weatherUtilization` + `pkg.fbStats`
    // + `pkg.commentary.operations` service fields stay produced and
    // are consumed by the Weather chapter's utilization-extension
    // tiles + the 5-pillar Board Briefing rollup; they are asserted
    // separately in the commentary-shape + service-shape tests.
    expect(MONTHLY_PAGE).not.toMatch(/function OperationsAnalytics\(/);
    expect(MONTHLY_PAGE).not.toMatch(/function OperatingMetricGroup\(/);
    expect(MONTHLY_PAGE).not.toMatch(/function OperatingMetric\(/);
    expect(MONTHLY_PAGE).not.toMatch(/<section id="operations"/);
    expect(MONTHLY_PAGE).not.toMatch(/data-testid="operations-lead"/);
    expect(MONTHLY_PAGE).not.toMatch(/data-testid="operations-headline"/);
    expect(MONTHLY_PAGE).not.toMatch(/data-testid="operations-utilization-trend"/);
    expect(MONTHLY_PAGE).not.toMatch(/testId="operations-group-membership"/);
    expect(MONTHLY_PAGE).not.toMatch(/testId="operations-group-course"/);
    expect(MONTHLY_PAGE).not.toMatch(/testId="operations-group-fb"/);
    expect(MONTHLY_PAGE).not.toMatch(/testId="operations-active-members"/);
    expect(MONTHLY_PAGE).not.toMatch(/testId="operations-rounds-ytd"/);
    expect(MONTHLY_PAGE).not.toMatch(/testId="operations-fb-covers"/);
    expect(MONTHLY_PAGE).not.toMatch(/testId="operations-waitlist"/);
  });

  // ---------------------------------------------------------------
  // Board-readable financial statements — each of the 4 statements
  // (Activities, Capital Fund, Position, AR Aging) exposes a summary
  // cards block + key variance rows + plain-English notes BEFORE
  // the line-by-line detail table.
  // ---------------------------------------------------------------
  it("each statement section exposes summaryCards + keyVariances + notes alongside the detail lines", async () => {
    const club = await bootstrapAPClub("Statement Board Shape");
    const pkg = await getMonthlyReportingPackage(club.id);

    for (const section of [
      pkg.statementOfActivities,
      pkg.capitalFund,
      pkg.financialPosition,
    ]) {
      expect(section.summaryCards.length, "summary cards present").toBeGreaterThanOrEqual(3);
      expect(section.keyVariances.length, "key variances present").toBeGreaterThanOrEqual(3);
      expect(section.notes.length, "notes paragraph present").toBeGreaterThan(60);
      expect(section.lines.length, "detail lines preserved for audit trail").toBeGreaterThan(0);
    }

    // AR Aging carries the same shape.
    expect(pkg.arAging.summaryCards.length).toBeGreaterThanOrEqual(3);
    expect(pkg.arAging.keyVariances.length).toBeGreaterThanOrEqual(3);
    expect(pkg.arAging.notes.length).toBeGreaterThan(60);
    expect(pkg.arAging.buckets.length).toBe(4);
  });

  it("Statement of Activities summary cards lead with the four board-headline lines", async () => {
    const club = await bootstrapAPClub("Activities Headline Cards");
    const pkg = await getMonthlyReportingPackage(club.id);
    const keys = pkg.statementOfActivities.summaryCards.map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining([
      "total-revenue", "total-expense", "noi-before-dep", "noi",
    ]));
    // Each summary card has a comparator.
    for (const c of pkg.statementOfActivities.summaryCards) {
      expect(c.comparison, `${c.key} comparison missing`).toBeDefined();
      expect(c.comparison!.label).toBeTruthy();
      expect(c.comparison!.value).toBeTruthy();
    }
  });

  it("AR Aging summary cards reflect the directors' four numbers (Total / Current% / 31-60 / Over-90)", async () => {
    const club = await bootstrapAPClub("AR Headline Cards");
    const pkg = await getMonthlyReportingPackage(club.id);
    const keys = pkg.arAging.summaryCards.map((c) => c.key);
    expect(keys).toEqual(["total", "current", "31-60", "over-90"]);
  });

  it("legacy AR fields (totalReceivable, currentPct, over90Pct) are removed from the type", () => {
    const SERVICE = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/reporting/monthly-package.ts"),
      "utf8",
    );
    const arBlock = SERVICE.match(/arAging:\s*\{[\s\S]+?\};/);
    expect(arBlock).toBeTruthy();
    const body = arBlock![0];
    expect(body).not.toMatch(/totalReceivable: string;/);
    expect(body).not.toMatch(/currentPct: string;/);
    expect(body).not.toMatch(/over90Pct: string;/);
  });

  it("BoardStatement component renders the 4-tier hierarchy with summary → variances → notes → detail", () => {
    const body = sliceFn("BoardStatement");
    expect(body.length, "BoardStatement body must be sliced").toBeGreaterThan(0);
    // Anatomy testids in source order: summary, variances, notes, detail.
    const summaryIdx = body.indexOf(`data-testid={\`\${testId}-summary\`}`);
    const variancesIdx = body.indexOf(`data-testid={\`\${testId}-variances\`}`);
    const notesIdx = body.indexOf(`data-testid={\`\${testId}-notes\`}`);
    const detailIdx = body.indexOf(`data-testid={\`\${testId}-detail\`}`);
    expect(summaryIdx, "summary testid present").toBeGreaterThan(-1);
    expect(variancesIdx, "variances testid present").toBeGreaterThan(-1);
    expect(notesIdx, "notes testid present").toBeGreaterThan(-1);
    expect(detailIdx, "detail testid present").toBeGreaterThan(-1);
    // Order: summary precedes variances precedes notes precedes detail.
    expect(summaryIdx).toBeLessThan(variancesIdx);
    expect(variancesIdx).toBeLessThan(notesIdx);
    expect(notesIdx).toBeLessThan(detailIdx);
    // "Key variances" + "Full statement detail" smallcaps labels.
    expect(body).toMatch(/Key variances this period/);
    expect(body).toMatch(/Full statement detail/);
  });

  // ---------------------------------------------------------------
  // Executive commentary — eight blocks, one per section that lacked
  // a built-in narrative (Board Briefing already carries its own).
  // ---------------------------------------------------------------
  it("commentary block exists on the service for each of the ten sections", async () => {
    const club = await bootstrapAPClub("Commentary Service Shape");
    const pkg = await getMonthlyReportingPackage(club.id);
    expect(pkg.commentary).toBeDefined();
    for (const key of [
      "atAGlance", "stewardship", "financialStatements", "operations",
      "payroll", "fb", "capitalProjects", "arCollections",
      "membershipStewardship", "experienceStewardship",
    ] as const) {
      const block = pkg.commentary[key];
      expect(block, `commentary.${key} missing`).toBeDefined();
      expect(block.dataSource).toBe("demo");
      expect(block.whatHappened.length, `${key} whatHappened body`).toBeGreaterThan(40);
      expect(block.whatItMeans.length, `${key} whatItMeans body`).toBeGreaterThan(40);
      expect(block.whatNeedsAttention.length, `${key} whatNeedsAttention body`).toBeGreaterThan(20);
      // boardDecision is optional but every demo block populates it
      // so the question is always answered in the rendered UI.
      expect(block.boardDecision, `${key} boardDecision body`).toBeTruthy();
    }
  });

  it("commentary copy uses private golf club vocabulary, not generic SaaS filler", async () => {
    const club = await bootstrapAPClub("Commentary Vocabulary");
    const pkg = await getMonthlyReportingPackage(club.id);
    // Concatenate every commentary body and assert the club-specific
    // terms the spec listed appear across the package.
    const all = JSON.stringify(pkg.commentary).toLowerCase();
    for (const term of [
      "dues",
      "entrance fee",
      "waitlist",
      "capital reserve",
      "f&b subsidy",
      "course utilization",
      "ar",
      "capital stewardship",
    ]) {
      expect(all.includes(term), `commentary copy must mention "${term}"`).toBe(true);
    }
    // Narrative-rewrite pass: "member experience" appears as either
    // the bare phrase OR the hyphenated "member-experience" OR the
    // Pillar 5 framing per docs/executive-narrative-style-guide.md.
    expect(
      /member[\s-]experience|experience stewardship|member-experience driven/.test(all),
      'commentary copy must reference member experience (any spelling) or Pillar 5 Experience Stewardship',
    ).toBe(true);
    // Anti-SaaS vocabulary check.
    expect(all).not.toMatch(/dau|mau|nps|churn|funnel|conversion rate/);
  });

  it("ExecutiveCommentary component renders the four labelled rows + demo chip", () => {
    const body = sliceFn("ExecutiveCommentary");
    expect(body.length, "ExecutiveCommentary body must be sliced").toBeGreaterThan(0);
    // The four question labels.
    expect(body).toMatch(/What happened/);
    expect(body).toMatch(/What it means/);
    expect(body).toMatch(/What needs attention/);
    expect(body).toMatch(/Board decision required/);
    // boardDecision falls back to "None this month" when absent.
    expect(body).toMatch(/None this month/);
    // Demo source paints a DataSourceChip in commentary variant.
    // The literal label string moved into DataSourceChip; here we
    // just assert the chip is wired with variant="commentary".
    expect(body).toMatch(/<DataSourceChip source=\{block\.dataSource\} variant="commentary"/);
    // Gold left accent + cream/ivory paper.
    expect(body).toMatch(/bg-club-gold/);
    expect(body).toMatch(/border-club-sand/);
    // Board Consideration chip wired into every commentary block —
    // the four-state governance signal at the top of the block,
    // above the four labeled rows.
    expect(body).toMatch(/Board consideration/);
    expect(body).toMatch(/<BoardConsiderationChip consideration=\{block\.consideration\}/);
  });

  it("BoardConsiderationChip component ships the four documented states", () => {
    const body = sliceFn("BoardConsiderationChip");
    expect(body.length, "BoardConsiderationChip body must be sliced").toBeGreaterThan(0);
    // The four state values defined in the executive-narrative style
    // guide must all be supported by the chip atom.
    expect(body).toMatch(/"no-action"/);
    expect(body).toMatch(/"monitor"/);
    expect(body).toMatch(/"committee-review"/);
    expect(body).toMatch(/"board-decision"/);
    // Four human-readable labels.
    expect(body).toMatch(/"No action required"/);
    expect(body).toMatch(/"Monitor"/);
    expect(body).toMatch(/"Committee review recommended"/);
    expect(body).toMatch(/"Board decision required"/);
    // Paper-on-paper chip (no pastel tints).
    expect(body).toMatch(/bg-club-cream/);
    expect(body).not.toMatch(/bg-amber-50/);
    expect(body).not.toMatch(/bg-red-50/);
    // Testid + data attribute for DOM-walkers.
    expect(body).toMatch(/data-testid="board-consideration-chip"/);
    expect(body).toMatch(/data-consideration=\{consideration\}/);
  });

  it("BoardConsideration type + service shape wire to every major narrative", async () => {
    const club = await bootstrapAPClub("BoardConsideration shape");
    const pkg = await getMonthlyReportingPackage(club.id);
    // Package-level: executive summary carries a Board Consideration.
    expect(pkg.executiveSummary.consideration).toBeTruthy();
    // Per-memo: all three briefing memos carry one.
    expect(pkg.boardBriefing.operations.consideration).toBeTruthy();
    expect(pkg.boardBriefing.financialHealth.consideration).toBeTruthy();
    expect(pkg.boardBriefing.capitalProgram.consideration).toBeTruthy();
    // Per-statement: all four BoardStatement instances carry one.
    expect(pkg.statementOfActivities.consideration).toBeTruthy();
    expect(pkg.capitalFund.consideration).toBeTruthy();
    expect(pkg.financialPosition.consideration).toBeTruthy();
    expect(pkg.arAging.consideration).toBeTruthy();
    // Per-chapter: all eight Executive Commentary blocks carry one.
    const all = pkg.commentary;
    for (const k of ["atAGlance", "stewardship", "financialStatements", "operations", "payroll", "fb", "capitalProjects", "arCollections", "membershipStewardship", "experienceStewardship"] as const) {
      expect(all[k].consideration, `commentary.${k}.consideration must be set`).toBeTruthy();
      // Value must be one of the four documented states.
      expect(
        ["no-action", "monitor", "committee-review", "board-decision"].includes(all[k].consideration),
        `commentary.${k}.consideration must be one of the four documented values`,
      ).toBe(true);
    }
  });

  it("every commentary-bearing section in the page wires an ExecutiveCommentary block", () => {
    // The chapter-X stewardship ExecutiveCommentary wiring was
    // removed in the 2026-06-14 chapter consolidation. The new
    // chapter III "Stewardship KPI Dashboard" ships its own
    // dedicated reactive commentary surface (Dashboard Notes,
    // generated by buildStewardshipDashboardNotes) — it does NOT
    // reuse the generic ExecutiveCommentary block, so the wiring
    // table below intentionally omits the `stewardship` entry. The
    // `pkg.commentary.stewardship` field is still produced by the
    // service for the future PDF / committee-pack export path and
    // is asserted separately in the commentary-shape tests.
    // Legacy "capital-projects" ExecutiveCommentary wiring was
    // removed 2026-06-17 with the duplicate Capital / Projects
    // chapter. Legacy "payroll", "fb-hospitality",
    // "membership-stewardship", and "experience-stewardship" wirings
    // were removed 2026-06-19 with their chapters (Payroll + F&B
    // were duplicates; both Stewardship pillar memos were retired
    // after their load-bearing surfaces migrated into the
    // Stewardship KPI Dashboard, the Weather chapter, and the F&B
    // Statistics chapter). The
    // `pkg.commentary.capitalProjects` + `pkg.commentary.payroll` +
    // `pkg.commentary.fb` + `pkg.commentary.membershipStewardship` +
    // `pkg.commentary.experienceStewardship` fields are still
    // produced by the service for the export path and for the 5-
    // pillar Board Briefing rollup (which consumes
    // `commentary.experienceStewardship.boardHeadline`).
    // 2026-06-19 close-out: every chapter that historically wired
    // an <ExecutiveCommentary> block was either retired (Payroll,
    // F&B / Hospitality, Capital / Projects, Membership Stewardship,
    // Experience Stewardship, Operations & Analytics) or had its
    // commentary surface replaced by a dedicated reactive component
    // (the chapter-III Stewardship KPI Dashboard ships its own
    // Dashboard Notes generated by buildStewardshipDashboardNotes).
    // The service-side `pkg.commentary.*` fields stay produced and
    // are asserted in the commentary-shape tests below; this guard
    // pins that the React layer no longer renders the generic
    // <ExecutiveCommentary> wrapper anywhere on the page.
    expect(
      MONTHLY_PAGE,
      "<ExecutiveCommentary> wrappers MUST NOT render after the 2026-06-19 chapter retirements",
    ).not.toMatch(/<ExecutiveCommentary\s/);
  });

  // ---------------------------------------------------------------
  // Stewardship Dashboard — Operating + Capital, controller-style.
  // ---------------------------------------------------------------
  it("Stewardship service returns the 8 + 8 metric set the spec named", async () => {
    const club = await bootstrapAPClub("Stewardship Service Shape");
    const pkg = await getMonthlyReportingPackage(club.id);

    const opKeys = pkg.operatingKPIs.cards.map((k) => k.key);
    expect(opKeys.sort()).toEqual([
      "ar-current",
      "covers-vs-plan",
      "dues-rev",
      "fb-subsidy",
      "init-fee-subsidy",
      "noi-margin",
      "payroll-ratio",
      "rounds-vs-plan",
    ]);

    const capKeys = pkg.capitalKPIs.cards.map((k) => k.key);
    expect(capKeys.sort()).toEqual([
      "capital-income-vs-plan",
      "capital-spend-vs-plan",
      "debt-equity",
      "ppe-reinvestment",
      "project-completion",
      "reserve-coverage",
      "reserve-sufficiency",
      "working-capital",
    ]);
  });

  it("every stewardship card answers the three controller questions", async () => {
    const club = await bootstrapAPClub("Stewardship Three Questions");
    const pkg = await getMonthlyReportingPackage(club.id);
    for (const k of [...pkg.operatingKPIs.cards, ...pkg.capitalKPIs.cards]) {
      expect(k.whatIsIt, `${k.key} whatIsIt missing`).toBeTruthy();
      expect(k.whyItMatters, `${k.key} whyItMatters missing`).toBeTruthy();
      expect(k.assessment, `${k.key} assessment missing`).toBeTruthy();
      // The legacy `explanation` field is gone from the type.
      // (Object literals can still carry it at runtime, but the type
      //  no longer requires it.)
    }
  });

  it("StewardshipKpi type exposes whatIsIt + whyItMatters + assessment and drops `explanation`", () => {
    const SERVICE = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/reporting/monthly-package.ts"),
      "utf8",
    );
    expect(SERVICE).toMatch(/whatIsIt: string;/);
    expect(SERVICE).toMatch(/whyItMatters: string;/);
    expect(SERVICE).toMatch(/assessment: string;/);
    // The type no longer declares explanation.
    expect(SERVICE).not.toMatch(/^\s*explanation: string;/m);
  });

  it("Stewardship card renders the controller's three-question anatomy", () => {
    const body = sliceFn("StewardshipMetricCard");
    expect(body.length, "StewardshipMetricCard body must be sliced").toBeGreaterThan(0);
    for (const part of ["", "-name", "-tone", "-actual", "-assessment", "-definitions", "-what", "-why"]) {
      const expr = `data-testid={\`stewardship-\${kpi.key}${part}\`}`;
      expect(
        body.includes(expr),
        `StewardshipMetricCard must expose stewardship-{key}${part} testid`,
      ).toBe(true);
    }
    // 3-question structure: explicit "What it is" + "Why it matters" labels.
    expect(body).toMatch(/What it is/);
    expect(body).toMatch(/Why it matters/);
    // Assessment uses the tone-coloured headline class so the verdict
    // visually answers "Is it good or bad?".
    expect(body).toMatch(/toneHeadlineClass\(tone\)/);
    // Actual number is serif tabular-nums. 2026-06-14 compaction
    // pass: hero tier dropped from text-4xl (36 px) to text-3xl
    // (30 px) so the explanatory card stops dominating the chapter
    // height while remaining the dominant atom inside its card.
    expect(body).toMatch(/font-serif/);
    expect(body).toMatch(/text-3xl/);
    expect(body).toMatch(/tabular-nums/);
  });

  it("StewardshipBlock prints the group count and uses board-doc typography", () => {
    const body = sliceFn("StewardshipBlock");
    expect(body.length).toBeGreaterThan(0);
    // Group header: serif h3 + the muted-gold "N ratios" tag.
    expect(body).toMatch(/<h3[\s\S]+?font-serif[\s\S]+?text-2xl/);
    expect(body).toMatch(/\{cards\.length\} ratios/);
    // Group uses the cream-bg parchment (no admin stone-200 borders).
    expect(body).toMatch(/border-club-sand/);
    expect(body).not.toMatch(/border-stone-200/);
  });

  it("Stewardship KPI Dashboard (chapter III) renders eyebrow + title + meta + intro question + summary cards + Operating + Capital panels + Dashboard Notes", () => {
    // Chapter III replaces the old chapter X stewardship-lead +
    // controller's-view body (removed 2026-06-14). The new section
    // ships the Saguaro-style premium editorial chrome the founder
    // approved: eyebrow + display title + period line + italic intro
    // question, four summary cards, two-column Operating + Capital
    // panels, and reactive Dashboard Notes. The section wraps a
    // single <StewardshipKpiDashboard> component — the editorial
    // chrome + summary-card + panel + notes testids live in the
    // component body, not on the section element.
    const sect = MONTHLY_PAGE.match(/<section id="stewardship-dashboard"[\s\S]+?<\/section>/);
    expect(sect, "stewardship-dashboard section must exist").toBeTruthy();
    expect(sect![0]).toMatch(/<StewardshipKpiDashboard\s+pkg=\{pkg\}/);

    const body = sliceFn("StewardshipKpiDashboard");
    expect(body.length, "StewardshipKpiDashboard body must be findable").toBeGreaterThan(0);

    // Premium editorial chrome — eyebrow + title + period line + italic intro.
    expect(body).toMatch(/eyebrow="Silver Springs Golf & Country Club · KPI Dashboard"/);
    expect(body).toMatch(/title="Stewardship KPI Dashboard"/);
    expect(body).toMatch(/data-testid="stewardship-kpi-dashboard-meta"/);
    expect(body).toMatch(/data-testid="stewardship-kpi-dashboard-intro"/);

    // Four top summary cards — atom is data-testid="stewardship-summary-*".
    expect(body).toMatch(/testId="stewardship-summary-revenue"/);
    expect(body).toMatch(/testId="stewardship-summary-noi"/);
    expect(body).toMatch(/testId="stewardship-summary-capital-fund-income"/);
    expect(body).toMatch(/testId="stewardship-summary-reserve-coverage"/);

    // Operating + Capital panels — chapter III's EXPLANATORY layer
    // (StewardshipMetricCard rows carrying What it is / Why it
    // matters / Policy or Target / Benchmark) rendered inside the
    // chapter-III-specific StewardshipKpiPairedGrid wrapper. The
    // paired-row CSS grid stretches both cells in each row to share
    // the row's natural height so Operating KPI N and Capital KPI N
    // start AND end at the same y position. Chapter II's detailed
    // StewardshipScorecardCard tables MUST NOT render here.
    expect(body).toMatch(/<StewardshipKpiPairedGrid/);
    expect(body).toMatch(/testid:\s*"stewardship-kpi-panel-operating"/);
    expect(body).toMatch(/testid:\s*"stewardship-kpi-panel-capital"/);
    expect(body, "chapter III must not duplicate chapter II scorecard tables").not.toMatch(/<StewardshipScorecardCard/);
    // Paired-row CSS grid (2 columns at xl, 1 column below).
    const pairedGrid = sliceFn("StewardshipKpiPairedGrid");
    expect(pairedGrid).toMatch(/data-testid="stewardship-kpi-dashboard-panels"[\s\S]{0,200}grid grid-cols-1 gap-x-5 gap-y-4 xl:grid-cols-2/);

    // Dashboard Notes — two complete paragraph bullets, stacked
    // vertically. Reactive: the two `dashboard.dashboardNotes`
    // entries (operating + capital) flow through a single-column
    // <ul>/<li> stack where each <li> renders a full executive
    // paragraph (NOT a fragmented one-sentence bullet). The
    // chapter-III block is fed by `dashboard.dashboardNotes` (a
    // Bullet[] from buildStewardshipDashboardNotes).
    expect(body).toMatch(/data-testid="stewardship-kpi-dashboard-notes"/);
    expect(body).toMatch(/data-testid="stewardship-kpi-dashboard-notes-heading"/);
    expect(body).toMatch(/data-testid="stewardship-kpi-dashboard-notes-list"/);
    // Single-column stack — no two-column tone-grouped grid.
    expect(body).toMatch(/<ul[\s\S]+?data-testid="stewardship-kpi-dashboard-notes-list"[\s\S]+?className="mt-4 space-y-4 font-serif/);
    // Dynamic per-bullet testid uses the bullet's tone, so the two
    // stacked items expose `stewardship-kpi-dashboard-notes-operating`
    // and `stewardship-kpi-dashboard-notes-capital`.
    expect(body).toMatch(/data-testid=\{`stewardship-kpi-dashboard-notes-\$\{bullet\.tone\}`\}/);
    // Bullets are mapped directly off the reactive generator output —
    // no tone-filter that would imply fragmented snippets.
    expect(body).toMatch(/dashboard\.dashboardNotes\.map\(\(bullet\) =>/);

    // Saguaro-style ▶ arrow markers replace the prior gold dot.
    // Operating gets the muted Saguaro clay (#8b3520 — same family
    // as the action-status dot); capital gets a muted slate-blue
    // (#3a5a78) — a restrained editorial complement to the clay.
    // Only the arrow is coloured; the paragraph stays in the
    // report's body colour.
    expect(body).toMatch(/bullet\.tone === "operating"\s*\?\s*"text-\[#8b3520\]"\s*:\s*"text-\[#3a5a78\]"/);
    expect(body).toMatch(/data-testid=\{`stewardship-kpi-dashboard-notes-\$\{bullet\.tone\}-marker`\}/);
    // The arrow glyph is a small triangle (▶ = U+25B6, rendered via
    // HTML entity in JSX so the JSX parser stays happy).
    expect(body).toMatch(/&#9654;/);

    // The deprecated max-w-[920px] narrow-text-column constraint AND
    // the deprecated xl:grid-cols-2 tone-column grid MUST be gone.
    const notesBlock = body.match(/data-testid="stewardship-kpi-dashboard-notes"[\s\S]+?<\/div>\s*\)/);
    expect(notesBlock, "notes block must be findable").toBeTruthy();
    expect(notesBlock![0], "notes must not use the deprecated max-w-[920px] narrow column").not.toMatch(/max-w-\[920px\]/);
    expect(notesBlock![0], "notes must not use the deprecated xl:grid-cols-2 tone column grid").not.toMatch(/xl:grid-cols-2/);
    // The prior round gold dot marker is gone — only the arrow renders now.
    expect(notesBlock![0], "deprecated gold round dot marker must not render").not.toMatch(/h-1\.5 w-1\.5[^"]*rounded-full[^"]*bg-club-gold/);

    // Old chapter-X testid surface must NOT appear (consolidated away).
    expect(MONTHLY_PAGE, "chapter-X stewardship-lead must not render").not.toMatch(/data-testid="stewardship-lead"/);
  });

  it("Stewardship operating group lists the exact 8 metric names the user named", async () => {
    const club = await bootstrapAPClub("Stewardship Operating Names");
    const pkg = await getMonthlyReportingPackage(club.id);
    const names = pkg.operatingKPIs.cards.map((k) => k.name);
    expect(names).toContain("Dues-to-Revenue Ratio");
    expect(names).toContain("Payroll Ratio");
    expect(names).toContain("NOI Margin");
    expect(names).toContain("F&B Subsidy");
    expect(names).toContain("Rounds vs Plan");
    expect(names).toContain("Covers vs Plan");
    expect(names).toContain("AR Current %");
    expect(names).toContain("Initiation Fee Operating Subsidy");
  });

  it("Stewardship capital group lists the exact 8 metric names the user named", async () => {
    const club = await bootstrapAPClub("Stewardship Capital Names");
    const pkg = await getMonthlyReportingPackage(club.id);
    const names = pkg.capitalKPIs.cards.map((k) => k.name);
    expect(names).toContain("Reserve Coverage");
    expect(names).toContain("Capital Income vs Plan");
    expect(names).toContain("Capital Spend vs Plan");
    expect(names).toContain("Long-Term Debt-to-Equity");
    expect(names).toContain("PPE Reinvestment");
    expect(names).toContain("Reserve Sufficiency");
    expect(names).toContain("Working Capital");
    expect(names).toContain("Capital Project Completion");
  });

  // ---------------------------------------------------------------
  // At-a-Glance KPIs — premium board-document tiles.
  // ---------------------------------------------------------------
  it("each At-a-Glance KPI in the service has context + comparison fields", async () => {
    const club = await bootstrapAPClub("At-a-Glance Service Shape");
    const pkg = await getMonthlyReportingPackage(club.id);
    expect(pkg.executiveSummary.kpis.length).toBe(6);
    for (const k of pkg.executiveSummary.kpis) {
      expect(k.context, `${k.key} context missing`).toBeTruthy();
      expect(k.comparison, `${k.key} comparison missing`).toBeTruthy();
      expect(k.comparison!.label).toBeTruthy();
      expect(k.comparison!.value).toBeTruthy();
      // variance carries the directional summary; it's optional on the
      // type but our demo data populates it for all six.
      expect(k.comparison!.variance, `${k.key} variance missing`).toBeTruthy();
    }
  });

  it("KpiComparison + KpiCard types expose the new optional fields", () => {
    const SERVICE = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/reporting/monthly-package.ts"),
      "utf8",
    );
    expect(SERVICE).toMatch(/export type KpiComparison = \{/);
    expect(SERVICE).toMatch(/context\?: string;/);
    expect(SERVICE).toMatch(/comparison\?: KpiComparison;/);
  });

  // Slice the KpiCardView body from "function KpiCardView(" to the
  // next top-level "function " — robust against nested JSX braces.
  function sliceFn(name: string): string {
    const start = MONTHLY_PAGE.indexOf(`function ${name}(`);
    if (start < 0) return "";
    const nextFn = MONTHLY_PAGE.indexOf("\nfunction ", start + 1);
    return nextFn > 0 ? MONTHLY_PAGE.slice(start, nextFn) : MONTHLY_PAGE.slice(start);
  }

  it("At-a-Glance hero number uses prestige typography (L1c Headline-KPI, serif text-5xl, tabular-nums)", () => {
    // L1c Headline-KPI at text-5xl (48 px). Rebalanced down from
    // text-6xl in the squint-test refinement pass so the chapter
    // title above (now text-5xl) wins the eye first. Same size +
    // top-of-chapter position = chapter title beats KPI grid on
    // the squint test.
    const body = sliceFn("KpiCardView");
    expect(body.length, "KpiCardView body must be sliced").toBeGreaterThan(0);
    expect(body).toMatch(/data-testid=\{`exec-kpi-\$\{kpi\.key\}-value`\}/);
    expect(body).toMatch(/font-serif/);
    expect(body).toMatch(/text-5xl/);
    expect(body).toMatch(/tabular-nums/);
    expect(body).toMatch(/text-club-green-900/);
  });

  it("At-a-Glance card renders the documented anatomy testids", () => {
    const body = sliceFn("KpiCardView");
    for (const part of ["", "-label", "-tone", "-value", "-context", "-comparison", "-variance"]) {
      const expr = `data-testid={\`exec-kpi-\${kpi.key}${part}\`}`;
      expect(
        body.includes(expr),
        `KpiCardView must expose exec-kpi-{key}${part} testid`,
      ).toBe(true);
    }
  });

  it("At-a-Glance comparison renders comparator label + value + tone-coloured variance", () => {
    const body = sliceFn("KpiCardView");
    expect(body).toMatch(/kpi\.comparison\.label/);
    expect(body).toMatch(/kpi\.comparison\.value/);
    expect(body).toMatch(/kpi\.comparison\.variance/);
    // Variance text is tone-coloured via the briefing-memo helper.
    expect(body).toMatch(/toneHeadlineClass\(tone\)/);
  });

  it("dead tone helpers removed (dotForTone + toneHeadlineClass remain)", () => {
    // borderForTone was already dead. toneStripeClass was removed in
    // the board-briefing memo redesign — no more Kanban-style stripes
    // anywhere on the page.
    expect(MONTHLY_PAGE).not.toMatch(/function borderForTone/);
    expect(MONTHLY_PAGE).not.toMatch(/function toneStripeClass/);
    // The two live tone helpers stay.
    expect(MONTHLY_PAGE).toMatch(/function dotForTone/);
    expect(MONTHLY_PAGE).toMatch(/function toneHeadlineClass/);
  });

  it("reading order: chapters in the rail appear in board-reading order (labels drive ids via chapterIdFor)", () => {
    // The chapter entries declare `label` (not `id` — per the 2026-
    // 06-19 naming-convention enforcement). Pull label strings from
    // MONTHLY_CHAPTERS in source order; apply the same chapterIdFor
    // slugify that the shell uses; assert the derived sequence
    // matches the new spec exactly.
    const labelMatches = Array.from(
      REPORTING_LAYOUT.matchAll(/label: "([^"]+)"/g),
      (m) => m[1],
    );
    function chapterIdFor(label: string): string {
      return label
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    }
    const idMatches = labelMatches.map(chapterIdFor);
    // The rail now holds 14 chapters; the STEWARDSHIP group is gone;
    // the "Operations & Analytics" label survives ONLY as a group
    // heading (chapter retired 2026-06-19).
    expect(idMatches).toEqual([
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
    ]);
  });

  it("monthly page no longer renders its own chapter rail or grid wrapper", () => {
    // The page's old grid + aside chapter nav are gone — those moved
    // up into the layout / shell.
    expect(MONTHLY_PAGE).not.toMatch(/data-testid="monthly-section-nav"/);
    expect(MONTHLY_PAGE).not.toMatch(/lg:grid-cols-\[220px_1fr\]/);
    // The page body is the dominant element under the shell.
    expect(MONTHLY_PAGE).toMatch(/data-testid="monthly-reporting-body"/);
  });

  it("reporting layout still relies on the parent admin layout for auth + per-page permission gating", () => {
    // Layout itself does NOT call hasPermission — that stays on each page.
    expect(REPORTING_LAYOUT).not.toMatch(/hasPermission/);
    // Page still gates on reports:board.
    expect(MONTHLY_PAGE).toMatch(/hasPermission\(principal, clubId, "reports:board"\)/);
  });

  // ---------------------------------------------------------------
  // Executive Reporting Theme — scoped to the reporting shell only.
  // ---------------------------------------------------------------
  it("ReportingShell paints the Executive Reporting Theme (deep green / ivory / muted gold)", () => {
    // Theme attribute so DOM-walkers can target the scope.
    expect(SHELL).toMatch(/data-report-theme="executive"/);

    // Deep private-club green in the header background; ivory text on it.
    expect(SHELL).toMatch(/bg-club-green-900/);
    expect(SHELL).toMatch(/text-club-cream/);

    // Cream parchment canvas underneath the report body.
    expect(SHELL).toMatch(/bg-club-cream/);

    // Muted gold accents — pinstripe under header, period chip ring,
    // chapter numerals, focus ring.
    expect(SHELL).toMatch(/border-club-gold\/30/);
    expect(SHELL).toMatch(/border-club-gold\/45/);
    expect(SHELL).toMatch(/text-club-gold/);
    expect(SHELL).toMatch(/ring-club-gold\/50/);

    // Subtle parchment-toned borders replace stone-200 in the rail.
    expect(SHELL).toMatch(/border-club-sand/);

    // No leftover SaaS-neutral stone classes inside the themed shell
    // (we want the cream/green/gold palette to dominate).
    expect(SHELL).not.toMatch(/border-stone-200/);
    expect(SHELL).not.toMatch(/text-stone-(?:500|600|700|900)/);
    expect(SHELL).not.toMatch(/bg-stone-(?:50|100)/);
  });

  it("AdminShell reporting-mode wrapper paints cream so first paint matches the theme", () => {
    expect(ADMIN_SHELL).toMatch(/data-testid="reporting-mode-shell"[^>]*bg-club-cream/);
  });

  it("Executive Reporting Theme — color audit close-out (chips, dots, strokes)", () => {
    // Color audit close-out (docs/monthly-reporting-color-audit.md):
    //   C1 — no pastel chip backgrounds anywhere on the page
    //   C2 — no stoplight saturation tone dots (-500 step is banned)
    //   C3 — no bg-stone-300 neutral dot (stone tokens fully purged)
    //   H1 — no pastel ring colors (ring-{amber,red,club-green}-200)
    //   H2 — no #a85a1f burnt-orange sparkline stroke
    //   M1/M2 — text-red-700 and text-amber-700 are the single named
    //           tones for those statuses (no -800 chip text drift)
    expect(MONTHLY_PAGE).not.toMatch(/bg-amber-50/);
    expect(MONTHLY_PAGE).not.toMatch(/bg-red-50/);
    expect(MONTHLY_PAGE).not.toMatch(/bg-club-green-50/);
    expect(MONTHLY_PAGE).not.toMatch(/bg-club-green-500/);
    expect(MONTHLY_PAGE).not.toMatch(/bg-amber-500/);
    expect(MONTHLY_PAGE).not.toMatch(/bg-red-500/);
    expect(MONTHLY_PAGE).not.toMatch(/bg-stone-300/);
    expect(MONTHLY_PAGE).not.toMatch(/ring-amber-200/);
    expect(MONTHLY_PAGE).not.toMatch(/ring-red-200/);
    expect(MONTHLY_PAGE).not.toMatch(/ring-club-green-200/);
    expect(MONTHLY_PAGE).not.toMatch(/#a85a1f/);
    expect(MONTHLY_PAGE).not.toMatch(/text-red-800/);
    expect(MONTHLY_PAGE).not.toMatch(/text-amber-800/);
  });

  it("Executive Reporting Theme — chips are paper-on-paper (cream bg + sand or gold ring)", () => {
    // ToneChip + DataSourceChip both render with bg-club-cream so the
    // chip reads as paper on the cream report body, not as a pastel
    // SaaS warning/error/success badge. Slice each function body by
    // indexOf so we capture the whole function, not just the signature.
    const sliceBody = (name: string, next: string): string => {
      const start = MONTHLY_PAGE.indexOf(`function ${name}(`);
      if (start < 0) return "";
      const end = MONTHLY_PAGE.indexOf(next, start + 1);
      return end > 0 ? MONTHLY_PAGE.slice(start, end) : MONTHLY_PAGE.slice(start);
    };

    const tone = sliceBody("ToneChip", "\nfunction ");
    expect(tone.length, "ToneChip body must be sliced").toBeGreaterThan(0);
    expect(tone).toMatch(/bg-club-cream/);
    // Word-boundary on -50 so the matcher does not also hit -500.
    expect(tone).not.toMatch(/bg-(?:amber|red|club-green)-50(?!\d)/);

    const data = sliceBody("DataSourceChip", "\nfunction DemoChip");
    expect(data.length, "DataSourceChip body must be sliced").toBeGreaterThan(0);
    expect(data).toMatch(/bg-club-cream/);
    expect(data).toMatch(/text-club-gold-700/);
    expect(data).not.toMatch(/bg-(?:amber|club-green)-50(?!\d)/);
  });

  it("Executive Reporting Theme — tone dots use the desaturated -700 step", () => {
    // dotForTone collapses every -500 stoplight to -700 per spec.
    // Neutral moves from bg-stone-300 to bg-club-sand.
    const dotMatch = MONTHLY_PAGE.match(/function dotForTone\([\s\S]+?\n\}/);
    expect(dotMatch).toBeTruthy();
    const dot = dotMatch![0];
    expect(dot).toMatch(/bg-club-green-700/);
    expect(dot).toMatch(/bg-amber-700/);
    expect(dot).toMatch(/bg-red-700/);
    expect(dot).toMatch(/bg-club-sand/);
    expect(dot).not.toMatch(/-500/);
    expect(dot).not.toMatch(/bg-stone-/);
  });

  it("Executive Reporting Theme — no burnt-orange #a85a1f stroke regresses onto the page", () => {
    // Color audit H2 close-out — burnt-orange #a85a1f had been
    // replaced with club-gold #b08a4a on the F&B subsidy sparkline
    // inside the Experience Stewardship chapter. That chapter was
    // retired 2026-06-19, so the positive #b08a4a assertion no
    // longer applies to the page, but the burnt-orange regression
    // guard stays — any future chart that wants gold MUST use the
    // theme token #b08a4a, never the SaaS burnt-orange.
    expect(MONTHLY_PAGE).not.toMatch(/stroke="#a85a1f"/);
  });

  it("Executive Reporting Theme — tailwind ships the club-gold-700 AA variant", () => {
    const TAILWIND_CONFIG = fs.readFileSync(
      path.resolve(process.cwd(), "tailwind.config.ts"),
      "utf8",
    );
    // The AA-compliant gold variant for chip text on cream.
    expect(TAILWIND_CONFIG).toMatch(/gold:\s*\{[\s\S]+?DEFAULT:\s*"#b08a4a"[\s\S]+?700:\s*"#6b5028"/);
  });

  it("Executive Reporting Theme — ChapterOrnament punctuates between chapters", () => {
    // The aldus-leaf ornament + hair rules provides the printed-page
    // chapter-break rhythm a premium board pack carries. The component
    // exists and is wired between sections II through XIII (twelve
    // ornaments — chapter II Chair's Dashboard gets the first one
    // since it sits directly below the cover briefing column, and
    // chapter III Board Financial Briefing now gets one too after
    // the Chair's Dashboard insertion).
    expect(MONTHLY_PAGE).toMatch(/function ChapterOrnament\(/);
    expect(MONTHLY_PAGE).toMatch(/data-testid="chapter-ornament"/);
    expect(MONTHLY_PAGE).toMatch(/aria-hidden="true"/);
    // Aldus leaf glyph (decorative HTML entity).
    expect(MONTHLY_PAGE).toMatch(/&#10086;/);
    // Twelve ornament insertions after the legacy "Payroll",
    // "F&B / Hospitality", "Membership Stewardship", "Experience
    // Stewardship", and standalone "Operations & Analytics" chapters
    // were removed 2026-06-19. Chapters III through XIV each carry
    // one (12 ornaments total — chapter II skips the ornament by
    // design).
    const ornamentCount = (MONTHLY_PAGE.match(/<ChapterOrnament \/>/g) ?? []).length;
    expect(ornamentCount, "ornament should appear before chapters III through XIV").toBe(12);
  });

  it("cover carries a single restrained Spectre Framework colophon citing all five pillars", () => {
    // Framework-citation audit C1 close-out: a single italic-serif
    // line in the cover colophon identifies the governance instrument
    // the document implements. Per the user's "do not make branding
    // excessive" constraint, the citation appears here once and
    // nowhere else on the page chrome.
    expect(MONTHLY_PAGE).toMatch(/data-testid="monthly-cover-framework"/);
    expect(MONTHLY_PAGE).toMatch(/Prepared using the Spectre Framework\./);
    // The framework colophon is intentionally a single short line — the
    // five pillars are cited downstream via per-chapter PillarChips, so
    // listing them here would just clutter the cover. A separate
    // confidentiality line sits directly below.
    expect(MONTHLY_PAGE).not.toMatch(
      /monthly-cover-framework[\s\S]{0,200}Operating, Capital,/,
    );
    expect(MONTHLY_PAGE).toMatch(/data-testid="monthly-cover-confidentiality"/);
    expect(MONTHLY_PAGE).toMatch(
      /This report is confidential and intended solely for the Board of Directors\./,
    );
    // Italic-serif treatment per L4 spec — quiet, not loud — preserved
    // on both lines.
    expect(MONTHLY_PAGE).toMatch(
      /data-testid="monthly-cover-framework"[\s\S]*?font-serif italic[\s\S]*?text-club-green-800\/65/,
    );
    expect(MONTHLY_PAGE).toMatch(
      /data-testid="monthly-cover-confidentiality"[\s\S]*?font-serif italic[\s\S]*?text-club-green-800\/65/,
    );
  });

  // Test "chapter XV Capital Projects ships an L4 framing lead citing
  // Pillar 2" was removed 2026-06-17 alongside the legacy Capital /
  // Projects chapter the assertion guarded. The canonical Capital
  // Projects surface (chapter VI Capital Project Tracker) is pinned
  // by its own dedicated source-contract test elsewhere in this file.

  it("Executive Reporting Theme — at-a-glance KPI tiles drop the outer border", () => {
    // The KpiCardView tiles sit on cream as bordered web-app cards no
    // longer; the outer border-club-sand has been removed so the tile
    // reads as a printed page element. Cream-on-white contrast carries
    // the tile boundary.
    const body = (function () {
      const start = MONTHLY_PAGE.indexOf("function KpiCardView(");
      const end = MONTHLY_PAGE.indexOf("\nfunction ", start + 1);
      return MONTHLY_PAGE.slice(start, end);
    })();
    expect(body).toMatch(/className="flex flex-col rounded-lg bg-white p-7"/);
    expect(body).not.toMatch(/border-club-sand bg-white/);
  });

  it("Executive Reporting Theme — operating headline tiles drop the outer border", () => {
    // Same treatment as KpiCardView — the OperatingHeadlineTile drops
    // its outer border. Five chapters (VI Operations, VII Payroll,
    // VIII F&B) consume this primitive; consistency across them keeps
    // the document reading uniform.
    const body = (function () {
      const start = MONTHLY_PAGE.indexOf("function OperatingHeadlineTile(");
      const end = MONTHLY_PAGE.indexOf("\nfunction ", start + 1);
      return MONTHLY_PAGE.slice(start, end);
    })();
    // Four-pillar KPI redesign: OperatingHeadlineTile now uses
    // `flex flex-col` to host context paragraph + hairline-divided
    // benchmark/status footer. Outer border still absent.
    expect(body).toMatch(/className="flex flex-col rounded-lg bg-white p-5"/);
    expect(body).not.toMatch(/border-club-sand bg-white/);
  });

  // ---------------------------------------------------------------
  // Print Mode toggle — board package PDF preview without wiring a
  // PDF renderer yet. The toggle sets data-print-mode="true" on the
  // shell root; @media print mirrors the same rules.
  // ---------------------------------------------------------------
  it("ReportingShell ships the Print Mode toggle + data-print-mode attribute", () => {
    // useState hook in the shell + toggle component.
    expect(SHELL).toMatch(/const \[printMode, setPrintMode\] = useState\(false\)/);
    // The shell root carries the data-print-mode attribute (undefined
    // when off so the attribute is absent in the DOM by default).
    expect(SHELL).toMatch(/data-print-mode=\{printMode \? "true" : undefined\}/);
    // PrintModeToggle component exists with a printer icon + an SVG path.
    expect(SHELL).toMatch(/function PrintModeToggle\(/);
    expect(SHELL).toMatch(/data-testid="print-mode-toggle"/);
    expect(SHELL).toMatch(/aria-pressed=\{printMode\}/);
    // The button is wired into the shell header.
    expect(SHELL).toMatch(/<PrintModeToggle[\s\S]+?onToggle=/);
  });

  it("globals.css ships [data-print-mode='true'] preview rules AND @media print rules", () => {
    const GLOBALS = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/globals.css"),
      "utf8",
    );
    // On-screen toggle path hides shell chrome. The controls-strip
    // selector was removed in the body-polish pass (the strip itself
    // was deleted per audit C1, so the rule had nothing to match).
    expect(GLOBALS).toMatch(/\[data-print-mode="true"\] \[data-testid="reporting-shell-header"\]/);
    expect(GLOBALS).toMatch(/\[data-print-mode="true"\] \[data-testid="reporting-shell-chapters"\]/);
    expect(GLOBALS).not.toMatch(/monthly-cover-controls-strip/);
    // @media print pass hides the same chrome PLUS the toggle itself,
    // sets page margins, and forces accurate colour rendering.
    expect(GLOBALS).toMatch(/@media print \{/);
    expect(GLOBALS).toMatch(/@page \{[\s\S]+?margin: 18mm 14mm;/);
    expect(GLOBALS).toMatch(/data-testid="print-mode-toggle"\][\s\S]*?display: none/);
    expect(GLOBALS).toMatch(/print-color-adjust: exact;/);
    // break-inside guards against awkward chart / card splits.
    expect(GLOBALS).toMatch(/break-inside: avoid;/);
    expect(GLOBALS).toMatch(/page-break-inside: avoid;/);
  });

  // ---------------------------------------------------------------
  // Cover redesign — the opening section is now a document cover,
  // not a header card. ~78vh of cream parchment; centered prestige
  // serif title; package controls live in a quiet strip beneath.
  // ---------------------------------------------------------------
  it("cover renders the documented blocks with their testids (two-column briefing cover)", () => {
    // Cover redesign — the cover is now a two-column Executive
    // Briefing layout (Saguaro p01 pattern). LEFT column carries the
    // identity stack (club name, period, FY context, committee,
    // prepared date, framework colophon). RIGHT column carries the
    // Executive Briefing — three medium-density briefing cards +
    // anchor link to chapter III (Board Financial Briefing).
    //
    // Static testids (set as JSX string literals on the source).
    for (const id of [
      "monthly-cover",
      "monthly-cover-masthead",
      "monthly-cover-package-label",
      "monthly-cover-identity",
      "monthly-cover-club-name",
      "monthly-cover-period",
      "monthly-cover-fy",
      "monthly-cover-prepared-for",
      "monthly-cover-briefing",
    ]) {
      expect(MONTHLY_PAGE.includes(`data-testid="${id}"`), `${id} testid missing`).toBe(true);
    }
    // "monthly-cover-briefing-link" was deliberately REMOVED so the
    // briefing column can distribute its three cards over the full
    // identity-column height — no anchor expected on the cover.
    expect(MONTHLY_PAGE).not.toMatch(/data-testid="monthly-cover-briefing-link"/);
    // The three cover briefing cards now render via their dedicated
    // first-scroll atoms (Operations / Financial Health / Capital
    // Program). The cover-briefing-* testid surface is asserted by
    // the dedicated-atom tests further down this file; here we just
    // confirm the three atoms are wired on the cover.
    expect(MONTHLY_PAGE).toMatch(/<OperationsBriefingCard\s+b=\{pkg\.boardBriefing\.operations\}/);
    expect(MONTHLY_PAGE).toMatch(/<FinancialHealthBriefingCard\s+b=\{pkg\.boardBriefing\.financialHealth\}/);
    expect(MONTHLY_PAGE).toMatch(/<CapitalProgramBriefingCard\s+b=\{pkg\.boardBriefing\.capitalProgram\}/);
  });

  it("cover uses a two-column layout — left identity + right Executive Briefing", () => {
    // Masthead is still the full-width letterhead above the body. The
    // gold hair rule used to be a separate `<div h-px w-full bg-club-gold>`
    // below the row; the header-baseline refactor unified it with the
    // rail's `border-b border-club-sand pb-3` pattern so MBRP + EB +
    // "IN THIS PACKAGE" all share one underline rhythm.
    expect(MONTHLY_PAGE).toMatch(/data-testid="monthly-cover-masthead"/);
    expect(MONTHLY_PAGE).toMatch(
      /data-testid="monthly-cover-masthead"[\s\S]{0,1000}border-b border-club-sand pb-3/,
    );
    // Cover body is a fluid 2-track grid: identity expands as `1fr` to
    // claim any horizontal space the briefing column doesn't take;
    // briefing is capped at minmax(540px, 640px) so its cards stay
    // readable at wide viewports without leaving dead space at narrow
    // ones. The masthead row uses the SAME template, so the package
    // label cell sits directly above the identity column and EB sits
    // directly above the briefing column.
    expect(MONTHLY_PAGE).toMatch(
      /lg:grid-cols-\[minmax\(0,1fr\)_minmax\(0,1fr\)\]/,
    );
    expect(MONTHLY_PAGE).toMatch(/data-testid="monthly-cover-identity"/);
    expect(MONTHLY_PAGE).toMatch(/data-testid="monthly-cover-briefing"/);
    // No more explicit col-span pins — children land by source order.
    expect(MONTHLY_PAGE).not.toMatch(/data-testid="monthly-cover-identity"[^>]*lg:col-span-5/);
    expect(MONTHLY_PAGE).not.toMatch(/data-testid="monthly-cover-briefing"[^>]*lg:col-span-7/);
    // The container is left/right body, not the old centered single
    // column.
    expect(MONTHLY_PAGE).not.toMatch(
      /data-testid="monthly-cover"[\s\S]{0,200}text-center/,
    );
    // Document-type label text matches the running header.
    expect(MONTHLY_PAGE).toMatch(/Monthly Board Reporting Package/);
  });

  it("cover club name uses the trimmed-prestige typography (L1 text-5xl, ~65% reduction)", () => {
    // Two-column redesign trims the club name from text-7xl (72px)
    // to text-5xl (48px) — premium serif preserved, but the
    // vertical footprint shrinks ~65% so the right-side briefing
    // claims the new screen real estate.
    expect(MONTHLY_PAGE).toMatch(
      /data-testid="monthly-cover-club-name"[\s\S]*?className=".*?font-serif.*?text-5xl[\s\S]*?text-club-green-900/,
    );
    // The old ceremonial text-7xl ceiling is gone from the cover.
    const clubName = MONTHLY_PAGE.match(
      /data-testid="monthly-cover-club-name"[\s\S]*?className="[^"]+"/,
    );
    expect(clubName, "cover club name must be findable").toBeTruthy();
    expect(clubName![0]).not.toMatch(/text-7xl/);
    // L2 cover subtitle (period date) — reduced from text-2xl (24px) to
    // text-xl (20px) per the editorial-hierarchy refresh: the
    // reporting-period reads as the secondary heading now, not as a
    // competing primary line under the club name.
    expect(MONTHLY_PAGE).toMatch(
      /data-testid="monthly-cover-period"[\s\S]*?className=".*?font-serif.*?text-xl/,
    );
  });

  it("cover is the editorial header (no card chrome) and sits adjacent to chapter II so the next-section teases above the fold", () => {
    // Saguaro-style next-section tease pass: the cover no longer claims
    // 100vh-96px. Its natural content height + a small mt-2 gap places
    // the Chair's Dashboard eyebrow just inside the 1440×900 viewport
    // bottom — the founder requirement that "the user visually
    // understands there is more report below". Empirical proof at
    // tests/e2e/next-chapter-tease.spec.ts.
    expect(MONTHLY_PAGE).toMatch(/data-testid="monthly-cover"/);
    expect(MONTHLY_PAGE).not.toMatch(/data-testid="monthly-cover"[\s\S]{0,200}?min-h-\[calc\(100vh-96px\)\]/);
    // It is NOT wrapped in admin card chrome (white card + stone borders).
    const headerMatch = MONTHLY_PAGE.match(
      /<header data-testid="monthly-package-header"[^>]*>/,
    );
    expect(headerMatch, "header element must exist").toBeTruthy();
    expect(headerMatch![0]).not.toMatch(/bg-white/);
    expect(headerMatch![0]).not.toMatch(/rounded-lg/);
    expect(headerMatch![0]).not.toMatch(/border-stone-200/);
  });

  it("cover includes prepared-for + fiscal year + understated metadata copy", () => {
    expect(MONTHLY_PAGE).toMatch(/Prepared for/);
    // "The " prefix dropped — "Finance Committee" + "Board of Directors"
    // reads cleaner as one restrained metadata block per the editorial
    // refresh.
    expect(MONTHLY_PAGE).toMatch(/Finance Committee/);
    expect(MONTHLY_PAGE).not.toMatch(/The Finance Committee/);
    expect(MONTHLY_PAGE).toMatch(/Board of Directors/);
    expect(MONTHLY_PAGE).toMatch(/Period \{ordinalWord\(pkg\.period\.ytdMonthsElapsed\)\} of Twelve/);
    // "Prepared on {preparedDate}" REMOVED from the cover per the
    // tighter identity-column refresh; the period-ended subtitle
    // ("For the period ended May 31, 2026") carries the reporting
    // date now, so the duplicate letterhead line is dropped.
    expect(MONTHLY_PAGE).not.toMatch(/Prepared on \{preparedDate\}/);
    // FY-prefix on the period eyebrow REMOVED — the period reads as
    // just "Period N of Twelve"; fiscal-year context is implicit in
    // the period-ended subtitle above.
    expect(MONTHLY_PAGE).not.toMatch(
      /data-testid="monthly-cover-fy"[\s\S]{0,400}\{pkg\.period\.fiscalYearLabel\}/,
    );
    // Cover SUBTITLE pulls from periodEndedLabel ("For the period
    // ended May 31, 2026") rather than the bare month label.
    expect(MONTHLY_PAGE).toMatch(/\{pkg\.period\.periodEndedLabel\}/);
    // Club identity meta line ("CITY, PROVINCE · EST. YEAR") is
    // rendered from ClubProfile (Admin → Club Settings). Smallcaps
    // treatment matches the other identity-column eyebrows.
    expect(MONTHLY_PAGE).toMatch(/data-testid="monthly-cover-club-meta"/);
  });

  // -----------------------------------------------------------------
  // Cover redesign — Executive Briefing column
  // -----------------------------------------------------------------
  it("cover briefing column wires three tiles — Operations, Financial Health, and Capital Program — to dedicated first-scroll atoms", () => {
    // All three Pillar-1/2/3 briefing blocks are read from the service.
    expect(MONTHLY_PAGE).toMatch(/pkg\.boardBriefing\.operations/);
    expect(MONTHLY_PAGE).toMatch(/pkg\.boardBriefing\.financialHealth/);
    expect(MONTHLY_PAGE).toMatch(/pkg\.boardBriefing\.capitalProgram/);
    // Each card renders via its dedicated first-scroll atom with the
    // standard's required metrics for its area.
    expect(MONTHLY_PAGE).toMatch(/<OperationsBriefingCard b=\{pkg\.boardBriefing\.operations\}/);
    expect(MONTHLY_PAGE).toMatch(/<FinancialHealthBriefingCard b=\{pkg\.boardBriefing\.financialHealth\}/);
    expect(MONTHLY_PAGE).toMatch(/<CapitalProgramBriefingCard b=\{pkg\.boardBriefing\.capitalProgram\}/);
    // Runtime testids set as JSX string literals on each dedicated atom.
    expect(MONTHLY_PAGE).toMatch(/data-testid="cover-briefing-operations"/);
    expect(MONTHLY_PAGE).toMatch(/data-testid="cover-briefing-financial-health"/);
    expect(MONTHLY_PAGE).toMatch(/data-testid="cover-briefing-capital-program"/);
    // The generic CoverBriefingCard atom is no longer wired into the
    // cover render (no more genericBriefingCards array on the cover).
    expect(MONTHLY_PAGE).not.toMatch(/genericBriefingCards/);
  });

  it("CoverBriefingCard atom carries the medium-density anatomy (headline + narrative + 2-row dl + chip)", () => {
    const body = sliceFn("CoverBriefingCard");
    expect(body.length, "CoverBriefingCard body must be sliced").toBeGreaterThan(0);
    // 1. Status headline — title in serif + tone dot + statusLabel.
    expect(body).toMatch(/cardKey/);
    expect(body).toMatch(/dotForTone\(b\.status\)/);
    expect(body).toMatch(/data-testid=\{`cover-briefing-\$\{cardKey\}-status`\}/);
    expect(body).toMatch(/font-serif text-lg/);
    // 2. Concise narrative — opening clause of the source memo,
    // capped at ~140 chars (firstClause helper) so the three cards
    // balance visually when one memo's first sentence is materially
    // longer than the others.
    expect(body).toMatch(/firstClause\(b\.narrative\)/);
    expect(body).toMatch(/data-testid=\{`cover-briefing-\$\{cardKey\}-narrative`\}/);
    // 3. Mini KPI dl — first two chips, label + value (+ optional subtitle).
    expect(body).toMatch(/b\.chips\.slice\(0, 2\)/);
    expect(body).toMatch(/data-testid=\{`cover-briefing-\$\{cardKey\}-kpis`\}/);
    expect(body).toMatch(/tabular-nums/);
    // 4. Board Consideration chip — the four-state cascade.
    expect(body).toMatch(/<BoardConsiderationChip consideration=\{b\.consideration\}/);
    // Paper-on-paper card chrome — white tile + single hairline border.
    expect(body).toMatch(/bg-white/);
    expect(body).toMatch(/border-club-sand/);
  });

  // ---------------------------------------------------------------
  // Operations briefing card — dedicated first-scroll atom
  // ---------------------------------------------------------------
  it("Operations briefing block carries the cover-specific fields (question + coverNarrative + coverMetrics)", async () => {
    const club = await bootstrapAPClub("Operations Cover Briefing Shape");
    const pkg = await getMonthlyReportingPackage(club.id);
    const o = pkg.boardBriefing.operations;
    // statusLabel is one of the three documented headline states.
    expect(["On Plan", "Watch", "Off Plan"]).toContain(o.statusLabel);
    // Question text — the briefing question the card answers.
    expect(o.question).toBe("Are we operating successfully?");
    // Cover narrative — max 2 sentences (period count ≤ 2).
    expect(o.coverNarrative.length).toBeGreaterThan(20);
    const sentenceCount = (o.coverNarrative.match(/\.\s|\.$/g) ?? []).length;
    expect(sentenceCount, "coverNarrative must be max 2 sentences").toBeLessThanOrEqual(2);
    // Three Operating Health metrics named in the first-scroll standard.
    expect(o.coverMetrics.length).toBe(3);
    const metricKeys = o.coverMetrics.map((m) => m.key);
    expect(metricKeys).toContain("revenue");
    expect(metricKeys).toContain("noi");
    expect(metricKeys).toContain("dues-rev");
    // Each metric ships label + value + sub (comparator) — required by
    // the design system's "never print a raw number alone" rule.
    for (const m of o.coverMetrics) {
      expect(m.label.length, `${m.key} label`).toBeGreaterThan(0);
      expect(m.value.length, `${m.key} value`).toBeGreaterThan(0);
      expect(m.sub.length,   `${m.key} sub (comparator)`).toBeGreaterThan(0);
    }
  });

  it("OperationsBriefingCard atom enforces headline-dominant / narrative-between / metrics-subordinate hierarchy", () => {
    const body = sliceFn("OperationsBriefingCard");
    expect(body.length, "OperationsBriefingCard body must be sliced").toBeGreaterThan(0);
    // Testid + tone attribute on the article wrapper.
    expect(body).toMatch(/data-testid="cover-briefing-operations"/);
    expect(body).toMatch(/data-tone=\{b\.status\}/);
    // 1. CONCLUSION — status verdict in serif tone-coloured editorial
    //    green. Bumped from text-2xl to text-[26px] / [@height≥880]:
    //    text-[30px] so the conclusion out-weighs the narrative
    //    visually per the Saguaro-style hierarchy. The status dot has
    //    been removed; typography + colour carry the verdict.
    expect(body).toMatch(/data-testid="cover-briefing-operations-status"/);
    expect(body).toMatch(
      /data-testid="cover-briefing-operations-status"[\s\S]*?font-serif text-\[18px\][\s\S]*?toneBriefingHeadlineClass\(b\.status\)/,
    );
    // Title eyebrow stays subordinate to the headline — text-[10px]
    // smallcaps, not a serif display tier.
    expect(body).toMatch(/data-testid="cover-briefing-operations-title"/);
    expect(body).toMatch(
      /data-testid="cover-briefing-operations-title"[\s\S]*?text-\[14px\] uppercase tracking-\[0\.18em\] font-semibold/,
    );
    // Italic-serif question caption — the briefing question this card
    // answers (L4-style).
    expect(body).toMatch(/data-testid="cover-briefing-operations-question"/);
    expect(body).toMatch(
      /data-testid="cover-briefing-operations-question"[\s\S]*?font-serif italic/,
    );
    // 2. NARRATIVE — sits between the headline and the metrics. Pulls
    //    directly from the service coverNarrative field (no UI
    //    truncation).
    expect(body).toMatch(/data-testid="cover-briefing-operations-narrative"/);
    expect(body).toMatch(/\{b\.coverNarrative\}/);
    // 3. METRICS — 3-column grid, subordinate to the headline. label
    //    in smallcaps + value in serif text-base tabular-nums.
    expect(body).toMatch(/data-testid="cover-briefing-operations-kpis"/);
    expect(body).toMatch(/grid-cols-3/);
    expect(body).toMatch(/b\.coverMetrics\.map/);
    expect(body).toMatch(/font-serif text-base[\s\S]*?tabular-nums/);
    // 4. Board Consideration footer REMOVED — the footer was consuming
    //    vertical space and shrinking the narrative copy. The
    //    BoardConsiderationChip atom is still used in every long-form
    //    commentary block downstream; only the cover card footer was
    //    deleted, so the cover-card narrative can grow to a more
    //    legible size (text-[14px]/[15px] vs the prior text-[12.5px]).
    expect(body).not.toMatch(/<BoardConsiderationChip/);
    expect(body).not.toMatch(/Board consideration/);
    // Card chrome REMOVED (Saguaro-style continuous panel) — the
    // briefing is no longer three boxed tiles. No bg-white, no
    // rounded border. Items are separated by `border-t border-club-
    // sand/40` + top padding, with `first:` stripping it from the
    // leading item so the panel flows as one document.
    expect(body).not.toMatch(/bg-white/);
    expect(body).not.toMatch(/rounded-lg/);
    // Inter-item separator darkened from /40 (too faint) to full
    // base `border-club-sand` token so the briefing items are visibly
    // distinct without resorting to boxed-card chrome.
    // Inter-item separator strengthened from `border-club-sand` (which
    // was barely visible on the cream body) to `border-club-green-800/25`
    // — a green-tinted hairline with materially more contrast, so the
    // briefing items are visibly distinct without resorting to boxed-
    // card chrome.
    expect(body).toMatch(/border-t border-club-green-800\/25/);
    expect(body).toMatch(/first:border-t-0/);
    // Status dot REMOVED — typography + colour carry the verdict.
    expect(body).not.toMatch(/h-2 w-2[\s\S]*?rounded-full/);
  });

  it("Operations card source-order: title eyebrow → question → conclusion → narrative → metrics", () => {
    const body = sliceFn("OperationsBriefingCard");
    // The five anchored testids must appear in this exact source order
    // — the visual hierarchy is enforced by markup order, not just by
    // typography.
    const ordered = [
      "cover-briefing-operations-title",
      "cover-briefing-operations-question",
      "cover-briefing-operations-status",
      "cover-briefing-operations-narrative",
      "cover-briefing-operations-kpis",
    ];
    let lastIdx = -1;
    for (const id of ordered) {
      const idx = body.indexOf(`data-testid="${id}"`);
      expect(idx, `${id} must appear in source`).toBeGreaterThan(-1);
      expect(idx, `${id} must appear after ${ordered[ordered.indexOf(id) - 1] ?? "start"}`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  // ---------------------------------------------------------------
  // Financial Health briefing card — dedicated first-scroll atom
  // ---------------------------------------------------------------
  it("Financial Health briefing block carries the cover-specific fields (question + coverNarrative + coverMetrics ×4)", async () => {
    const club = await bootstrapAPClub("Financial Health Cover Briefing Shape");
    const pkg = await getMonthlyReportingPackage(club.id);
    const f = pkg.boardBriefing.financialHealth;
    // statusLabel is one of the four documented headline states.
    expect(["Strong Position", "Stable", "Watch", "Concern"]).toContain(f.statusLabel);
    // Question text — the briefing question the card answers.
    expect(f.question).toBe("Is the Club financially healthy?");
    // Cover narrative — max 2 sentences.
    expect(f.coverNarrative.length).toBeGreaterThan(20);
    const sentenceCount = (f.coverNarrative.match(/\.\s|\.$/g) ?? []).length;
    expect(sentenceCount, "coverNarrative must be max 2 sentences").toBeLessThanOrEqual(2);
    // Four Financial Health metrics named in the first-scroll standard.
    expect(f.coverMetrics.length).toBe(4);
    const metricKeys = f.coverMetrics.map((m) => m.key);
    expect(metricKeys).toContain("working-capital");
    expect(metricKeys).toContain("reserve-coverage");
    expect(metricKeys).toContain("current-ratio");
    expect(metricKeys).toContain("ar-current");
    // Each metric ships label + value + sub (comparator).
    for (const m of f.coverMetrics) {
      expect(m.label.length, `${m.key} label`).toBeGreaterThan(0);
      expect(m.value.length, `${m.key} value`).toBeGreaterThan(0);
      expect(m.sub.length,   `${m.key} sub (comparator)`).toBeGreaterThan(0);
    }
  });

  it("FinancialHealthBriefingCard atom mirrors OperationsBriefingCard anatomy with 4-col metric grid", () => {
    const body = sliceFn("FinancialHealthBriefingCard");
    expect(body.length, "FinancialHealthBriefingCard body must be sliced").toBeGreaterThan(0);
    // Testid + tone attribute on the article wrapper.
    expect(body).toMatch(/data-testid="cover-briefing-financial-health"/);
    expect(body).toMatch(/data-tone=\{b\.status\}/);
    // 1. CONCLUSION — serif tone-coloured, bumped to text-[26px] /
    //    [@height≥880]:text-[30px] per the Saguaro-style redesign.
    //    Status dot removed.
    expect(body).toMatch(/data-testid="cover-briefing-financial-health-status"/);
    expect(body).toMatch(
      /data-testid="cover-briefing-financial-health-status"[\s\S]*?font-serif text-\[18px\][\s\S]*?toneBriefingHeadlineClass\(b\.status\)/,
    );
    // Title eyebrow subordinate to the headline.
    expect(body).toMatch(/data-testid="cover-briefing-financial-health-title"/);
    expect(body).toMatch(
      /data-testid="cover-briefing-financial-health-title"[\s\S]*?text-\[14px\] uppercase tracking-\[0\.18em\] font-semibold/,
    );
    // Italic-serif question caption — mirrors Operations.
    expect(body).toMatch(/data-testid="cover-briefing-financial-health-question"/);
    expect(body).toMatch(
      /data-testid="cover-briefing-financial-health-question"[\s\S]*?font-serif italic/,
    );
    // 2. NARRATIVE — pulls directly from coverNarrative.
    expect(body).toMatch(/data-testid="cover-briefing-financial-health-narrative"/);
    expect(body).toMatch(/\{b\.coverNarrative\}/);
    // 3. METRICS — 4-column grid (distinguishes Financial Health
    //    from the Operations card's 3-col grid).
    expect(body).toMatch(/data-testid="cover-briefing-financial-health-kpis"/);
    expect(body).toMatch(/grid-cols-4/);
    expect(body).toMatch(/b\.coverMetrics\.map/);
    expect(body).toMatch(/font-serif text-base[\s\S]*?tabular-nums/);
    // 4. Board Consideration footer REMOVED — see OperationsBriefingCard.
    expect(body).not.toMatch(/<BoardConsiderationChip/);
    expect(body).not.toMatch(/Board consideration/);
    // Card chrome REMOVED — Saguaro-style continuous panel. Same
    // assertions as OperationsBriefingCard.
    expect(body).not.toMatch(/bg-white/);
    expect(body).not.toMatch(/rounded-lg/);
    // Inter-item separator darkened from /40 (too faint) to full
    // base `border-club-sand` token so the briefing items are visibly
    // distinct without resorting to boxed-card chrome.
    // Inter-item separator strengthened from `border-club-sand` (which
    // was barely visible on the cream body) to `border-club-green-800/25`
    // — a green-tinted hairline with materially more contrast, so the
    // briefing items are visibly distinct without resorting to boxed-
    // card chrome.
    expect(body).toMatch(/border-t border-club-green-800\/25/);
    expect(body).toMatch(/first:border-t-0/);
    // Status dot REMOVED.
    expect(body).not.toMatch(/h-2 w-2[\s\S]*?rounded-full/);
  });

  it("Financial Health card source-order: title eyebrow → question → conclusion → narrative → metrics", () => {
    const body = sliceFn("FinancialHealthBriefingCard");
    const ordered = [
      "cover-briefing-financial-health-title",
      "cover-briefing-financial-health-question",
      "cover-briefing-financial-health-status",
      "cover-briefing-financial-health-narrative",
      "cover-briefing-financial-health-kpis",
    ];
    let lastIdx = -1;
    for (const id of ordered) {
      const idx = body.indexOf(`data-testid="${id}"`);
      expect(idx, `${id} must appear in source`).toBeGreaterThan(-1);
      expect(idx, `${id} must appear after ${ordered[ordered.indexOf(id) - 1] ?? "start"}`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  // ---------------------------------------------------------------
  // Capital Program briefing card — dedicated first-scroll atom
  // ---------------------------------------------------------------
  it("Capital Program briefing block carries the cover-specific fields (question + coverNarrative + coverMetrics ×4)", async () => {
    const club = await bootstrapAPClub("Capital Program Cover Briefing Shape");
    const pkg = await getMonthlyReportingPackage(club.id);
    const c = pkg.boardBriefing.capitalProgram;
    // statusLabel is one of the four documented headline states.
    expect(["Executing", "Monitor", "Delayed", "Critical"]).toContain(c.statusLabel);
    // Question text — the briefing question the card answers.
    expect(c.question).toBe("Are capital projects and reserve investments being executed properly?");
    // Cover narrative — max 2 sentences.
    expect(c.coverNarrative.length).toBeGreaterThan(20);
    const sentenceCount = (c.coverNarrative.match(/\.\s|\.$/g) ?? []).length;
    expect(sentenceCount, "coverNarrative must be max 2 sentences").toBeLessThanOrEqual(2);
    // Four Capital Health metrics named in the first-scroll standard.
    expect(c.coverMetrics.length).toBe(4);
    const metricKeys = c.coverMetrics.map((m) => m.key);
    expect(metricKeys).toContain("active-projects");
    expect(metricKeys).toContain("capital-spend-ytd");
    expect(metricKeys).toContain("reserve-contributions");
    expect(metricKeys).toContain("reserve-funded");
    // Each metric ships label + value + sub (comparator).
    for (const m of c.coverMetrics) {
      expect(m.label.length, `${m.key} label`).toBeGreaterThan(0);
      expect(m.value.length, `${m.key} value`).toBeGreaterThan(0);
      expect(m.sub.length,   `${m.key} sub (comparator)`).toBeGreaterThan(0);
    }
  });

  it("CapitalProgramBriefingCard atom mirrors FinancialHealthBriefingCard anatomy with 4-col metric grid", () => {
    const body = sliceFn("CapitalProgramBriefingCard");
    expect(body.length, "CapitalProgramBriefingCard body must be sliced").toBeGreaterThan(0);
    // Testid + tone attribute on the article wrapper.
    expect(body).toMatch(/data-testid="cover-briefing-capital-program"/);
    expect(body).toMatch(/data-tone=\{b\.status\}/);
    // 1. CONCLUSION — serif tone-coloured, bumped to text-[26px] /
    //    [@height≥880]:text-[30px] per the Saguaro-style redesign.
    //    Status dot removed.
    expect(body).toMatch(/data-testid="cover-briefing-capital-program-status"/);
    expect(body).toMatch(
      /data-testid="cover-briefing-capital-program-status"[\s\S]*?font-serif text-\[18px\][\s\S]*?toneBriefingHeadlineClass\(b\.status\)/,
    );
    // Title eyebrow subordinate to the headline.
    expect(body).toMatch(/data-testid="cover-briefing-capital-program-title"/);
    expect(body).toMatch(
      /data-testid="cover-briefing-capital-program-title"[\s\S]*?text-\[14px\] uppercase tracking-\[0\.18em\] font-semibold/,
    );
    // Italic-serif question caption — mirrors the other two cards.
    expect(body).toMatch(/data-testid="cover-briefing-capital-program-question"/);
    expect(body).toMatch(
      /data-testid="cover-briefing-capital-program-question"[\s\S]*?font-serif italic/,
    );
    // 2. NARRATIVE — pulls directly from coverNarrative.
    expect(body).toMatch(/data-testid="cover-briefing-capital-program-narrative"/);
    expect(body).toMatch(/\{b\.coverNarrative\}/);
    // 3. METRICS — 4-column grid matching Financial Health.
    expect(body).toMatch(/data-testid="cover-briefing-capital-program-kpis"/);
    expect(body).toMatch(/grid-cols-4/);
    expect(body).toMatch(/b\.coverMetrics\.map/);
    expect(body).toMatch(/font-serif text-base[\s\S]*?tabular-nums/);
    // 4. Board Consideration footer REMOVED — see OperationsBriefingCard.
    expect(body).not.toMatch(/<BoardConsiderationChip/);
    expect(body).not.toMatch(/Board consideration/);
    // Card chrome REMOVED — Saguaro-style continuous panel. Same
    // assertions as the sibling cards.
    expect(body).not.toMatch(/bg-white/);
    expect(body).not.toMatch(/rounded-lg/);
    // Inter-item separator darkened from /40 (too faint) to full
    // base `border-club-sand` token so the briefing items are visibly
    // distinct without resorting to boxed-card chrome.
    // Inter-item separator strengthened from `border-club-sand` (which
    // was barely visible on the cream body) to `border-club-green-800/25`
    // — a green-tinted hairline with materially more contrast, so the
    // briefing items are visibly distinct without resorting to boxed-
    // card chrome.
    expect(body).toMatch(/border-t border-club-green-800\/25/);
    expect(body).toMatch(/first:border-t-0/);
    // Status dot REMOVED.
    expect(body).not.toMatch(/h-2 w-2[\s\S]*?rounded-full/);
  });

  it("Capital Program card source-order: title eyebrow → question → conclusion → narrative → metrics", () => {
    const body = sliceFn("CapitalProgramBriefingCard");
    const ordered = [
      "cover-briefing-capital-program-title",
      "cover-briefing-capital-program-question",
      "cover-briefing-capital-program-status",
      "cover-briefing-capital-program-narrative",
      "cover-briefing-capital-program-kpis",
    ];
    let lastIdx = -1;
    for (const id of ordered) {
      const idx = body.indexOf(`data-testid="${id}"`);
      expect(idx, `${id} must appear in source`).toBeGreaterThan(-1);
      expect(idx, `${id} must appear after ${ordered[ordered.indexOf(id) - 1] ?? "start"}`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it("cover no longer ships the 'Read full memos →' anchor (briefing column distributes the three cards over its full height instead)", () => {
    // The anchor and its testid have been removed. The briefing column
    // now uses `flex flex-col justify-between` so the three cards
    // stretch the column's full height — there is no anchor occupying
    // the bottom of the column, and no chrome left behind. The
    // chapter-III deep-link is still reachable via the persistent
    // chapter rail.
    expect(MONTHLY_PAGE).not.toMatch(/data-testid="monthly-cover-briefing-link"/);
    expect(MONTHLY_PAGE).not.toMatch(/Read full memos/);
  });


  it("page no longer ships the admin disclaimer footer ('Tenant scope' / 'live source data is wired up')", () => {
    // Audit C2 + M6: the footer below the chapters used admin-stone
    // tokens and exposed developer language ("Tenant scope",
    // "live source data is wired up") to board readers. It has been
    // removed; each section's DataSourceChip carries the honest label.
    expect(MONTHLY_PAGE).not.toMatch(/Tenant scope/);
    expect(MONTHLY_PAGE).not.toMatch(/live source data is wired up/);
    expect(MONTHLY_PAGE).not.toMatch(/border-stone-200/);
    expect(MONTHLY_PAGE).not.toMatch(/bg-stone-50/);
  });

  // -----------------------------------------------------------------
  // Chapter XI — Membership Stewardship (Pillar 4)
  // -----------------------------------------------------------------
  it("Membership Stewardship service shape carries the five Pillar 4 dimensions", async () => {
    const club = await bootstrapAPClub("Membership Stewardship Shape");
    const pkg = await getMonthlyReportingPackage(club.id);
    const m = pkg.membershipStewardship;
    expect(m, "membershipStewardship section must exist").toBeDefined();
    expect(m.dataSource).toBe("demo");
    // Dimension 1 — active count + YTD net change.
    expect(m.activeMembers).toBeGreaterThan(0);
    expect(typeof m.netYTD).toBe("number");
    expect(m.newYTD).toBeGreaterThanOrEqual(0);
    expect(m.resignationsYTD).toBeGreaterThanOrEqual(0);
    // Dimension 2 — attrition (TTM rate + benchmark + 12-month trend).
    expect(m.attritionRateTTM).toMatch(/%/);
    expect(m.attritionBenchmark.toLowerCase()).toMatch(/peer/);
    expect(m.attritionTrend.length).toBe(12);
    // Dimension 3 — category mix (counts sum to active total).
    expect(m.categoryMix.length).toBeGreaterThanOrEqual(4);
    const categorySum = m.categoryMix.reduce((acc, row) => acc + row.count, 0);
    expect(categorySum, "category counts must sum to active membership").toBe(m.activeMembers);
    // YTD net deltas per category must sum to the headline net YTD.
    const netSum = m.categoryMix.reduce((acc, row) => acc + row.netYTD, 0);
    expect(netSum, "category netYTD must sum to headline netYTD").toBe(m.netYTD);
    // Dimension 4 — waitlist (depth + conversion + LRP target + aging).
    expect(m.waitlist.depth).toBeGreaterThanOrEqual(0);
    expect(m.waitlist.conversionPct).toMatch(/%/);
    expect(m.waitlist.targetDepth).toBeGreaterThan(0);
    expect(m.waitlist.aging.length).toBeGreaterThanOrEqual(3);
    // Dimension 5 — entrance fee yield (YTD + YoY + per new member + benchmark).
    expect(m.entranceFee.ytd).toMatch(/\$/);
    expect(m.entranceFee.varPctYoY).toMatch(/%/);
    expect(m.entranceFee.perNewMember).toMatch(/\$/);
    expect(m.entranceFee.benchmark.toLowerCase()).toMatch(/peer/);
    // Dimension 6 — tenure (avg + distribution summing to active total).
    expect(m.tenure.averageYears).toMatch(/yr/);
    const tenureSum = m.tenure.distribution.reduce((acc, row) => acc + row.count, 0);
    expect(tenureSum, "tenure distribution must sum to active membership").toBe(m.activeMembers);
  });

  it("legacy Membership Stewardship chapter no longer ships in the page", () => {
    // 2026-06-19 — the standalone Membership Stewardship chapter
    // was retired after its load-bearing surfaces (headline tiles +
    // Category Mix + Waitlist Depth & Aging + Tenure Distribution)
    // migrated into the Stewardship KPI Dashboard at chapter III.
    // The residual L4 lead + attrition trend did not justify a
    // standalone chapter, so chapter XVI was removed entirely.
    // The shared `pkg.membershipStewardship` and
    // `pkg.commentary.membershipStewardship` service fields stay
    // intact — they back the dashboard sub-blocks and the export
    // path; they are asserted separately in the service-shape +
    // commentary-shape tests below.
    expect(MONTHLY_PAGE).not.toMatch(/function MembershipStewardship\(/);
    expect(MONTHLY_PAGE).not.toMatch(/<section id="membership-stewardship"/);
    expect(MONTHLY_PAGE).not.toMatch(/data-testid="membership-stewardship-lead"/);
    expect(MONTHLY_PAGE).not.toMatch(/data-testid="membership-attrition-trend"/);
    expect(MONTHLY_PAGE).not.toMatch(/eyebrow="Section [A-Z]+ · Membership · Stewardship"/);
    // The "membership-stewardship" anchor must be gone from the
    // body too (any sticky-rail click would otherwise scroll into
    // dead air).
    expect(MONTHLY_PAGE).not.toMatch(/data-testid="membership-stewardship"/);
  });

  it("Stewardship Dashboard hosts the moved Membership sub-blocks (chapter III)", () => {
    // The lifted sub-blocks render inside StewardshipKpiDashboard.
    // Hero tiles use a new testid (stewardship-kpi-dashboard-membership-
    // headline) to make the new location explicit while the individual
    // tile testIds (membership-active / -attrition / -entrance-fee /
    // -tenure) stay stable so existing scrolls + e2e clicks survive.
    const skd = sliceFn("StewardshipKpiDashboard");
    expect(skd.length, "StewardshipKpiDashboard body must be findable").toBeGreaterThan(0);
    // Four hero tiles.
    expect(skd).toMatch(/data-testid="stewardship-kpi-dashboard-membership-headline"/);
    expect(skd).toMatch(/testId="membership-active"/);
    expect(skd).toMatch(/testId="membership-attrition"/);
    expect(skd).toMatch(/testId="membership-entrance-fee"/);
    expect(skd).toMatch(/testId="membership-tenure"/);
    // Three sub-blocks.
    expect(skd).toMatch(/<MembershipCategoryMix mix=\{m\.categoryMix\}/);
    expect(skd).toMatch(/<MembershipWaitlist waitlist=\{m\.waitlist\}/);
    expect(skd).toMatch(/<MembershipTenureDistribution[\s\S]{0,40}distribution=\{m\.tenure\.distribution\}/);
  });

  it("Stewardship Dashboard renders the 'Operating vs. Capital Stewardship' sub-header in the Tenure-Distribution style above the intro question", () => {
    // 2026-06-19 — a section-header rhythm fix. After the lifted
    // membership blocks, a sub-header restores the transition into
    // the original Operating + Capital content. Style is pinned to
    // match Tenure Distribution exactly: mt-10 wrapper, bordered
    // block with `border-b border-club-sand pb-2`, h3 in
    // `font-serif text-2xl tracking-tight text-club-green-900`.
    const skd = sliceFn("StewardshipKpiDashboard");
    expect(skd).toMatch(/data-testid="stewardship-kpi-dashboard-op-vs-cap-heading"/);
    // The heading testid block must use the same Tailwind tokens as
    // the Tenure Distribution header. Match the block from testid to
    // closing </div> after the h3.
    const headingBlock = skd.match(
      /data-testid="stewardship-kpi-dashboard-op-vs-cap-heading"[\s\S]+?<\/h3>/,
    );
    expect(headingBlock, "Op vs. Cap heading block must be findable").toBeTruthy();
    expect(headingBlock![0]).toMatch(/className="mt-10"/);
    expect(headingBlock![0]).toMatch(/border-b border-club-sand pb-2/);
    expect(headingBlock![0]).toMatch(/font-serif text-2xl tracking-tight text-club-green-900/);
    expect(headingBlock![0]).toMatch(/Operating vs\. Capital Stewardship/);
    // Sits immediately above the Red·Yellow·Green intro question.
    const headingIdx = skd.indexOf('data-testid="stewardship-kpi-dashboard-op-vs-cap-heading"');
    const introIdx = skd.indexOf('data-testid="stewardship-kpi-dashboard-intro"');
    const tenureIdx = skd.indexOf("<MembershipTenureDistribution");
    expect(tenureIdx).toBeGreaterThan(0);
    expect(headingIdx, "heading must follow Tenure Distribution").toBeGreaterThan(tenureIdx);
    expect(introIdx, "intro question must follow the new heading").toBeGreaterThan(headingIdx);
  });

  it("Stewardship Dashboard places the membership sub-blocks immediately after the header and preserves original content order below", () => {
    // 2026-06-19 (corrected) — the moved membership blocks sit
    // directly under the dashboard header (after the period meta
    // line) so the board sees them FIRST when chapter III opens.
    // Every pre-existing dashboard element renders below in the
    // ORIGINAL order: intro question (Red·Yellow·Green) → summary
    // KPI cards → paired grid → dashboard notes.
    //
    // Target order inside StewardshipKpiDashboard:
    //   1. period meta       (stewardship-kpi-dashboard-meta)
    //   2. membership tiles  (stewardship-kpi-dashboard-membership-headline)
    //   3. category mix      (MembershipCategoryMix)
    //   4. waitlist          (MembershipWaitlist)
    //   5. tenure dist.      (MembershipTenureDistribution)
    //   6. Op vs. Cap heading (stewardship-kpi-dashboard-op-vs-cap-heading)
    //   7. intro question    (stewardship-kpi-dashboard-intro — Red·Yellow·Green)
    //   8. summary KPI cards (stewardship-kpi-dashboard-summary)
    //   9. paired grid       (StewardshipKpiPairedGrid)
    //  10. dashboard notes   (stewardship-kpi-dashboard-notes)
    const skd = sliceFn("StewardshipKpiDashboard");
    const idx = (needle: string) => skd.indexOf(needle);
    const meta       = idx('data-testid="stewardship-kpi-dashboard-meta"');
    const memHead    = idx('data-testid="stewardship-kpi-dashboard-membership-headline"');
    const catMix     = idx("<MembershipCategoryMix");
    const waitlist   = idx("<MembershipWaitlist");
    const tenure     = idx("<MembershipTenureDistribution");
    const opVsCapHdg = idx('data-testid="stewardship-kpi-dashboard-op-vs-cap-heading"');
    const intro      = idx('data-testid="stewardship-kpi-dashboard-intro"');
    const summary    = idx('data-testid="stewardship-kpi-dashboard-summary"');
    const paired     = idx("<StewardshipKpiPairedGrid");
    const notes      = idx('data-testid="stewardship-kpi-dashboard-notes"');
    expect(meta,       "period meta line must render").toBeGreaterThan(0);
    expect(memHead,    "membership tiles must follow header").toBeGreaterThan(meta);
    expect(catMix,     "category mix must follow tiles").toBeGreaterThan(memHead);
    expect(waitlist,   "waitlist must follow category mix").toBeGreaterThan(catMix);
    expect(tenure,     "tenure distribution must follow waitlist").toBeGreaterThan(waitlist);
    expect(opVsCapHdg, "Operating vs. Capital Stewardship heading follows tenure dist.").toBeGreaterThan(tenure);
    expect(intro,      "intro question follows the new heading").toBeGreaterThan(opVsCapHdg);
    expect(summary,    "summary KPI cards retain their original position below intro").toBeGreaterThan(intro);
    expect(paired,     "paired grid retains its original position").toBeGreaterThan(summary);
    expect(notes,      "dashboard notes retain their original closing position").toBeGreaterThan(paired);
  });

  it("Membership Stewardship commentary block answers the four questions and names the pillar", async () => {
    const club = await bootstrapAPClub("Membership Stewardship Commentary");
    const pkg = await getMonthlyReportingPackage(club.id);
    const c = pkg.commentary.membershipStewardship;
    expect(c).toBeDefined();
    expect(c.dataSource).toBe("demo");
    expect(c.consideration).toBe("monitor");
    // Four-question content present.
    expect(c.whatHappened.length).toBeGreaterThan(40);
    expect(c.whatItMeans.length).toBeGreaterThan(40);
    expect(c.whatNeedsAttention.length).toBeGreaterThan(20);
    expect(c.boardDecision).toBeTruthy();
    // Names the pillar served (Pillar 4) — required by the framework.
    expect(c.whatItMeans).toMatch(/Pillar 4 Membership Stewardship/);
    // References at least one of the five named metrics the user asked for.
    expect(c.whatHappened).toMatch(/waitlist/i);
    expect(c.whatHappened).toMatch(/attrition/i);
    expect(c.whatHappened).toMatch(/entrance.fee/i);
  });

  // -----------------------------------------------------------------
  // Chapter XII — Experience Stewardship (Pillar 5)
  // -----------------------------------------------------------------
  it("Experience Stewardship service shape carries the two editorial readings", async () => {
    const club = await bootstrapAPClub("Experience Stewardship Shape");
    const pkg = await getMonthlyReportingPackage(club.id);
    const e = pkg.experienceStewardship;
    expect(e, "experienceStewardship section must exist").toBeDefined();
    expect(e.dataSource).toBe("demo");
    // Two editorial paragraphs — each substantial (3+ sentences worth
    // of prose, not chip captions).
    expect(e.golfReading.length).toBeGreaterThan(200);
    expect(e.hospitalityReading.length).toBeGreaterThan(200);
    // Golf reading must cite the activity-side metrics the user named.
    expect(e.golfReading).toMatch(/rounds/i);
    expect(e.golfReading).toMatch(/utilization/i);
    expect(e.golfReading).toMatch(/Pillar 5/);
    // Hospitality reading must cite the hospitality-side metrics.
    expect(e.hospitalityReading).toMatch(/covers/i);
    expect(e.hospitalityReading).toMatch(/subsidy/i);
    expect(e.hospitalityReading).toMatch(/spend.per.(member|round)/i);
    expect(e.hospitalityReading).toMatch(/Pillar 1|Pillar 5/);
  });

  it("legacy Experience Stewardship chapter no longer ships in the page", () => {
    // 2026-06-19 — the standalone Experience Stewardship chapter
    // was retired. Rounds YTD / Course Utilization / Spend per
    // Member / Spend per Round were lifted into the Weather &
    // Utilization chapter earlier the same day; F&B covers + F&B
    // subsidy already live in the F&B Statistics chapter and the
    // Stewardship KPI Dashboard. The shared `pkg.experienceStewardship`
    // and `pkg.commentary.experienceStewardship` service fields stay
    // intact — they back the 5-pillar Board Briefing rollup (which
    // consumes `commentary.experienceStewardship.boardHeadline`) and
    // the export path. Both fields are asserted separately in the
    // service-shape + commentary-shape tests in this file.
    expect(MONTHLY_PAGE).not.toMatch(/function ExperienceStewardship\(/);
    expect(MONTHLY_PAGE).not.toMatch(/function ExperienceReading\(/);
    expect(MONTHLY_PAGE).not.toMatch(/<section id="experience-stewardship"/);
    expect(MONTHLY_PAGE).not.toMatch(/data-testid="experience-stewardship"/);
    expect(MONTHLY_PAGE).not.toMatch(/data-testid="experience-stewardship-lead"/);
    expect(MONTHLY_PAGE).not.toMatch(/data-testid="experience-readings"/);
    expect(MONTHLY_PAGE).not.toMatch(/data-testid="experience-metrics"/);
    expect(MONTHLY_PAGE).not.toMatch(/data-testid="experience-headline"/);
    expect(MONTHLY_PAGE).not.toMatch(/data-testid="experience-utilization-trend"/);
    expect(MONTHLY_PAGE).not.toMatch(/data-testid="experience-subsidy-trend"/);
    expect(MONTHLY_PAGE).not.toMatch(/testId="experience-covers"/);
    expect(MONTHLY_PAGE).not.toMatch(/testId="experience-fb-subsidy"/);
    expect(MONTHLY_PAGE).not.toMatch(/eyebrow="Section [A-Z]+ · Experience · Stewardship"/);
  });

  // -----------------------------------------------------------------
  // Saguaro-comparison polish: editorial serif + pillar pill chip
  // -----------------------------------------------------------------
  it("editorial serif (Source Serif 4) is loaded at the root and scoped to the report theme", () => {
    // next/font wiring at the root layout.
    const layoutPath = path.resolve(__dirname, "..", "src/app/layout.tsx");
    const layout = fs.readFileSync(layoutPath, "utf-8");
    expect(layout).toMatch(/Source_Serif_4/);
    expect(layout).toMatch(/variable:\s*"--font-source-serif-4"/);
    // The variable must be wired onto <html> so the font is loaded
    // globally (no FOUT on report navigation).
    expect(layout).toMatch(/<html[^>]*className=\{sourceSerif\.variable\}/);
    // globals.css resolves font-serif to the editorial serif ONLY
    // inside [data-report-theme="executive"], so the 69 non-reporting
    // surfaces keep their Georgia fallback.
    const cssPath = path.resolve(__dirname, "..", "src/app/globals.css");
    const css = fs.readFileSync(cssPath, "utf-8");
    expect(css).toMatch(/\[data-report-theme="executive"\] \.font-serif/);
    expect(css).toMatch(/var\(--font-source-serif-4\)/);
  });

  it("PillarChip atom renders the print-TOC pill with the cream + gold-700 paper-on-paper treatment", () => {
    const body = sliceFn("PillarChip");
    expect(body.length, "PillarChip body must be sliced").toBeGreaterThan(0);
    // Paper-on-paper background + gold-700 ring + gold-700 text (the
    // AA-compliant token, not the DEFAULT step that fails on cream).
    expect(body).toMatch(/bg-club-cream/);
    expect(body).toMatch(/text-club-gold-700/);
    expect(body).toMatch(/ring-club-gold-700/);
    // Smallcaps + wide tracking — print-TOC convention.
    expect(body).toMatch(/uppercase/);
    expect(body).toMatch(/tracking-\[0\.18em\]/);
    // Testid + data attribute for DOM-walkers.
    expect(body).toMatch(/data-testid="pillar-chip"/);
    expect(body).toMatch(/data-pillar-label=\{label\}/);
  });

  it("SectionHeading accepts a pillarLabel and stacks it above any data-source rightChip", () => {
    const body = sliceFn("SectionHeading");
    expect(body.length, "SectionHeading body must be sliced").toBeGreaterThan(0);
    // The pillarLabel prop is part of the public surface.
    expect(body).toMatch(/pillarLabel\?:\s*string/);
    // When pillarLabel is set, PillarChip renders.
    expect(body).toMatch(/<PillarChip label=\{pillarLabel\}/);
    // Stack container — pillar chip above, rightChip below.
    expect(body).toMatch(/flex flex-col items-end/);
  });

  it("no pillar-chipped SectionHeading calls remain in the page (legacy chapters retired 2026-06-19)", () => {
    // Map: each chapter's SectionHeading call used to include a
    // pillarLabel prop with its framework citation. AR Collections
    // was removed in the 2026-06-16 chapter consolidation. Legacy
    // Payroll, F&B / Hospitality, Membership Stewardship, Experience
    // Stewardship, and Operations & Analytics SectionHeading entries
    // were retired 2026-06-19 (Payroll + F&B were duplicates of the
    // canonical Saguaro-style chapters; both Stewardship pillar
    // memos AND the Operations & Analytics catch-all chapter were
    // retired after their load-bearing surfaces dispersed into the
    // Stewardship KPI Dashboard, the Weather chapter, and the F&B
    // Statistics chapter). The rail now holds 14 chapters and no
    // page-level SectionHeading instance carries a pillarLabel.
    expect(
      MONTHLY_PAGE,
      "no SectionHeading instance should declare a pillarLabel after the 2026-06-19 chapter retirements",
    ).not.toMatch(/<SectionHeading[\s\S]{0,400}pillarLabel=/);
  });

  it("multi-pillar chapters do NOT carry a pillar pill chip (Stewardship KPI Dashboard)", () => {
    // The chapter-III Stewardship KPI Dashboard renders Operating +
    // Capital + Balance Sheet pillars under one chapter; assigning a
    // single chip would mis-attribute. The chapter-III SectionHeading
    // uses the Saguaro-style eyebrow "Silver Springs Golf & Country
    // Club · KPI Dashboard" rather than a "Section X · …" numeral,
    // but the no-pillar-chip invariant is the same.
    //
    // (The legacy multi-pillar Financial Statements composite chapter
    // was removed in the 2026-06-16 chapter consolidation, so it is
    // no longer asserted here.)
    const stewardship = MONTHLY_PAGE.match(
      /eyebrow="Silver Springs Golf & Country Club · KPI Dashboard"[\s\S]{0,400}/,
    );
    expect(stewardship, "Stewardship KPI Dashboard SectionHeading must exist").toBeTruthy();
    expect(stewardship![0], "Stewardship KPI Dashboard must not carry a pillar chip").not.toMatch(/pillarLabel=/);
  });

  it("Experience Stewardship commentary block answers the four questions and names Pillar 5", async () => {
    const club = await bootstrapAPClub("Experience Stewardship Commentary");
    const pkg = await getMonthlyReportingPackage(club.id);
    const c = pkg.commentary.experienceStewardship;
    expect(c).toBeDefined();
    expect(c.dataSource).toBe("demo");
    expect(c.consideration).toBe("monitor");
    expect(c.whatHappened.length).toBeGreaterThan(40);
    expect(c.whatItMeans.length).toBeGreaterThan(40);
    expect(c.whatNeedsAttention.length).toBeGreaterThan(20);
    expect(c.boardDecision).toBeTruthy();
    // Names Pillar 5 (and references the Pillar 1 subsidy crossover).
    expect(c.whatItMeans).toMatch(/Pillar 5 Experience Stewardship/);
    expect(c.whatItMeans).toMatch(/Pillar 1 Operating Stewardship/);
    // References the six named metrics.
    const all = `${c.whatHappened} ${c.whatItMeans}`.toLowerCase();
    expect(all).toMatch(/rounds/);
    expect(all).toMatch(/utilization/);
    expect(all).toMatch(/covers/);
    expect(all).toMatch(/spend.per.(member|round)/);
    expect(all).toMatch(/subsidy/);
  });

  // -----------------------------------------------------------------
  // Chapter II — Chair's Dashboard
  // -----------------------------------------------------------------
  it("Equity Value Over Time card has NO hardcoded equity arrays — page + monthly-package both consume the accounting-fed service", () => {
    // Reporting-integrity guard. The Equity Value Over Time stewardship
    // chart MUST consume `getEquityHistory()` from the accounting-fed
    // service in src/lib/reporting/equity-history.ts. It MUST NOT inline
    // a series in either page.tsx or monthly-package.ts.

    // 1. page.tsx — the React component must contain none of the
    //    seeded series values, no fiscal-year label literal, and none
    //    of the displayed KPI strings as inline text. The card
    //    receives `data` as a prop.
    //    Both the prior values (kept here as a regression backstop)
    //    and the new Saguaro-aligned values are listed; the React
    //    component must contain neither.
    expect(MONTHLY_PAGE).not.toMatch(/value:\s*21\.40/);  // prior FY19 base
    expect(MONTHLY_PAGE).not.toMatch(/value:\s*22\.68/);  // prior FY20 best-in-class
    expect(MONTHLY_PAGE).not.toMatch(/value:\s*18\.83/);  // new   FY19 base
    expect(MONTHLY_PAGE).not.toMatch(/value:\s*31\.00/);  // new   FY26 endpoint
    expect(MONTHLY_PAGE).not.toMatch(/label:\s*"FY19"/);
    expect(MONTHLY_PAGE).not.toMatch(/label:\s*"2018"/);
    // KPI display strings must not appear as React-tree literals.
    expect(MONTHLY_PAGE).not.toMatch(/"7\.4%"/);
    expect(MONTHLY_PAGE).not.toMatch(/"\$31\.0M"/);
    expect(MONTHLY_PAGE).not.toMatch(/"5\.5%"/);
    expect(MONTHLY_PAGE).not.toMatch(/"3\.5%"/);

    // Y-axis domain and tick count must come from the data shape
    // (data.yAxisMin / data.yAxisMax / data.yAxisTicks), NOT from
    // hardcoded literals like `yDomain={[19, 35]}` or `yTicks={4}`.
    expect(MONTHLY_PAGE).not.toMatch(/yDomain=\{\[\d+,\s*\d+\]\}/);
    expect(MONTHLY_PAGE).not.toMatch(/yTicks=\{\d+\}/);
    expect(MONTHLY_PAGE).toMatch(/yDomain=\{\[data\.yAxisMin,\s*data\.yAxisMax\]\}/);
    expect(MONTHLY_PAGE).toMatch(/yTicks=\{data\.yAxisTicks\}/);

    // 2. monthly-package.ts must call the service and NOT carry the
    //    historical equity points as inline literals.
    expect(MONTHLY_PACKAGE).toMatch(/import\s*\{[^}]*getEquityHistory[^}]*\}\s*from\s*["'@\/]+lib\/reporting\/equity-history["']/);
    expect(MONTHLY_PACKAGE).toMatch(/await getEquityHistory\(/);
    // No inline historical equity values in monthly-package.ts.
    expect(MONTHLY_PACKAGE).not.toMatch(/value:\s*21\.40/);
    expect(MONTHLY_PACKAGE).not.toMatch(/value:\s*22\.68/);
    expect(MONTHLY_PACKAGE).not.toMatch(/value:\s*26\.31/);
    expect(MONTHLY_PACKAGE).not.toMatch(/value:\s*18\.83/);
    expect(MONTHLY_PACKAGE).not.toMatch(/value:\s*31\.00/);
  });

  // ---------------------------------------------------------------
  // LOCKED BASELINE — Equity Value Over Time card
  //
  // Authority: docs/equity-value-over-time-card-spec.md (signed off
  // 2026-06-13). The 13 rules in that spec are catalysed below into
  // source-contract assertions. Any future change that breaks one of
  // these guards is asking — implicitly — to re-litigate a founder-
  // approved baseline. Reopening the spec doc is a prerequisite for
  // green-lighting an edit here.
  // ---------------------------------------------------------------
  describe("Equity Value Over Time card — LOCKED baseline regression guards", () => {
    const CHART = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/reporting/EditorialLineChart.tsx"),
      "utf8",
    );
    const PAGE = MONTHLY_PAGE;
    const COMMENTARY = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/reporting/equity-commentary.ts"),
      "utf8",
    );
    const HISTORY = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/reporting/equity-history.ts"),
      "utf8",
    );

    // Slice the EquityValueCard and OperatingResultsCard function
    // bodies. Each function contains a single <StewardshipCard /> JSX
    // block with all its props. We can't naively scan for `/>` after
    // the testid because <StewardshipKpi /> children also self-close
    // with `/>`; bounding by the next top-level `function` keyword is
    // robust and simple.
    function sliceFunction(name: string): string {
      const start = PAGE.indexOf(`function ${name}(`);
      if (start < 0) return "";
      const next = PAGE.indexOf("\nfunction ", start + 1);
      return PAGE.slice(start, next > 0 ? next : start + 6000);
    }
    const equityCardBlock = sliceFunction("EquityValueCard");
    const operatingCardBlock = sliceFunction("OperatingResultsCard");

    it("Rule 6: SVG must render at uniform scale — preserveAspectRatio='none' is forbidden anywhere in the chart", () => {
      // The cream-gutter bug at viewports ≥ 1600 px was caused by a
      // fixed viewBox + meet. The fix was a dynamic viewBox width via
      // ResizeObserver — NOT preserveAspectRatio="none" (which would
      // stretch text and markers non-uniformly).
      //
      // Strip `// …` line comments first so the chart's own
      // documentation comment that NAMES the forbidden pattern does
      // not false-trigger the guard.
      const CHART_NO_LINE_COMMENTS = CHART.replace(/\/\/[^\n]*/g, "");
      expect(CHART_NO_LINE_COMMENTS).not.toMatch(/preserveAspectRatio\s*=\s*["']none["']/);
      // The ResizeObserver hook must stay wired — that's the actual
      // responsive solution.
      expect(CHART).toMatch(/new ResizeObserver/);
      expect(CHART).toMatch(/setContainerWidth/);
    });

    it("Rule 6: data markers are <circle>, never <ellipse> (no ovals)", () => {
      // <ellipse rx ry> would render an oval. All markers must be
      // <circle r=...>.
      expect(CHART).not.toMatch(/<ellipse[\s>]/);
      expect(CHART).toMatch(/<circle\b/);
    });

    it("Rule 6: geometricPrecision rendering hints remain set", () => {
      expect(CHART).toMatch(/shapeRendering:\s*["']geometricPrecision["']/);
      expect(CHART).toMatch(/textRendering:\s*["']geometricPrecision["']/);
    });

    it("Rule 7 + Rule 8: EquityValueCard pins padLeft=44 and padRight=14", () => {
      // The two locked geometry numbers. Y-label column → Actual CAGR
      // tile LEFT (padLeft=44), and rightmost marker → Current Equity
      // tile RIGHT (padRight=14). Anything else breaks the alignment
      // invariants.
      expect(equityCardBlock, "EquityValueCard JSX block must be locatable").not.toBe("");
      expect(equityCardBlock).toMatch(/padLeft=\{44\}/);
      expect(equityCardBlock).toMatch(/padRight=\{14\}/);
    });

    it("Rule 8 + Rule 11: EquityValueCard uses layout='chart-dominant' and insetCommentary", () => {
      // chart-dominant = 60/245/100 band heights; insetCommentary =
      // green wash sits in a px-3.5 gutter and the inner <p> hugs the
      // text (NO h-full).
      expect(equityCardBlock).toMatch(/layout=["']chart-dominant["']/);
      expect(equityCardBlock).toMatch(/insetCommentary/);
    });

    it("Rule 9: legend entries use line-preview shape (stroke + strokeWidth + showMarker), NOT filled swatches", () => {
      // The chart's LegendEntry type must carry stroke / strokeWidth /
      // showMarker fields (line preview). If someone reverts to the
      // old { swatch, hollow } shape, this guard fires.
      expect(CHART).toMatch(/strokeWidth:\s*number/);
      expect(CHART).toMatch(/showMarker\?:\s*boolean/);
      // The Equity card's legend prop passes the line-preview shape.
      const legendBlock = equityCardBlock.match(/legend=\{\[[\s\S]+?\]\}/);
      expect(legendBlock, "Equity card legend prop must be locatable").toBeTruthy();
      const body = legendBlock![0];
      expect(body).toMatch(/stroke:\s*["']stroke-club-green-500["']/);
      expect(body).toMatch(/stroke:\s*["']stroke-club-gold["']/);
      expect(body).toMatch(/dasharray:\s*["']6 4["']/);   // best-in-class long dash
      expect(body).toMatch(/dasharray:\s*["']3 4["']/);   // min-required short dash
      expect(body).toMatch(/showMarker:\s*true/);          // Club Equity carries the marker
      // The legacy `swatch` field must NOT reappear on the Equity card's
      // legend entries.
      expect(body).not.toMatch(/swatch:/);
    });

    it("Rule 10: commentary is generated, not hardcoded — page consumes data.interpretation; generator owns the sentences", () => {
      expect(equityCardBlock).toMatch(/interpretation=\{data\.interpretation\}/);
      // page.tsx must NOT contain a hardcoded equity sentence template.
      expect(PAGE).not.toMatch(/Compounded annual equity growth of \*\*\d/);
      // The generator owns the templates.
      expect(COMMENTARY).toMatch(/Compounded annual equity growth of/);
    });

    it("Rule 10: commentary generator must never reference 'pillar' in any EMITTED prose (template literals)", () => {
      // The Saguaro register: a CFO's voice, not internal product
      // taxonomy. Scope the check to the actual returned strings
      // (template literals + double-quoted string literals) so a
      // documentation comment that says "no pillar references" does
      // not false-trigger this guard.
      const templates = COMMENTARY.match(/`[^`]+`/g) ?? [];
      for (const t of templates) {
        expect(t.toLowerCase(), `commentary template literal must not contain "pillar":\n${t}`).not.toContain("pillar");
      }
      // Plus all double-quoted string LITERALS — case labels are
      // double-quoted, returned from the classifier; check them too.
      const dquoted = COMMENTARY.match(/"[^"]+"/g) ?? [];
      for (const s of dquoted) {
        expect(s.toLowerCase(), `commentary double-quoted string must not contain "pillar":\n${s}`).not.toContain("pillar");
      }
    });

    it("Rule 3: x-axis uses calendar-year format (NOT 'FY' prefix anywhere in the equity surface)", () => {
      // formatEquityDashboard sets firstYear via fyShort, which strips
      // the "FY" prefix. If anyone re-inlines "FY${year}" anywhere in
      // page.tsx, the generator, or the history service, this fires.
      expect(equityCardBlock).not.toMatch(/"FY\d/);
      expect(COMMENTARY).not.toMatch(/FY\$\{|"FY\d/);
      // The history service emits labels like "FY2025" internally, but
      // monthly-package.ts MUST convert via fyShort before they hit
      // the React tree.
      expect(MONTHLY_PACKAGE).toMatch(/fyShort/);
    });

    it("Rule 3: getEquityHistory filters to COMPLETED fiscal years only (endDate < asOf)", () => {
      // The "in-progress year shouldn't appear" guarantee. If this
      // filter regresses to startDate ≤ asOf, the open FY2026 marker
      // would re-appear in May-reporting data.
      expect(HISTORY).toMatch(/endDate:\s*\{\s*lt:\s*asOf\s*\}/);
      expect(HISTORY).toMatch(/orderBy:\s*\{\s*endDate:\s*["']desc["']\s*\}/);
    });

    it("Rule 12: subtitle styling is bumped (font 10.5, opacity /70, letter-spacing 0.7) — NOT the prior squinty defaults", () => {
      // Locate the StewardshipCard header subtitle <p>. The bumped
      // values must appear; the previous values (9px / /45 / 1.1px)
      // must NOT.
      const subtitleRegion = PAGE.match(
        /\{subtitle\}[\s\S]*?<\/p>|className="mt-1 uppercase text-club-cream\/\d+"[\s\S]*?\{subtitle\}/,
      );
      // Whatever the exact match-region, search the page broadly for
      // the locked literals; they all live in the same JSX block.
      expect(PAGE).toMatch(/text-club-cream\/70/);
      expect(PAGE).toMatch(/fontSize:\s*["']10\.5px["']/);
      expect(PAGE).toMatch(/letterSpacing:\s*["']0\.7px["']/);
      // Prior squinty defaults must NOT reappear on this subtitle.
      expect(PAGE).not.toMatch(/text-club-cream\/45[\s\S]*?\{subtitle\}/);
      // (font-size 9px is used elsewhere — by KPI labels — so we don't
      // forbid the literal "9px" globally; instead we lock the new
      // 10.5px above and rely on the subtitleStyle assertion in the
      // Playwright spec.)
    });

    it("Rule 11: inset commentary structure exists in StewardshipCard (px-3.5 wrapper + borderLeft accent)", () => {
      // The inset variant of the commentary band. If the px-3.5
      // wrapper or the borderLeft accent goes away, the regression
      // measurement test will also fail, but this catches it earlier
      // at source-contract time.
      expect(PAGE).toMatch(/insetCommentary\?:\s*boolean/);
      // px-3.5 wrapper visible in the JSX.
      expect(PAGE).toMatch(/<div\s+className=["']px-3\.5["'][\s\S]*?\$\{testid\}-commentary/);
      // borderLeft accent is wired.
      expect(PAGE).toMatch(/borderLeft:\s*["']3px solid rgba\(63,\s*112,\s*66,\s*0\.55\)["']/);
      // The inner <p> MUST NOT have h-full (otherwise the shading
      // fills the entire band again).
      const insetP = PAGE.match(
        /insetCommentary\s*\?\s*\([\s\S]*?<p[^>]*?data-testid=\{`\$\{testid\}-commentary`\}[\s\S]*?<\/p>/,
      );
      expect(insetP, "inset commentary <p> must be locatable").toBeTruthy();
      expect(insetP![0]).not.toMatch(/className=["'][^"']*\bh-full\b/);
    });

    it("Locked geometry: StewardshipCard chart-dominant dims are 60 / 245 / 100", () => {
      // The four locked numbers — kpiHeight, chartHeight, commentary
      // -Height. If anyone re-tunes these (e.g. shrinks the chart),
      // the commentary will overflow again or the chart-dominant
      // hierarchy collapses.
      const chartDominantBlock = PAGE.match(
        /layout === "chart-dominant"\s*\?\s*\{[\s\S]*?\}\s*:\s*\{/,
      );
      expect(chartDominantBlock, "chart-dominant dims block must be locatable").toBeTruthy();
      const body = chartDominantBlock![0];
      expect(body).toMatch(/kpiHeight:\s*60/);
      expect(body).toMatch(/chartHeight:\s*245/);
      expect(body).toMatch(/commentaryHeight:\s*100/);
    });

    it("Locked geometry: Equity card passes height={245} to keep SVG in sync with the chart-dominant band", () => {
      // If chartHeight is 245 in StewardshipCard but the SVG height is
      // 260, the chart overflows the band. The two must move together.
      expect(equityCardBlock).toMatch(/height=\{245\}/);
    });

    it("Operating Results card remains a stewardship sibling (still rendered by StewardshipDashboard, still under testid='stewardship-operating')", () => {
      // The founder constraint that anchored this guard at the
      // equity-lock moment was: do not collateral-damage Operating
      // Results when working on Equity. Originally the test forbade
      // chart-dominant / insetCommentary / padLeft / padRight on the
      // Operating card on the assumption those were equity-only.
      //
      // The Operating Results parity rebuild (2026-06-13+) brought
      // the same disciplined visual contract to Operating, so those
      // specific forbids became wrong. The spirit of the guard
      // remains — "do not accidentally remove or break the operating
      // card while editing equity" — re-anchored on its identity
      // anchors: it still exists, still has its testid, and is still
      // rendered next to the equity card by StewardshipDashboard.
      // The intentional parity assertions live in the Operating
      // Results describe block below.
      expect(operatingCardBlock, "OperatingResultsCard function must still exist").not.toBe("");
      expect(operatingCardBlock).toMatch(/testid=["']stewardship-operating["']/);
      expect(operatingCardBlock).toMatch(/<StewardshipCard/);
      expect(MONTHLY_PAGE).toMatch(/<OperatingResultsCard\s+data=/);
      expect(MONTHLY_PAGE).toMatch(/<StewardshipDashboard\s+data=/);
    });

    it("Default chart geometry (used by future consumers) preserves the original 66 / 31 padding contract", () => {
      // padLeft defaults to 66, padRight defaults to 31 — preserved so
      // any new line-chart consumer gets Saguaro-tier paddings unless
      // it explicitly opts in to alignment-with-adjacent-column.
      expect(CHART).toMatch(/padLeft \?\?\s*66/);
      expect(CHART).toMatch(/padRight \?\?\s*31/);
    });
  });

  // ---------------------------------------------------------------
  // Operating Results card — discipline parity with the locked
  // Equity baseline. The guards below mirror the equity-card-spec.md
  // rules and catch the specific regressions the founder named:
  //   - KPI values hardcoded in React
  //   - Chart series hardcoded in React
  //   - Hardcoded "$245K" / "$0" / "($193K)" strings
  //   - preserveAspectRatio="none" reintroduced
  //   - Filled-rectangle legend with no chart-glyph parity
  //   - Operating commentary referencing pillars or SaaS vocab
  //   - Operating Results changes that collateral-damage the locked
  //     Equity card
  // ---------------------------------------------------------------
  describe("Operating Results card — discipline parity with the locked Equity baseline", () => {
    const BAR_CHART = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/reporting/EditorialBarChart.tsx"),
      "utf8",
    );
    const OP_SERVICE = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/reporting/operating-results.ts"),
      "utf8",
    );
    const OP_COMMENTARY = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/reporting/operating-commentary.ts"),
      "utf8",
    );
    const SERVICE = MONTHLY_PACKAGE;
    const PAGE = MONTHLY_PAGE;
    function sliceFunction(name: string): string {
      const start = PAGE.indexOf(`function ${name}(`);
      if (start < 0) return "";
      const next = PAGE.indexOf("\nfunction ", start + 1);
      return PAGE.slice(start, next > 0 ? next : start + 6000);
    }
    const operatingCardBlock = sliceFunction("OperatingResultsCard");
    const equityCardBlock = sliceFunction("EquityValueCard");

    it("KPI values are NOT hardcoded in React — page consumes data.ytdNoiLabel / etc.", () => {
      expect(operatingCardBlock).toMatch(/value=\{data\.ytdNoiLabel\}/);
      expect(operatingCardBlock).toMatch(/value=\{data\.noiPctRevenueLabel\}/);
      expect(operatingCardBlock).toMatch(/value=\{data\.budgetGoalLabel\}/);
      expect(operatingCardBlock).toMatch(/value=\{data\.priorYearLabel\}/);
      // The literal demo values that were inline before this refactor
      // must NOT reappear in the React tree.
      expect(operatingCardBlock).not.toMatch(/"\$245K"/);
      expect(operatingCardBlock).not.toMatch(/"\(\$193K\)"/);
      expect(operatingCardBlock).not.toMatch(/"1\.7%"/);
    });

    it("chart series are NOT hardcoded in React — page consumes data.series / .budget / .priorYearYtd", () => {
      // Three chart series: primary monthly bars, secondary budget
      // bars, cumulative prior-year YTD overlay. ALL must come from
      // the service-emitted data shape (no inline arrays).
      expect(operatingCardBlock).toMatch(/values:\s*data\.series\.map/);
      expect(operatingCardBlock).toMatch(/values:\s*data\.budget\.map/);
      // Overlay line consumes the CUMULATIVE prior-year series (the
      // monthly priorYear field is preserved on the data shape but
      // no longer plotted as the overlay line — see the dedicated
      // reconciliation test below).
      expect(operatingCardBlock).toMatch(/values:\s*data\.priorYearYtd\.map/);
      // No inline { label: "Jan", value: -45 } arrays anywhere on the
      // page.
      expect(PAGE).not.toMatch(/label:\s*"Jan",\s*value:\s*-45/);
      expect(PAGE).not.toMatch(/label:\s*"Dec",\s*value:\s*47/);
      // monthly-package.ts must not carry the literals either.
      expect(SERVICE).not.toMatch(/label:\s*"Jan",\s*value:\s*-45/);
      expect(SERVICE).not.toMatch(/label:\s*"Dec",\s*value:\s*47/);
    });

    it("monthly-package.ts wires the accounting-fed service for Operating Results", () => {
      // The service must be imported and called, parallel to the
      // equity wiring.
      expect(SERVICE).toMatch(/import\s*\{[^}]*getOperatingResults[^}]*\}\s*from\s*["'@\/]+lib\/reporting\/operating-results["']/);
      expect(SERVICE).toMatch(/import\s*\{[^}]*buildOperatingCommentary[^}]*\}\s*from\s*["'@\/]+lib\/reporting\/operating-commentary["']/);
      expect(SERVICE).toMatch(/await\s+getOperatingResults\(/);
      expect(SERVICE).toMatch(/formatOperatingDashboard\(/);
    });

    it("accounting-fed service reads FiscalPeriod columns (closingNoi / closingRevenue / budgetNoi)", () => {
      // Proof the service is wired to the GL — not just renaming
      // demo arrays.
      expect(OP_SERVICE).toMatch(/prisma\.fiscalPeriod\.findMany/);
      expect(OP_SERVICE).toMatch(/closingNoi/);
      expect(OP_SERVICE).toMatch(/closingRevenue/);
      expect(OP_SERVICE).toMatch(/budgetNoi/);
      // Tenant scope: every query must be club-scoped.
      expect(OP_SERVICE).toMatch(/where:\s*\{\s*clubId/);
    });

    it("NOI % is CALCULATED from revenue + NOI, not hardcoded", () => {
      // The formatter must compute %-of-revenue from the two
      // numeric inputs, NOT pass a literal "1.7%" through.
      expect(SERVICE).toMatch(/\(n\s*\/\s*rev\)\s*\*\s*100/);
      expect(SERVICE).not.toMatch(/noiPctRevenueLabel:\s*["']1\.7%["']/);
      expect(SERVICE).not.toMatch(/noiPctRevenueLabel:\s*["']2\.3%["']/);
    });

    it("Rule 6: bar chart SVG renders at uniform scale — preserveAspectRatio='none' is forbidden", () => {
      // The historical bug. Strip line comments first so the chart's
      // own documentation comment that NAMES the forbidden pattern
      // does not false-trigger the guard.
      const BAR_NO_COMMENTS = BAR_CHART.replace(/\/\/[^\n]*/g, "");
      expect(BAR_NO_COMMENTS).not.toMatch(/preserveAspectRatio\s*=\s*["']none["']/);
      // ResizeObserver wired — the responsive solution.
      expect(BAR_CHART).toMatch(/new ResizeObserver/);
      expect(BAR_CHART).toMatch(/setContainerWidth/);
      // geometricPrecision rendering hints.
      expect(BAR_CHART).toMatch(/shapeRendering:\s*["']geometricPrecision["']/);
      expect(BAR_CHART).toMatch(/textRendering:\s*["']geometricPrecision["']/);
    });

    it("Operating card uses chart-dominant layout + insetCommentary (parity with Equity)", () => {
      expect(operatingCardBlock).toMatch(/layout=["']chart-dominant["']/);
      expect(operatingCardBlock).toMatch(/insetCommentary/);
    });

    it("Operating card pins padLeft + padRight on the bar chart for KPI-edge alignment", () => {
      // Same alignment discipline as the equity card — y-axis label
      // column → YTD NOI tile LEFT, rightmost bar → Prior Year tile
      // RIGHT.
      expect(operatingCardBlock).toMatch(/padLeft=\{44\}/);
      expect(operatingCardBlock).toMatch(/padRight=\{14\}/);
    });

    it("Operating chart's overlay LINE consumes data.priorYearYtd CUMULATIVE — not data.priorYear monthly — so it reconciles to the Prior Year KPI tile at the right edge", () => {
      // The chart's overlay prop must read priorYearYtd (cumulative
      // running sum). The monthly priorYear field stays on the data
      // shape but is no longer plotted as the line.
      expect(operatingCardBlock).toMatch(/overlay=\{\s*\{[\s\S]*?values:\s*data\.priorYearYtd\.map/);
      // Negative guard: the chart must not regress to plotting
      // data.priorYear monthly values as the overlay line.
      expect(operatingCardBlock).not.toMatch(/overlay=\{\s*\{[\s\S]*?values:\s*data\.priorYear\.map/);
      // Y-axis domain must include priorYearYtd (the cumulative
      // series) so the y-axis naturally extends to the KPI depth.
      expect(operatingCardBlock).toMatch(/data\.priorYearYtd\.map/);
      // Hardcoded y-bounds must NOT reappear (the prior regression
      // was a fixed `[-110, 110]` domain that ignored the data).
      expect(operatingCardBlock).not.toMatch(/yDomain=\{\[\s*-?\d+\s*,\s*-?\d+\s*\]\}/);
      // Y-domain must come from data, via the computed yLo / yHi.
      expect(operatingCardBlock).toMatch(/yDomain=\{\[yLo,\s*yHi\]\}/);
    });

    it("Operating card uses chart-glyph legend (bars + line sample), NOT generic filled boxes", () => {
      // BarLegendEntry has a `shape` discriminator with three values:
      // "bar" (single-tone), "split-bar" (diverging — diagonally
      // split preview), and "line" (overlay). The Operating card's
      // Actual series is diverging (positive AND negative NOI),
      // so its legend entry MUST use shape="split-bar" with the
      // chart's positive + negative fills mirrored. Budget stays as
      // a single-tone "bar"; Prior Year YTD remains a stroked "line".
      expect(BAR_CHART).toMatch(/shape:\s*["']bar["']\s*\|\s*["']split-bar["']\s*\|\s*["']line["']/);
      const legendBlock = operatingCardBlock.match(/legend=\{\[[\s\S]+?\]\}/);
      expect(legendBlock, "legend prop block must be locatable").toBeTruthy();
      const body = legendBlock![0];
      // Actual — diagonally split square previewing both tones.
      // Fills mirror the chart's `primary.positiveFill` /
      // `primary.negativeFill` so the legend never invents a colour.
      expect(body).toMatch(/label:\s*["']Actual["'][\s\S]*?shape:\s*["']split-bar["']/);
      expect(body).toMatch(/positiveSwatch:\s*["']fill-club-green-500["']/);
      expect(body).toMatch(/negativeSwatch:\s*["']fill-\[#8b3520\]["']/);
      // Budget — unchanged: single-tone gold rectangle.
      expect(body).toMatch(/label:\s*["']Budget["'][\s\S]*?shape:\s*["']bar["'][\s\S]*?swatch:\s*["']fill-club-gold["']/);
      // Prior Year YTD — unchanged: stroked dashed line preview.
      expect(body).toMatch(/shape:\s*["']line["'][\s\S]*?stroke:\s*["']stroke-club-green-800["']/);
      expect(body).toMatch(/dasharray:\s*["']2 4["']/);
    });

    it("EditorialBarChart ships a 'split-bar' legend shape that renders both positive and negative fills", () => {
      // The split-bar render must:
      //   - emit two <polygon> elements tagged data-tone="positive" / "negative"
      //   - read positiveSwatch + negativeSwatch from the legend entry
      //   - default to the brand-clay #8b3520 negative fill so the
      //     chart's Saguaro-matched negative bar colour stays single-
      //     sourced
      expect(BAR_CHART).toMatch(/e\.shape === ["']split-bar["']/);
      expect(BAR_CHART).toMatch(/data-tone="positive"/);
      expect(BAR_CHART).toMatch(/data-tone="negative"/);
      expect(BAR_CHART).toMatch(/e\.positiveSwatch \?\? ["']fill-club-green-500["']/);
      expect(BAR_CHART).toMatch(/e\.negativeSwatch \?\? ["']fill-\[#8b3520\]["']/);
    });

    it("split-bar marker shares the same rectangular footprint as the single-tone 'bar' marker", () => {
      // Per founder direction 2026-06-14: the Actual swatch must
      // remain the SAME rectangular dimensions as the Budget swatch
      // so the legend reads as one family. The split-bar uses
      // PREVIEW_W (the same width every bar swatch uses) and the
      // same 8-px height as the Budget bar, with no centering offset.
      expect(BAR_CHART).toMatch(/if \(e\.shape === ["']split-bar["']\)\s*\{[\s\S]+?const swW = PREVIEW_W;/);
      expect(BAR_CHART).toMatch(/if \(e\.shape === ["']split-bar["']\)\s*\{[\s\S]+?const swH = 8;/);
      expect(BAR_CHART).toMatch(/if \(e\.shape === ["']split-bar["']\)\s*\{[\s\S]+?const swX = lineLeftX;/);
      // Single-tone "bar" branch uses the same height — pinned so
      // future tweaks keep both branches in lockstep.
      expect(BAR_CHART).toMatch(/if \(e\.shape === ["']bar["']\)\s*\{[\s\S]+?const swH = 8;/);
    });

    it("commentary is generated, not hardcoded — page consumes data.interpretation", () => {
      expect(operatingCardBlock).toMatch(/interpretation=\{data\.interpretation\}/);
      // The hardcoded interpretation string from the prior version
      // must not reappear in the React tree.
      expect(PAGE).not.toMatch(/Year-end NOI of \*\*\$\d+K \(\d/);
      // The generator owns the templates.
      expect(OP_COMMENTARY).toMatch(/ClubBenchmarking break-even zone/);
    });

    it("Operating commentary generator must never reference 'pillar' in EMITTED prose", () => {
      // Scope to template literals + double-quoted strings so a
      // documentation comment does not false-trigger.
      const templates = OP_COMMENTARY.match(/`[^`]+`/g) ?? [];
      for (const t of templates) {
        expect(t.toLowerCase()).not.toContain("pillar");
      }
      const dquoted = OP_COMMENTARY.match(/"[^"]+"/g) ?? [];
      for (const s of dquoted) {
        expect(s.toLowerCase()).not.toContain("pillar");
      }
    });

    it("Stewardship Scorecards — two scorecard cards render beneath the chart pair (Operating + Capital)", () => {
      // The StewardshipDashboard now ships two rows: charts on top,
      // scorecards beneath. Both scorecard testids must appear.
      expect(PAGE).toMatch(/data-testid="stewardship-scorecards"/);
      expect(PAGE).toMatch(/testid="stewardship-scorecard-operating"/);
      expect(PAGE).toMatch(/testid="stewardship-scorecard-capital"/);
      // The scorecard card component itself.
      expect(PAGE).toMatch(/function StewardshipScorecardCard\(/);
    });

    it("Stewardship Scorecards — operating + capital data shapes live in scorecard-metrics service (NOT monthly-package builder)", () => {
      // Public shape on the package type.
      expect(SERVICE).toMatch(/scorecards:\s*\{[\s\S]*?operating:\s*StewardshipScorecard[\s\S]*?capital:\s*StewardshipScorecard/);
      // The scorecard headers + section bands + column headers now
      // live in the scorecard-metrics service file, not in the
      // monthly-package builder block. Read that file directly.
      const METRICS = fs.readFileSync(
        path.resolve(process.cwd(), "src/lib/reporting/scorecard-metrics.ts"),
        "utf8",
      );
      expect(METRICS).toMatch(/title:\s*"Operating Stewardship — KPI Scorecard"/);
      expect(METRICS).toMatch(/subtitle:\s*"IS THE CLUB LIVING WITHIN THE OPERATING PLAN\?"/);
      expect(METRICS).toMatch(/title:\s*"Capital Stewardship — KPI Scorecard"/);
      expect(METRICS).toMatch(/subtitle:\s*"IS THE CLUB PROTECTING ITS FUTURE\?"/);
      expect(METRICS).toMatch(/sectionBand:\s*"NON-PROFIT OPERATING LEDGER"/);
      expect(METRICS).toMatch(/sectionBand:\s*"CAPITAL LEDGER & BALANCE SHEET HEALTH"/);
      expect(METRICS).toMatch(/columnHeaders:\s*\{[^}]*budget:\s*"Budget"[^}]*benchmark:\s*"Benchmark"/);
      expect(METRICS).toMatch(/columnHeaders:\s*\{[^}]*budget:\s*"Budget\/Goal"[^}]*benchmark:\s*"Best-in-Class"/);
    });

    it("Stewardship Scorecards — accounting-fed rows pull from the equity + operating dashboards (NOT React literals)", () => {
      // The dashboard labels still flow into the scorecards — but
      // they now go through buildOperatingScorecardData /
      // buildCapitalScorecardData rather than being typed as inline
      // row literals in the package builder. The package now PASSES
      // the labels into the service.
      //
      // After the Jonas-readiness operating-scorecard refactor, the
      // `buildOperatingScorecardData(...)` call wraps its first
      // argument in `buildDemoOperatingScorecardSnapshot()` (nested
      // parens). The `\([\s\S]*?` patterns below allow nested
      // groups, so the assertion targets the *eventual* presence of
      // the operating-dashboard label reference anywhere inside the
      // outer call.
      expect(SERVICE).toMatch(/buildOperatingScorecardData\([\s\S]*?operatingDashboard\.ytdNoiLabel/);
      expect(SERVICE).toMatch(/buildOperatingScorecardData\([\s\S]*?operatingDashboard\.budgetGoalLabel/);
      expect(SERVICE).toMatch(/buildOperatingScorecardData\([\s\S]*?operatingDashboard\.noiPctRevenueLabel/);
      // Same nested-paren accommodation as the operating call:
      // `buildCapitalScorecardData(...)` now wraps its first
      // argument in `buildDemoCapitalScorecardSnapshot()`, so the
      // [^)]* pattern needs the multi-char any-including-newline
      // form to reach past the wrapper.
      expect(SERVICE).toMatch(/buildCapitalScorecardData\([\s\S]*?equityDashboard\.actualCagrLabel/);
      expect(SERVICE).toMatch(/buildCapitalScorecardData\([\s\S]*?equityDashboard\.bestInClassCagrLabel/);
      // The scorecard-metrics service file is what owns the row
      // computations now — verify it exists and is wired by the
      // import + call.
      expect(SERVICE).toMatch(/from\s+["'@\/]+lib\/reporting\/scorecard-metrics["']/);
      expect(SERVICE).toMatch(/buildOperatingScorecardData\(/);
      expect(SERVICE).toMatch(/buildCapitalScorecardData\(/);
    });

    it("Stewardship Scorecards — every scorecard row literal has been moved OUT of monthly-package.ts into the scorecard-metrics service", () => {
      // Before the audit refactor, monthly-package.ts had the 8-row
      // operating + 8-row capital arrays inline as literal strings
      // (actual: "65.9%", budget: "67.2%", etc.). The audit rule says
      // those literals must live in a reporting service, not in the
      // package-builder block. This guard pins that the literal
      // strings are gone from monthly-package.ts. If they reappear,
      // someone has reverted to the audit-flagged shape.
      const scorecardLiterals = [
        '"65.9%"', '"67.2%"', '"≥60%"',         // dues-to-revenue
        '"$1.07M"', '"$1.04M"',                  // initiation fee
        '"59.2%"', '"58.2%"', '"57%+"',          // payroll
        '"77.2%"', '"77.0%"', '"66%+"',          // equity-to-assets
        '"11.7%"', '"14.0%"', '"14%+"',          // capital reserve
        '"26.2%"', '"34.7%"', '"20%+"',          // net available capital
        '"YES"', '"Required"',                    // net capital > depreciation
        '"31%"', '"35%"', '"55%+ target"',        // net PPE
        '"$4.44M"', '"$6.03M"', '"−$1.59M"',     // total capital income
        '"6,483"', '"5,455"', '"+1,028"',         // golf rounds
        '"24,207"', '"29,310"', '"−5,103"',       // F&B covers
      ];
      for (const lit of scorecardLiterals) {
        expect(
          SERVICE.includes(lit),
          `scorecard literal ${lit} must NOT appear in monthly-package.ts (moved to scorecard-metrics service)`,
        ).toBe(false);
      }
      // And of course PAGE.tsx must not have them either.
      for (const lit of scorecardLiterals) {
        expect(
          PAGE.includes(lit),
          `scorecard literal ${lit} must NOT appear in page.tsx`,
        ).toBe(false);
      }
    });

    it("Stewardship Scorecards — service ships the FULL row set (8 rows operating, 8 rows capital) — verified by the scorecard-metrics unit tests", () => {
      // The row set + values are pinned by tests/scorecard-metrics.test.ts
      // which exercises the actual computation. Here we just confirm
      // the service file is wired into the package builder.
      const METRICS = fs.readFileSync(
        path.resolve(process.cwd(), "src/lib/reporting/scorecard-metrics.ts"),
        "utf8",
      );
      // 8 row keys per scorecard.
      const operatingKeys = [
        "dues-to-revenue", "initiation-fee-subsidy", "payroll-benefits-ratio",
        "noi-variance-to-budget", "noi-pct-revenue", "fb-subsidy-pct-dues",
        "golf-rounds-vs-budget", "fb-covers-vs-budget",
      ];
      const capitalKeys = [
        "equity-cagr", "equity-to-assets", "capital-reserve-pct",
        "net-available-capital", "net-capital-vs-depreciation",
        "long-term-debt-equity", "net-ppe-to-gross-ppe",
        "total-capital-income-vs-budget",
      ];
      for (const k of [...operatingKeys, ...capitalKeys]) {
        expect(METRICS).toMatch(new RegExp(`key:\\s*"${k.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}"`));
      }
    });

    it("Stewardship Scorecards — `trend` override flows through the glyph helper (Monitor + downward arrow case)", () => {
      // The trend override allows a row whose status is "monitor"
      // to still display a downward arrow — needed for the Total
      // Capital Income vs. Budget row.
      // Component reads `row.trend` first and falls back to status.
      expect(PAGE).toMatch(/if\s*\(row\.trend\)/);
      expect(PAGE).toMatch(/scorecardStatusGlyph\(row\)/);
      // StewardshipScorecardRow public type exposes the optional
      // trend field on the monthly-package public surface.
      expect(SERVICE).toMatch(/trend\?:\s*"up"\s*\|\s*"down"\s*\|\s*"flat"/);
      // The scorecard-metrics service is the one that SETS trend
      // when actual/budget delta is negative — proves the
      // service-computed trend flows to the chart, not a manual
      // pick in monthly-package.
      const METRICS = fs.readFileSync(
        path.resolve(process.cwd(), "src/lib/reporting/scorecard-metrics.ts"),
        "utf8",
      );
      expect(METRICS).toMatch(/function trendOfDelta/);
      expect(METRICS).toMatch(/trend:\s*trendOfDelta/);
    });

    it("Stewardship Scorecards — each card renders the 3-dot legend, section band, column header row, and per-row data-status attribute", () => {
      // Header legend dots — three labels (On Track / Monitor / Action)
      // each paired with a status-specific colour token.
      expect(PAGE).toMatch(/On Track/);
      expect(PAGE).toMatch(/Monitor/);
      expect(PAGE).toMatch(/Action/);
      // The dot-class helper maps status → fill token.
      expect(PAGE).toMatch(/function scorecardDotClass/);
      // Inline hex tokens — preserve the brand palette colours without
      // re-introducing the Executive Reporting color audit's banned
      // `bg-club-green-500` / `bg-amber-500` / `bg-red-500` class names.
      expect(PAGE).toMatch(/case "on-track":\s*return\s*"bg-\[#3f7042\]"/);
      expect(PAGE).toMatch(/case "monitor":\s*return\s*"bg-\[#b08a4a\]"/);
      expect(PAGE).toMatch(/case "action":\s*return\s*"bg-\[#8b3520\]"/);
      // Each scorecard renders the section-band testid + column header
      // row + rows region.
      expect(PAGE).toMatch(/data-testid=\{`\$\{testid\}-section-band`\}/);
      expect(PAGE).toMatch(/data-testid=\{`\$\{testid\}-rows`\}/);
      // Each row carries data-status for downstream Playwright /
      // measurement consumption.
      expect(PAGE).toMatch(/data-status=\{row\.status\}/);
    });

    it("Stewardship Supplemental Row — Department Net Performance + Dues Subsidy Analysis cards render beneath the scorecards", () => {
      // Card components exist.
      expect(PAGE).toMatch(/function DepartmentNetPerformanceCard\(/);
      expect(PAGE).toMatch(/function DuesSubsidyAnalysisCard\(/);
      // Third-row wrapper testid + the two card testids on the page.
      expect(PAGE).toMatch(/data-testid="stewardship-supplemental"/);
      expect(PAGE).toMatch(/data-testid="department-net-performance"/);
      expect(PAGE).toMatch(/data-testid="dues-subsidy-analysis"/);
      // Data shapes exposed by the package.
      expect(SERVICE).toMatch(/departmentPerformance:\s*DepartmentNetPerformanceData/);
      expect(SERVICE).toMatch(/duesSubsidy:\s*DuesSubsidyData/);
      // Builder calls in the package builder.
      expect(SERVICE).toMatch(/buildDepartmentNetPerformanceData\(/);
      expect(SERVICE).toMatch(/buildDuesSubsidyData\(/);
    });

    it("Stewardship Supplemental Row — NO inline department / dues literal strings in monthly-package.ts or page.tsx", () => {
      // Strict version of the data-source discipline: every literal
      // value displayed by the two new cards is computed by a service
      // and seeded as a NUMERIC input in the service file. If any of
      // the displayed STRINGS reappear in the package builder or in
      // React, the audit's rule is broken.
      const forbidden = [
        // Department actual / budget / variance display strings
        '"($77K)"', '"($127K)"', '"+$50K"',
        '"($2,884K)"', '"($2,836K)"',
        '"($1,886K)"', '"($1,676K)"', '"($210K)"',
        '"+$124K"',
        // Dues summary line
        '"$10.38M"',
        '"253 Members"',
        '"~$41K / member / yr"',
        // Category label display strings on the page side
        '"Golf Course Maint. & Staffing"',
        '"Admin, Membership, Accounting, IT & HR"',
      ];
      for (const lit of forbidden) {
        expect(SERVICE.includes(lit), `${lit} must NOT appear in monthly-package.ts (moved to a reporting service)`).toBe(false);
        expect(PAGE.includes(lit), `${lit} must NOT appear in page.tsx (must flow from data prop)`).toBe(false);
      }
    });

    it("Stewardship Supplemental Row — Department + Dues services are wired and own all literal data", () => {
      const DEPT_SERVICE = fs.readFileSync(
        path.resolve(process.cwd(), "src/lib/reporting/department-net-performance.ts"),
        "utf8",
      );
      const DUES_SERVICE = fs.readFileSync(
        path.resolve(process.cwd(), "src/lib/reporting/dues-subsidy.ts"),
        "utf8",
      );
      // Department service emits the founder-named headers + commentary.
      expect(DEPT_SERVICE).toMatch(/"Department Net Performance Highlights"/);
      expect(DEPT_SERVICE).toMatch(/"ACTUAL VS\. BUDGET YTD/);
      expect(DEPT_SERVICE).toMatch(/"DEPT SUMMARY"/);
      // Numeric inputs are in the service (not React).
      expect(DEPT_SERVICE).toMatch(/ytdActual:\s*-77_000/);
      expect(DEPT_SERVICE).toMatch(/ytdActual:\s*-2_884_000/);

      // Dues service emits the founder-named headers + categories.
      expect(DUES_SERVICE).toMatch(/"Dues Subsidy Analysis"/);
      expect(DUES_SERVICE).toMatch(/"DUES BREAKDOWN"/);
      // The constant was renamed + bumped to match the founder's
      // dues-payroll delta spec ($511K = 10,381,000 − 9,870,000).
      // The canonical constant is now SILVER_SPRINGS_OPERATING_DUES,
      // and the legacy SILVER_SPRINGS_DUES_TOTAL is an alias pointing
      // at the same value — see "Financial Reporting Data Integrity"
      // in CLAUDE.md (single source of truth).
      expect(DUES_SERVICE).toMatch(/SILVER_SPRINGS_OPERATING_DUES\s*=\s*10_381_000/);
      expect(DUES_SERVICE).toMatch(/SILVER_SPRINGS_DUES_TOTAL\s*=\s*SILVER_SPRINGS_OPERATING_DUES/);
      expect(DUES_SERVICE).toMatch(/SILVER_SPRINGS_MEMBER_COUNT\s*=\s*253/);
      // All 15 category labels are in the service.
      expect(DUES_SERVICE).toMatch(/"Golf Course Maint\. & Staffing"/);
      expect(DUES_SERVICE).toMatch(/"Club Owned Lot POA Fees"/);
    });

    it("Payroll Analysis Row — Payroll Department + Payroll Ratio Trend cards render beneath the Department / Dues row", () => {
      // Card components exist.
      expect(PAGE).toMatch(/function PayrollDepartmentCard\(/);
      expect(PAGE).toMatch(/function PayrollRatioTrendCard\(/);
      // Fourth-row wrapper testid + the two card testids on the page.
      expect(PAGE).toMatch(/data-testid="stewardship-payroll"/);
      expect(PAGE).toMatch(/data-testid="payroll-department"/);
      expect(PAGE).toMatch(/data-testid="payroll-ratio-trend"/);
      // Both cards render the shared CardHeaderBand with pill chip.
      expect(PAGE).toMatch(/function CardHeaderBand\(/);
      // Data shapes exposed by the package.
      expect(SERVICE).toMatch(/payrollDepartment:\s*PayrollDepartmentData/);
      expect(SERVICE).toMatch(/payrollRatioTrend:\s*PayrollRatioTrendData/);
      // Builder calls in the package builder.
      expect(SERVICE).toMatch(/buildPayrollDepartmentData\(/);
      expect(SERVICE).toMatch(/buildPayrollRatioTrendData\(/);
    });

    it("Payroll Analysis Row — payroll-analysis service owns all literal data + computes KPIs from typed inputs", () => {
      const PAYROLL_SERVICE = fs.readFileSync(
        path.resolve(process.cwd(), "src/lib/reporting/payroll-analysis.ts"),
        "utf8",
      );
      // Service emits the founder-named card headers.
      expect(PAYROLL_SERVICE).toMatch(/"Payroll Analysis — Department Breakdown"/);
      expect(PAYROLL_SERVICE).toMatch(/"Payroll Ratio — Monthly Trend"/);
      expect(PAYROLL_SERVICE).toMatch(/"LABOR REPORT"/);
      expect(PAYROLL_SERVICE).toMatch(/"RATIO TREND"/);
      // Department seeds are typed numeric inputs (in the service).
      expect(PAYROLL_SERVICE).toMatch(/SILVER_SPRINGS_PAYROLL_DEPTS/);
      expect(PAYROLL_SERVICE).toMatch(/actual:\s*2_700_000/); // GCM actual
      expect(PAYROLL_SERVICE).toMatch(/actual:\s*2_800_000/); // F&B actual
      // Benchmark + revenue are typed config in the service.
      expect(PAYROLL_SERVICE).toMatch(/SILVER_SPRINGS_PAYROLL_BENCHMARK_PCT\s*=\s*57/);
      expect(PAYROLL_SERVICE).toMatch(/SILVER_SPRINGS_PAYROLL_REVENUE\s*=\s*16_671_000/);
    });

    it("Payroll Analysis Row — NO inline payroll literal strings appear in monthly-package.ts or page.tsx", () => {
      // The displayed KPI strings must NOT appear in the package
      // builder or in React — they flow from the service computation.
      // Note: `"PASS"` / `"FAIL"` ARE allowed in page.tsx because
      // they're type-narrowing discriminators (decision === "PASS")
      // that drive the dot colour, not display strings — the visible
      // decision text comes from data.check.decision.
      const forbidden = [
        '"$9.87M"', '"$122K"', '"$613K"',
        '"59.2%"', '"58.2%"', '"55.3%"',
        // Founder-spec exact phrases on the page side
        '"LABOR REPORT"', '"RATIO TREND"',
        '"Payroll Analysis — Department Breakdown"',
        '"Payroll Ratio — Monthly Trend"',
      ];
      for (const lit of forbidden) {
        expect(SERVICE.includes(lit), `${lit} must NOT appear in monthly-package.ts`).toBe(false);
        expect(PAGE.includes(lit), `${lit} must NOT appear in page.tsx`).toBe(false);
      }
    });

    it("LOCKED EQUITY: editing Operating Results did NOT regress the equity card", () => {
      // The four locked numbers from docs/equity-value-over-time-card-spec.md.
      // If a future task accidentally edits them while working on the
      // Operating Results card, this guard fires.
      expect(equityCardBlock).toMatch(/padLeft=\{44\}/);
      expect(equityCardBlock).toMatch(/padRight=\{14\}/);
      expect(equityCardBlock).toMatch(/height=\{245\}/);
      expect(equityCardBlock).toMatch(/layout=["']chart-dominant["']/);
      expect(equityCardBlock).toMatch(/insetCommentary/);
      // Equity legend still uses line-preview shape.
      expect(equityCardBlock).toMatch(/stroke:\s*["']stroke-club-green-500["']/);
      expect(equityCardBlock).toMatch(/showMarker:\s*true/);
    });
  });

  it("Chair's Dashboard chapter II ships its anchor + eyebrow + framing lead", () => {
    // Section id + the masthead eyebrow (re-authored per founder
    // direction to frame the chapter as a club-branded "Visual
    // Summary" rather than as a pillar-management Chair's Dashboard).
    expect(MONTHLY_PAGE).toMatch(/<section id="financial-performance"/);
    expect(MONTHLY_PAGE).toMatch(/eyebrow="Silver Springs Golf & Country Club · Visual Summary"/);
    expect(MONTHLY_PAGE).toMatch(/title="Financial Performance, Illustrated"/);
    // Long-form lead paragraph REMOVED — replaced with the visual
    // StewardshipDashboard (two equal-width chart cards immediately
    // after the section heading) per the Visual-First Reporting
    // principle (docs/spectre-executive-reporting-design-system.md).
    // A director should land on the two charts first, not on
    // explanatory prose.
    expect(MONTHLY_PAGE).not.toMatch(/data-testid="financial-performance-lead"/);
    expect(MONTHLY_PAGE).not.toMatch(/80&ndash;90%/);
    // Visual stewardship dashboard wired in its place. The two card
    // testids are passed as the `testid` prop on StewardshipCard
    // (which forwards to data-testid at render time), so the source
    // pin is on the prop literal, not on `data-testid="…"`.
    expect(MONTHLY_PAGE).toMatch(/<StewardshipDashboard data=\{pkg\.stewardshipDashboard\}/);
    expect(MONTHLY_PAGE).toMatch(/data-testid="stewardship-dashboard"/);
    expect(MONTHLY_PAGE).toMatch(/testid="stewardship-equity"/);
    expect(MONTHLY_PAGE).toMatch(/testid="stewardship-operating"/);
  });

  // -----------------------------------------------------------------
  // Chapter II section boundary — Financial Performance terminates
  // at the StewardshipDashboard
  // -----------------------------------------------------------------
  // Per founder direction 2026-06-14 (Saguaro reference parity), the
  // Financial Performance chapter ends at the Payroll Ratio — Monthly
  // Trend card (the last card rendered by StewardshipDashboard). The
  // following blocks were removed from chapter II to match the
  // Saguaro reference, which does not contain these cards:
  //   • Executive Narrative (Five Observations)
  //   • Dashboard attention rollup
  //   • Five-pillar grid (PillarSummaryCard ×5)
  //   • Board Decisions
  //   • Board Risks
  // The next chapter (III · Operations) follows immediately.
  it("chapter II ends at the StewardshipDashboard — no post-Payroll cards inside the section", () => {
    const dash = MONTHLY_PAGE.match(/function ChairsDashboard\([\s\S]+?^\}/m);
    expect(dash, "ChairsDashboard body must be findable").toBeTruthy();
    const body = dash![0];

    // StewardshipDashboard remains the chapter's final block — Equity
    // Value Over Time + Operating Results + the four KPI scorecards +
    // Department Net Performance + Dues Subsidy + Payroll Analysis +
    // Payroll Ratio all live inside this single component.
    expect(body).toMatch(/<StewardshipDashboard\s+data=\{pkg\.stewardshipDashboard\}/);

    // Post-Payroll cards explicitly REMOVED from the chapter.
    expect(body, "ExecutiveNarrative must not render inside chapter II")
      .not.toMatch(/<ExecutiveNarrative\s/);
    expect(body, "DashboardAttentionRollup must not render inside chapter II")
      .not.toMatch(/<DashboardAttentionRollup\s/);
    expect(body, "five-pillar grid wrapper must not render inside chapter II")
      .not.toMatch(/data-testid="financial-performance-grid"/);
    expect(body, "PillarSummaryCard must not render inside chapter II")
      .not.toMatch(/<PillarSummaryCard\s/);
    expect(body, "BoardDecisions must not render inside chapter II")
      .not.toMatch(/<BoardDecisions\s/);
    expect(body, "BoardRisks must not render inside chapter II")
      .not.toMatch(/<BoardRisks\s/);
  });

  // -----------------------------------------------------------------
  // Data-layer pin (kept after the chapter-II render trim) — the
  // service still ships commentary.<pillar>.boardHeadline so other
  // consumers (PDF export, downstream chapters) can read the
  // Director-voice sentence. Field shape is unchanged.
  // -----------------------------------------------------------------
  it("commentary.boardHeadline is populated for all five pillars in the demo data", () => {
    expect(MONTHLY_PACKAGE).toMatch(/operations:\s*\{[\s\S]*?boardHeadline:/);
    expect(MONTHLY_PACKAGE).toMatch(/financialStatements:\s*\{[\s\S]*?boardHeadline:/);
    expect(MONTHLY_PACKAGE).toMatch(/capitalProjects:\s*\{[\s\S]*?boardHeadline:/);
    expect(MONTHLY_PACKAGE).toMatch(/membershipStewardship:\s*\{[\s\S]*?boardHeadline:/);
    expect(MONTHLY_PACKAGE).toMatch(/experienceStewardship:\s*\{[\s\S]*?boardHeadline:/);
  });

  // -----------------------------------------------------------------
  // Data-layer pin (kept after the chapter-II render trim) — the
  // BoardDecision type + demo data remain on the service for the
  // future PDF / committee-pack export path. The chapter-II RENDER
  // of these decisions was removed (no longer Saguaro-aligned).
  // -----------------------------------------------------------------
  it("BoardDecisions demo data + type contract still ship on the service", () => {
    expect(MONTHLY_PACKAGE).toMatch(/boardDecisions:\s*\[/);
    const block = MONTHLY_PACKAGE.match(/boardDecisions:\s*\[[\s\S]+?\n    \],/);
    expect(block, "boardDecisions demo block must be findable").toBeTruthy();
    const body = block![0];
    const keyMatches = body.match(/key:\s*"[a-z0-9-]+"/g);
    expect(keyMatches, "boardDecisions must list 3 keys").toHaveLength(3);
    expect(body.match(/sponsor:\s*"[^"]+"/g), "each decision must name a sponsor").toHaveLength(3);
    expect(body.match(/meeting:\s*"[^"]+"/g), "each decision must name a meeting").toHaveLength(3);
    expect(body).not.toMatch(/TBD|Pending|Coming Soon|placeholder/i);
    // Type contract.
    expect(MONTHLY_PACKAGE).toMatch(/export type DecisionAction\s*=\s*"approve"\s*\|\s*"review"\s*\|\s*"ratify"/);
    expect(MONTHLY_PACKAGE).toMatch(/export type BoardDecision\s*=\s*\{/);
  });

  // -----------------------------------------------------------------
  // Data-layer pin (kept after the chapter-II render trim) — the
  // BoardRisk type + demo data remain on the service for the future
  // PDF / committee-pack export path. The chapter-II RENDER of these
  // risks was removed (no longer Saguaro-aligned).
  // -----------------------------------------------------------------
  it("BoardRisks demo data + type contract still ship on the service", () => {
    expect(MONTHLY_PACKAGE).toMatch(/boardRisks:\s*\[/);
    const block = MONTHLY_PACKAGE.match(/boardRisks:\s*\[[\s\S]+?\n    \],/);
    expect(block, "boardRisks demo block must be findable").toBeTruthy();
    const body = block![0];
    const keyMatches = body.match(/key:\s*"[a-z0-9-]+"/g);
    expect(keyMatches, "boardRisks must list 5 keys").toHaveLength(5);
    const highIdx     = body.indexOf('severity: "high"');
    const moderateIdx = body.indexOf('severity: "moderate"');
    const watchIdx    = body.indexOf('severity: "watch"');
    expect(highIdx,     "demo must include a HIGH risk").toBeGreaterThan(-1);
    expect(moderateIdx, "demo must include MODERATE risks").toBeGreaterThan(-1);
    expect(watchIdx,    "demo must include a WATCH risk").toBeGreaterThan(-1);
    expect(highIdx,     "HIGH must lead MODERATE in source").toBeLessThan(moderateIdx);
    expect(moderateIdx, "MODERATE must lead WATCH in source").toBeLessThan(watchIdx);
    // Type contract.
    expect(MONTHLY_PACKAGE).toMatch(/export type BoardRiskSeverity\s*=\s*"high"\s*\|\s*"moderate"\s*\|\s*"watch"/);
    expect(MONTHLY_PACKAGE).toMatch(/export type BoardRiskTrend\s*=\s*"worsening"\s*\|\s*"stable"\s*\|\s*"improving"\s*\|\s*"new"/);
    expect(MONTHLY_PACKAGE).toMatch(/export type BoardRisk\s*=\s*\{/);
  });

  // The original source-contract pins below this point asserted that
  // the chapter rendered ExecutiveNarrative + financial-performance-grid +
  // BoardDecisions + BoardRisks. All have been intentionally removed
  // per the Saguaro reference-replication directive. The three pins
  // above preserve the still-meaningful data-layer assertions and the
  // chapter-II render boundary.

  // -----------------------------------------------------------------
  // Pillar deep-dive panels (Operations / Financial Health / Capital /
  // Membership / Experience) REMOVED 2026-06-16 with the chapter
  // consolidation that dropped the rail from 23 chapters to 14.
  // -----------------------------------------------------------------
});
