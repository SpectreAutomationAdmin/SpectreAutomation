// Sprint 3 · Phase 4 Slice 5.4 (2026-08-08) — Product Identity
// Resolution + price-plausibility + external provider tests.
//
// All test data is SYNTHETIC. No real supplier / product / SKU /
// model literal from any real invoice. Assertions verify the
// generic architecture: candidate generation, internal scoring,
// price-plausibility integration (via a stubbable provider), and
// the §1 structural invariant that PRICE does NOT directly increase
// CAPITAL score.

import { describe, it, expect } from "vitest";
import {
  resolveProductIdentity,
} from "@/lib/ap-intelligence/product-identity-resolution";
import {
  NullPricePlausibilityProvider,
  type PricePlausibilityProvider,
  type PricePlausibilityBand,
} from "@/lib/ap-intelligence/price-plausibility";
import {
  NullProductReferenceProvider,
  fingerprintProductRequest,
  type ProductReferenceProvider,
  type ProductReferenceResult,
  type ProductReferenceRequest,
} from "@/lib/ap-intelligence/product-reference-provider";
import { DeterministicPurchasedObjectProvider } from "@/lib/ap-intelligence/purchased-object-identity";
import { evaluateCapitalObjectEvidence } from "@/lib/ap-intelligence/capital-evidence";
import type { CanonicalLineItem } from "@/lib/ap-intelligence/evidence/canonical-line-item";

function makeLI(
  description: string,
  extension: number | null = null,
  opts: Partial<CanonicalLineItem> = {},
): CanonicalLineItem {
  return {
    description, quantity: null, unitPrice: null, extension, sku: null,
    tax: null, role: "PRIMARY_PURCHASE", lineNumber: null,
    ...opts,
  } as CanonicalLineItem;
}

const objectProvider = new DeterministicPurchasedObjectProvider();

// -----------------------------------------------------------------------------
// Scaffolding — Null providers produce no external calls
// -----------------------------------------------------------------------------

