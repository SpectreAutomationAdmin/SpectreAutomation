// HR mobile-hotfix (2026-08-25) — source-contract pins for the
// email-based Employee Portal login. Prevents a future refactor from
// silently reintroducing employeeNumber-based login copy or removing
// the neutral / capability-scoped ambiguity handling.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}
function code(rel: string): string {
  return src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("HR mobile-hotfix · portal login is now email-based (source pins)", () => {
  const loginPage      = src("src/app/employee/login/page.tsx");
  const loginForm      = src("src/app/employee/login/EmployeeLoginForm.tsx");
  const loginAction    = code("src/app/employee/_login-actions.ts");
  const credService    = code("src/lib/hr/employee-portal-credential.ts");
  const portalPwPage   = src("src/app/hr/onboarding/portal-password/page.tsx");
  const completePage   = src("src/app/hr/onboarding/complete/page.tsx");

  it("login page copy: 'Sign in with your email address.' (not employee number)", () => {
    expect(loginPage).toMatch(/Sign in with your email address\./);
    expect(loginPage).not.toMatch(/Sign in with your employee number\./);
  });

  it("login form: email input (type=email, autocomplete=username) — no employeeNumber input", () => {
    expect(loginForm).toMatch(/name="email"/);
    expect(loginForm).toMatch(/type="email"/);
    expect(loginForm).toMatch(/autoComplete="username"/);
    expect(loginForm).toMatch(/data-testid="employee-login-email"/);
    // Regression pin — the old employee-number input must not exist.
    expect(loginForm).not.toMatch(/name="employeeNumber"/);
    expect(loginForm).not.toMatch(/data-testid="employee-login-number"/);
  });

  it("login action: consumes formData.email (not employeeNumber) + calls verifyPortalPasswordByEmail", () => {
    expect(loginAction).toMatch(/formData\.get\("email"\)/);
    expect(loginAction).not.toMatch(/formData\.get\("employeeNumber"\)/);
    expect(loginAction).toMatch(/verifyPortalPasswordByEmail/);
    // Regression pin — the platform-host bail is gone; a null
    // hostClubId is a legitimate origin (email lookup spans Clubs
    // with neutral ambiguity handling).
    expect(loginAction).not.toMatch(/Sign in is not available at this address/);
  });

  it("login action: normalises email at the boundary (normaliseLoginEmail)", () => {
    expect(loginAction).toMatch(/normaliseLoginEmail/);
  });

  it("login action: neutral failure message covers BOTH not_recognised and ambiguous_across_clubs (same audit shape)", () => {
    expect(loginAction).toMatch(/NEUTRAL_LOGIN_FAILURE/);
    // Ambiguous-Club handling is present.
    expect(loginAction).toMatch(/ambiguous_across_clubs/);
    // Audit entity id is the hashed email (never raw email; never
    // discriminates between failure kinds in the caller-visible
    // response).
    expect(loginAction).toMatch(/entityId:\s*`hash:\$\{hashEmail\(email\)\}`/);
  });

  it("credential service: exports normaliseLoginEmail + verifyPortalPasswordByEmail", () => {
    expect(credService).toMatch(/export function normaliseLoginEmail/);
    expect(credService).toMatch(/export async function verifyPortalPasswordByEmail/);
    // Result type distinguishes success / not_recognised / ambiguous_across_clubs.
    expect(credService).toMatch(/kind:\s*"success"/);
    expect(credService).toMatch(/kind:\s*"not_recognised"/);
    expect(credService).toMatch(/kind:\s*"ambiguous_across_clubs"/);
    // Bcrypt dummy compare on every failure path — timing discipline.
    expect(credService).toMatch(/DUMMY_HASH/);
  });

  it("credential service: preserves AccountLock semantics (5→15min, 10→60min)", () => {
    // Regression pin — the lockout escalation ladder is unchanged.
    expect(credService).toMatch(/if \(next >= 10\)/);
    expect(credService).toMatch(/60 \* 60 \* 1000/);
    expect(credService).toMatch(/if \(next >= 5\)/);
    expect(credService).toMatch(/15 \* 60 \* 1000/);
  });

  it("portal-password onboarding: employee number is displayed but NOT called the username", () => {
    // The "your permanent username" copy has been removed.
    expect(portalPwPage).not.toMatch(/permanent username/);
    // The new copy explicitly separates payroll-record vs portal sign-in.
    expect(portalPwPage).toMatch(/For payroll and Club records/);
    expect(portalPwPage).toMatch(/sign in to the Employee Portal using your email/);
  });

  it("post-submit complete page: sign-in copy references email, not employee number", () => {
    expect(completePage).toMatch(/Sign in any time using your email/);
    expect(completePage).not.toMatch(/Sign in any time using your\s+employee number/);
    // Employee-number card retained but disclaimed.
    expect(completePage).toMatch(/data-testid="complete-employee-number"/);
    expect(completePage).toMatch(/not your portal sign-in/);
  });

  it("write paths lowercase personalEmail (portable case-insensitive login lookup)", () => {
    const employees = code("src/lib/hr/employees.ts");
    const selfSvc = code("src/lib/hr/employee-self-service.ts");
    // createEmployee + updateEmployee + updateSelfIdentity all lowercase.
    expect(employees).toMatch(/input\.personalEmail\.trim\(\)\.toLowerCase\(\)/);
    // Self-service normalises via a single line — accept either the
    // helper form or an inline .toLowerCase() in the branch.
    expect(selfSvc).toMatch(/value\.toLowerCase\(\)/);
  });
});
