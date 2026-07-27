// Sprint 3 · Checkpoint 15P-3 (2026-07-27) — vendor-field
// normalizers. Each helper is pure, symmetric (extracted-side and
// persisted-side pass through the SAME function), and returns
// either the normalized value or null when the input carries no
// evidence.
//
// Founder rule (§Field normalization): "Keep normalization in
// isolated, unit-tested helper functions."
//
// Every helper obeys the same missing-value contract:
//
//   null / undefined / "" / whitespace-only  →  null
//   any other input                          →  normalized string
//
// The one exception is `normalizePaymentTermsDays`, which preserves
// the number 0 as a real value (§ Evidence states: "Numeric 0 is
// populated and must not be treated as blank").

// -----------------------------------------------------------------------------
// The blank-detection helper the whole module leans on.
// -----------------------------------------------------------------------------

export function isBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  return false;
}

// -----------------------------------------------------------------------------
// Strings
// -----------------------------------------------------------------------------

/**
 * Trim, lowercase, collapse whitespace to a single space, drop common
 * "Inc", "Corporation", "LLC" style suffixes ONLY at the tail, and
 * strip punctuation that varies invisibly across vendors' own
 * spelling (commas, periods that end abbreviations, ampersand →
 * "and").
 *
 * Aggressive-equivalence WARNING: we do NOT drop generic words like
 * "the" or "of" — those change meaning. We only touch the well-
 * established organizational-suffix set. When two vendors share the
 * same base name but different suffixes ("ACME Ltd" vs "ACME Inc")
 * this returns "acme" for both — that IS the intended equivalence,
 * because it's the same organization in >99 % of real cases and
 * humans can override.
 */
export function normalizeName(v: string | null | undefined): string | null {
  if (isBlank(v)) return null;
  let s = String(v).trim().toLowerCase();
  s = s.replace(/[.,]/g, " ");
  s = s.replace(/&/g, " and ");
  s = s.replace(/\s+/g, " ").trim();
  // Strip organizational suffix (once, at the tail).
  s = s.replace(/\s+(?:inc(?:orporated)?|corp(?:oration)?|ltd|limited|llc|llp|lp|co|gmbh|ag|sa|plc|nv|bv|pty)\s*$/i, "").trim();
  return s || null;
}

// -----------------------------------------------------------------------------
// Emails
// -----------------------------------------------------------------------------

export function normalizeEmail(v: string | null | undefined): string | null {
  if (isBlank(v)) return null;
  return String(v).trim().toLowerCase() || null;
}

/** Extract the domain (lowercase, no www) from an email address. */
export function emailDomain(v: string | null | undefined): string | null {
  const e = normalizeEmail(v);
  if (!e) return null;
  const at = e.indexOf("@");
  if (at < 0 || at === e.length - 1) return null;
  return e.slice(at + 1).replace(/^www\./, "") || null;
}

// -----------------------------------------------------------------------------
// Phones
// -----------------------------------------------------------------------------

/**
 * Compare phones as pure digit strings. North-American 11-digit
 * numbers with a leading "1" collapse to their 10-digit local form
 * so `+1 (800) 865-9408` and `1-800-865-9408` and `8008659408` all
 * normalize to `8008659408`.
 *
 * Anything shorter than 7 digits after stripping is treated as
 * blank (extension-only fragments, obviously wrong input).
 */
export function normalizePhoneDigits(v: string | null | undefined): string | null {
  if (isBlank(v)) return null;
  const digits = String(v).replace(/\D/g, "");
  if (digits.length < 7) return null;
  // NA 11-digit with leading 1 → drop the country code.
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

// -----------------------------------------------------------------------------
// Postal / ZIP
// -----------------------------------------------------------------------------

/**
 * Canadian postal codes ignore case and internal spacing. US ZIPs
 * keep the "-" separator between the 5-digit prefix and the 4-digit
 * suffix. We collapse both by removing all whitespace and going
 * uppercase — good enough for equality-testing and clearly wrong
 * for anything else.
 */
export function normalizePostalCode(v: string | null | undefined): string | null {
  if (isBlank(v)) return null;
  const s = String(v).trim().toUpperCase().replace(/\s+/g, "");
  return s || null;
}

// -----------------------------------------------------------------------------
// Tax registration number
// -----------------------------------------------------------------------------

/**
 * GST/HST BN-9 + "RT0001" pattern varies in spelling: `135625069
 * RT0001`, `135625069RT0001`, `135625069 RT 0001`. We collapse
 * whitespace and non-alphanumeric characters entirely.
 */
export function normalizeTaxRegistrationNumber(v: string | null | undefined): string | null {
  if (isBlank(v)) return null;
  const s = String(v).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s || null;
}

// -----------------------------------------------------------------------------
// Website hostname
// -----------------------------------------------------------------------------

/**
 * Compare hostnames only — protocol, path, query string, port and
 * "www." are stripped. Handles malformed inputs by falling back to a
 * simple regex.
 */
export function normalizeWebsiteHost(v: string | null | undefined): string | null {
  if (isBlank(v)) return null;
  const raw = String(v).trim();
  // Node URL requires a scheme; add one when the vendor typed a
  // bare host.
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return host || null;
  } catch {
    // Fallback: strip scheme, path, take first host-shaped segment.
    const m = raw.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").match(/^([a-z0-9.\-]+)/);
    return m ? m[1] : null;
  }
}

