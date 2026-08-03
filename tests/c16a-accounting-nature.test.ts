// Sprint 3 · Checkpoint 16A (2026-08-04) — accounting-nature
// classifier + positioned-table reconstructor + metamorphic
// accounting tests.
//
// Founder rule §14: dedicated accounting benchmark SEPARATE from
// extraction. §15 blind holdout uses unseen docs after the code
// is written. §16 metamorphic: change presentation without
// changing meaning; expected accounting nature must remain stable.

import { describe, expect, it } from "vitest";
import { classifyAccountingNature, accountTypesForNature, categoryHintsForNature } from "@/lib/ap-intelligence/accounting-nature";
import { reconstructLineItemTable } from "@/lib/ap-intelligence/positioned-table-reconstruct";
import type { PdfLayout, LayoutTextItem, LayoutVisualLine } from "@/lib/ap-intelligence/pdf-layout-extract";

// -----------------------------------------------------------------------------
// Accounting-nature — cross-nature accuracy
// -----------------------------------------------------------------------------

interface NatureCase {
  label: string;
  supplierName?: string;
  lineItemDescriptions: string[];
  fullDocumentText?: string;
  totalCents?: number;
  capitalThresholdCents?: number;
  expectedNature: string;
  expectAmbiguousOk?: boolean; // when multiple natures score similar, other-nature is acceptable
}

const NATURE_CASES: NatureCase[] = [
  {
    label: "durable equipment purchase with model and serial",
    supplierName: "Northlake Turf Products Ltd.",
    lineItemDescriptions: ["Fairway mower, model X48, serial 2202-99, includes installation"],
    fullDocumentText: "Purchase order for new fairway mower equipment. Model X48. Serial 2202-99. Installation included. Manufacturer warranty 2 years.",
    totalCents: 4_500_000,
    capitalThresholdCents: 500_000,
    expectedNature: "CAPITAL_ASSET",
  },
  {
    label: "repair parts (replacement seals, filters, gaskets)",
    lineItemDescriptions: ["Replacement seal for pump", "Oil filter", "Gasket kit"],
    expectedNature: "REPAIR_AND_MAINTENANCE",
  },
  {
    label: "cost of sales — food (produce, meat, dairy)",
    lineItemDescriptions: ["Produce order — mixed greens, tomatoes", "Seafood — fresh salmon 20lb", "Dairy — heavy cream 5gal"],
    expectedNature: "COST_OF_SALES",
  },
  {
    label: "monthly utility (electricity)",
    lineItemDescriptions: ["Electricity service June 2026"],
    fullDocumentText: "Monthly electricity service. Billing period June 1-30, 2026. Hydro charges.",
    expectedNature: "UTILITY_OR_RECURRING_SERVICE",
  },
  {
    label: "professional service — external audit",
    lineItemDescriptions: ["Annual audit fees — year ended Dec 31 2025"],
    fullDocumentText: "External audit and accounting services for fiscal year 2025.",
    expectedNature: "PROFESSIONAL_SERVICE",
  },
  {
    label: "recurring software subscription",
    lineItemDescriptions: ["Monthly subscription — cloud POS platform"],
    fullDocumentText: "Recurring monthly subscription. Billing period covers August 2026.",
    expectedNature: "UTILITY_OR_RECURRING_SERVICE",
  },
  {
    label: "professional membership dues",
    lineItemDescriptions: ["Professional membership renewal — CPA institute"],
    expectedNature: "PROFESSIONAL_SERVICE",
  },
  {
    label: "interest / penalty invoice",
    lineItemDescriptions: ["Late payment charge on overdue invoice"],
    fullDocumentText: "Interest charges assessed on the previous overdue amount. NSF fee.",
    expectedNature: "INTEREST_OR_PENALTY",
  },
  {
    label: "inventory purchase for resale — packaged beer",
    lineItemDescriptions: ["Case of packaged beer for resale"],
    fullDocumentText: "Wholesale beverage order for resale. Case count 24.",
    expectedNature: "INVENTORY",
  },
  {
    label: "office supplies (operating expense base case)",
    lineItemDescriptions: ["Office paper — 5000 sheets", "Ink cartridges for admin printer"],
    expectedNature: "OPERATING_EXPENSE",
  },
];

