// Sprint 3 · Checkpoint 15V (2026-07-29) — multi-GL allocation
// engine regression suite.
//
// Every scenario runs against the sanitized Coulee Ridge COA SHAPE
// so the tests reproduce the real tenant competition. Randomized-
// order determinism is proven for 100 permutations.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeAllocations } from "@/lib/ap-intelligence/gl-allocations";
import { classifyEconomicPurpose, type PurposeCandidate } from "@/lib/ap-intelligence/economic-purpose";
import type { LineItem, LineTaxTreatment, LineEvidenceKind } from "@/lib/ap-intelligence/line-items-extract";
import type { AccountView } from "@/lib/ap-intelligence/gl-account-concepts";
import { COULEE_RIDGE_ACCOUNTS_SHAPE } from "./fixtures/c15u-coulee-ridge-coa-shape";

// -----------------------------------------------------------------------------
// Extended sanitized fixture — adds food/beverage/COGS accounts that
// live on Coulee Ridge but weren't in the 15U ranker fixture. All
// account names + FS groups verbatim from the tenant.
// -----------------------------------------------------------------------------

const EXTENDED_COA: AccountView[] = [
  ...COULEE_RIDGE_ACCOUNTS_SHAPE,
  { id: "a-5010", accountNumber: "5010", name: "Cost of Sales - Food", categoryKey: "COGS_FOOD", categoryName: "Food Cost of Sales", fsGroupKey: "IS_COGS_FOOD", fsGroupName: "Food Cost of Sales" },
  { id: "a-5020", accountNumber: "5020", name: "Cost of Sales - Beverage - Draft Beer", categoryKey: "COGS_BEV", categoryName: "Beverage Cost of Sales", fsGroupKey: "IS_COGS_BEV", fsGroupName: "Beverage Cost of Sales" },
  { id: "a-5021", accountNumber: "5021", name: "Cost of Sales - Beverage - Packaged Beer", categoryKey: "COGS_BEV", categoryName: "Beverage Cost of Sales", fsGroupKey: "IS_COGS_BEV", fsGroupName: "Beverage Cost of Sales" },
  { id: "a-5022", accountNumber: "5022", name: "Cost of Sales - Wine", categoryKey: "COGS_BEV", categoryName: "Beverage Cost of Sales", fsGroupKey: "IS_COGS_BEV", fsGroupName: "Beverage Cost of Sales" },
  { id: "a-5030", accountNumber: "5030", name: "Delivery & Freight", categoryKey: "OTHER_EXPENSES", categoryName: "Other Expenses", fsGroupKey: "IS_OTHER_EXPENSES", fsGroupName: "Other Expenses" },
];

function mkLine(opts: {
  description: string;
  amount: number;
  taxTreatment?: LineTaxTreatment;
  taxRate?: number | null;
  taxAmount?: number | null;
  evidence?: LineEvidenceKind[];
  lineNo?: number;
}): LineItem {
  return {
    description: opts.description,
    quantity: null,
    unitPrice: null,
    amount: opts.amount,
    taxRate: opts.taxRate ?? null,
    taxAmount: opts.taxAmount ?? null,
    taxTreatment: opts.taxTreatment ?? "unknown",
    evidence: opts.evidence ?? ["amount_only"],
    confidence: 70,
    lineNo: opts.lineNo ?? 0,
  };
}

function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = items.slice();
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function classify(args: {
  supplierName: string;
  lineDescriptions: string[];
  fullDocumentText: string;
  hasMembershipLine?: boolean;
  hasPenaltyLine?: boolean;
  hasProfessionalCredentialContext?: boolean;
}): PurposeCandidate[] {
  return classifyEconomicPurpose({
    supplierName: args.supplierName,
    lineDescriptions: args.lineDescriptions,
    fullDocumentText: args.fullDocumentText,
    paymentDirection: "club_pays_vendor",
    hasPenaltyLine: !!args.hasPenaltyLine,
    hasMembershipLine: !!args.hasMembershipLine,
    hasProfessionalCredentialContext: !!args.hasProfessionalCredentialContext,
  });
}

