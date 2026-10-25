// SIGNUP-2 Phase 2A (2026-10-25) -- Subscription state-machine contract tests.
// Pure functions; no DB.

import { describe, it, expect } from "vitest";
import {
  SUBSCRIPTION_STATES,
  TERMINAL_STATES,
  TIER1_STATES,
  TIER2_STATES,
  SUSPENDED_READ_ONLY_STATES,
  PERMITTED_TRANSITIONS,
  FORBIDDEN_TRANSITIONS,
  REVERSAL_EDGES,
  isTransitionPermitted,
  requireTransition,
  evaluateActivationGate,
  type SubscriptionState,
} from "@/lib/billing/subscription-state-machine";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("SIGNUP-2 · subscription states enumerated", () => {
  it("defines exactly the ten documented states", () => {
    expect(SUBSCRIPTION_STATES).toEqual([
      "AUTHORISED",
      "INITIATED",
      "AWAITING_SETTLEMENT",
      "SETTLED",
      "ACTIVATION_READY",
      "ACTIVE",
      "SUSPENDED",
      "PAYMENT_FAILED",
      "CANCELLED",
      "MANUAL_INVOICE",
    ]);
  });

  it("every state has a PERMITTED_TRANSITIONS entry", () => {
    for (const s of SUBSCRIPTION_STATES) {
      expect(PERMITTED_TRANSITIONS[s], `state ${s} missing from PERMITTED_TRANSITIONS`).toBeDefined();
    }
  });

  it("ACTIVE and CANCELLED are terminal", () => {
    expect(TERMINAL_STATES.has("ACTIVE")).toBe(true);
    expect(TERMINAL_STATES.has("CANCELLED")).toBe(true);
    expect(TERMINAL_STATES.has("AUTHORISED")).toBe(false);
    expect(TERMINAL_STATES.has("SUSPENDED")).toBe(false);
  });

  it("Tier 1 states are the pre-activation chain + PAYMENT_FAILED", () => {
    expect(TIER1_STATES.has("AUTHORISED")).toBe(true);
    expect(TIER1_STATES.has("INITIATED")).toBe(true);
    expect(TIER1_STATES.has("AWAITING_SETTLEMENT")).toBe(true);
    expect(TIER1_STATES.has("SETTLED")).toBe(true);
    expect(TIER1_STATES.has("ACTIVATION_READY")).toBe(true);
    expect(TIER1_STATES.has("PAYMENT_FAILED")).toBe(true);
    expect(TIER1_STATES.has("ACTIVE")).toBe(false);
    expect(TIER1_STATES.has("CANCELLED")).toBe(false);
  });

  it("Tier 2 states are ACTIVE + MANUAL_INVOICE", () => {
    expect(TIER2_STATES.has("ACTIVE")).toBe(true);
    expect(TIER2_STATES.has("MANUAL_INVOICE")).toBe(true);
    expect(TIER2_STATES.has("SUSPENDED")).toBe(false);
    expect(TIER2_STATES.has("AUTHORISED")).toBe(false);
  });

  it("SUSPENDED collapses to Tier-1 read-only", () => {
    expect(SUSPENDED_READ_ONLY_STATES.has("SUSPENDED")).toBe(true);
    expect(SUSPENDED_READ_ONLY_STATES.size).toBe(1);
  });
});

describe("SIGNUP-2 · permitted transitions", () => {
  it("AUTHORISED -> INITIATED permitted; AUTHORISED -> ACTIVE forbidden", () => {
    expect(isTransitionPermitted("AUTHORISED", "INITIATED")).toBe(true);
    expect(isTransitionPermitted("AUTHORISED", "ACTIVE")).toBe(false);
  });

  it("SETTLED -> ACTIVATION_READY permitted; SETTLED -> ACTIVE forbidden (gate mandatory)", () => {
    expect(isTransitionPermitted("SETTLED", "ACTIVATION_READY")).toBe(true);
    expect(isTransitionPermitted("SETTLED", "ACTIVE")).toBe(false);
  });

  it("ACTIVATION_READY -> ACTIVE permitted", () => {
    expect(isTransitionPermitted("ACTIVATION_READY", "ACTIVE")).toBe(true);
  });

  it("ACTIVE -> SUSPENDED permitted (reversal)", () => {
    expect(isTransitionPermitted("ACTIVE", "SUSPENDED")).toBe(true);
  });

  it("SUSPENDED -> ACTIVE permitted (reinstatement)", () => {
    expect(isTransitionPermitted("SUSPENDED", "ACTIVE")).toBe(true);
  });

  it("CANCELLED is a terminal black hole", () => {
    expect(PERMITTED_TRANSITIONS["CANCELLED"]).toEqual([]);
    for (const s of SUBSCRIPTION_STATES) {
      if (s === "CANCELLED") continue;
      expect(isTransitionPermitted("CANCELLED", s)).toBe(false);
    }
  });

  it("self-transitions are not permitted", () => {
    for (const s of SUBSCRIPTION_STATES) {
      expect(isTransitionPermitted(s, s)).toBe(false);
    }
  });

  it("ACTIVE -> AUTHORISED (un-pay) is forbidden explicitly", () => {
    expect(isTransitionPermitted("ACTIVE", "AUTHORISED")).toBe(false);
    expect(FORBIDDEN_TRANSITIONS.find((e) => e.from === "ACTIVE" && e.to === "AUTHORISED")).toBeDefined();
  });

  it("SUSPENDED -> AUTHORISED is forbidden explicitly", () => {
    expect(isTransitionPermitted("SUSPENDED", "AUTHORISED")).toBe(false);
    expect(FORBIDDEN_TRANSITIONS.find((e) => e.from === "SUSPENDED" && e.to === "AUTHORISED")).toBeDefined();
  });

  it("CANCELLED -> ACTIVE is forbidden explicitly", () => {
    expect(FORBIDDEN_TRANSITIONS.find((e) => e.from === "CANCELLED" && e.to === "ACTIVE")).toBeDefined();
  });

  it("every FORBIDDEN_TRANSITIONS edge is actually denied by the predicate", () => {
    for (const e of FORBIDDEN_TRANSITIONS) {
      expect(
        isTransitionPermitted(e.from, e.to),
        `${e.from} -> ${e.to} should be forbidden but predicate returned permitted`,
      ).toBe(false);
    }
  });

  it("requireTransition throws on forbidden; passes on permitted", () => {
    expect(() => requireTransition("ACTIVE", "SUSPENDED")).not.toThrow();
    expect(() => requireTransition("ACTIVE", "AUTHORISED")).toThrow(/not permitted/i);
  });
});