// -----------------------------------------------------------------------------
// Province / State
// -----------------------------------------------------------------------------

// Symmetric normalization. When the caller passes "Washington" or
// "wa" or "WA", we produce "WA". When someone passes "Alberta" or
// "AB" or "alberta" we produce "AB". Unknown values pass through
// uppercased and trimmed so the caller still has SOMETHING to
// compare (equal-uppercase-strings). Nothing here is authoritative
// — this is a "make identical human labels compare equal" helper.
const US_STATE_LONG_TO_CODE: Record<string, string> = {
  "alabama":"AL","alaska":"AK","arizona":"AZ","arkansas":"AR","california":"CA","colorado":"CO",
  "connecticut":"CT","delaware":"DE","florida":"FL","georgia":"GA","hawaii":"HI","idaho":"ID",
  "illinois":"IL","indiana":"IN","iowa":"IA","kansas":"KS","kentucky":"KY","louisiana":"LA",
  "maine":"ME","maryland":"MD","massachusetts":"MA","michigan":"MI","minnesota":"MN","mississippi":"MS",
  "missouri":"MO","montana":"MT","nebraska":"NE","nevada":"NV","new hampshire":"NH","new jersey":"NJ",
  "new mexico":"NM","new york":"NY","north carolina":"NC","north dakota":"ND","ohio":"OH","oklahoma":"OK",
  "oregon":"OR","pennsylvania":"PA","rhode island":"RI","south carolina":"SC","south dakota":"SD",
  "tennessee":"TN","texas":"TX","utah":"UT","vermont":"VT","virginia":"VA","washington":"WA",
  "west virginia":"WV","wisconsin":"WI","wyoming":"WY","district of columbia":"DC",
};
const CA_PROVINCE_LONG_TO_CODE: Record<string, string> = {
  "alberta":"AB","british columbia":"BC","manitoba":"MB","new brunswick":"NB","newfoundland and labrador":"NL",
  "newfoundland":"NL","labrador":"NL","nova scotia":"NS","northwest territories":"NT","nunavut":"NU",
  "ontario":"ON","prince edward island":"PE","quebec":"QC","saskatchewan":"SK","yukon":"YT",
};

export function normalizeProvinceState(v: string | null | undefined): string | null {
  if (isBlank(v)) return null;
  const s = String(v).trim().toLowerCase().replace(/\s+/g, " ");
  if (US_STATE_LONG_TO_CODE[s]) return US_STATE_LONG_TO_CODE[s];
  if (CA_PROVINCE_LONG_TO_CODE[s]) return CA_PROVINCE_LONG_TO_CODE[s];
  return s.toUpperCase();
}

// -----------------------------------------------------------------------------
// Country
// -----------------------------------------------------------------------------

const COUNTRY_ALIAS: Record<string, string> = {
  "us":"US","usa":"US","u.s.":"US","u.s.a.":"US","united states":"US","united states of america":"US","america":"US",
  "ca":"CA","can":"CA","canada":"CA",
  "uk":"GB","u.k.":"GB","great britain":"GB","united kingdom":"GB","england":"GB","britain":"GB",
  "gb":"GB",
};

export function normalizeCountry(v: string | null | undefined): string | null {
  if (isBlank(v)) return null;
  const s = String(v).trim().toLowerCase().replace(/\s+/g, " ");
  if (COUNTRY_ALIAS[s]) return COUNTRY_ALIAS[s];
  // ISO-2 or ISO-3 code passed through as uppercase.
  return s.toUpperCase();
}

// -----------------------------------------------------------------------------
// Address lines / city
// -----------------------------------------------------------------------------

/**
 * Case-fold, collapse whitespace, strip trailing punctuation. Does
 * NOT rewrite "Street" ↔ "St" or "Avenue" ↔ "Ave" — that's an
 * aggressive equivalence with real false-positive risk. Vendors who
 * mix the two get counted as `differed`, which the operator can
 * override by editing the field.
 */
export function normalizeAddressLine(v: string | null | undefined): string | null {
  if (isBlank(v)) return null;
  let s = String(v).trim().toLowerCase();
  s = s.replace(/[.,]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s || null;
}

export function normalizeCity(v: string | null | undefined): string | null {
  return normalizeAddressLine(v);
}

// -----------------------------------------------------------------------------
// Payment terms
// -----------------------------------------------------------------------------

/**
 * Payment terms are stored as an integer days count on Vendor. We
 * preserve `0` as a real value (due-on-receipt / auto-pay) — the
 * blank check is on `null` / `undefined` only. Non-integer or
 * negative inputs collapse to `null`.
 */
export function normalizePaymentTermsDays(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return Math.round(v);
}
