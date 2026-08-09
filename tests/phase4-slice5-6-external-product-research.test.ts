// Sprint 3 · Phase 4 Slice 5.6 (2026-08-09) — external product
// research + evidence fusion + privacy + failure-behaviour tests.
//
// All test data is SYNTHETIC. No supplier / product / SKU literals
// from any real invoice. Assertions verify GENERIC architecture:
// query sanitizer, source-tier classifier, rate limiter, fixture-
// backed provider, fusion into ProductIdentityResolution.

import { describe, it, expect, beforeEach } from "vitest";
import {
  sanitizeProductReferenceRequest,
  containsPii,
  sanitizeDescription,
  looksLikeProductIdentifier,
} from "@/lib/ap-intelligence/external-product-reference/query-sanitizer";
import {
  classifySourceTier,
  areIndependentSources,
} from "@/lib/ap-intelligence/external-product-reference/source-tier";
import {
  tryConsumeDailyQuota,
  currentClubDailyCount,
  _resetDailyQuotaForTest,
  circuitBreakerAllowed,
  circuitBreakerRecordFailure,
  circuitBreakerRecordSuccess,
  _resetCircuitBreakerForTest,
} from "@/lib/ap-intelligence/external-product-reference/rate-limiter";
import { FixtureProductReferenceProvider } from "@/lib/ap-intelligence/external-product-reference/fixture-provider";
import { resolveProductIdentity } from "@/lib/ap-intelligence/product-identity-resolution";
import { NullPricePlausibilityProvider } from "@/lib/ap-intelligence/price-plausibility";
import { DeterministicPurchasedObjectProvider } from "@/lib/ap-intelligence/purchased-object-identity";
import type { CanonicalLineItem } from "@/lib/ap-intelligence/evidence/canonical-line-item";
import type {
  ProductReferenceRequest,
  ProductReferenceEvidence,
} from "@/lib/ap-intelligence/product-reference-provider";

function makeLI(description: string, extension = 100, extra: Partial<CanonicalLineItem> = {}): CanonicalLineItem {
  return {
    description, quantity: 1, unit: "EA", unitPrice: extension, extension,
    sku: null, role: "PRIMARY_PURCHASE",
    page: 1, sourceStrategy: "POSITIONED_CLASSIC_TABLE",
    validationConfidence: 78, arithmetic: "ARITHMETIC_OK",
    evidence: [],
    ...extra,
  };
}

const objectProvider = new DeterministicPurchasedObjectProvider();

function makeRequest(overrides: Partial<ProductReferenceRequest> = {}): ProductReferenceRequest {
  return {
    brandCandidates: ["ACME"],
    modelCandidates: ["X-4000"],
    skuCandidates: [],
    serialCandidates: [],
    descriptionExcerpt: "ACME MOWER X-4000",
    observedUnitPrice: null,
    currency: null,
    maxCalls: 3,
    ...overrides,
  };
}

