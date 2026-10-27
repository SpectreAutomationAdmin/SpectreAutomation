// SIGNUP-2 M2 ACSS Compatibility Audit (2026-10-27)
//
// Source-contract tests for the ACSS Debit mandate collection flow.
// Each test corresponds to one of Stripe's documented ACSS requirements
// for recurring annual CAD subscriptions.
//
// Sources (fetched 2026-10-27):
//   https://docs.stripe.com/payments/acss-debit
//   https://docs.stripe.com/payments/acss-debit/set-up-payment
//   https://docs.stripe.com/billing/subscriptions/acss-debit
//   https://docs.stripe.com/payments/checkout/save-and-reuse
//   https://docs.stripe.com/payments/acss-debit/custom-pad-agreement
//
// Requirements covered:
//   §1 Checkout mode = "setup" (subscription mode NOT supported for ACSS)
//   §2 Explicit payment_method_types = ["acss_debit"]
//   §3 default_for = ["invoice", "subscription"] on mandate_options
//      (so saved mandate serves future invoices + subscription renewals)
//   §4 setup_future_usage = "off_session" (so future renewals are
//      authorised without re-collecting mandate)
//   §5 payment_schedule = "interval" + interval_description (required
//      by ACSS)
//   §6 transaction_type = "business" (B2B PAD)
//   §7 currency = "cad"
//   §8 Subscription creation NOT via Checkout subscription mode --
//      uses stripe.subscriptions.create with saved default_payment_method
//      and payment_settings.payment_method_types = ["acss_debit"]

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LIVE = readFileSync(
  join(process.cwd(), "src/lib/billing/stripe-adapter/live.ts"),
  "utf8",
);
const MANDATE_SERVICE = readFileSync(
  join(process.cwd(), "src/lib/billing/signup-2e-mandate-service.ts"),
  "utf8",
);

describe("SIGNUP-2 M2 ACSS Compat §1 · Checkout uses setup mode (NOT subscription mode)", () => {
  it("createMandateCheckoutSession uses mode: 'setup'", () => {
    const block = LIVE.match(/async createMandateCheckoutSession[\s\S]+?^    \},/m)![0];
    expect(block).toMatch(/mode:\s*"setup"/);
    // Checkout subscription mode is NOT supported for ACSS per Stripe docs.
    expect(block).not.toMatch(/mode:\s*"subscription"/);
  });
});

describe("SIGNUP-2 M2 ACSS Compat §2 · payment_method_types explicitly set", () => {
  it("createMandateCheckoutSession sets payment_method_types: ['acss_debit']", () => {
    const block = LIVE.match(/async createMandateCheckoutSession[\s\S]+?^    \},/m)![0];
    expect(block).toMatch(/payment_method_types:\s*\[\s*"acss_debit"\s*\]/);
  });
});

describe("SIGNUP-2 M2 ACSS Compat §3 · default_for = ['invoice', 'subscription']", () => {
  it("mandate_options.default_for serves future invoices + subscription renewals", () => {
    const block = LIVE.match(/async createMandateCheckoutSession[\s\S]+?^    \},/m)![0];
    expect(block).toMatch(/default_for:\s*\[\s*"invoice",\s*"subscription"\s*\]/);
  });
});

describe("SIGNUP-2 M2 ACSS Compat §4 · setup_future_usage = 'off_session'", () => {
  it("ACSS setup_future_usage=off_session so future renewals are authorised", () => {
    const block = LIVE.match(/async createMandateCheckoutSession[\s\S]+?^    \},/m)![0];
    expect(block).toMatch(/setup_future_usage:\s*"off_session"/);
  });
});

describe("SIGNUP-2 M2 ACSS Compat §5 · payment_schedule = interval + interval_description", () => {
  it("mandate_options.payment_schedule=interval with interval_description", () => {
    const block = LIVE.match(/async createMandateCheckoutSession[\s\S]+?^    \},/m)![0];
    expect(block).toMatch(/payment_schedule:\s*"interval"/);
    expect(block).toMatch(/interval_description:\s*args\.acssMandate\.intervalDescription/);
  });

  it("mandate service passes an interval_description for annual Spectre subscription", () => {
    expect(MANDATE_SERVICE).toMatch(/intervalDescription:\s*"Annual Spectre subscription"/);
  });
});

