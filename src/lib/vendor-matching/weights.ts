// Sprint 3 · Checkpoint 15P-3 (2026-07-27) — vendor-match field
// weights + conflict-critical set.
//
// Design principle (§Weighting principles): "Do not allow numerous
// weak fields to casually override a conflict in a strong
// identifier." That's implemented two ways here:
//
//   1. Strong identifiers carry disproportionately high weight so
//      a matched tax id + name outweighs many matched weak fields.
//   2. A `differed` on any CONFLICT_CRITICAL field immediately
//      classifies the candidate as `conflicting`, regardless of
//      how many other fields agree.
//
// FIELD_KEYS is the closed set of fields the matcher knows about.
// Anything a caller sends that isn't on this list is silently
// ignored (defensive, forward-compatible).

export type FieldKey =
  | "legalName"
  | "operatingName"
  | "addressLine1"
  | "addressLine2"
  | "city"
  | "provinceState"
  | "postalCode"
  | "country"
  | "phone"
  | "website"
  | "email"
  | "arEmail"
  | "apRemittanceEmail"
  | "taxRegistrationNumber"
  | "paymentTermsDays"
  | "mainContactName"
  | "mainContactEmail";

// Weight per field. Documented tiers (from the founder's brief):
//
//   Very high (strong identifier):
//     tax registration number         40
//   High:
//     exact normalized legal name     25
//   Medium-high:
//     phone                           15
//     email                           15
//     AR email                         6   (rarely on invoices — supporting)
//     AP remittance email              6   (rarely on invoices — supporting)
//   Medium:
//     operating name                  10
//     website hostname                10
//     address line 1                   8
//     postal code                      8
//     main contact email               8
//   Supporting:
//     city                             5
//     province / state                 3
//     country                          2
//     address line 2                   3
//     main contact name                4
//   Low (not identity-defining):
//     payment terms days               2
//
// Total possible weight ≈ 168. `evidenceCoverage = matchedWeight /
// MAX_POSSIBLE_WEIGHT` therefore rewards records where MANY fields
// agree without punishing the common case where extractions only
// carry the top-tier evidence.
export const FIELD_WEIGHT: Record<FieldKey, number> = {
  taxRegistrationNumber: 40,
  legalName:             25,
  phone:                 15,
  email:                 15,
  operatingName:         10,
  website:               10,
  addressLine1:           8,
  postalCode:             8,
  mainContactEmail:       8,
  arEmail:                6,
  apRemittanceEmail:      6,
  city:                   5,
  mainContactName:        4,
  addressLine2:           3,
  provinceState:          3,
  country:                2,
  paymentTermsDays:       2,
};

export const MAX_POSSIBLE_WEIGHT: number =
  Object.values(FIELD_WEIGHT).reduce((a, b) => a + b, 0);

// A `differed` on any of these disqualifies or downgrades the
// candidate — an operator would never accept a "same vendor" call
// when the tax id or legal name disagree.
//
// Note: legalName appears here despite ALSO being a strong positive
// signal. The rationale is that any candidate the retrieval stage
// returned already had a normalized-name substring hit; a hard
// legal-name disagreement between the extraction and the persisted
// row means we're comparing against a wrongly-retrieved candidate.
export const CONFLICT_CRITICAL: ReadonlySet<FieldKey> = new Set([
  "taxRegistrationNumber",
  "legalName",
]);

// The minimum matched-weight required to call a candidate `exact`.
// Set so a matched tax registration + legal name (40 + 25 = 65)
// qualifies, but a single high-weight field alone does not.
export const EXACT_MATCHED_WEIGHT_FLOOR = 65;

// Minimum matched-weight for `strong` when agreement is high.
export const STRONG_MATCHED_WEIGHT_FLOOR = 40;

// Below this agreement ratio (with at least one differed field) →
// conflicting.
export const CONFLICT_AGREEMENT_CEILING = 0.7;