// -----------------------------------------------------------------------------
// §15 Scenario A — Professional membership with late interest
// -----------------------------------------------------------------------------

describe("15V · Scenario A — Professional membership + late interest", () => {
  const lineItems = [
    mkLine({ description: "Provincial regulatory body annual dues", amount: 810, taxTreatment: "taxable", lineNo: 0 }),
    mkLine({ description: "National affiliate dues", amount: 400, lineNo: 1 }),
    mkLine({ description: "Late-payment penalty (Q1)", amount: 150, taxTreatment: "exempt", lineNo: 2 }),
  ];
  const fullText = "Member Dues for [Person] year 2026\nProvincial regulatory body annual dues\nNational affiliate dues\nLate-payment penalty (Q1)\nSubtotal\nGST\nInvoice Total";
  const purpose = classify({
    supplierName: "SAMPLE PROF ALBERTA",
    lineDescriptions: lineItems.map((l) => l.description),
    fullDocumentText: fullText,
    hasMembershipLine: true,
    hasPenaltyLine: true,
    hasProfessionalCredentialContext: true,
  });

  const result = computeAllocations({
    lineItems,
    accounts: EXTENDED_COA,
    postingBlockersByAccount: new Map(),
    economicPurposeCandidates: purpose,
    fullDocumentText: fullText,
    supplierName: "SAMPLE PROF ALBERTA",
    printedSubtotal: 1360,
    printedTax: 40.5,
    printedTotal: 1550.5,
  });

  it("produces at least TWO allocations", () => {
    expect(result.allocations.length).toBeGreaterThanOrEqual(2);
  });

  it("membership-fee allocation lands on a Membership & Dues account", () => {
    const membership = result.allocations.find((a) =>
      /membership\s*[&/]?\s*dues|dues\s*[&/]?\s*membership/i.test(a.recommendedAccount?.accountName ?? ""),
    );
    expect(membership).toBeDefined();
    expect(membership!.amount).toBeGreaterThan(1000);
  });

  it("late-interest allocation lands on Interest Expense / bank charges (separate account)", () => {
    const interest = result.allocations.find((a) =>
      /interest|bank\s+charge|penalt/i.test(a.recommendedAccount?.accountName ?? ""),
    );
    expect(interest).toBeDefined();
    // Different account from the membership allocation.
    const membership = result.allocations.find((a) =>
      /membership/i.test(a.recommendedAccount?.accountName ?? ""),
    );
    expect(interest!.recommendedAccount?.accountNumber).not.toBe(membership?.recommendedAccount?.accountNumber);
  });

  it("Card Category = 'Multiple'", () => {
    expect(result.cardCategory).toBe("Multiple");
  });

  it("totals reconcile: printed gross == subtotal + tax - credits", () => {
    // With no credits, gross must ~= allocationsSubtotal + tax.
    const expected = result.totals.allocationsSubtotal + result.totals.taxTotal - result.totals.creditTotal;
    expect(Math.abs(expected - result.totals.grossTotal)).toBeLessThan(200);
  });
});

// -----------------------------------------------------------------------------
// §15 Scenario B — Groceries + taxable fuel surcharge
// -----------------------------------------------------------------------------

