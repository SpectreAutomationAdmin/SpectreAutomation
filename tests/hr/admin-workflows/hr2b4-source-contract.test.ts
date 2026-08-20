// HR-2B.4 (2026-08-19) — Source-contract regression pins for the
// Emergency + Documents & Credentials surfaces.
//
// A live-browser Playwright walk of these routes requires the raw
// invitation token, which HR-2A.1 fail-secure hardening intentionally
// keeps out of every admin surface. We pin the founder-contract
// surface at the source level here so a regression fails the build.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("HR-2B.4 · Emergency page source-contract", () => {
  const page = src("src/app/hr/onboarding/emergency/page.tsx");
  const actions = src("src/app/hr/onboarding/_hr2b4-actions.ts");

  it("uses the shared PostPayrollShell (rail + branding)", () => {
    expect(page).toMatch(/import PostPayrollShell/);
    expect(page).toMatch(/<PostPayrollShell/);
    expect(page).toMatch(/currentSection="emergency"/);
  });

  it("asks exactly the founder-approved three questions + optional email", () => {
    expect(page).toMatch(/Who should we contact in an emergency\?/);
    expect(page).toMatch(/What's their relationship to you\?/);
    expect(page).toMatch(/best phone number/);
    // Email must be present as OPTIONAL.
    expect(page).toMatch(/Email <span className="text-stone-400 text-xs">\(optional\)</);
  });

  it("submits to saveEmergencyContactAction (server action)", () => {
    expect(page).toMatch(/action=\{saveEmergencyContactAction\}/);
    expect(actions).toMatch(/export async function saveEmergencyContactAction/);
    expect(actions).toMatch(/submitSelfEmergencyContact/);
  });
});

describe("HR-2B.4 · Documents page source-contract", () => {
  const page = src("src/app/hr/onboarding/documents/page.tsx");
  const list = src("src/app/hr/onboarding/documents/DocumentsRequirementList.tsx");
  const actions = src("src/app/hr/onboarding/_hr2b4-actions.ts");

  it("resolves applicable requirements server-side (never inferred client-side)", () => {
    expect(page).toMatch(/resolveRequirementStatus/);
  });

  it("computes allRequiredSatisfied from server-side fulfilment", () => {
    expect(page).toMatch(/allRequiredSatisfied/);
    expect(page).toMatch(/filter\(\(r\) => r\.required\)[\s\S]*every\(\(r\) => r\.satisfied\)/);
  });

  it("no-requirements state renders 'You're all set here.' — never an empty form", () => {
    expect(list).toMatch(/You&apos;re all set here\./);
    expect(list).toMatch(/documents-empty-state/);
  });

  it("no requirement CODE is founder-visible — only displayName + explanation", () => {
    // The list must render req.displayName, NOT req.code.
    expect(list).toMatch(/data-testid=\{`requirement-name-\$\{req\.code\}`\}[\s\S]{0,300}\{req\.displayName\}/);
    // A stray `>{req.code}<` (raw code shown to the user) MUST NOT exist.
    expect(list).not.toMatch(/>\{req\.code\}</);
  });

  it("submits confirmation via server action to confirmRequirementAction", () => {
    expect(list).toMatch(/action=\{confirmRequirementAction\}/);
    expect(actions).toMatch(/export async function confirmRequirementAction/);
    expect(actions).toMatch(/confirmSelfRequirement/);
  });

  it("submits credential details via server action to saveCredentialDetailsAction", () => {
    expect(list).toMatch(/action=\{saveCredentialDetailsAction\}/);
    expect(actions).toMatch(/export async function saveCredentialDetailsAction/);
    expect(actions).toMatch(/submitSelfCredentialDetails/);
  });

  it("uploads stream to the canonical /api/hr/onboarding/self/requirement-document/upload endpoint", () => {
    expect(list).toMatch(/\/api\/hr\/onboarding\/self\/requirement-document\/upload/);
    // Explicit credentials:"same-origin" — same guard as HR-2B.3.4.
    expect(list).toMatch(/credentials:\s*"same-origin"/);
  });

  it("Continue button is DISABLED until all required requirements are satisfied", () => {
    expect(list).toMatch(/disabled=\{!allRequiredSatisfied\}/);
    expect(list).toMatch(/data-testid="documents-continue"/);
  });

  it("no fake Submit button anywhere — HR-2B.4 does not own final Submit", () => {
    expect(list).not.toMatch(/>Submit onboarding</);
    expect(list).not.toMatch(/>Submit</);
  });
});

describe("HR-2B.4 · Continuation resolver contract", () => {
  const resolver = src("src/lib/hr/onboarding-continuation.ts");

  it("routes Payroll-complete → Emergency when incomplete", () => {
    expect(resolver).toMatch(/if \(!emergencyDone\) return URLS\.emergency;/);
  });

  it("routes Emergency-complete → Documents when incomplete", () => {
    expect(resolver).toMatch(/if \(!documentsDone\) return URLS\.documents;/);
  });

  it("stops at readyForReview boundary (no fake Submit path in HR-2B.4)", () => {
    expect(resolver).toMatch(/return URLS\.readyForReview;/);
  });
});

describe("HR-2B.4 · Ready-for-review boundary source-contract", () => {
  const page = src("src/app/hr/onboarding/ready-for-review/page.tsx");

  it("does NOT expose a Submit button", () => {
    expect(page).not.toMatch(/>Submit</);
    expect(page).not.toMatch(/type="submit"[\s\S]{0,50}Submit/);
  });

  it("uses truthful copy — 'final review is coming next' — not fabricated completion", () => {
    expect(page).toMatch(/final review is coming next/i);
    expect(page).toMatch(/Your final review is coming next\./);
  });

  it("does defensive redirect to the true next incomplete step if landed early", () => {
    expect(page).toMatch(/resolveOnboardingContinuation/);
    expect(page).toMatch(/redirect\(next\)/);
  });
});

describe("HR-2B.4 · Admin config surface source-contract", () => {
  const page = src("src/app/app/admin/people/onboarding-requirements/page.tsx");
  const client = src("src/app/app/admin/people/onboarding-requirements/AdminOnboardingRequirementsClient.tsx");
  const nav = src("src/components/sidebar-nav-data.ts");

  it("lives under People navigation with hr:employee:write gate", () => {
    expect(nav).toMatch(/\/app\/admin\/people\/onboarding-requirements/);
    expect(nav).toMatch(/perm: "hr:employee:write"/);
  });

  it("admin page permission-gates on hr:employee:write", () => {
    expect(page).toMatch(/hasPermission\(principal, clubId, "hr:employee:write"\)/);
  });

  it("client posts create to canonical /api/hr/onboarding-requirements", () => {
    expect(client).toMatch(/fetch\("\/api\/hr\/onboarding-requirements"[\s\S]{0,80}method:\s*"POST"/);
  });

  it("client patch-toggles active state via /api/hr/onboarding-requirements/:id", () => {
    expect(client).toMatch(/fetch\(`\/api\/hr\/onboarding-requirements\/\$\{id\}`[\s\S]{0,80}method:\s*"PATCH"/);
  });
});
