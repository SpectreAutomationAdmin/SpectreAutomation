// Sprint 3 · Checkpoint 16C (2026-08-04) — calibrated accounting
// nature + nature-scoped ranker + unified amount formatter.
//
// Founder rules covered:
//   §2 concept-family evidence aggregation
//   §3 repair-vs-capital distinction
//   §5-§8 nature-scoped COA search
//   §14+§15 unified amount format
//   §16 accounting benchmark
//   §18 metamorphic accounting invariance

import { describe, expect, it } from "vitest";
import { classifyAccountingNature } from "@/lib/ap-intelligence/accounting-nature";
import { rankNatureScopedAccounts, type CoaAccount } from "@/lib/ap-intelligence/nature-scoped-ranker";
import { formatWorkIntakeAmount } from "@/lib/ap-intelligence/format-amount";

// -----------------------------------------------------------------------------
// §2 + §3 — concept-family cluster bonus for replacement parts
// -----------------------------------------------------------------------------

describe("16C · §2 concept-family cluster bonus (repair regression fix)", () => {
  it("SEAL + BEARING + SPACER on separate lines → REPAIR defensible (was UNKNOWN@13)", () => {
    const res = classifyAccountingNature({
      extraction: null, supplierName: null,
      lineItemDescriptions: [
        "72-9361 | CUP-SCALP. ANTI",       // no repair token
        "253-154 | SEAL-OIL",              // seal
        "100-5703 | SPACER AND BEARING ASM", // spacer + bearing + asm
      ],
      fullDocumentText: "72-9361 CUP-SCALP. ANTI 253-154 SEAL-OIL 100-5703 SPACER AND BEARING ASM",
      capitalStateFromClassifier: null, totalCents: 100_000, capitalThresholdCents: 500_000,
    });
    expect(res.leader).toBe("REPAIR_AND_MAINTENANCE");
    expect(res.isDefensible).toBe(true);
    expect(res.leaderConfidence).toBeGreaterThanOrEqual(20);
    // Cluster bonus is cited.
    const evidence = res.ranked[0].supportingEvidence.join(",");
    expect(evidence).toMatch(/cluster_bonus_\d\+_lines/);
  });

  it("single stray SEAL token → still weak (no false-positive cluster bonus)", () => {
    const res = classifyAccountingNature({
      extraction: null, supplierName: null,
      lineItemDescriptions: ["Some description with seal word"],
      fullDocumentText: "Some description with seal word.",
      capitalStateFromClassifier: null, totalCents: null, capitalThresholdCents: null,
    });
    // One weak-signal line — cluster bonus needs ≥2 distinct lines
    // firing weak terms.  Result should NOT be REPAIR-defensible.
    expect(res.leader).not.toBe("REPAIR_AND_MAINTENANCE");
  });

  it("5-line replacement-parts invoice → highest-tier cluster bonus applied", () => {
    const res = classifyAccountingNature({
      extraction: null, supplierName: null,
      lineItemDescriptions: [
        "PART-1 SEAL kit",
        "PART-2 BEARING kit",
        "PART-3 GASKET replacement",
        "PART-4 FILTER unit",
        "PART-5 HOSE assembly",
      ],
      fullDocumentText: "seal bearing gasket filter hose",
      capitalStateFromClassifier: null, totalCents: null, capitalThresholdCents: null,
    });
    expect(res.leader).toBe("REPAIR_AND_MAINTENANCE");
    const evidence = res.ranked[0].supportingEvidence.join(",");
    expect(evidence).toMatch(/cluster_bonus_5\+_lines/);
  });
});