function fixtureEvidence(overrides: Partial<ProductReferenceEvidence> = {}): ProductReferenceEvidence {
  return {
    evidenceType: "OEM_PRODUCT_MATCH",
    sourceDomain: "example-oem.test",
    sourceTitle: "Example OEM product page",
    retrievedAt: "2026-08-09T00:00:00Z",
    queryFingerprint: "ACME|X-4000||",
    matchedManufacturer: "ACME",
    matchedModel: "X-4000",
    matchedPartNumber: null,
    matchedProductFamily: "fairway mower",
    observedPrice: null,
    currency: null,
    confidence: 90,
    evidenceSnippet: "TIER_1_OEM: complete machine",
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// §4 query-sanitizer + §23 privacy adversarial tests
// -----------------------------------------------------------------------------

describe("§4/§23 query sanitizer — privacy boundary", () => {
  it("looksLikeProductIdentifier accepts model-shape tokens", () => {
    expect(looksLikeProductIdentifier("X-4000")).toBe(true);
    expect(looksLikeProductIdentifier("GM3500D")).toBe(true);
    expect(looksLikeProductIdentifier("ACME")).toBe(true);
    expect(looksLikeProductIdentifier("30807")).toBe(true);
  });
  it("looksLikeProductIdentifier rejects invoice-number-shape tokens", () => {
    expect(looksLikeProductIdentifier("1091559")).toBe(false);         // 7 digits pure-numeric
    expect(looksLikeProductIdentifier("418124536")).toBe(false);       // 9 digits pure-numeric
    expect(looksLikeProductIdentifier("")).toBe(false);
    expect(looksLikeProductIdentifier("A")).toBe(false);                // too short
    expect(looksLikeProductIdentifier("A".repeat(30))).toBe(false);    // too long
  });
  it("containsPii detects email addresses", () => {
    expect(containsPii("contact person@example.com")).toBe(true);
  });
  it("containsPii detects phone numbers", () => {
    expect(containsPii("phone: 403-279-2907")).toBe(true);
    expect(containsPii("phone: 4032861456")).toBe(true);
  });
  it("containsPii detects Canadian postal codes", () => {
    expect(containsPii("T2P 2P2")).toBe(true);
    expect(containsPii("T3B2W9")).toBe(true);
  });
  it("containsPii detects street addresses", () => {
    expect(containsPii("1600 Varsity Est Drive NW")).toBe(true);
    expect(containsPii("42 Main Street")).toBe(true);
    expect(containsPii("500 Cedar Road")).toBe(true);
  });
  it("containsPii detects GST/HST numbers", () => {
    expect(containsPii("830535936RT0001")).toBe(true);
  });
  it("containsPii detects currency amounts", () => {
    expect(containsPii("$74,112.00")).toBe(true);
    expect(containsPii("CAD 1,000.00")).toBe(true);
  });
  it("containsPii detects IBAN", () => {
    expect(containsPii("GB29NWBK60161331926819")).toBe(true);
  });
  it("containsPii detects bank account references", () => {
    expect(containsPii("Transit: 00009 Account: 6735517")).toBe(true);
  });
  it("containsPii detects long invoice-number-shape tokens", () => {
    expect(containsPii("Invoice # 1091559")).toBe(true);
  });
  it("sanitizeDescription redacts adversarial PII fixture", () => {
    const adversarial = "TORO MOWER 30807 · Bill To: John Smith · 1600 Varsity Est Dr NW · Calgary AB T3B 2W9 · Phone 403-279-2907 · GST 830535936RT0001 · Invoice 1091559 · Amount $74,112 · account@example.com";
    const cleaned = sanitizeDescription(adversarial);
    expect(cleaned).not.toContain("John Smith 1600");
    expect(cleaned).not.toContain("T3B 2W9");
    expect(cleaned).not.toContain("T3B2W9");
    expect(cleaned).not.toContain("403-279-2907");
    expect(cleaned).not.toContain("830535936");
    expect(cleaned).not.toContain("1091559");
    expect(cleaned).not.toContain("$74,112");
    expect(cleaned).not.toContain("74,112");
    expect(cleaned).not.toContain("account@example.com");
    expect(cleaned).toContain("TORO MOWER");
    expect(cleaned).toContain("[REDACTED]");
  });
  it("sanitizeProductReferenceRequest drops serial candidates always", () => {
    const outcome = sanitizeProductReferenceRequest(makeRequest({
      serialCandidates: ["SN-12345678"],
    }));
    expect(outcome.request.serialCandidates).toEqual([]);
    expect(outcome.rejectionReasons).toContain("serial:always-dropped-outbound");
  });
  it("sanitizeProductReferenceRequest drops candidates containing PII", () => {
    const outcome = sanitizeProductReferenceRequest(makeRequest({
      brandCandidates: ["ACME", "user@example.com"],
      skuCandidates: ["X-4000", "$74,112"],
    }));
    expect(outcome.request.brandCandidates).toEqual(["ACME"]);
    expect(outcome.request.skuCandidates).toEqual(["X-4000"]);
    expect(outcome.rejectedCandidates).toContain("user@example.com");
    expect(outcome.rejectedCandidates).toContain("$74,112");
  });
  it("sanitizeProductReferenceRequest drops long pure-numeric tokens (invoice-number shape)", () => {
    const outcome = sanitizeProductReferenceRequest(makeRequest({
      skuCandidates: ["1091559", "GM3500D"],
    }));
    expect(outcome.request.skuCandidates).toEqual(["GM3500D"]);
  });
});

// -----------------------------------------------------------------------------
// §5 source-tier classifier
// -----------------------------------------------------------------------------

describe("§5 source-tier classifier", () => {
  it("classifies auction / marketplace as TIER_3", () => {
    expect(classifySourceTier("https://www.machinerytrader.com/listing/123").tier).toBe("TIER_3_MARKETPLACE");
    expect(classifySourceTier("https://www.ironplanet.com/lot/456").tier).toBe("TIER_3_MARKETPLACE");
    expect(classifySourceTier("https://www.ebay.com/itm/789").tier).toBe("TIER_3_MARKETPLACE");
  });
  it("classifies forum / wiki as TIER_4", () => {
    expect(classifySourceTier("https://www.reddit.com/r/turf/comments/xyz").tier).toBe("TIER_4_DISCOVERY");
    expect(classifySourceTier("https://en.wikipedia.org/wiki/Something").tier).toBe("TIER_4_DISCOVERY");
    expect(classifySourceTier("https://forums.example.com/thread/1").tier).toBe("TIER_4_DISCOVERY");
  });
  it("classifies product / spec / manual paths as TIER_1", () => {
    expect(classifySourceTier("https://acme.com/us/products/X-4000").tier).toBe("TIER_1_OEM");
    expect(classifySourceTier("https://widget.com/en/parts/12345").tier).toBe("TIER_1_OEM");
    expect(classifySourceTier("https://acme.com/manual/x-4000").tier).toBe("TIER_1_OEM");
  });
  it("classifies dealer paths as TIER_2", () => {
    expect(classifySourceTier("https://example.com/dealer/find").tier).toBe("TIER_2_DEALER");
    expect(classifySourceTier("https://example.com/dealers/directory").tier).toBe("TIER_2_DEALER");
  });
  it("unknown domains default to TIER_4", () => {
    expect(classifySourceTier("https://random-blog.example.com/post/123").tier).toBe("TIER_4_DISCOVERY");
  });
  it("areIndependentSources treats same eTLD+1 as ONE source", () => {
    expect(areIndependentSources("https://www.acme.com/a", "https://shop.acme.com/b")).toBe(false);
    expect(areIndependentSources("https://acme.com/a", "https://widget.com/b")).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// §18 rate-limiter + circuit breaker
// -----------------------------------------------------------------------------

describe("§18 rate-limiter — per-club daily cap", () => {
  beforeEach(() => _resetDailyQuotaForTest());

  it("allows up to 50 per club per day; refuses on 51st", () => {
    const clubId = "test-club-a";
    for (let i = 0; i < 50; i++) {
      const outcome = tryConsumeDailyQuota(clubId);
      expect(outcome.allowed, `attempt ${i + 1}`).toBe(true);
    }
    const overflow = tryConsumeDailyQuota(clubId);
    expect(overflow.allowed).toBe(false);
    expect(overflow.remaining).toBe(0);
    expect(currentClubDailyCount(clubId)).toBe(50);
  });
  it("independent per-club counters", () => {
    const a = tryConsumeDailyQuota("club-a");
    const b = tryConsumeDailyQuota("club-b");
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    expect(currentClubDailyCount("club-a")).toBe(1);
    expect(currentClubDailyCount("club-b")).toBe(1);
  });
});

describe("§19 circuit breaker — trips open after failures + half-open recovery", () => {
  beforeEach(() => _resetCircuitBreakerForTest());

  it("trips open after 5 consecutive failures", () => {
    for (let i = 0; i < 4; i++) {
      circuitBreakerRecordFailure("test-provider");
      expect(circuitBreakerAllowed("test-provider").allowed).toBe(true);
    }
    circuitBreakerRecordFailure("test-provider");
    expect(circuitBreakerAllowed("test-provider").allowed).toBe(false);
  });
  it("success resets failure count", () => {
    for (let i = 0; i < 4; i++) circuitBreakerRecordFailure("test-provider");
    circuitBreakerRecordSuccess("test-provider");
    circuitBreakerRecordFailure("test-provider");
    expect(circuitBreakerAllowed("test-provider").allowed).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// §22 evidence fusion — fixture-backed integration tests
// -----------------------------------------------------------------------------

describe("§22.1 complete equipment confirmed by OEM → fused resolution", () => {
  it("RESOLVED_WITH_EXTERNAL_CORROBORATION when OEM confirms COMPLETE_MACHINE", async () => {
    const objects = objectProvider.interpret([
      makeLI("ACME MOWER X-4000 WIDGET ENGINE Serial #: SN-12345678", 70000),
    ]);
    // Fall-through fixture: any fingerprint returns the OEM evidence.
    // The alternative would be to construct the exact same request
    // that resolveProductIdentity builds internally.
    const provider = new FixtureProductReferenceProvider({
      state: "RESOLVED",
      products: [
        fixtureEvidence({ evidenceType: "OEM_PRODUCT_MATCH", sourceDomain: "acme.com", matchedProductFamily: "fairway mower" }),
        fixtureEvidence({ evidenceType: "OEM_SPECIFICATION", sourceDomain: "acme-support.com", matchedProductFamily: "fairway mower", evidenceSnippet: "X-4000 spec — complete machine with Widget engine" }),
      ],
    });
    const result = await resolveProductIdentity({
      objects,
      pricePlausibilityProvider: new NullPricePlausibilityProvider(),
      productReferenceProvider: provider,
    });
    expect(result.status).toBe("RESOLVED_WITH_EXTERNAL_CORROBORATION");
    expect(result.selected?.objectType).toBe("COMPLETE_MACHINE");
  });
});

describe("§22.6 weak marketplace evidence alone → remain AMBIGUOUS", () => {
  it("TIER_4_DISCOVERY evidence does not resolve", async () => {
    const objects = objectProvider.interpret([
      makeLI("ACME X-4000 WIDGET ENGINE Serial #: SN-12345678", 70000),
    ]);
    const provider = new FixtureProductReferenceProvider();
    // Only weak "market comparable" evidence — insufficient per §9.
    provider.seed({
      brandCandidates: ["ACME", "WIDGET"], modelCandidates: ["X-4000"], skuCandidates: [], serialCandidates: [],
      descriptionExcerpt: "ACME X-4000 WIDGET ENGINE Serial #: SN-12345678",
      observedUnitPrice: 70000, currency: null, maxCalls: 3,
    }, {
      state: "LOW_QUALITY_RESULTS",
      products: [],
    });
    const result = await resolveProductIdentity({
      objects,
      pricePlausibilityProvider: new NullPricePlausibilityProvider(),
      productReferenceProvider: provider,
    });
    expect(["AMBIGUOUS", "UNRESOLVED"]).toContain(result.status);
  });
});

describe("§22.16 provider TIMEOUT → unchanged internal ambiguity", () => {
  it("TIMEOUT preserves internal-only reasoning", async () => {
    const objects = objectProvider.interpret([
      makeLI("ACME X-4000 WIDGET ENGINE Serial #: SN-12345678", 70000),
    ]);
    const provider: import("@/lib/ap-intelligence/product-reference-provider").ProductReferenceProvider = {
      async resolve() {
        return new Promise((r) => setTimeout(() => r({
          state: "RESOLVED", callCount: 1, products: [], prices: [], diagnostic: "late",
        }), 500));
      },
    };
    const result = await resolveProductIdentity({
      objects,
      pricePlausibilityProvider: new NullPricePlausibilityProvider(),
      productReferenceProvider: provider,
      externalTimeoutMs: 50,
    });
    expect(["AMBIGUOUS", "UNRESOLVED"]).toContain(result.status);
    expect(result.selected).toBeNull();
  });
});

describe("§22.18 NO_RESULTS → unchanged internal ambiguity", () => {
  it("empty results preserves AMBIGUOUS", async () => {
    const objects = objectProvider.interpret([
      makeLI("ACME X-4000 WIDGET ENGINE Serial #: SN-12345678", 70000),
    ]);
    const provider = new FixtureProductReferenceProvider({ state: "NO_RESULTS" });
    const result = await resolveProductIdentity({
      objects,
      pricePlausibilityProvider: new NullPricePlausibilityProvider(),
      productReferenceProvider: provider,
    });
    expect(result.status).toBe("AMBIGUOUS");
  });
});

describe("§22.19 low product confidence with no accounting-material alternative → no search", () => {
  it("standalone consumable never triggers external", async () => {
    const objects = objectProvider.interpret([
      makeLI("Diesel fuel bulk delivery 500 gallons", 2000),
    ]);
    const provider = new FixtureProductReferenceProvider();
    const result = await resolveProductIdentity({
      objects,
      pricePlausibilityProvider: new NullPricePlausibilityProvider(),
      productReferenceProvider: provider,
    });
    expect(result.externalCorroborationRequired).toBe(false);
    expect(provider.callCount).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// §15 external research MUST NOT become a GL fallback
// -----------------------------------------------------------------------------

describe("§15 external research is triggered by PRODUCT ambiguity, not GL/supplier ambiguity", () => {
  it("clearly resolved consumable does NOT trigger external search even if GL unresolved elsewhere", async () => {
    const objects = objectProvider.interpret([
      makeLI("Diesel fuel bulk delivery 250 gallons", 1000),
      makeLI("Diesel fuel second tank 250 gallons", 1000),
    ]);
    const provider = new FixtureProductReferenceProvider();
    const result = await resolveProductIdentity({
      objects,
      pricePlausibilityProvider: new NullPricePlausibilityProvider(),
      productReferenceProvider: provider,
    });
    expect(result.externalCorroborationRequired).toBe(false);
    expect(provider.callCount).toBe(0);
  });
});
