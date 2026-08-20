// HR-2B.5 blocker regression source-contract (2026-08-20).
//
// Pins the fix for the founder-reported "stuck at /payroll/complete
// with disabled Continue (available soon)" defect. If any future
// change reintroduces a hard-coded transition to the obsolete
// /payroll/complete boundary, or brings back the disabled dead-end
// button, this suite fails.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("HR-2B.5 blocker · /payroll/complete forward-router", () => {
  const complete = src("src/app/hr/onboarding/payroll/complete/page.tsx");

  it("is a pure forward-router (no dead-end article, no disabled button)", () => {
    expect(complete).toMatch(/resolveOnboardingContinuation/);
    expect(complete).toMatch(/redirect\(next\)/);
    // The header comment MAY mention the historical defect. What
    // matters is that no <button ...disabled...> renders and no
    // literal JSX/HTML "available soon" string is emitted. Strip
    // comments before asserting.
    const stripComments = complete
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripComments).not.toMatch(/available soon/i);
    expect(stripComments).not.toMatch(/<button[^>]*disabled/i);
  });

  it("loops-back guard routes to /session if resolver ever returns this URL", () => {
    expect(complete).toMatch(/if \(next === "\/hr\/onboarding\/payroll\/complete"\)/);
    expect(complete).toMatch(/redirect\("\/hr\/onboarding\/session"\)/);
  });
});

describe("HR-2B.5 blocker · /payroll/review Continue routes through canonical resolver", () => {
  const review = src("src/app/hr/onboarding/payroll/review/page.tsx");

  it("Continue link points at /hr/onboarding/session (not /payroll/complete)", () => {
    // The button is a Link to /session so the resolver decides where
    // the employee actually goes next.
    expect(review).toMatch(/href="\/hr\/onboarding\/session"/);
    expect(review).not.toMatch(/href="\/hr\/onboarding\/payroll\/complete"/);
  });

  it("button copy is a neutral 'Continue' (not 'Complete Payroll' → dead-end)", () => {
    // Founder brief §4 — no phase-boundary language on the button.
    // The 'Continue' verb was the intent, coupled with resolver
    // routing. Strip comments so the assertion only inspects
    // user-visible JSX.
    const stripComments = review
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripComments).toMatch(/>[\s]*Continue[\s]*</);
    expect(stripComments).not.toMatch(/Complete Payroll/);
  });
});

describe("HR-2B.5 blocker · Provincial TD1 attest action routes through resolver", () => {
  const actions = src("src/app/hr/onboarding/payroll/_actions.ts");

  it("attest-provincial post-save redirects via resolveOnboardingContinuation", () => {
    expect(actions).toMatch(/resolveOnboardingContinuation/);
    // The final redirect in the file uses the resolver output, not a
    // hard-coded /payroll/review URL.
    expect(actions).toMatch(/const next = await resolveOnboardingContinuation/);
    expect(actions).toMatch(/redirect\(next\);/);
  });
});

describe("HR-2B.5 blocker · resolver docstring RETIRED payrollComplete", () => {
  const resolver = src("src/lib/hr/onboarding-continuation.ts");

  it("resolver never emits URLS.payrollComplete (docstring updated + no return sites)", () => {
    // The URL constant remains for bookmark forwarding, but the
    // resolver's own return sites use URLS.submitted / URLS.expired /
    // URLS.emergency / etc. There should be NO `return URLS.payrollComplete;`.
    expect(resolver).not.toMatch(/return URLS\.payrollComplete/);
  });

  it("resolver docstring documents the retirement", () => {
    expect(resolver).toMatch(/HR-2B\.5 blocker fix|RETIRED/i);
  });
});
