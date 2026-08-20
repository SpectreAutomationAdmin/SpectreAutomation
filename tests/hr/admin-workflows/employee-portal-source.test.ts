// HR-2B.5 §32-42, §45, §48 — Employee Portal source-contract.
//
// Pins the shell + auth boundary + tour invariants at the source level.
// Live behaviour is covered by the Playwright founder path in slice 8.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}
function exists(rel: string): boolean {
  return existsSync(resolve(process.cwd(), rel));
}

describe("HR-2B.5 · Employee Portal shell + routes", () => {
  const layout = src("src/app/employee/(authed)/layout.tsx");
  const sidebar = src("src/components/employee/EmployeePortalSidebar.tsx");
  const nav = src("src/components/sidebar-nav-data.ts");
  const home = src("src/app/employee/(authed)/page.tsx");
  const pay = src("src/app/employee/(authed)/pay/page.tsx");
  const schedule = src("src/app/employee/(authed)/schedule/page.tsx");
  const availability = src("src/app/employee/(authed)/availability/page.tsx");
  const documents = src("src/app/employee/(authed)/documents/page.tsx");
  const profile = src("src/app/employee/(authed)/profile/page.tsx");

  it("EMPLOYEE_NAV covers Home / Pay / Schedule / Availability / Safety & Training / Documents / Profile", () => {
    // HR-2C §5 added Safety & Training and refined ordering.
    for (const label of ["Home", "Pay", "Schedule", "Availability", "Safety & Training", "Documents", "Profile"]) {
      expect(nav).toContain(`label: "${label}"`);
    }
    // HR-2C widened the exported type to `Array<NavItem & { tourTarget?: string }>`
    // to carry the stable coach-mark anchor slug.
    expect(nav).toMatch(/EMPLOYEE_NAV: Array<NavItem & \{ tourTarget\?: string \}>/);
  });

  it("each portal route exists as a real page (no coming-soon copy)", () => {
    for (const p of ["pay", "schedule", "availability", "documents", "profile"]) {
      expect(exists(`src/app/employee/(authed)/${p}/page.tsx`)).toBe(true);
    }
    // No developer language.
    for (const body of [pay, schedule, availability]) {
      expect(body).not.toMatch(/coming in HR-|Phase \d|TODO|FIXME/i);
    }
  });

  it("§37: documents page filters SIN / void-cheque / resume categories", () => {
    expect(documents).toMatch(/NEVER_EMPLOYEE_VISIBLE/);
    expect(documents).toMatch(/void_cheque/);
    expect(documents).toMatch(/sin_scan/);
    expect(documents).toMatch(/resume/);
  });

  it("§38: profile does NOT expose compensation (per §14 sensitive-permission)", () => {
    expect(profile).not.toMatch(/getSelfCurrentCompensation|EmployeeCompensation|payRate|Hourly rate|Annual salary/);
  });

  it("§42: layout redirects to /employee/login on absent portal principal", () => {
    expect(layout).toMatch(/if \(!principal\) redirect\("\/employee\/login"\)/);
  });

  it("§42: terminated employees can't enter the portal", () => {
    expect(layout).toMatch(/TERMINATED/);
    expect(layout).toMatch(/redirect\("\/employee\/login\?err=/);
  });

  it("§32: sidebar uses club branding, never the word 'Spectre'", () => {
    expect(sidebar).not.toMatch(/"Spectre"/);
    expect(sidebar).not.toMatch(/Spectre Automation/);
    expect(layout).toMatch(/getActiveBranding/);
    expect(layout).toMatch(/clubName = club\.name/);
  });

  it("§33: home shows employee number + position + department + start date", () => {
    expect(home).toMatch(/employeeNumber/);
    expect(home).toMatch(/position/);
    expect(home).toMatch(/department/);
    expect(home).toMatch(/expectedStartDate|hireDate/);
  });
});

describe("HR-2B.5 · Employee Portal auth boundary (§6, §41-42)", () => {
  const sessionLib = src("src/lib/employee-portal-session.ts");
  const loginActions = src("src/app/employee/_login-actions.ts");
  const credentialLib = src("src/lib/hr/employee-portal-credential.ts");
  const nav = src("src/components/sidebar-nav-data.ts");

  it("uses a distinct cookie name (not the admin or onboarding cookie)", () => {
    expect(sessionLib).toMatch(/COOKIE_NAME = "spectre_employee_session"/);
    // Distinct from spectre_session (admin) and spectre_hr_onboarding (temporary).
    expect(sessionLib).not.toMatch(/"spectre_session"|"spectre_hr_onboarding"/);
  });

  it("EmployeePortalPrincipal is NOT a Principal (§6 no admin surface access)", () => {
    // The type is EmployeePortalPrincipal, not Principal. The layout
    // and the pages consume it directly — never through requirePermission
    // (which needs a real Principal).
    expect(sessionLib).toMatch(/export interface EmployeePortalPrincipal/);
    expect(sessionLib).not.toMatch(/import type \{ Principal \}/);
    expect(sessionLib).not.toMatch(/requirePermission/);
  });

  it("Employee Portal nav does NOT include admin surfaces", () => {
    expect(nav).toMatch(/EMPLOYEE_NAV[\s\S]{0,800}\]/);
    // Extract the EMPLOYEE_NAV block, roughly.
    const block = nav.slice(nav.indexOf("EMPLOYEE_NAV"), nav.indexOf("EMPLOYEE_NAV") + 800);
    expect(block).not.toContain("/app/admin");
    expect(block).not.toContain("Mission Control");
    expect(block).not.toContain("Finance");
    expect(block).not.toContain("AP");
  });

  it("verifyPortalPassword tenants on {clubId, employeeNumber} — no global lookup", () => {
    expect(credentialLib).toMatch(/where: \{ clubId: input\.clubId, employeeNumber: number \}/);
    expect(credentialLib).not.toMatch(/where: \{ employeeNumber:/);
  });

  it("login action resolves clubId from active branding (host-scoped, §8)", () => {
    expect(loginActions).toMatch(/getActiveBranding/);
    expect(loginActions).toMatch(/branding\.clubId/);
  });

  it("login action is rate-limited on hashed (clubId + employeeNumber)", () => {
    expect(loginActions).toMatch(/hashEmail\(`\$\{clubId\}:\$\{employeeNumber\}`\)/);
    expect(loginActions).toMatch(/consumeRate\("login"/);
  });

  it("login action never returns the password or hash to the client", () => {
    // The response is a redirect — nothing in the body. The error
    // channel only contains a neutral safe message via ?err=.
    expect(loginActions).not.toMatch(/passwordHash|bcrypt|password:\s*(rawPassword|password)/);
  });

  it("handoff-from-onboarding requires terminal session state + credential", () => {
    expect(loginActions).toMatch(/state === "SUBMITTED" \|\| session\.state === "APPROVED" \|\| session\.state === "REJECTED"/);
    expect(loginActions).toMatch(/if \(!credential\) redirect\("\/hr\/onboarding\/portal-password"\)/);
  });
});

describe("HR-2B.5 · First-login tour (§39-40, §48)", () => {
  const tour = src("src/components/employee/EmployeeTourOnFirstLogin.tsx");
  const home = src("src/app/employee/(authed)/page.tsx");
  const api = src("src/app/api/employee/tour-completed/route.ts");

  it("tour is a client component with Next / Back / Skip / Finish (§39)", () => {
    expect(tour).toMatch(/^"use client";/m);
    expect(tour).toMatch(/data-testid="portal-tour-next"/);
    expect(tour).toMatch(/data-testid="portal-tour-back"/);
    expect(tour).toMatch(/data-testid="portal-tour-skip"/);
    expect(tour).toMatch(/data-testid="portal-tour-finish"/);
  });

  it("tour is embedded on the Home page and gated on portalTourCompletedAt", () => {
    expect(home).toMatch(/import EmployeeTourOnFirstLogin/);
    // The employee row is loaded via `include` — `portalTourCompletedAt`
    // arrives as a default scalar, so the reference we pin is the
    // derivation of `tourAlreadyDone` from it.
    expect(home).toMatch(/portalTourCompletedAt !== null/);
    expect(home).toMatch(/alreadyDone=\{tourAlreadyDone\}/);
  });

  it("tour completion is persisted via /api/employee/tour-completed", () => {
    expect(api).toMatch(/portalTourCompletedAt: new Date\(\)/);
    expect(tour).toMatch(/\/api\/employee\/tour-completed/);
  });

  it("tour covers Pay / Schedule / Availability / Documents / Profile (§39)", () => {
    for (const label of ["Pay", "Schedule", "Availability", "Documents", "Profile"]) {
      expect(tour).toMatch(new RegExp(`title:\\s*"${label}"`));
    }
  });
});

describe("HR-2B.5 · Employee Portal brand shielding (feedback_member_brand_shielding)", () => {
  const login = readFileSync(resolve(process.cwd(), "src/app/employee/login/page.tsx"), "utf8");
  it("never emits the 'Spectre' wordmark on the login page", () => {
    // The fallback path when running on the platform host must use a
    // neutral label — never "Spectre".
    expect(login).toMatch(/branding\.mode === "club" && branding\.wordmark/);
    expect(login).toMatch(/\? branding\.wordmark[\s\S]{0,40}: "Your Club"/);
    expect(login).not.toMatch(/= *"Spectre"/);
  });
});
