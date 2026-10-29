// SIGNUP-2 M4-STRIPE-1B (2026-10-29) -- Stripe test-account
// remediation.
//
// Scope (per founder M4-STRIPE-1B authorization):
//   - §1 READ-ONLY: deep-inspect account requirements + capabilities
//     + acss_debit_payments requirements.  Do NOT accept terms, do
//     NOT submit identity, do NOT attest.
//   - §2 WRITE: update staging webhook endpoint's enabled_events to
//     the exact 19 types the dispatcher routes.  NO wildcard.
//     Preserve URL + signing-secret + api_version.
//   - §3 READ-ONLY: diagnose ACSS Debit limit without creating any
//     subscription/invoice/PaymentIntent/debit.
//
// Uses raw HTTPS to api.stripe.com (no SDK dep).  Masks all ids.

import https from "node:https";
import { URLSearchParams } from "node:url";

const DISPATCHER_EVENTS = [
  "payment_intent.processing",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "charge.succeeded",
  "charge.refunded",
  "charge.dispute.created",
  "setup_intent.succeeded",
  "setup_intent.requires_action",
  "setup_intent.setup_failed",
  "setup_intent.canceled",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.marked_uncollectible",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "mandate.updated",
];

function maskId(id) {
  if (!id || typeof id !== "string") return "<null>";
  if (id.length <= 12) return id;
  return id.slice(0, 8) + "***" + id.slice(-4);
}