describe("16C · §3 capital-vs-repair distinction", () => {
  it("complete equipment purchase → CAPITAL_ASSET (not REPAIR)", () => {
    const res = classifyAccountingNature({
      extraction: null, supplierName: null,
      lineItemDescriptions: ["New fairway mower, model X48, serial 22-99, installation included"],
      fullDocumentText: "Complete new fairway mower equipment model X48 serial 22-99 warranty 2 years installation.",
      capitalStateFromClassifier: null, totalCents: 4_500_000, capitalThresholdCents: 500_000,
    });
    expect(res.leader).toBe("CAPITAL_ASSET");
  });

  it("replacement parts should NOT be miscoded as CAPITAL despite serial numbers on parts", () => {
    const res = classifyAccountingNature({
      extraction: null, supplierName: null,
      lineItemDescriptions: [
        "SEAL kit replacement part serial 22-9",
        "BEARING replacement",
        "SPACER assembly",
      ],
      fullDocumentText: "Replacement parts for existing tractor. SEAL BEARING SPACER assembly repair kit.",
      capitalStateFromClassifier: null, totalCents: 800_000, capitalThresholdCents: 500_000,
    });
    // Repair-kit terminology + component cluster should beat the
    // stray "serial" token that CAPITAL's strongTerms picks up.
    expect(res.leader).toBe("REPAIR_AND_MAINTENANCE");
  });
});

// -----------------------------------------------------------------------------
// §5-§8 — nature-scoped COA search
// -----------------------------------------------------------------------------

function makeCoa(overrides: Partial<CoaAccount> = {}): CoaAccount {
  return {
    id: "acc-" + Math.random().toString(36).slice(2, 8),
    accountNumber: overrides.accountNumber ?? "0000",
    name: overrides.name ?? "Account",
    type: overrides.type ?? "EXPENSE",
    isActive: true,
    isHeader: false,
    isControlAccount: false,
    allowManualPosting: true,
    categoryKey: overrides.categoryKey ?? null,
    categoryName: overrides.categoryName ?? null,
    fsGroupKey: overrides.fsGroupKey ?? null,
    fsGroupName: overrides.fsGroupName ?? null,
    fundApplicability: overrides.fundApplicability ?? "GENERAL",
    ...overrides,
  };
}

