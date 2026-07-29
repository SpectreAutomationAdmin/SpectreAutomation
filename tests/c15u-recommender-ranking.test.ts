// Sprint 3 · Checkpoint 15U (2026-07-28) — real-tenant GL recommender
// regression suite.
//
// Every scenario runs the ranker against the sanitized Coulee Ridge
// COA SHAPE (real account names + real FS groups + real categories)
// so the tests reproduce the competition the ranker faces in
// production. NO tenant identifiers, no vendor names, no invoice
// numbers, no amounts in the assertions.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rankAccountsPure, type PostingBlocker } from "@/lib/ap-intelligence/gl-recommend";
import { extractQueryConcepts } from "@/lib/ap-intelligence/gl-query-concepts";
import { classifyEconomicPurpose, type PurposeCandidate } from "@/lib/ap-intelligence/economic-purpose";
import type { LineItem } from "@/lib/ap-intelligence/line-items-extract";
import { COULEE_RIDGE_ACCOUNTS_SHAPE } from "./fixtures/c15u-coulee-ridge-coa-shape";

// -----------------------------------------------------------------------------
// Deterministic seeded shuffle — used for the "same result across 100
// permutations" property test. No Math.random() so failures reproduce.
// -----------------------------------------------------------------------------
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

function mkLine(description: string, amount = 100, treatment: LineItem["taxTreatment"] = "unknown"): LineItem {
  return {
    description, quantity: null, unitPrice: null, amount,
    taxRate: null, taxAmount: null, taxTreatment: treatment,
    evidence: ["amount_only"], confidence: 60, lineNo: 0,
  };
}

function buildQuery(args: {
  lineItems: LineItem[];
  fullDocumentText: string;
  supplierName?: string | null;
  purpose?: PurposeCandidate[];
}) {
  return extractQueryConcepts({
    lineItems: args.lineItems,
    economicPurposeCandidates: args.purpose ?? null,
    fullDocumentText: args.fullDocumentText,
    supplierName: args.supplierName ?? null,
  });
}

// -----------------------------------------------------------------------------
// §15 Scenario 1 — Professional membership dues
// -----------------------------------------------------------------------------

describe("15U · GL ranker — professional membership dues", () => {
  const lineItems = [
    mkLine("Provincial regulatory body annual dues"),
    mkLine("National affiliate fee"),
    mkLine("Regional levy"),
  ];
  const fullText = "Member Dues for [PersonName] year 2026\nProvincial regulatory body annual dues\nSUBTOTAL\nGST/HST\nINVOICE TOTAL";
  const purpose = classifyEconomicPurpose({
    supplierName: "PROF ALBERTA",
    lineDescriptions: lineItems.map((l) => l.description),
    fullDocumentText: fullText,
    paymentDirection: "club_pays_vendor",
    hasPenaltyLine: false,
    hasMembershipLine: true,
    hasProfessionalCredentialContext: true,
  });
  const queryConcepts = buildQuery({ lineItems, fullDocumentText: fullText, supplierName: "PROF ALBERTA", purpose });

  it("ranks Membership & Dues FIRST", () => {
    const ranked = rankAccountsPure({ accounts: COULEE_RIDGE_ACCOUNTS_SHAPE, queryConcepts });
    expect(ranked[0].accountName).toBe("Membership & Dues");
  });

  it("ranks Subscriptions BELOW Membership & Dues", () => {
    const ranked = rankAccountsPure({ accounts: COULEE_RIDGE_ACCOUNTS_SHAPE, queryConcepts });
    const dues = ranked.findIndex((r) => r.accountName === "Membership & Dues");
    const subs = ranked.findIndex((r) => r.accountName === "Subscriptions");
    expect(subs).toBeGreaterThan(dues);
    expect(ranked[dues].semanticScore).toBeGreaterThan(ranked[subs].semanticScore);
  });

  it("ranks Accounting fees BELOW both Membership & Dues and Subscriptions", () => {
    const ranked = rankAccountsPure({ accounts: COULEE_RIDGE_ACCOUNTS_SHAPE, queryConcepts });
    const dues = ranked.findIndex((r) => r.accountName === "Membership & Dues");
    const subs = ranked.findIndex((r) => r.accountName === "Subscriptions");
    const acct = ranked.findIndex((r) => r.accountName === "Accounting fees");
    expect(acct).toBeGreaterThan(dues);
    expect(acct).toBeGreaterThan(subs);
  });

  it("Score Cards & Printing is not in top 3", () => {
    const ranked = rankAccountsPure({ accounts: COULEE_RIDGE_ACCOUNTS_SHAPE, queryConcepts });
    const top3 = ranked.slice(0, 3).map((r) => r.accountName);
    expect(top3).not.toContain("Score Cards & Printing");
  });
});