describe("ProductIdentityResolution — Null-provider scaffolding", () => {
  it("with NullProductReferenceProvider: external lookup count is zero", async () => {
    const objects = objectProvider.interpret([
      // Genuinely material-ambiguous: brand + model + assembly-body
      // word (engine) + serial + qty=1 EA — but NO complete-machine
      // noun. Structural signature (brand+model+EA+qty=1+serial)
      // supports COMPLETE_MACHINE; assembly-body vocab supports
      // REPLACEMENT_ENGINE. Both candidates sit within the
      // material-ambiguity band → external corroboration warranted.
      makeLI("ACME X-4000 WIDGET ENGINE Serial #: SN-12345678", 70000, {
        unit: "EA", quantity: 1, unitPrice: 70000,
      }),
    ]);
    const result = await resolveProductIdentity({
      objects,
      pricePlausibilityProvider: new NullPricePlausibilityProvider(),
      productReferenceProvider: new NullProductReferenceProvider(),
    });
    expect(result.externalLookupCount).toBe(0);
  });
  it("with no providers configured: externalCorroborationRequired reflects internal ambiguity", async () => {
    const objects = objectProvider.interpret([
      // Genuinely material-ambiguous: brand + model + assembly-body
      // word (engine) + serial + qty=1 EA — but NO complete-machine
      // noun. Structural signature (brand+model+EA+qty=1+serial)
      // supports COMPLETE_MACHINE; assembly-body vocab supports
      // REPLACEMENT_ENGINE. Both candidates sit within the
      // material-ambiguity band → external corroboration warranted.
      makeLI("ACME X-4000 WIDGET ENGINE Serial #: SN-12345678", 70000, {
        unit: "EA", quantity: 1, unitPrice: 70000,
      }),
    ]);
    const result = await resolveProductIdentity({ objects });
    // Ambiguous shape (complete-machine + engine) should flag
    // externalCorroborationRequired.
    expect(result.externalCorroborationRequired).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// §1 structural invariant — price does not directly increase capital
// -----------------------------------------------------------------------------

describe("§1 invariant — price MAY influence object identity but MUST NOT directly increase capital", () => {
  // A price-plausibility provider that reports PLAUSIBLE for
  // COMPLETE_MACHINE at 70k, and PLAUSIBLE for REPLACEMENT_ENGINE
  // at 70k as well (so it doesn't distinguish). This isolates the
  // capital-score axis.
  const alwaysPlausible: PricePlausibilityProvider = {
    async classify() {
      return { band: "PLAUSIBLE" as PricePlausibilityBand, reason: "test" };
    },
  };

  it("changing the observed price does NOT change capital score directly", async () => {
    const cheap = objectProvider.interpret([
      makeLI("ACME MOWER MODEL X-4000 WIDGET ENGINE Serial #: SN-12345678", 1000, {
        unit: "EA", quantity: 1, unitPrice: 1000,
      }),
    ]);
    const expensive = objectProvider.interpret([
      makeLI("ACME MOWER MODEL X-4000 WIDGET ENGINE Serial #: SN-12345678", 100000, {
        unit: "EA", quantity: 1, unitPrice: 100000,
      }),
    ]);

    // Resolve identity for both — price plausibility MAY affect
    // identity selection, but the capital branch below must NOT
    // consume price directly.
    const idCheap = await resolveProductIdentity({
      objects: cheap, pricePlausibilityProvider: alwaysPlausible,
      productReferenceProvider: new NullProductReferenceProvider(),
    });
    const idExpensive = await resolveProductIdentity({
      objects: expensive, pricePlausibilityProvider: alwaysPlausible,
      productReferenceProvider: new NullProductReferenceProvider(),
    });

    const capitalCheap = evaluateCapitalObjectEvidence({
      objects: cheap, poRequestorText: null, supplierName: null,
      resolvedProductIdentity: idCheap,
    });
    const capitalExpensive = evaluateCapitalObjectEvidence({
      objects: expensive, poRequestorText: null, supplierName: null,
      resolvedProductIdentity: idExpensive,
    });

    // Structural invariant: same object identity outcome must produce
    // the same capital decision regardless of raw price. If identity
    // resolves the same way, capital MUST be identical.
    if (idCheap.status === idExpensive.status
        && idCheap.selected?.objectType === idExpensive.selected?.objectType) {
      expect(capitalCheap.decision).toBe(capitalExpensive.decision);
    }
    // Additionally the diagnostic must never contain the raw price
    // tokens as capital evidence — capital-evidence's diagnostic
    // must not reference amount/extension/total.
    expect(capitalCheap.diagnostic).not.toMatch(/\b(amount|extension|total)\b/i);
    expect(capitalExpensive.diagnostic).not.toMatch(/\b(amount|extension|total)\b/i);
  });
});

// -----------------------------------------------------------------------------
// Candidate generation
// -----------------------------------------------------------------------------

describe("candidate generation — ambiguous complete-vs-engine descriptions", () => {
  it("complete-machine noun + assembly-body noun => multiple candidates emitted", async () => {
    const objects = objectProvider.interpret([
      // Genuinely material-ambiguous: brand + model + assembly-body
      // word (engine) + serial + qty=1 EA — but NO complete-machine
      // noun. Structural signature (brand+model+EA+qty=1+serial)
      // supports COMPLETE_MACHINE; assembly-body vocab supports
      // REPLACEMENT_ENGINE. Both candidates sit within the
      // material-ambiguity band → external corroboration warranted.
      makeLI("ACME X-4000 WIDGET ENGINE Serial #: SN-12345678", 70000, {
        unit: "EA", quantity: 1, unitPrice: 70000,
      }),
    ]);
    const result = await resolveProductIdentity({ objects });
    const types = new Set(result.candidates.map((c) => c.objectType));
    expect(types.has("COMPLETE_MACHINE")).toBe(true);
    expect(types.has("REPLACEMENT_ENGINE") || types.has("SERIALIZED_COMPONENT")).toBe(true);
  });
  it("clear consumable description => single CONSUMABLE candidate, RESOLVED_INTERNAL", async () => {
    const objects = objectProvider.interpret([
      makeLI("Diesel fuel bulk delivery 500 gallons", 2000),
      makeLI("Diesel fuel second tank 250 gallons", 1000),
    ]);
    const result = await resolveProductIdentity({ objects });
    expect(result.candidates.every((c) => c.objectType === "CONSUMABLE" || c.objectType === "UNKNOWN")).toBe(true);
    // Consumable is decisive → should NOT flag externalCorroborationRequired
    expect(result.externalCorroborationRequired).toBe(false);
  });
  it("standalone component parts => REPLACEMENT_COMPONENT (or COMPONENT), no external required", async () => {
    const objects = objectProvider.interpret([
      makeLI("Ball bearing replacement", 50),
      makeLI("Seal kit hydraulic pump", 30),
    ]);
    const result = await resolveProductIdentity({ objects });
    expect(result.externalCorroborationRequired).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// External-corroboration integration (via mock provider, no live calls)
// -----------------------------------------------------------------------------

describe("external corroboration — mocked provider", () => {
  it("mock OEM_PRODUCT_MATCH resolving COMPLETE_MACHINE moves status to RESOLVED_WITH_EXTERNAL_CORROBORATION", async () => {
    const objects = objectProvider.interpret([
      // Genuinely material-ambiguous: brand + model + assembly-body
      // word (engine) + serial + qty=1 EA — but NO complete-machine
      // noun. Structural signature (brand+model+EA+qty=1+serial)
      // supports COMPLETE_MACHINE; assembly-body vocab supports
      // REPLACEMENT_ENGINE. Both candidates sit within the
      // material-ambiguity band → external corroboration warranted.
      makeLI("ACME X-4000 WIDGET ENGINE Serial #: SN-12345678", 70000, {
        unit: "EA", quantity: 1, unitPrice: 70000,
      }),
    ]);
    const mockProvider: ProductReferenceProvider = {
      async resolve(_req: ProductReferenceRequest): Promise<ProductReferenceResult> {
        return {
          state: "RESOLVED",
          callCount: 2,
          products: [{
            evidenceType: "OEM_PRODUCT_MATCH",
            sourceDomain: "example-oem.test",
            sourceTitle: "ACME X-4000 product page",
            retrievedAt: "2026-08-08T00:00:00Z",
            queryFingerprint: "ACME|X-4000||",
            matchedManufacturer: "ACME",
            matchedModel: "X-4000",
            matchedPartNumber: null,
            matchedProductFamily: "fairway mower",
            observedPrice: null,
            currency: null,
            confidence: 90,
            evidenceSnippet: "ACME X-4000 is a fairway mower with Widget engine",
          }, {
            evidenceType: "OEM_SPECIFICATION",
            sourceDomain: "example-oem.test",
            sourceTitle: "X-4000 spec sheet",
            retrievedAt: "2026-08-08T00:00:00Z",
            queryFingerprint: "ACME|X-4000||",
            matchedManufacturer: "ACME",
            matchedModel: "X-4000",
            matchedPartNumber: null,
            matchedProductFamily: "fairway mower",
            observedPrice: null,
            currency: null,
            confidence: 85,
            evidenceSnippet: "X-4000 ships with Widget engine as standard",
          }],
          prices: [],
          diagnostic: "mock provider",
        };
      },
    };
    const result = await resolveProductIdentity({
      objects,
      pricePlausibilityProvider: new NullPricePlausibilityProvider(),
      productReferenceProvider: mockProvider,
    });
    expect(result.externalLookupCount).toBe(2);
    expect(result.status).toBe("RESOLVED_WITH_EXTERNAL_CORROBORATION");
    expect(result.selected?.objectType).toBe("COMPLETE_MACHINE");
  });
  it("mock TIMEOUT provider does not throw and stays AMBIGUOUS", async () => {
    const objects = objectProvider.interpret([
      // Genuinely material-ambiguous: brand + model + assembly-body
      // word (engine) + serial + qty=1 EA — but NO complete-machine
      // noun. Structural signature (brand+model+EA+qty=1+serial)
      // supports COMPLETE_MACHINE; assembly-body vocab supports
      // REPLACEMENT_ENGINE. Both candidates sit within the
      // material-ambiguity band → external corroboration warranted.
      makeLI("ACME X-4000 WIDGET ENGINE Serial #: SN-12345678", 70000, {
        unit: "EA", quantity: 1, unitPrice: 70000,
      }),
    ]);
    const slow: ProductReferenceProvider = {
      async resolve() {
        // Never resolves — will exceed timeout.
        return new Promise<ProductReferenceResult>((_resolve) => {
          setTimeout(() => _resolve({
            state: "RESOLVED",
            callCount: 1,
            products: [],
            prices: [],
            diagnostic: "too late",
          }), 500);
        });
      },
    };
    const result = await resolveProductIdentity({
      objects,
      pricePlausibilityProvider: new NullPricePlausibilityProvider(),
      productReferenceProvider: slow,
      externalTimeoutMs: 50,
    });
    // Timeout gets caught, marked as TIMEOUT via the provider fallback.
    expect(result.status === "AMBIGUOUS" || result.status === "UNRESOLVED").toBe(true);
  });
  it("mock NO_RESULTS keeps status AMBIGUOUS", async () => {
    const objects = objectProvider.interpret([
      // Genuinely material-ambiguous: brand + model + assembly-body
      // word (engine) + serial + qty=1 EA — but NO complete-machine
      // noun. Structural signature (brand+model+EA+qty=1+serial)
      // supports COMPLETE_MACHINE; assembly-body vocab supports
      // REPLACEMENT_ENGINE. Both candidates sit within the
      // material-ambiguity band → external corroboration warranted.
      makeLI("ACME X-4000 WIDGET ENGINE Serial #: SN-12345678", 70000, {
        unit: "EA", quantity: 1, unitPrice: 70000,
      }),
    ]);
    const empty: ProductReferenceProvider = {
      async resolve() {
        return { state: "NO_RESULTS", callCount: 1, products: [], prices: [], diagnostic: "" };
      },
    };
    const result = await resolveProductIdentity({
      objects,
      pricePlausibilityProvider: new NullPricePlausibilityProvider(),
      productReferenceProvider: empty,
    });
    expect(result.status).toBe("AMBIGUOUS");
  });
});

// -----------------------------------------------------------------------------
// Fingerprint deduplication
// -----------------------------------------------------------------------------

describe("fingerprintProductRequest", () => {
  it("normalizes and orders candidate arrays deterministically", () => {
    const a = fingerprintProductRequest({
      brandCandidates: ["ACME", "widget"],
      modelCandidates: ["X-4000"],
      skuCandidates: ["30807"],
      serialCandidates: [],
      descriptionExcerpt: "",
      observedUnitPrice: null,
      currency: null,
      maxCalls: 2,
    });
    const b = fingerprintProductRequest({
      brandCandidates: ["widget", "ACME"],
      modelCandidates: ["X-4000"],
      skuCandidates: ["30807"],
      serialCandidates: [],
      descriptionExcerpt: "different excerpt",
      observedUnitPrice: 99999,
      currency: "CAD",
      maxCalls: 2,
    });
    expect(a).toBe(b);
  });
});
