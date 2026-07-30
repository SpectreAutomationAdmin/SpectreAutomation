// Sprint 3 · Checkpoint 15V Addendum (2026-07-29) — generalized
// postal-address parser.
//
// Founder rule §5-§7: parse a supplier address block into
// { addressLine1, addressLine2, city, provinceState, postalCode,
// country }. Handles:
//
//   * Suite/unit ON the same line as street or on a separate line
//   * City, province and postal on one line (all-in-one)
//   * Irregular postal spacing (pdf-parse artefact "T 2P 0X8")
//   * Punctuation variation
//   * Province abbreviations and full names
//   * Country present or omitted (safely inferred from CA postal / province)
//   * Multi-line address blocks (2-6 lines)
//
// Preserves the source display form (line1 + line2) while returning
// normalized comparison values (city/province/postalCode).
//
// Every field carries confidence + source metadata.

import { CA_POSTAL_LOOSE, US_ZIP } from "./document-entities";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface ParsedAddress {
  addressLine1: { value: string | null; confidence: number; inferred: boolean };
  addressLine2: { value: string | null; confidence: number; inferred: boolean };
  city: { value: string | null; confidence: number; inferred: boolean };
  provinceState: { value: string | null; confidence: number; inferred: boolean };
  postalCode: { value: string | null; confidence: number; inferred: boolean };
  country: { value: string | null; confidence: number; inferred: boolean };
}

// -----------------------------------------------------------------------------
// Vocabulary
// -----------------------------------------------------------------------------

export const CANADIAN_PROVINCES = new Set([
  "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT",
]);
export const CANADIAN_PROVINCE_FULL_NAMES = new Map<string, string>([
  ["alberta", "AB"], ["british columbia", "BC"], ["manitoba", "MB"],
  ["new brunswick", "NB"], ["newfoundland", "NL"], ["nova scotia", "NS"],
  ["northwest territories", "NT"], ["nunavut", "NU"], ["ontario", "ON"],
  ["prince edward island", "PE"], ["quebec", "QC"], ["saskatchewan", "SK"], ["yukon", "YT"],
]);
export const US_STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID",
  "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS",
  "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
  "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
  "WI", "WY", "DC",
]);

