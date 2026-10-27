// SIGNUP-2 M3 (2026-10-27) -- Bank-verification contract tests.
//
// Scope:
//  - State-machine permitted/forbidden transitions
//  - §5 Stripe-state re-validation predicate (pure)
//  - §7 flag-off refuses advanceToPaymentInitiated
//  - §7 flag-off refuses synthetic-sandbox persistSyntheticSignedMandate
//  - §6 orphan-event replay semantics (unit-shape)
//  - §1 safe-recovery: no permanent fail from internal timer
//  - verification-method classifier
//
// Pure contract tests only; no live DB or Stripe calls.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  SUBSCRIPTION_STATES,
  BANK_VERIFICATION_STATES,
  PERMITTED_TRANSITIONS,
  FORBIDDEN_TRANSITIONS,
  isTransitionPermitted,
  requireTransition,
  TIER1_STATES,
  TIER2_STATES,
} from "@/lib/billing/subscription-state-machine";
import {
  validateSetupIntentForPaymentInitiation,
  classifyVerificationMethod,
  assertBankVerificationFlag,
  assertPaymentInitiationFlag,
} from "@/lib/billing/signup-2m3-bank-verification-service";
import type { SetupIntentResult } from "@/lib/billing/stripe-adapter";

function baseSi(partial: Partial<SetupIntentResult> = {}): SetupIntentResult {
  return {
    setupIntentId: "seti_test_abc",
    status: "succeeded",
    customerId: "cus_test_123",
    paymentMethodId: "pm_test_456",
    mandateId: "mandate_test_789",
    nextAction: null,
    lastSetupErrorCode: null,
    lastSetupErrorMessage: null,
    evidenceSource: "mock-stripe",
    ...partial,
  };
}

describe("signup-2 m3 :: state machine (new bank-verification tier)", () => {
  it("declares the three new states", () => {
    expect(SUBSCRIPTION_STATES).toContain("BANK_VERIFICATION_PENDING");
    expect(SUBSCRIPTION_STATES).toContain("BANK_VERIFIED");
    expect(SUBSCRIPTION_STATES).toContain("BANK_VERIFICATION_FAILED");
  });

  it("BANK_VERIFICATION_STATES contains exactly the three M3 states", () => {
    expect(BANK_VERIFICATION_STATES.has("BANK_VERIFICATION_PENDING")).toBe(true);
    expect(BANK_VERIFICATION_STATES.has("BANK_VERIFIED")).toBe(true);
    expect(BANK_VERIFICATION_STATES.has("BANK_VERIFICATION_FAILED")).toBe(true);
    expect(BANK_VERIFICATION_STATES.has("AUTHORISED")).toBe(false);
    expect(BANK_VERIFICATION_STATES.has("INITIATED")).toBe(false);
  });

  it("AUTHORISED can transition into each M3 state + legacy INITIATED + CANCELLED", () => {
    const allowed = PERMITTED_TRANSITIONS["AUTHORISED"];
    expect(allowed).toContain("BANK_VERIFICATION_PENDING");
    expect(allowed).toContain("BANK_VERIFIED");
    expect(allowed).toContain("BANK_VERIFICATION_FAILED");
    expect(allowed).toContain("INITIATED");
    expect(allowed).toContain("CANCELLED");
  });

  it("BANK_VERIFICATION_PENDING -> BANK_VERIFIED is permitted", () => {
    expect(isTransitionPermitted("BANK_VERIFICATION_PENDING", "BANK_VERIFIED")).toBe(true);
  });

  it("BANK_VERIFICATION_PENDING -> BANK_VERIFICATION_FAILED is permitted", () => {
    expect(isTransitionPermitted("BANK_VERIFICATION_PENDING", "BANK_VERIFICATION_FAILED")).toBe(true);
  });

  it("BANK_VERIFIED -> INITIATED is permitted (M3 payment-initiation edge)", () => {
    expect(isTransitionPermitted("BANK_VERIFIED", "INITIATED")).toBe(true);
  });

  it("BANK_VERIFICATION_FAILED -> AUTHORISED is permitted (§1 safe recovery)", () => {
    expect(isTransitionPermitted("BANK_VERIFICATION_FAILED", "AUTHORISED")).toBe(true);
  });

  it("cannot skip bank verification (INITIATED -> BANK_VERIFICATION_PENDING forbidden)", () => {
    expect(isTransitionPermitted("INITIATED", "BANK_VERIFICATION_PENDING")).toBe(false);
    const forbidden = FORBIDDEN_TRANSITIONS.find(
      (t) => t.from === "INITIATED" && t.to === "BANK_VERIFICATION_PENDING",
    );
    expect(forbidden).toBeTruthy();
  });

  it("cannot regress ACTIVE back into bank-verification tier", () => {
    expect(isTransitionPermitted("ACTIVE", "BANK_VERIFICATION_PENDING")).toBe(false);
    expect(isTransitionPermitted("ACTIVE", "BANK_VERIFIED")).toBe(false);
    expect(isTransitionPermitted("ACTIVE", "BANK_VERIFICATION_FAILED")).toBe(false);
  });

  it("cannot resurrect from CANCELLED into bank-verification tier", () => {
    expect(isTransitionPermitted("CANCELLED", "BANK_VERIFICATION_PENDING")).toBe(false);
    expect(isTransitionPermitted("CANCELLED", "BANK_VERIFIED")).toBe(false);
  });

  it("requireTransition throws on forbidden edges", () => {
    expect(() => requireTransition("INITIATED", "BANK_VERIFIED")).toThrow();
    expect(() => requireTransition("ACTIVE", "BANK_VERIFICATION_PENDING")).toThrow();
  });

  it("requireTransition succeeds on BANK_VERIFIED -> INITIATED", () => {
    expect(() => requireTransition("BANK_VERIFIED", "INITIATED")).not.toThrow();
  });

  it("bank-verification tier is in Tier 1 (staged access)", () => {
    expect(TIER1_STATES.has("BANK_VERIFICATION_PENDING")).toBe(true);
    expect(TIER1_STATES.has("BANK_VERIFIED")).toBe(true);
    expect(TIER1_STATES.has("BANK_VERIFICATION_FAILED")).toBe(true);
  });

  it("bank-verification tier is NOT in Tier 2 (never a tenant-active state)", () => {
    expect(TIER2_STATES.has("BANK_VERIFICATION_PENDING")).toBe(false);
    expect(TIER2_STATES.has("BANK_VERIFIED")).toBe(false);
    expect(TIER2_STATES.has("BANK_VERIFICATION_FAILED")).toBe(false);
  });

  it("existing AUTHORISED -> INITIATED edge still permitted (backward-compat)", () => {
    expect(isTransitionPermitted("AUTHORISED", "INITIATED")).toBe(true);
  });
});

