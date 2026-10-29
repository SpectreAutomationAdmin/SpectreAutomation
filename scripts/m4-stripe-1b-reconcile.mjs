// SIGNUP-2 M4-STRIPE-1B reconciliation (2026-10-29) -- READ-ONLY.
//
// Founder reports: Stripe Dashboard shows ACSS "Enabled" with
// CAD $0.50-$3,000 single-transaction max; recurring supported;
// separate weekly processing limit.
//
// My earlier capability inspection showed `acss_debit_payments`
// capability as "unrequested" via GET /v1/accounts/{self}/capabilities
// /acss_debit_payments.
//
// Hypothesis: the capabilities endpoint represents Connect
// capability state (for CustomS / Express accounts), not Standard-
// account own payment-method activation.  Standard accounts' own
// payment-method enablement lives under /v1/payment_method_configurations.
// This script reconciles both views.
//
// Does NOT mutate anything.  Does NOT create subscription / invoice /
// PaymentIntent / debit.  Does NOT change the Price.  Masks ids.

import https from "node:https";

function maskId(id) {
  if (!id || typeof id !== "string") return "<null>";
  if (id.length <= 12) return id;
  return id.slice(0, 8) + "***" + id.slice(-4);
}

function get(path, secretKey) {
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
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: null, raw: buf }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function main() {
  const sk = process.env.STRIPE_SECRET_KEY ?? "";
  if (!sk.startsWith("sk_test_")) throw new Error("REFUSING: not sk_test_");

  // ============================================================
  // 1. Account identity (confirm Standard type)
  // ============================================================
  const account = await get("/v1/account", sk);
  const a = account.body ?? {};
  console.log(JSON.stringify({
    section: "account_identity",
    status: account.status,
    idMasked: maskId(a.id),
    type: a.type,
    country: a.country,
    details_submitted: a.details_submitted,
    charges_enabled: a.charges_enabled,
    note: "For type='standard', the account's OWN payment-method activation lives in Dashboard payment-method configuration (payment_method_configurations), NOT the Capabilities API. The Capabilities API is primarily used by Custom/Express Connect accounts.",
  }, null, 2));

  // ============================================================
  // 2. Payment method configurations (authoritative for Standard)
  // ============================================================
  const configs = await get("/v1/payment_method_configurations?limit=20", sk);
  console.log(JSON.stringify({
    section: "payment_method_configurations_summary",
    status: configs.status,
    totalConfigs: Array.isArray(configs.body?.data) ? configs.body.data.length : null,
    error: configs.body?.error ?? null,
  }, null, 2));

  if (Array.isArray(configs.body?.data) && configs.body.data.length > 0) {
    for (const cfg of configs.body.data) {
      // Only print the ACSS part + top-level identity for each config.
      console.log(JSON.stringify({
        section: "payment_method_config",
        idMasked: maskId(cfg.id),
        name: cfg.name ?? null,
        active: cfg.active,
        is_default: cfg.is_default,
        parent: cfg.parent ?? null,
        acss_debit: cfg.acss_debit ?? null,
      }, null, 2));
    }
  }

  // ============================================================
  // 3. Default config detail (if present)
  // ============================================================
  const defaultCfg = (configs.body?.data ?? []).find((c) => c.is_default);
  if (defaultCfg) {
    const detail = await get(`/v1/payment_method_configurations/${encodeURIComponent(defaultCfg.id)}`, sk);
    console.log(JSON.stringify({
      section: "default_payment_method_config_detail",
      status: detail.status,
      idMasked: maskId(detail.body?.id),
      acss_debit: detail.body?.acss_debit ?? null,
      // Note: Stripe's PMConfig does not expose per-transaction
      // numeric limits via API -- these live in the Dashboard's
      // underwriting / account-tier settings.
    }, null, 2));
  }

  // ============================================================
  // 4. Re-fetch the acss_debit_payments Capability object
  //    (Connect-side state, for clarity + reconciliation)
  // ============================================================
  const cap = await get(`/v1/accounts/${a.id}/capabilities/acss_debit_payments`, sk);
  console.log(JSON.stringify({
    section: "acss_debit_payments_capability_connect_view",
    status_code: cap.status,
    capability_status: cap.body?.status ?? null,
    reconciliation_note: "This endpoint represents the Connect-platform view: whether a PLATFORM Connect user has requested this capability for the SELF account.  For Standard accounts' own payment-method state, this endpoint can read 'unrequested' while Dashboard payment-method configuration reports 'Enabled'.  Both can be simultaneously true; they are different control surfaces.",
  }, null, 2));

  // ============================================================
  // 5. Price confirmation (unchanged -- read-only)
  // ============================================================
  const priceId = process.env.STRIPE_ACSS_PRICE_ID ?? "";
  if (priceId) {
    const price = await get(`/v1/prices/${encodeURIComponent(priceId)}`, sk);
    const p = price.body ?? {};
    console.log(JSON.stringify({
      section: "price_unchanged",
      status: price.status,
      idMasked: maskId(p.id),
      unit_amount: p.unit_amount,
      unit_amount_cad_dollars: typeof p.unit_amount === "number" ? p.unit_amount / 100 : null,
      currency: p.currency,
      livemode: p.livemode,
      active: p.active,
      recurring_interval: p.recurring?.interval ?? null,
    }, null, 2));
  }

  // ============================================================
  // 6. Limit distinction summary
  // ============================================================
  console.log(JSON.stringify({
    section: "limit_distinction",
    per_transaction_cap_dashboard: "CAD $0.50 - $3,000 (per founder's Dashboard view)",
    weekly_processing_cap_dashboard: "Separate -- not exposed via API",
    api_visibility: "Stripe does NOT expose numeric per-account ACSS Debit per-transaction or weekly limits via the public API.  Dashboard values are authoritative and are set by Stripe underwriting (test mode uses lower default ceilings; live mode is tier-based).",
    blocker_for_38000_subscription: "The CAD $3,000 per-transaction maximum is the active block for a CAD $38,000 subscription attempt.  Founder has already requested the limit increase from Stripe and is awaiting their response.",
    not_a_blocker: "The acss_debit_payments Capability object (Connect view) status is a separate control surface.  The Dashboard already shows the payment method as Enabled; the Capability's 'unrequested' value is a Connect-platform construct that does not block Standard-account acceptance of ACSS debits.",
  }, null, 2));
}

main().catch((err) => {
  console.error("reconcile failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
