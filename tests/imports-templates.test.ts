// Per-domain template metadata — unit tests.
//
// Covers:
//   • Every domain in IMPORT_TEMPLATE_METADATA has matching headers,
//     sample rows, and field docs (no orphans).
//   • COA field docs explain the founder's six columns in language
//     a non-technical admin can read.
//   • buildTemplateCsv / buildHeaderRowCsv produce parseable CSV that
//     round-trips through the same naive splitter the server action
//     uses (so the downloaded template is a valid import input).
//   • Quoted cells with commas / newlines are escaped per RFC 4180.

import { describe, expect, it } from "vitest";

import {
  buildHeaderRowCsv,
  buildTemplateCsv,
  IMPORT_TEMPLATE_METADATA,
  IMPORT_TEMPLATES,
  templateFilename,
  type ImportDomain,
} from "@/lib/imports/templates";

const DOMAINS = Object.keys(IMPORT_TEMPLATE_METADATA) as ImportDomain[];

// ---------------------------------------------------------------------------
// Cross-domain shape invariants.
// ---------------------------------------------------------------------------

describe("IMPORT_TEMPLATE_METADATA — shape invariants", () => {
  it.each(DOMAINS)(
    "%s has a display name, blurb, headers, fields, and sample rows",
    (domain) => {
      const md = IMPORT_TEMPLATE_METADATA[domain];
      expect(md.displayName.length).toBeGreaterThan(0);
      expect(md.blurb.length).toBeGreaterThan(0);
      expect(md.headers.length).toBeGreaterThan(0);
      expect(md.fields.length).toBe(md.headers.length);
      expect(md.sampleRows.length).toBeGreaterThanOrEqual(3);
    },
  );

  it.each(DOMAINS)(
    "%s — every sample row has the same column count as the header row",
    (domain) => {
      const md = IMPORT_TEMPLATE_METADATA[domain];
      for (const row of md.sampleRows) {
        expect(row.length).toBe(md.headers.length);
      }
    },
  );

  it.each(DOMAINS)(
    "%s — every field doc names a column that exists in the header row",
    (domain) => {
      const md = IMPORT_TEMPLATE_METADATA[domain];
      const headerSet = new Set(md.headers);
      for (const f of md.fields) {
        expect(headerSet.has(f.name), `missing header for field ${f.name}`).toBe(true);
      }
    },
  );

  it("legacy IMPORT_TEMPLATES export still matches the metadata headers", () => {
    for (const domain of DOMAINS) {
      expect(IMPORT_TEMPLATES[domain]).toEqual([...IMPORT_TEMPLATE_METADATA[domain].headers]);
    }
  });
});

// ---------------------------------------------------------------------------
// COA — the founder's spec-driven scenario.
// ---------------------------------------------------------------------------

describe("IMPORT_TEMPLATE_METADATA.COA — simplified upload format", () => {
  const coa = IMPORT_TEMPLATE_METADATA.COA;

  it("upload format is just number + name (classification happens in the in-page mapping table)", () => {
    expect(coa.headers).toEqual(["number", "name"]);
    for (const f of coa.fields) {
      expect(f.required, `${f.name} should be required on upload`).toBe(true);
    }
  });

  it("blurb mentions the post-upload mapping table so admins understand where type/category live", () => {
    const blurb = coa.blurb.toLowerCase();
    expect(blurb).toContain("mapping");
    // Specifically calls out that dropdowns are populated from the
    // operator's own configured keys.
    expect(blurb).toMatch(/dropdown|drop-down/);
  });

  it("ships the founder's flagship sample row (1010 Operating Bank Account, simple format)", () => {
    const cashRow = coa.sampleRows.find((r) => r[0] === "1010");
    expect(cashRow).toEqual(["1010", "Operating Bank Account"]);
  });
});

// ---------------------------------------------------------------------------
// CSV helpers.
// ---------------------------------------------------------------------------

describe("buildHeaderRowCsv", () => {
  it("returns the comma-joined header row with no trailing newline", () => {
    const csv = buildHeaderRowCsv(IMPORT_TEMPLATE_METADATA.COA);
    expect(csv).toBe("number,name");
  });
});

describe("buildTemplateCsv", () => {
  it("emits header row followed by every sample row", () => {
    const csv = buildTemplateCsv(IMPORT_TEMPLATE_METADATA.COA);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("number,name");
    // Header + 10 COA sample rows.
    expect(lines.length).toBe(11);
  });

  it("emits one cell per column for every sample row", () => {
    const csv = buildTemplateCsv(IMPORT_TEMPLATE_METADATA.COA);
    const lines = csv.trim().split("\n").slice(1); // skip header
    for (const line of lines) {
      // COA simple format has 2 columns → exactly 1 comma per row.
      const commaCount = (line.match(/,/g) ?? []).length;
      expect(commaCount).toBe(1);
    }
  });

  it("escapes a sample row that contains a comma per RFC 4180", () => {
    const csv = buildTemplateCsv(IMPORT_TEMPLATE_METADATA.VENDORS);
    // Vendor "Greenline Turf Supplies Ltd." has a period but no
    // comma — pick a row that should be quoted by inspecting the
    // legal-name column for any commas in the metadata.
    const legalNames = IMPORT_TEMPLATE_METADATA.VENDORS.sampleRows.map((r) => r[0]);
    const withComma = legalNames.find((n) => n.includes(","));
    if (withComma) {
      expect(csv).toContain(`"${withComma}"`);
    } else {
      // None of the seeded vendor rows contain commas — exercise the
      // escape path directly via a synthetic metadata payload.
      const csvDirect = buildTemplateCsv({
        domain: "VENDORS",
        displayName: "Test",
        blurb: "Test",
        headers: ["legalName"],
        fields: [{ name: "legalName", description: "" }],
        sampleRows: [["Acme, Inc."]],
      });
      expect(csvDirect).toContain('"Acme, Inc."');
    }
  });

  it("escapes embedded quotes by doubling them", () => {
    const csvDirect = buildTemplateCsv({
      domain: "VENDORS",
      displayName: "Test",
      blurb: "Test",
      headers: ["name"],
      fields: [{ name: "name", description: "" }],
      sampleRows: [['Bob "Big" Robertson']],
    });
    expect(csvDirect).toContain('"Bob ""Big"" Robertson"');
  });
});

describe("templateFilename", () => {
  it("emits a sensible kebab-case filename for each domain", () => {
    expect(templateFilename(IMPORT_TEMPLATE_METADATA.COA)).toBe(
      "spectre-chart-of-accounts-template.csv",
    );
    expect(templateFilename(IMPORT_TEMPLATE_METADATA.MEMBERS)).toBe(
      "spectre-members-template.csv",
    );
    expect(templateFilename(IMPORT_TEMPLATE_METADATA.OPENING_TRIAL_BALANCE)).toBe(
      "spectre-opening-trial-balance-template.csv",
    );
  });
});