describe("16C · §5-§8 nature-scoped COA branch search", () => {
  it("CAPITAL_ASSET nature finds all ASSET-typed capital-family accounts", () => {
    const accounts: CoaAccount[] = [
      makeCoa({ accountNumber: "1500", name: "Course Equipment", type: "ASSET", categoryKey: "FIXED_ASSETS" }),
      makeCoa({ accountNumber: "1501", name: "Vehicles", type: "ASSET", categoryKey: "FIXED_ASSETS" }),
      makeCoa({ accountNumber: "1502", name: "Buildings", type: "ASSET", categoryKey: "FIXED_ASSETS" }),
      makeCoa({ accountNumber: "1599", name: "Accumulated Depreciation - Equipment", type: "ASSET", categoryKey: "FIXED_ASSETS" }),
      makeCoa({ accountNumber: "6023", name: "Delivery & Shipping Expenses", type: "EXPENSE", categoryKey: "OTHER_EXPENSES" }),
      makeCoa({ accountNumber: "6072", name: "Telephone & Internet", type: "EXPENSE", categoryKey: "ADMIN_EXPENSES" }),
    ];
    const res = rankNatureScopedAccounts({
      nature: "CAPITAL_ASSET", natureConfidence: 60,
      allAccounts: accounts,
      lineItemDescriptions: ["new golf course mower equipment"],
      fullDocumentText: "purchase of course equipment tractor",
      supplierName: null,
    });
    // Compatible = 3 (1500, 1501, 1502) — excludes accum depreciation, EXPENSE accounts.
    expect(res.compatibleAccountCount).toBe(3);
    expect(res.excludedReasons.contra_or_depreciation).toBe(1);
    expect(res.excludedReasons.type_mismatch).toBe(2);
    // Leader is Course Equipment (name-hint hits + evidence match).
    expect(res.leader?.account.name).toBe("Course Equipment");
  });

  it("REPAIR_AND_MAINTENANCE finds R&M expense accounts and skips capital assets", () => {
    const accounts: CoaAccount[] = [
      makeCoa({ accountNumber: "6100", name: "Repairs & Maintenance - Grounds", type: "EXPENSE", categoryKey: "REPAIRS_MAINTENANCE" }),
      makeCoa({ accountNumber: "6101", name: "Repair Parts - Kitchen", type: "EXPENSE", categoryKey: "REPAIRS_MAINTENANCE" }),
      makeCoa({ accountNumber: "1500", name: "Course Equipment", type: "ASSET", categoryKey: "FIXED_ASSETS" }),
    ];
    const res = rankNatureScopedAccounts({
      nature: "REPAIR_AND_MAINTENANCE", natureConfidence: 40,
      allAccounts: accounts,
      lineItemDescriptions: ["SEAL kit for grounds tractor"],
      fullDocumentText: "grounds repair parts",
      supplierName: null,
    });
    expect(res.compatibleAccountCount).toBe(2);
    expect(res.leader?.account.accountNumber).toBe("6100");
  });

  it("excludes header + inactive + control accounts + accum-depreciation", () => {
    const accounts: CoaAccount[] = [
      makeCoa({ name: "Fixed Assets [HEADER]", type: "ASSET", isHeader: true, categoryKey: "FIXED_ASSETS" }),
      makeCoa({ name: "Course Equipment", type: "ASSET", isActive: false, categoryKey: "FIXED_ASSETS" }),
      makeCoa({ name: "Accounts Payable Control", type: "LIABILITY", isControlAccount: true }),
      makeCoa({ name: "Accumulated Depreciation - Buildings", type: "ASSET", categoryKey: "FIXED_ASSETS" }),
      makeCoa({ accountNumber: "1500", name: "Course Equipment", type: "ASSET", categoryKey: "FIXED_ASSETS" }),
    ];
    const res = rankNatureScopedAccounts({
      nature: "CAPITAL_ASSET", natureConfidence: 60,
      allAccounts: accounts,
      lineItemDescriptions: ["equipment"],
      fullDocumentText: "equipment purchase",
      supplierName: null,
    });
    expect(res.excludedReasons.header).toBe(1);
    expect(res.excludedReasons.inactive).toBe(1);
    expect(res.excludedReasons.contra_or_depreciation).toBe(1);
    // Only accountNumber 1500 remains.
    expect(res.compatibleAccountCount).toBe(1);
  });

  it("UTILITY nature ranks Telephone & Internet by name-hint when categoryKey is ADMIN_EXPENSES", () => {
    // Reproduces Coulee Ridge's actual COA shape.
    const accounts: CoaAccount[] = [
      makeCoa({ accountNumber: "6072", name: "Telephone & Internet", type: "EXPENSE", categoryKey: "ADMIN_EXPENSES" }),
      makeCoa({ accountNumber: "6073", name: "Utilities - Hydro", type: "EXPENSE", categoryKey: "ADMIN_EXPENSES" }),
      makeCoa({ accountNumber: "6074", name: "Utilities - Natural Gas", type: "EXPENSE", categoryKey: "ADMIN_EXPENSES" }),
      makeCoa({ accountNumber: "6075", name: "Office Supplies", type: "EXPENSE", categoryKey: "ADMIN_EXPENSES" }),
    ];
    const res = rankNatureScopedAccounts({
      nature: "UTILITY_OR_RECURRING_SERVICE", natureConfidence: 60,
      allAccounts: accounts,
      lineItemDescriptions: ["Internet: 25 mbit/s"],
      fullDocumentText: "Ongoing charges Internet plan monthly",
      supplierName: null,
    });
    // All 4 EXPENSE accounts are compatible via category or name.
    expect(res.compatibleAccountCount).toBe(4);
    // Leader should be Telephone & Internet (name-hint hit + evidence).
    expect(res.leader?.account.accountNumber).toBe("6072");
  });
});

// -----------------------------------------------------------------------------
// §14 + §15 — unified amount formatter
// -----------------------------------------------------------------------------

