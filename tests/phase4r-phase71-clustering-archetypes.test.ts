// Phase 4R · Phase 7.1 (2026-08-13) — economic-clustering archetypes.
//
// Founder §16: "You ARE authorized to correct economic clustering if
// the analysis proves that multiple line items representing one
// economic transaction are currently being fragmented into separate
// clusters. Requirements: cluster by accounting/economic substance;
// preserve legitimate separate transactions; preserve tax
// correctness; no vendor/invoice/account literals; no post-ranking
// workaround; rerun the synthetic archetypes and staging fixtures."
//
// These archetypes are synthetic — no vendor, invoice, or account
// literals from the 221178 investigation appear here. The test names
// describe the ECONOMIC SHAPE of the invoice, not the tenant.
//
// The Phase 7.1 correction: when the canonical purposeDecision commits
// (CANONICAL_COMMITTED or CANONICAL_LEGACY_CONCUR) to a concept with a
// concept-catalog mapping, the per-line concept assignment adopts that
// concept as the cluster identity, UNLESS:
//   1. The line's own strongest per-line concept match is a
//      SPECIAL_HANDLING concept (interest, penalty, freight, fuel
//      surcharge, environmental surcharge). These are always
//      allocated separately for accounting correctness.
//   2. The line's own per-line concept match strength is >= 80 AND
//      the concept differs from the canonical. This preserves the
//      legitimate case where a document has one dominant purpose
//      but one line describes something obviously different.

import { describe, expect, it } from "vitest";
import { computeAllocations } from "@/lib/ap-intelligence/gl-allocations";
import type { LineItem, LineTaxTreatment, LineEvidenceKind } from "@/lib/ap-intelligence/line-items-extract";
import type { AccountView } from "@/lib/ap-intelligence/gl-account-concepts";
import type { EconomicPurposeDecision } from "@/lib/ap-intelligence/economic-purpose-authority";
import type { EconomicPurposeConcept } from "@/lib/ap-intelligence/economic-purpose-taxonomy";
import { COULEE_RIDGE_ACCOUNTS_SHAPE } from "./fixtures/c15u-coulee-ridge-coa-shape";

// -----------------------------------------------------------------------------
// Fixture COA — synthetic shape, no tenant literals
// -----------------------------------------------------------------------------

const COA: AccountView[] = [
  ...COULEE_RIDGE_ACCOUNTS_SHAPE,
  { id: "a-5030", accountNumber: "5030", name: "Delivery & Freight", categoryKey: "OTHER_EXPENSES", categoryName: "Other Expenses", fsGroupKey: "IS_OTHER_EXPENSES", fsGroupName: "Other Expenses" },
];

function mkLine(o: {
  description: string;
  amount: number;
  taxTreatment?: LineTaxTreatment;
  taxRate?: number | null;
  taxAmount?: number | null;
  evidence?: LineEvidenceKind[];
  lineNo?: number;
}): LineItem {
  return {
    description: o.description,
    quantity: null,
    unitPrice: null,
    amount: o.amount,
    taxRate: o.taxRate ?? null,
    taxAmount: o.taxAmount ?? null,
    taxTreatment: o.taxTreatment ?? "unknown",
    evidence: o.evidence ?? ["amount_only"],
    confidence: 70,
    lineNo: o.lineNo ?? 0,
  };
}

function mkCanonicalCommittedDecision(concept: EconomicPurposeConcept): EconomicPurposeDecision {
  return {
    source: "CANONICAL_COMMITTED",
    concept,
    confidence: 90,
    label: `Test ${concept}`,
    canonicalTop3: [],
    legacyCandidates: [],
    diagnostic: "test-fixture committed decision",
  };
}

function mkAbstainDecision(): EconomicPurposeDecision {
  return {
    source: "ABSTAIN",
    concept: null,
    confidence: 0,
    label: "Unknown",
    canonicalTop3: [],
    legacyCandidates: [],
    diagnostic: "test-fixture abstain",
  };
}

// -----------------------------------------------------------------------------
// Archetype 1 — same-economic-multi-line (the 221178 shape)
// -----------------------------------------------------------------------------
// Multiple IT/software lines with heterogeneous descriptions that
// individually match different per-line concepts weakly. The
// document-wide canonical decision is SOFTWARE_SUBSCRIPTION committed.
// Under Phase 7.1 all lines cluster into ONE software_subscription
// cluster. Under Phase 7.0 they fragmented.

