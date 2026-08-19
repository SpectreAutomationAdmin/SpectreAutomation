// Mission Control integration sentinel (2026-08-19).
//
// This sentinel exists because Phase 4R rev-4 through rev-14 +
// Phase 20 Member Database were founder-approved on the
// `work-intake-state-outlook-archive-fix` branch and NEVER merged
// to `main`. When the HR module was branched off `main`, it
// silently regressed the entire Mission Control shell + Work
// Intake card + Outlook read/unread sync + AP intelligence
// projection — because none of that code existed on the branch
// HR started from.
//
// The regression was invisible to CI because:
//   * every test on HR branch passed (HR code is internally consistent)
//   * every test on WIP branch passed (WIP code is internally consistent)
//   * NO test asserted "when both HR and MC live together, MC still works"
//
// This file is that assertion. It pins the FOUNDER-CONTRACT surface
// of the reconciled application. A pull request that regresses any
// pinned invariant fails here, before it can reach staging or
// founder review.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("Mission Control integration sentinel · shell", () => {
  const adminShell = src("src/components/admin/AdminShell.tsx");
  const adminLayout = src("src/app/app/admin/layout.tsx");
  const sidebarNav = src("src/components/sidebar-nav-data.ts");
  const spectreSidebar = src("src/components/spectre/SpectreSidebar.tsx");

  it("AdminShell renders SpectreShell as the DEFAULT admin chrome (rev-4)", () => {
    // The Phase 4R rev-4 rule: Spectre is default; POS + Reporting opt out.
    // The stale HR-era opt-IN prefix list must NOT come back.
    expect(adminShell).not.toMatch(/SPECTRE_MODE_PREFIXES/);
    expect(adminShell).not.toMatch(/SPECTRE_MODE_EXACT_URLS/);
    expect(adminShell).not.toMatch(/SPECTRE_MODE_EXACT_PATHS/);
    // Must still import SpectreShell.
    expect(adminShell).toMatch(/from "@\/components\/spectre\/SpectreShell"/);
    // POS + Reporting opt-OUT are the only branches allowed.
    expect(adminShell).toMatch(/POS_MODE_PREFIXES/);
    expect(adminShell).toMatch(/REPORTING_MODE_PREFIXES/);
  });

  it("admin layout wires both legacy fallback AND canonical Spectre chrome", () => {
    expect(adminLayout).toMatch(/spectreSidebar=\{/);
    expect(adminLayout).toMatch(/spectreTopbar=\{/);
    expect(adminLayout).toMatch(/BreadcrumbLabelsProvider/);
  });

  it("SpectreSidebar consumes canonical ADMIN_SECTIONS + ADMIN_TOP_LEVEL nav", () => {
    expect(spectreSidebar).toMatch(/ADMIN_TOP_LEVEL/);
    expect(spectreSidebar).toMatch(/ADMIN_SECTIONS/);
    expect(spectreSidebar).toMatch(/from "@\/components\/sidebar-nav-data"/);
  });

  it("no duplicate top-level Search entry (sidebar search removed by rev-4)", () => {
    // The pre-rev-4 sidebar had an in-sidebar search field. The
    // canonical single search lives in the topbar (`GlobalSearch`).
    // A future refactor that reintroduces `label: "Search"` in
    // `ADMIN_TOP_LEVEL` fails here.
    const topLevelBlock = sidebarNav.match(/ADMIN_TOP_LEVEL: NavItem\[\] = \[([\s\S]+?)\];/);
    expect(topLevelBlock, "ADMIN_TOP_LEVEL block not found").toBeTruthy();
    const body = topLevelBlock![1];
    expect(body).not.toMatch(/label:\s*"Search"/);
  });

  it("People section (HR) lives inside canonical ADMIN_SECTIONS — one navigation, not two", () => {
    expect(sidebarNav).toMatch(/id:\s*"people"/);
    expect(sidebarNav).toMatch(/label:\s*"Employee Directory"/);
    expect(sidebarNav).toMatch(/label:\s*"Onboarding"/);
    // People sits between Membership and Finance per HR-2A ordering.
    const membershipIdx = sidebarNav.indexOf('id: "membership"');
    const peopleIdx = sidebarNav.indexOf('id: "people"');
    const financeIdx = sidebarNav.indexOf('id: "finance"');
    expect(membershipIdx).toBeGreaterThan(0);
    expect(peopleIdx).toBeGreaterThan(membershipIdx);
    expect(financeIdx).toBeGreaterThan(peopleIdx);
  });
});

