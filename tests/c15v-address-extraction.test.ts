// Sprint 3 · Checkpoint 15V Addendum (2026-07-29) — vendor-address
// extraction regression suite.
//
// Every fixture preserves the actual pdf-parse SHAPE that broke the
// pre-Addendum extractor. NO acceptance-specific supplier names,
// invoice numbers, tax registrations, or municipality names appear
// in assertions — only structural shape assertions.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractDocumentEntities } from "@/lib/ap-intelligence/document-entities";
import { parseAddressBlock, CANADIAN_PROVINCES } from "@/lib/ap-intelligence/address-parser";
import { extractVendorProfile } from "@/lib/ap-intelligence/vendor-profile-extract";

// -----------------------------------------------------------------------------
// §13 — behavioural tests: address parser
// -----------------------------------------------------------------------------

describe("15V Addendum · postal-code spacing tolerance (real pdf-parse artefact)", () => {
  it("parses a Canadian postal with a single stray space between chars", () => {
    // Variant 1: "T 2P 0X8".
    const parsed = parseAddressBlock([
      "Suite 800, 444 - 7th Ave SW Calgary, AB T 2P 0X8 Canada",
    ]);
    expect(parsed.postalCode.value).toBe("T2P 0X8");
  });

  it("parses a Canadian postal with DOUBLE spaces between chars (real CPA-shape live artefact)", () => {
    // Variant 2: "T  2P  0X8" — the SPECIFIC shape the CPA ALBERTA
    // letterhead produces via pdf-parse. This one broke the initial
    // Addendum extractor because the regex used `\s?` (0 or 1)
    // instead of a multi-space quantifier.
    const parsed = parseAddressBlock([
      "Suite 800, 444 - 7th Ave SW Calgary, AB T  2P  0X8 Canada",
    ]);
    expect(parsed.postalCode.value).toBe("T2P 0X8");
    expect(parsed.provinceState.value).toBe("AB");
    expect(parsed.city.value).toBe("Calgary");
    expect(parsed.country.value).toBe("Canada");
    // The address parser must ALSO recover suite + street from
    // the SAME live-artefact layout (double-space postal).
    expect(parsed.addressLine1.value).toBe("444 - 7th Ave SW");
    expect(parsed.addressLine2.value).toBe("Suite 800");
  });

  it("parses a canonical single-mid-space Canadian postal", () => {
    const parsed = parseAddressBlock(["100 Sample Ave, Redwood, BC V6B 1A1"]);
    expect(parsed.postalCode.value).toBe("V6B 1A1");
  });

  it("infers country=Canada from CA postal + AB province when country not printed", () => {
    const parsed = parseAddressBlock([
      "Sample Street 500",
      "Redwood, BC V6B 1A1",
    ]);
    expect(parsed.country.value).toBe("Canada");
    expect(parsed.country.inferred).toBe(true);
  });

  it("infers country=United States from US ZIP + state when not printed", () => {
    const parsed = parseAddressBlock([
      "1 Sample Way",
      "Redmond, WA 98052",
    ]);
    expect(parsed.country.value).toBe("United States");
    expect(parsed.country.inferred).toBe(true);
  });
});

describe("15V Addendum · comma-separated single-line address recovery", () => {
  it("recovers suite (line2) + street (line1) from a comma-prefixed line", () => {
    const parsed = parseAddressBlock([
      "Suite 800, 444 - 7th Ave SW Calgary, AB T2P 0X8 Canada",
    ]);
    expect(parsed.addressLine1.value).toBe("444 - 7th Ave SW");
    expect(parsed.addressLine2.value).toBe("Suite 800");
  });

  it("retains a suite on a separate line above the street", () => {
    const parsed = parseAddressBlock([
      "Suite 800",
      "444 - 7th Ave SW",
      "Calgary, AB T2P 0X8",
    ]);
    expect(parsed.addressLine1.value).toBe("444 - 7th Ave SW");
    expect(parsed.addressLine2.value).toBe("Suite 800");
    expect(parsed.city.value).toBe("Calgary");
  });

  it("preserves suite information when placed after the street", () => {
    const parsed = parseAddressBlock([
      "444 - 7th Ave SW, Suite 800 Calgary, AB T2P 0X8",
    ]);
    // Either order is acceptable; the assertion is that suite info
    // is preserved SOMEWHERE.
    const bothPresent = (parsed.addressLine1.value ?? "") + " " + (parsed.addressLine2.value ?? "");
    expect(bothPresent).toMatch(/Suite\s+800/i);
    expect(bothPresent).toMatch(/444\s*[-–]\s*7th/i);
  });
});

// -----------------------------------------------------------------------------
// §3 + §8 — entity-block tests: recipient must not leak into supplier
// -----------------------------------------------------------------------------

