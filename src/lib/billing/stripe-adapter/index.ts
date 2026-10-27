// SIGNUP-2 Phase 2E + M2 (2026-10-26 .. 2026-10-27) -- StripeAdapter factory.
//
// Mode selection (M2 Validation hardening -- rename for clarity, preserve
// backwards compatibility):
//
//   PRIMARY FLAG:   SPECTRE_STRIPE_SDK_MODE  = "mock" | "test"
//   LEGACY FLAG:    SPECTRE_SIGNUP_2E_STRIPE_MODE = "mock" | "live"
//
// The LEGACY flag's value "live" was ambiguous: it meant "use the real
// Stripe SDK against TEST MODE credentials", not "live-money mode".
// M2-Validation adds the primary flag with the clearer semantics:
//   "test" -- use the real Stripe SDK with sk_test_* credentials.
//   "mock" -- deterministic provider-independent mock.
//
// The legacy flag remains accepted for backwards compatibility:
//   SPECTRE_SIGNUP_2E_STRIPE_MODE=live  --> SDK mode "test"
//   SPECTRE_SIGNUP_2E_STRIPE_MODE=mock  --> SDK mode "mock"
//
// If BOTH flags are set, PRIMARY wins and a warning is logged.
//
// SAFETY GUARDS (M2-Validation, founder §2):
//   - When SDK mode is "test": STRIPE_SECRET_KEY MUST begin with
//     "sk_test_" (never "sk_live_").  Rejecting sk_live_ is unconditional
//     on staging to make live-money handling physically impossible.
//   - Webhook events with livemode=true are rejected at the dispatcher
//     level (see src/app/api/webhooks/stripe/route.ts).
//   - Fail CLOSED: when SDK mode is "test" but any required credential
//     is missing or an sk_live_ key is detected, the resolver THROWS.
//     No silent fallback to mock.

import { createMockStripeAdapter } from "./mock";
import { createLiveStripeAdapter } from "./live";
import { logger } from "@/lib/observability/logger";
import type { StripeAdapter } from "./types";

/** The clearer M2-Validation mode name.  "test" = real SDK in Stripe
 *  test mode.  "mock" = deterministic mock. */
export type StripeSdkMode = "mock" | "test";

/** The legacy Phase 2E mode name.  Preserved for compatibility.
 *  "live" meant "real SDK against test credentials" -- NOT real-money
 *  live mode.  M2-Validation adds the clearer alias.
 *  @deprecated Use StripeSdkMode. */
export type StripeAdapterMode = "mock" | "live";

/** M2-Validation (2026-10-27): resolve the SDK mode from the clearer
 *  primary flag, falling back to the legacy flag.  Returns the
 *  normalised {@link StripeSdkMode}. */
export function stripeSdkMode(): StripeSdkMode {
  const primary = process.env.SPECTRE_STRIPE_SDK_MODE;
  const legacy = process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE;
  if (primary && legacy && primary !== "" && legacy !== "") {
    logger.warn("stripe.adapter.mode_flag_conflict", {
      primary,
      legacy,
      note: "both SPECTRE_STRIPE_SDK_MODE and SPECTRE_SIGNUP_2E_STRIPE_MODE are set; primary wins",
    });
  }
  if (primary === "test") return "test";
  if (primary === "mock") return "mock";
  if (legacy === "live") return "test";
  return "mock";
}

/** @deprecated Use {@link stripeSdkMode}.  Retained for existing callers. */
export function stripeAdapterMode(): StripeAdapterMode {
  return stripeSdkMode() === "test" ? "live" : "mock";
}

export interface ResolveOptions {
  /** When true, throws if the resolved adapter is not isLive (real SDK).
   *  Use at production-capable call-sites so no caller-supplied test
   *  flag can bypass live-mode validation. */
  requireLive?: boolean;
}

/** M2-Validation (founder §2): staging MUST never process a Stripe
 *  live-money key.  This check is unconditional on any environment
 *  that is not explicitly PRODUCTION.  Staging + dev + CI all refuse
 *  `sk_live_` prefixes.  Production reversal of this rule requires an
 *  explicit, separately-authorised slice. */
function assertSecretKeyIsTestMode(secretKey: string): void {
  if (secretKey.startsWith("sk_live_")) {
    throw new Error(
      "[signup-2m2] REFUSING to use STRIPE_SECRET_KEY beginning with 'sk_live_'. " +
        "This process is not authorised for Stripe live-money mode.  Provision a test-mode key (sk_test_...) " +
        "or disable the SDK adapter by unsetting SPECTRE_STRIPE_SDK_MODE and SPECTRE_SIGNUP_2E_STRIPE_MODE.",
    );
  }
  if (!secretKey.startsWith("sk_test_")) {
    // Unknown prefix.  Could be a restricted key (rk_test_) or
    // malformed input.  Fail closed with a clear message.
    throw new Error(
      "[signup-2m2] STRIPE_SECRET_KEY does not begin with 'sk_test_'.  " +
        "Only Stripe TEST MODE secret keys are accepted at this stage.  See docs/signup-2-m2-acceptance.md §12.",
    );
  }
}

export function resolveStripeAdapter(opts: ResolveOptions = {}): StripeAdapter {
  const mode = stripeSdkMode();
  if (mode === "test") {
    const secretKey = process.env.STRIPE_SECRET_KEY ?? "";
    const webhookSigningSecret = process.env.STRIPE_WEBHOOK_SIGNING_SECRET ?? "";
    if (!secretKey || !webhookSigningSecret) {
      // Fail CLOSED.  An operator flipped the mode flag without
      // provisioning the credentials.
      throw new Error(
        "[signup-2m2] SPECTRE_STRIPE_SDK_MODE=test but STRIPE_SECRET_KEY and/or STRIPE_WEBHOOK_SIGNING_SECRET is unset. " +
          "Set both secrets via `flyctl secrets set` before enabling SDK mode.",
      );
    }
    // M2-Validation safety guard: reject sk_live_ unconditionally.
    assertSecretKeyIsTestMode(secretKey);
    return createLiveStripeAdapter({ secretKey, webhookSigningSecret });
  }
  if (opts.requireLive) {
    throw new Error(
      "[signup-2m2] resolveStripeAdapter({requireLive:true}) refused: SDK mode is 'mock'. " +
        "This call-site requires the real Stripe SDK.  Set SPECTRE_STRIPE_SDK_MODE=test and provision " +
        "STRIPE_SECRET_KEY (sk_test_...) + STRIPE_WEBHOOK_SIGNING_SECRET.",
    );
  }
  logger.info("stripe.adapter.mode", { mode: "mock" });
  return createMockStripeAdapter();
}

/** Returns the configured ACSS price id for CAD $38,000 annual, or
 *  null when running in mock mode.  Fails closed if mode is test but
 *  STRIPE_ACSS_PRICE_ID is unset. */
export function resolveAcssPriceId(): string | null {
  const mode = stripeSdkMode();
  if (mode === "mock") return null;
  const priceId = process.env.STRIPE_ACSS_PRICE_ID ?? "";
  if (!priceId) {
    throw new Error(
      "[signup-2m2] STRIPE_ACSS_PRICE_ID is unset while SDK mode=test. " +
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
