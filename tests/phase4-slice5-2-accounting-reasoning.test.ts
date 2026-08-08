// Sprint 3 · Phase 4 Slice 5.2 (2026-08-08) — accounting-reasoning
// architecture regression tests.
//
// All test data is SYNTHETIC. Ground-truth per-supplier assertions
// live in the acceptance suite; this file tests the ARCHITECTURE.

import { describe, it, expect } from "vitest";
import {
  buildTransactionalText,
  transactionalTextDiagnostic,
} from "@/lib/ap-intelligence/transactional-text";
import { resolveEconomicPurpose } from "@/lib/ap-intelligence/economic-purpose-authority";
import { evaluateSemanticMatchGate, NATURE_OVERRIDE_MIN_CONFIDENCE } from "@/lib/ap-intelligence/semantic-match-gate";
import {
  evaluatePurposeAccountAffinity,
  PURPOSE_ONTOLOGY_BOOST,
} from "@/lib/ap-intelligence/purpose-to-gl-ontology";
import { classifyAccountingNature } from "@/lib/ap-intelligence/accounting-nature";
import type { CanonicalLineItem } from "@/lib/ap-intelligence/evidence/canonical-line-item";
import type { LayoutRegion } from "@/lib/ap-intelligence/layout-regions";
import type { LayoutVisualLine } from "@/lib/ap-intelligence/pdf-layout-extract";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function li(over: Partial<CanonicalLineItem>): CanonicalLineItem {
  return {
    description: "widget",
    extension: 100,
    role: "PRIMARY_PURCHASE",
    page: 1,
    sourceStrategy: "POSITIONED_CLASSIC_TABLE",
    validationConfidence: 80,
    arithmetic: "ARITHMETIC_OK",
    evidence: [],
    ...over,
  };
}

function region(kind: LayoutRegion["kind"], lines: string[]): LayoutRegion {
  return {
    id: `r-${kind}`,
    page: 1,
    kind,
    xMin: 0, xMax: 100, yMin: 0, yMax: 100,
    kindConfidence: 90,
    lines: lines.map((t, i) => ({
      page: 1, y: i * 12, text: t, items: [],
    } as LayoutVisualLine)),
    text: lines.join("\n"),
    evidence: [],
  };
}

// -----------------------------------------------------------------------------
// Amendment #4 — transactional-text region filtering
// -----------------------------------------------------------------------------
describe("Slice 5.2 · buildTransactionalText (amendment #4)", () => {
  it("includes LINE_ITEMS + SUMMARY regions", () => {
    const r = buildTransactionalText([
      region("LINE_ITEMS", ["Widget A 100.00", "Widget B 50.00"]),
      region("SUMMARY", ["Subtotal 150.00", "Total 157.50"]),
    ]);
    expect(r.text).toContain("Widget A");
    expect(r.text).toContain("Widget B");
    expect(r.text).toContain("Subtotal");
    expect(r.includedRegions).toHaveLength(2);
    expect(r.excludedRegions).toHaveLength(0);
  });
  it("EXCLUDES SUPPLIER_BLOCK (fixes 'Capital Circle' false positive)", () => {
    const r = buildTransactionalText([
      region("SUPPLIER_BLOCK", ["ACME Energy Inc", "17 Capital Circle", "Saskatoon, SK"]),
      region("LINE_ITEMS", ["Diesel LS Dyed 2344.30"]),
      region("SUMMARY", ["Total 2532.92"]),
    ]);
    expect(r.text).toContain("Diesel LS Dyed");
    expect(r.text).not.toContain("Capital Circle");
    expect(r.excludedRegions.some((e) => e.kind === "SUPPLIER_BLOCK")).toBe(true);
  });
  it("EXCLUDES RECIPIENT_BLOCK", () => {
    const r = buildTransactionalText([
      region("RECIPIENT_BLOCK", ["SILVER SPRINGS GOLF & COUNTRY CLUB", "1600 VARSITY ESTATES DR NW"]),
      region("LINE_ITEMS", ["Diesel"]),
    ]);
    expect(r.text).not.toContain("SILVER SPRINGS");
    expect(r.text).not.toContain("VARSITY ESTATES");
  });
  it("EXCLUDES FOOTER (fixes 'finance charge' policy false positive)", () => {
    const r = buildTransactionalText([
      region("LINE_ITEMS", ["Product ABC 100.00"]),
      region("FOOTER", [
        "Invoice due upon receipt unless otherwise stated",
        "Administration fee: 2.00% per month",
        "Finance charge of 24% per year on all overdue amounts",
      ]),
    ]);
    expect(r.text).toContain("Product ABC");
    expect(r.text).not.toContain("finance charge");
    expect(r.text).not.toContain("Administration fee");
  });
  it("strips policy-line leading prefixes even inside LINE_ITEMS band", () => {
    const r = buildTransactionalText([
      region("LINE_ITEMS", [
        "Real product 100.00",
        "Invoice due upon receipt unless otherwise stated  99.99",
        "Administration fee: 2.00% per month  12.34",
      ]),
    ]);
    expect(r.text).toContain("Real product");
    expect(r.text).not.toContain("Invoice due");
    expect(r.text).not.toContain("Administration fee");
    expect(r.strippedPolicyLineCount).toBeGreaterThanOrEqual(2);
  });
});

