// Sprint 3 · Checkpoint 15P-1 (2026-07-27) — REAL Microsoft invoice
// fixture. The pre-15P-1 extractor produced null address / null
// phone / null payment terms on this text. These tests lock the
// fixed candidate-scoring extractor against the actual staging
// text (captured from Coulee Ridge / Microsoft O365 invoice
// E0701097E3 / doc 93458725404.pdf).
//
// NO PDF is stored in this file. NO customer-account-specific
// values are included. The text below is the pdf-parse output
// verbatim with the Coulee Ridge dev-tenant address preserved AS
// the customer-block bait (to lock the vendor-vs-customer scoring).

import { describe, expect, it } from "vitest";
import { extractVendorProfile, EXTRACTOR_VERSION } from "@/lib/ap-intelligence/vendor-profile-extract";

const REAL_MICROSOFT_TEXT = [
  "",
  "",
  "Invoice",
  "July 2026",
  "Invoice Date: 2026-07-22",
  "Invoice Number: E0701097E3",
  "Due Date: 2026-07-22",
  "31.29 CAD",
  "Sold-ToBill-ToService Usage Address",   // concatenated headers
  "Spectre Automation ",
  "1515 25th Ave SW ",
  "Calgary ab T2T 0Z7 ",                    // lowercase province — no comma
  "Canada",
  "Spectre Automation ",
  "1515 25th Ave SW ",
  "Calgary ab T2T 0Z7 ",
  "Canada",
  "Spectre Automation ",
  "1515 25th Ave SW ",
  "Calgary ab T2T 0Z7 ",
  "Canada",
  "Order Details",
  "Product:Online Services",
  "Customer PO Number:",
  "Order Number:103851cc-2dea-42be-b32b-64fceed2e42f",
  "Billing Period:2026-07-21 - 2026-07-21",
  "Due Date:2026-07-22",
  "Billing Summary",
  "Charges:29.80",
  "Discounts:0.00",
  "Credits:0.00",
  "GST/HST:1.49",
  "QST/PST:0.00",
  "Total:31.29",
  "Payment Instructions:Please DO NOT PAY. You will be charged the amount due through your selected method of payment.",
  "21/",
  "Billing or service question? Call 1-800-865-9408 or visit https://aka.ms/Office365Billing",
  "Microsoft Corporation, One Microsoft Way, Redmond, WA 98052, United States ",  // ← the REAL vendor address
  "GST/HST 135625069RT0001 QST 1015764658TQ0002",
  "",
  "Invoice",
  "July 2026",
].join("\n");

describe("15P-1 — REAL Microsoft invoice populates every field the founder listed", () => {
  const p = extractVendorProfile(REAL_MICROSOFT_TEXT, { vendorLegalName: "Microsoft Corporation" });

  it("address line 1 = 'One Microsoft Way' (vendor footer wins over 3× customer blocks)", () => {
    expect(p.address.line1.value).toBe("One Microsoft Way");
    expect(p.address.line1.source).toBe("invoice-pdf");
  });
  it("city = 'Redmond'", () => {
    expect(p.address.city.value).toBe("Redmond");
  });
  it("province/state = 'WA'", () => {
    expect(p.address.provinceState.value).toBe("WA");
  });
  it("postal code = '98052'", () => {
    expect(p.address.postalCode.value).toBe("98052");
  });
  it("country = 'United States'", () => {
    expect(p.address.country.value).toBe("United States");
  });
  it("address block confidence is above the extraction threshold", () => {
    expect(p.address.blockConfidence).toBeGreaterThanOrEqual(60);
  });

  it("phone = '(800) 865-9408' (parsed from the '1-800-865-9408' line)", () => {
    expect(p.phone.value).toBeTruthy();
    // Accept either canonical NA form OR "+1 (800) 865-9408" —
    // both are correct; the deployed normaliser picks one.
    expect(p.phone.value).toMatch(/(?:\(800\)\s*865-?9408|\+1\s*\(800\)\s*865-?9408)/);
  });

  it("website = 'https://aka.ms/Office365Billing'", () => {
    expect(p.website.value).toBe("https://aka.ms/Office365Billing");
  });

  it("GST registration = '135625069RT0001'", () => {
    expect(p.taxRegistrationNumber.value).toContain("135625069");
  });

  it("payment terms = auto-pay (recognizes 'You will be charged')", () => {
    expect(p.paymentTerms.value).toBeTruthy();
    expect(p.paymentTerms.value?.toLowerCase()).toContain("auto");
  });

  it("VENDOR address WINS over the 3× customer 'Spectre Automation / 1515 25th Ave SW / Calgary' blocks", () => {
    // The customer blocks share the tenant address; the extractor
    // must not emit it as the vendor address.
    expect(p.address.line1.value).not.toContain("1515 25th");
    expect(p.address.city.value).not.toBe("Calgary");
    expect(p.address.provinceState.value).not.toBe("AB");
  });
});

describe("15P-1 — EXTRACTOR_VERSION is a named export (cache-key input)", () => {
  it("exports a numeric version constant", () => {
    expect(typeof EXTRACTOR_VERSION).toBe("number");
    expect(EXTRACTOR_VERSION).toBeGreaterThanOrEqual(2);
  });
});

describe("15P-1 — synthetic sanity: multi-line block still wins on invoices that use that layout", () => {
  const text = [
    "Toro Company",
    "8111 Lyndale Avenue South",
    "Suite 200",
    "Bloomington, MN 55420",
    "United States",
    "",
    "Bill To:",
    "Coulee Ridge Golf & Country Club",
    "5150 Rec Road",
    "Sunset, AB T0K 2X0",
    "Canada",
  ].join("\n");
  const p = extractVendorProfile(text, { vendorLegalName: "Toro Company" });
  it("line1 is the vendor's street (not the club's)", () => {
    expect(p.address.line1.value).toBe("8111 Lyndale Avenue South");
  });
  it("line2 captures the suite", () => {
    expect(p.address.line2.value).toBe("Suite 200");
  });
  it("city, state, postal, country are the vendor's", () => {
    expect(p.address.city.value).toBe("Bloomington");
    expect(p.address.provinceState.value).toBe("MN");
    expect(p.address.postalCode.value).toBe("55420");
    expect(p.address.country.value).toBe("United States");
  });
});

describe("15P-1 — no vendor-specific parsing", () => {
  it("the same single-line comma-separated address pattern works for a non-Microsoft footer", () => {
    const text = [
      "Invoice #42",
      "Total: $500.00",
      "",
      "Billing or service question? Call 1-888-123-4567",
      "Cisco Systems Inc., 170 West Tasman Drive, San Jose, CA 95134, United States",
    ].join("\n");
    const p = extractVendorProfile(text, { vendorLegalName: "Cisco Systems Inc." });
    expect(p.address.line1.value).toBe("170 West Tasman Drive");
    expect(p.address.city.value).toBe("San Jose");
    expect(p.address.provinceState.value).toBe("CA");
    expect(p.address.postalCode.value).toBe("95134");
    expect(p.address.country.value).toBe("United States");
  });
});
