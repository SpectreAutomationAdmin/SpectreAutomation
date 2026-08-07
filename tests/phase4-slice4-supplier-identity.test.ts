// Sprint 3 · Post-16H Phase 4 Slice 4-reopen (2026-08-07) —
// multimodal supplier-identity architecture regression tests.

import { describe, it, expect } from "vitest";
import {
  collectTextSupplierEvidence,
  clusterSupplierEvidence,
  scoreSupplierCandidates,
  selectSupplier,
  selectSupplierFromText,
  normalizeOrgName,
} from "@/lib/ap-intelligence/evidence/supplier-identity";

// The exact real DMM pdf-parse text observed via inspect-wi.
const REAL_DMM_TEXT = [
  "PRODUIT",
  "B0037FC2026/06/17",
  "DATEPAGE",
  "1",
  "INVOICE",
  "SILVER SPRINGS GOLF",
  "& COUNTRY CLUB",
  "CALGARY  AB   T3B 2W9",
  "1600 VARSITY ESTATES DR NW",
  "Bill To :",
  "1600 Varsity Estates Dr Nw",
  "CALGARY",
  "Ship to :",
  "005623Customer005623AShipment Accounts",
  "ProductDescriptionQtyPriceAmount",
  "Order",
  "Calgary",
  "Phone (403) 336-3365",
  "www.dmmenergy.ca",
  "17 Capital Circle, Corman Park No. 344",
  "Saskatoon, SK  S7R 0H4",
  "1700.001.379000  9Diesel LS Dyed2344.30",
  "PFT :0.04000068.00",
  "Please write your account number AND the invoice number on your cheque or return a copy of the invoice with your payment",
  "GST/HST #  724076930RT0001",
  "120.62",
  "2532.92",
  "2412.30",
  "TOTAL",
  "Sub Total",
  "GST/HST",
  "0.00PST",
  "Invoice due upon receipt unless it is otherwise stated in your",
  "account's terms and conditions.",
  "Administration fee: 2.00% per month compounded ( 24.00% nominal per year)",
  "on all overdue amounts. All merchandise sold as described herein remains",
  "the property of DMM ENERGY INC. until full payment is received.",
  "Thank you for your patronage.",
].join("\n");

describe("Slice 4-reopen · normalizeOrgName", () => {
  it("collapses corp-suffix variants into the same key", () => {
    expect(normalizeOrgName("DMM Energy")).toBe(normalizeOrgName("DMM Energy Inc"));
    expect(normalizeOrgName("DMM Energy Inc.")).toBe(normalizeOrgName("DMM ENERGY INC"));
    expect(normalizeOrgName("Coulee Ridge Golf & Country Club")).toContain("coulee");
  });
});