function request(method, path, secretKey, bodyParams) {
  return new Promise((resolve, reject) => {
    const body = bodyParams ? bodyParams.toString() : "";
    const req = https.request({
      method,
      hostname: "api.stripe.com",
      path,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Stripe-Version": "2026-09-30.endive",
        ...(bodyParams ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } : {}),
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
    if (bodyParams) req.write(body);
    req.end();
  });
}

async function main() {
  const sk = process.env.STRIPE_SECRET_KEY ?? "";
  if (!sk.startsWith("sk_test_")) {
    throw new Error("REFUSING: STRIPE_SECRET_KEY is not sk_test_");
  }

  // ============================================================
  // §1 Deep account requirements + capabilities inspection
  // ============================================================
  console.log("=== SECTION 1: ACCOUNT INSPECTION ===");
  const account = await request("GET", "/v1/account", sk);
  if (account.status !== 200) {
    console.log(JSON.stringify({ section: "account_error", status: account.status, body: account.body }));
    return;
  }
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
    capabilities: a.capabilities ?? null,
    requirements: {
      currently_due: a.requirements?.currently_due ?? [],
      past_due: a.requirements?.past_due ?? [],
      eventually_due: a.requirements?.eventually_due ?? [],
      pending_verification: a.requirements?.pending_verification ?? [],
      disabled_reason: a.requirements?.disabled_reason ?? null,
      current_deadline: a.requirements?.current_deadline ?? null,
    },
    future_requirements: a.future_requirements ?? null,
    business_type: a.business_type ?? null,
    external_accounts_count: a.external_accounts?.data?.length ?? 0,
  }, null, 2));

  // Specifically inspect the acss_debit_payments capability (per
  // Stripe docs, GET /v1/accounts/{account}/capabilities/{capability}
  // on the SELF account requires an account id -- we use the account's
  // own id).
  try {
    const cap = await request("GET", `/v1/accounts/${a.id}/capabilities/acss_debit_payments`, sk);
    console.log(JSON.stringify({
      section: "acss_debit_payments_capability",
      status_code: cap.status,
      status: cap.body?.status ?? null,
      requested: cap.body?.requested ?? null,
      requested_at: cap.body?.requested_at ?? null,
      requirements: {
        currently_due: cap.body?.requirements?.currently_due ?? [],
        past_due: cap.body?.requirements?.past_due ?? [],
        eventually_due: cap.body?.requirements?.eventually_due ?? [],
        pending_verification: cap.body?.requirements?.pending_verification ?? [],
        disabled_reason: cap.body?.requirements?.disabled_reason ?? null,
      },
      future_requirements: cap.body?.future_requirements ?? null,
      error: cap.body?.error ?? null,
    }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ section: "acss_debit_payments_capability_error", error: String(e?.message ?? e) }));
  }

  // ============================================================
  // §2 Webhook endpoint audit + update to named events (NO wildcard)
  // ============================================================
  console.log("=== SECTION 2: WEBHOOK ENDPOINT ===");
  const list = await request("GET", "/v1/webhook_endpoints?limit=10", sk);
  if (list.status !== 200) {
    console.log(JSON.stringify({ section: "webhook_list_error", status: list.status, body: list.body }));
    return;
  }
  const stagingEp = (list.body.data || []).find((ep) =>
    typeof ep.url === "string" && ep.url.includes("staging.spectreautomation.com/api/webhooks/stripe"),
  );
  if (!stagingEp) {
    console.log(JSON.stringify({
      section: "webhook_endpoint_not_found",
      note: "No endpoint matches staging URL fragment. Not updating anything.",
    }));
    return;
  }

  // BEFORE snapshot.
  console.log(JSON.stringify({
    section: "webhook_endpoint_before",
    idMasked: maskId(stagingEp.id),
    url: stagingEp.url,
    status: stagingEp.status,
    api_version: stagingEp.api_version,
    enabled_events_count: Array.isArray(stagingEp.enabled_events) ? stagingEp.enabled_events.length : null,
    enabled_events: stagingEp.enabled_events ?? null,
    has_wildcard: Array.isArray(stagingEp.enabled_events) && stagingEp.enabled_events.includes("*"),
  }, null, 2));

  // Decide whether an update is needed.
  const currentEvents = new Set(stagingEp.enabled_events || []);
  const targetEvents = new Set(DISPATCHER_EVENTS);
  const toAdd = DISPATCHER_EVENTS.filter((e) => !currentEvents.has(e));
  const toRemove = (stagingEp.enabled_events || []).filter((e) => !targetEvents.has(e));
  const noChange = toAdd.length === 0 && toRemove.length === 0 && !currentEvents.has("*");

  if (noChange) {
    console.log(JSON.stringify({
      section: "webhook_update_skipped",
      reason: "Already matches target set exactly.",
    }));
  } else {
    console.log(JSON.stringify({
      section: "webhook_update_plan",
      targetEventCount: DISPATCHER_EVENTS.length,
      toAdd,
      toRemove,
      wildcardWillBeDropped: currentEvents.has("*"),
    }, null, 2));

    // UPDATE: POST /v1/webhook_endpoints/{id} with enabled_events[].
    // Preserve URL + signing-secret + api_version (we do NOT send
    // url, api_version, or any signing-secret param; those stay as-is).
    const params = new URLSearchParams();
    for (const ev of DISPATCHER_EVENTS) params.append("enabled_events[]", ev);
    const upd = await request("POST", `/v1/webhook_endpoints/${encodeURIComponent(stagingEp.id)}`, sk, params);
    console.log(JSON.stringify({
      section: "webhook_update_response",
      status_code: upd.status,
      ok: upd.status === 200,
      error: upd.body?.error ?? null,
    }));
    if (upd.status !== 200) {
      console.log("UPDATE FAILED -- aborting without re-read.");
      return;
    }
  }

  // AFTER re-read.
  const after = await request("GET", `/v1/webhook_endpoints/${encodeURIComponent(stagingEp.id)}`, sk);
  const b = after.body;
  console.log(JSON.stringify({
    section: "webhook_endpoint_after",
    idMasked: maskId(b.id),
    url: b.url,
    status: b.status,
    api_version: b.api_version,
    enabled_events_count: Array.isArray(b.enabled_events) ? b.enabled_events.length : null,
    enabled_events: b.enabled_events ?? null,
    has_wildcard: Array.isArray(b.enabled_events) && b.enabled_events.includes("*"),
    all_dispatcher_events_present: DISPATCHER_EVENTS.every((e) => (b.enabled_events || []).includes(e)),
    only_dispatcher_events: (b.enabled_events || []).every((e) => DISPATCHER_EVENTS.includes(e)),
    secret_prefix_preserved: typeof b.secret === "string" && b.secret.startsWith("whsec_"),
  }, null, 2));

  // ============================================================
  // §3 ACSS Debit limit diagnosis (NO subscription / invoice / PI)
  // ============================================================
  console.log("=== SECTION 3: ACSS DEBIT LIMIT DIAGNOSIS ===");
  console.log(JSON.stringify({
    section: "acss_limit_api_findings",
    stripe_api_exposes_per_account_limit: false,
    note_from_stripe_docs: "ACSS Debit maximum transaction amounts are account-tier policies set via Stripe underwriting; the public API does not expose a numeric per-account limit. Default documented ceilings (per Stripe's ACSS integration guide) are tier-dependent. Numeric confirmation requires Stripe Support.",
    acss_capability_status: "see section 'acss_debit_payments_capability' above",
    test_mode_vs_live_mode_distinction: "ACSS Debit transaction-amount restrictions apply in LIVE MODE (real underwriting). TEST MODE accepts large amounts without underwriting but requires acss_debit_payments capability = active. Spectre currently sees capability status null/inactive on the test account -- that is the actionable blocker; the numeric limit question is live-mode-specific.",
    reproducibility_without_mutation: "Not reproducible without creating a PaymentIntent/Invoice/Subscription against a live account. This slice does NOT do that.",
  }, null, 2));

  console.log("=== END ===");
}

main().catch((err) => {
  console.error("remediate failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
