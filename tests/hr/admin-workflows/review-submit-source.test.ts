// HR-2B.5 §20-31, §46 — Real Review page + Submit source-contract.
//
// The Review page is entirely data-driven (server-fetched) with a
// small client-side attestation form. Behaviour is exercised by the
// submitSelfSessionToSubmitted integration test and the Playwright
// founder path; here we pin the presentation invariants at the
// source level.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("HR-2B.5 · Review page source-contract", () => {
  const page = src("src/app/hr/onboarding/review/page.tsx");
  const form = src("src/app/hr/onboarding/review/ReviewSubmitForm.tsx");
  const complete = src("src/app/hr/onboarding/complete/page.tsx");
  const actions = src("src/app/hr/onboarding/_hr2b5-actions.ts");
  const resolver = src("src/lib/hr/onboarding-continuation.ts");

  it("§21-26: renders every review group (About You / Employment / Payroll / Emergency / Documents / Portal)", () => {
    // testId props are passed to the local Section component, which
    // renders them as data-testid at runtime. The source-contract
    // check pins the prop values so a rename cannot silently drop a
    // section from the Playwright / a11y test surface.
    expect(page).toMatch(/testId="review-section-about-you"/);
    expect(page).toMatch(/testId="review-section-employment"/);
    expect(page).toMatch(/testId="review-section-payroll"/);
    expect(page).toMatch(/testId="review-section-emergency-contact"/);
    expect(page).toMatch(/testId="review-section-documents-credentials"/);
    expect(page).toMatch(/testId="review-section-employee-portal"/);
  });

  it("§23: shows masked payroll values only — no plaintext SIN, no bank number rehydration", () => {
    // Uses masked helpers exclusively.
    expect(page).toMatch(/getSelfSinMasked/);
    expect(page).toMatch(/getSelfBankAccountMasked/);
    expect(page).toMatch(/getSelfTaxProfileMasked/);
    // NO calls to reveal or plaintext helpers.
    expect(page).not.toMatch(/getSelfSinPlaintext/);
    expect(page).not.toMatch(/getSelfBankAccountReveal/);
  });

  it("§26: portal password renders as fixed masked bullets — never the hash", () => {
    expect(page).toMatch(/data-testid="review-portal-password-mask"/);
    // No hash prefix leakage anywhere on the page.
    expect(page).not.toMatch(/passwordHash/);
    expect(page).not.toMatch(/bcrypt/);
  });

  it("§27: attestation is a single client-side checkbox that gates the button", () => {
    expect(form).toMatch(/^"use client";/m);
    expect(form).toMatch(/data-testid="review-attestation-checkbox"/);
    expect(form).toMatch(/data-testid="review-submit-button"/);
    expect(form).toMatch(/disabled=\{!enabled/);
    // `enabled = canSubmit && attested`.
    expect(form).toMatch(/const enabled = canSubmit && attested/);
  });

  it("§28: readiness re-validation lives server-side in the transition service, not the route", () => {
    // The action delegates to transitionSelfSessionToSubmitted, which
    // re-checks the attestation ack + credential presence.
    expect(actions).toMatch(/transitionSelfSessionToSubmitted/);
    const selfService = src("src/lib/hr/employee-self-service.ts");
    expect(selfService).toMatch(/Final submission attestation is required before submit/);
    expect(selfService).toMatch(/Portal password must be set before submit/);
  });

  it("§29: SUBMITTED is not auto-APPROVED (Club review remains separate)", () => {
    const selfService = src("src/lib/hr/employee-self-service.ts");
    expect(selfService).toMatch(/data: \{ state: "SUBMITTED", submittedAt: now \}/);
    // Post-transition, no code sets APPROVED in the same path.
    expect(selfService).not.toMatch(/data: \{ state: "APPROVED"[^}]*\}[^]*transitionSelfSessionToSubmitted/);
  });

  it("§17 (again): corrections surface on the Review page as 'Correction requested'", () => {
    expect(page).toMatch(/Correction requested:/);
    expect(page).toMatch(/data-testid="review-corrections-notice"/);
    // Correction request does NOT mutate compensation — the review
    // page's compensation row reads from EmployeeCompensation, not
    // corrections. Verify the reader is used.
    expect(page).toMatch(/getSelfCurrentCompensation/);
  });

  it("§31: /complete page renders the portal handoff CTA, not a dead 'you\\'re done' screen", () => {
    expect(complete).toMatch(/data-testid="complete-continue-to-portal"/);
    expect(complete).toMatch(/href="\/employee\/login\/handoff-from-onboarding"/);
    expect(complete).toMatch(/Continue to your employee portal/);
    // Employee number surfaced on the terminal page too.
    expect(complete).toMatch(/data-testid="complete-employee-number"/);
  });

  it("resolver: SUBMITTED sessions land on /complete (not the payroll-section handoff)", () => {
    expect(resolver).toMatch(/return URLS\.submitted;/);
    expect(resolver).toMatch(/submitted: "\/hr\/onboarding\/complete"/);
  });

  it("submit action idempotence: re-hitting /review after submit routes to /complete", () => {
    // Two-layer session-state gate: the cookie-scoped priorSession
    // check runs first (routes SUBMITTED / APPROVED / REJECTED to
    // /complete before the actor resolver rejects the actor), and
    // the actor-scoped session check runs after as defence-in-depth.
    expect(page).toMatch(/priorSession\.state === "SUBMITTED"/);
    expect(page).toMatch(/session\.state === "SUBMITTED"/);
    expect(page).toMatch(/redirect\("\/hr\/onboarding\/complete"\)/);
  });
});