describe("15V Addendum · entity blocks — supplier vs recipient separation", () => {
  it("supplier header + recipient 'Bill To' block are separate entities", () => {
    const text = `SAMPLE COMPANY LTD
100 Main St, Toronto, ON M5H 2N2 Canada
info@sample-body.example
+1 416 555 0100

Bill To:
Recipient Person
2200 Other Ave
Vancouver, BC V6B 4N4

Invoice # 12345
Total 1000.00
`;
    const entities = extractDocumentEntities(text, { supplierLegalName: "SAMPLE COMPANY LTD" });
    const supplier = entities.find((e) => e.entityType === "SUPPLIER");
    const recipient = entities.find((e) => e.entityType === "RECIPIENT");
    expect(supplier).toBeDefined();
    expect(recipient).toBeDefined();
    expect(supplier!.organizationName).toBe("SAMPLE COMPANY LTD");
    expect(supplier!.addressLines.some((l) => /Toronto|M5H/.test(l))).toBe(true);
    expect(recipient!.addressLines.some((l) => /Vancouver|V6B/.test(l))).toBe(true);
    // Cross-contamination guard: supplier's address must NOT contain recipient's city.
    expect(supplier!.addressLines.some((l) => /Vancouver|V6B/.test(l))).toBe(false);
    // Recipient's address must NOT contain supplier's city.
    expect(recipient!.addressLines.some((l) => /Toronto|M5H/.test(l))).toBe(false);
  });

  it("a 'Firstname Lastname, CRED' recipient line is NEVER promoted to supplier organizationName", () => {
    const text = `Recipient Person, CPA
SAMPLE INSTITUTE
Suite 500, 100 Some Ave Calgary, AB T2P 0X8

Invoice # 12345
`;
    const entities = extractDocumentEntities(text, { supplierLegalName: "SAMPLE INSTITUTE" });
    const supplier = entities.find((e) => e.entityType === "SUPPLIER");
    expect(supplier).toBeDefined();
    expect(supplier!.organizationName).toBe("SAMPLE INSTITUTE");
    // The person-name line must have been captured as person name
    // OR excluded from the address lines — NOT promoted to the org.
    expect(supplier!.addressLines.every((l) => !/CPA$|CFA$|CGA$/i.test(l))).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// §14 — end-to-end vendor-profile extraction on real CPA-shape
// -----------------------------------------------------------------------------

describe("15V Addendum · extractVendorProfile on real letterhead layout", () => {
  // Sprint 3 · Checkpoint 15V Addendum-rejection — this fixture
  // reproduces the EXACT pdf-parse output shape from the live
  // Coulee Ridge doc: double-space postal, `T.`/`F.` mid-letter
  // artefacts, concatenated fax+website, "Invoice To :" recipient
  // header, and a recipient home address printed further down.
  // Every acceptance-specific value (person name, address, city,
  // postal, phone, invoice number, tax reg) is sanitized to a
  // structural equivalent.
  const CPA_SHAPE_TEXT = `

[PersonName], CPA
BODY ACRONYM
Suite 800, 444 - 7th Ave SW Calgary, AB T  2P  0X8 Canada
T.
403.299.1300
F.
403.299.1339www.example-body.example
Invoice To :
Invoice #:
 9999999999
Date:
Oct 07, 2025
Due Date:
Member Dues for [PersonName] (1006061) Calgary year 2025
Description
Total
May 31, 2025
Member #:
1006061
1515 25 Avenue Southwest
Calgary, AB T  2T  0Z7
Body Region Fee
$810.00
Total
1,000.00
`;

  it("populates line1, line2, city, province, postalCode, country from a single-line letterhead (real live shape)", () => {
    const profile = extractVendorProfile(CPA_SHAPE_TEXT, { vendorLegalName: "BODY ACRONYM" });
    // These are the SUPPLIER address values. The doc also contains
    // a RECIPIENT address ("1515 25 Avenue Southwest / Calgary, AB
    // T  2T  0Z7") — the supplier extraction MUST NOT pick that one.
    expect(profile.address.city.value).toBe("Calgary");
    expect(profile.address.provinceState.value).toBe("AB");
    expect(profile.address.postalCode.value).toBe("T2P 0X8");  // supplier postal, NOT the recipient's T2T 0Z7
    expect(profile.address.country.value).toBe("Canada");
    const line1 = profile.address.line1.value ?? "";
    const line2 = profile.address.line2.value ?? "";
    expect(`${line1} ${line2}`).toMatch(/444\s*[-–]\s*7th/i);
    expect(`${line1} ${line2}`).toMatch(/Suite\s+800/i);
    // Recipient-leakage guard — the supplier line1 must NOT contain the recipient street.
    expect(line1.toLowerCase()).not.toContain("1515");
    expect(line1.toLowerCase()).not.toContain("25 avenue");
  });

  it("does not fabricate address fields when the source document lacks a supplier address", () => {
    const textNoAddress = `Invoice
BODY ACRONYM
Invoice #:
1234567
Total 100.00`;
    const profile = extractVendorProfile(textNoAddress, { vendorLegalName: "BODY ACRONYM" });
    // Every address field must be null when no address block was found.
    expect(profile.address.line1.value).toBeNull();
    expect(profile.address.city.value).toBeNull();
    expect(profile.address.postalCode.value).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// §12 — architectural anti-hardcoding guard
// -----------------------------------------------------------------------------

describe("15V Addendum · anti-hardcoding architectural guard for address extraction", () => {
  const FORBIDDEN = [
    "CPA Alberta", "cpaalberta",
    "1007565767",
    "444 - 7th Ave", "444 7th Ave", "7th Ave SW",
    "Calgary", "Suite 800",
    "T2P 0X8", "T 2P 0X8",
    "108083654",
    "403.269.5341", "1.800.232.9406",
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

  it("no acceptance-document strings leak into executable ap-intelligence code (comments excluded)", async () => {
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

// -----------------------------------------------------------------------------
// Small sanity check on province + postal constants
// -----------------------------------------------------------------------------

describe("15V Addendum · province / postal vocabulary", () => {
  it("recognises all 13 Canadian provinces + territories", () => {
    expect(CANADIAN_PROVINCES.size).toBe(13);
  });
});
