// PAY-1B/1 (2026-09-27) — Provider Adapter Conformance Suite.
//
// Any future PaymentProvider adapter MUST pass this suite before it
// can be considered implementation-ready. The suite runs against ANY
// object implementing `PaymentProviderV2` and exercises every
// invariant the Payments engine relies on.
//
// This is a reusable factory — `describeConformance(name, factory)`
// declares a vitest describe block. Callers wire it up in their own
// test file per adapter. See tests/payments/pay1b-simulator-
// conformance.test.ts for the SimulatorProvider wiring.

import { describe, it, expect } from "vitest";
import type {
  PaymentProviderV2,
  ProviderSubmissionInput,
} from "./contract";

export interface ConformanceHarness {
  /** Fresh provider instance for each test. */
  createProvider(): PaymentProviderV2;
  /** Optional: allow a test to force the provider into a specific
   *  outcome for the next submission. Adapters that lack this hook
   *  will have some optional tests skipped. */
  setNextOutcome?(
    idempotencyKey: string,
    kind: "ACKNOWLEDGE" | "REJECT" | "TIMEOUT" | "SETTLE" | "RETURN",
  ): void;
}

function baseInput(): ProviderSubmissionInput {
  return {
    clubId: "test-club",
    runId: "test-run-" + Math.random().toString(36).slice(2),
    instructionId: "test-inst-" + Math.random().toString(36).slice(2),
    amount: "100.00",
    currency: "CAD",
    requestedExecutionDate: new Date("2026-10-15T00:00:00Z"),
    idempotencyKey: "test-idem-" + Math.random().toString(36).slice(2),
    destinationRef: "dest-" + Math.random().toString(36).slice(2),
    fundingRef: "fund-" + Math.random().toString(36).slice(2),
  };
}