describe("16A · accounting-nature classifier — cross-nature accuracy", () => {
  for (const c of NATURE_CASES) {
    it(`classifies "${c.label}" as ${c.expectedNature}`, () => {
      const assessment = classifyAccountingNature({
        extraction: null,
        supplierName: c.supplierName ?? null,
        lineItemDescriptions: c.lineItemDescriptions,
        fullDocumentText: c.fullDocumentText ?? c.lineItemDescriptions.join(" "),
        capitalStateFromClassifier: null,
        totalCents: c.totalCents ?? null,
        capitalThresholdCents: c.capitalThresholdCents ?? null,
      });
      expect(assessment.leader, `leader for ${c.label}`).toBe(c.expectedNature);
      expect(assessment.leaderConfidence, `defensible score for ${c.label}`).toBeGreaterThanOrEqual(20);
    });
  }

  it("abstains as UNKNOWN when no evidence available", () => {
    const a = classifyAccountingNature({
      extraction: null, supplierName: null,
      lineItemDescriptions: [], fullDocumentText: "",
      capitalStateFromClassifier: null, totalCents: null, capitalThresholdCents: null,
    });
    expect(a.leader).toBe("UNKNOWN");
    expect(a.isDefensible).toBe(false);
  });

  it("does NOT classify as CAPITAL_ASSET on high amount alone", () => {
    const a = classifyAccountingNature({
      extraction: null, supplierName: null,
      lineItemDescriptions: ["Monthly electricity bill"],
      fullDocumentText: "Utility service.",
      capitalStateFromClassifier: null,
      totalCents: 50_000_000, capitalThresholdCents: 500_000, // WAY above threshold
    });
    expect(a.leader).not.toBe("CAPITAL_ASSET");
  });
});

// -----------------------------------------------------------------------------
// §16 metamorphic — same accounting substance, different presentation
// -----------------------------------------------------------------------------

describe("16A · §16 metamorphic — accounting nature is stable under presentation changes", () => {
  it("same equipment purchase from different suppliers → same nature (CAPITAL_ASSET)", () => {
    const commonDesc = ["Commercial oven, model CV-500, serial 88221, installation included"];
    const A = classifyAccountingNature({
      extraction: null, supplierName: "Aardvark Restaurant Supply Inc.",
      lineItemDescriptions: commonDesc, fullDocumentText: commonDesc.join(" "),
      capitalStateFromClassifier: "CAPITAL", totalCents: 800_000, capitalThresholdCents: 500_000,
    });
    const B = classifyAccountingNature({
      extraction: null, supplierName: "Zebra Kitchen Equipment Ltd.",
      lineItemDescriptions: commonDesc, fullDocumentText: commonDesc.join(" "),
      capitalStateFromClassifier: "CAPITAL", totalCents: 800_000, capitalThresholdCents: 500_000,
    });
    expect(A.leader).toBe(B.leader);
    expect(A.leader).toBe("CAPITAL_ASSET");
  });

  it("same supplier — one invoice is capital, another is repair — natures diverge on evidence not supplier", () => {
    const supplier = "Northlake Turf Products Ltd.";
    const capitalDesc = ["New tractor unit — model FX7 serial ABC123, installation"];
    const repairDesc = ["Replacement seal for tractor pump", "Oil filter", "Gasket"];
    const capital = classifyAccountingNature({
      extraction: null, supplierName: supplier,
      lineItemDescriptions: capitalDesc, fullDocumentText: capitalDesc.join(" "),
      capitalStateFromClassifier: null, totalCents: 3_500_000, capitalThresholdCents: 500_000,
    });
    const repair = classifyAccountingNature({
      extraction: null, supplierName: supplier,
      lineItemDescriptions: repairDesc, fullDocumentText: repairDesc.join(" "),
      capitalStateFromClassifier: null, totalCents: 20_000, capitalThresholdCents: 500_000,
    });
    expect(capital.leader).toBe("CAPITAL_ASSET");
    expect(repair.leader).toBe("REPAIR_AND_MAINTENANCE");
  });

  it("description reordering / synonym variation preserves nature", () => {
    const A = classifyAccountingNature({
      extraction: null, supplierName: null,
      lineItemDescriptions: ["Fresh produce, dairy, meat delivery"],
      fullDocumentText: "Weekly food delivery for restaurant.",
      capitalStateFromClassifier: null, totalCents: 200_000, capitalThresholdCents: 500_000,
    });
    const B = classifyAccountingNature({
      extraction: null, supplierName: null,
      lineItemDescriptions: ["Meat, dairy and produce order"],
      fullDocumentText: "Weekly restaurant food cost.",
      capitalStateFromClassifier: null, totalCents: 200_000, capitalThresholdCents: 500_000,
    });
    expect(A.leader).toBe(B.leader);
    expect(A.leader).toBe("COST_OF_SALES");
  });
});

