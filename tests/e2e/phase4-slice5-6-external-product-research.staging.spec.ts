// Sprint 3 · Phase 4 Slice 5.6 (2026-08-09) — authenticated staging
// acceptance for external product intelligence subsystem.
//
// This spec verifies:
//   - externalResearchTrace is exposed for every real card;
//   - trigger fires ONLY on cards with material product-identity
//     ambiguity affecting accounting treatment (§14);
//   - preservation controls: DMM / 1087769 / OXIO / CPA never
//     trigger external research (§29-§31);
//   - when the provider is unconfigured (default), external
//     lookup count is 0 across the board;
//   - when the provider IS configured, evidence flows back through
//     the internal accounting chain (§20) — the ranker consumes
//     resolved identity via existing authorities.

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const availability = stagingCredsAvailable();

async function probe(page: Page, suffix4: string): Promise<any> {
  const res = await page.request.post(
    `${availability.baseURL}/api/ap-intelligence/inspect-wi`,
    { data: { wiIdSuffix4: suffix4 } },
  );
  expect(res.status(), `inspect-wi ${suffix4}`).toBe(200);
  return await res.json();
}

test.describe("Slice 5.6 · external product intelligence — real staging cards", () => {
  test.skip(!availability.ready, availability.reason ?? "");
  test.setTimeout(180_000);

  test("every real card returns externalResearchTrace with valid provider kind", async ({ context }) => {
    const page = await loginAsFounder(context);
    for (const suffix of ["vkbm", "8fk9", "7b0b", "73n5", "w3bz"]) {
      const r = await probe(page, suffix);
      const trace = r.analyseResult?.externalResearchTrace;
      expect(trace, `${suffix} externalResearchTrace present`).toBeTruthy();
      expect(trace.providerKind, `${suffix} providerKind is valid enum`).toMatch(
        /^(null|null-fallback|claude-web-search|test-injected)$/,
      );
      // §25: fingerprint and reason strings must always be surfaced
      // for auditability (fingerprint may be null when no primary
      // purchased-object candidate exists).
      expect(typeof trace.reason).toBe("string");
    }
  });

  test("preservation §29 §31 — DMM / OXIO / CPA / 1087769 never trigger external research", async ({ context }) => {
    const page = await loginAsFounder(context);
    // These four cards have internally-resolved product identity
    // (or no product identity at all — service / membership). None
    // should trigger externalCorroborationRequired.
    for (const suffix of ["8fk9", "7b0b", "73n5", "w3bz"]) {
      const r = await probe(page, suffix);
      const trace = r.analyseResult?.externalResearchTrace;
      expect(trace.externalLookupCount, `${suffix} zero external calls`).toBe(0);
      expect(trace.triggered, `${suffix} not triggered`).toBe(false);
    }
  });

  test("1091559 — externalResearchTrace exposes correct state given current provider config", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "vkbm");
    const trace = r.analyseResult?.externalResearchTrace;
    const pi = r.analyseResult?.productIdentityResolution;
    expect(trace).toBeTruthy();
    // The amended §10 Slice-5.5 trigger flags externalCorroboration-
    // Required for this document.
    expect(pi.externalCorroborationRequired).toBe(true);
    // Two acceptable states depending on staging config:
    //   (A) NullProvider active → considered=true, triggered=false,
    //       providerKind=null, externalLookupCount=0
    //   (B) claude-web-search active → considered=true, either
    //       cacheHit=true (repeat) or triggered=true + latency > 0
    if (trace.providerKind === "null" || trace.providerKind === "null-fallback") {
      expect(trace.considered).toBe(true);
      expect(trace.triggered).toBe(false);
      expect(trace.externalLookupCount).toBe(0);
    } else {
      // Provider is configured — either cache hit or live call
      expect(trace.considered).toBe(true);
      // Either cache hit OR live triggered
      expect(trace.cacheHit || trace.triggered).toBe(true);
    }
    // §25: fingerprint present (primary object has brand + model)
    expect(trace.fingerprint).not.toBeNull();
  });

  test("§20 — external evidence flows through internal chain, never writes GL directly", async ({ context }) => {
    const page = await loginAsFounder(context);
    // Regardless of provider config, capital / department / GL
    // authorities remain internal. Verify that gl / capital are
    // populated by internal authorities, not by any web string.
    const r = await probe(page, "vkbm");
    const capitalDiag = r.analyseResult?.purchasedItemIntelligence?.capitalDiagnostic ?? "";
    // Capital diagnostic must not carry raw source text — only
    // structured internal weights.
    expect(capitalDiag).not.toMatch(/https?:|\.com|\.net|\.org|amazon|google|bing/i);
    // Capital diagnostic must not carry amount / extension / total.
    expect(capitalDiag).not.toMatch(/\b(amount|extension|total)\b/i);
  });
});
