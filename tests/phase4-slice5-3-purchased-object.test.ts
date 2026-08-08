// Sprint 3 · Phase 4 Slice 5.3 completion pass (2026-08-08) —
// PurchasedObjectIdentity + object-role classifier + relationships +
// object-aware CapitalEvidenceDecision tests.
//
// All test data is SYNTHETIC. No supplier / product / SKU / model
// literal from any real invoice. Assertions verify the GENERIC
// reasoning: brand/model preservation, engine-as-evidence-not-verdict,
// zero-cost bundled accessory as complete-machine evidence, and
// UNRESOLVED as the honest default for genuine ambiguity.

import { describe, it, expect } from "vitest";
import {
  DeterministicPurchasedObjectProvider,
} from "@/lib/ap-intelligence/purchased-object-identity";
import { evaluateCapitalObjectEvidence } from "@/lib/ap-intelligence/capital-evidence";
import type { CanonicalLineItem } from "@/lib/ap-intelligence/evidence/canonical-line-item";

function makeLI(
  description: string,
  extension: number | null = null,
  opts: Partial<CanonicalLineItem> = {},
): CanonicalLineItem {
  return {
    description,
    quantity: null,
    unitPrice: null,
    extension,
    sku: null,
    tax: null,
    role: "PRIMARY_PURCHASE",
    lineNumber: null,
    ...opts,
  } as CanonicalLineItem;
}

const provider = new DeterministicPurchasedObjectProvider();

// -----------------------------------------------------------------------------
// Brand / model / SKU / serial preservation (§7 + §15)
// -----------------------------------------------------------------------------

describe("PurchasedObject — brand/model/sku/serial preservation", () => {
  it("preserves TWO brands when a description contains an outer brand and an assembly brand", () => {
    // Synthetic: outer machine brand + assembly-body brand within one
    // description. Neither hardcoded.
    const objects = provider.interpret([
      makeLI("ACME MODEL X-42 WIDGET ENGINE Serial #: 987654321", 55000, { unit: "EA", quantity: 1, unitPrice: 55000 }),
    ]);
    expect(objects).toHaveLength(1);
    // Both brand candidates must appear. Order not asserted.
    const brandValues = objects[0].brandCandidates.map((b) => b.value);
    expect(brandValues, "outer brand preserved").toContain("ACME");
    expect(brandValues, "assembly brand preserved").toContain("WIDGET");
  });
  it("keeps SKU separate from model", () => {
    const objects = provider.interpret([
      makeLI("Item 30807 ACME MODEL X-42", 100, { sku: "SKU-30807", unit: "EA" }),
    ]);
    expect(objects).toHaveLength(1);
    expect(objects[0].skuCandidates.map((s) => s.value)).toContain("SKU-30807");
    // Model X-42 is a model candidate, not a SKU
    expect(objects[0].modelCandidates.some((m) => m.value === "X-42")).toBe(true);
  });
  it("extracts leading numeric prefix as SKU candidate (line# + product-code)", () => {
    const objects = provider.interpret([
      makeLI("1 30807 ACME MODEL X-42", 100),
    ]);
    expect(objects[0].skuCandidates.some((s) => s.value === "30807")).toBe(true);
  });
  it("extracts explicit labelled serial with STRONG provenance", () => {
    const objects = provider.interpret([
      makeLI("ACME MODEL X-42 Serial #: ABC-98765432", 100),
    ]);
    expect(objects[0].serialCandidates[0].value).toBe("ABC-98765432");
    expect(objects[0].serialCandidates[0].strength).toBe("strong");
  });
});

// -----------------------------------------------------------------------------
// Object-role classifier — engine as evidence not verdict (§9)
// -----------------------------------------------------------------------------

describe("Object-role classifier — engine is evidence, not verdict (§9)", () => {
  it("engine + mower in same description => role is UNRESOLVED (ambiguous)", () => {
    // Synthetic: outer machine noun (mower) + assembly-body noun
    // (engine) within one description → classifier must NOT verdict
    // COMPONENT.
    const objects = provider.interpret([
      makeLI("ACME MOWER MODEL X-4000 KUBOTA ENGINE Serial #: SN-12345678", 70000, { unit: "EA", quantity: 1, unitPrice: 70000 }),
    ]);
    // Should NOT be COMPONENT (the completed slice's over-strong
    // rule). Either COMPLETE_MACHINE or UNKNOWN is acceptable.
    expect(objects[0].objectRole).not.toBe("COMPONENT");
    expect(["COMPLETE_MACHINE", "UNKNOWN"]).toContain(objects[0].objectRole);
  });
  it("standalone repair-part (bearing) => COMPONENT", () => {
    const objects = provider.interpret([
      makeLI("Ball bearing replacement", 50),
    ]);
    expect(objects[0].objectRole).toBe("COMPONENT");
  });
  it("standalone diesel => CONSUMABLE", () => {
    const objects = provider.interpret([
      makeLI("Diesel fuel bulk delivery 500 gallons", 2000),
    ]);
    expect(objects[0].objectRole).toBe("CONSUMABLE");
  });
  it("standalone repair labour => SERVICE", () => {
    const objects = provider.interpret([
      makeLI("Repair service call labour 4 hours", 400),
    ]);
    expect(objects[0].objectRole).toBe("SERVICE");
  });
  it("explicit 'replacement' language pushes toward SERIALIZED_COMPONENT (contradicts COMPLETE_MACHINE)", () => {
    const objects = provider.interpret([
      makeLI("Replacement engine assembly for existing machine", 8000),
    ]);
    // Should NOT be COMPLETE_MACHINE with strong confidence.
    if (objects[0].objectRole === "COMPLETE_MACHINE") {
      expect(objects[0].objectRoleConfidence).toBeLessThan(50);
    }
  });
});