// -----------------------------------------------------------------------------
// Bridge — accountTypesForNature and categoryHintsForNature
// -----------------------------------------------------------------------------

describe("16A · nature → account-type + category bridge", () => {
  it("CAPITAL_ASSET maps to ASSET account type only", () => {
    expect(accountTypesForNature("CAPITAL_ASSET")).toEqual(["ASSET"]);
  });
  it("OPERATING / R&M / PROFESSIONAL / UTILITY / COS all map to EXPENSE", () => {
    for (const n of ["OPERATING_EXPENSE", "REPAIR_AND_MAINTENANCE", "PROFESSIONAL_SERVICE", "UTILITY_OR_RECURRING_SERVICE", "COST_OF_SALES"] as const) {
      expect(accountTypesForNature(n)).toEqual(["EXPENSE"]);
    }
  });
  it("category hints exist for every nature except UNKNOWN", () => {
    for (const n of ["CAPITAL_ASSET","REPAIR_AND_MAINTENANCE","INVENTORY","COST_OF_SALES","UTILITY_OR_RECURRING_SERVICE","PROFESSIONAL_SERVICE","PREPAID_EXPENSE","TAX_OR_REGULATORY","INTEREST_OR_PENALTY","OPERATING_EXPENSE"] as const) {
      expect(categoryHintsForNature(n).length).toBeGreaterThan(0);
    }
    expect(categoryHintsForNature("UNKNOWN")).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Positioned-table reconstructor — smoke + column detection
// -----------------------------------------------------------------------------

function makeItem(text: string, page: number, x: number, y: number, w = 20, h = 8): LayoutTextItem {
  return { text, page, x, y, width: w, height: h };
}
function makeLine(items: LayoutTextItem[], y: number, page = 1): LayoutVisualLine {
  return { page, y, text: items.map((it) => it.text).join(" | "), items };
}

describe("16A · §5 positioned-table reconstructor", () => {
  it("detects a header row and recovers line items with 5-column layout", () => {
    const header = makeLine([
      makeItem("SKU", 1, 20, 100, 20),
      makeItem("Description", 1, 100, 100, 60),
      makeItem("Qty", 1, 300, 100, 15),
      makeItem("Unit Price", 1, 380, 100, 40),
      makeItem("Amount", 1, 500, 100, 30),
    ], 100);
    const row1 = makeLine([
      makeItem("72-9361", 1, 20, 120),
      makeItem("CUP-SCALP. ANTI", 1, 100, 120),
      makeItem("4", 1, 300, 120),
      makeItem("48.76", 1, 380, 120),
      makeItem("195.04", 1, 500, 120),
    ], 120);
    const row2 = makeLine([
      makeItem("253-154", 1, 20, 140),
      makeItem("SEAL-OIL", 1, 100, 140),
      makeItem("12", 1, 300, 140),
      makeItem("9.04", 1, 380, 140),
      makeItem("108.48", 1, 500, 140),
    ], 140);
    const total = makeLine([
      makeItem("Total:", 1, 380, 200),
      makeItem("303.52", 1, 500, 200),
    ], 200);
    const layout: PdfLayout = {
      pageCount: 1,
      items: [...header.items, ...row1.items, ...row2.items, ...total.items],
      visualLines: [header, row1, row2, total],
      flattenedText: "",
    };
    const res = reconstructLineItemTable(layout);
    expect(res.headerFound).toBe(true);
    expect(res.detectedColumns.length).toBeGreaterThanOrEqual(3);
    expect(res.lineItems.length).toBe(2);
    expect(res.lineItems[0].sku).toBe("72-9361");
    expect(res.lineItems[0].description).toContain("CUP-SCALP");
    expect(res.lineItems[0].amount).toBeCloseTo(195.04);
    expect(res.lineItems[1].sku).toBe("253-154");
    expect(res.lineItems[1].amount).toBeCloseTo(108.48);
    // Summary row must be rejected.
    expect(res.rejectedRows.some((r) => r.reason === "SUMMARY_ROW_LEADING")).toBe(true);
  });

  it("returns empty when no header can be found", () => {
    const line = makeLine([
      makeItem("Free-form text", 1, 20, 100),
    ], 100);
    const layout: PdfLayout = {
      pageCount: 1, items: line.items, visualLines: [line], flattenedText: "",
    };
    const res = reconstructLineItemTable(layout);
    expect(res.headerFound).toBe(false);
    expect(res.lineItems.length).toBe(0);
  });

  it("rejects footer/policy text below the item table", () => {
    const header = makeLine([
      makeItem("Item", 1, 20, 100, 20),
      makeItem("Amount", 1, 500, 100, 30),
    ], 100);
    const row1 = makeLine([
      makeItem("Widget", 1, 20, 120),
      makeItem("15.00", 1, 500, 120),
    ], 120);
    const policy = makeLine([
      makeItem("Please note our return policy applies to all purchases.", 1, 20, 140),
    ], 140);
    const layout: PdfLayout = {
      pageCount: 1,
      items: [...header.items, ...row1.items, ...policy.items],
      visualLines: [header, row1, policy],
      flattenedText: "",
    };
    const res = reconstructLineItemTable(layout);
    expect(res.lineItems.length).toBe(1);
    expect(res.rejectedRows.some((r) => r.reason === "POLICY_TEXT")).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// §11 architecture guard — no acceptance-specific strings in production
// -----------------------------------------------------------------------------

describe("16A · architecture guards", () => {
  it("accounting-nature.ts has no supplier / SKU / filename specificity", async () => {
    const src = await (await import("node:fs")).promises.readFile(
      new URL("../src/lib/ap-intelligence/accounting-nature.ts", import.meta.url),
      "utf8",
    );
    for (const forbidden of ["Oakcreek", "1091559", "1087769", "30629", "72-9361", "cbb3900e"]) {
      expect(src).not.toContain(forbidden);
    }
  });

  it("positioned-table-reconstruct.ts has no supplier / SKU / filename specificity", async () => {
    const src = await (await import("node:fs")).promises.readFile(
      new URL("../src/lib/ap-intelligence/positioned-table-reconstruct.ts", import.meta.url),
      "utf8",
    );
    for (const forbidden of ["Oakcreek", "1091559", "1087769", "30629", "72-9361", "cbb3900e"]) {
      expect(src).not.toContain(forbidden);
    }
  });
});
