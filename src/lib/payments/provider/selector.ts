// PAY-1A/4 (2026-09-26) — Provider selector.
//
// Only the simulator is available in PAY-1A. Any attempt to construct
// a real-money provider fails through the kill-switch. The selector
// is the SINGLE entry point for the submission code path — every
// worker, cron, and request must go through it.

import { assertPaymentsEnabled, realMoneyEnabled } from "../kill-switch";
import { getSimulator } from "./simulator";
import type { PaymentProvider } from "./index";

export function selectProvider(providerType: "SIMULATOR"): PaymentProvider {
  assertPaymentsEnabled();
  if (providerType === "SIMULATOR") return getSimulator();
  // Defense in depth: if a future provider is registered here, its
  // constructor MUST re-assert real-money capability. The selector
  // additionally refuses to hand out a real-money provider when the
  // capability is off.
  if (!realMoneyEnabled()) {
    throw new Error(
      `PAY-1A: provider ${providerType} requires PAYMENTS_REAL_MONEY_ENABLED=true; refused.`,
    );
  }
  throw new Error(`PAY-1A: unknown provider ${providerType}. Only SIMULATOR is available.`);
}
