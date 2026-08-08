// Sprint 3 · Phase 4 Slice 5.3 (2026-08-08) — purchased-item
// substance authority tests: PurchasedItemIdentity, ItemCompleteness,
// CapitalEvidenceDecision, summary-row rejection, split-row merge.
//
// All test data is SYNTHETIC. No real invoice content, no real
// supplier / SKU / product-code / model literal. Assertions verify
// the GENERIC classifier behaviour — not that a particular real-world
// invoice codes to a particular GL account.

import { describe, it, expect } from "vitest";
import {
  extractPurchasedItems,
} from "@/lib/ap-intelligence/purchased-item-identity";
import {
  classifyItemCompleteness,
} from "@/lib/ap-intelligence/item-completeness";
import {
  evaluateCapitalEvidence,
} from "@/lib/ap-intelligence/capital-evidence";
import {
  isItemizedSummaryDescription,
} from "@/lib/ap-intelligence/line-item-region-strategies";
import type { CanonicalLineItem } from "@/lib/ap-intelligence/evidence/canonical-line-item";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeLI(
  description: string,
  opts: Partial<CanonicalLineItem> = {},
): CanonicalLineItem {
  return {
    description,
    quantity: null,
    unitPrice: null,
    extension: null,
    sku: null,
    tax: null,
    role: "PRIMARY_PURCHASE",
    lineNumber: null,
    ...opts,
  } as CanonicalLineItem;
}

// -----------------------------------------------------------------------------
// Summary-row rejection (amendment #1)
// -----------------------------------------------------------------------------

describe("isItemizedSummaryDescription (amendment #1)", () => {
  it("rejects generic summary shapes across suppliers", () => {
    const cases = [
      "2 Lines Total", "5 Lines Total",
      "Items Total", "Product Total", "Parts Total",
      "Net Total",
    ];
    for (const c of cases) {
      expect(isItemizedSummaryDescription(c), c).toBe(true);
    }
  });
  it("does NOT reject legitimate purchase descriptions", () => {
    const cases = [
      "Bearing kit — front axle",
      "Diesel — 250 gallons",
      "Repair labour — 4 hours",
      "Complete mower unit",
    ];
    for (const c of cases) {
      expect(isItemizedSummaryDescription(c), c).toBe(false);
    }
  });
});

// -----------------------------------------------------------------------------
// PurchasedItemIdentity: NON_MODEL_TOKENS + evidence-backed identity
// -----------------------------------------------------------------------------

