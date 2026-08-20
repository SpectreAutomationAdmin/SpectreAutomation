// HR-2B.5 §17-18, §44 — Employment correction UI must be gated on
// outcome=needs_correction, and per-field correction inputs must be
// gated on their own checkbox.
//
// The employment step is a server component that hydrates data + hands
// it off to a client component. Source-contract regressions here are
// the fastest way to pin these UX invariants; the live behaviour is
// covered by the Playwright founder path.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("HR-2B.5 · Employment correction conditional UI", () => {
  const form = src("src/app/hr/onboarding/about-you/employment/EmploymentConfirmationForm.tsx");
  const page = src("src/app/hr/onboarding/about-you/employment/page.tsx");

  it("form is a client component", () => {
    expect(form).toMatch(/^"use client";/m);
  });

  it("correction section is gated on outcome === 'needs_correction'", () => {
    // The condition is `showCorrectionSection = outcome === "needs_correction"`
    // and the section renders inside `{showCorrectionSection && (`.
    expect(form).toMatch(/showCorrectionSection\s*=\s*outcome\s*===\s*"needs_correction"/);
    expect(form).toMatch(/\{showCorrectionSection && \(/);
  });

  it("per-field text input is gated on that field's checkbox being checked", () => {
    // Each row wraps its <input type="text"> in `{checked && (`.
    expect(form).toMatch(/\{checked && \(/);
    expect(form).toMatch(/data-testid={`correction-value-wrapper-\$\{f\.field\}`}/);
  });

  it("default outcome is 'correct' unless the employee already recorded a correction", () => {
    // Preserves user-in-the-loop behaviour: revisiting after a correction
    // starts you back where you left off, not on the happy path.
    expect(form).toMatch(/useState<"correct" \| "needs_correction">\(\s*hadCorrection \? "needs_correction" : "correct"/s);
  });

  it("all four correctable fields still map to the persistence keys the server action expects", () => {
    // The server action `confirmEmploymentAction` reads
    // `correction:<field>:enabled` and `correction:<field>:value`
    // from FormData. If the client renames these, corrections stop
    // persisting.
    expect(page).toMatch(/positionId/);
    expect(page).toMatch(/departmentId/);
    expect(page).toMatch(/employmentType/);
    expect(page).toMatch(/expectedStartDate/);
    expect(form).toMatch(/`correction:\$\{f\.field\}:enabled`/);
    expect(form).toMatch(/`correction:\$\{f\.field\}:value`/);
  });

  it("radio copy matches founder brief §17", () => {
    // "Yes, everything looks right" — verbatim founder copy.
    expect(form).toMatch(/Yes, everything looks right/);
    expect(form).toMatch(/Something needs correcting/);
  });

  it("field-picker header matches founder brief §18", () => {
    expect(form).toMatch(/What needs correcting\?/);
  });

  it("action prop is passed from the server page (server-action reuse preserved)", () => {
    expect(page).toMatch(/action=\{confirmEmploymentAction\}/);
    expect(form).toMatch(/action: \(formData: FormData\) => Promise<void> \| void/);
  });
});
