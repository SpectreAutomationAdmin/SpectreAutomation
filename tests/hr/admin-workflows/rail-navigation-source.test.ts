// HR-2B.3.6 (2026-08-19) — Onboarding rail navigation source-contract.
//
// A live browser walk of the rail requires the raw invitation token
// (HR-2A.1 keeps it out of every admin surface). We pin the founder
// invariants at the source level here so a regression fails the
// build before it reaches a browser:
//
//   * Both layouts pass `href` values ONLY based on canonical
//     completion state (`nameDone` / `contactDone` / …), NEVER based
//     on URL history or client-side heuristics.
//   * Future / incomplete steps never receive an `href`.
//   * The rail component exposes stage / sub-stage navigation
//     when a href is provided.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("HR-2B.3.6 · Rail navigation source-contract", () => {
  const aboutLayout = src("src/app/hr/onboarding/about-you/layout.tsx");
  const payrollLayout = src("src/app/hr/onboarding/payroll/layout.tsx");
  const rail = src("src/components/hr/OnboardingProgressRail.tsx");

  it("About-you layout gates every sub-step href on its `Done` boolean", () => {
    // Every href value must be the ternary `<subDone> ? "…" : undefined`.
    // No unconditional hrefs on sub-stages.
    for (const step of ["nameDone", "contactDone", "employmentDone", "photoDone"]) {
      const re = new RegExp(`href: ${step} \\? "/hr/onboarding/about-you/[a-z]+" : undefined`);
      expect(aboutLayout, `About-you rail must gate href on ${step}`).toMatch(re);
    }
  });

  it("Payroll layout gates every sub-step href on its `completion` boolean", () => {
    expect(payrollLayout).toMatch(/href: completion\.sin \? "\/hr\/onboarding\/payroll\/sin" : undefined/);
    expect(payrollLayout).toMatch(/href: completion\.banking \? "\/hr\/onboarding\/payroll\/direct-deposit" : undefined/);
    expect(payrollLayout).toMatch(/completion\.taxProfile && completion\.federalAttestation \? "\/hr\/onboarding\/payroll\/td1-federal" : undefined/);
    expect(payrollLayout).toMatch(/completion\.taxProfile && completion\.provincialAttestation \? "\/hr\/onboarding\/payroll\/td1-provincial" : undefined/);
  });

  it("Neither layout sends an href on future / incomplete stages (emergency / documents / review)", () => {
    for (const layout of [aboutLayout, payrollLayout]) {
      // Emergency / documents / review are the future placeholders.
      // Their config lines must not contain `href:`.
      const futureLine = /\{ key: "emergency", label: "Emergency"[^}]*\}/;
      const doc = /\{ key: "documents", label: "Documents"[^}]*\}/;
      const review = /\{ key: "review", label: "Review"[^}]*\}/;
      const futureMatch = layout.match(futureLine)?.[0] ?? "";
      const docMatch = layout.match(doc)?.[0] ?? "";
      const reviewMatch = layout.match(review)?.[0] ?? "";
      expect(futureMatch).not.toMatch(/href:/);
      expect(docMatch).not.toMatch(/href:/);
      expect(reviewMatch).not.toMatch(/href:/);
    }
  });

  it("OnboardingProgressRail renders a Link when a stage has href, a button when it has subStages, and a span otherwise", () => {
    // Guard against a rewrite that reintroduces info-only rendering.
    expect(rail).toMatch(/import Link from "next\/link"/);
    // Parent affordance branches must exist:
    expect(rail).toMatch(/parentNav \?/);
    expect(rail).toMatch(/hasSubs && !s\.future \?/);
    // Sub-stage renders as Link when href is set:
    expect(rail).toMatch(/subNav \?/);
    // Sub-stage carries a data-testid derived from sub.key — string
    // check avoids the escaping ambiguity of a template-literal regex.
    expect(rail.includes("onboarding-rail-sub-")).toBe(true);
  });

  it("Rail component uses server-supplied `done` — never CALLS URL / DOM / localStorage APIs", () => {
    // The comment header may mention these words as prohibitions; the
    // ban is on actual EXECUTABLE calls. Look for the tell-tale API
    // shapes: `localStorage.getItem(`, `window.location.`, etc.
    expect(rail).not.toMatch(/localStorage\.(get|set|remove)Item/);
    expect(rail).not.toMatch(/sessionStorage\.(get|set|remove)Item/);
    expect(rail).not.toMatch(/window\.location\.(href|pathname|search|hash)/);
    expect(rail).not.toMatch(/document\.referrer/);
  });
});

describe("HR-2B.3.6 · AddEmployeeForm source-contract", () => {
  const form = src("src/app/app/admin/people/employees/new/AddEmployeeForm.tsx");
  const page = src("src/app/app/admin/people/employees/new/page.tsx");

  it("Position select is disabled when no Department is chosen", () => {
    // The disabled branch pins the founder invariant.
    expect(form).toMatch(/!selectedDepartmentId \?/);
    expect(form).toMatch(/Select a department first/);
    expect(form).toMatch(/disabled/);
  });

  it("Position options filter by `selectedDepartmentId`", () => {
    expect(form).toMatch(/filteredPositions/);
    expect(form).toMatch(/positions\.filter\(\(p\) => p\.departmentId === selectedDepartmentId\)/);
  });

  it("Changing Department clears the Position via useEffect", () => {
    expect(form).toMatch(/useEffect\(/);
    expect(form).toMatch(/setSelectedPositionId\(""\)/);
  });

  it("Inline Add Position POSTs `departmentId: selectedDepartmentId`", () => {
    expect(form).toMatch(/departmentId: selectedDepartmentId/);
  });

  it("Uses the SegmentedDateInput for expected start date (not the native `<input type=\"date\">`)", () => {
    expect(form).toMatch(/import SegmentedDateInput/);
    expect(form).toMatch(/<SegmentedDateInput/);
    // Native date input MUST NOT be present for expectedStartDate.
    expect(form).not.toMatch(/type="date"/);
  });

  it("Page loader passes departmentId on each position option", () => {
    expect(page).toMatch(/departmentId: p\.departmentId/);
    expect(page).toMatch(/departmentId: true/);
  });
});
