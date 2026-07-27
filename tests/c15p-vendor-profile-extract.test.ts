// Sprint 3 · Checkpoint 15P (2026-07-27) — vendor-profile extraction
// intelligence tests.
//
// Founder rule: the operator should almost never have to type when
// they click "Create vendor". The extractor MUST populate address,
// phone, website, GST, currency, and terms from the invoice PDF text
// whenever those signals are present, and MUST leave a field null
// when the confidence is below the threshold (never guess).
//
// General-purpose: no Microsoft-specific parsing anywhere. The
// realistic-sample tests below use invoice text patterns that also
// occur on Cisco, Dell, Sysco, Toro, John Deere, and Club-Support
// bills.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractVendorProfile } from "@/lib/ap-intelligence/vendor-profile-extract";

const EXTRACT_MODULE = readFileSync(
  join(process.cwd(), "src/lib/ap-intelligence/vendor-profile-extract.ts"),
  "utf8",
);
const MODAL = readFileSync(
  join(process.cwd(), "src/components/mission-control/CreateVendorAndPostModal.tsx"),
  "utf8",
);
const IRI = readFileSync(
  join(process.cwd(), "src/lib/mission-control/intelligence-review-intakes.ts"),
  "utf8",
);
const ANALYSE = readFileSync(
  join(process.cwd(), "src/lib/ap-intelligence/analyse.ts"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Address extraction
// ---------------------------------------------------------------------------

describe("15P — address extraction", () => {
  it("extracts a Canadian address block (city, province, postal + walk-back for line 1)", () => {
    const text = [
      "Microsoft Corporation",
      "1950 Meadowvale Blvd",
      "Mississauga, ON L5N 8L9",
      "Canada",
      "",
      "Invoice #E0701097E3",
      "Total: $31.29",
    ].join("\n");
    const p = extractVendorProfile(text);
    expect(p.address.line1.value).toBe("1950 Meadowvale Blvd");
    expect(p.address.city.value).toBe("Mississauga");
    expect(p.address.provinceState.value).toBe("ON");
    expect(p.address.postalCode.value).toBe("L5N 8L9");
    expect(p.address.country.value).toBe("Canada");
    expect(p.address.blockConfidence).toBeGreaterThanOrEqual(80);
    // Provenance
    for (const f of [p.address.line1, p.address.city, p.address.provinceState, p.address.postalCode, p.address.country]) {
      expect(f.source).toBe("invoice-pdf");
      expect(f.confidence).toBeGreaterThanOrEqual(80);
    }
  });

  it("extracts a US address block (city, state, ZIP+4)", () => {
    const text = [
      "Cisco Systems Inc.",
      "170 West Tasman Drive",
      "San Jose, CA 95134-1706",
      "United States",
    ].join("\n");
    const p = extractVendorProfile(text);
    expect(p.address.line1.value).toBe("170 West Tasman Drive");
    expect(p.address.city.value).toBe("San Jose");
    expect(p.address.provinceState.value).toBe("CA");
    expect(p.address.postalCode.value).toBe("95134-1706");
    expect(p.address.country.value).toBe("United States");
  });

  it("captures an optional suite/unit line as address line 2", () => {
    const text = [
      "Toro Company",
      "8111 Lyndale Avenue South",
      "Suite 200",
      "Bloomington, MN 55420",
    ].join("\n");
    const p = extractVendorProfile(text);
    expect(p.address.line1.value).toBe("8111 Lyndale Avenue South");
    expect(p.address.line2.value).toBe("Suite 200");
    expect(p.address.city.value).toBe("Bloomington");
    expect(p.address.provinceState.value).toBe("MN");
    expect(p.address.postalCode.value).toBe("55420");
  });

  it("does NOT extract the customer's Bill To / Ship To address as the vendor's", () => {
    // The vendor address is followed by a Bill-To block with the
    // Coulee Ridge address. The extractor must skip the Bill-To
    // range and return the vendor's address, not the club's.
    const text = [
      "John Deere Financial",
      "6400 NW 86th Street",
      "Johnston, IA 50131",
      "",
      "Bill To:",
      "Coulee Ridge Golf & Country Club",
      "5150 Rec Road",
      "Sunset, AB T0K 2X0",
      "",
      "Invoice #123",
    ].join("\n");
    const p = extractVendorProfile(text);
    expect(p.address.line1.value).toBe("6400 NW 86th Street");
    expect(p.address.city.value).toBe("Johnston");
    expect(p.address.provinceState.value).toBe("IA");
  });

  it("returns null-block when no city/state/postal anchor is found (never guesses)", () => {
    const text = "Widgets Ltd\nGlobal HQ\nSomewhere nice\nInvoice #1";
    const p = extractVendorProfile(text);
    expect(p.address.line1.value).toBeNull();
    expect(p.address.city.value).toBeNull();
    expect(p.address.blockConfidence).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phone extraction
// ---------------------------------------------------------------------------

describe("15P — phone extraction", () => {
  it("extracts a labeled North-American phone with high confidence + canonical format", () => {
    const p = extractVendorProfile("Microsoft Corporation\nPhone: (800) 642-7676\nInvoice #1");
    expect(p.phone.value).toBe("(800) 642-7676");
    expect(p.phone.confidence).toBeGreaterThanOrEqual(90);
    expect(p.phone.source).toBe("invoice-pdf");
  });

  it("extracts a bare NA phone in the header without a label", () => {
    const p = extractVendorProfile("Sysco Foods\n416-555-1234\n... invoice content ...");
    expect(p.phone.value).toBe("(416) 555-1234");
    expect(p.phone.confidence).toBeGreaterThanOrEqual(60);
  });

  it("extracts an international phone with a country-code prefix", () => {
    const p = extractVendorProfile("SAP AG\n+49 6227 74 74747\n...");
    expect(p.phone.value).toContain("49");
    expect(p.phone.confidence).toBeGreaterThan(0);
  });

  it("rejects 9-digit strings that look like a Canadian BN9 tax number", () => {
    const p = extractVendorProfile("Vendor Inc.\nGST Reg: 123456789\nInvoice #1");
    expect(p.phone.value).toBeNull();
  });

  it("rejects a 'Fax:' line even when it contains a phone-shaped number", () => {
    const p = extractVendorProfile("Vendor Inc.\nFax: 416-555-9999\nInvoice #1");
    expect(p.phone.value).toBeNull();
    expect(p.fax.value).toContain("416");
    expect(p.fax.source).toBe("invoice-pdf");
  });
});

// ---------------------------------------------------------------------------
// Website extraction
// ---------------------------------------------------------------------------

describe("15P — website extraction", () => {
  it("extracts a labeled website with high confidence", () => {
    const p = extractVendorProfile("Microsoft Corporation\nWebsite: microsoft.com\n");
    expect(p.website.value).toBe("https://microsoft.com");
    expect(p.website.confidence).toBeGreaterThanOrEqual(90);
  });
  it("extracts an explicit https URL free-standing", () => {
    const p = extractVendorProfile("Toro\nContact us at https://www.toro.com/support for parts.");
    expect(p.website.value).toBe("https://www.toro.com/support");
  });
  it("extracts a www.X.Y URL with slightly lower confidence", () => {
    const p = extractVendorProfile("John Deere\nVisit www.deere.com for details.");
    expect(p.website.value).toBe("https://www.deere.com");
    expect(p.website.confidence).toBeGreaterThanOrEqual(80);
  });
  it("returns null when no website-shaped string is present", () => {
    const p = extractVendorProfile("A very generic invoice with no URLs at all.");
    expect(p.website.value).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GST / tax registration extraction
// ---------------------------------------------------------------------------

describe("15P — GST / tax registration extraction", () => {
  it("extracts a Canadian BN9(RT4) with 99% confidence when the label is HST/GST", () => {
    const p = extractVendorProfile("Microsoft Corporation\nGST/HST No. 895332351 RT0001");
    expect(p.taxRegistrationNumber.value).toContain("895332351");
    expect(p.taxRegistrationNumber.confidence).toBeGreaterThanOrEqual(90);
  });
  it("extracts a Business Number labeled as BN", () => {
    const p = extractVendorProfile("Vendor Corp.\nBusiness Number: 123456789 RT0001");
    expect(p.taxRegistrationNumber.value).toContain("123456789");
  });
  it("extracts a generic Tax Registration Number label", () => {
    const p = extractVendorProfile("Vendor GmbH\nTax Registration No: DE-123456789");
    expect(p.taxRegistrationNumber.value).toBeTruthy();
  });
  it("extracts a VAT number separately", () => {
    const p = extractVendorProfile("Vendor Ltd.\nVAT ID: GB 123 4567 89");
    expect(p.vatNumber.value).toBeTruthy();
    expect(p.vatNumber.source).toBe("invoice-pdf");
  });
});

// ---------------------------------------------------------------------------
// Payment terms — must never guess
// ---------------------------------------------------------------------------

describe("15P — payment terms extraction", () => {
  it("extracts a labeled 'Net 30' at high confidence", () => {
    const p = extractVendorProfile("Vendor\nTerms: Net 30 days\nAmount: $1000");
    expect(p.paymentTerms.value).toBe("Net 30");
    expect(p.paymentTerms.confidence).toBeGreaterThanOrEqual(90);
  });
  it("extracts 'Due on receipt'", () => {
    const p = extractVendorProfile("Vendor\nPayment Terms: Due on receipt");
    expect(p.paymentTerms.value).toBe("Due on receipt");
  });
  it("extracts auto-pay / charged-to-card-on-file wording", () => {
    const p = extractVendorProfile("Microsoft Corporation\nCharged to card on file. No action required.");
    expect(p.paymentTerms.value).toBeTruthy();
  });
  it("returns null when no terms language is present (never guesses)", () => {
    const p = extractVendorProfile("Just a bill with a total and nothing else.");
    expect(p.paymentTerms.value).toBeNull();
    expect(p.paymentTerms.confidence).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Provenance + confidence gate
// ---------------------------------------------------------------------------

describe("15P — provenance and extraction threshold", () => {
  it("EXTRACTION_THRESHOLD is 60 (locked so a future refactor can't silently weaken it)", () => {
    expect(EXTRACT_MODULE).toMatch(/const EXTRACTION_THRESHOLD = 60/);
  });
  it("every populated field carries source='invoice-pdf' + numeric confidence", () => {
    const p = extractVendorProfile([
      "Microsoft Corporation",
      "1950 Meadowvale Blvd",
      "Mississauga, ON L5N 8L9",
      "Phone: (800) 642-7676",
      "Website: https://microsoft.com",
      "GST/HST No. 895332351 RT0001",
      "Terms: Net 30",
    ].join("\n"));
    for (const f of [p.address.line1, p.phone, p.website, p.taxRegistrationNumber, p.paymentTerms]) {
      expect(f.source).toBe("invoice-pdf");
      expect(f.confidence).toBeGreaterThanOrEqual(60);
    }
  });
  it("empty text produces an all-null profile with 0 confidence everywhere", () => {
    const p = extractVendorProfile("");
    for (const f of [
      p.address.line1, p.address.city, p.phone, p.website,
      p.taxRegistrationNumber, p.paymentTerms, p.fax, p.arEmail,
    ]) {
      expect(f.value).toBeNull();
      expect(f.source).toBeNull();
      expect(f.confidence).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Wiring — extraction reaches the modal + the audit log
// ---------------------------------------------------------------------------

describe("15P — wiring: extraction → projection → modal", () => {
  it("analyse.ts runs extractVendorProfile and returns it on ApAnalyseResult.vendorProfile", () => {
    expect(ANALYSE).toMatch(/import \{ extractVendorProfile, type ExtractedVendorProfile \} from ".\/vendor-profile-extract"/);
    expect(ANALYSE).toMatch(/vendorProfile: ExtractedVendorProfile/);
    expect(ANALYSE).toMatch(/const vendorProfile: ExtractedVendorProfile = pdfOk[\s\S]{0,100}\? extractVendorProfile\(pdfText\)/);
  });
  it("Mission Control projection carries extractedVendorProfile on ApInvoiceCardIntelligence", () => {
    expect(IRI).toMatch(/extractedVendorProfile: ExtractedVendorProfile \| null/);
    expect(IRI).toMatch(/extractedVendorProfile: analysis\?\.vendorProfile \?\? null/);
  });
  it("modal pre-populates address, phone, website, GST, AR/remittance emails, terms from the extraction", () => {
    // Initial state derived from `extracted` — the profile useState
    // initializer reads every extractedVendorProfile field.
    expect(MODAL).toMatch(/const extracted = ap\.extractedVendorProfile/);
    expect(MODAL).toMatch(/addressLine1: extracted\?\.address\?\.line1\?\.value \?\? null/);
    expect(MODAL).toMatch(/city: extracted\?\.address\?\.city\?\.value \?\? null/);
    expect(MODAL).toMatch(/provinceOrState: extracted\?\.address\?\.provinceState\?\.value \?\? null/);
    expect(MODAL).toMatch(/postalCode: extracted\?\.address\?\.postalCode\?\.value \?\? null/);
    expect(MODAL).toMatch(/country: extracted\?\.address\?\.country\?\.value \?\? null/);
    expect(MODAL).toMatch(/phone: extracted\?\.phone\?\.value \?\? null/);
    expect(MODAL).toMatch(/website: extracted\?\.website\?\.value \?\? null/);
    expect(MODAL).toMatch(/taxRegistrationNumber: extracted\?\.taxRegistrationNumber\?\.value \?\? null/);
    expect(MODAL).toMatch(/arEmail: extracted\?\.arEmail\?\.value \?\? null/);
    expect(MODAL).toMatch(/apRemittanceEmail: extracted\?\.remittanceEmail\?\.value \?\? null/);
    // Payment-terms conversion via the Net-N shorthand.
    expect(MODAL).toMatch(/const paymentTermsDaysFromExtracted =/);
  });
  it("modal renders a provenance chip per pre-populated field", () => {
    expect(MODAL).toMatch(/function provenanceLabel/);
    // At least the address block + phone + website + GST all pass
    // the chip through the ProfileField wrapper.
    expect(MODAL).toMatch(/provenance=\{provenanceLabel\(extracted\?\.address\?\.line1\)\}/);
    expect(MODAL).toMatch(/provenance=\{provenanceLabel\(extracted\?\.phone\)\}/);
    expect(MODAL).toMatch(/provenance=\{provenanceLabel\(extracted\?\.website\)\}/);
    expect(MODAL).toMatch(/provenance=\{provenanceLabel\(extracted\?\.taxRegistrationNumber\)\}/);
  });
  it("modal ships the per-field provenance back to createVendorAction (audit trail)", () => {
    expect(MODAL).toMatch(/const provenance: Record<string, \{ source: string \| null; confidence: number \}> = \{\}/);
    expect(MODAL).toMatch(/provenance,\s+finishLater/);
  });
});

// ---------------------------------------------------------------------------
// Microsoft acceptance test (realistic sample — no vendor-specific parsing)
// ---------------------------------------------------------------------------

describe("15P — Microsoft-shaped invoice acceptance", () => {
  // A realistic Microsoft O365 invoice text — same shape as the
  // Coulee Ridge staging invoice. NOTHING in the extractor is
  // Microsoft-specific; the same patterns work for Cisco / Dell /
  // Sysco / Toro / John Deere / Club-Support invoices.
  const microsoft = [
    "Microsoft Corporation",
    "1950 Meadowvale Blvd",
    "Mississauga, ON L5N 8L9",
    "Canada",
    "",
    "Phone: (800) 642-7676",
    "Website: https://microsoft.com",
    "",
    "GST/HST No. 895332351 RT0001",
    "",
    "Bill To:",
    "Coulee Ridge Golf & Country Club",
    "5150 Rec Road",
    "Sunset, AB T0K 2X0",
    "",
    "Invoice #E0701097E3",
    "Invoice Date: July 1, 2026",
    "Due Date: July 31, 2026",
    "Terms: Net 30",
    "",
    "Description: Microsoft 365 Business Basic",
    "Subtotal: $29.80",
    "GST 5%: $1.49",
    "Total Due: $31.29 CAD",
  ].join("\n");
  const p = extractVendorProfile(microsoft);

  it("populates VENDOR address (not the Coulee Ridge Bill-To address)", () => {
    expect(p.address.line1.value).toBe("1950 Meadowvale Blvd");
    expect(p.address.city.value).toBe("Mississauga");
    expect(p.address.provinceState.value).toBe("ON");
    expect(p.address.postalCode.value).toBe("L5N 8L9");
    expect(p.address.country.value).toBe("Canada");
  });
  it("populates phone, website, GST reg #, and payment terms", () => {
    expect(p.phone.value).toBe("(800) 642-7676");
    expect(p.website.value).toBe("https://microsoft.com");
    expect(p.taxRegistrationNumber.value).toContain("895332351");
    expect(p.paymentTerms.value).toBe("Net 30");
  });
  it("every populated field carries invoice-pdf provenance", () => {
    for (const f of [p.address.line1, p.address.city, p.phone, p.website, p.taxRegistrationNumber, p.paymentTerms]) {
      expect(f.source).toBe("invoice-pdf");
    }
  });
});