describe("SIGNUP-2 M2 ACSS Compat §6 · transaction_type = business (B2B PAD)", () => {
  it("mandate_options.transaction_type=business", () => {
    const block = LIVE.match(/async createMandateCheckoutSession[\s\S]+?^    \},/m)![0];
    expect(block).toMatch(/transaction_type:\s*"business"/);
  });

  it("mandate service passes transactionType=business", () => {
    expect(MANDATE_SERVICE).toMatch(/transactionType:\s*"business"/);
  });
});

describe("SIGNUP-2 M2 ACSS Compat §7 · currency = cad", () => {
  it("ACSS currency=cad on the Checkout session", () => {
    const block = LIVE.match(/async createMandateCheckoutSession[\s\S]+?^    \},/m)![0];
    expect(block).toMatch(/currency:\s*"cad"/);
  });

  it("reconciliation expected currency = cad", () => {
    const recon = readFileSync(
      join(process.cwd(), "src/lib/billing/signup-2m2-reconciliation-service.ts"),
      "utf8",
    );
    expect(recon).toMatch(/EXPECTED_CURRENCY = "cad"/);
  });
});

describe("SIGNUP-2 M2 ACSS Compat §8 · subscription via API, NOT Checkout subscription mode", () => {
  it("createSubscription uses stripe.subscriptions.create (not another Checkout mode)", () => {
    const block = LIVE.match(/async createSubscription[\s\S]+?^    \},/m)![0];
    expect(block).toMatch(/stripe\.subscriptions\.create/);
    expect(block).not.toMatch(/stripe\.checkout\.sessions\.create[\s\S]+?mode:\s*"subscription"/);
  });

  it("subscription payment_settings.payment_method_types = ['acss_debit']", () => {
    const block = LIVE.match(/async createSubscription[\s\S]+?^    \},/m)![0];
    expect(block).toMatch(/payment_method_types:\s*\[\s*"acss_debit"\s*\]/);
  });

  it("subscription payment_behavior = 'default_incomplete' (invoice settles via webhook)", () => {
    const block = LIVE.match(/async createSubscription[\s\S]+?^    \},/m)![0];
    expect(block).toMatch(/payment_behavior:\s*"default_incomplete"/);
  });

  it("subscription saves the collected payment method as default", () => {
    const block = LIVE.match(/async createSubscription[\s\S]+?^    \},/m)![0];
    expect(block).toMatch(/save_default_payment_method:\s*"on_subscription"/);
  });

  it("subscription uses the mandate-collected default_payment_method (not a new PaymentMethod)", () => {
    const block = LIVE.match(/async createSubscription[\s\S]+?^    \},/m)![0];
    expect(block).toMatch(/default_payment_method:\s*args\.defaultPaymentMethodId/);
  });
});

describe("SIGNUP-2 M2 ACSS Compat · persistSignedMandate records mandate + payment method", () => {
  it("persistSignedMandate reads stripeMandateId + stripePaymentMethodId from Checkout result", () => {
    expect(MANDATE_SERVICE).toMatch(/stripeMandateId:\s*sessionResult\.mandateId/);
    expect(MANDATE_SERVICE).toMatch(/stripePaymentMethodId:\s*sessionResult\.paymentMethodId/);
  });

  it("records mandateType=ACSS_DEBIT and transactionType=BUSINESS", () => {
    expect(MANDATE_SERVICE).toMatch(/mandateType:\s*"ACSS_DEBIT"/);
    expect(MANDATE_SERVICE).toMatch(/transactionType:\s*"BUSINESS"/);
  });
});

describe("SIGNUP-2 M2 ACSS Compat · evidenceSource preserved end-to-end", () => {
  it("createMandateCheckoutSession returns evidenceSource='live-stripe'", () => {
    const block = LIVE.match(/async createMandateCheckoutSession[\s\S]+?^    \},/m)![0];
    expect(block).toMatch(/evidenceSource:\s*"live-stripe"/);
  });

  it("createSubscription returns evidenceSource='live-stripe'", () => {
    const block = LIVE.match(/async createSubscription[\s\S]+?^    \},/m)![0];
    expect(block).toMatch(/evidenceSource:\s*"live-stripe"/);
  });

  it("retrieveCheckoutSession returns evidenceSource='live-stripe'", () => {
    const block = LIVE.match(/async retrieveCheckoutSession[\s\S]+?^    \},/m)![0];
    expect(block).toMatch(/evidenceSource:\s*"live-stripe"/);
  });
});
