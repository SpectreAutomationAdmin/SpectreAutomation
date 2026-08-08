// Sprint 3 · Post-16H Phase 4 Slice 4-reopen (2026-08-07) —
// multimodal supplier-identity orchestrator.
//
// Founder rebuild: supplier identity must be derived from
// CORROBORATED evidence, not a single-signal shortcut. A domain
// alone (e.g. "Dmmenergy" from www.dmmenergy.ca) is insufficient
// architecture — a real invoice carries multiple independent
// signals that must combine into a defensible identity:
//
//   VISUAL_LOGO          + LEGAL_ENTITY_TEXT
//   HEADER_ORG_TEXT      + WEBSITE_DOMAIN
//   ADDRESS_BLOCK        + PHONE_BLOCK
//   TAX_REGISTRATION     + REMITTANCE_ENTITY
//   REPEATED_BRANDING    + PROVIDER_VENDOR_ROLE
//
// This module implements the provider-neutral canonical shape
// (types + orchestrator + clustering + scoring). Visual/logo
// evidence is scaffolded via the existing strategy-router — its
// full realisation is a follow-on slice. Text-based evidence is
// implemented here.
//
// Every candidate carries:
//   * normalizedIdentity — the cluster key (lowercase, corp-suffix
//     stripped, alphanumeric only)
//   * legalNameCandidate — the best "…Inc/Corp/Ltd/…" form seen
//   * operatingNameCandidate — the best plain-brand form seen
//   * evidence — supporting signals with type + page + region +
//     confidence + independenceGroup
//   * contradictions — negative signals attached to this cluster
//   * independentEvidenceGroups — count of DISTINCT independence
//     groups (WEBSITE + EMAIL from same domain root count as ONE)
//   * confidence — 0..100 corroboration score

export type SupplierEvidenceType =
  | "VISUAL_LOGO"
  | "HEADER_ORG_TEXT"
  | "LEGAL_ENTITY_TEXT"
  | "WEBSITE_DOMAIN"
  | "EMAIL_DOMAIN"
  | "ADDRESS_BLOCK"
  | "PHONE_BLOCK"
  | "TAX_REGISTRATION"
  | "REMITTANCE_ENTITY"
  | "PROVIDER_VENDOR_ROLE"
  | "REPEATED_BRANDING"
  | "POSITIONAL_HEADER"
  | "OTHER";

export interface SupplierBoundingRegion {
  page: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  lineIndex?: number;
}

export interface SupplierIdentityEvidence {
  type: SupplierEvidenceType;
  value: string;
  page: number;
  region?: SupplierBoundingRegion;
  confidence: number;              // 0..100 (single-signal strength)
  sourceStrategy: string;
  evidenceSnippet?: string;
  /** Independence-group key. Multiple evidence items sharing this
   *  key count as ONE independent confirmation (e.g. WEBSITE_DOMAIN +
   *  EMAIL_DOMAIN sharing the same domain root). */
  independenceGroup: string;
}

export interface SupplierIdentityCandidate {
  normalizedIdentity: string;
  legalNameCandidate?: string;
  operatingNameCandidate?: string;
  /** Sprint 3 · Post-16H Phase 4 Slice 4-reopen (2026-08-07) —
   *  founder §3: the founder-facing displayName MUST preserve the
   *  original casing / spacing / punctuation of the highest-quality
   *  document evidence text. It must NEVER equal the normalizedIdentity
   *  (which is a machine cluster key). Priority when computing:
   *    HEADER_ORG_TEXT > LEGAL_ENTITY_TEXT > REMITTANCE_ENTITY >
   *    VISUAL_LOGO > REPEATED_BRANDING > any raw-text identity.
   *  Only when NO raw-text evidence exists (domain-only) does a
   *  domain-derived title-case value fall through. */
  displayName?: string;
  evidence: SupplierIdentityEvidence[];
  contradictions: SupplierIdentityEvidence[];
  /** Founder §6: distinct COUNT of evidence FAMILIES (correlated
   *  observations from the same physical block are ONE family).
   *  Was `independentEvidenceGroups` — kept for backward compat. */
  independentEvidenceGroups: number;
  independentEvidenceFamilies: number;
  confidence: number;
}

export interface SupplierSelection {
  winner: SupplierIdentityCandidate | null;
  alternates: Array<{ candidate: SupplierIdentityCandidate; rejectedBecause: string[] }>;
  abstained: boolean;
  abstainReason: string | null;
  /** Deterministic diagnostic payload for tests + card debugging. */
  diagnostic: {
    selectedSupplier: string | null;
    operatingName: string | null;
    legalName: string | null;
    confidence: number;
    independentEvidenceGroups: number;
    supportingEvidence: SupplierEvidenceType[];
    contradictions: SupplierEvidenceType[];
    allCandidates: number;
  };
}

// ---------------------------------------------------------------------------
// Evidence collection — text-only in this slice; visual/logo evidence is
// added by a companion module that feeds SupplierIdentityEvidence with
// type=VISUAL_LOGO once the vision path is wired.
// ---------------------------------------------------------------------------

