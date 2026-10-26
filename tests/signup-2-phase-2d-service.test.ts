// SIGNUP-2 Phase 2D (2026-10-25) -- Service contract tests.
//
// Pins the operator-verification service invariants.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertPhase2dOperatorFlag, computeQueueState } from "@/lib/signup/operator-verification";

const ROOT = process.cwd();
const SERVICE = readFileSync(join(ROOT, "src/lib/signup/operator-verification.ts"), "utf8");

describe("SIGNUP-2 Phase 2D · fail-closed flag gate", () => {
  it("assertPhase2dOperatorFlag throws when flag is unset", () => {
    const prev = process.env.SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE;
    delete process.env.SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE;
    try {
      expect(() => assertPhase2dOperatorFlag()).toThrow(/disabled/i);
    } finally {
      if (prev === undefined) delete process.env.SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE;
      else process.env.SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE = prev;
    }
  });

  it("assertPhase2dOperatorFlag throws when flag is '0'", () => {
    const prev = process.env.SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE;
    process.env.SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE = "0";
    try {
      expect(() => assertPhase2dOperatorFlag()).toThrow(/disabled/i);
    } finally {
      if (prev === undefined) delete process.env.SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE;
      else process.env.SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE = prev;
    }
  });

  it("assertPhase2dOperatorFlag throws when flag is 'true' (only literal '1' passes)", () => {
    const prev = process.env.SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE;
    process.env.SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE = "true";
    try {
      expect(() => assertPhase2dOperatorFlag()).toThrow(/disabled/i);
    } finally {
      if (prev === undefined) delete process.env.SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE;
      else process.env.SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE = prev;
    }
  });

  it("assertPhase2dOperatorFlag passes when flag === '1'", () => {
    const prev = process.env.SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE;
    process.env.SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE = "1";
    try {
      expect(() => assertPhase2dOperatorFlag()).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE;
      else process.env.SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE = prev;
    }
  });
});

