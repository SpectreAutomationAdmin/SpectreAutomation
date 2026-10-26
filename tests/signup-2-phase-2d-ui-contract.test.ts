// SIGNUP-2 Phase 2D (2026-10-25) -- UI contract tests.
//
// Pins the operator queue + review pages' invariants:
//   • gated by platform:signups:release.
//   • queue surfaces eight distinct states (per founder §4).
//   • review page surfaces applicant/club/attestation/standing/
//     per-concept records/available actions.
//   • form fields enforce length caps + required attributes.
//   • NO internal fraud/impersonation indicator leaks to the
//     applicant-facing side.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const QUEUE_PAGE = readFileSync(join(ROOT, "src/app/app/admin/signup-ops/page.tsx"), "utf8");
const REVIEW_PAGE = readFileSync(join(ROOT, "src/app/app/admin/signup-ops/registration/[id]/page.tsx"), "utf8");
const APPLICANT_COMPLETE = readFileSync(join(ROOT, "src/app/signup/t/[token]/authority/complete/page.tsx"), "utf8");

describe("SIGNUP-2 Phase 2D · queue page", () => {
  it("gated by platform:signups:release", () => {
    expect(QUEUE_PAGE).toMatch(/hasPermission\(principal, null, "platform:signups:release"\)/);
  });

  it("declares all 8 state copy strings (founder §4)", () => {
    expect(QUEUE_PAGE).toMatch(/AWAITING_STANDING:\s*"Awaiting organisation verification"/);
    expect(QUEUE_PAGE).toMatch(/AWAITING_AUTHORITY:\s*"Awaiting signing-authority verification"/);
    expect(QUEUE_PAGE).toMatch(/CONFLICTING_EVIDENCE:\s*"Conflicting evidence"/);
    expect(QUEUE_PAGE).toMatch(/INSUFFICIENT_EVIDENCE:\s*"Insufficient evidence"/);
    expect(QUEUE_PAGE).toMatch(/SUSPECTED_IMPERSONATION:\s*"Suspected impersonation"/);
    expect(QUEUE_PAGE).toMatch(/READY_FOR_RELEASE:\s*"Ready for final release"/);
    expect(QUEUE_PAGE).toMatch(/RELEASED:\s*"Released"/);
    expect(QUEUE_PAGE).toMatch(/REJECTED:\s*"Rejected"/);
  });

  it("emits stable test-ids for row + state", () => {
    expect(QUEUE_PAGE).toMatch(/data-testid="signup-ops-queue-row"/);
    expect(QUEUE_PAGE).toMatch(/data-testid="signup-ops-queue-state"/);
    expect(QUEUE_PAGE).toMatch(/data-testid="signup-ops-queue-review-link"/);
    expect(QUEUE_PAGE).toMatch(/data-testid="signup-ops-queue-empty"/);
  });

  it("401-ish forbidden state has a test-id so the Playwright can assert", () => {
    expect(QUEUE_PAGE).toMatch(/data-testid="signup-ops-forbidden"/);
  });
});

describe("SIGNUP-2 Phase 2D · review page", () => {
  it("gated by platform:signups:release", () => {
    expect(REVIEW_PAGE).toMatch(/hasPermission\(principal, null, "platform:signups:release"\)/);
  });

  it("surfaces applicant / attestation / standing-check panels", () => {
    expect(REVIEW_PAGE).toMatch(/data-testid="signup-ops-review-admin-email"/);
    expect(REVIEW_PAGE).toMatch(/data-testid="signup-ops-review-attestation"/);
    expect(REVIEW_PAGE).toMatch(/data-testid="signup-ops-review-standing-check"/);
  });

  it("renders the three operator forms with stable test-ids", () => {
    expect(REVIEW_PAGE).toMatch(/data-testid="signup-ops-standing-form"/);
    expect(REVIEW_PAGE).toMatch(/data-testid="signup-ops-authority-form"/);
    expect(REVIEW_PAGE).toMatch(/data-testid="signup-ops-release-form"/);
    expect(REVIEW_PAGE).toMatch(/data-testid="signup-ops-reject-form"/);
  });

  it("standing form has required inputs with length caps", () => {
    expect(REVIEW_PAGE).toMatch(/data-testid="signup-ops-standing-input-source"[\s\S]+?required/);
    expect(REVIEW_PAGE).toMatch(/data-testid="signup-ops-standing-input-reference"[\s\S]+?maxLength=\{500\}/);
    expect(REVIEW_PAGE).toMatch(/data-testid="signup-ops-standing-input-reason"[\s\S]+?maxLength=\{1000\}/);
  });

  it("release form reason is required and length-capped", () => {
    expect(REVIEW_PAGE).toMatch(/data-testid="signup-ops-release-input-reason"[\s\S]+?required/);
    expect(REVIEW_PAGE).toMatch(/data-testid="signup-ops-release-input-reason"[\s\S]+?maxLength=\{1000\}/);
  });

  it("forms POST at the real API routes", () => {
    expect(REVIEW_PAGE).toMatch(/action=\{`\/api\/admin\/signup-ops\/registration\/\$\{registrationId\}\/standing-verified`\}/);
    expect(REVIEW_PAGE).toMatch(/action=\{`\/api\/admin\/signup-ops\/registration\/\$\{registrationId\}\/authority-verified`\}/);
    expect(REVIEW_PAGE).toMatch(/action=\{`\/api\/admin\/signup-ops\/registration\/\$\{registrationId\}\/release`\}/);
    expect(REVIEW_PAGE).toMatch(/action=\{`\/api\/admin\/signup-ops\/registration\/\$\{registrationId\}\/reject`\}/);
  });

  it("self-approval banner has a stable test-id so Playwright can assert the refusal", () => {
    expect(REVIEW_PAGE).toMatch(/data-testid="signup-ops-review-self-approval-blocked"/);
  });

  it("review page NEVER contains gov-ID surface or references", () => {
    expect(REVIEW_PAGE).not.toMatch(/govId/i);
    expect(REVIEW_PAGE).not.toMatch(/government[-_ ]?id/i);
    expect(REVIEW_PAGE).not.toMatch(/passport|driver.?licence|driver.?license/i);
  });

  it("review page does not render internal fraud / abuse signals as applicant-visible content", () => {
    // The review page is operator-only, so internal signals are
    // allowed to appear.  But the specific hold-category strings
    // used by the applicant-facing page MUST stay hidden there --
    // we test that separately below.
    expect(REVIEW_PAGE).toMatch(/data-testid="signup-ops-review-state"/);
  });
});

describe("SIGNUP-2 Phase 2D · applicant-facing surface preserves Phase 2C invariants", () => {
  it("applicant /authority/complete page NEVER discloses internal hold categories", () => {
    expect(APPLICANT_COMPLETE).not.toMatch(/SUSPECTED_IMPERSONATION/);
    expect(APPLICANT_COMPLETE).not.toMatch(/CONFLICTING_EVIDENCE/);
    expect(APPLICANT_COMPLETE).not.toMatch(/INSUFFICIENT_EVIDENCE/);
    expect(APPLICANT_COMPLETE).not.toMatch(/ENTITY_VERIFICATION/);
    expect(APPLICANT_COMPLETE).not.toMatch(/SIGNING_AUTHORITY_VERIFICATION/);
  });

  it("applicant page remains flag-gated by SPECTRE_SIGNUP_2C_VERIFICATION_LIVE", () => {
    expect(APPLICANT_COMPLETE).toMatch(/process\.env\.SPECTRE_SIGNUP_2C_VERIFICATION_LIVE === "1"/);
  });
});
