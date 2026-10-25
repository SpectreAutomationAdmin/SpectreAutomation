// SIGNUP-2 Phase 2C (2026-10-25) -- Verification pipeline source
// contract tests.
//
// Pins the orchestrator's architectural invariants:
//   • Single $transaction wrap of EntityStandingCheck.create +
//     SignupRegistration.update.
//   • Audit emission uses tails only -- no raw oid, no raw payload,
//     no PII.
//   • REJECT verdict transitions status to ABANDONED.
//   • Idempotent-replay guard (short-circuits on existing verdict).
//   • The pipeline reads classifier from the DB (never trusts
//     client inputs).
//   • Adapter errors route to MANUAL_REVIEW_REQUIRED (never silent
//     ACTIVE).
//   • The Phase 2B attestation POST calls the pipeline AFTER the
//     attestation persists (not before).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const PIPELINE = readFileSync(join(ROOT, "src/lib/signup/registration-verification.ts"), "utf8");
const ACCEPT_ROUTE = readFileSync(join(ROOT, "src/app/api/signup/authority/accept/route.ts"), "utf8");

describe("SIGNUP-2 Phase 2C · pipeline atomic write", () => {
  it("wraps EntityStandingCheck.create + SignupRegistration.update in a single $transaction", () => {
    expect(PIPELINE).toMatch(/prisma\.\$transaction\(async \(tx\) =>/);
    // Match the whole transaction body up to the matching close.
    // The outer `});` on its own line marks the end; the inner Prisma
    // calls each end in `}` so a non-greedy match stops too early.
    expect(PIPELINE).toMatch(/tx\.entityStandingCheck\.create/);
    expect(PIPELINE).toMatch(/tx\.signupRegistration\.update/);
    // Ensure they appear in that order within the single $transaction.
    const txIdx = PIPELINE.indexOf("$transaction(async (tx) =>");
    const checkIdx = PIPELINE.indexOf("tx.entityStandingCheck.create", txIdx);
    const updateIdx = PIPELINE.indexOf("tx.signupRegistration.update", txIdx);
    expect(checkIdx).toBeGreaterThan(txIdx);
    expect(updateIdx).toBeGreaterThan(checkIdx);
  });

  it("sets clubId=null on EntityStandingCheck (no Club shell exists in Phase 2C)", () => {
    expect(PIPELINE).toMatch(/clubId:\s*null,.*no Club shell exists/);
  });

  it("sets verificationDeciderUserId=null for automatic decisions (operator overrides are Phase 2H)", () => {
    expect(PIPELINE).toMatch(/verificationDeciderUserId:\s*null,.*automatic decision/);
  });

  it("REJECT verdict transitions status to ABANDONED", () => {
    expect(PIPELINE).toMatch(/verdict\.verdict === "REJECT".*ABANDONED/);
  });
});

describe("SIGNUP-2 Phase 2C · pipeline redaction + no PII", () => {
  it("buildRedactedRegistryPayload emits a Phase-2C-schema JSON string, NOT the raw adapter response", () => {
    expect(PIPELINE).toMatch(/schema:\s*"phase-2c\.v1"/);
    // The redaction comment is intentionally multi-line.  Match the
    // key phrase without pinning the exact wrapping.
    expect(PIPELINE).toMatch(/no raw registry fields/);
    expect(PIPELINE).toMatch(/no director names/);
  });

  it("audit meta carries only tails + classifier flags, NEVER raw oid or full ids", () => {
    const auditCall = PIPELINE.match(/action:\s*"signup\.verification\.decided"[\s\S]+?\}\s*\);/)![0];
    expect(auditCall).toMatch(/registrationIdTail/);
    expect(auditCall).toMatch(/jurisdiction/);
    expect(auditCall).toMatch(/verdict/);
    // Never includes raw oid or full hashes.
    expect(auditCall).not.toMatch(/\badminMicrosoftOid\b\s*:/);
    expect(auditCall).not.toMatch(/\bresumeTokenHash\b\s*:/);
  });

  it("logger.info calls do NOT include raw tokens / PII", () => {
    const logs = PIPELINE.match(/logger\.(?:info|warn|error)\([^)]*\)/g) ?? [];
    for (const l of logs) {
      expect(l).not.toMatch(/\btoken\b(?!Hash)/i);
      expect(l).not.toMatch(/\badminMicrosoftOid\b/);
      expect(l).not.toMatch(/\bresumeTokenHash\b/);
    }
  });
});