describe("SIGNUP-2 Phase 2D · service enforces every entry-point invariant (source-contract)", () => {
  it("fail-closed flag checked at the top of every write entry point", () => {
    const entryPoints = [
      /export async function recordStandingVerification[\s\S]+?writeConceptVerification\(principal, registrationId, "STANDING"/,
      /export async function recordAuthorityVerification[\s\S]+?writeConceptVerification\(principal, registrationId, "AUTHORITY"/,
      /export async function releaseRegistration[\s\S]+?assertPhase2dOperatorFlag\(\);/,
      /export async function rejectRegistration[\s\S]+?assertPhase2dOperatorFlag\(\);/,
    ];
    for (const re of entryPoints) {
      expect(SERVICE).toMatch(re);
    }
    // And the shared writer:
    expect(SERVICE).toMatch(/async function writeConceptVerification[\s\S]+?assertPhase2dOperatorFlag\(\);/);
  });

  it("every write entry point asserts platform:signups:release permission", () => {
    expect(SERVICE).toMatch(/function assertOperatorAuthorised[\s\S]+?hasPermission\(principal, null, "platform:signups:release"\)/);
    // Called from release / reject / writeConceptVerification:
    expect(SERVICE.match(/assertOperatorAuthorised\(principal\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("every write entry point refuses the applicant (operator email == applicant email after normalisation)", () => {
    // Phase 2D identity-control correction (2026-10-26): the
    // comparator was strengthened to normalise both emails before
    // comparing (lowercase + trim + plus-tag strip).  See
    // tests/signup-2-phase-2d-identity-control.test.ts for the
    // normaliser's own property tests.
    expect(SERVICE).toMatch(/function assertNotApplicant[\s\S]+?normaliseEmailForComparison\(principal\.email\)/);
    expect(SERVICE).toMatch(/function assertNotApplicant[\s\S]+?normaliseEmailForComparison\(reg\.adminEmail\)/);
    expect(SERVICE.match(/assertNotApplicant\(principal, reg\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("separation-of-duties: same operator cannot sign STANDING and AUTHORITY", () => {
    expect(SERVICE).toMatch(/otherLatest\.operatorUserId === principal\.id/);
    expect(SERVICE).toMatch(/separation-of-duties/i);
  });

  it("release gate enforces three distinct operators", () => {
    expect(SERVICE).toMatch(/standingOp === authorityOp/);
    expect(SERVICE).toMatch(/principal\.id === standingOp \|\| principal\.id === authorityOp/);
  });

  it("release gate rejects conflicting-evidence + suspected-impersonation holds", () => {
    expect(SERVICE).toMatch(/prereq\.holdCategory === "CONFLICTING_EVIDENCE"/);
    expect(SERVICE).toMatch(/prereq\.holdCategory === "SUSPECTED_IMPERSONATION"/);
  });

  it("release gate rejects stale standing + authority evidence", () => {
    expect(SERVICE).toMatch(/prereq\.standingRecord\.expiresAt && prereq\.standingRecord\.expiresAt\.getTime\(\) < now\.getTime\(\)/);
    expect(SERVICE).toMatch(/prereq\.authorityRecord\.expiresAt && prereq\.authorityRecord\.expiresAt\.getTime\(\) < now\.getTime\(\)/);
  });

  it("release transition is atomic via conditional updateMany", () => {
    expect(SERVICE).toMatch(/tx\.signupRegistration\.updateMany\(\s*\{\s*where:\s*\{\s*id:\s*registrationId,\s*verificationVerdict:\s*"HOLD_FOR_REVIEW"/);
  });

  it("reject transition flips status to ABANDONED atomically", () => {
    expect(SERVICE).toMatch(/data:\s*\{[\s\S]+?verificationVerdict:\s*"REJECT"[\s\S]+?status:\s*"ABANDONED"/);
  });

  it("idempotent-replay guard: already-released (either verdict) returns noop without re-writing", () => {
    // Phase 2E correction (founder §2): the release path now writes
    // MANUAL_RELEASE (not PASS_AUTOMATED).  The replay guard accepts
    // both verdicts as terminal.
    expect(SERVICE).toMatch(/reg\.verificationVerdict === "MANUAL_RELEASE" \|\| reg\.verificationVerdict === "PASS_AUTOMATED"/);
    expect(SERVICE).toMatch(/reg\.verificationVerdict === "REJECT"[\s\S]+?return \{ noop: true as const/);
  });

  it("release transition writes verificationVerdict = MANUAL_RELEASE (not PASS_AUTOMATED)", () => {
    // Founder §2 of Phase 2E planning email: a manual three-operator
    // release must NOT set PASS_AUTOMATED (reserved for automated
    // corroborator pass).
    expect(SERVICE).toMatch(/verificationVerdict:\s*"MANUAL_RELEASE"/);
    // Not accidentally writing PASS_AUTOMATED in the release path.
    const releaseBlock = SERVICE.match(/export async function releaseRegistration[\s\S]+?^}/m)!;
    expect(releaseBlock[0]).not.toMatch(/verificationVerdict:\s*"PASS_AUTOMATED"/);
  });

  it("evidence-reference length cap enforced server-side", () => {
    expect(SERVICE).toMatch(/MAX_EVIDENCE_REFERENCE = 500/);
    expect(SERVICE).toMatch(/evidenceReference\.length > MAX_EVIDENCE_REFERENCE/);
  });

  it("reason length cap enforced server-side", () => {
    expect(SERVICE).toMatch(/MAX_REASON = 1000/);
    expect(SERVICE).toMatch(/input\.reason && input\.reason\.length > MAX_REASON/);
  });

  it("audit emission uses tails only (no raw operator id, no raw oid)", () => {
    const auditBlocks = SERVICE.match(/await audit\(principal, \{[\s\S]+?\}\)/g) ?? [];
    expect(auditBlocks.length).toBeGreaterThanOrEqual(3);
    for (const b of auditBlocks) {
      expect(b).toMatch(/\w+IdTail/);
      // No raw principal.id direct emission in meta.
      expect(b).not.toMatch(/\boperatorUserId:\s*principal\.id\b/);
    }
  });

  it("service never writes to ClubSubscription / Club / User / UserClubRole / Stripe", () => {
    expect(SERVICE).not.toMatch(/prisma\.clubSubscription\./);
    expect(SERVICE).not.toMatch(/prisma\.club\.create/);
    expect(SERVICE).not.toMatch(/prisma\.user\.create/);
    expect(SERVICE).not.toMatch(/prisma\.userClubRole\.create/);
    expect(SERVICE).not.toMatch(/stripe\./i);
  });

  it("service never writes accessTier anywhere", () => {
    expect(SERVICE).not.toMatch(/accessTier\s*:/);
  });

  it("service never contains any gov-ID surface or comment", () => {
    expect(SERVICE).not.toMatch(/govId/i);
    expect(SERVICE).not.toMatch(/government[-_ ]?id/i);
    expect(SERVICE).not.toMatch(/passport|driver.?licence|driver.?license/i);
  });
});

describe("SIGNUP-2 Phase 2D · computeQueueState covers all eight UI states", () => {
  it("verdict PASS_AUTOMATED → RELEASED", () => {
    expect(computeQueueState({ verdict: "PASS_AUTOMATED", holdCategory: null, standingVerified: true, authorityVerified: true })).toBe("RELEASED");
  });
  it("verdict MANUAL_RELEASE → RELEASED (Phase 2E §2 correction)", () => {
    expect(computeQueueState({ verdict: "MANUAL_RELEASE", holdCategory: null, standingVerified: true, authorityVerified: true })).toBe("RELEASED");
  });
  it("verdict REJECT → REJECTED", () => {
    expect(computeQueueState({ verdict: "REJECT", holdCategory: null, standingVerified: false, authorityVerified: false })).toBe("REJECTED");
  });
  it("hold SUSPECTED_IMPERSONATION → SUSPECTED_IMPERSONATION", () => {
    expect(computeQueueState({ verdict: "HOLD_FOR_REVIEW", holdCategory: "SUSPECTED_IMPERSONATION", standingVerified: false, authorityVerified: false })).toBe("SUSPECTED_IMPERSONATION");
  });
  it("hold CONFLICTING_EVIDENCE → CONFLICTING_EVIDENCE", () => {
    expect(computeQueueState({ verdict: "HOLD_FOR_REVIEW", holdCategory: "CONFLICTING_EVIDENCE", standingVerified: true, authorityVerified: true })).toBe("CONFLICTING_EVIDENCE");
  });
  it("hold INSUFFICIENT_EVIDENCE → INSUFFICIENT_EVIDENCE", () => {
    expect(computeQueueState({ verdict: "HOLD_FOR_REVIEW", holdCategory: "INSUFFICIENT_EVIDENCE", standingVerified: false, authorityVerified: false })).toBe("INSUFFICIENT_EVIDENCE");
  });
  it("both verified AND no blocking hold → READY_FOR_RELEASE", () => {
    expect(computeQueueState({ verdict: "HOLD_FOR_REVIEW", holdCategory: "ENTITY_VERIFICATION", standingVerified: true, authorityVerified: true })).toBe("READY_FOR_RELEASE");
  });
  it("standing verified only → AWAITING_AUTHORITY", () => {
    expect(computeQueueState({ verdict: "HOLD_FOR_REVIEW", holdCategory: "ENTITY_VERIFICATION", standingVerified: true, authorityVerified: false })).toBe("AWAITING_AUTHORITY");
  });
  it("nothing verified → AWAITING_STANDING", () => {
    expect(computeQueueState({ verdict: "HOLD_FOR_REVIEW", holdCategory: "ENTITY_VERIFICATION", standingVerified: false, authorityVerified: false })).toBe("AWAITING_STANDING");
  });
});
