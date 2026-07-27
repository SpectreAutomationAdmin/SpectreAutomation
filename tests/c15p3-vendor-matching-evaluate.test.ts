// Sprint 3 · Checkpoint 15P-3 (2026-07-27) — field-comparison +
// evaluator unit tests. Covers:
//
//   • matched / differed / notComparable state per field
//   • blank / null / undefined / empty-string collapse to
//     notComparable symmetrically
//   • numeric 0 on paymentTermsDays is a real value
//   • conflict-critical downgrade (tax id, legal name)
//   • the Microsoft acceptance case (exact classification)
//   • name-only match → possible, NOT equivalent to multi-field exact
//   • tax id + name → exact
//   • matching name with conflicting phone → conflicting-visible

import { describe, expect, it } from "vitest";
import { compareField, compareAllFields, type MatchInputProfile } from "@/lib/vendor-matching/compare";
import { evaluateVendorMatch } from "@/lib/vendor-matching/evaluate";
import { FIELD_WEIGHT, MAX_POSSIBLE_WEIGHT, CONFLICT_CRITICAL } from "@/lib/vendor-matching/weights";

// -----------------------------------------------------------------------------
// Field-level comparison states
// -----------------------------------------------------------------------------

describe("15P-3 · field states — matched / differed / notComparable", () => {
  it("both populated + normalized-equal → matched", () => {
    const r = compareField("legalName", { legalName: "Microsoft Corporation" }, { legalName: "microsoft corp" });
    expect(r.state).toBe("matched");
  });
  it("both populated + normalized-different → differed", () => {
    const r = compareField("legalName", { legalName: "Microsoft Corporation" }, { legalName: "Google LLC" });
    expect(r.state).toBe("differed");
  });
  it("either side blank / null / undefined → notComparable", () => {
    for (const blank of [null, undefined, "", "   "]) {
      const r = compareField("legalName", { legalName: "X" }, { legalName: blank as string | null });
      expect(r.state).toBe("notComparable");
      const r2 = compareField("legalName", { legalName: blank as string | null }, { legalName: "X" });
      expect(r2.state).toBe("notComparable");
    }
  });
  it("null / undefined / empty string treated identically on both sides", () => {
    const cases: Array<null | undefined | string> = [null, undefined, "", "   "];
    for (const a of cases) {
      for (const b of cases) {
        const r = compareField("phone", { phone: a as string | null }, { phone: b as string | null });
        expect(r.state).toBe("notComparable");
      }
    }
  });
  it("paymentTermsDays: 0 is a REAL value (matched vs matched)", () => {
    const r = compareField("paymentTermsDays", { paymentTermsDays: 0 }, { paymentTermsDays: 0 });
    expect(r.state).toBe("matched");
    expect(r.extractedNormalized).toBe(0);
    expect(r.persistedNormalized).toBe(0);
  });
  it("paymentTermsDays: 0 vs null is notComparable (null is missing)", () => {
    const r = compareField("paymentTermsDays", { paymentTermsDays: 0 }, { paymentTermsDays: null });
    expect(r.state).toBe("notComparable");
  });
});

// -----------------------------------------------------------------------------
// Normalization symmetry (both sides through same fn)
// -----------------------------------------------------------------------------

describe("15P-3 · normalization is symmetric between the two sides", () => {
  it("phone: '+1 (800) 865-9408' matches '1-800-865-9408'", () => {
    const r = compareField("phone", { phone: "+1 (800) 865-9408" }, { phone: "1-800-865-9408" });
    expect(r.state).toBe("matched");
  });
  it("postal: 'T2T 0Z7' matches 't2t0z7'", () => {
    const r = compareField("postalCode", { postalCode: "T2T 0Z7" }, { postalCode: "t2t0z7" });
    expect(r.state).toBe("matched");
  });
  it("country: 'United States' matches 'USA'", () => {
    const r = compareField("country", { country: "United States" }, { country: "USA" });
    expect(r.state).toBe("matched");
  });
  it("province: 'Washington' matches 'WA'", () => {
    const r = compareField("provinceState", { provinceState: "Washington" }, { provinceState: "WA" });
    expect(r.state).toBe("matched");
  });
  it("website: 'https://www.example.com/foo' matches 'example.com'", () => {
    const r = compareField("website", { website: "https://www.example.com/foo" }, { website: "example.com" });
    expect(r.state).toBe("matched");
  });
  it("email: mixed case matches lowercase", () => {
    const r = compareField("email", { email: "Admin@Foo.COM" }, { email: "admin@foo.com" });
    expect(r.state).toBe("matched");
  });
  it("tax id: '135625069 RT 0001' matches '135625069RT0001'", () => {
    const r = compareField("taxRegistrationNumber", { taxRegistrationNumber: "135625069 RT 0001" }, { taxRegistrationNumber: "135625069RT0001" });
    expect(r.state).toBe("matched");
  });
});