const LEGAL_SUFFIX_RE = /\b(Inc|Incorporated|Corp|Corporation|Ltd|Limited|LLC|LLP|LP|ULC|PLC|Company|Co|GmbH|AG|SA|BV|NV)\b\.?/i;
// Sprint 3 · Post-16H Phase 4 Slice 4-reopen fix (2026-08-07) —
// the LEGAL_ENTITY_LINE regex must NOT use /i, because /i makes
// `[A-Z]` match lowercase too, which caused "the property of DMM
// ENERGY INC" to be captured as an org name from the footer terms
// ("...the property of DMM ENERGY INC. until full payment..."). An
// organisation name always STARTS with an uppercase letter — the
// suffix alternation covers common casing variants explicitly.
const LEGAL_ENTITY_LINE = /([A-Z][A-Za-z0-9&.,'\-\s]{2,60}?\s+(?:Inc|Incorporated|Corp|Corporation|Ltd|Limited|LLC|LLP|LP|ULC|PLC|Company|Co|GmbH|AG|SA|BV|NV|INC|CORP|LTD|LIMITED|COMPANY|CO))\b\.?/;
const WEBSITE_RE = /\bwww\.([a-z0-9][a-z0-9\-]{1,40})\.([a-z]{2,6})\b/i;
const EMAIL_RE = /\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+)\.([A-Za-z]{2,})\b/g;
const PHONE_RE = /\b(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}\b/;
// Sprint 3 · Post-16H Phase 4 Slice 4-reopen (2026-08-07) —
// bounded quantifiers to prevent catastrophic backtracking on
// long lines that don't contain an address suffix. `{1,60}?`
// is non-greedy + capped.
const ADDRESS_RE = /\b\d{1,6}\s+[A-Z][A-Za-z0-9.'\-\s]{1,60}?(?:Street|St\.?|Road|Rd\.?|Avenue|Ave\.?|Boulevard|Blvd\.?|Drive|Dr\.?|Circle|Cir\.?|Highway|Hwy\.?|Way|Lane|Ln\.?|Court|Ct\.?|Place|Pl\.?|Route|Rte\.?|Square|Sq\.?)\b/i;
const TAX_REG_RE = /\b(?:GST|HST|TPS|TVQ|BN|Business\s*Number|Tax\s*Reg(?:istration)?|EIN)\s*[#:]?\s*(\d[\d\s\-]{6,30})/i;
const REMITTANCE_RE = /\bRemit(?:tance)?\s*(?:payment\s*)?to[:\s]+([^\n]+)/i;

// Domains that must NEVER become a supplier identity on their own —
// generic payment portals, cloud services, personal email hosts.
// Corroboration by a same-cluster address/phone/tax-reg on the same
// document CAN still promote them, but a bare domain match cannot.
const GENERIC_DOMAIN_BLOCKLIST = new Set([
  "gmail", "yahoo", "hotmail", "outlook", "protonmail", "aol", "icloud",
  "no-reply", "noreply", "notifications", "mailer-daemon",
  "quickbooks", "intuit", "stripe", "square",
  "amazonaws", "s3", "dropbox", "sharepoint", "onedrive", "docusign",
  "sendgrid", "mailgun", "postmark", "hubspot", "salesforce",
  "paypal", "venmo", "cashapp", "billcom",
]);

/** Normalize an organisation name into its cluster key: lowercase,
 *  strip legal-suffix, collapse non-alphanumerics. Also handles
 *  suffix variants (Inc./Ltd./LLC) so "DMM Energy Inc" and
 *  "DMM Energy" collapse to the same key. */
export function normalizeOrgName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(LEGAL_SUFFIX_RE, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/** Sprint 3 · Post-16H Phase 4 Slice 4-reopen (2026-08-07) — §5
 *  generalized generic-label rejection. Blocks candidates that
 *  are role/category descriptors (slash-separated, colon-labels,
 *  short common-noun phrases with no organization signal) from
 *  becoming supplier identities. Genuine businesses whose names
 *  INCLUDE these words are not rejected — the value must BE the
 *  bare descriptor (≤ 3 words, no proper-noun anchor).
 *
 *  Rejection criteria (any one is sufficient):
 *    * slash-separated category label ("Taxes/Fees", "GST/HST",
 *      "Product/Service")
 *    * word count ≤ 3 AND every word is on the generic-commercial-
 *      noun list ("Fees", "Charges", "Services", "Products",
 *      "Supplies", "Membership", "Dues", "Account", "Payment",
 *      "Ongoing charges")
 *    * matches known section-title vocabulary
 */
const GENERIC_COMMERCIAL_NOUNS = new Set([
  "fee", "fees", "charge", "charges", "service", "services", "product",
  "products", "supply", "supplies", "membership", "dues", "account",
  "accounts", "payment", "payments", "invoice", "invoices", "statement",
  "statements", "bill", "bills", "receipt", "receipts", "amount",
  "amounts", "total", "totals", "subtotal", "tax", "taxes", "credit",
  "credits", "debit", "debits", "ongoing", "recurring", "pending",
  "outage", "usage", "billing", "adjustment", "adjustments", "rebate",
  "discount", "surcharge",
]);
export function isGenericLabelCandidate(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  // Slash-separated category label — Taxes/Fees / GST/HST / etc.
  if (/^[A-Za-z][A-Za-z]*\/[A-Za-z][A-Za-z]*(?:\/[A-Za-z]+)*$/.test(trimmed)) return true;
  // Trailing colon indicates a label, not an identity.
  if (/:\s*$/.test(trimmed)) return true;
  // Word-by-word generic check.
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  if (words.length <= 3) {
    // All-generic word check (case-insensitive). If EVERY word is
    // in the generic-commercial-noun list, it's a descriptor.
    const allGeneric = words.every((w) => GENERIC_COMMERCIAL_NOUNS.has(w.toLowerCase().replace(/[^a-z]/g, "")));
    if (allGeneric) return true;
  }
  return false;
}

/** Sprint 3 · Post-16H Phase 4 Slice 4-reopen (2026-08-07) — §6
 *  independent-evidence-FAMILY count. Multiple observations from
 *  the same physical letterhead/contact block are correlated and
 *  count as ONE family, not several. Groupings:
 *    IDENTITY_TEXT   — HEADER_ORG_TEXT / LEGAL_ENTITY_TEXT (each
 *                      distinct-value is its own family)
 *    VISUAL_LOGO     — separate family per logo
 *    DOMAIN          — WEBSITE_DOMAIN + EMAIL_DOMAIN sharing domain
 *                      root count as ONE family
 *    CONTACT_BLOCK   — ADDRESS_BLOCK + PHONE_BLOCK adjacent lines
 *                      collapse to ONE family
 *    TAX_REGISTRATION— each distinct registration is its own family
 *    REMITTANCE      — each distinct remittance entity
 *    REPEATED_BRANDING— per-page recurrence
 *    PROVIDER_ROLE   — provider-declared vendor field
 */
function computeIndependentFamilies(evidence: SupplierIdentityEvidence[]): number {
  const families = new Set<string>();
  let contactBlockSeen = false;
  const domainRoots = new Set<string>();
  for (const e of evidence) {
    if (e.type === "ADDRESS_BLOCK" || e.type === "PHONE_BLOCK") {
      if (!contactBlockSeen) {
        families.add("CONTACT_BLOCK");
        contactBlockSeen = true;
      }
      continue;
    }
    if (e.type === "WEBSITE_DOMAIN" || e.type === "EMAIL_DOMAIN") {
      const root = e.value.toLowerCase();
      if (!domainRoots.has(root)) {
        domainRoots.add(root);
        families.add(`DOMAIN:${root}`);
      }
      continue;
    }
    if (e.type === "TAX_REGISTRATION") {
      families.add(`TAX_REG:${e.value.replace(/\s+/g, "")}`);
      continue;
    }
    if (e.type === "REMITTANCE_ENTITY") {
      families.add(`REMIT:${normalizeOrgName(e.value)}`);
      continue;
    }
    if (e.type === "VISUAL_LOGO" || e.type === "REPEATED_BRANDING") {
      families.add(`${e.type}:${normalizeOrgName(e.value)}`);
      continue;
    }
    if (e.type === "HEADER_ORG_TEXT" || e.type === "LEGAL_ENTITY_TEXT" || e.type === "POSITIONAL_HEADER") {
      // Each distinct identity-text value is its own family.
      families.add(`IDENTITY_TEXT:${normalizeOrgName(e.value)}`);
      continue;
    }
    if (e.type === "PROVIDER_VENDOR_ROLE") {
      families.add("PROVIDER_ROLE");
      continue;
    }
    families.add(`${e.type}:${normalizeOrgName(e.value)}`);
  }
  return families.size;
}

/** Sprint 3 · Post-16H Phase 4 Slice 4-reopen (2026-08-07) — §3
 *  founder-facing displayName. Highest-quality preserved-casing
 *  text from actual document evidence. Never returns the
 *  normalizedIdentity. Priority order:
 *    HEADER_ORG_TEXT > LEGAL_ENTITY_TEXT > REMITTANCE_ENTITY >
 *    VISUAL_LOGO > REPEATED_BRANDING > (last resort) a
 *    title-cased domain root.
 */
function computeDisplayName(evidence: SupplierIdentityEvidence[]): string | undefined {
  const PRIORITY: SupplierEvidenceType[] = [
    "HEADER_ORG_TEXT", "LEGAL_ENTITY_TEXT", "REMITTANCE_ENTITY",
    "VISUAL_LOGO", "REPEATED_BRANDING", "POSITIONAL_HEADER",
  ];
  for (const t of PRIORITY) {
    const cand = evidence
      .filter((e) => e.type === t)
      .sort((a, b) => b.confidence - a.confidence)[0];
    if (cand && !isGenericLabelCandidate(cand.value)) return cand.value;
  }
  // Last resort: a domain — title-case it, but flag downstream
  // that this is a domain-only fallback.
  const domain = evidence
    .filter((e) => e.type === "WEBSITE_DOMAIN" || e.type === "EMAIL_DOMAIN")
    .sort((a, b) => b.confidence - a.confidence)[0];
  if (domain) return domain.value.charAt(0).toUpperCase() + domain.value.slice(1);
  return undefined;
}

/** Compute independenceGroup key for an evidence item. WEBSITE +
 *  EMAIL sharing the same domain root collapse; address + phone
 *  block sharing the same page region are separate groups. */
function independenceGroupKey(type: SupplierEvidenceType, value: string): string {
  if (type === "WEBSITE_DOMAIN" || type === "EMAIL_DOMAIN") {
    // Same domain root → same group.
    return `DOMAIN:${value.toLowerCase()}`;
  }
  return `${type}:${normalizeOrgName(value)}`;
}

/** Scan flattened text for supplier-identity evidence. All returned
 *  evidence items carry page=1 (single-page assumption for the
 *  text-only path; positioned/OCR sources overwrite this later). */
export function collectTextSupplierEvidence(text: string): SupplierIdentityEvidence[] {
  const evidence: SupplierIdentityEvidence[] = [];
  const lines = text.split(/\r?\n/);
  const totalLines = lines.length;
  const headerCutoff = Math.min(30, Math.ceil(totalLines * 0.3));

  // ---- LEGAL_ENTITY_TEXT + HEADER_ORG_TEXT (suffix-required path) ----
  for (let i = 0; i < totalLines; i++) {
    const line = lines[i];
    const m = line.match(LEGAL_ENTITY_LINE);
    if (!m || !m[1]) continue;
    const name = m[1].trim().replace(/[,;:]+$/, "");
    if (name.length < 4 || name.length > 80) continue;
    const type: SupplierEvidenceType = i < headerCutoff ? "HEADER_ORG_TEXT" : "LEGAL_ENTITY_TEXT";
    const norm = normalizeOrgName(name);
    if (!norm || norm.length < 3) continue;
    evidence.push({
      type,
      value: name,
      page: 1,
      region: { page: 1, lineIndex: i },
      confidence: type === "HEADER_ORG_TEXT" ? 82 : 75,
      sourceStrategy: "EMBEDDED_TEXT",
      evidenceSnippet: line.slice(0, 100),
      independenceGroup: `LEGAL:${norm}`,
    });
  }

  // Sprint 3 · Post-16H Phase 4 Slice 4-reopen (2026-08-07) — §4
  // suffix-LESS header-org detection. Many real invoices carry the
  // supplier name as a bare all-caps or Title-Case line in the
  // header WITHOUT a corp suffix (CPA ALBERTA / OXIO / Silver
  // Springs Golf & Country Club). Emit these as HEADER_ORG_TEXT
  // evidence so the orchestrator can cluster them with website /
  // tax-reg / address evidence — otherwise the founder-facing
  // display falls through to a domain-derived normalized key.
  const HEADER_STOPLIST = new Set([
    "INVOICE", "FACTURE", "STATEMENT", "BILL", "RECEIPT", "QUOTE", "QUOTATION",
    "CREDIT MEMO", "CREDIT NOTE", "REMITTANCE",
    "BILL TO", "BILL TO:", "SHIP TO", "SHIP TO:", "SOLD TO",
    "CUSTOMER", "CLIENT", "ACCOUNT HOLDER",
    "DESCRIPTION", "PRODUCT", "PRODUIT", "QUANTITY", "QUANTITÉ",
    "PRICE", "PRIX", "AMOUNT", "MONTANT", "TOTAL", "SUBTOTAL",
    "SUB TOTAL", "GRAND TOTAL", "TAX", "TAXES", "GST", "HST", "PST", "QST",
    "TAXES/FEES", "FEES", "CHARGES", "PRODUCTS", "SERVICES", "SUPPLIES",
    "DATE", "PAGE", "REFERENCE", "DATEPAGE", "ORDER", "REF", "REF NO",
    "TERMS", "DUE", "DUE DATE", "PAID", "BALANCE",
  ]);
  // Sprint 3 · Post-16H Phase 4 Slice 4-reopen (2026-08-07) —
  // pdf-parse column-header concatenations (DATEPAGE, PAGEDATE,
  // ORDERPAGE, ITEMQTY, etc.) are single-word tokens formed by
  // adjacent column labels being flattened together. Reject any
  // ALL-CAPS single word whose entire content is composed of ≥2
  // stoplist words concatenated end-to-end.
  const isColumnHeaderConcat = (raw: string): boolean => {
    if (!/^[A-Z]+$/.test(raw)) return false;
    // Try to split into ≥2 known stoplist tokens.
    const stopWords = ["DATE", "PAGE", "TIME", "ORDER", "INVOICE", "ITEM",
      "QTY", "QUANTITY", "PRICE", "AMOUNT", "TOTAL", "TAX", "REF",
      "PRODUCT", "DESCRIPTION", "DUE", "PAID", "NUMBER"];
    let remaining = raw;
    let tokensFound = 0;
    while (remaining.length > 0) {
      const match = stopWords.find((w) => remaining.startsWith(w));
      if (!match) return false;
      remaining = remaining.slice(match.length);
      tokensFound++;
    }
    return tokensFound >= 2;
  };
  // Sprint 3 · Post-16H Phase 4 Slice 4-reopen (2026-08-07) —
  // reject candidates that contain a run of ≥4 digits. Real org
  // names may include a small digit (3M, 7-Eleven) but do not
  // include a 4+ digit sequence like a statement number
  // ("OXIO-23375874"), invoice reference, phone fragment, or
  // account number. This blocks statement-number-as-supplier
  // without a supplier-specific literal.
  const containsLongDigitRun = (raw: string): boolean => /\d{4,}/.test(raw);
  // Sprint 3 · Post-16H Phase 4 Slice 4-reopen (2026-08-07) —
  // pdf-parse label-pair concatenations ("Bill ToShip To" from
  // adjacent "Bill To:" and "Ship To:" columns; "InvoiceCustomer"
  // etc.). Detect by looking for a camelCase boundary
  // (lowercase→uppercase) where BOTH sides are known label words.
  const isLabelPairConcat = (raw: string): boolean => {
    // Only run on strings without whitespace at the boundary.
    const boundaries = [...raw.matchAll(/[a-z](?=[A-Z])/g)];
    if (boundaries.length === 0) return false;
    const LABEL_WORDS = new Set([
      "BILL", "SHIP", "SOLD", "REMIT", "INVOICE", "STATEMENT", "CUSTOMER",
      "CLIENT", "ACCOUNT", "PAYMENT", "DATE", "PAGE", "TIME", "ORDER",
      "ITEM", "PRODUCT", "TOTAL", "TAX", "DUE", "TO", "FROM", "REF",
      "MEMO", "NOTES",
    ]);
    for (const b of boundaries) {
      const idx = b.index!;
      // Left side: consume from a preceding word-boundary up to idx.
      let leftStart = idx;
      while (leftStart > 0 && /[A-Za-z]/.test(raw[leftStart - 1])) leftStart--;
      const leftWord = raw.slice(leftStart, idx + 1).toUpperCase();
      // Right side: consume from idx+1 forward.
      let rightEnd = idx + 1;
      while (rightEnd < raw.length && /[A-Za-z]/.test(raw[rightEnd])) rightEnd++;
      const rightWord = raw.slice(idx + 1, rightEnd).toUpperCase();
      // Also check bare labels + trailing "To" ("BillTo", "ShipTo").
      const leftIsLabel = LABEL_WORDS.has(leftWord) || LABEL_WORDS.has(leftWord.replace(/TO$/, ""));
      const rightIsLabel = LABEL_WORDS.has(rightWord);
      if (leftIsLabel && rightIsLabel) return true;
    }
    return false;
  };
  const HEADER_SUFFIX_LESS_LINE = /^[A-Z][A-Za-z0-9&.'\-]+(?:\s+[A-Z][A-Za-z0-9&.'\-]+){0,5}$/;
  for (let i = 0; i < Math.min(headerCutoff, totalLines); i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    // Skip lines already emitted by the suffix-required path.
    if (LEGAL_SUFFIX_RE.test(raw)) continue;
    if (raw.length < 3 || raw.length > 60) continue;
    // Must be Title-Case or ALL-CAPS run of 1-6 words.
    if (!HEADER_SUFFIX_LESS_LINE.test(raw)) continue;
    // Must not be a stoplist word (case-insensitive comparison).
    if (HEADER_STOPLIST.has(raw.toUpperCase())) continue;
    // Reject pdf-parse column-header concatenations (DATEPAGE etc.).
    if (isColumnHeaderConcat(raw)) continue;
    // Reject label-pair concatenations ("Bill ToShip To" etc.).
    if (isLabelPairConcat(raw)) continue;
    // Reject candidates containing a long digit run (statement
    // numbers, invoice references, phone fragments, account #s).
    if (containsLongDigitRun(raw)) continue;
    // Guard: reject generic labels via the same predicate the
    // orchestrator uses downstream (§5). Prevents FEES / SERVICES /
    // TAXES/FEES / CHARGES from becoming a candidate at seeding time.
    if (isGenericLabelCandidate(raw)) continue;
    const norm = normalizeOrgName(raw);
    if (!norm || norm.length < 3) continue;
    // Reject bare descriptors (2-word phrases where BOTH words are
    // generic commercial nouns).
    evidence.push({
      type: "HEADER_ORG_TEXT",
      value: raw,
      page: 1,
      region: { page: 1, lineIndex: i },
      confidence: 78,
      sourceStrategy: "EMBEDDED_TEXT",
      evidenceSnippet: raw,
      independenceGroup: `HEADER:${norm}`,
    });
  }

  // ---- WEBSITE_DOMAIN ----
  for (let i = 0; i < totalLines; i++) {
    const m = lines[i].match(WEBSITE_RE);
    if (!m || !m[1]) continue;
    const root = m[1].toLowerCase();
    if (GENERIC_DOMAIN_BLOCKLIST.has(root)) continue;
    evidence.push({
      type: "WEBSITE_DOMAIN",
      value: root,
      page: 1,
      region: { page: 1, lineIndex: i },
      confidence: 70,
      sourceStrategy: "EMBEDDED_TEXT",
      evidenceSnippet: `www.${root}.${m[2]}`,
      independenceGroup: `DOMAIN:${root}`,
    });
  }

  // ---- EMAIL_DOMAIN ----
  for (const m of text.matchAll(EMAIL_RE)) {
    const host = (m[2] ?? "").toLowerCase();
    if (!host) continue;
    const root = host.split(".")[0];
    if (GENERIC_DOMAIN_BLOCKLIST.has(root)) continue;
    evidence.push({
      type: "EMAIL_DOMAIN",
      value: root,
      page: 1,
      confidence: 60,
      sourceStrategy: "EMBEDDED_TEXT",
      evidenceSnippet: `${m[1]}@${host}.${m[3]}`,
      independenceGroup: `DOMAIN:${root}`,
    });
  }

  // ---- ADDRESS_BLOCK + PHONE_BLOCK + TAX_REGISTRATION ----
  // These attach to the NEAREST organisation candidate in the header
  // region — we collect them, then during clustering they're assigned
  // to the closest LEGAL/HEADER cluster (or become weak standalone
  // evidence when no cluster exists).
  for (let i = 0; i < totalLines; i++) {
    const line = lines[i];
    if (ADDRESS_RE.test(line)) {
      evidence.push({
        type: "ADDRESS_BLOCK",
        value: line.trim().slice(0, 100),
        page: 1,
        region: { page: 1, lineIndex: i },
        confidence: 55,
        sourceStrategy: "EMBEDDED_TEXT",
        evidenceSnippet: line.trim().slice(0, 80),
        independenceGroup: `ADDRESS_LINE:${i}`,
      });
    }
    if (PHONE_RE.test(line)) {
      const p = line.match(PHONE_RE)?.[0] ?? "";
      evidence.push({
        type: "PHONE_BLOCK",
        value: p,
        page: 1,
        region: { page: 1, lineIndex: i },
        confidence: 45,
        sourceStrategy: "EMBEDDED_TEXT",
        evidenceSnippet: line.trim().slice(0, 80),
        independenceGroup: `PHONE:${p.replace(/\D/g, "")}`,
      });
    }
    const trm = line.match(TAX_REG_RE);
    if (trm) {
      const num = (trm[1] ?? "").replace(/\s+/g, "");
      evidence.push({
        type: "TAX_REGISTRATION",
        value: num,
        page: 1,
        region: { page: 1, lineIndex: i },
        confidence: 78,
        sourceStrategy: "EMBEDDED_TEXT",
        evidenceSnippet: line.trim().slice(0, 80),
        independenceGroup: `TAX_REG:${num}`,
      });
    }
  }

  // ---- REMITTANCE_ENTITY ----
  const remit = text.match(REMITTANCE_RE);
  if (remit && remit[1]) {
    const remitName = remit[1].trim().replace(/[,;:]+$/, "").slice(0, 80);
    const norm = normalizeOrgName(remitName);
    if (norm && norm.length >= 3) {
      evidence.push({
        type: "REMITTANCE_ENTITY",
        value: remitName,
        page: 1,
        confidence: 70,
        sourceStrategy: "EMBEDDED_TEXT",
        evidenceSnippet: remit[0].slice(0, 80),
        independenceGroup: `REMIT:${norm}`,
      });
    }
  }

  return evidence;
}

/** Group evidence into candidates by normalized identity. Attaches
 *  supporting evidence (address / phone / tax-reg / remittance) to
 *  the nearest LEGAL/HEADER cluster when structural proximity
 *  supports it. */
export function clusterSupplierEvidence(evidence: SupplierIdentityEvidence[]): SupplierIdentityCandidate[] {
  // First pass: create candidates from every LEGAL_ENTITY_TEXT /
  // HEADER_ORG_TEXT / WEBSITE_DOMAIN / EMAIL_DOMAIN / REMITTANCE_ENTITY
  // evidence.
  const candidatesByIdentity = new Map<string, SupplierIdentityCandidate>();
  const identityAliases = new Map<string, string>();   // normalized alias → canonical identity
  const IDENTITY_TYPES = new Set<SupplierEvidenceType>([
    "LEGAL_ENTITY_TEXT", "HEADER_ORG_TEXT", "WEBSITE_DOMAIN",
    "EMAIL_DOMAIN", "REMITTANCE_ENTITY", "VISUAL_LOGO", "REPEATED_BRANDING",
  ]);
  for (const e of evidence) {
    if (!IDENTITY_TYPES.has(e.type)) continue;
    const idKey = normalizeOrgName(e.value);
    if (!idKey || idKey.length < 3) continue;
    // Alias merge: domain root and legal name may match by substring.
    // If a longer legal name contains the domain root (or vice versa),
    // merge into the LONGER identity's cluster. Post-16H fix: never
    // create a self-referential alias (which would loop forever in
    // the resolution walk below).
    let target = idKey;
    for (const existing of candidatesByIdentity.keys()) {
      if (existing === idKey) continue;
      if (existing.includes(idKey) || idKey.includes(existing)) {
        target = existing.length >= idKey.length ? existing : idKey;
        if (existing !== target) identityAliases.set(existing, target);
        if (idKey !== target) identityAliases.set(idKey, target);
        break;
      }
    }
    // Resolve alias with a bounded walk (never loops).
    const visited = new Set<string>();
    while (identityAliases.has(target) && !visited.has(target)) {
      visited.add(target);
      const next = identityAliases.get(target)!;
      if (next === target) break;
      target = next;
    }
    let cand = candidatesByIdentity.get(target);
    if (!cand) {
      cand = {
        normalizedIdentity: target,
        legalNameCandidate: undefined,
        operatingNameCandidate: undefined,
        displayName: undefined,
        evidence: [],
        contradictions: [],
        independentEvidenceGroups: 0,
        independentEvidenceFamilies: 0,
        confidence: 0,
      };
      candidatesByIdentity.set(target, cand);
    }
    cand.evidence.push(e);
    // Set legal vs operating names when the shape supports it.
    if (e.type === "LEGAL_ENTITY_TEXT" || e.type === "HEADER_ORG_TEXT") {
      const hasSuffix = LEGAL_SUFFIX_RE.test(e.value);
      if (hasSuffix && !cand.legalNameCandidate) cand.legalNameCandidate = e.value;
      if (!cand.operatingNameCandidate) {
        cand.operatingNameCandidate = e.value.replace(LEGAL_SUFFIX_RE, "").trim().replace(/[,]+$/, "");
      }
    }
    if ((e.type === "WEBSITE_DOMAIN" || e.type === "EMAIL_DOMAIN") && !cand.operatingNameCandidate) {
      cand.operatingNameCandidate = e.value.charAt(0).toUpperCase() + e.value.slice(1);
    }
  }

  // Second pass: attach supporting evidence (address/phone/tax-reg)
  // to the NEAREST-line identity cluster. Sprint 3 · Post-16H
  // Phase 4 Slice 4-reopen (2026-08-07) — nearest-attachment
  // replaces first-by-lineIndex so DMM's Saskatoon address (line
  // 20) attaches to the DMM cluster (whose website evidence is at
  // line 18), not to a spurious earlier cluster like a pdf-parse
  // column-header concat at line 2.
  const supporting = evidence.filter((e) =>
    e.type === "ADDRESS_BLOCK" || e.type === "PHONE_BLOCK" || e.type === "TAX_REGISTRATION",
  );
  const clusterList = Array.from(candidatesByIdentity.values());
  // Sprint 3 · Post-16H Phase 4 Slice 4-reopen (2026-08-07) —
  // never attach supporting evidence (address / phone / tax reg) to
  // a person-shape cluster when an ORG-shape cluster also exists.
  // A recipient's name should not inherit the supplier's tax
  // registration by nearest-line proximity. If no org cluster
  // exists, nearest-line applies as before.
  const orgClusters = clusterList.filter((c) => {
    const primary = c.evidence.find((e) => e.type === "HEADER_ORG_TEXT" || e.type === "LEGAL_ENTITY_TEXT");
    return primary ? !looksLikePersonName(primary.value) : true;
  });
  const attachTargets = orgClusters.length > 0 ? orgClusters : clusterList;
  if (attachTargets.length === 1) {
    for (const s of supporting) attachTargets[0].evidence.push(s);
  } else if (attachTargets.length > 1) {
    for (const s of supporting) {
      const sLine = s.region?.lineIndex ?? -1;
      if (sLine < 0) { attachTargets[0].evidence.push(s); continue; }
      // Distance = min |cluster-evidence-lineIndex − s.lineIndex|.
      let best = attachTargets[0];
      let bestDist = Number.POSITIVE_INFINITY;
      for (const c of attachTargets) {
        for (const ce of c.evidence) {
          const cLine = ce.region?.lineIndex;
          if (cLine == null) continue;
          const dist = Math.abs(cLine - sLine);
          if (dist < bestDist) { bestDist = dist; best = c; }
        }
      }
      best.evidence.push(s);
    }
  }

  return Array.from(candidatesByIdentity.values());
}

/** Sprint 3 · Post-16H Phase 4 Slice 4-reopen (2026-08-07) —
 *  detect candidates that look like a personal name ("FIRST LAST"
 *  two-word all-caps or Title-Case) so they can be down-weighted
 *  when competing against organisation candidates. This handles
 *  invoices with no explicit "Bill To" label above the recipient
 *  (e.g. OXIO's addressee-style layout). Genuine two-word org
 *  names (e.g. "OXIO INTERNATIONAL") are not affected because they
 *  either contain a corp suffix elsewhere or are single-word. */
function looksLikePersonName(raw: string): boolean {
  const words = raw.trim().split(/\s+/);
  if (words.length !== 2) return false;
  const isPersonShape = (w: string): boolean =>
    w.length >= 2 && w.length <= 12 && /^[A-Z][a-z]+$|^[A-Z]+$/.test(w);
  if (!words.every(isPersonShape)) return false;
  // Exclude common organisation words that pass the person-shape
  // pattern (RIDGE, SPRINGS, GOLF, CLUB, etc.). If either word is
  // in the org-word list, don't treat as a person.
  const ORG_WORDS = new Set([
    "GOLF", "CLUB", "COUNTRY", "RIDGE", "SPRINGS", "PARK", "PROPERTIES",
    "COMPANY", "GROUP", "PARTNERS", "SERVICES", "INTERNATIONAL", "GLOBAL",
    "SOLUTIONS", "SYSTEMS", "ENTERPRISES", "INDUSTRIES", "MANAGEMENT",
    "MEDIA", "STUDIOS", "WORKS", "TECHNOLOGIES", "ENERGY", "MINING",
    "MECHANICAL", "PLUMBING", "ELECTRICAL", "LANDSCAPING", "CONSTRUCTION",
  ]);
  return !words.some((w) => ORG_WORDS.has(w.toUpperCase()));
}

/** Compute independent-evidence-family count + confidence for every
 *  candidate. Uses the founder's §5 confidence model + §6 family
 *  bucketing so contact-block observations count as ONE family. */
export function scoreSupplierCandidates(candidates: SupplierIdentityCandidate[]): void {
  for (const c of candidates) {
    // Kept for backward compat (old field) — but confidence now
    // uses FAMILIES.
    const groups = new Set(c.evidence.map((e) => e.independenceGroup));
    c.independentEvidenceGroups = groups.size;
    c.independentEvidenceFamilies = computeIndependentFamilies(c.evidence);
    // Compute + freeze the founder-facing displayName from actual
    // document text (never the normalized cluster key).
    c.displayName = computeDisplayName(c.evidence);
    // Base score from strongest single signal.
    const strongest = c.evidence.reduce((max, e) => Math.max(max, e.confidence), 0);
    // Corroboration multiplier per additional independent FAMILY.
    //   1 family → strongest only
    //   2 families → +20
    //   3+ families → +30
    const bonusFamilies = c.independentEvidenceFamilies;
    const groupBonus =
      bonusFamilies >= 3 ? 30
      : bonusFamilies === 2 ? 20
      : 0;
    // Weak-only cap: single WEBSITE/EMAIL family with no
    // corroboration cannot exceed 45 — founder §18.
    const types = new Set(c.evidence.map((e) => e.type));
    const onlyDomain = bonusFamilies === 1
      && (types.has("WEBSITE_DOMAIN") || types.has("EMAIL_DOMAIN"))
      && !types.has("LEGAL_ENTITY_TEXT") && !types.has("HEADER_ORG_TEXT")
      && !types.has("TAX_REGISTRATION") && !types.has("ADDRESS_BLOCK")
      && !types.has("VISUAL_LOGO");
    let confidence = strongest + groupBonus;
    if (onlyDomain) confidence = Math.min(confidence, 45);
    // Sprint 3 · Post-16H Phase 4 Slice 4-reopen (2026-08-07) —
    // §4 positive-organization-shape requirement. A candidate that
    // has NO identity-text evidence (HEADER_ORG_TEXT /
    // LEGAL_ENTITY_TEXT / VISUAL_LOGO / REPEATED_BRANDING /
    // REMITTANCE_ENTITY) cannot exceed the commitment threshold.
    // Domain-only + address-block does NOT satisfy positive-org-shape.
    const hasIdentityText = types.has("HEADER_ORG_TEXT")
      || types.has("LEGAL_ENTITY_TEXT")
      || types.has("VISUAL_LOGO")
      || types.has("REPEATED_BRANDING")
      || types.has("REMITTANCE_ENTITY");
    if (!hasIdentityText) confidence = Math.min(confidence, 55);
    // Sprint 3 · Post-16H Phase 4 Slice 4-reopen (2026-08-07) —
    // person-name deprioritization. If the winning identity value
    // matches a two-word person-shape, cap confidence at 50 (below
    // commitment threshold) unless the candidate is corroborated
    // by ≥2 identity-text families (e.g. matched by both header
    // AND legal text). This handles OXIO-shape invoices where a
    // recipient name appears in an addressee block WITHOUT an
    // explicit "Bill To:" label.
    const displayVal = c.displayName ?? c.operatingNameCandidate ?? c.legalNameCandidate ?? "";
    if (looksLikePersonName(displayVal) && c.independentEvidenceFamilies < 2) {
      confidence = Math.min(confidence, 50);
    }
    // Sprint 3 · Post-16H Phase 4 Slice 4-reopen (2026-08-07) —
    // earlier-line tiebreaker. When multiple candidates tie on
    // family count + strongest signal, prefer the one whose primary
    // identity evidence appears earliest in the document — the
    // supplier letterhead is almost always FIRST. Small bump
    // (0.5 pt per 10 lines earlier) keeps the tiebreaker gentle.
    const primaryLine = c.evidence
      .filter((e) => e.type === "HEADER_ORG_TEXT" || e.type === "LEGAL_ENTITY_TEXT")
      .map((e) => e.region?.lineIndex ?? Number.POSITIVE_INFINITY)
      .reduce((min, n) => Math.min(min, n), Number.POSITIVE_INFINITY);
    if (Number.isFinite(primaryLine)) {
      // Penalize by ~0.5 pt per 10 lines from the top.
      const positionPenalty = Math.min(5, primaryLine / 10);
      confidence -= positionPenalty;
    }
    c.confidence = Math.max(0, Math.min(100, Math.round(confidence)));
  }
}

/** Founder-§5 commitment policy. Selects a winner only when the
 *  corroboration confidence clears the review threshold; otherwise
 *  abstains with a structured reason. */
export function selectSupplier(candidates: SupplierIdentityCandidate[], opts: {
  /** Minimum confidence to commit to a supplier value. Default 60. */
  commitmentThreshold?: number;
} = {}): SupplierSelection {
  const threshold = opts.commitmentThreshold ?? 60;
  const sorted = candidates.slice().sort((a, b) => b.confidence - a.confidence);
  const winner = sorted[0] ?? null;
  const alternates = sorted.slice(1).map((c) => ({
    candidate: c,
    rejectedBecause: [
      c.confidence < threshold ? "BELOW_COMMITMENT_THRESHOLD" : "LOWER_CONFIDENCE",
    ],
  }));
  const abstained = !winner || winner.confidence < threshold;
  const abstainReason = !winner
    ? "no supplier candidates"
    : winner.confidence < threshold
    ? `top candidate confidence ${winner.confidence} < threshold ${threshold} (insufficient corroboration)`
    : null;
  const supporting = winner ? Array.from(new Set(winner.evidence.map((e) => e.type))) : [];
  // Founder §3 — the founder-facing selectedSupplier is the
  // displayName (raw preserved text from the highest-quality
  // evidence). NEVER the normalizedIdentity.
  return {
    winner: abstained ? null : winner,
    alternates,
    abstained,
    abstainReason,
    diagnostic: {
      selectedSupplier: abstained ? null : (winner?.displayName ?? winner?.legalNameCandidate ?? winner?.operatingNameCandidate ?? null),
      operatingName: winner?.operatingNameCandidate ?? winner?.displayName ?? null,
      legalName: winner?.legalNameCandidate ?? null,
      confidence: winner?.confidence ?? 0,
      independentEvidenceGroups: winner?.independentEvidenceFamilies ?? 0,
      supportingEvidence: supporting,
      contradictions: winner ? Array.from(new Set(winner.contradictions.map((e) => e.type))) : [],
      allCandidates: candidates.length,
    },
  };
}

/** End-to-end helper: text → evidence → clusters → scored → selected.
 *
 *  Sprint 3 · Phase 4 Slice 5.2 (2026-08-08, amendment #8) —
 *  additive `additionalEvidence` input for VISUAL_LOGO / branding
 *  evidence produced by the Slice-5.1 visual-branding-extractor.
 *  Supplier scoring rules are UNCHANGED — branding evidence is
 *  merged into the SAME evidence pool the text path produces and
 *  flows through the SAME clustering + scoring + selection. The
 *  frozen Slice-4-reopen scoring surface is preserved.
 *
 *  Downstream reports (from analyse.ts) publish whether branding
 *  changed evidence-family count, confidence, or the selected
 *  supplier — per amendment #8. */
export function selectSupplierFromText(
  text: string,
  opts?: { commitmentThreshold?: number; additionalEvidence?: SupplierIdentityEvidence[] },
): SupplierSelection {
  const textEvidence = collectTextSupplierEvidence(text);
  const additional = opts?.additionalEvidence ?? [];
  const evidence = additional.length > 0 ? [...textEvidence, ...additional] : textEvidence;
  const candidates = clusterSupplierEvidence(evidence);
  scoreSupplierCandidates(candidates);
  return selectSupplier(candidates, opts ?? {});
}
