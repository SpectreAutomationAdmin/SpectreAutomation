// SIGNUP-2 Phase 2E + M2 (2026-10-26 .. 2026-10-27) -- StripeAdapter factory.
//
// Factory resolves the adapter based on `SPECTRE_SIGNUP_2E_STRIPE_MODE`:
//   "live"  -- M2 (2026-10-27).  Uses the official Stripe Node SDK.
//              Requires STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SIGNING_SECRET
//              to be set.  Fails CLOSED (throws) if either is missing --
//              per founder §4: "Do not allow caller-supplied test flags
//              to bypass production-capable financial validation."
//   "mock"  -- deterministic provider-independent mock.
//   unset   -- defaults to "mock" (fail-safe to never-fabricated
//              behaviour).
//
// Call-site usage: `const stripe = resolveStripeAdapter();`.
// Call-sites that MUST have a live adapter (e.g., production
// financial-activation gate) should call `resolveStripeAdapter({
// requireLive: true })`, which throws if the resolver returns a mock.

import { createMockStripeAdapter } from "./mock";
import { createLiveStripeAdapter } from "./live";
import { logger } from "@/lib/observability/logger";
import type { StripeAdapter } from "./types";

export type StripeAdapterMode = "mock" | "live";

export function stripeAdapterMode(): StripeAdapterMode {
  const raw = process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE;
  return raw === "live" ? "live" : "mock";
}

export interface ResolveOptions {
  /** When true, throws if the resolved adapter is not isLive.
   *  Use at production-capable call-sites so no caller-supplied test
   *  flag can bypass live-mode validation. */
  requireLive?: boolean;
}

export function resolveStripeAdapter(opts: ResolveOptions = {}): StripeAdapter {
  const mode = stripeAdapterMode();
  if (mode === "live") {
    const secretKey = process.env.STRIPE_SECRET_KEY ?? "";
    const webhookSigningSecret = process.env.STRIPE_WEBHOOK_SIGNING_SECRET ?? "";
    if (!secretKey || !webhookSigningSecret) {
      // Fail CLOSED, do NOT silently fall back to mock.  An operator
      // flipped the mode flag without provisioning the credentials.
      throw new Error(
        "[signup-2m2] SPECTRE_SIGNUP_2E_STRIPE_MODE=live but STRIPE_SECRET_KEY and/or STRIPE_WEBHOOK_SIGNING_SECRET is unset. " +
          "Set both secrets via `flyctl secrets set` before enabling live mode.",
      );
    }
    return createLiveStripeAdapter({ secretKey, webhookSigningSecret });
  }
  if (opts.requireLive) {
    throw new Error(
      "[signup-2m2] resolveStripeAdapter({requireLive:true}) refused: adapter mode is 'mock'. " +
        "This call-site requires a live Stripe adapter.  Set SPECTRE_SIGNUP_2E_STRIPE_MODE=live and " +
        "provision STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SIGNING_SECRET.",
    );
  }
  logger.info("stripe.adapter.mode", { mode: "mock" });
  return createMockStripeAdapter();
}

/** Returns the configured ACSS price id for CAD $38,000 annual, or
 *  null when running in mock mode (the mock adapter does not require
 *  a price id; it synthesises one from the idempotency key).  Live
 *  adapter call-sites MUST provide a non-null price id.
 */
export function resolveAcssPriceId(): string | null {
  const mode = stripeAdapterMode();
  if (mode === "mock") return null;
  const priceId = process.env.STRIPE_ACSS_PRICE_ID ?? "";
  if (!priceId) {
    throw new Error(
      "[signup-2m2] STRIPE_ACSS_PRICE_ID is unset while mode=live. " +
        "Create a CAD $38,000 annual recurring Price in the Stripe dashboard with payment_method_types=['acss_debit'] " +
        "and set STRIPE_ACSS_PRICE_ID via `flyctl secrets set`.",
    );
  }
  return priceId;
}

export type { StripeAdapter } from "./types";
export * from "./types";
export { createLiveStripeAdapter } from "./live";
export { createMockStripeAdapter } from "./mock";