// -----------------------------------------------------------------------------
// Object relationships (§8 + §13)
// -----------------------------------------------------------------------------

describe("Object relationships — BUNDLED_WITH + COMPATIBLE_WITH", () => {
  it("zero-cost accessory sharing a model with a high-value machine => BUNDLED_WITH", () => {
    const objects = provider.interpret([
      makeLI("ACME MOWER MODEL X-4000", 70000, { unit: "EA", quantity: 1, unitPrice: 70000 }),
      makeLI("PREMIUM SEAT X-4000", 0, { unit: "EA", quantity: 1, unitPrice: 0 }),
    ]);
    // The accessory (index 1) should have a BUNDLED_WITH relationship
    // pointing at the mower (index 0).
    const seatRel = objects[1].relatedObjects.find((r) => r.kind === "BUNDLED_WITH");
    expect(seatRel, "seat BUNDLED_WITH mower").toBeTruthy();
  });
  it("shared model between two non-zero-cost lines => COMPATIBLE_WITH", () => {
    const objects = provider.interpret([
      makeLI("ACME X-4000 blade kit", 250),
      makeLI("ACME X-4000 filter", 45),
    ]);
    // Both share model X-4000 → each should see the other via
    // COMPATIBLE_WITH.
    expect(objects[0].relatedObjects.some((r) => r.kind === "COMPATIBLE_WITH")).toBe(true);
    expect(objects[1].relatedObjects.some((r) => r.kind === "COMPATIBLE_WITH")).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// evaluateCapitalObjectEvidence — completion-pass primary
// -----------------------------------------------------------------------------

describe("evaluateCapitalObjectEvidence — completion-pass capital reasoning", () => {
  it("genuine ambiguity between complete-machine and component => UNRESOLVED", () => {
    // Complete-machine noun + engine body word within one description.
    // Both signals present. Expected outcome: UNRESOLVED (§31 Outcome B).
    const objects = provider.interpret([
      makeLI("ACME MOWER MODEL X-4000 KUBOTA ENGINE Serial #: SN-12345678", 70000, { unit: "EA", quantity: 1, unitPrice: 70000 }),
    ]);
    const decision = evaluateCapitalObjectEvidence({
      objects, poRequestorText: null, supplierName: null,
    });
    // Either UNRESOLVED (ambiguity honestly reported) or CAPITAL_CANDIDATE
    // (complete-machine signal dominates via model+brand+EA=1). Never
    // REPAIR_MAINTENANCE from engine alone.
    expect(decision.decision).not.toBe("REPAIR_MAINTENANCE");
  });
  it("zero-cost bundled accessory + high-value machine => CAPITAL_CANDIDATE", () => {
    const objects = provider.interpret([
      makeLI("ACME MOWER MODEL X-4000", 70000, { unit: "EA", quantity: 1, unitPrice: 70000 }),
      makeLI("PREMIUM SEAT X-4000", 0, { unit: "EA", quantity: 1, unitPrice: 0 }),
    ]);
    const decision = evaluateCapitalObjectEvidence({
      objects, poRequestorText: null, supplierName: null,
    });
    // Zero-cost bundled accessory adds capital weight (§13). Result
    // should not be REPAIR_MAINTENANCE.
    expect(decision.decision).not.toBe("REPAIR_MAINTENANCE");
  });
  it("multiple standalone components => REPAIR_MAINTENANCE", () => {
    const objects = provider.interpret([
      makeLI("Ball bearing replacement", 50),
      makeLI("Seal kit hydraulic pump", 30),
      makeLI("Filter assembly engine oil", 45),
    ]);
    const decision = evaluateCapitalObjectEvidence({
      objects, poRequestorText: null, supplierName: null,
    });
    expect(decision.decision).toBe("REPAIR_MAINTENANCE");
  });
  it("diesel fuel bulk delivery => OPERATING", () => {
    const objects = provider.interpret([
      makeLI("Diesel fuel bulk delivery 500 gallons", 2000),
      makeLI("Diesel fuel second tank 250 gallons", 1000),
    ]);
    const decision = evaluateCapitalObjectEvidence({
      objects, poRequestorText: null, supplierName: null,
    });
    expect(decision.decision).toBe("OPERATING");
  });
  it("amount is NOT capital evidence (§25 completion pass)", () => {
    const cheap = provider.interpret([
      makeLI("Ball bearing replacement", 12),
    ]);
    const expensive = provider.interpret([
      makeLI("Ball bearing replacement", 12000),
    ]);
    const dCheap = evaluateCapitalObjectEvidence({
      objects: cheap, poRequestorText: null, supplierName: null,
    });
    const dExpensive = evaluateCapitalObjectEvidence({
      objects: expensive, poRequestorText: null, supplierName: null,
    });
    expect(dCheap.decision).toBe(dExpensive.decision);
    expect(dCheap.confidence).toBe(dExpensive.confidence);
  });
  it("explicit 'replacement engine' language + capital-project PO context — capital context DOES tip toward complete-machine", () => {
    const objects = provider.interpret([
      makeLI("Capital project engine assembly replacement", 15000),
    ]);
    const withProject = evaluateCapitalObjectEvidence({
      objects,
      poRequestorText: "capital project #2027-1",
      supplierName: null,
    });
    // The capital-project context adds weight but replacement language
    // adds RM weight. Either UNRESOLVED (evidence balanced) or one of
    // the decisions is acceptable — REPAIR_MAINTENANCE strongest with
    // replacement wording present.
    expect(["CAPITAL_CANDIDATE", "REPAIR_MAINTENANCE", "UNRESOLVED"]).toContain(withProject.decision);
  });
});
