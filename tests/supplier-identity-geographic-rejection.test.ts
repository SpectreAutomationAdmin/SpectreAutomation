// Sprint 3 · Phase 4R Phase B (2026-08-15) §B1 + §B2 — supplier
// identity address-vs-legal-name discipline in the PRIMARY runtime
// extractor (`evidence/supplier-identity.ts`).
//
// The legacy `supplier-extract.ts` fixes cover the fallback path
// only. The current-primary path selects the winning supplier via
// `selectSupplierFromText` from `evidence/supplier-identity.ts` →
// `evidence/supplier-ranker.ts` → `selectCanonicalFields`. This suite
// pins the primary-path behaviour of the new
// `isPureGeographicPhrase` predicate and the HEADER_ORG_TEXT emitter
// that consumes it.
//
// No brand/vendor-specific literals. No Microsoft rule. No Canada
// blacklist that reaches the winner-selection layer — just a
// principled address-vs-identity discipline at the evidence-emission
// layer.

import { describe, it, expect } from "vitest";
import {
  collectTextSupplierEvidence,
  selectSupplierFromText,
  isPureGeographicPhrase,
} from "@/lib/ap-intelligence/evidence/supplier-identity";

// ---------------------------------------------------------------------------
// §B1 — isPureGeographicPhrase unit contract
// ---------------------------------------------------------------------------