const SUITE_PREFIX = /^(suite|ste\.?|unit|apt\.?|apartment|building|bldg|floor|fl\.?|#)\b/i;
const STREET_LEADER = /^(?:\d+[a-zA-Z]?\s|(?:PO|P\.O\.?)\s*Box\s+|[A-Za-z]+\s+\d{1,4}[a-zA-Z]?\b)/i;

// -----------------------------------------------------------------------------
// Public entrypoint
// -----------------------------------------------------------------------------

export function parseAddressBlock(rawLines: string[]): ParsedAddress {
  const lines = rawLines.map((l) => l.trim()).filter(Boolean);
  const empty: ParsedAddress["addressLine1"] = { value: null, confidence: 0, inferred: false };
  const result: ParsedAddress = {
    addressLine1: { ...empty },
    addressLine2: { ...empty },
    city: { ...empty },
    provinceState: { ...empty },
    postalCode: { ...empty },
    country: { ...empty },
  };
  if (lines.length === 0) return result;

  // Pass 1 — locate the CITY / PROVINCE / POSTAL anchor.
  const anchor = findCityProvincePostal(lines);
  if (anchor) {
    const { cityRaw, provinceRaw, postalRaw, lineIdx, precedingSegments, citySegmentTail, trailingCountry } = anchor;
    result.city = { value: cleanCity(cityRaw), confidence: 92, inferred: false };
    result.provinceState = { value: normalizeProvince(provinceRaw), confidence: 95, inferred: false };
    result.postalCode = { value: normalizePostal(postalRaw), confidence: 96, inferred: false };

    // Country — explicit, or inferred from postal / province.
    if (trailingCountry) {
      result.country = { value: normalizeCountry(trailingCountry), confidence: 95, inferred: false };
    } else if (lineIdx + 1 < lines.length && /^(canada|united\s*states|usa|u\.s\.a\.?)$/i.test(lines[lineIdx + 1])) {
      result.country = { value: normalizeCountry(lines[lineIdx + 1]), confidence: 90, inferred: false };
    } else if (CA_POSTAL_LOOSE.test(postalRaw) || CANADIAN_PROVINCES.has(normalizeProvince(provinceRaw) ?? "")) {
      result.country = { value: "Canada", confidence: 75, inferred: true };
    } else if (US_ZIP.test(postalRaw) || US_STATES.has(normalizeProvince(provinceRaw) ?? "")) {
      result.country = { value: "United States", confidence: 75, inferred: true };
    }

    // Line 1 + line 2 recovery.
    const { line1, line2 } = recoverStreetAndSuite({
      lines,
      lineIdx,
      precedingSegments,
      citySegmentTail,
    });
    if (line1) result.addressLine1 = { value: line1, confidence: 85, inferred: false };
    if (line2) result.addressLine2 = { value: line2, confidence: 85, inferred: false };
  }
  return result;
}

// -----------------------------------------------------------------------------
// Anchor detection — city / province / postal
// -----------------------------------------------------------------------------

interface CityProvincePostal {
  cityRaw: string;
  provinceRaw: string;
  postalRaw: string;
  lineIdx: number;
  citySegmentIdx: number;          // which comma-segment contained the city
  precedingSegments: string[];     // comma-segments BEFORE the city segment (in order)
  citySegmentTail: string | null;  // portion of city segment BEFORE the city word (street tail)
  trailingCountry: string | null;
}

const STREET_TOKEN_RE = /\b(?:Ave|Avenue|St|Street|Rd|Road|Blvd|Boulevard|Dr|Drive|Way|Cres|Crescent|Ct|Court|Pl|Place|Trail|Terr|Terrace|Hwy|Highway|Hts|Heights|Sq|Square|Circle|Cir|Lane|Ln|Loop)\b\.?/i;
const CARDINAL_TOKEN_RE = /\b(?:N|S|E|W|NE|NW|SE|SW|North|South|East|West|Northeast|Northwest|Southeast|Southwest)\b\.?/i;

// Given a comma-segment that ends with the city, extract:
//   * the last word run (the CITY),
//   * everything BEFORE the city (street tail — may be empty).
// "444 - 7th Ave SW Calgary" -> street="444 - 7th Ave SW", city="Calgary"
function splitCitySegment(segment: string): { street: string | null; city: string } | null {
  const trimmed = segment.trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 1) {
    // Single-token segment — the whole thing is the city.
    return SUITE_PREFIX.test(tokens[0]) ? null : { street: null, city: tokens[0] };
  }
  // Walk backward from the tail until we hit a non-city token (digit,
  // street-family word, cardinal direction). Whatever's left after is
  // the city; everything before is the street.
  let cityEndIdx = tokens.length; // exclusive
  let cityStartIdx = cityEndIdx - 1;
  while (cityStartIdx > 0) {
    const prev = tokens[cityStartIdx - 1];
    // Stop when the previous token is a street-family token, a
    // cardinal direction, or contains a digit.
    if (STREET_TOKEN_RE.test(prev) || CARDINAL_TOKEN_RE.test(prev) || /\d/.test(prev)) break;
    // Stop when the previous token doesn't look like a city
    // continuation (must start with capital letter — accepts both
    // Title Case "Calgary" and ALL CAPS "MONTREAL").
    if (!/^[A-Z]/i.test(prev)) break;
    if (/^[a-z]/.test(prev)) break;
    cityStartIdx--;
  }
  const city = tokens.slice(cityStartIdx, cityEndIdx).join(" ").trim();
  const street = cityStartIdx > 0 ? tokens.slice(0, cityStartIdx).join(" ").trim() : null;
  if (!city || /^\d/.test(city) || SUITE_PREFIX.test(city)) return null;
  return { street, city };
}