describe("Mission Control integration sentinel · Work Intake card contract", () => {
  const emailCard = src("src/components/mission-control/EmailIntakeCard.tsx");

  it("Work Intake card uses the three-tab model (AI Summary / Conversation / Attachments)", () => {
    // Rev-14 canonical tabs.
    expect(emailCard).toMatch(/AI Summary/);
    expect(emailCard).toMatch(/Conversation/);
    expect(emailCard).toMatch(/Attachments/);
    // The pre-rev-7 "Open" / "Collapse" model must NOT return.
    // (Case-sensitive to avoid false matches on words like "open" in helpers.)
    expect(emailCard).not.toMatch(/>Open<\/button>/);
    expect(emailCard).not.toMatch(/>Collapse<\/button>/);
  });

  it("Work Intake card does NOT surface internal MAIL-* identifiers in the founder-visible UI", () => {
    // The old cards rendered internal short identifiers like `MAIL-27BX`
    // in the header. The rev-14 card does not.
    expect(emailCard).not.toMatch(/MAIL-\$\{/);
    expect(emailCard).not.toMatch(/`MAIL-/);
  });

  it("Work Intake card reads active-card state from the shared WorkFeedActiveContext (rev-14)", () => {
    // The active-card reset behaviour ("previous card returns to
    // AI Summary when a different card becomes active") depends on
    // this context wiring.
    expect(emailCard).toMatch(/WorkFeedActive|useWorkFeedActive|WorkFeedActiveContext/);
  });
});

describe("Mission Control integration sentinel · Feed Synced + refresh", () => {
  const feedPill = src("src/components/mission-control/FeedSyncedStatusPill.tsx");

  it("Feed Synced pill exposes an integrated refresh icon (no separate 'Refresh now' text link)", () => {
    // Rev-6: the refresh affordance is an icon inside the FEED SYNCED
    // pill. The pre-rev-6 separate "Refresh now" text was removed.
    expect(feedPill).toMatch(/aria-label="Refresh|aria-label=\{`Refresh|title="Refresh|title=\{"Refresh/);
    // The specific string "Refresh now" as a visible label must NOT
    // return in a rendered `<span>` / `<button>`.
    expect(feedPill).not.toMatch(/>Refresh now</);
  });
});

describe("Mission Control integration sentinel · Outlook read/unread contract", () => {
  it("mailbox/mark-read.ts is present — rev-10/12/13 Outlook-canonical read-state", () => {
    // The whole Outlook round-trip (Spectre → Graph PATCH → Outlook)
    // depends on this file. If it disappears (as it did when HR
    // branched off main), the round-trip silently regresses.
    expect(() =>
      readFileSync(resolve(process.cwd(), "src/lib/mailbox/mark-read.ts"), "utf8"),
    ).not.toThrow();
  });

  it("MicrosoftDelegatedProvider interface exposes markMessageRead()", () => {
    const provider = src("src/lib/integrations/microsoft-graph-delegated.ts");
    expect(provider).toMatch(/markMessageRead\(args: MarkMessageReadArgs\)/);
    expect(provider).toMatch(/PATCH \/v1\.0\/me\/messages/);
  });

  it("mailbox refresh-mailbox routes exist (rev-13 manual Feed Sync)", () => {
    // Manual Feed Sync (icon click) enqueues a real mailbox refresh
    // job and polls its status. Both routes must be present.
    expect(() =>
      readFileSync(resolve(process.cwd(), "src/app/api/mission-control/refresh-mailbox/route.ts"), "utf8"),
    ).not.toThrow();
    expect(() =>
      readFileSync(resolve(process.cwd(), "src/app/api/mission-control/refresh-mailbox/status/route.ts"), "utf8"),
    ).not.toThrow();
  });
});

describe("Mission Control integration sentinel · AP intelligence projection", () => {
  const projection = src("src/lib/mission-control/intelligence-review-intakes.ts");

  it("AP projection uses the rev-14+ vendor-not-found-→-create-vendor recommendation branch", () => {
    // The pre-WIP branch's projection returned a generic "Supplier
    // identity is not resolved to sufficient confidence" abstention
    // for every unresolved-supplier row. The founder-approved branch
    // distinguishes:
    //   • supplier resolved + no matching vendor → "create vendor and post"
    //   • supplier NOT resolved                  → the generic abstention
    // A regression that collapses both branches back into the single
    // generic abstention fails here.
    expect(projection).toMatch(/create the vendor|create vendor/i);
  });

  it("AP projection is the file rev-14 rewrote (not the pre-WIP stub)", () => {
    // Structural check — line-count assertion is fragile, but at least
    // pin that the file is non-trivial.
    const lineCount = projection.split(/\r?\n/).length;
    expect(lineCount, "AP projection should be substantial (rev-14 rewrite ≥ 300 lines)").toBeGreaterThan(300);
  });
});

describe("Mission Control integration sentinel · HR module coexistence", () => {
  it("Employee lifecycle service exports delete + archive + eligibility", () => {
    const employees = src("src/lib/hr/employees.ts");
    expect(employees).toMatch(/export async function archiveEmployee/);
    expect(employees).toMatch(/export async function deleteEmployee/);
    expect(employees).toMatch(/export async function getDeleteEligibility/);
    expect(employees).toMatch(/const LIFECYCLES = \[.*"ARCHIVED".*\]/);
  });

  it("Segmented start-date component + Position depends on Department (HR-2B.3.6)", () => {
    expect(() =>
      readFileSync(resolve(process.cwd(), "src/components/hr/SegmentedDateInput.tsx"), "utf8"),
    ).not.toThrow();
    const positions = src("src/lib/hr/employee-positions.ts");
    expect(positions).toMatch(/departmentId:\s*string;/);
  });

  it("Club.payrollProvince resolver (HR-2B.3.5) present", () => {
    expect(() =>
      readFileSync(resolve(process.cwd(), "src/lib/hr/club-payroll-province.ts"), "utf8"),
    ).not.toThrow();
  });

  it("Employee onboarding cookie path is '/' (HR-2B.3.4 fix)", () => {
    const sess = src("src/lib/hr/employee-onboarding-session.ts");
    expect(sess).toMatch(/path:\s*"\/"/);
  });

  it("Member profile exposes optional employeeLink (Member↔Employee cross-nav preserved)", () => {
    const memberView = src("src/components/members/MemberProfileView.tsx");
    expect(memberView).toMatch(/employeeLink\?:/);
    expect(memberView).toMatch(/data-testid="member-employee-(link|indicator)"/);
  });
});
