// Sprint 3 · Checkpoint 15P-3 (2026-07-27) — field-by-field
// comparison. Each vendor field takes a normalizer from
// normalize.ts, applies it symmetrically to both sides, and
// returns one of:
//
//   matched         — both populated, normalized-equal
//   differed        — both populated, normalized-different
//   notComparable   — either side blank / missing
//
// Founder rule (§Evidence states): "Numeric 0 is populated and must
// not be treated as blank." That's enforced in normalizePaymentTermsDays.
//
// The extracted-side and persisted-side shapes are DIFFERENT (one
// comes off `ExtractedVendorProfile`, the other off a Prisma
// `Vendor` row) but the caller flattens both to `MatchInputProfile`
// before calling this module. Keeps the comparison logic entirely
// oblivious to whichever data source it's reading.

import {
  normalizeName, normalizeEmail, normalizePhoneDigits, normalizePostalCode,
  normalizeTaxRegistrationNumber, normalizeWebsiteHost, normalizeProvinceState,
  normalizeCountry, normalizeAddressLine, normalizeCity, normalizePaymentTermsDays,
} from "./normalize";
import { FIELD_WEIGHT, type FieldKey } from "./weights";

export type FieldState = "matched" | "differed" | "notComparable";

export interface FieldComparisonResult {
  key: FieldKey;
  state: FieldState;
  extractedNormalized: string | number | null;
  persistedNormalized: string | number | null;
  weight: number;
}

/**
 * The flattened profile shape both sides funnel through. Every
 * field is optional; a caller that has no value for a field simply
 * omits it. Blank / null / undefined / empty-string all collapse
 * to `notComparable` in the field state.
 */
export interface MatchInputProfile {
  legalName?: string | null;
  operatingName?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  provinceState?: string | null;
  postalCode?: string | null;
  country?: string | null;
  phone?: string | null;
  website?: string | null;
  email?: string | null;
  arEmail?: string | null;
  apRemittanceEmail?: string | null;
  taxRegistrationNumber?: string | null;
  paymentTermsDays?: number | null;
  mainContactName?: string | null;
  mainContactEmail?: string | null;
}

// Per-field normalizer chosen by FieldKey. String helpers cover
// most fields; the terms field uses the numeric normalizer that
// preserves 0.
type StringNormalizer = (v: string | null | undefined) => string | null;
type NumberNormalizer = (v: number | null | undefined) => number | null;

const STRING_NORMALIZERS: Partial<Record<FieldKey, StringNormalizer>> = {
  legalName:             normalizeName,
  operatingName:         normalizeName,
  addressLine1:          normalizeAddressLine,
  addressLine2:          normalizeAddressLine,
  city:                  normalizeCity,
  provinceState:         normalizeProvinceState,
  postalCode:            normalizePostalCode,
  country:               normalizeCountry,
  phone:                 normalizePhoneDigits,
  website:               normalizeWebsiteHost,
  email:                 normalizeEmail,
  arEmail:               normalizeEmail,
  apRemittanceEmail:     normalizeEmail,
  taxRegistrationNumber: normalizeTaxRegistrationNumber,
  mainContactName:       normalizeName,
  mainContactEmail:      normalizeEmail,
};
const NUMBER_NORMALIZERS: Partial<Record<FieldKey, NumberNormalizer>> = {
  paymentTermsDays: normalizePaymentTermsDays,
};

function normalizeOne(key: FieldKey, raw: unknown): string | number | null {
  const strFn = STRING_NORMALIZERS[key];
  if (strFn) return strFn(raw as string | null | undefined);
  const numFn = NUMBER_NORMALIZERS[key];
  if (numFn) return numFn(raw as number | null | undefined);
  return null;
}

export function compareField(
  key: FieldKey,
  extracted: MatchInputProfile,
  persisted: MatchInputProfile,
): FieldComparisonResult {
  const extRaw = (extracted as Record<string, unknown>)[key];
  const perRaw = (persisted as Record<string, unknown>)[key];
  const extNorm = normalizeOne(key, extRaw);
  const perNorm = normalizeOne(key, perRaw);
  const weight = FIELD_WEIGHT[key];

  if (extNorm === null || perNorm === null) {
    return { key, state: "notComparable", extractedNormalized: extNorm, persistedNormalized: perNorm, weight };
  }
  if (extNorm === perNorm) {
    return { key, state: "matched", extractedNormalized: extNorm, persistedNormalized: perNorm, weight };
  }
  return { key, state: "differed", extractedNormalized: extNorm, persistedNormalized: perNorm, weight };
}

/**
 * Compare every known field. Returns results in FIELD_WEIGHT
 * key order (highest weight first) so consumer UI can render the
 * most-important disagreement first without extra sorting.
 */
export function compareAllFields(
  extracted: MatchInputProfile,
  persisted: MatchInputProfile,
): FieldComparisonResult[] {
  const keys = Object.keys(FIELD_WEIGHT) as FieldKey[];
  const results = keys.map((k) => compareField(k, extracted, persisted));
  return results.sort((a, b) => b.weight - a.weight);
}
