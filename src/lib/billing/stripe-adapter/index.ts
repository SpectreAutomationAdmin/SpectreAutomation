// SIGNUP-2 Phase 2E (2026-10-26) -- StripeAdapter factory.
//
// Factory resolves the adapter based on `SPECTRE_SIGNUP_2E_STRIPE_MODE`:
//   "live"  -- (not shipped in Phase 2E baseline; requires a
//              separately-authorised slice that adds the live
//              adapter after Stripe test-mode credentials are
//              provisioned on staging as Fly secrets).
//   "mock"  -- deterministic provider-independent mock.
//   unset   -- defaults to "mock" (fail-safe to never-fabricated
//              behaviour).
//
// Per founder §1: Phase 2E baseline is implemented against the
// mock adapter; the live adapter is explicitly out-of-scope for
// Phase 2E's first ship.

import { createMockStripeAdapter } from "./mock";
import type { StripeAdapter } from "./types";

export type StripeAdapterMode = "mock" | "live";

export function stripeAdapterMode(): StripeAdapterMode {
  const raw = process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE;
  return raw === "live" ? "live" : "mock";
}

export function resolveStripeAdapter(): StripeAdapter {
  const mode = stripeAdapterMode();
  if (mode === "live") {
    // Live adapter is a Phase 2E-Follow-On deliverable gated behind
    // Stripe test-mode credential procurement + the verify doc.
    // For now, "live" mode falls through to mock BUT logs loudly so
    // operators notice the misconfiguration.  A later slice will
    // throw here when no live adapter module is wired.
    // eslint-disable-next-line no-console
    console.warn("[signup-2e] SPECTRE_SIGNUP_2E_STRIPE_MODE=live requested but live adapter is not shipped in Phase 2E baseline; falling back to mock.");
  }
  return createMockStripeAdapter();
}

export type { StripeAdapter } from "./types";
export * from "./types";