// -----------------------------------------------------------------------------
// Amendment #3 — amount-based capital signal REMOVED
// -----------------------------------------------------------------------------
describe("Slice 5.2 · accounting-nature amount signal REMOVED (amendment #3)", () => {
  it("large invoice with NO capital vocabulary does not classify as CAPITAL_ASSET", () => {
    // Oakcreek 1091559 shape: $77,833 total, no capital vocab in transactional text.
    const result = classifyAccountingNature({
      extraction: null,
      supplierName: "Generic Vendor",
      lineItemDescriptions: ["Alberta Tire Levy ADF", "2 Lines Total"],
      fullDocumentText: null,
      transactionalText: "Alberta Tire Levy ADF\n2 Lines Total",
      capitalStateFromClassifier: "AMBIGUOUS",
      capitalThresholdCents: 500000,
      totalCents: 7783335,  // $77,833 — used to trigger the old defect
    });
    const capital = result.ranked.find((n) => n.nature === "CAPITAL_ASSET");
    const hasAmountSignal = (capital?.supportingEvidence ?? []).some((s) => s.includes("amount_above_capital_threshold"));
    expect(hasAmountSignal).toBe(false);
    // The nature classifier must NOT elect CAPITAL_ASSET on amount alone.
    expect(result.leader).not.toBe("CAPITAL_ASSET");
  });
});

// -----------------------------------------------------------------------------
// Amendment #6 — footer/address/terms cannot overturn canonical purpose
// -----------------------------------------------------------------------------
describe("Slice 5.2 · footer/address/terms cannot overturn canonical purpose (amendment #6)", () => {
  it("committed canonical FUEL is not overridden by 'phone' / 'internet' in supplier block", () => {
    // Canonical line items say FUEL. Transactional-text excludes
    // supplier-block. So even if the supplier address includes
    // "Phone (403)..." or "www.example.com", resolveEconomicPurpose
    // must commit to FUEL.
    const decision = resolveEconomicPurpose({
      canonicalLineItems: [
        li({ description: "Diesel LS Dyed 1700 L", extension: 2344.30, quantity: 1700, unitPrice: 1.379 }),
      ],
      supplierName: "ACME Energy",
      // Transactional text SHOULD NOT include the supplier's phone
      // number (that lives in SUPPLIER_BLOCK region). This test
      // simulates that isolation.
      transactionalText: "Diesel LS Dyed 1700 L 2344.30",
      hasPenaltyLine: false,
      hasMembershipLine: false,
      hasProfessionalCredentialContext: false,
    });
    expect(decision.source).toBe("CANONICAL_COMMITTED");
    expect(decision.concept).toBe("FUEL");
  });
  it("committed canonical EQUIPMENT_PARTS is not overridden by 'finance charge' in footer", () => {
    const decision = resolveEconomicPurpose({
      canonicalLineItems: [
        li({ description: "Alberta Tire Levy ADF", extension: 15, role: "SURCHARGE" }),
        li({ description: "Bearing seal spacer", extension: 500 }),
      ],
      supplierName: "Turf Equipment Co",
      // Footer text stripped in production; simulate here.
      transactionalText: "Bearing seal spacer 500\nAlberta Tire Levy 15",
      hasPenaltyLine: false,
      hasMembershipLine: false,
      hasProfessionalCredentialContext: false,
    });
    // Not FUEL / INTEREST — should be EQUIPMENT_PARTS
    expect(decision.concept).toBe("EQUIPMENT_PARTS");
  });
});