describe("16C · §15 unified amount formatter", () => {
  it("40.32 CAD → $40.32 CAD", () => {
    expect(formatWorkIntakeAmount({ amount: 40.32, currency: "CAD" })).toBe("$40.32 CAD");
  });
  it("1056.22 CAD → $1,056.22 CAD", () => {
    expect(formatWorkIntakeAmount({ amount: 1056.22, currency: "CAD" })).toBe("$1,056.22 CAD");
  });
  it("77833.35 CAD → $77,833.35 CAD", () => {
    expect(formatWorkIntakeAmount({ amount: 77833.35, currency: "CAD" })).toBe("$77,833.35 CAD");
  });
  it("0 CAD → $0.00 CAD", () => {
    expect(formatWorkIntakeAmount({ amount: 0, currency: "CAD" })).toBe("$0.00 CAD");
  });
  it("-150 CAD → consistent negative format", () => {
    expect(formatWorkIntakeAmount({ amount: -150, currency: "CAD" })).toBe("$-150.00 CAD");
  });
  it("null amount → dash", () => {
    expect(formatWorkIntakeAmount({ amount: null, currency: "CAD" })).toBe("—");
  });
  it("amount with no currency → bare formatted number (no fabricated ISO)", () => {
    expect(formatWorkIntakeAmount({ amount: 1056.22, currency: null })).toBe("1,056.22");
  });
  it("amount + tenantDefaultCurrency fallback → uses fallback", () => {
    expect(formatWorkIntakeAmount({ amount: 1056.22, currency: null, tenantDefaultCurrency: "CAD" })).toBe("$1,056.22 CAD");
  });
  it("USD → $ prefix + USD suffix", () => {
    expect(formatWorkIntakeAmount({ amount: 500, currency: "USD" })).toBe("$500.00 USD");
  });
  it("EUR → € prefix + EUR suffix", () => {
    expect(formatWorkIntakeAmount({ amount: 500, currency: "EUR" })).toBe("€500.00 EUR");
  });
  it("string-typed amount input → same output", () => {
    expect(formatWorkIntakeAmount({ amount: "77833.35", currency: "CAD" })).toBe("$77,833.35 CAD");
  });
  it("invalid string amount → dash", () => {
    expect(formatWorkIntakeAmount({ amount: "abc", currency: "CAD" })).toBe("—");
  });
});

// -----------------------------------------------------------------------------
// §16 expanded accounting benchmark (14 cases minimum)
// -----------------------------------------------------------------------------

describe("16C · §16 expanded accounting benchmark", () => {
  const CASES: Array<{ label: string; text: string; expected: string; totalCents?: number }> = [
    { label: "replacement parts for existing equipment", text: "SEAL kit BEARING kit GASKET replacement filter service kit", expected: "REPAIR_AND_MAINTENANCE" },
    { label: "complete capital equipment", text: "Purchase new tractor equipment model FX7 serial 22-99 warranty installation", expected: "CAPITAL_ASSET", totalCents: 4_500_000 },
    { label: "repair labour + parts", text: "Preventive maintenance labour + replacement seal + gasket", expected: "REPAIR_AND_MAINTENANCE" },
    { label: "consumables", text: "office paper 5000 sheets ink cartridges printer", expected: "OPERATING_EXPENSE" },
    { label: "capital improvement — leasehold", text: "leasehold improvement building renovation flooring installation capital", expected: "CAPITAL_ASSET", totalCents: 8_000_000 },
    { label: "recurring internet/communications", text: "monthly internet service plan billing cycle mbit/s wifi", expected: "UTILITY_OR_RECURRING_SERVICE" },
    { label: "professional membership", text: "annual professional membership renewal CPA institute", expected: "PROFESSIONAL_SERVICE" },
    { label: "professional accounting service", text: "external audit accounting services fiscal year 2025 tax preparation", expected: "PROFESSIONAL_SERVICE" },
    { label: "groceries + delivery surcharge", text: "produce dairy meat seafood delivery surcharge food cost", expected: "COST_OF_SALES" },
    { label: "packaged beverage", text: "packaged beer wholesale for resale case of 24", expected: "INVENTORY" },
    { label: "interest / late penalty", text: "late payment charge interest overdue NSF fee", expected: "INTEREST_OR_PENALTY" },
    { label: "no-suitable-account case", text: "abstract text with no clear accounting nature signal", expected: "UNKNOWN" },
    { label: "mixed capital + freight/installation", text: "new commercial oven equipment model XZ100 with installation and freight shipping", expected: "CAPITAL_ASSET", totalCents: 2_500_000 },
    { label: "small tools (operating baseline)", text: "small tools office supplies for administration", expected: "OPERATING_EXPENSE" },
  ];

  for (const c of CASES) {
    it(`benchmark: ${c.label}`, () => {
      const res = classifyAccountingNature({
        extraction: null, supplierName: null,
        lineItemDescriptions: [c.text],
        fullDocumentText: c.text,
        capitalStateFromClassifier: null,
        totalCents: c.totalCents ?? 100_000,
        capitalThresholdCents: 500_000,
      });
      expect(res.leader, `case '${c.label}' expected ${c.expected}, got ${res.leader}`).toBe(c.expected);
    });
  }
});