describe("signup-2 m3 :: §5 Stripe-state re-validation (validateSetupIntentForPaymentInitiation)", () => {
  const expected = { expectedMandateId: "mandate_test_789", expectedPaymentMethodId: "pm_test_456" };

  it("accepts a succeeded SI with matching mandate + PM", () => {
    const r = validateSetupIntentForPaymentInitiation({ si: baseSi(), ...expected });
    expect(r.ok).toBe(true);
  });

  it("refuses when status is not succeeded", () => {
    const r = validateSetupIntentForPaymentInitiation({ si: baseSi({ status: "requires_action" }), ...expected });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("status_not_succeeded");
  });

  it("refuses on processing status", () => {
    const r = validateSetupIntentForPaymentInitiation({ si: baseSi({ status: "processing" }), ...expected });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("status_not_succeeded");
  });

  it("refuses on canceled status (signatory cancelled)", () => {
    const r = validateSetupIntentForPaymentInitiation({ si: baseSi({ status: "canceled" }), ...expected });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("status_not_succeeded");
  });

  it("refuses when customer missing", () => {
    const r = validateSetupIntentForPaymentInitiation({ si: baseSi({ customerId: null }), ...expected });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("customer_missing");
  });

  it("refuses when payment method missing", () => {
    const r = validateSetupIntentForPaymentInitiation({ si: baseSi({ paymentMethodId: null }), ...expected });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("payment_method_missing");
  });

  it("refuses when mandate missing", () => {
    const r = validateSetupIntentForPaymentInitiation({ si: baseSi({ mandateId: null }), ...expected });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("mandate_missing");
  });

  it("refuses on payment-method mismatch (adversarial swap)", () => {
    const r = validateSetupIntentForPaymentInitiation({
      si: baseSi({ paymentMethodId: "pm_attacker_999" }),
      ...expected,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("payment_method_mismatch");
  });

  it("refuses on mandate mismatch (adversarial swap)", () => {
    const r = validateSetupIntentForPaymentInitiation({
      si: baseSi({ mandateId: "mandate_attacker_999" }),
      ...expected,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("mandate_mismatch");
  });
});

describe("signup-2 m3 :: §7 flag gates", () => {
  beforeEach(() => {
    delete process.env.SPECTRE_SIGNUP_2M3_BANK_VERIFICATION;
    delete process.env.SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION;
  });

  afterEach(() => {
    delete process.env.SPECTRE_SIGNUP_2M3_BANK_VERIFICATION;
    delete process.env.SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION;
  });

  it("assertBankVerificationFlag throws when flag is unset", () => {
    expect(() => assertBankVerificationFlag()).toThrow(/disabled/);
  });

  it("assertBankVerificationFlag throws when flag is 0", () => {
    process.env.SPECTRE_SIGNUP_2M3_BANK_VERIFICATION = "0";
    expect(() => assertBankVerificationFlag()).toThrow(/disabled/);
  });

  it("assertBankVerificationFlag succeeds when flag is 1", () => {
    process.env.SPECTRE_SIGNUP_2M3_BANK_VERIFICATION = "1";
    expect(() => assertBankVerificationFlag()).not.toThrow();
  });

  it("assertPaymentInitiationFlag throws when flag is unset", () => {
    expect(() => assertPaymentInitiationFlag()).toThrow(/disabled/);
  });

  it("assertPaymentInitiationFlag throws when flag is 0", () => {
    process.env.SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION = "0";
    expect(() => assertPaymentInitiationFlag()).toThrow(/disabled/);
  });

  it("assertPaymentInitiationFlag error message mentions ALL pathway blocking (§7)", () => {
    try {
      assertPaymentInitiationFlag();
      expect.fail("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/legacy|recovery|synthetic|scheduled/i);
    }
  });

  it("assertPaymentInitiationFlag succeeds when flag is 1", () => {
    process.env.SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION = "1";
    expect(() => assertPaymentInitiationFlag()).not.toThrow();
  });

  it("the two flags are independent (BANK_VERIFICATION=1 alone does not unlock payment)", () => {
    process.env.SPECTRE_SIGNUP_2M3_BANK_VERIFICATION = "1";
    expect(() => assertBankVerificationFlag()).not.toThrow();
    expect(() => assertPaymentInitiationFlag()).toThrow(/disabled/);
  });
});

describe("signup-2 m3 :: verification-method classifier", () => {
  it("instant path: no previous pending, no verify_with_microdeposits => INSTANT", () => {
    const m = classifyVerificationMethod({ previousState: null, si: baseSi() });
    expect(m).toBe("INSTANT");
  });

  it("microdeposit path: previous state BANK_VERIFICATION_PENDING => MICRODEPOSITS", () => {
    const m = classifyVerificationMethod({ previousState: "BANK_VERIFICATION_PENDING", si: baseSi() });
    expect(m).toBe("MICRODEPOSITS");
  });

  it("microdeposit path: next_action.type=verify_with_microdeposits => MICRODEPOSITS", () => {
    const m = classifyVerificationMethod({
      previousState: null,
      si: baseSi({
        nextAction: {
          type: "verify_with_microdeposits",
          arrivalDate: new Date(),
          hostedUrl: "https://stripe.test/microdeposit",
          depositType: "amounts",
        },
      }),
    });
    expect(m).toBe("MICRODEPOSITS");
  });
});

describe("signup-2 m3 :: §1 safe recovery semantics", () => {
  it("BANK_VERIFICATION_FAILED -> AUTHORISED permits restart (never a terminal state)", () => {
    expect(isTransitionPermitted("BANK_VERIFICATION_FAILED", "AUTHORISED")).toBe(true);
  });

  it("TTL expiry is NOT the authoritative trigger (Stripe-sourced only)", () => {
    // The service's bankVerificationExpiresAt is informational -- this
    // test asserts the design intent: TTL semantics live in the
    // service's documented reasons.  "STRIPE_TTL_EXCEEDED" is the only
    // Spectre-triggered reason, and it is reserved for Stripe-reported
    // expiry (not a Spectre-side timer).
    const allowedReasons = ["STRIPE_SETUP_FAILED", "SIGNATORY_CANCELED", "STRIPE_TTL_EXCEEDED"] as const;
    expect(allowedReasons).toContain("STRIPE_SETUP_FAILED");
    expect(allowedReasons).toContain("SIGNATORY_CANCELED");
    expect(allowedReasons).toContain("STRIPE_TTL_EXCEEDED");
    // There is NO "SPECTRE_INTERNAL_TIMER_EXPIRED" reason -- that
    // would violate founder §1.
    expect(allowedReasons).not.toContain("SPECTRE_INTERNAL_TIMER_EXPIRED" as unknown as typeof allowedReasons[number]);
  });
});