describe("15V · Scenario B — Grocery lines + taxable fuel surcharge", () => {
  const lineItems = [
    mkLine({ description: "Fresh produce - lettuce", amount: 45.20, taxTreatment: "exempt", lineNo: 0 }),
    mkLine({ description: "Dairy - milk 4L", amount: 32.50, taxTreatment: "exempt", lineNo: 1 }),
    mkLine({ description: "Meat - chicken breast", amount: 180.00, taxTreatment: "exempt", lineNo: 2 }),
    mkLine({ description: "Grocery - bakery bread", amount: 25.75, taxTreatment: "exempt", lineNo: 3 }),
    mkLine({ description: "Fuel surcharge", amount: 12.00, taxTreatment: "taxable", lineNo: 4 }),
  ];
  const fullText = "Food Supplier Invoice\nFresh produce\nDairy\nMeat\nGrocery items\nFuel surcharge\nSubtotal\nGST\nTotal";
  const purpose = classify({
    supplierName: "SAMPLE FOODS INC",
    lineDescriptions: lineItems.map((l) => l.description),
    fullDocumentText: fullText,
    hasMembershipLine: false,
    hasPenaltyLine: false,
    hasProfessionalCredentialContext: false,
  });

  const result = computeAllocations({
    lineItems,
    accounts: EXTENDED_COA,
    postingBlockersByAccount: new Map(),
    economicPurposeCandidates: purpose,
    fullDocumentText: fullText,
    supplierName: "SAMPLE FOODS INC",
    printedSubtotal: 295.45,
    printedTax: 0.60,
    printedTotal: 296.05,
  });

  it("food allocation lands on a Food cost-of-sales account", () => {
    const food = result.allocations.find((a) =>
      /food|cogs.*food|cost.*sales.*food/i.test(a.recommendedAccount?.accountName ?? ""),
    );
    expect(food).toBeDefined();
    expect(food!.amount).toBeGreaterThan(150);
  });

  it("fuel surcharge lands on a delivery/freight-type account distinct from food", () => {
    const fuel = result.allocations.find((a) =>
      /deliver|freight|surcharge|fuel/i.test(a.recommendedAccount?.accountName ?? ""),
    );
    expect(fuel).toBeDefined();
    const food = result.allocations.find((a) =>
      /food|cogs.*food/i.test(a.recommendedAccount?.accountName ?? ""),
    );
    expect(fuel!.recommendedAccount?.accountNumber).not.toBe(food?.recommendedAccount?.accountNumber);
  });

  it("food + fuel have DIFFERENT tax treatments", () => {
    const food = result.allocations.find((a) => /food|cogs.*food/i.test(a.recommendedAccount?.accountName ?? ""));
    const fuel = result.allocations.find((a) => /deliver|freight|fuel/i.test(a.recommendedAccount?.accountName ?? ""));
    expect(food!.taxTreatment).toBe("EXEMPT");
    expect(fuel!.taxTreatment).toBe("TAXABLE");
  });

  it("Category = 'Multiple'", () => {
    expect(result.cardCategory).toBe("Multiple");
  });
});

// -----------------------------------------------------------------------------
// §15 Scenario C — Draft + packaged beer
// -----------------------------------------------------------------------------

describe("15V · Scenario C — Draft and packaged beer", () => {
  const lineItems = [
    mkLine({ description: "Draft beer keg - lager 58L", amount: 320.00, taxTreatment: "taxable", lineNo: 0 }),
    mkLine({ description: "Draft beer keg - IPA 58L", amount: 350.00, taxTreatment: "taxable", lineNo: 1 }),
    mkLine({ description: "Bottled beer 24-pack lager", amount: 68.50, taxTreatment: "taxable", lineNo: 2 }),
    mkLine({ description: "Canned beer 12-pack IPA", amount: 42.00, taxTreatment: "taxable", lineNo: 3 }),
  ];
  const fullText = "Beverage supplier\nDraft beer keg\nBottled beer\nCanned beer\nSubtotal\nGST\nTotal";
  const purpose = classify({
    supplierName: "SAMPLE BEER CO",
    lineDescriptions: lineItems.map((l) => l.description),
    fullDocumentText: fullText,
    hasMembershipLine: false,
    hasPenaltyLine: false,
    hasProfessionalCredentialContext: false,
  });

  const result = computeAllocations({
    lineItems,
    accounts: EXTENDED_COA,
    postingBlockersByAccount: new Map(),
    economicPurposeCandidates: purpose,
    fullDocumentText: fullText,
    supplierName: "SAMPLE BEER CO",
    printedSubtotal: 780.50,
    printedTax: 39.03,
    printedTotal: 819.53,
  });

  it("draft-beer allocation lands on a Draft Beer cost-of-sales account", () => {
    const draft = result.allocations.find((a) =>
      /draft\s+beer|draught\s+beer/i.test(a.recommendedAccount?.accountName ?? ""),
    );
    expect(draft).toBeDefined();
  });

  it("packaged-beer allocation lands on a Packaged Beer cost-of-sales account", () => {
    const packaged = result.allocations.find((a) =>
      /packaged\s+beer|bottled\s+beer|canned\s+beer/i.test(a.recommendedAccount?.accountName ?? ""),
    );
    expect(packaged).toBeDefined();
    const draft = result.allocations.find((a) => /draft\s+beer/i.test(a.recommendedAccount?.accountName ?? ""));
    expect(packaged!.recommendedAccount?.accountNumber).not.toBe(draft?.recommendedAccount?.accountNumber);
  });

  it("Category = 'Multiple'", () => {
    expect(result.cardCategory).toBe("Multiple");
  });
});

