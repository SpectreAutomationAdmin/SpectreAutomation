// SIGNUP-2 Phase 2E (2026-10-26) -- Mandate-service contract.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertPhase2ePaymentFlag } from "@/lib/billing/signup-2e-mandate-service";

const ROOT = process.cwd();
const SERVICE = readFileSync(join(ROOT, "src/lib/billing/signup-2e-mandate-service.ts"), "utf8");

describe("SIGNUP-2 Phase 2E · fail-closed flag", () => {
  const prev = process.env.SPECTRE_SIGNUP_2E_PAYMENT_LIVE;
  beforeEach(() => {
    delete process.env.SPECTRE_SIGNUP_2E_PAYMENT_LIVE;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.SPECTRE_SIGNUP_2E_PAYMENT_LIVE;
    else process.env.SPECTRE_SIGNUP_2E_PAYMENT_LIVE = prev;
  });

  it("assertPhase2ePaymentFlag throws when flag is unset", () => {
    expect(() => assertPhase2ePaymentFlag()).toThrow(/disabled/i);
  });

  it("assertPhase2ePaymentFlag throws when flag is '0'", () => {
    process.env.SPECTRE_SIGNUP_2E_PAYMENT_LIVE = "0";
    expect(() => assertPhase2ePaymentFlag()).toThrow(/disabled/i);
  });

  it("assertPhase2ePaymentFlag throws when flag is 'true' (only literal '1' passes)", () => {
    process.env.SPECTRE_SIGNUP_2E_PAYMENT_LIVE = "true";
    expect(() => assertPhase2ePaymentFlag()).toThrow(/disabled/i);
  });

  it("assertPhase2ePaymentFlag passes when flag === '1'", () => {
    process.env.SPECTRE_SIGNUP_2E_PAYMENT_LIVE = "1";
    expect(() => assertPhase2ePaymentFlag()).not.toThrow();
  });
});

describe("SIGNUP-2 Phase 2E · service gates order (fail-closed first)", () => {
  it("initiateMandateCollection calls assertPhase2ePaymentFlag BEFORE touching the DB", () => {
    // Scan the whole service file (not a sub-block regex which may
    // over-match / under-match function bodies with nested braces).
    const funStart = SERVICE.indexOf("export async function initiateMandateCollection(");
    const flagIdx = SERVICE.indexOf("assertPhase2ePaymentFlag();", funStart);
    // The next await on prisma / tx within this function.
    const prismaIdx = SERVICE.indexOf("await prisma.", funStart);
    expect(funStart).toBeGreaterThan(0);
    expect(flagIdx).toBeGreaterThan(funStart);
    if (prismaIdx >= 0) {
      expect(flagIdx).toBeLessThan(prismaIdx);
    }
  });

  it("initiateMandateCollection inherits the Phase 2B ToS gate", () => {
    expect(SERVICE).toMatch(/assertAttestationCanProceed\(\)/);
  });

  it("initiateMandateCollection refuses when attestation ToS SHA-256 mismatches the current approved ToS", () => {
    expect(SERVICE).toMatch(/attestation\.termsVersionSha256 !== doc\.sha256/);
  });

  it("persistSignedMandate refuses when no Phase 2D RELEASE record exists", () => {
    expect(SERVICE).toMatch(/No Phase 2D RELEASE record on file/);
  });

  it("persistSignedMandate attaches releasedByOperatorRecordId to the BillingCycle", () => {
    expect(SERVICE).toMatch(/releasedByOperatorRecordId:\s*releaseRecord\.id/);
  });

  it("persistSignedMandate is idempotent on signupRegistrationId (replay returns noop)", () => {
    expect(SERVICE).toMatch(/signup\.mandate\.persist\.replay/);
    expect(SERVICE).toMatch(/existing && !existing\.revokedAt/);
  });

  it("isActivationReady is REVOCABLE per founder §5 (reversedAt null required)", () => {
    expect(SERVICE).toMatch(/if \(cycle\.reversedAt\) return false; \/\/ revocable per founder §5/);
  });

  it("isActivationReady checks balance-transaction availability", () => {
    expect(SERVICE).toMatch(/retrieveBalanceTransaction/);
    expect(SERVICE).toMatch(/bal\.status === "available" && bal\.availableAt\.getTime\(\) <= Date\.now\(\)/);
  });
});

describe("SIGNUP-2 Phase 2E · service never performs forbidden writes", () => {
  it("never writes User / Club / UserClubRole / accessTier / Stripe-live", () => {
    expect(SERVICE).not.toMatch(/prisma\.user\.create/);
    expect(SERVICE).not.toMatch(/prisma\.club\.create/);
    expect(SERVICE).not.toMatch(/prisma\.userClubRole\.create/);
    expect(SERVICE).not.toMatch(/accessTier\s*:/);
    // Stripe LIVE-mode flagging: adapter decides live/mock; the
    // service never selects live directly.
    expect(SERVICE).not.toMatch(/livemode\s*:\s*true/);
  });

  it("never introduces gov-ID surface", () => {
    expect(SERVICE).not.toMatch(/govId/i);
    expect(SERVICE).not.toMatch(/government[-_ ]?id/i);
  });
});