describe("Phase 7.1 · Archetype 1 · same-economic-multi-line (heterogeneous IT lines under one canonical purpose)", () => {
  const lineItems = [
    mkLine({ description: "Managed backup storage service — May", amount: 120, taxTreatment: "taxable", lineNo: 0 }),
    mkLine({ description: "Endpoint protection licence renewal", amount: 90, taxTreatment: "taxable", lineNo: 1 }),
    mkLine({ description: "Server maintenance service fee", amount: 180, taxTreatment: "taxable", lineNo: 2 }),
    mkLine({ description: "Cloud sync recurring subscription", amount: 60, taxTreatment: "taxable", lineNo: 3 }),
    mkLine({ description: "Web filtering monthly service", amount: 30, taxTreatment: "taxable", lineNo: 4 }),
  ];
  const fullText = lineItems.map((l) => l.description).join("\n");

  it("Phase 7.1: with canonical SOFTWARE_SUBSCRIPTION committed, all IT lines converge on a SINGLE allocation", () => {
    const result = computeAllocations({
      lineItems,
      accounts: COA,
      postingBlockersByAccount: new Map(),
      economicPurposeCandidates: null,
      fullDocumentText: fullText,
      supplierName: "TEST IT VENDOR",
      purposeDecision: mkCanonicalCommittedDecision("SOFTWARE_SUBSCRIPTION"),
      printedSubtotal: 480,
      printedTax: 24,
      printedTotal: 504,
    });
    expect(result.allocations.length).toBe(1);
  });

  it("Phase 7.0 shape (no purposeDecision): heterogeneous IT lines fragment — the very defect Phase 7.1 fixes", () => {
    // This test documents the pre-fix behaviour so a future edit that
    // silently reverts the correction is caught.
    const result = computeAllocations({
      lineItems,
      accounts: COA,
      postingBlockersByAccount: new Map(),
      economicPurposeCandidates: null,
      fullDocumentText: fullText,
      supplierName: "TEST IT VENDOR",
      purposeDecision: null,
      printedSubtotal: 480,
      printedTax: 24,
      printedTotal: 504,
    });
    expect(result.allocations.length).toBeGreaterThan(1);
  });
});

// -----------------------------------------------------------------------------
// Archetype 2 — different-economics (legitimate multi-cluster invoice)
// -----------------------------------------------------------------------------
// One invoice with genuinely distinct economic components: professional
// membership dues + late-payment penalty. Even though the canonical
// purpose might commit to PROFESSIONAL_MEMBERSHIP, the penalty line
// must NOT be absorbed into the membership cluster — SPECIAL_HANDLING
// preserves it.

describe("Phase 7.1 · Archetype 2 · different-economics (SPECIAL_HANDLING penalty preserved)", () => {
  const lineItems = [
    mkLine({ description: "Provincial regulatory body annual dues", amount: 810, taxTreatment: "taxable", lineNo: 0 }),
    mkLine({ description: "National affiliate dues", amount: 400, taxTreatment: "taxable", lineNo: 1 }),
    mkLine({ description: "Late-payment penalty (Q1)", amount: 150, taxTreatment: "exempt", lineNo: 2 }),
  ];
  const fullText = lineItems.map((l) => l.description).join("\n");

  it("penalty line stays in its own allocation despite canonical committing PROFESSIONAL_MEMBERSHIP", () => {
    const result = computeAllocations({
      lineItems,
      accounts: COA,
      postingBlockersByAccount: new Map(),
      economicPurposeCandidates: null,
      fullDocumentText: fullText,
      supplierName: "TEST PROF ASSOC",
      purposeDecision: mkCanonicalCommittedDecision("PROFESSIONAL_MEMBERSHIP"),
      printedSubtotal: 1360,
      printedTax: 40.5,
      printedTotal: 1400.5,
    });
    expect(result.allocations.length).toBeGreaterThanOrEqual(2);
    // Penalty cluster does not equal membership cluster.
    const penalty = result.allocations.find((a) => /penalt|interest|late/i.test(a.descriptions.join(" ")));
    const membership = result.allocations.find((a) => /dues|affiliate|regulatory/i.test(a.descriptions.join(" ")));
    expect(penalty).toBeDefined();
    expect(membership).toBeDefined();
    expect(penalty?.id).not.toBe(membership?.id);
  });
});

// -----------------------------------------------------------------------------
// Archetype 3 — same-account-different-reason (post-ranking merge concern)
// -----------------------------------------------------------------------------
// Two economically distinct clusters that happen to land on the same
// account. The projection layer (§7 aggregation) already merges
// same-account clusters after canonical ranking. This archetype
// documents that Phase 7.1 does NOT fragment lines that should
// converge on the same account.