describe("SIGNUP-2 Phase 2C · pipeline idempotent-replay", () => {
  it("short-circuits if verificationVerdict is already set", () => {
    expect(PIPELINE).toMatch(/if \(reg\.verificationVerdict\)/);
    expect(PIPELINE).toMatch(/single-shot per registration/);
  });
});

describe("SIGNUP-2 Phase 2C · pipeline reads inputs server-side", () => {
  it("classifier read from DB field ownershipVerificationState (never trusted from client)", () => {
    expect(PIPELINE).toMatch(/ownershipVerificationState:\s*true/);
    expect(PIPELINE).toMatch(/normalizeClassifier\(reg\.ownershipVerificationState\)/);
  });

  it("adapter errors are caught and routed to MANUAL_REVIEW_REQUIRED (never silent ACTIVE)", () => {
    expect(PIPELINE).toMatch(/standing:\s*"MANUAL_REVIEW_REQUIRED"/);
    expect(PIPELINE).toMatch(/evidenceSource:\s*"adapter-crash"/);
  });

  it("impersonation hook reserved for future -- Phase 2C ships returning false", () => {
    expect(PIPELINE).toMatch(/async function lookupImpersonationFlag[\s\S]+?return false;/);
  });
});

describe("SIGNUP-2 Phase 2C · attestation POST wires the pipeline AFTER persist", () => {
  it("imports runRegistrationVerification dynamically after the attestation $transaction returns", () => {
    expect(ACCEPT_ROUTE).toMatch(/const \{ runRegistrationVerification \} = await import\("@\/lib\/signup\/registration-verification"\)/);
    expect(ACCEPT_ROUTE).toMatch(/await runRegistrationVerification\(/);
  });

  it("the pipeline-fire is placed AFTER the attestation $transaction + audit (not before)", () => {
    const persistIdx = ACCEPT_ROUTE.indexOf("subscriptionAuthorisationAttestation.create");
    const pipelineIdx = ACCEPT_ROUTE.indexOf("runRegistrationVerification(");
    expect(persistIdx).toBeGreaterThan(-1);
    expect(pipelineIdx).toBeGreaterThan(persistIdx);
  });

  it("a pipeline failure is caught + logged but does NOT fail the attestation acceptance", () => {
    const section = ACCEPT_ROUTE.match(/runRegistrationVerification[\s\S]+?Pipeline failures do NOT block/);
    expect(section).not.toBeNull();
  });
});

describe("SIGNUP-2 Phase 2C · pipeline does NOT create Phase-2G artefacts", () => {
  it("never creates ClubSubscription / Club / User / UserClubRole", () => {
    expect(PIPELINE).not.toMatch(/prisma\.clubSubscription\.create/);
    expect(PIPELINE).not.toMatch(/prisma\.club\.create/);
    expect(PIPELINE).not.toMatch(/prisma\.user\.create/);
    expect(PIPELINE).not.toMatch(/prisma\.userClubRole\.create/);
  });

  it("never calls Stripe", () => {
    expect(PIPELINE).not.toMatch(/stripe\./);
    expect(PIPELINE).not.toMatch(/@\/lib\/billing\/stripe/);
  });

  it("never writes accessTier anywhere", () => {
    expect(PIPELINE).not.toMatch(/accessTier\s*:/);
  });
});

describe("SIGNUP-2 Phase 2C · jurisdictionCodeForRegistration helper", () => {
  it("maps CA + 2-letter province to CA-XX", () => {
    expect(PIPELINE).toMatch(/if \(c === "CA" && p\.length === 2\) return `CA-\$\{p\}`/);
  });

  it("falls through to <country>-UNKNOWN for unmapped combinations (no silent default)", () => {
    expect(PIPELINE).toMatch(/`\$\{c \|\| "CA"\}-\$\{p \|\| "UNKNOWN"\}`/);
  });
});
