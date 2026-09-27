// PAY-1B/1 — SimulatorProvider must pass the reusable provider
// conformance suite defined in src/lib/payments/provider/conformance.ts.

import { describeConformance, type ConformanceHarness } from "@/lib/payments/provider/conformance";
import { getSimulatorV2, getSimulator, resetSimulator } from "@/lib/payments/provider/simulator";

const harness: ConformanceHarness = {
  createProvider() {
    resetSimulator();
    return getSimulatorV2();
  },
  setNextOutcome(idempotencyKey, kind) {
    const sim = getSimulator();
    if (kind === "REJECT") sim.setDirective(idempotencyKey, { kind: "REJECT", code: "R01", description: "invalid destination" });
    else if (kind === "TIMEOUT") sim.setDirective(idempotencyKey, { kind: "TIMEOUT" });
    else if (kind === "RETURN") sim.setDirective(idempotencyKey, { kind: "RETURN_AFTER_SETTLE", code: "R08" });
    else sim.setDirective(idempotencyKey, { kind: "ACCEPT_THEN_SETTLE" });
  },
};

describeConformance("SimulatorProvider", harness);
