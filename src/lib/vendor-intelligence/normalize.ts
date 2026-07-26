// Sprint 3 Checkpoint 15F (2026-07-24) — Deterministic vendor
// normalization.
//
// Every function here is pure. NONE of these functions writes to a
// database. Callers use the normalized form for matching only — the
// original values in the Vendor row are preserved untouched.

// -----------------------------------------------------------------------------
// Name normalization
// -----------------------------------------------------------------------------
// Corporate-suffix + punctuation + whitespace + case normalisation.
// Reuses the same suffix list as mission-control/invoice-analysis so a
// PDF-based match and a Vendor-master match resolve identically.
const CORP_SUFFIXES = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|holdings|group|plc|llp|lp|ulc)\b\.?/g;

export function normaliseVendorName(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[,.'"()]/g, "")
    .replace(/&/g, "and")
    .replace(CORP_SUFFIXES, "")
    .replace(/\s+/g, " ")
    .trim();
}

// -----------------------------------------------------------------------------
// Tax / business number normalization
// -----------------------------------------------------------------------------
// Canadian: 9-digit BN, optional "RT" + 4-digit division suffix.
// US: EIN "XX-XXXXXXX".
// General: strip whitespace, uppercase.
export function normaliseTaxNumber(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.replace(/[\s\-]/g, "").toUpperCase();
}

// -----------------------------------------------------------------------------
// Telephone normalization
// -----------------------------------------------------------------------------
// Strip all non-digit characters. Drop leading "1" for NANP numbers so
// a "+1 403-555-1234" and "403.555.1234" collapse to the same 10-digit
// key. Non-NANP numbers preserve their country prefix.
export function normalisePhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

// -----------------------------------------------------------------------------
// Postal-code / ZIP normalization
// -----------------------------------------------------------------------------
// Canadian: uppercase, single space between segments (K1A 0A6).
// US ZIP: uppercase, strip trailing "-XXXX" suffix.
export function normalisePostalCode(raw: string | null | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim().toUpperCase();
  const canadaCompact = trimmed.replace(/[\s\-]+/g, "");
  if (/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(canadaCompact)) {
    return `${canadaCompact.slice(0, 3)} ${canadaCompact.slice(3)}`;
  }
  const usZip = trimmed.replace(/-\d{4}$/, "").replace(/\s+/g, "");
  if (/^\d{5}$/.test(usZip)) return usZip;
  return trimmed.replace(/\s+/g, " ");
}

// -----------------------------------------------------------------------------
// Address normalization
// -----------------------------------------------------------------------------
// Strategy: collapse whitespace, uppercase, expand a small set of common
// street-type abbreviations (St → Street, Ave → Avenue). Deliberately
// conservative — deep address parsing is a rabbit hole and we already
// have postal-code + city as separate signals.
const STREET_TYPE_MAP: Record<string, string> = {
  ST: "STREET", "ST.": "STREET", STR: "STREET",
  AVE: "AVENUE", "AVE.": "AVENUE", AV: "AVENUE",
  RD: "ROAD", "RD.": "ROAD",
  BLVD: "BOULEVARD", "BLVD.": "BOULEVARD",
  DR: "DRIVE", "DR.": "DRIVE",
  HWY: "HIGHWAY", "HWY.": "HIGHWAY",
  PL: "PLACE", "PL.": "PLACE",
  CT: "COURT", "CT.": "COURT",
  CRES: "CRESCENT",
  LN: "LANE", "LN.": "LANE",
};

export function normaliseAddressLine(raw: string | null | undefined): string {
  if (!raw) return "";
  const upper = raw.toUpperCase().replace(/[,.]/g, " ").replace(/\s+/g, " ").trim();
  const tokens = upper.split(" ").map((t) => STREET_TYPE_MAP[t] ?? t);
  return tokens.join(" ").trim();
}

// -----------------------------------------------------------------------------
// Email domain
// -----------------------------------------------------------------------------
const CONSUMER_MAILBOX_DOMAINS = new Set([
  "gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com",
  "aol.com", "live.com", "protonmail.com", "proton.me", "me.com", "msn.com",
]);

export function normaliseEmail(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.trim().toLowerCase();
}

export function domainFromEmail(email: string | null | undefined): string {
  const e = normaliseEmail(email);
  if (!e) return "";
  const at = e.indexOf("@");
  if (at < 0) return "";
  return e.slice(at + 1);
}

export function isConsumerDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  return CONSUMER_MAILBOX_DOMAINS.has(domain.toLowerCase());
}

// -----------------------------------------------------------------------------
// Website domain (strips scheme + www + trailing path)
// -----------------------------------------------------------------------------
export function normaliseWebsiteDomain(raw: string | null | undefined): string {
  if (!raw) return "";
  const t = raw.trim().toLowerCase();
  const withoutScheme = t.replace(/^https?:\/\//, "");
  const hostAndPath = withoutScheme.split("/", 1)[0];
  return hostAndPath.replace(/^www\./, "");
}

// -----------------------------------------------------------------------------
// Composite "normalised vendor fingerprint" — one call, all signals.
// -----------------------------------------------------------------------------
export interface VendorNormalisedFingerprint {
  legalNameNorm: string;
  operatingNameNorm: string;
  taxNumberNorm: string;
  emailNorm: string;
  emailDomain: string;
  websiteDomain: string;
  phoneNorm: string;
  postalCodeNorm: string;
  addressLine1Norm: string;
}

export function fingerprintVendor(v: {
  legalName?: string | null;
  operatingName?: string | null;
  taxRegistrationNumber?: string | null;
  email?: string | null;
  website?: string | null;
  phone?: string | null;
  postalCode?: string | null;
  address1?: string | null;
}): VendorNormalisedFingerprint {
  const emailNorm = normaliseEmail(v.email);
  return {
    legalNameNorm: normaliseVendorName(v.legalName),
    operatingNameNorm: normaliseVendorName(v.operatingName),
    taxNumberNorm: normaliseTaxNumber(v.taxRegistrationNumber),
    emailNorm,
    emailDomain: domainFromEmail(emailNorm),
    websiteDomain: normaliseWebsiteDomain(v.website),
    phoneNorm: normalisePhone(v.phone),
    postalCodeNorm: normalisePostalCode(v.postalCode),
    addressLine1Norm: normaliseAddressLine(v.address1),
  };
}