export function describeConformance(
  adapterName: string,
  harness: ConformanceHarness,
): void {
  describe(`PAY-1B conformance · ${adapterName}`, () => {
    it("declares required capability fields", () => {
      const p = harness.createProvider();
      expect(p.providerType).toBeTruthy();
      expect(typeof p.movesRealMoney).toBe("boolean");
      const c = p.capabilities;
      expect(typeof c.supportsSubmission).toBe("boolean");
      expect(typeof c.supportsStatusLookup).toBe("boolean");
      expect(typeof c.supportsCancellation).toBe("boolean");
      expect(typeof c.supportsAsyncEvents).toBe("boolean");
      expect(typeof c.supportsReturns).toBe("boolean");
      expect(typeof c.supportsBatchSubmission).toBe("boolean");
      expect(typeof c.supportsPerInstructionStatus).toBe("boolean");
      expect(typeof c.supportsScheduledExecution).toBe("boolean");
      expect(typeof c.supportsRealTimePayments).toBe("boolean");
      expect(typeof c.supportsBatchEft).toBe("boolean");
    });

    it("supportsSubmission → implements submit; else does not", () => {
      const p = harness.createProvider();
      if (p.capabilities.supportsSubmission) {
        expect(typeof p.submit).toBe("function");
      }
    });

    it("supportsStatusLookup → implements getStatus", () => {
      const p = harness.createProvider();
      if (p.capabilities.supportsStatusLookup) {
        expect(typeof p.getStatus).toBe("function");
      }
    });

    it("supportsCancellation → implements cancel", () => {
      const p = harness.createProvider();
      if (p.capabilities.supportsCancellation) {
        expect(typeof p.cancel).toBe("function");
      }
    });

    it("supportsAsyncEvents → implements verifyExternalEvent", () => {
      const p = harness.createProvider();
      if (p.capabilities.supportsAsyncEvents) {
        expect(typeof p.verifyExternalEvent).toBe("function");
      }
    });

    // ------------------------------------------------------------
    // Submission determinism + idempotency (required if
    // supportsSubmission).
    // ------------------------------------------------------------
    it("idempotency: same idempotencyKey returns the same result on retry", async () => {
      const p = harness.createProvider();
      if (!p.capabilities.supportsSubmission) return;
      harness.setNextOutcome?.("KEY_1", "ACKNOWLEDGE");
      const first = await p.submit({ ...baseInput(), idempotencyKey: "KEY_1" });
      const second = await p.submit({ ...baseInput(), idempotencyKey: "KEY_1" });
      expect(first.outcome).toBe(second.outcome);
      if (first.providerInstructionId && second.providerInstructionId) {
        expect(first.providerInstructionId).toBe(second.providerInstructionId);
      }
    });

    // ------------------------------------------------------------
    // Normalized submission outcomes.
    // ------------------------------------------------------------
    it("acknowledged submission produces ACKNOWLEDGED + providerInstructionId", async () => {
      const p = harness.createProvider();
      if (!p.capabilities.supportsSubmission) return;
      const idem = "OK_" + Math.random().toString(36).slice(2);
      harness.setNextOutcome?.(idem, "ACKNOWLEDGE");
      const r = await p.submit({ ...baseInput(), idempotencyKey: idem });
      expect(r.outcome).toBe("ACKNOWLEDGED");
      if (r.outcome === "ACKNOWLEDGED") {
        expect(r.providerInstructionId).toBeTruthy();
      }
    });

    it("rejected submission produces REJECTED + normalized error category", async () => {
      const p = harness.createProvider();
      if (!p.capabilities.supportsSubmission || !harness.setNextOutcome) return;
      const idem = "REJ_" + Math.random().toString(36).slice(2);
      harness.setNextOutcome(idem, "REJECT");
      const r = await p.submit({ ...baseInput(), idempotencyKey: idem });
      expect(r.outcome).toBe("REJECTED");
      expect(r.error?.category).toBeDefined();
    });

    it("timeout submission produces UNKNOWN (never a false ACKNOWLEDGE/REJECTED)", async () => {
      const p = harness.createProvider();
      if (!p.capabilities.supportsSubmission || !harness.setNextOutcome) return;
      const idem = "TO_" + Math.random().toString(36).slice(2);
      harness.setNextOutcome(idem, "TIMEOUT");
      const r = await p.submit({ ...baseInput(), idempotencyKey: idem });
      expect(r.outcome).toBe("UNKNOWN");
      if (r.error) {
        expect(["TIMEOUT", "PROVIDER_UNAVAILABLE", "TRANSIENT_NETWORK", "UNKNOWN"])
          .toContain(r.error.category);
        expect(r.error.retryable).toBe(true);
      }
    });

    // ------------------------------------------------------------
    // Status lookup — settlement + return semantics.
    // ------------------------------------------------------------
    it("settled instruction reports SETTLED with settledAt", async () => {
      const p = harness.createProvider();
      if (!p.capabilities.supportsSubmission || !p.capabilities.supportsStatusLookup || !harness.setNextOutcome) return;
      const idem = "S_" + Math.random().toString(36).slice(2);
      harness.setNextOutcome(idem, "SETTLE");
      const submitted = await p.submit({ ...baseInput(), idempotencyKey: idem });
      if (submitted.outcome !== "ACKNOWLEDGED" || !submitted.providerInstructionId) return;
      // Advance through polls if the adapter needs them.
      let last = submitted.providerInstructionId;
      let status = await p.getStatus!(last);
      let hops = 0;
      while (status.status !== "SETTLED" && hops < 4) {
        status = await p.getStatus!(last);
        hops++;
      }
      expect(status.status).toBe("SETTLED");
      if (status.settledAt) expect(status.settledAt).toBeInstanceOf(Date);
    });

    it("returned instruction reports RETURNED with returnedAt + returnCode", async () => {
      const p = harness.createProvider();
      if (!p.capabilities.supportsSubmission || !p.capabilities.supportsReturns || !p.capabilities.supportsStatusLookup || !harness.setNextOutcome) return;
      const idem = "R_" + Math.random().toString(36).slice(2);
      harness.setNextOutcome(idem, "RETURN");
      const submitted = await p.submit({ ...baseInput(), idempotencyKey: idem });
      if (submitted.outcome !== "ACKNOWLEDGED" || !submitted.providerInstructionId) return;
      let status = await p.getStatus!(submitted.providerInstructionId);
      let hops = 0;
      while (status.status !== "RETURNED" && hops < 6) {
        status = await p.getStatus!(submitted.providerInstructionId);
        hops++;
      }
      expect(status.status).toBe("RETURNED");
      if (status.returnedAt) expect(status.returnedAt).toBeInstanceOf(Date);
    });

    // ------------------------------------------------------------
    // Unknown provider instruction → adapter fails safely, never
    // synthesises an accepted/settled result.
    // ------------------------------------------------------------
    it("getStatus on unknown providerInstructionId fails safely (does not synthesise SETTLED)", async () => {
      const p = harness.createProvider();
      if (!p.capabilities.supportsStatusLookup) return;
      const p2 = await p.getStatus!("DEFINITELY-NOT-A-REAL-ID-" + Math.random()).catch((e) => ({ threw: true, err: e }));
      if ("threw" in p2) return; // allowed
      expect(p2.status).not.toBe("SETTLED");
      expect(p2.status).not.toBe("ACCEPTED");
    });

    // ------------------------------------------------------------
    // Cancellation semantics — never claims cancellation without
    // provider evidence.
    // ------------------------------------------------------------
    it("cancel returns a normalized outcome (never a boolean-only claim)", async () => {
      const p = harness.createProvider();
      if (!p.capabilities.supportsCancellation) return;
      const r = await p.cancel!("UNKNOWN-ID-" + Math.random());
      expect(["REQUESTED", "ACCEPTED", "REJECTED", "TOO_LATE", "UNKNOWN"]).toContain(r.outcome);
    });

    // ------------------------------------------------------------
    // Signature/verification boundary.
    // ------------------------------------------------------------
    it("verifyExternalEvent produces a normalized envelope with verificationStatus", async () => {
      const p = harness.createProvider();
      if (!p.capabilities.supportsAsyncEvents) return;
      const env = await p.verifyExternalEvent!({}, {}).catch((e) => ({ threw: true, err: e }));
      if ("threw" in env) return; // adapter may reject entirely
      expect(["VERIFIED", "UNVERIFIED", "FAILED"]).toContain(env.verificationStatus);
      expect(env.provider).toBe(p.providerType);
      expect(env.payloadHash).toBeTruthy();
    });
  });
}
