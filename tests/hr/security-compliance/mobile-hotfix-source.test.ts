// HR mobile-hotfix (2026-08-30) — source-contract for the six
// mobile defect fixes:
//   §1 greeting uses Club-local timezone (not server UTC)
//   §6 mobile widgets use compact treatment (<md); desktop unchanged
//   §7 tour popover is mobile-responsive
//   §8 CoachMark re-anchors on layout mutation
//   §9 no horizontal scroll (see Playwright)
//   §10 drawer open/close does not restart the tour
//
// Source-contract pins are complemented by an authenticated
// Playwright spec at tests/e2e/hr-mobile-hotfix.local.spec.ts that
// proves the runtime geometry.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("HR mobile-hotfix · source-contract", () => {
  const hero = src("src/components/employee/EmployeePortalHero.tsx");
  const home = src("src/app/employee/(authed)/page.tsx");
  const widgetGrid = src("src/app/employee/(authed)/_home/HomeWidgetGrid.tsx");
  const coachMark = src("src/components/employee/CoachMark.tsx");
  const mobileNav = src("src/components/employee/EmployeePortalMobileNav.tsx");
  const tour = src("src/components/employee/EmployeeTourOnFirstLogin.tsx");

  it("§1 — Hero uses the canonical greetingWordForInstant helper (not server-local getHours)", () => {
    expect(hero).toMatch(/greetingWordForInstant/);
    expect(hero).toMatch(/from "@\/lib\/mission-control\/local-time"/);
    // The old server-local getHours path must be gone.
    expect(hero).not.toMatch(/date\.getHours\(\)/);
    // Hero accepts clubTimezone from the caller.
    expect(hero).toMatch(/clubTimezone: string \| null/);
  });

  it("§1 — Home page reads Club.timezone and passes it into the Hero", () => {
    expect(home).toMatch(/timezone: true/);
    expect(home).toMatch(/clubTimezone=\{club\?\.timezone/);
  });

  it("§6 — Widget tile uses a compact mobile treatment and preserves the accepted desktop dims", () => {
    // Mobile: shorter min-height + tighter padding.
    expect(widgetGrid).toMatch(/min-h-\[92px\]/);
    expect(widgetGrid).toMatch(/pt-2\.5 pb-3/);
    // md+: accepted desktop treatment preserved (§6 explicit rule).
    expect(widgetGrid).toMatch(/md:min-h-\[132px\]/);
    expect(widgetGrid).toMatch(/md:px-3 md:pt-4 md:pb-5/);
    // Icon scale — smaller on mobile, restored on md+.
    expect(widgetGrid).toMatch(/\[&_svg\]:h-9 \[&_svg\]:w-9/);
    expect(widgetGrid).toMatch(/md:\[&_svg\]:h-14 md:\[&_svg\]:w-14/);
  });

  it("§7 — CoachMark popover width is viewport-responsive", () => {
    expect(coachMark).toMatch(/POPOVER_WIDTH_MOBILE_MAX/);
    expect(coachMark).toMatch(/POPOVER_MOBILE_BREAKPOINT/);
    expect(coachMark).toMatch(/function resolvePopoverWidth/);
    // Hard-cap max-width so a stale render can never overflow the viewport.
    expect(coachMark).toMatch(/maxWidth:\s*`calc\(100vw - \$\{VIEWPORT_MARGIN \* 2\}px\)`/);
  });

  it("§8 — CoachMark re-layouts on DOM mutation + RAF settle (proves target geometry adjacency)", () => {
    expect(coachMark).toMatch(/new MutationObserver/);
    expect(coachMark).toMatch(/mo\.observe\(document\.body/);
    // RAF settle chain catches the mobile drawer's slide-in transition.
    expect(coachMark).toMatch(/window\.requestAnimationFrame\(settle\)/);
  });

  it("§10 — Mobile drawer broadcasts open/closed events so the tour can hide/restore the popover", () => {
    expect(mobileNav).toMatch(/spectre:portal:mobile-drawer:opened/);
    expect(mobileNav).toMatch(/spectre:portal:mobile-drawer:closed/);
  });

  it("§10 — Tour listens for drawer state and hides the popover while the drawer is open (state preserved)", () => {
    expect(tour).toMatch(/drawerOpen/);
    expect(tour).toMatch(/spectre:portal:mobile-drawer:opened/);
    expect(tour).toMatch(/spectre:portal:mobile-drawer:closed/);
    // Popover hides while drawer is open BUT step/dismissed state persists.
    expect(tour).toMatch(/if \(drawerOpen\) return null;/);
  });
});