describe("SIGNUP-2 · reversal edges documented", () => {
  it("three ACTIVE -> SUSPENDED edges + one ACTIVATION_READY -> SUSPENDED edge", () => {
    const fromActive = REVERSAL_EDGES.filter((e) => e.from === "ACTIVE");
    expect(fromActive.length).toBe(3);
    const reasons = fromActive.map((e) => e.reason);
    expect(reasons).toContain("pad_nsf_post_settlement");
    expect(reasons).toContain("pad_dispute_within_window");
    expect(reasons).toContain("operator_initiated_suspend");
    const fromActGate = REVERSAL_EDGES.filter((e) => e.from === "ACTIVATION_READY");
    expect(fromActGate.length).toBe(1);
    expect(fromActGate[0].reason).toBe("pre_activation_reversal");
  });

  it("every reversal edge is a permitted transition", () => {
    for (const e of REVERSAL_EDGES) {
      expect(
        isTransitionPermitted(e.from, e.to),
        `reversal ${e.from} -> ${e.to} (${e.reason}) must be a permitted transition`,
      ).toBe(true);
    }
  });
});

describe("SIGNUP-2 · activation gate", () => {
  const base = {
    subscriptionStatus: "SETTLED" as SubscriptionState,
    balanceTransactionStatus: "available" as const,
    balanceAvailableOn: new Date("2026-10-20T00:00:00Z"),
    nowUtc: new Date("2026-10-25T00:00:00Z"),
    disputeOrRefundExistsForCycle: false,
  };

  it("passes when all four conditions hold", () => {
    const r = evaluateActivationGate(base);
    expect(r.pass).toBe(true);
  });

  it("fails if subscriptionStatus is not SETTLED (requires reconciliation gate)", () => {
    const r = evaluateActivationGate({ ...base, subscriptionStatus: "AWAITING_SETTLEMENT" });
    expect(r.pass).toBe(false);
    expect(r.reason).toBe("wrong_subscription_status");
  });

  it("fails if balance_transaction.status is pending (webhook only; funds not usable)", () => {
    const r = evaluateActivationGate({ ...base, balanceTransactionStatus: "pending" });
    expect(r.pass).toBe(false);
    expect(r.reason).toBe("balance_transaction_not_available");
  });

  it("fails if available_on is in the future (ACSS funds not yet released)", () => {
    const r = evaluateActivationGate({
      ...base,
      balanceAvailableOn: new Date("2026-11-01T00:00:00Z"),
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toBe("available_on_in_future");
  });

  it("fails if a dispute or refund exists for the cycle", () => {
    const r = evaluateActivationGate({ ...base, disputeOrRefundExistsForCycle: true });
    expect(r.pass).toBe(false);
    expect(r.reason).toBe("dispute_or_refund_exists_for_cycle");
  });

  it("explicit note: payment_intent.processing alone does NOT satisfy the gate", () => {
    // The gate's input shape has no `processing` field; the gate
    // requires SETTLED subscription status + available balance
    // transaction.  Processing-only payment never reaches here.
    const r = evaluateActivationGate({ ...base, subscriptionStatus: "AWAITING_SETTLEMENT" });
    expect(r.pass).toBe(false);
  });
});

describe("SIGNUP-2 · state-machine source-contract", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/billing/subscription-state-machine.ts"), "utf8");

  it("exports SUBSCRIPTION_STATES as a frozen tuple", () => {
    expect(src).toMatch(/export const SUBSCRIPTION_STATES = \[[\s\S]+?\] as const/);
  });

  it("the three terminal-states-cannot-reverse edges are forbidden", () => {
    expect(src).toMatch(/from: "ACTIVE",\s*to: "AUTHORISED"/);
    expect(src).toMatch(/from: "ACTIVE",\s*to: "INITIATED"/);
    expect(src).toMatch(/from: "SETTLED",\s*to: "ACTIVE"/);
  });

  it("evaluateActivationGate inspects balance_transaction.status === 'available'", () => {
    expect(src).toMatch(/balanceTransactionStatus !== "available"/);
  });

  it("evaluateActivationGate inspects available_on vs nowUtc", () => {
    expect(src).toMatch(/balanceAvailableOn\.getTime\(\) > input\.nowUtc\.getTime\(\)/);
  });
});