describe("isPureGeographicPhrase — pure-geographic phrase detector", () => {
  it("bare country name is pure geographic", () => {
    expect(isPureGeographicPhrase("Canada")).toBe(true);
    expect(isPureGeographicPhrase("USA")).toBe(true);
    expect(isPureGeographicPhrase("United States")).toBe(true);
    expect(isPureGeographicPhrase("United Kingdom")).toBe(true);
  });

  it("bare province / state name is pure geographic", () => {
    expect(isPureGeographicPhrase("Alberta")).toBe(true);
    expect(isPureGeographicPhrase("Ontario")).toBe(true);
    expect(isPureGeographicPhrase("British Columbia")).toBe(true);
    expect(isPureGeographicPhrase("Washington")).toBe(true);
    expect(isPureGeographicPhrase("California")).toBe(true);
  });

  it("2-3 word geographic combinations are pure geographic", () => {
    // City tokens are NOT in the geographic set, so these compositions
    // are validated by their all-geographic tokens:
    expect(isPureGeographicPhrase("Alberta Canada")).toBe(true);
    expect(isPureGeographicPhrase("Washington USA")).toBe(true);
  });

  it("legal names containing a geographic token are NOT pure geographic", () => {
    expect(isPureGeographicPhrase("Canada Golf Supply Inc")).toBe(false);
    expect(isPureGeographicPhrase("Alberta Equipment Ltd")).toBe(false);
    expect(isPureGeographicPhrase("Ontario Turf Products")).toBe(false);
    expect(isPureGeographicPhrase("Silver Springs Golf")).toBe(false);
  });

  it("city + non-geographic token is NOT pure geographic", () => {
    // Cities are not in the geographic set — a city name alone would
    // fail this predicate, and the HEADER_ORG_TEXT emitter has other
    // guards for city-only lines (stoplist etc.). But paired with a
    // non-geographic word like 'Golf' the phrase is not pure
    // geographic.
    expect(isPureGeographicPhrase("Calgary Golf")).toBe(false);
  });

  it("empty / whitespace input is not pure geographic (predicate)", () => {
    expect(isPureGeographicPhrase("")).toBe(false);
    expect(isPureGeographicPhrase("   ")).toBe(false);
  });

  it("phrases longer than 4 tokens are not classified geographic", () => {
    // Guard against pathological long inputs that might accidentally
    // match. The predicate is scoped to address-fragment shapes.
    expect(isPureGeographicPhrase("Canada Canada Canada Canada Canada"))
      .toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §B2 — HEADER_ORG_TEXT emitter rejects pure-geographic candidates
// ---------------------------------------------------------------------------

describe("HEADER_ORG_TEXT — rejects pure-geographic emissions", () => {
  it("bare 'Canada' line does NOT become a HEADER_ORG_TEXT evidence", () => {
    // Minimal reproduction of the Sold-To/Bill-To column shape.
    const text = [
      "Invoice",
      "Coulee Ridge Golf & Country Club",
      "1515 25th Ave SW",
      "Calgary AB T2T 0Z7",
      "Canada",
    ].join("\n");
    const evidence = collectTextSupplierEvidence(text);
    const headers = evidence.filter((e) => e.type === "HEADER_ORG_TEXT");
    const values = headers.map((e) => e.value);
    expect(values).not.toContain("Canada");
  });

  it("bare 'USA' line does NOT become a HEADER_ORG_TEXT evidence", () => {
    const text = [
      "Invoice",
      "Some Recipient",
      "One Recipient Way",
      "Redmond WA 98052",
      "USA",
    ].join("\n");
    const evidence = collectTextSupplierEvidence(text);
    const headers = evidence.filter((e) => e.type === "HEADER_ORG_TEXT");
    const values = headers.map((e) => e.value);
    expect(values).not.toContain("USA");
    expect(values).not.toContain("United States");
  });

  it("'Alberta Canada' 2-word line does NOT become HEADER_ORG_TEXT", () => {
    const text = [
      "Invoice Number: TEST-1",
      "Some Recipient",
      "Alberta Canada",
    ].join("\n");
    const evidence = collectTextSupplierEvidence(text);
    const headers = evidence.filter((e) => e.type === "HEADER_ORG_TEXT");
    expect(headers.map((e) => e.value)).not.toContain("Alberta Canada");
  });
});

// ---------------------------------------------------------------------------
// §B7 — Microsoft-shape end-to-end selection (generic name, no
// vendor-specific literal in production code)
// ---------------------------------------------------------------------------

describe("selectSupplierFromText — three-column recipient + legal footer", () => {
  it("bare Canada in three recipient columns does NOT beat a legal footer", () => {
    // Reproduces the Microsoft #E0701097E3 pdf-parse text-projection
    // shape without any Microsoft-specific literal in the production
    // code path. The extractor picks the LEGAL_ENTITY_TEXT line
    // (Example Software Corporation) over the geographic fragments.
    const text = [
      "Invoice",
      "Invoice Date: 2026-08-15",
      "Invoice Number: TEST-E0701097E3",
      "31.29 CAD",
      "",
      "Sold-To                                 Bill-To                               Service Usage Address",
      "Spectre Automation",
      "1515 25th Ave SW                        Spectre Automation                    Spectre Automation",
      "Calgary ab T2T 0Z7                      1515 25th Ave SW                      1515 25th Ave SW",
      "Canada                                  Calgary ab T2T 0Z7                    Calgary ab T2T 0Z7",
      "                                        Canada                                Canada",
      "",
      "Order Details",
      "Product: Business Standard - 1Year Commit Paid Monthly",
      "",
      "                                Example Software Corporation, One Example Way, Seattle WA 98101, United States",
      "                                                  GST/HST 123456789RT0001",
    ].join("\n");
    const result = selectSupplierFromText(text);
    const picked = result.diagnostic.selectedSupplier ?? result.winner?.displayName ?? null;
    expect(picked).toBeTruthy();
    // Winner must be the legal entity, not a country token.
    expect(picked).not.toMatch(/^Canada\b/i);
    expect(picked).not.toMatch(/^United States/i);
    expect(picked).toMatch(/Example Software Corporation/i);
  });

  it("simple legal name at top wins over any bare country footer", () => {
    const text = [
      "Cloud Reseller Partners Inc.",
      "555 Enterprise Way",
      "Toronto ON M5V 3B2",
      "GST# 800800800 RT0001",
      "",
      "INVOICE",
      "Invoice CRP-A26-9977",
      "",
      "Bill To:",
      "Coulee Ridge Golf & Country Club",
      "Canada",
    ].join("\n");
    const result = selectSupplierFromText(text);
    const picked = result.diagnostic.selectedSupplier ?? result.winner?.displayName ?? null;
    expect(picked).toMatch(/Cloud Reseller Partners/i);
    expect(picked).not.toMatch(/^Canada\b/i);
  });

  it("geography-containing legal name is preserved as supplier", () => {
    const text = [
      "Canada Golf Supply Inc.",
      "500 Fairway Rd",
      "Calgary AB T2T 0Z7",
      "GST 123456789RT0001",
      "",
      "INVOICE",
      "Invoice CGS-2026-08-15",
    ].join("\n");
    const result = selectSupplierFromText(text);
    const picked = result.diagnostic.selectedSupplier ?? result.winner?.displayName ?? null;
    expect(picked).toMatch(/Canada Golf Supply/i);
  });
});