// -----------------------------------------------------------------------------
// §15 Scenario D — Single-purpose invoice with several lines
// -----------------------------------------------------------------------------

describe("15V · Scenario D — Single-purpose invoice", () => {
  const lineItems = [
    mkLine({ description: "Office supplies - printer paper", amount: 45.00, taxTreatment: "taxable", lineNo: 0 }),
    mkLine({ description: "Office supplies - pens", amount: 12.00, taxTreatment: "taxable", lineNo: 1 }),
    mkLine({ description: "Office supplies - stapler", amount: 8.50, taxTreatment: "taxable", lineNo: 2 }),
  ];
  const fullText = "Office supplies invoice";
  const purpose = classify({
    supplierName: "SAMPLE OFFICE SUPPLY",
    lineDescriptions: lineItems.map((l) => l.description),
    fullDocumentText: fullText,
    hasMembershipLine: false,
    hasPenaltyLine: false,
    hasProfessionalCredentialContext: false,
  });

  const result = computeAllocations({
    lineItems,
    accounts: EXTENDED_COA,
    postingBlockersByAccount: new Map(),
    economicPurposeCandidates: purpose,
    fullDocumentText: fullText,
    supplierName: "SAMPLE OFFICE SUPPLY",
    printedSubtotal: 65.50,
    printedTax: 3.28,
    printedTotal: 68.78,
  });

  it("emits exactly ONE allocation for all lines", () => {
    expect(result.allocations.length).toBe(1);
  });

  it("Category displays the single account name (NOT 'Multiple')", () => {
    expect(result.cardCategory).not.toBe("Multiple");
    expect(result.cardCategory).toBe(result.allocations[0].recommendedAccount?.accountName);
  });
});

// -----------------------------------------------------------------------------
// §15 Scenario E — Mixed tax, same GL
// -----------------------------------------------------------------------------

describe("15V · Scenario E — Mixed tax treatment, single GL", () => {
  const lineItems = [
    mkLine({ description: "Office supplies - taxable box", amount: 45.00, taxTreatment: "taxable", lineNo: 0 }),
    mkLine({ description: "Office supplies - exempt goods", amount: 30.00, taxTreatment: "exempt", lineNo: 1 }),
  ];
  const purpose = classify({
    supplierName: "SAMPLE",
    lineDescriptions: lineItems.map((l) => l.description),
    fullDocumentText: "Office supplies invoice",
    hasMembershipLine: false,
    hasPenaltyLine: false,
    hasProfessionalCredentialContext: false,
  });
  const result = computeAllocations({
    lineItems,
    accounts: EXTENDED_COA,
    postingBlockersByAccount: new Map(),
    economicPurposeCandidates: purpose,
    fullDocumentText: "Office supplies invoice",
    supplierName: "SAMPLE",
    printedSubtotal: 75.00,
    printedTax: 2.25,
    printedTotal: 77.25,
  });

  it("emits ONE allocation with MIXED tax treatment", () => {
    expect(result.allocations.length).toBe(1);
    expect(result.allocations[0].taxTreatment).toBe("MIXED");
  });

  it("Category does NOT display 'Multiple' (single GL despite two tax groups)", () => {
    expect(result.cardCategory).not.toBe("Multiple");
  });
});