// -----------------------------------------------------------------------------
// Weights sanity
// -----------------------------------------------------------------------------

describe("15P-3 · field weights", () => {
  it("tax id has the highest single weight", () => {
    const max = Math.max(...Object.values(FIELD_WEIGHT));
    expect(FIELD_WEIGHT.taxRegistrationNumber).toBe(max);
  });
  it("legal name > every non-identifier field", () => {
    expect(FIELD_WEIGHT.legalName).toBeGreaterThan(FIELD_WEIGHT.city);
    expect(FIELD_WEIGHT.legalName).toBeGreaterThan(FIELD_WEIGHT.paymentTermsDays);
  });
  it("payment terms weight is low (not identity-defining)", () => {
    expect(FIELD_WEIGHT.paymentTermsDays).toBeLessThanOrEqual(4);
  });
  it("MAX_POSSIBLE_WEIGHT is the sum of all field weights", () => {
    const sum = Object.values(FIELD_WEIGHT).reduce((a, b) => a + b, 0);
    expect(MAX_POSSIBLE_WEIGHT).toBe(sum);
  });
  it("CONFLICT_CRITICAL contains tax registration number + legal name", () => {
    expect(CONFLICT_CRITICAL.has("taxRegistrationNumber")).toBe(true);
    expect(CONFLICT_CRITICAL.has("legalName")).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Evaluator — headline scenarios
// -----------------------------------------------------------------------------

const MICROSOFT_EXTRACTED: MatchInputProfile = {
  legalName: "Microsoft Corporation",
  addressLine1: "One Microsoft Way",
  city: "Redmond",
  provinceState: "WA",
  postalCode: "98052",
  country: "United States",
  phone: "+1 (800) 865-9408",
  website: "https://aka.ms/Office365Billing",
  taxRegistrationNumber: "135625069RT0001",
};
const MICROSOFT_PERSISTED: MatchInputProfile = {
  legalName: "Microsoft Corporation",
  addressLine1: "One Microsoft Way",
  city: "Redmond",
  provinceState: "WA",
  postalCode: "98052",
  country: "United States",
  phone: "+1 (800) 865-9408",
  website: "https://aka.ms/Office365Billing",
  taxRegistrationNumber: "135625069RT0001",
};

describe("15P-3 · Microsoft acceptance case (identical multi-field record → exact)", () => {
  const ev = evaluateVendorMatch(MICROSOFT_EXTRACTED, MICROSOFT_PERSISTED);
  it("classification = 'exact'", () => {
    expect(ev.classification).toBe("exact");
  });
  it("no differed fields", () => {
    expect(ev.differedFields).toEqual([]);
  });
  it("matched-weight ≥ EXACT_MATCHED_WEIGHT_FLOOR (65)", () => {
    expect(ev.matchedWeight).toBeGreaterThanOrEqual(65);
  });
  it("agreement = 1.0", () => {
    expect(ev.agreement).toBe(1);
  });
  it("fieldsCompared reflects ONLY comparable fields", () => {
    expect(ev.fieldsCompared).toBe(ev.matchedFields.length);
  });
  it("rankingScore > 60", () => {
    expect(ev.rankingScore).toBeGreaterThan(60);
  });
});

describe("15P-3 · name-only match (limited evidence)", () => {
  const ev = evaluateVendorMatch(
    { legalName: "Microsoft Corporation" },
    { legalName: "Microsoft Corporation" },
  );
  it("classification = 'possible' (NOT exact — no supporting evidence)", () => {
    expect(ev.classification).toBe("possible");
  });
  it("fieldsCompared = 1", () => {
    expect(ev.fieldsCompared).toBe(1);
  });
  it("agreement = 1.0 (the one comparable field agrees)", () => {
    expect(ev.agreement).toBe(1);
  });
  it("matched-weight < EXACT_MATCHED_WEIGHT_FLOOR", () => {
    expect(ev.matchedWeight).toBeLessThan(65);
  });
});

describe("15P-3 · exact tax id + name → exact or strong", () => {
  const ev = evaluateVendorMatch(
    { legalName: "X", taxRegistrationNumber: "135625069RT0001" },
    { legalName: "X", taxRegistrationNumber: "135625069RT0001" },
  );
  it("classification is exact (tax id + name = 65 weight)", () => {
    expect(ev.classification).toBe("exact");
  });
});

describe("15P-3 · matching name + conflicting tax id → conflicting", () => {
  const ev = evaluateVendorMatch(
    { legalName: "Microsoft Corporation", taxRegistrationNumber: "135625069RT0001" },
    { legalName: "Microsoft Corporation", taxRegistrationNumber: "999999999RT9999" },
  );
  it("classification = 'conflicting'", () => {
    expect(ev.classification).toBe("conflicting");
  });
  it("taxRegistrationNumber appears in differedFields", () => {
    expect(ev.differedFields).toContain("taxRegistrationNumber");
  });
});

describe("15P-3 · matching name + conflicting phone → conflict visible in evidence", () => {
  const ev = evaluateVendorMatch(
    { legalName: "Microsoft Corporation", phone: "+1 (800) 111-1111" },
    { legalName: "Microsoft Corporation", phone: "+1 (800) 865-9408" },
  );
  it("phone appears in differedFields", () => {
    expect(ev.differedFields).toContain("phone");
  });
  it("agreement is imperfect (< 1.0)", () => {
    expect(ev.agreement).toBeLessThan(1);
  });
  // Phone weight (15) < 70 % floor of (name 25 + phone 15 = 40) → 25/40 = 0.625 → conflicting.
  it("classification = 'conflicting' (below 70 % agreement threshold)", () => {
    expect(ev.classification).toBe("conflicting");
  });
});

describe("15P-3 · differing operatingName (NOT a critical conflict on its own)", () => {
  const ev = evaluateVendorMatch(
    { legalName: "Microsoft Corporation", operatingName: "MS Canada",
      addressLine1: "One Microsoft Way", city: "Redmond", provinceState: "WA",
      postalCode: "98052", country: "US" },
    { legalName: "Microsoft Corporation", operatingName: "MS USA",
      addressLine1: "One Microsoft Way", city: "Redmond", provinceState: "WA",
      postalCode: "98052", country: "US" },
  );
  it("agreement stays above the 70 % floor (many strong matches, one weak differ)", () => {
    expect(ev.agreement).toBeGreaterThanOrEqual(0.7);
  });
  it("classification is NOT conflicting — operatingName differ alone is not critical", () => {
    // The intent of this test is that a non-critical field's
    // disagreement (operatingName) does NOT push the candidate into
    // `conflicting`. Whether it lands at `possible` or `strong`
    // depends on the exact matched-weight vs. the 0.85 agreement
    // threshold — either is a valid non-conflicting outcome.
    expect(ev.classification).not.toBe("conflicting");
    expect(["strong", "exact", "possible"]).toContain(ev.classification);
    // The differed field is surfaced in the evidence.
    expect(ev.differedFields).toContain("operatingName");
  });
});

describe("15P-3 · blank / missing fields do not lower the agreement score", () => {
  const both = evaluateVendorMatch(
    { legalName: "X" },                                   // extracted has nothing else
    { legalName: "X", phone: "+1 (555) 123-4567" },       // persisted has phone
  );
  it("phone stays in notComparableFields (extracted missing)", () => {
    expect(both.notComparableFields).toContain("phone");
  });
  it("agreement stays 1.0 (only name was comparable, and it matched)", () => {
    expect(both.agreement).toBe(1);
  });
});

describe("15P-3 · symmetry — blank on either side is treated the same", () => {
  it("extracted blank == persisted blank => notComparable", () => {
    const a = evaluateVendorMatch({ legalName: "X", phone: null }, { legalName: "X", phone: "5551234567" });
    const b = evaluateVendorMatch({ legalName: "X", phone: "5551234567" }, { legalName: "X", phone: null });
    expect(a.notComparableFields).toEqual(b.notComparableFields);
    expect(a.matchedFields).toEqual(b.matchedFields);
  });
});

describe("15P-3 · ranking among multiple same-name vendors", () => {
  const extracted: MatchInputProfile = {
    legalName: "Microsoft Corporation",
    phone: "+1 (800) 865-9408",
    website: "aka.ms",
    postalCode: "98052",
  };
  const a = evaluateVendorMatch(extracted, { legalName: "Microsoft Corporation" });
  const b = evaluateVendorMatch(extracted, {
    legalName: "Microsoft Corporation",
    phone: "+1 (800) 865-9408",
    website: "aka.ms",
    postalCode: "98052",
  });
  it("richer record ranks higher (matchedWeight)", () => {
    expect(b.matchedWeight).toBeGreaterThan(a.matchedWeight);
  });
  it("richer record ranks higher (rankingScore)", () => {
    expect(b.rankingScore).toBeGreaterThan(a.rankingScore);
  });
  it("both may be positive classifications (not conflicting) because no disagreement exists", () => {
    expect(a.classification).not.toBe("conflicting");
    expect(b.classification).not.toBe("conflicting");
  });
});

// -----------------------------------------------------------------------------
// compareAllFields returns weight-descending order
// -----------------------------------------------------------------------------

describe("15P-3 · compareAllFields returns in weight-descending order", () => {
  const results = compareAllFields({}, {});
  it("first result is tax registration number (weight 40)", () => {
    expect(results[0].key).toBe("taxRegistrationNumber");
  });
  it("second result is legal name (weight 25)", () => {
    expect(results[1].key).toBe("legalName");
  });
});