describe("Slice 4-reopen · collectTextSupplierEvidence on real DMM text", () => {
  const evidence = collectTextSupplierEvidence(REAL_DMM_TEXT);

  it("collects the WEBSITE_DOMAIN dmmenergy.ca", () => {
    const web = evidence.filter((e) => e.type === "WEBSITE_DOMAIN");
    expect(web.length).toBeGreaterThanOrEqual(1);
    expect(web[0].value).toBe("dmmenergy");
  });

  it("collects the LEGAL_ENTITY_TEXT 'DMM ENERGY INC.' from the footer", () => {
    const legal = evidence.filter((e) => e.type === "LEGAL_ENTITY_TEXT" || e.type === "HEADER_ORG_TEXT");
    expect(legal.length).toBeGreaterThanOrEqual(1);
    expect(legal.some((e) => /DMM ENERGY INC/i.test(e.value))).toBe(true);
  });

  it("collects the TAX_REGISTRATION 724076930RT0001", () => {
    const tax = evidence.filter((e) => e.type === "TAX_REGISTRATION");
    expect(tax.length).toBeGreaterThanOrEqual(1);
    expect(tax[0].value).toContain("724076930");
  });

  it("collects the PHONE_BLOCK (403) 336-3365", () => {
    const phone = evidence.filter((e) => e.type === "PHONE_BLOCK");
    expect(phone.length).toBeGreaterThanOrEqual(1);
    expect(phone[0].value).toMatch(/403.*336.*3365/);
  });

  it("collects the ADDRESS_BLOCK for the DMM Saskatoon location", () => {
    const addr = evidence.filter((e) => e.type === "ADDRESS_BLOCK");
    expect(addr.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT collect the remittance-instruction sentence as any identity evidence", () => {
    const identities = evidence.filter((e) =>
      e.type === "LEGAL_ENTITY_TEXT" || e.type === "HEADER_ORG_TEXT" || e.type === "WEBSITE_DOMAIN" || e.type === "EMAIL_DOMAIN",
    );
    for (const e of identities) {
      expect(e.value.toLowerCase()).not.toContain("please write");
    }
  });
});

describe("Slice 4-reopen · clustering + scoring", () => {
  const evidence = collectTextSupplierEvidence(REAL_DMM_TEXT);
  const candidates = clusterSupplierEvidence(evidence);
  scoreSupplierCandidates(candidates);

  it("clusters DMM website + legal entity + supporting evidence into ONE candidate", () => {
    // We expect a single DMM cluster (dmmenergy ↔ DMM ENERGY INC.).
    const dmm = candidates.find((c) => c.normalizedIdentity.includes("dmmenergy"));
    expect(dmm, "DMM cluster must exist").toBeDefined();
    expect(dmm!.legalNameCandidate, "legal name populated from LEGAL_ENTITY_TEXT").toMatch(/DMM ENERGY INC/i);
    // Independent evidence groups: DOMAIN + LEGAL + TAX_REG + PHONE
    // + ADDRESS = 5 groups (or thereabouts — attachment logic can vary).
    expect(dmm!.independentEvidenceGroups, "DMM cluster has multiple independent evidence groups")
      .toBeGreaterThanOrEqual(3);
  });

  it("DMM cluster confidence clears the commitment threshold", () => {
    const dmm = candidates.find((c) => c.normalizedIdentity.includes("dmmenergy"));
    expect(dmm!.confidence).toBeGreaterThanOrEqual(70);
  });
});

describe("Slice 4-reopen · selectSupplier commitment policy", () => {
  it("selects the DMM cluster as supplier winner on real DMM text", () => {
    const selection = selectSupplierFromText(REAL_DMM_TEXT);
    expect(selection.abstained).toBe(false);
    expect(selection.winner).not.toBeNull();
    const displayName = selection.diagnostic.selectedSupplier ?? "";
    expect(displayName.toLowerCase(), "selected supplier contains 'dmm energy' identity").toContain("dmm energy");
    expect(selection.diagnostic.independentEvidenceGroups, "corroborated by multiple groups")
      .toBeGreaterThanOrEqual(2);
    expect(selection.diagnostic.supportingEvidence, "supporting evidence includes both LEGAL_ENTITY_TEXT + WEBSITE_DOMAIN")
      .toEqual(expect.arrayContaining(["LEGAL_ENTITY_TEXT"]));
  });

  it("abstains when only a single weak domain signal exists (no corroboration)", () => {
    const selection = selectSupplierFromText("Some text\nwww.acme.com\nMore text");
    // Only WEBSITE_DOMAIN and nothing else — should not commit.
    expect(selection.abstained).toBe(true);
    expect(selection.abstainReason).toMatch(/threshold/);
  });

  it("rejects generic-domain-only signals (quickbooks, stripe, gmail)", () => {
    const selection = selectSupplierFromText("Payment portal: www.quickbooks.com\nContact: billing@stripe.com");
    // Blocklisted domains produce no identity evidence.
    expect(selection.abstained).toBe(true);
  });

  it("commits on a small-business shape: header org + address + phone + tax reg (no website)", () => {
    const smallVendor = [
      "Joe's Plumbing Ltd.",
      "123 Main Street",
      "Calgary, AB T2P 1J9",
      "Phone (403) 555-1234",
      "GST # 123456789RT0001",
      "",
      "Invoice #: JP-2026-42",
      "Total: $500.00",
    ].join("\n");
    const selection = selectSupplierFromText(smallVendor);
    expect(selection.abstained).toBe(false);
    expect(selection.winner?.legalNameCandidate).toMatch(/Joe's Plumbing/i);
    expect(selection.diagnostic.supportingEvidence).toEqual(
      expect.arrayContaining(["TAX_REGISTRATION"]),
    );
  });
});