// -----------------------------------------------------------------------------
// §15 Scenario 2 — General software subscription
// -----------------------------------------------------------------------------

describe("15U · GL ranker — general software subscription", () => {
  const lineItems = [mkLine("Monthly software subscription — cloud SaaS"), mkLine("Additional user licence")];
  const fullText = "Monthly software subscription — cloud SaaS\nAdditional user licence\nInvoice Total";
  const queryConcepts = buildQuery({ lineItems, fullDocumentText: fullText });

  it("ranks a subscription/software account first, not Membership & Dues", () => {
    const ranked = rankAccountsPure({ accounts: COULEE_RIDGE_ACCOUNTS_SHAPE, queryConcepts });
    const winnerName = ranked[0].accountName;
    // Coulee Ridge shape: either Subscriptions (Memberships & Subscriptions FS)
    // OR Computer & IT Services (IT & Software FS) — both are valid.
    expect(["Subscriptions", "Computer & IT Services"]).toContain(winnerName);
    const duesRank = ranked.findIndex((r) => r.accountName === "Membership & Dues");
    expect(duesRank).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------------
// §15 Scenario 3 — External accounting services
// -----------------------------------------------------------------------------

describe("15U · GL ranker — external accounting services", () => {
  const lineItems = [mkLine("Tax return preparation services"), mkLine("Audit engagement fee")];
  const fullText = "Tax return preparation services\nAudit engagement fee\nInvoice Total";
  const purpose = classifyEconomicPurpose({
    supplierName: "Sample LLP",
    lineDescriptions: lineItems.map((l) => l.description),
    fullDocumentText: fullText,
    paymentDirection: "club_pays_vendor",
    hasPenaltyLine: false,
    hasMembershipLine: false,
    hasProfessionalCredentialContext: false,
  });
  const queryConcepts = buildQuery({ lineItems, fullDocumentText: fullText, supplierName: "Sample LLP", purpose });

  it("ranks Accounting fees FIRST", () => {
    const ranked = rankAccountsPure({ accounts: COULEE_RIDGE_ACCOUNTS_SHAPE, queryConcepts });
    expect(ranked[0].accountName).toBe("Accounting fees");
  });

  it("does NOT rank Membership & Dues in the top 3", () => {
    const ranked = rankAccountsPure({ accounts: COULEE_RIDGE_ACCOUNTS_SHAPE, queryConcepts });
    const top3 = ranked.slice(0, 3).map((r) => r.accountName);
    expect(top3).not.toContain("Membership & Dues");
  });
});

// -----------------------------------------------------------------------------
// §15 Scenario 4 — Recurring connectivity service
// -----------------------------------------------------------------------------

describe("15U · GL ranker — recurring connectivity service", () => {
  const lineItems = [mkLine("Internet: 25 mbit/s, 2.5 mbit/s", 40)];
  const fullText = `Billing cycle 07/28/2026 - 08/27/2026\nStatement number\nTotal amount due\nOngoing charges\nTaxes/Fees\nCredits\nInternet: 25 mbit/s, 2.5 mbit/s`;
  const purpose = classifyEconomicPurpose({
    supplierName: "GENERIC TELECOM CO",
    lineDescriptions: lineItems.map((l) => l.description),
    fullDocumentText: fullText,
    paymentDirection: "club_pays_vendor",
    hasPenaltyLine: false,
    hasMembershipLine: false,
    hasProfessionalCredentialContext: false,
  });
  const queryConcepts = buildQuery({ lineItems, fullDocumentText: fullText, supplierName: "GENERIC TELECOM CO", purpose });

  it("ranks Telephone & Internet FIRST (leaf communications concept beats generic Utilities)", () => {
    const ranked = rankAccountsPure({ accounts: COULEE_RIDGE_ACCOUNTS_SHAPE, queryConcepts });
    expect(ranked[0].accountName).toBe("Telephone & Internet");
  });

  it("Score Cards & Printing ranks BELOW the minimum-relevance threshold", () => {
    const ranked = rankAccountsPure({ accounts: COULEE_RIDGE_ACCOUNTS_SHAPE, queryConcepts });
    const printing = ranked.find((r) => r.accountName === "Score Cards & Printing");
    expect(printing).toBeDefined();
    // Threshold is 40; Printing must not exceed it here.
    expect(printing!.semanticScore).toBeLessThan(40);
  });

  it("winner is independent of supplier name", () => {
    // Same document, different supplier — winner should be the same.
    const qOther = buildQuery({ lineItems, fullDocumentText: fullText, supplierName: "ANOTHER SUPPLIER INC", purpose });
    const rankedOther = rankAccountsPure({ accounts: COULEE_RIDGE_ACCOUNTS_SHAPE, queryConcepts: qOther });
    expect(rankedOther[0].accountName).toBe("Telephone & Internet");
  });
});

// -----------------------------------------------------------------------------
// §15 Scenario 5 — General utility bill (electricity)
// -----------------------------------------------------------------------------

describe("15U · GL ranker — general utility bill", () => {
  const lineItems = [mkLine("Electricity consumption 500 kWh"), mkLine("Distribution charge")];
  const fullText = "Electricity 500 kWh\nDistribution charge\nMeter reading\nService address";
  const purpose = classifyEconomicPurpose({
    supplierName: "GENERIC POWER CO",
    lineDescriptions: lineItems.map((l) => l.description),
    fullDocumentText: fullText,
    paymentDirection: "club_pays_vendor",
    hasPenaltyLine: false,
    hasMembershipLine: false,
    hasProfessionalCredentialContext: false,
  });
  const queryConcepts = buildQuery({ lineItems, fullDocumentText: fullText, supplierName: "GENERIC POWER CO", purpose });

  it("ranks a Utilities account first, not Telephone & Internet", () => {
    const ranked = rankAccountsPure({ accounts: COULEE_RIDGE_ACCOUNTS_SHAPE, queryConcepts });
    expect(["Utilities", "Utilities - Backshop"]).toContain(ranked[0].accountName);
    const telRank = ranked.findIndex((r) => r.accountName === "Telephone & Internet");
    const utilRank = ranked.findIndex((r) => r.accountName === "Utilities");
    if (telRank >= 0 && utilRank >= 0) {
      expect(telRank).toBeGreaterThan(utilRank);
    }
  });
});

// -----------------------------------------------------------------------------
// §15 Scenario 6 — Genuine printing invoice
// -----------------------------------------------------------------------------

describe("15U · GL ranker — genuine printing invoice", () => {
  const lineItems = [mkLine("Score card printing (500 copies)"), mkLine("Yardage book brochures")];
  const fullText = "Printing services quote\nScore card printing 500 copies\nYardage book brochures";
  const queryConcepts = buildQuery({ lineItems, fullDocumentText: fullText });

  it("ranks Score Cards & Printing FIRST", () => {
    const ranked = rankAccountsPure({ accounts: COULEE_RIDGE_ACCOUNTS_SHAPE, queryConcepts });
    expect(ranked[0].accountName).toBe("Score Cards & Printing");
    // Score must clear the min-relevance threshold.
    expect(ranked[0].semanticScore).toBeGreaterThanOrEqual(40);
  });
});

// -----------------------------------------------------------------------------
// §15 Scenario 7 — No suitable account: abstain / review
// -----------------------------------------------------------------------------

describe("15U · GL ranker — no suitable account", () => {
  const lineItems = [mkLine("Miscellaneous professional widget alignment")];
  const fullText = "Miscellaneous professional widget alignment";
  const queryConcepts = buildQuery({ lineItems, fullDocumentText: fullText });

  it("top score falls below the min-relevance threshold (requires review)", () => {
    const ranked = rankAccountsPure({ accounts: COULEE_RIDGE_ACCOUNTS_SHAPE, queryConcepts });
    expect(ranked[0].semanticScore).toBeLessThan(40);
  });
});

// -----------------------------------------------------------------------------
// §15 Scenario 8 — Mixed-purpose invoice: split-account readiness
// -----------------------------------------------------------------------------

describe("15U · GL ranker — mixed-purpose invoice signals split recommendations", () => {
  const lineItems = [
    mkLine("Monthly software subscription", 200),
    mkLine("Annual membership dues", 500),
  ];
  const fullText = "Monthly software subscription\nAnnual membership dues";
  const queryConcepts = buildQuery({ lineItems, fullDocumentText: fullText });

  it("distinct query concepts fire for distinct line items", () => {
    const conceptIds = new Set(queryConcepts.map((q) => q.conceptId));
    expect(conceptIds.size).toBeGreaterThanOrEqual(2);
  });
});

// -----------------------------------------------------------------------------
// §15 Scenario 9 — 100-permutation determinism
// -----------------------------------------------------------------------------

describe("15U · GL ranker — deterministic across randomized account order", () => {
  const lineItems = [mkLine("Provincial regulatory body annual dues")];
  const fullText = "Member Dues for [Name] year 2026\nProvincial regulatory body annual dues";
  const purpose = classifyEconomicPurpose({
    supplierName: "PROF ONTARIO",
    lineDescriptions: lineItems.map((l) => l.description),
    fullDocumentText: fullText,
    paymentDirection: "club_pays_vendor",
    hasPenaltyLine: false,
    hasMembershipLine: true,
    hasProfessionalCredentialContext: true,
  });
  const queryConcepts = buildQuery({ lineItems, fullDocumentText: fullText, supplierName: "PROF ONTARIO", purpose });
  const baseline = rankAccountsPure({ accounts: COULEE_RIDGE_ACCOUNTS_SHAPE, queryConcepts });
  const baselineOrder = baseline.map((r) => r.accountNumber);

  it("100 permutations of input order all produce the same ranking", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const shuffled = seededShuffle(COULEE_RIDGE_ACCOUNTS_SHAPE, seed);
      const ranked = rankAccountsPure({ accounts: shuffled, queryConcepts });
      const order = ranked.map((r) => r.accountNumber);
      expect(order, `permutation seed=${seed} produced a different ranking`).toEqual(baselineOrder);
    }
  });
});

// -----------------------------------------------------------------------------
// §14 architectural anti-hardcoding — production code must not
// branch on vendor names, invoice numbers, filenames, account
// numbers, or acceptance-document phrase combinations.
// -----------------------------------------------------------------------------

describe("15U · architectural anti-hardcoding guard", () => {
  const FORBIDDEN = [
    // Vendor identities
    "CPA Alberta", "cpaalberta", "OXIO", "oxio.ca",
    // Acceptance-specific identifiers
    "1007565767", "OXIO-23375874", "OXIO-00108064",
    // Coulee Ridge account numbers must not appear as literals in
    // recommendation logic
    "6045", "6047", "6061", "6064", "6068", "6071", "6072", "6073",
    // Acceptance-specific amounts
    "40.32", "1420.50", "1650.50",
  ];

  function stripComments(line: string): string {
    return line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
  }
  function scanFile(path: string): Array<{ path: string; line: number; term: string; snippet: string }> {
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

  it("no acceptance-specific literals appear in recommender executable code", async () => {
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