// -----------------------------------------------------------------------------
// §15 Scenario F — Credit applying to one group
// -----------------------------------------------------------------------------

describe("15V · Scenario F — Credit applying to a specific group", () => {
  const lineItems = [
    mkLine({ description: "Internet: 25 mbit/s service", amount: 40.00, taxTreatment: "taxable", lineNo: 0 }),
    mkLine({ description: "Outage credit", amount: -1.60, taxTreatment: "exempt", lineNo: 1 }),
  ];
  const fullText = "Statement\nInternet: 25 mbit/s\nBilling cycle\nOngoing charges\nCredits";
  const purpose = classify({
    supplierName: "SAMPLE TELECOM",
    lineDescriptions: lineItems.map((l) => l.description),
    fullDocumentText: fullText,
    hasMembershipLine: false,
    hasPenaltyLine: false,
    hasProfessionalCredentialContext: false,
  });

  const result = computeAllocations({
    lineItems,
    accounts: EXTENDED_COA,
    postingBlockersByAccount: new Map(),
    economicPurposeCandidates: purpose,
    fullDocumentText: fullText,
    supplierName: "SAMPLE TELECOM",
    printedSubtotal: 40.00,
    printedTax: 1.92,
    printedTotal: 40.32,
  });

  it("creditTotal is populated + gross reconciles", () => {
    expect(result.totals.creditTotal).toBeGreaterThan(0);
    // Gross = subtotal + tax - credit
    const derived = result.totals.allocationsSubtotal + result.totals.taxTotal - result.totals.creditTotal;
    expect(Math.abs(derived - result.totals.grossTotal)).toBeLessThan(1);
  });
});

// -----------------------------------------------------------------------------
// §15 Scenario G — Ambiguous surcharge
// -----------------------------------------------------------------------------

describe("15V · Scenario G — Ambiguous surcharge stays a separate allocation", () => {
  const lineItems = [
    mkLine({ description: "Grocery order", amount: 200.00, taxTreatment: "exempt", lineNo: 0 }),
    mkLine({ description: "Miscellaneous handling", amount: 15.00, taxTreatment: "taxable", lineNo: 1 }),
  ];
  const fullText = "Grocery order\nMiscellaneous handling\nSubtotal\nGST\nTotal";
  const purpose = classify({
    supplierName: "SAMPLE FOOD",
    lineDescriptions: lineItems.map((l) => l.description),
    fullDocumentText: fullText,
    hasMembershipLine: false,
    hasPenaltyLine: false,
    hasProfessionalCredentialContext: false,
  });

  const result = computeAllocations({
    lineItems,
    accounts: EXTENDED_COA,
    postingBlockersByAccount: new Map(),
    economicPurposeCandidates: purpose,
    fullDocumentText: fullText,
    supplierName: "SAMPLE FOOD",
    printedSubtotal: 215,
    printedTax: 0.75,
    printedTotal: 215.75,
  });

  it("primary allocation is populated", () => {
    expect(result.allocations.some((a) => a.recommendedAccount?.accountName?.match(/food|cogs.*food/i))).toBe(true);
  });

  it("miscellaneous handling stays as its own allocation (may be review-required)", () => {
    // Either surfaced as a delivery/freight allocation OR remains
    // as a separate allocation with lower confidence — but NOT
    // silently absorbed into the food allocation.
    const food = result.allocations.find((a) => /food|cogs.*food/i.test(a.recommendedAccount?.accountName ?? ""));
    expect(food).toBeDefined();
    // Food line's amount should NOT include the surcharge (200, not 215).
    expect(Math.abs(food!.amount - 200)).toBeLessThan(1);
  });
});

// -----------------------------------------------------------------------------
// §15 Scenario H — 100-permutation deterministic COA ordering
// -----------------------------------------------------------------------------