// -----------------------------------------------------------------------------
// §18 metamorphic — accounting substance invariance
// -----------------------------------------------------------------------------

describe("16C · §18 metamorphic accounting invariance", () => {
  it("same replacement parts wording invariance", () => {
    const A = classifyAccountingNature({
      extraction: null, supplierName: null,
      lineItemDescriptions: ["SEAL kit A1", "BEARING kit A2", "SPACER A3"],
      fullDocumentText: "seal bearing spacer",
      capitalStateFromClassifier: null, totalCents: null, capitalThresholdCents: null,
    });
    const B = classifyAccountingNature({
      extraction: null, supplierName: null,
      lineItemDescriptions: ["B1 kit for seal", "B2 bearing replacement", "B3 spacer part"],
      fullDocumentText: "seal replacement bearing spacer part",
      capitalStateFromClassifier: null, totalCents: null, capitalThresholdCents: null,
    });
    expect(A.leader).toBe(B.leader);
    expect(A.leader).toBe("REPAIR_AND_MAINTENANCE");
  });

  it("same equipment purchased from different suppliers → same CAPITAL_ASSET", () => {
    const desc = "New commercial oven equipment model CV-500 serial 88 installation warranty";
    const A = classifyAccountingNature({
      extraction: null, supplierName: "Aardvark Restaurant Supply Inc.",
      lineItemDescriptions: [desc], fullDocumentText: desc,
      capitalStateFromClassifier: null, totalCents: 900_000, capitalThresholdCents: 500_000,
    });
    const B = classifyAccountingNature({
      extraction: null, supplierName: "Zebra Kitchen Equipment Ltd.",
      lineItemDescriptions: [desc], fullDocumentText: desc,
      capitalStateFromClassifier: null, totalCents: 900_000, capitalThresholdCents: 500_000,
    });
    expect(A.leader).toBe(B.leader);
    expect(A.leader).toBe("CAPITAL_ASSET");
  });

  it("same supplier sells both a complete unit and replacement parts — nature diverges on invoice evidence", () => {
    const supplier = "Northlake Turf Products Ltd.";
    const capital = classifyAccountingNature({
      extraction: null, supplierName: supplier,
      lineItemDescriptions: ["New fairway mower model X48 serial 22 installation"],
      fullDocumentText: "new complete tractor equipment model X48 serial",
      capitalStateFromClassifier: null, totalCents: 3_500_000, capitalThresholdCents: 500_000,
    });
    const repair = classifyAccountingNature({
      extraction: null, supplierName: supplier,
      lineItemDescriptions: ["SEAL replacement", "BEARING kit", "FILTER unit"],
      fullDocumentText: "replacement parts seal bearing filter",
      capitalStateFromClassifier: null, totalCents: 20_000, capitalThresholdCents: 500_000,
    });
    expect(capital.leader).toBe("CAPITAL_ASSET");
    expect(repair.leader).toBe("REPAIR_AND_MAINTENANCE");
  });
});

// -----------------------------------------------------------------------------
// Anti-hardcoding guard
// -----------------------------------------------------------------------------

describe("16C · anti-hardcoding", () => {
  const FORBIDDEN = ["Oakcreek", "Oxio", "OXIO", "1091559", "1087769", "00108064", "23375874", "30629", "72-9361", "cbb3900e", "5ed48c9d"];
  const FILES = [
    "accounting-nature.ts",
    "nature-scoped-ranker.ts",
    "format-amount.ts",
    "positioned-table-reconstruct.ts",
    "department-inference.ts",
  ];
  for (const f of FILES) {
    it(`${f} contains no acceptance-specific strings`, async () => {
      const src = await (await import("node:fs")).promises.readFile(
        new URL(`../src/lib/ap-intelligence/${f}`, import.meta.url),
        "utf8",
      );
      for (const forbidden of FORBIDDEN) {
        expect(src, `${f} contains "${forbidden}"`).not.toContain(forbidden);
      }
    });
  }
});
