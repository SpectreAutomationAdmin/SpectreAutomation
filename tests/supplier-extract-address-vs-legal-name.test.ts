// Sprint 3 · Phase 4R Phase B (2026-08-15) — supplier extraction
// address-vs-legal-name discipline. Locks the §B6 mandatory controls:
//
//   * recipient-address / country-token / postal-line inputs MUST NOT
//     become supplier candidates
//   * geography-containing LEGAL names ("Canada Golf Supply Inc.",
//     "Alberta Equipment Ltd.", ...) MUST remain supplier candidates
//   * legal-name-plus-address same-line ("Microsoft Corporation, One
//     Microsoft Way, Redmond, WA 98052, United States") MUST extract
//     the legal name prefix
//   * three-column Sold-To/Bill-To/Service Usage Address recipient
//     blocks ending in "Canada" MUST NOT yield "Canada" as supplier
//     when the actual supplier appears elsewhere
//
// No brand-specific / vendor-specific / country-blacklist rules.
// Uses generic supplier names throughout.

import { describe, it, expect } from "vitest";
import { extractSupplier } from "@/lib/ap-intelligence/supplier-extract";

// ---------------------------------------------------------------------------
// §B6 — address-only NEGATIVE controls
// ---------------------------------------------------------------------------

describe("§B6 — recipient-address / country / postal inputs are NOT supplier", () => {
  it("Recipient address block ending in bare Canada — supplier is null", () => {
    const text = [
      "123 Example Street",
      "Calgary AB T2T 0Z7",
      "Canada",
    ].join("\n");
    const r = extractSupplier(text, {});
    expect(r.value).toBeNull();
  });

  it("Inline postal + country → not supplier", () => {
    const text = "Calgary AB T2T 0Z7 Canada";
    const r = extractSupplier(text, {});
    expect(r.value).toBeNull();
  });

  it("Suite/address line with mid-line Canadian postal → not supplier", () => {
    const text = "Suite 800, 444 7 Ave SW Calgary AB T2P 0X8 Canada";
    const r = extractSupplier(text, {});
    expect(r.value).toBeNull();
  });

  it("US address with mid-line ZIP → not supplier", () => {
    const text = "Redmond WA 98052 United States";
    const r = extractSupplier(text, {});
    expect(r.value).toBeNull();
  });

  it("UK address with mid-line postcode → not supplier", () => {
    const text = "London SW1A 1AA United Kingdom";
    const r = extractSupplier(text, {});
    expect(r.value).toBeNull();
  });

  it("Province/state-only line 'Calgary Alberta Canada' → not supplier", () => {
    const text = "Calgary Alberta Canada";
    const r = extractSupplier(text, {});
    expect(r.value).toBeNull();
  });

  it("Country-only repeated lines → none become supplier", () => {
    const text = ["Canada", "Canada", "Canada"].join("\n");
    const r = extractSupplier(text, {});
    expect(r.value).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §B6 — legal-name POSITIVE controls (geography inside a credible name)
// ---------------------------------------------------------------------------

describe("§B6 — geography-containing legal names remain valid supplier candidates", () => {
  function suppliesText(name: string) {
    return [
      "INVOICE",
      "Invoice Date: 2026-08-15",
      "Invoice Number: TEST-1",
      name,
      "GST/HST 123456789RT0001",
      "",
      "Bill To:",
      "Coulee Ridge Golf & Country Club",
      "1515 25th Ave SW",
      "Calgary AB T2T 0Z7",
      "Canada",
    ].join("\n");
  }

  it("Canada Golf Supply Inc. — extracts as supplier", () => {
    const r = extractSupplier(suppliesText("Canada Golf Supply Inc."), {});
    expect(r.value).toMatch(/Canada Golf Supply/i);
  });

  it("Alberta Equipment Ltd. — extracts as supplier", () => {
    const r = extractSupplier(suppliesText("Alberta Equipment Ltd."), {});
    expect(r.value).toMatch(/Alberta Equipment/i);
  });

  it("Ontario Turf Products Corporation — extracts as supplier", () => {
    const r = extractSupplier(suppliesText("Ontario Turf Products Corporation"), {});
    expect(r.value).toMatch(/Ontario Turf Products/i);
  });

  it("Example Software Corporation — extracts as supplier", () => {
    const r = extractSupplier(suppliesText("Example Software Corporation"), {});
    expect(r.value).toMatch(/Example Software Corporation/i);
  });
});

// ---------------------------------------------------------------------------
// §B4 — legal-name + address same-line control
// ---------------------------------------------------------------------------

describe("§B4 — legal-name-plus-address same-line preserves legal name prefix", () => {
  it("Example Software Corporation, One Example Way, Seattle WA 98101, United States", () => {
    const text = [
      "INVOICE",
      "Invoice Number: TEST-1",
      "",
      "Bill To: Coulee Ridge",
      "",
      "                Example Software Corporation, One Example Way, Seattle WA 98101, United States",
      "                GST/HST 123456789RT0001",
    ].join("\n");
    const r = extractSupplier(text, {});
    expect(r.value).toMatch(/Example Software Corporation/i);
    // Must NOT be "Seattle", "WA", "98101", "United States", or the
    // full address string.
    expect(r.value).not.toMatch(/^Seattle\b/);
    expect(r.value).not.toMatch(/98101/);
    expect(r.value).not.toMatch(/^United States/);
  });

  it("Microsoft-shape single-line supplier + address — recognisable legal name only", () => {
    // Direct simulation of the #E0701097E3 footer line.
    const text = [
      "                                                                                    Please DO NOT PAY. You will be charged the amount due through your selected method of payment.",
      "                                                                                    Billing or service question? Call 1-800-865-9408 or visit https://aka.ms/Office365Billing",
      "                                                                                    Microsoft Corporation, One Microsoft Way, Redmond, WA 98052, United States",
      "                                                                                    GST/HST 135625069RT0001 QST 1015764658TQ0002",
    ].join("\n");
    const r = extractSupplier(text, {});
    expect(r.value).toMatch(/Microsoft Corporation/i);
    expect(r.value).not.toMatch(/^Redmond\b/);
    expect(r.value).not.toMatch(/98052/);
    expect(r.value).not.toMatch(/^United States/);
    expect(r.value).not.toMatch(/^Canada\b/i);
  });
});

// ---------------------------------------------------------------------------
// §B6 — three-column invoice recipient control (the exact Microsoft
// regression shape)
// ---------------------------------------------------------------------------

describe("§B6 — three-column Sold-To/Bill-To/Service Address recipient blocks", () => {
  it("recipient columns ending in Canada + legitimate supplier footer → supplier wins", () => {
    // Reproduces the Microsoft #E0701097E3 layout: three recipient
    // address columns each ending in a bare "Canada" line, with the
    // actual supplier as a comma-separated single line in the footer.
    // Uses generic 'Example Software Corporation' — no Microsoft-
    // specific rule anywhere in the extractor.
    const text = [
      "Invoice",
      "Invoice Date: 2026-08-15",
      "Invoice Number: TEST-E0701097E3",
      "31.29 CAD",
      "",
      "Sold-To                                 Bill-To                               Service Usage Address",
      "Spectre Automation",
      "1515 25th Ave SW                        Spectre Automation                    Spectre Automation",
      "Calgary ab T2T 0Z7                      1515 25th Ave SW                      1515 25th Ave SW",
      "Canada                                  Calgary ab T2T 0Z7                    Calgary ab T2T 0Z7",
      "                                        Canada                                Canada",
      "",
      "Order Details",
      "Product: Business Standard - 1Year Commit Paid Monthly",
      "",
      "                                Example Software Corporation, One Example Way, Seattle WA 98101, United States",
      "                                                  GST/HST 123456789RT0001",
    ].join("\n");
    const r = extractSupplier(text, {});
    expect(r.value).toMatch(/Example Software Corporation/i);
    expect(r.value).not.toMatch(/^Canada\b/i);
    expect(r.value).not.toMatch(/^Spectre Automation/); // recipient — never supplier
    expect(r.value).not.toMatch(/^United States/);
  });
});

// ---------------------------------------------------------------------------
// §B6 — international control
// ---------------------------------------------------------------------------

describe("§B6 — international supplier with Canadian recipient address", () => {
  it("UK supplier with 'Ltd' beats Canadian recipient address blocks", () => {
    const text = [
      "INVOICE",
      "Invoice Number: TEST-INTL-1",
      "",
      "Sold-To",
      "Coulee Ridge Golf & Country Club",
      "1515 25th Ave SW",
      "Calgary AB T2T 0Z7",
      "Canada",
      "",
      "                        London Turf Machinery Ltd, 12 High Street, London SW1A 1AA, United Kingdom",
      "                        VAT No. GB123456789",
    ].join("\n");
    const r = extractSupplier(text, {});
    expect(r.value).toMatch(/London Turf Machinery/i);
    expect(r.value).not.toMatch(/^Canada\b/i);
    expect(r.value).not.toMatch(/^Calgary\b/i);
    expect(r.value).not.toMatch(/^London SW1A/i); // must not pick the address prefix
  });
});

// ---------------------------------------------------------------------------
// Regression control — pre-Phase-B baseline behaviours must survive
// ---------------------------------------------------------------------------

describe("regression — pre-Phase-B baseline supplier extractions still work", () => {
  it("Simple Corporation-suffixed vendor at top of page", () => {
    const text = [
      "Cloud Reseller Partners Inc.",
      "555 Enterprise Way",
      "Toronto ON M5V 3B2",
      "GST# 800800800 RT0001",
      "",
      "INVOICE",
      "Invoice CRP-A26-9977",
      "Date: 2026-04-28",
    ].join("\n");
    const r = extractSupplier(text, {});
    expect(r.value).toMatch(/Cloud Reseller Partners/i);
  });

  it("Multi-word org name with 'Ltd' at bottom", () => {
    const text = [
      "INVOICE",
      "Invoice Number: TEST-2",
      "",
      "                       Grand Prairie Utilities Ltd",
      "                       GST/HST 111222333RT0001",
    ].join("\n");
    const r = extractSupplier(text, {});
    expect(r.value).toMatch(/Grand Prairie Utilities/i);
  });
});