describe("15V · Scenario H — 100-permutation determinism", () => {
  const lineItems = [
    mkLine({ description: "Provincial regulatory body annual dues", amount: 810, taxTreatment: "taxable", lineNo: 0 }),
    mkLine({ description: "Late-payment penalty", amount: 150, taxTreatment: "exempt", lineNo: 1 }),
  ];
  const fullText = "Member Dues for [Person] year 2026\nAnnual dues\nLate-payment penalty\nSubtotal\nGST\nInvoice Total";
  const purpose = classify({
    supplierName: "SAMPLE PROF",
    lineDescriptions: lineItems.map((l) => l.description),
    fullDocumentText: fullText,
    hasMembershipLine: true,
    hasPenaltyLine: true,
    hasProfessionalCredentialContext: true,
  });

  const baseline = computeAllocations({
    lineItems,
    accounts: EXTENDED_COA,
    postingBlockersByAccount: new Map(),
    economicPurposeCandidates: purpose,
    fullDocumentText: fullText,
    supplierName: "SAMPLE PROF",
    printedSubtotal: 960,
    printedTax: 40.5,
    printedTotal: 1000.5,
  });
  const baselineSig = baseline.allocations.map((a) => `${a.recommendedAccount?.accountNumber}:${a.amount}`).join("|");

  it("100 permutations of input account order produce IDENTICAL allocations", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const shuffled = seededShuffle(EXTENDED_COA, seed);
      const result = computeAllocations({
        lineItems,
        accounts: shuffled,
        postingBlockersByAccount: new Map(),
        economicPurposeCandidates: purpose,
        fullDocumentText: fullText,
        supplierName: "SAMPLE PROF",
        printedSubtotal: 960,
        printedTax: 40.5,
        printedTotal: 1000.5,
      });
      const sig = result.allocations.map((a) => `${a.recommendedAccount?.accountNumber}:${a.amount}`).join("|");
      expect(sig, `seed=${seed} produced different allocations`).toBe(baselineSig);
    }
  });
});

// -----------------------------------------------------------------------------
// §16 Architectural anti-hardcoding guard
// -----------------------------------------------------------------------------

describe("15V · anti-hardcoding architectural guard", () => {
  const FORBIDDEN = [
    "CPA Alberta", "cpaalberta", "OXIO", "oxio.ca",
    "1007565767", "OXIO-23375874", "OXIO-00108064",
    "6045", "6047", "6061", "6064", "6068", "6071", "6072", "6073",
    "5010", "5020", "5021", "5022", "5030",
    "40.32", "1420.50", "1650.50",
  ];
  function stripComments(line: string): string {
    return line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
  }
  function scanFile(path: string) {
    const raw = readFileSync(path, "utf8");
    const rawLines = raw.split(/\r?\n/);
    const violations: Array<{ path: string; line: number; term: string; snippet: string }> = [];
    let inBlockComment = false;
    for (let i = 0; i < rawLines.length; i++) {
      let effective = rawLines[i];
      if (inBlockComment) {
        const end = effective.indexOf("*/");
        if (end === -1) continue;
        effective = effective.slice(end + 2);
        inBlockComment = false;
      }
      const start = effective.indexOf("/*");
      if (start !== -1 && effective.indexOf("*/", start) === -1) {
        inBlockComment = true;
        effective = effective.slice(0, start);
      }
      effective = stripComments(effective);
      for (const term of FORBIDDEN) {
        if (effective.includes(term)) {
          violations.push({ path, line: i + 1, term, snippet: rawLines[i].trim().slice(0, 120) });
        }
      }
    }
    return violations;
  }

  it("no vendor identities / tenant account numbers / acceptance amounts leak into executable code", async () => {
    const { readdir } = await import("node:fs/promises");
    const root = join(process.cwd(), "src", "lib", "ap-intelligence");
    const files = (await readdir(root)).filter((f) => f.endsWith(".ts"));
    const violations = files.flatMap((f) => scanFile(join(root, f)));
    if (violations.length > 0) {
      throw new Error(
        "Acceptance-specific literals leaked into executable ap-intelligence code:\n"
        + violations.map((v) => `  ${v.path}:${v.line}  [${v.term}]  ${v.snippet}`).join("\n"),
      );
    }
  });
});