// -----------------------------------------------------------------------------
// Amendment #1 — economic-purpose authority policy
// -----------------------------------------------------------------------------
describe("Slice 5.2 · resolveEconomicPurpose authority (amendment #1)", () => {
  it("CANONICAL_COMMITTED when canonical confidence ≥ 60", () => {
    const decision = resolveEconomicPurpose({
      canonicalLineItems: [
        li({ description: "Internet: 100 Mbps service", extension: 40 }),
      ],
      supplierName: "Fiber Co", transactionalText: "Internet: 100 Mbps service",
      hasPenaltyLine: false, hasMembershipLine: false, hasProfessionalCredentialContext: false,
    });
    expect(decision.source).toBe("CANONICAL_COMMITTED");
    expect(decision.concept).toBe("INTERNET_CONNECTIVITY");
  });
  it("ABSTAIN when neither canonical nor legacy is defensible", () => {
    const decision = resolveEconomicPurpose({
      canonicalLineItems: [li({ description: "generic thing", extension: 100 })],
      supplierName: "Unknown Vendor",
      transactionalText: "generic thing",
      hasPenaltyLine: false, hasMembershipLine: false, hasProfessionalCredentialContext: false,
    });
    expect(decision.source).toBe("ABSTAIN");
    expect(decision.concept).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Amendment #5 — SEMANTIC_MATCH override gate
// -----------------------------------------------------------------------------
describe("Slice 5.2 · SEMANTIC_MATCH override gate (amendment #5)", () => {
  const fuelDecision = resolveEconomicPurpose({
    canonicalLineItems: [li({ description: "Diesel LS Dyed", extension: 2344 })],
    supplierName: "Fuel Co",
    transactionalText: "Diesel LS Dyed 2344",
    hasPenaltyLine: false, hasMembershipLine: false, hasProfessionalCredentialContext: false,
  });

  it("DENIES override when nature confidence below threshold (DMM defect)", () => {
    const gate = evaluateSemanticMatchGate({
      natureLeader: "CAPITAL_ASSET",
      natureConfidence: 20,   // DMM's actual live conf that caused the defect
      natureIsDefensible: false,
      candidateAccountType: "EXPENSE",  // "Telephone & Internet" is EXPENSE
      purposeDecision: fuelDecision,
    });
    expect(gate.allow).toBe(false);
    expect(gate.denials.some((d) => d.startsWith("nature_confidence_below_threshold"))).toBe(true);
  });
  it("DENIES override when nature incompatible with committed purpose", () => {
    // FUEL is compatible with OPERATING_EXPENSE, not CAPITAL_ASSET.
    const gate = evaluateSemanticMatchGate({
      natureLeader: "CAPITAL_ASSET",
      natureConfidence: 80,
      natureIsDefensible: true,
      candidateAccountType: "ASSET",
      purposeDecision: fuelDecision,
    });
    expect(gate.allow).toBe(false);
    expect(gate.denials.some((d) => d.startsWith("nature_incompatible_with_purpose"))).toBe(true);
  });
  it("DENIES override when account type incompatible with nature (Oakcreek defect)", () => {
    // nature=CAPITAL_ASSET but candidate account is EXPENSE type
    // (Interest Expense). Even if we bypassed the purpose check,
    // account-type/nature incompatibility catches it.
    const gate = evaluateSemanticMatchGate({
      natureLeader: "CAPITAL_ASSET",
      natureConfidence: 80,
      natureIsDefensible: true,
      candidateAccountType: "EXPENSE",   // Interest Expense
      purposeDecision: fuelDecision,     // purposeCheck passes: purpose vs nature mismatch caught first
    });
    expect(gate.allow).toBe(false);
  });
  it("ALLOWS override when all gates pass", () => {
    const gate = evaluateSemanticMatchGate({
      natureLeader: "OPERATING_EXPENSE",
      natureConfidence: 75,
      natureIsDefensible: true,
      candidateAccountType: "EXPENSE",
      purposeDecision: fuelDecision,
    });
    expect(gate.allow).toBe(true);
    expect(gate.denials).toHaveLength(0);
  });
  it("threshold constant is 60", () => {
    expect(NATURE_OVERRIDE_MIN_CONFIDENCE).toBe(60);
  });
});

// -----------------------------------------------------------------------------
// Amendment #2 — concept→GL weak ontology signal
// -----------------------------------------------------------------------------
describe("Slice 5.2 · purpose→GL ontology (amendment #2)", () => {
  it("emits weak boost for a matching account name", () => {
    const m = evaluatePurposeAccountAffinity("FUEL", "Fuel — Grounds Equipment");
    expect(m).not.toBeNull();
    expect(m?.boost).toBe(PURPOSE_ONTOLOGY_BOOST);
  });
  it("returns null when no discriminative substring matches", () => {
    expect(evaluatePurposeAccountAffinity("FUEL", "Telephone & Internet")).toBeNull();
  });
  it("does NOT boost on the generic term 'supplies' when no discriminative substring configured", () => {
    // 'supplies' is deliberately not in FUEL / EQUIPMENT_PARTS
    // discriminative substrings (broad-term guard, amendment #2).
    expect(evaluatePurposeAccountAffinity("FUEL", "Backshop Supplies")).toBeNull();
  });
  it("weak-ontology boost is <= 10 (never dominant)", () => {
    expect(PURPOSE_ONTOLOGY_BOOST).toBeLessThanOrEqual(10);
  });
});

// -----------------------------------------------------------------------------
// Diagnostic helper
// -----------------------------------------------------------------------------
describe("Slice 5.2 · transactionalTextDiagnostic", () => {
  it("produces a bounded diagnostic string", () => {
    const r = buildTransactionalText([
      region("LINE_ITEMS", ["A", "B"]),
      region("FOOTER", ["policy"]),
    ]);
    const s = transactionalTextDiagnostic(r);
    expect(s).toContain("chars=");
    expect(s).toContain("included=");
    expect(s).toContain("excluded=");
  });
});