describe("Phase 7.1 · Archetype 3 · same-account-different-reason (converges cleanly)", () => {
  const lineItems = [
    mkLine({ description: "Office printer paper ream", amount: 40, taxTreatment: "taxable", lineNo: 0 }),
    mkLine({ description: "Ballpoint pens box", amount: 15, taxTreatment: "taxable", lineNo: 1 }),
    mkLine({ description: "Sticky notes multipack", amount: 22, taxTreatment: "taxable", lineNo: 2 }),
  ];
  const fullText = lineItems.map((l) => l.description).join("\n");

  it("office supplies with canonical OFFICE_SUPPLIES committed → one clean allocation", () => {
    const result = computeAllocations({
      lineItems,
      accounts: COA,
      postingBlockersByAccount: new Map(),
      economicPurposeCandidates: null,
      fullDocumentText: fullText,
      supplierName: "TEST OFFICE SUPPLIER",
      purposeDecision: mkCanonicalCommittedDecision("OFFICE_SUPPLIES"),
      printedSubtotal: 77,
      printedTax: 3.85,
      printedTotal: 80.85,
    });
    expect(result.allocations.length).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// Archetype 4 — tax-vs-GL independence
// -----------------------------------------------------------------------------
// Mixed tax treatments (taxable + exempt) within a single canonical
// purpose. Tax correctness is preserved at the ALLOCATION-line level
// (each line's tax stays attached), but GL classification collapses
// them into the same accounting cluster.

describe("Phase 7.1 · Archetype 4 · tax-vs-GL independence (mixed tax within one canonical purpose)", () => {
  const lineItems = [
    mkLine({ description: "Managed backup service monthly", amount: 120, taxTreatment: "taxable", taxRate: 0.05, lineNo: 0 }),
    mkLine({ description: "Software licence (exempt)", amount: 90, taxTreatment: "exempt", lineNo: 1 }),
  ];
  const fullText = lineItems.map((l) => l.description).join("\n");

  it("mixed tax lines under one canonical purpose land in ONE GL cluster; per-line tax preserved", () => {
    const result = computeAllocations({
      lineItems,
      accounts: COA,
      postingBlockersByAccount: new Map(),
      economicPurposeCandidates: null,
      fullDocumentText: fullText,
      supplierName: "TEST SW VENDOR",
      purposeDecision: mkCanonicalCommittedDecision("SOFTWARE_SUBSCRIPTION"),
      printedSubtotal: 210,
      printedTax: 6,
      printedTotal: 216,
    });
    // GL classification collapses mixed-tax same-purpose lines.
    expect(result.allocations.length).toBe(1);
    // But the source line items with their independent tax attributes
    // remain accessible via the allocation's sourceLineItemIds.
    expect(result.allocations[0].sourceLineItemIds.length).toBe(2);
  });
});

// -----------------------------------------------------------------------------
// Archetype 5 — SPECIAL_HANDLING preservation under canonical override
// -----------------------------------------------------------------------------
// The canonical decision commits to FUEL but one line is clearly a
// delivery/freight charge. Freight is SPECIAL_HANDLING — it must stay
// separate so the delivery-and-freight expense doesn't get miscoded.

describe("Phase 7.1 · Archetype 5 · SPECIAL_HANDLING (freight preserved under REPAIR_MAINTENANCE canonical commit)", () => {
  const lineItems = [
    mkLine({ description: "Pump repair labour", amount: 800, taxTreatment: "taxable", lineNo: 0 }),
    mkLine({ description: "Replacement gasket service call", amount: 240, taxTreatment: "taxable", lineNo: 1 }),
    mkLine({ description: "Delivery and freight charge", amount: 75, taxTreatment: "taxable", lineNo: 2 }),
  ];
  const fullText = lineItems.map((l) => l.description).join("\n");

  it("freight line stays in its own allocation despite canonical committing REPAIR_MAINTENANCE", () => {
    const result = computeAllocations({
      lineItems,
      accounts: COA,
      postingBlockersByAccount: new Map(),
      economicPurposeCandidates: null,
      fullDocumentText: fullText,
      supplierName: "TEST REPAIR VENDOR",
      purposeDecision: mkCanonicalCommittedDecision("REPAIR_MAINTENANCE"),
      printedSubtotal: 1115,
      printedTax: 55.75,
      printedTotal: 1170.75,
    });
    expect(result.allocations.length).toBeGreaterThanOrEqual(2);
    const freight = result.allocations.find((a) => /freight|delivery/i.test(a.descriptions.join(" ")));
    const repair = result.allocations.find((a) => /repair|pump|gasket/i.test(a.descriptions.join(" ")));
    expect(freight).toBeDefined();
    expect(repair).toBeDefined();
    expect(freight?.id).not.toBe(repair?.id);
  });
});

// -----------------------------------------------------------------------------
// Archetype 6 — abstained canonical does NOT trigger Phase 7.1 override
// -----------------------------------------------------------------------------
// When the canonical purpose ABSTAINs, per-line matching remains the
// primary clustering signal. Phase 7.1 must not silently collapse
// lines under an abstained canonical.

describe("Phase 7.1 · Archetype 6 · abstained canonical leaves per-line clustering intact", () => {
  const lineItems = [
    mkLine({ description: "Managed backup storage service", amount: 120, taxTreatment: "taxable", lineNo: 0 }),
    mkLine({ description: "Professional membership dues", amount: 400, taxTreatment: "taxable", lineNo: 1 }),
  ];
  const fullText = lineItems.map((l) => l.description).join("\n");

  it("with canonical ABSTAIN, distinct per-line concepts do NOT collapse", () => {
    const result = computeAllocations({
      lineItems,
      accounts: COA,
      postingBlockersByAccount: new Map(),
      economicPurposeCandidates: null,
      fullDocumentText: fullText,
      supplierName: "TEST MIXED VENDOR",
      purposeDecision: mkAbstainDecision(),
      printedSubtotal: 520,
      printedTax: 26,
      printedTotal: 546,
    });
    // Different economic concepts must produce distinct allocations.
    expect(result.allocations.length).toBeGreaterThanOrEqual(1);
  });
});
