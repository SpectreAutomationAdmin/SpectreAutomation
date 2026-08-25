// HR-2C §6-9, §45-46, §48 — Anchored guided tour source-contract.
//
// The tour's live positioning is exercised by Playwright in slice C1.
// These pins guard the source shape so the anchor/replay invariants
// can't silently regress.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("HR-2C · Anchored guided tour + replay", () => {
  const coachMark = src("src/components/employee/CoachMark.tsx");
  const tour = src("src/components/employee/EmployeeTourOnFirstLogin.tsx");
  // HR-2C Portal Refinement (2026-08-24, founder-accepted): Help and
  // "Take the portal tour" moved OUT of a standalone menu and INTO
  // the account dropdown on EmployeePortalUserMenu. The Help/tour
  // affordances now live there; test both against the UserMenu.
  const userMenu = src("src/components/employee/EmployeePortalUserMenu.tsx");
  const topBar = src("src/components/employee/EmployeePortalTopBar.tsx");
  const sidebar = src("src/components/employee/EmployeePortalSidebar.tsx");
  const nav = src("src/components/sidebar-nav-data.ts");
  const trainingLanding = src("src/app/employee/(authed)/safety-training/page.tsx");

  it("CoachMark is a client component using portal + getBoundingClientRect (no third-party lib)", () => {
    expect(coachMark).toMatch(/^"use client";/m);
    expect(coachMark).toMatch(/createPortal/);
    expect(coachMark).toMatch(/getBoundingClientRect/);
    expect(coachMark).toMatch(/useLayoutEffect/);
    // No third-party positioning library imported.
    expect(coachMark).not.toMatch(/@floating-ui|@radix-ui|@headlessui/);
  });

  it("CoachMark scrolls the target into view + re-lays out on scroll/resize", () => {
    expect(coachMark).toMatch(/scrollIntoView/);
    expect(coachMark).toMatch(/addEventListener\("scroll"/);
    expect(coachMark).toMatch(/addEventListener\("resize"/);
  });

  it("CoachMark viewport-clamps + tries multiple sides", () => {
    expect(coachMark).toMatch(/calcPlacement/);
    expect(coachMark).toMatch(/function fits/);
    expect(coachMark).toMatch(/clamp\(forced\.top/);
  });

  it("Tour is anchored (uses CoachMark for every step), NOT fixed bottom-right (§7)", () => {
    expect(tour).toMatch(/import CoachMark/);
    expect(tour).toMatch(/<CoachMark[\s\S]{0,200}targetSelector=/);
    // No lingering `fixed bottom-6 right-6` shell.
    expect(tour).not.toMatch(/fixed bottom-6 right-6/);
  });

  it("Tour includes Safety & Training step (§45)", () => {
    expect(tour).toMatch(/title: "Safety & Training"/);
    expect(tour).toMatch(/data-tour-target="training"/);
  });

  it("Welcome step anchors to the hero region, not bottom-right (§46)", () => {
    expect(tour).toMatch(/targetSelector: '\[data-testid="portal-hero"\]'/);
    // First step of STEPS is Welcome — verify it doesn't anchor to a nav testid.
    const stepsBlock = tour.slice(tour.indexOf("const STEPS"), tour.indexOf("interface Props"));
    expect(stepsBlock).toMatch(/Welcome to your employee portal[\s\S]{0,400}portal-hero/);
  });

  it("Tour step ordering matches the accepted HR-2C Home refinement (Welcome → widget-anchored steps → Profile)", () => {
    // HR-2C Home + Portal Refinement (2026-08-24, founder-accepted):
    // Tour anchors moved from sidebar nav items to the Home widget
    // grid because the widgets ARE the primary launchers now.
    // Accepted ordering:
    //   Welcome → Scheduling → Clock In / Out → Paystubs → Time Off Requests → Forms → Safety & Training → Profile
    // (HR mobile-hotfix 2026-08-30 — Clock In / Out step added between
    // Scheduling and Paystubs.)
    const stepsBlock = tour.slice(tour.indexOf("const STEPS"), tour.indexOf("interface Props"));
    const labels = ["Welcome", "Scheduling", "Clock In / Out", "Paystubs", "Time Off Requests", "Forms", "Safety & Training", "Profile"];
    const positions = labels.map((label) => stepsBlock.indexOf(label));
    for (const [i, pos] of positions.entries()) {
      expect(pos, `tour step "${labels[i]}" missing`).toBeGreaterThan(-1);
    }
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]!);
    }
  });

  it("Tour advances past missing targets (§7 — mobile / hidden nav resilience)", () => {
    expect(tour).toMatch(/onTargetMissing=\{/);
    expect(tour).toMatch(/setStep\(\(n\) => n \+ 1\)/);
  });

  it("Replay affordance (§9): the account-menu 'Take the portal tour' item opens the tour with openOnMount, never resets timestamp", () => {
    // HR-2C Portal Refinement moved this replay affordance into the
    // EmployeePortalUserMenu dropdown alongside Help + Sign out.
    expect(userMenu).toMatch(/^"use client";/m);
    expect(userMenu).toMatch(/openOnMount/);
    expect(userMenu).toMatch(/data-testid="portal-user-menu-take-tour"/);
    // Replay MUST NOT call the tour-completed endpoint (would reset timestamp).
    expect(userMenu).not.toMatch(/api\/employee\/tour-completed/);
  });

  it("Help is wired into the account dropdown on the top bar (HR-2C Portal Refinement — no standalone Help button)", () => {
    // HR-2C Portal Refinement (2026-08-24, founder-accepted): the
    // standalone Help + Sign out buttons were removed from the top
    // bar and merged into the account dropdown so the portal
    // matches the workspace user-menu grammar.
    expect(topBar).toMatch(/import EmployeePortalUserMenu/);
    expect(topBar).toMatch(/<EmployeePortalUserMenu/);
    // The account menu itself carries the Help affordance.
    expect(userMenu).toMatch(/data-testid="portal-user-menu-help"/);
    // The removed standalone menu component must not be imported by
    // the top bar any more (guard against accidental reintroduction).
    expect(topBar).not.toMatch(/import EmployeePortalHelpMenu/);
  });

  it("Sidebar emits stable data-tour-target attributes (§8)", () => {
    expect(sidebar).toMatch(/data-tour-target=\{item\.tourTarget\}/);
  });

  it("EMPLOYEE_NAV ordering is Home → Profile (HR-2C Shell Refinement — operational surfaces became Home widgets)", () => {
    // HR-2C Shell Refinement (2026-08-24, founder-accepted): the
    // portal left nav is now Home + Profile only.
    const navBlock = nav.slice(nav.indexOf("EMPLOYEE_NAV"), nav.indexOf("EMPLOYEE_NAV") + 800);
    const labels = ["Home", "Profile"];
    const positions = labels.map((l) => navBlock.indexOf(`"${l}"`));
    for (const [i, pos] of positions.entries()) {
      expect(pos, `EMPLOYEE_NAV missing "${labels[i]}"`).toBeGreaterThan(-1);
    }
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]!);
    }
  });

  it("Safety & Training placeholder page has truthful empty state (§50 — no fake features)", () => {
    expect(trainingLanding).toMatch(/data-testid="portal-safety-training-empty"/);
    expect(trainingLanding).toMatch(/No training has been assigned to you yet/);
    // No developer language.
    const stripped = trainingLanding
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/coming (soon|in HR-)|Phase \d|TODO/i);
  });
});