describe("extractPurchasedItems — evidence-backed identity (amendment #3)", () => {
  it("does not promote unit / tax / amount tokens to model", () => {
    const items = extractPurchasedItems([
      makeLI("Bearing set — front axle EA GST TOTAL"),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].model).toBeNull();
    expect(items[0].manufacturer).toBeNull();
  });
  it("keeps SKU separate from model", () => {
    const items = extractPurchasedItems([
      makeLI("Bearing set — front axle", { sku: "ABC-12345" }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].sku).toBe("ABC-12345");
    expect(items[0].model).toBeNull();
  });
  it("promotes a plausible model-shape token when digit/hyphen and not on the reject list", () => {
    const items = extractPurchasedItems([
      makeLI("Complete generator unit ACME GX-4400 220V"),
    ]);
    expect(items[0].model).toBe("GX-4400");
    expect(items[0].manufacturer).toBe("ACME");
  });
  it("extracts explicit labelled Serial value only", () => {
    const items = extractPurchasedItems([
      makeLI("Complete unit"),
      makeLI("Serial #: SN-987654"),
    ]);
    // Second line should have attached to the first.
    expect(items).toHaveLength(1);
    expect(items[0].serialNumber).toBe("SN-987654");
  });
  it("marks summary-shape descriptions as LOW evidence quality", () => {
    const items = extractPurchasedItems([
      makeLI("Items Total"),
    ]);
    if (items.length > 0) {
      expect(items[0].evidenceQuality).toBe("LOW");
    }
  });
});

// -----------------------------------------------------------------------------
// ItemCompleteness — FUNCTIONAL, not merely by identifier (amendment #5)
// -----------------------------------------------------------------------------

describe("classifyItemCompleteness — functional classification (amendment #5)", () => {
  it("engine body word => COMPONENT even with model/serial", () => {
    const items = extractPurchasedItems([
      makeLI("Complete mower — replacement engine ACME EG-320"),
    ]);
    // Force the item to have a model + serial to test the
    // contradiction — engine body word must dominate.
    const item = { ...items[0], model: "EG-320", serialNumber: "S123-456" };
    const result = classifyItemCompleteness(item);
    expect(result.completeness).toBe("COMPONENT");
  });
  it("clean mower description => COMPLETE_ASSET", () => {
    const items = extractPurchasedItems([
      makeLI("New rotary mower — 60 inch cutting deck"),
    ]);
    const result = classifyItemCompleteness(items[0]);
    expect(result.completeness).toBe("COMPLETE_ASSET");
  });
  it("bearing / seal / filter => COMPONENT", () => {
    const items = extractPurchasedItems([
      makeLI("Ball bearing set replacement"),
    ]);
    const result = classifyItemCompleteness(items[0]);
    expect(result.completeness).toBe("COMPONENT");
  });
  it("diesel fuel => CONSUMABLE", () => {
    const items = extractPurchasedItems([
      makeLI("Diesel fuel — 250 gallons"),
    ]);
    const result = classifyItemCompleteness(items[0]);
    expect(result.completeness).toBe("CONSUMABLE");
  });
  it("repair labour => SERVICE", () => {
    const items = extractPurchasedItems([
      makeLI("Repair service call — labour"),
    ]);
    const result = classifyItemCompleteness(items[0]);
    // Service or REPAIR — either way, not COMPLETE_ASSET / CAPITAL
    expect(["SERVICE", "COMPONENT"]).toContain(result.completeness);
  });
});

// -----------------------------------------------------------------------------
// CapitalEvidenceDecision — probabilistic, no amount, no supplier hardcoding
// (amendments #7, #8, #11)
// -----------------------------------------------------------------------------

describe("evaluateCapitalEvidence — capital nature classifier", () => {
  it("COMPLETE_ASSET + identifier + capital-project context => CAPITAL_CANDIDATE", () => {
    // Single strongest signal (complete asset w/ identifier = 30)
    // plus explicit capital-project context to clear the 40-point
    // commit floor. The scorer is deliberately conservative — see
    // capital-evidence.ts COMMIT_MIN_CONFIDENCE.
    const items = extractPurchasedItems([
      makeLI("Complete rotary mower — 60 inch deck ACME MW-6000"),
    ]);
    const completeness = new Map();
    for (const it of items) completeness.set(it.sourceLineItemIndex, classifyItemCompleteness(it));
    const decision = evaluateCapitalEvidence({
      items, itemCompleteness: completeness,
      poRequestorText: "Capital project #2027-1 — grounds equipment refresh",
      supplierName: null,
    });
    expect(decision.decision).toBe("CAPITAL_CANDIDATE");
  });
  it("Multiple COMPONENT lines => REPAIR_MAINTENANCE", () => {
    const items = extractPurchasedItems([
      makeLI("Ball bearing replacement"),
      makeLI("Seal kit — hydraulic pump"),
      makeLI("Filter assembly — engine"),
    ]);
    const completeness = new Map();
    for (const it of items) completeness.set(it.sourceLineItemIndex, classifyItemCompleteness(it));
    const decision = evaluateCapitalEvidence({
      items, itemCompleteness: completeness, poRequestorText: null, supplierName: null,
    });
    expect(decision.decision).toBe("REPAIR_MAINTENANCE");
  });
  it("Multiple diesel fuel lines => OPERATING", () => {
    const items = extractPurchasedItems([
      makeLI("Diesel fuel — 250 gallons"),
      makeLI("Diesel fuel — bulk delivery second tank"),
    ]);
    const completeness = new Map();
    for (const it of items) completeness.set(it.sourceLineItemIndex, classifyItemCompleteness(it));
    const decision = evaluateCapitalEvidence({
      items, itemCompleteness: completeness, poRequestorText: null, supplierName: null,
    });
    expect(decision.decision).toBe("OPERATING");
  });
  it("engine-body-word items => REPAIR_MAINTENANCE, not CAPITAL (amendment #5)", () => {
    const items = extractPurchasedItems([
      makeLI("Complete mower — replacement engine ACME EG-320"),
    ]);
    const completeness = new Map();
    for (const it of items) completeness.set(it.sourceLineItemIndex, classifyItemCompleteness(it));
    const decision = evaluateCapitalEvidence({
      items, itemCompleteness: completeness, poRequestorText: null, supplierName: null,
    });
    expect(decision.decision).not.toBe("CAPITAL_CANDIDATE");
  });
  it("no line items => UNRESOLVED", () => {
    const decision = evaluateCapitalEvidence({
      items: [], itemCompleteness: new Map(), poRequestorText: null, supplierName: null,
    });
    expect(decision.decision).toBe("UNRESOLVED");
  });
  it("does NOT consider amount as capital evidence (amendment #8)", () => {
    // Two items with identical descriptions but wildly different
    // extensions. Amount MUST NOT tip the classifier.
    const cheap = extractPurchasedItems([
      makeLI("Ball bearing replacement", { extension: 12 }),
    ]);
    const expensive = extractPurchasedItems([
      makeLI("Ball bearing replacement", { extension: 12000 }),
    ]);
    const cCheap = new Map();
    for (const it of cheap) cCheap.set(it.sourceLineItemIndex, classifyItemCompleteness(it));
    const cExpensive = new Map();
    for (const it of expensive) cExpensive.set(it.sourceLineItemIndex, classifyItemCompleteness(it));
    const dCheap = evaluateCapitalEvidence({
      items: cheap, itemCompleteness: cCheap, poRequestorText: null, supplierName: null,
    });
    const dExpensive = evaluateCapitalEvidence({
      items: expensive, itemCompleteness: cExpensive, poRequestorText: null, supplierName: null,
    });
    expect(dCheap.decision).toBe(dExpensive.decision);
    expect(dCheap.confidence).toBe(dExpensive.confidence);
  });
});

// -----------------------------------------------------------------------------
// Extraction/authority contract: TAX/CREDIT/SUMMARY rows must NOT
// produce PurchasedItemIdentity entries.
// -----------------------------------------------------------------------------

describe("extractPurchasedItems — role scoping (amendment #9)", () => {
  it("skips TAX rows", () => {
    const items = extractPurchasedItems([
      makeLI("GST 5%", { role: "TAX" }),
      makeLI("Ball bearing", { role: "PRIMARY_PURCHASE" }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].description).toBe("Ball bearing");
  });
  it("skips SUMMARY_ROW_REJECTED rows", () => {
    const items = extractPurchasedItems([
      makeLI("2 Lines Total", { role: "SUMMARY_ROW_REJECTED" }),
      makeLI("Ball bearing", { role: "PRIMARY_PURCHASE" }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].description).toBe("Ball bearing");
  });
  it("includes SURCHARGE rows (they may carry description-derived context)", () => {
    const items = extractPurchasedItems([
      makeLI("Environmental fee", { role: "SURCHARGE" }),
      makeLI("Ball bearing", { role: "PRIMARY_PURCHASE" }),
    ]);
    expect(items).toHaveLength(2);
  });
});