// Find PROVINCE + POSTAL on any comma-segment across all lines.
// Handles two shapes:
//   Shape A — combined:   "City, Province Postal[ Country]"
//                          segment N-1 = city
//                          segment N   = "Province Postal[ Country]"
//   Shape B — split:      "City, Province, Postal[, Country]"
//                          segment N-2 = city
//                          segment N-1 = province alone
//                          segment N   = postal alone [+ trailing country]
function findCityProvincePostal(lines: string[]): CityProvincePostal | null {
  const provinceAlt = [...CANADIAN_PROVINCES, ...US_STATES].join("|") + "|"
    + [...CANADIAN_PROVINCE_FULL_NAMES.keys()].map((n) => n.replace(/\s+/g, "\\s+")).join("|");
  const provincePostalCombinedRe = new RegExp(
    "^\\s*(" + provinceAlt + ")\\s+(" + CA_POSTAL_LOOSE.source + "|" + US_ZIP.source + ")"
    + "(?:\\s*,?\\s+([A-Z][A-Za-z .]{2,30}))?\\s*$",
    "i",
  );
  const provinceAloneRe = new RegExp("^\\s*(" + provinceAlt + ")\\s*$", "i");
  const postalAloneRe = new RegExp(
    "^\\s*(" + CA_POSTAL_LOOSE.source + "|" + US_ZIP.source + ")"
    + "(?:\\s*,?\\s+([A-Z][A-Za-z .]{2,30}))?\\s*$",
    "i",
  );

  for (let i = 0; i < lines.length; i++) {
    const segments = lines[i].split(",").map((s) => s.trim());

    // Shape B — city, province, postal split across three segments.
    for (let s = 2; s < segments.length; s++) {
      const postalSeg = segments[s].match(postalAloneRe);
      if (!postalSeg) continue;
      const provinceSeg = segments[s - 1].match(provinceAloneRe);
      if (!provinceSeg) continue;
      const provinceNormalized = normalizeProvince(provinceSeg[1]);
      if (!provinceNormalized) continue;
      if (!CANADIAN_PROVINCES.has(provinceNormalized) && !US_STATES.has(provinceNormalized)) continue;
      const citySegment = segments[s - 2];
      const split = splitCitySegment(citySegment);
      if (!split) continue;
      return {
        cityRaw: split.city,
        provinceRaw: provinceSeg[1],
        postalRaw: postalSeg[1],
        lineIdx: i,
        citySegmentIdx: s - 2,
        precedingSegments: segments.slice(0, s - 2),
        citySegmentTail: split.street,
        trailingCountry: postalSeg[2]?.trim() ?? null,
      };
    }

    // Shape A — city, province+postal combined in one segment.
    for (let s = 1; s < segments.length; s++) {
      const seg = segments[s];
      const m = seg.match(provincePostalCombinedRe);
      if (!m) continue;
      const provinceRaw = m[1].trim();
      const postalRaw = m[2].trim();
      const trailingCountry = m[3]?.trim() ?? null;
      const provinceNormalized = normalizeProvince(provinceRaw);
      if (!provinceNormalized) continue;
      if (!CANADIAN_PROVINCES.has(provinceNormalized) && !US_STATES.has(provinceNormalized)) continue;
      const citySegment = segments[s - 1];
      const split = splitCitySegment(citySegment);
      if (!split) continue;
      return {
        cityRaw: split.city,
        provinceRaw,
        postalRaw,
        lineIdx: i,
        citySegmentIdx: s - 1,
        precedingSegments: segments.slice(0, s - 1),
        citySegmentTail: split.street,
        trailingCountry,
      };
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Street + suite recovery
// -----------------------------------------------------------------------------

interface StreetSuite {
  line1: string | null;
  line2: string | null;
}

interface RecoverArgs {
  lines: string[];
  lineIdx: number;                   // index of the line where the anchor lives
  precedingSegments: string[];       // comma-segments on the anchor line BEFORE the city segment
  citySegmentTail: string | null;    // street portion of the city segment (may be null)
}

function recoverStreetAndSuite(args: RecoverArgs): StreetSuite {
  const { lines, lineIdx, precedingSegments, citySegmentTail } = args;

  // Same-line address recovery — collect suite + street from any
  // preceding segments on the anchor line plus the city segment's
  // street tail.
  const sameLineParts: string[] = [
    ...precedingSegments,
    ...(citySegmentTail ? [citySegmentTail] : []),
  ].filter(Boolean);

  const { suite: sameLineSuite, street: sameLineStreet } = classifySuiteStreetParts(sameLineParts);

  // If we found either same-line, ALSO scan PRIOR lines for a suite
  // that wasn't on the anchor line (fixture "Suite 800\n444 - 7th
  // Ave SW\nCalgary, AB T2P 0X8" pattern).
  let prevLineSuite: string | null = null;
  let prevLineStreet: string | null = null;
  for (let j = lineIdx - 1; j >= Math.max(0, lineIdx - 6); j--) {
    const prev = (lines[j] ?? "").trim();
    if (!prev) continue;
    // Stop at a line that looks like a business name / label.
    if (/\b(?:association|society|institute|college|order|federation|chartered|corp|inc|ltd|LLC)\b/i.test(prev)) break;
    if (/^(?:invoice|statement|bill\s*to|attn|phone|fax|email|website|customer|service)/i.test(prev)) break;
    if (!prevLineSuite && SUITE_PREFIX.test(prev)) {
      prevLineSuite = prev;
      continue;
    }
    if (!prevLineStreet && (STREET_LEADER.test(prev) || /^\d/.test(prev))) {
      prevLineStreet = prev;
      // Keep scanning UPWARDS in case a suite line sits above the street.
      continue;
    }
    // Anything else — stop.
    break;
  }

  // Choose final street + suite. Prefer same-line when populated;
  // otherwise fall back to prior lines.
  const finalStreet = sameLineStreet ?? prevLineStreet;
  const finalSuite = sameLineSuite ?? prevLineSuite;
  return { line1: finalStreet, line2: finalSuite };
}

function classifySuiteStreetParts(parts: string[]): { suite: string | null; street: string | null } {
  let suite: string | null = null;
  const streetPieces: string[] = [];
  for (const p of parts) {
    if (!suite && SUITE_PREFIX.test(p)) {
      suite = p;
      continue;
    }
    streetPieces.push(p);
  }
  return { suite, street: streetPieces.length > 0 ? streetPieces.join(", ") : null };
}

// -----------------------------------------------------------------------------
// Normalisation
// -----------------------------------------------------------------------------

function normalizeProvince(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();
  if (CANADIAN_PROVINCES.has(upper)) return upper;
  if (US_STATES.has(upper)) return upper;
  const full = CANADIAN_PROVINCE_FULL_NAMES.get(trimmed.toLowerCase());
  if (full) return full;
  return null;
}

function normalizePostal(raw: string): string {
  const trimmed = raw.trim();
  // Canadian — collapse internal whitespace to a single space in the
  // MIDDLE, upper-case letters.
  if (CA_POSTAL_LOOSE.test(trimmed)) {
    const alnum = trimmed.replace(/\s+/g, "").toUpperCase();
    if (alnum.length === 6) return alnum.slice(0, 3) + " " + alnum.slice(3);
    return alnum;
  }
  return trimmed;
}

function normalizeCountry(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (t === "canada") return "Canada";
  if (t === "usa" || t === "u.s.a." || t === "united states" || t === "united states of america") return "United States";
  return raw.trim();
}

function cleanCity(raw: string): string {
  // Strip a leading suite/unit fragment that leaked in (defensive).
  const trimmed = raw.trim();
  if (SUITE_PREFIX.test(trimmed)) {
    const stripped = trimmed.replace(SUITE_PREFIX, "").replace(/^[\s#\d]+/, "").trim();
    return stripped || trimmed;
  }
  return trimmed;
}
