// SIGNUP-2 M4-STRIPE-1 (2026-10-29) -- READ-ONLY Stripe test-mode
// inspection via raw HTTPS (no SDK dependency; the Next.js standalone
// bundle inlines `stripe` into the webhook route and does not expose
// it as a top-level resolvable module).
//
// Does NOT create, update, or delete anything.  Does NOT expose
// credential values.  Prints only shape + mode + id prefix evidence.

import https from "node:https";

function maskId(id) {
  if (!id || typeof id !== "string") return "<null>";
  if (id.length <= 12) return id;
  return id.slice(0, 8) + "***" + id.slice(-4);
}

function stripeGet(path, secretKey) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: "GET",
      hostname: "api.stripe.com",
      path,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Stripe-Version": "2026-09-30.endive",
      },
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body: null, raw: body });
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function main() {
  const sdkMode = process.env.SPECTRE_STRIPE_SDK_MODE ?? "(unset)";
  const legacyMode = process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE ?? "(unset)";
  const secretKey = process.env.STRIPE_SECRET_KEY ?? "";
  const webhookSigningSecret = process.env.STRIPE_WEBHOOK_SIGNING_SECRET ?? "";
  const priceId = process.env.STRIPE_ACSS_PRICE_ID ?? "";

  const secretKeyPrefix = secretKey.slice(0, 8);
  const secretKeyIsTestMode = secretKey.startsWith("sk_test_");
  const secretKeyIsLiveMode = secretKey.startsWith("sk_live_");

  console.log(JSON.stringify({
    section: "mode_resolution",
    SPECTRE_STRIPE_SDK_MODE: sdkMode,
    SPECTRE_SIGNUP_2E_STRIPE_MODE: legacyMode,
    secretKeyPrefix,
    secretKeyIsTestMode,
    secretKeyIsLiveMode,
    secretKeyLength: secretKey.length || 0,
    webhookSigningSecretPresent: !!webhookSigningSecret,
    webhookSigningSecretLength: webhookSigningSecret.length || 0,
    acssPriceIdPresent: !!priceId,
    acssPriceIdMasked: maskId(priceId),
  }, null, 2));

  if (!secretKeyIsTestMode) {
    console.log(JSON.stringify({
      section: "abort",
      reason: !secretKey ? "STRIPE_SECRET_KEY not set" :
        secretKeyIsLiveMode ? "sk_live_ refused unconditionally" :
          "STRIPE_SECRET_KEY has an unexpected prefix",
    }));
    return;
  }

  // 1. Account identity + capabilities.
  const account = await stripeGet("/v1/account", secretKey);
  if (account.status === 200 && account.body) {
    const a = account.body;
    console.log(JSON.stringify({
      section: "account",
      idMasked: maskId(a.id),
      type: a.type,
      country: a.country,
      default_currency: a.default_currency,
      details_submitted: a.details_submitted,
      charges_enabled: a.charges_enabled,
      payouts_enabled: a.payouts_enabled,
      capability_acss_debit_payments: a.capabilities?.acss_debit_payments ?? null,
      requirements_currently_due_count: Array.isArray(a.requirements?.currently_due)
        ? a.requirements.currently_due.length : 0,
      requirements_currently_due_sample: Array.isArray(a.requirements?.currently_due)
        ? a.requirements.currently_due.slice(0, 5) : null,
    }, null, 2));
  } else {
    console.log(JSON.stringify({
      section: "account_error",
      status: account.status,
      message: account.body?.error?.message ?? account.raw?.slice(0, 200),
    }));
  }

  // 2. Price retrieve.
  if (priceId) {
    const price = await stripeGet(`/v1/prices/${encodeURIComponent(priceId)}`, secretKey);
    if (price.status === 200 && price.body) {
      const p = price.body;
      console.log(JSON.stringify({
        section: "price",
        idMasked: maskId(p.id),
        livemode: p.livemode,
        active: p.active,
        currency: p.currency,
        type: p.type,
        recurring_interval: p.recurring?.interval ?? null,
        recurring_interval_count: p.recurring?.interval_count ?? null,
        unit_amount: p.unit_amount,
        unit_amount_cad_dollars: typeof p.unit_amount === "number" ? p.unit_amount / 100 : null,
        productIdMasked: maskId(typeof p.product === "string" ? p.product : p.product?.id ?? null),
      }, null, 2));
    } else {
      console.log(JSON.stringify({
        section: "price_error",
        status: price.status,
        message: price.body?.error?.message ?? price.raw?.slice(0, 200),
      }));
    }
  }

  // 3. Webhook endpoints.
  const endpoints = await stripeGet("/v1/webhook_endpoints?limit=10", secretKey);
  if (endpoints.status === 200 && endpoints.body) {
    const expected = "staging.spectreautomation.com/api/webhooks/stripe";
    const summary = (endpoints.body.data || []).map((ep) => ({
      idMasked: maskId(ep.id),
      urlMatchesStaging: typeof ep.url === "string" && ep.url.includes(expected),
      urlHostDomain: typeof ep.url === "string" ? new URL(ep.url).host : null,
      status: ep.status,
      api_version: ep.api_version,
      enabled_events_count: Array.isArray(ep.enabled_events) ? ep.enabled_events.length : null,
      has_wildcard: Array.isArray(ep.enabled_events) && ep.enabled_events.includes("*"),
      has_payment_intent_processing:
        Array.isArray(ep.enabled_events) && (ep.enabled_events.includes("payment_intent.processing") || ep.enabled_events.includes("*")),
      has_setup_intent_succeeded:
        Array.isArray(ep.enabled_events) && (ep.enabled_events.includes("setup_intent.succeeded") || ep.enabled_events.includes("*")),
      has_invoice_paid:
        Array.isArray(ep.enabled_events) && (ep.enabled_events.includes("invoice.paid") || ep.enabled_events.includes("*")),
      has_invoice_payment_failed:
        Array.isArray(ep.enabled_events) && (ep.enabled_events.includes("invoice.payment_failed") || ep.enabled_events.includes("*")),
      has_customer_subscription_updated:
        Array.isArray(ep.enabled_events) && (ep.enabled_events.includes("customer.subscription.updated") || ep.enabled_events.includes("*")),
      has_customer_subscription_deleted:
        Array.isArray(ep.enabled_events) && (ep.enabled_events.includes("customer.subscription.deleted") || ep.enabled_events.includes("*")),
      has_mandate_updated:
        Array.isArray(ep.enabled_events) && (ep.enabled_events.includes("mandate.updated") || ep.enabled_events.includes("*")),
      has_charge_dispute_closed:
        Array.isArray(ep.enabled_events) && (ep.enabled_events.includes("charge.dispute.closed") || ep.enabled_events.includes("*")),
    }));
    console.log(JSON.stringify({
      section: "webhook_endpoints",
      totalEndpoints: summary.length,
      stagingEndpointPresent: summary.some((s) => s.urlMatchesStaging && s.status === "enabled"),
      endpoints: summary,
    }, null, 2));
  } else {
    console.log(JSON.stringify({
      section: "webhook_endpoints_error",
      status: endpoints.status,
      message: endpoints.body?.error?.message ?? endpoints.raw?.slice(0, 200),
    }));
  }

  console.log(JSON.stringify({
    section: "runtime_bundle_findings",
    stripe_npm_in_runtime_image: false,
    note: "Next.js standalone webpack-bundled `stripe` into route.js for /api/webhooks/stripe; the npm package is NOT present at /app/node_modules/stripe. The LIVE adapter (`src/lib/billing/stripe-adapter/live.ts`) imports `stripe` at the top level. Standalone tracing may or may not include the SDK outside the webhook route path at build time; this requires validation before flag-flip.",
  }, null, 2));

  console.log(JSON.stringify({
    section: "notes",
    acss_limit_api_note: "Stripe does NOT expose per-account ACSS Debit transaction-amount limits via API. Capability status is above. Numeric limit requires Stripe Support.",
    test_vs_live_note: "This script runs ONLY against sk_test_. Unconditionally refuses sk_live_.",
  }, null, 2));
}

main().catch((err) => {
  console.error("inspect failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
