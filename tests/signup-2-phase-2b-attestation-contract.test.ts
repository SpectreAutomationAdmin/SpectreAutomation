// SIGNUP-2 Phase 2B (2026-10-25) -- Attestation API contract tests.
// Source-contract tests only; no DB.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const API = readFileSync(join(ROOT, "src/app/api/signup/authority/accept/route.ts"), "utf8");
const PAGE = readFileSync(join(ROOT, "src/app/signup/t/[token]/authority/page.tsx"), "utf8");
const COMPLETE = readFileSync(join(ROOT, "src/app/signup/t/[token]/authority/complete/page.tsx"), "utf8");

describe("SIGNUP-2 Phase 2B · attestation API fail-closed gates", () => {
  it("Feature flag SPECTRE_SIGNUP_2B_ATTESTATION_LIVE is required (fail-closed by default)", () => {
    expect(API).toMatch(/assertAttestationCanProceed/);
  });

  it("Imports from the ToS helper (not inline file reads)", () => {
    expect(API).toMatch(/from "@\/lib\/billing\/terms-of-service"/);
  });

  it("Development-fixture ToS is explicitly rejected via APPROVED-status check", () => {
    const TOS = readFileSync(join(ROOT, "src/lib/billing/terms-of-service.ts"), "utf8");
    expect(TOS).toMatch(/doc\.status !== "APPROVED"/);
    expect(TOS).toMatch(/doc\.label\.startsWith\("ToS-dev-fixture"\)/);
  });

  it("Attestation text is a top-level ATTESTATION_TEXT export, not inlined", () => {
    expect(API).toMatch(/export const ATTESTATION_TEXT = \[/);
  });
});

describe("SIGNUP-2 Phase 2B · attestation API input validation", () => {
  it("Rejects missing / malformed token", () => {
    expect(API).toMatch(/if \(!token\)/);
  });

  it("Rejects missing or malformed signatoryFullName with length bounds", () => {
    expect(API).toMatch(/signatoryFullName\.length < 2 \|\| signatoryFullName\.length > 200/);
  });

  it("Rejects missing or malformed signatoryTitle with length bounds", () => {
    expect(API).toMatch(/signatoryTitle\.length < 2 \|\| signatoryTitle\.length > 120/);
  });

  it("Requires confirmed=1 (the checkbox)", () => {
    expect(API).toMatch(/confirmed !== "1"/);
  });

  it("Rate-limits by IP + token-prefix", () => {
    expect(API).toMatch(/checkAuthRateLimit\("signup_authority_accept",/);
  });

  it("auth-guard.ts registers the signup_authority_accept bucket", () => {
    const G = readFileSync(join(ROOT, "src/lib/security/auth-guard.ts"), "utf8");
    expect(G).toMatch(/"signup_authority_accept"/);
  });
});

describe("SIGNUP-2 Phase 2B · attestation API server-side identity (no client trust)", () => {
  it("Resolves Microsoft identity from the DB row, NOT from the form payload", () => {
    expect(API).toMatch(/acceptedByMicrosoftOid:\s*reg\.adminMicrosoftOid/);
    expect(API).toMatch(/acceptedByMicrosoftTid:\s*reg\.adminMicrosoftTenantId/);
  });

  it("Rejects a registration whose adminVerifiedAt is unset", () => {
    expect(API).toMatch(/if \(!reg\.adminVerifiedAt \|\| !reg\.adminMicrosoftOid \|\| !reg\.adminMicrosoftTenantId\)/);
  });

  it("Rejects an ABANDONED registration", () => {
    expect(API).toMatch(/if \(reg\.status === "ABANDONED"\)/);
  });

  it("Does NOT read Microsoft identity from the form body", () => {
    expect(API).not.toMatch(/form\.get\("adminMicrosoftOid"/);
    expect(API).not.toMatch(/form\.get\("microsoftTenantId"/);
    expect(API).not.toMatch(/form\.get\("acceptedByMicrosoftOid"/);
  });

  it("Does NOT accept a client-supplied clubLegalName (it comes from reg.legalName)", () => {
    expect(API).toMatch(/clubLegalName:\s*reg\.legalName/);
    expect(API).not.toMatch(/form\.get\("clubLegalName"/);
  });

  it("Does NOT accept a client-supplied ToS version hash (it is computed server-side)", () => {
    expect(API).toMatch(/termsVersionSha256:\s*doc\.sha256/);
    expect(API).not.toMatch(/form\.get\("termsVersionSha256"/);
    expect(API).not.toMatch(/form\.get\("termsVersion"/);
  });

  it("Does NOT accept a client-supplied attestation text hash", () => {
    expect(API).toMatch(/attestationTextHash\s*=\s*createHash\("sha256"\)\.update\(ATTESTATION_TEXT/);
    expect(API).not.toMatch(/form\.get\("attestationTextHash"/);
  });
});

describe("SIGNUP-2 Phase 2B · attestation API idempotency + transaction", () => {
  it("Idempotent-replay check reads existing attestation by signupRegistrationId", () => {
    expect(API).toMatch(/subscriptionAuthorisationAttestation\.findUnique\({\s*where:\s*{\s*signupRegistrationId:\s*reg\.id\s*}/);
    expect(API).toMatch(/if \(existing\)/);
    expect(API).toMatch(/signup\.authority\.accept\.replay/);
  });

  it("Create + step transition are wrapped in prisma.$transaction", () => {
    expect(API).toMatch(/prisma\.\$transaction\(async \(tx\) =>/);
    expect(API).toMatch(/tx\.subscriptionAuthorisationAttestation\.create/);
    expect(API).toMatch(/tx\.signupRegistration\.update/);
  });

  it("Step transitions to AUTHORITY_ACCEPTED (additive; legacy steps preserved)", () => {
    expect(API).toMatch(/step:\s*"AUTHORITY_ACCEPTED"/);
  });

  it("Audit emission for the accept event", () => {
    expect(API).toMatch(/audit\(null, {\s*action:\s*"signup\.authority\.accepted"/);
  });

  it("Audit meta carries only tails + labels, NOT raw secrets or full oid", () => {
    const auditBlock = API.match(/action:\s*"signup\.authority\.accepted"[\s\S]+?}\s*\);/);
    expect(auditBlock, "audit() call block not found").not.toBeNull();
    expect(auditBlock![0]).toMatch(/registrationIdTail/);
    expect(auditBlock![0]).toMatch(/termsVersionSha256Tail/);
    expect(auditBlock![0]).toMatch(/acceptedByMicrosoftOidTail/);
    expect(auditBlock![0]).not.toMatch(/\badminMicrosoftOid\b\s*:/);  // no raw oid in meta
  });
});

describe("SIGNUP-2 Phase 2B · attestation API Phase-2G isolation", () => {
  it("Does NOT create any ClubSubscription row in Phase 2B", () => {
    expect(API).not.toMatch(/clubSubscription\.create\(/);
    expect(API).not.toMatch(/clubSubscription\.upsert\(/);
  });

  it("Writes clubId=null on the attestation; Phase 2G backfills", () => {
    expect(API).toMatch(/clubId:\s*null/);
  });

  it("Does NOT write accessTier anywhere", () => {
    expect(API).not.toMatch(/accessTier\s*:/);
  });

  it("Does NOT create Users, Clubs, UserClubRoles, or welcome emails", () => {
    expect(API).not.toMatch(/prisma\.user\.create/);
    expect(API).not.toMatch(/prisma\.club\.create/);
    expect(API).not.toMatch(/prisma\.userClubRole\.create/);
    expect(API).not.toMatch(/sendResumeEmail\(/);
    expect(API).not.toMatch(/sendWelcomeEmail\(/);
  });

  it("Does NOT call Stripe", () => {
    expect(API).not.toMatch(/\bstripe\./);
    expect(API).not.toMatch(/@\/lib\/billing\/index/);
  });
});

describe("SIGNUP-2 Phase 2B · attestation UI gates", () => {
  it("Live form only renders when flag is 1 AND tosApproved", () => {
    expect(PAGE).toMatch(/process\.env\.SPECTRE_SIGNUP_2B_ATTESTATION_LIVE === "1"/);
    expect(PAGE).toMatch(/const formEnabled = live && tosApproved/);
  });

  it("Coming-soon banner has a stable test-id so Playwright can detect the disabled state", () => {
    expect(PAGE).toMatch(/data-testid="signup-authority-coming-soon"/);
  });

  it("Form elements have stable test-ids", () => {
    expect(PAGE).toMatch(/data-testid="signup-authority-form"/);
    expect(PAGE).toMatch(/data-testid="signup-authority-input-fullName"/);
    expect(PAGE).toMatch(/data-testid="signup-authority-input-title"/);
    expect(PAGE).toMatch(/data-testid="signup-authority-input-confirmed"/);
    expect(PAGE).toMatch(/data-testid="signup-authority-submit"/);
    expect(PAGE).toMatch(/data-testid="signup-authority-tos-label"/);
  });

  it("The /complete sibling renders a non-dead-end receipt + no automatic forward progression", () => {
    expect(COMPLETE).toMatch(/data-testid="signup-authority-receipt"/);
    expect(COMPLETE).not.toMatch(/redirect\(.*\/mandate/);
    expect(COMPLETE).not.toMatch(/redirect\(.*\/payment/);
  });

  it("Already-accepted step redirects to /complete before showing the form", () => {
    expect(PAGE).toMatch(/if \(reg\.step === "AUTHORITY_ACCEPTED"\)/);
    expect(PAGE).toMatch(/redirect\(`\/signup\/t\/\$\{encodeURIComponent\(params\.token\)\}\/authority\/complete`\)/);
  });
});

describe("SIGNUP-2 Phase 2B · status-page affordance", () => {
  const STATUS = readFileSync(join(ROOT, "src/app/signup/t/[token]/status/page.tsx"), "utf8");

  it("Continue-to-authorisation link is gated by the feature flag", () => {
    expect(STATUS).toMatch(/process\.env\.SPECTRE_SIGNUP_2B_ATTESTATION_LIVE === "1"/);
    expect(STATUS).toMatch(/data-testid="signup-status-authority-link"/);
  });

  it("Continue link requires adminVerifiedAt (never shown pre-identity)", () => {
    expect(STATUS).toMatch(/SPECTRE_SIGNUP_2B_ATTESTATION_LIVE === "1" && reg\.adminVerifiedAt/);
  });
});
