// Sprint 3 · Checkpoint 15V Addendum (2026-07-29) — entity-aware
// document-block layer.
//
// Founder rule §3: extend the document-layout layer so related lines
// can be grouped into entity blocks — SUPPLIER, RECIPIENT,
// REMITTANCE, SHIP_TO, SERVICE_LOCATION, UNKNOWN — with each entity
// carrying its own organization / person / address / phone /
// website / tax-registration signal. Supplier identity + supplier
// address are then resolved as one coherent entity rather than
// through unrelated regexes.
//
// Deterministic, side-effect free. No LLM. pdf-parse currently
// exposes only line text (no coordinates), so this module works
// off the shared DocumentLayout classification; if a future
// extractor adds coordinates the same shape (BoundingBox) can be
// filled without changing consumers.

import { parseDocumentLayout, type DocumentLayout, type DocumentLine } from "./document-layout";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type DocumentEntityType =
  | "SUPPLIER"
  | "RECIPIENT"
  | "REMITTANCE"
  | "SHIP_TO"
  | "SERVICE_LOCATION"
  | "UNKNOWN";

export interface BoundingBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DocumentEntityBlock {
  entityType: DocumentEntityType;
  organizationName?: string;
  personName?: string;
  addressLines: string[];
  phone?: string;
  website?: string;
  email?: string;
  taxRegistrationNumber?: string;
  // Line indices covered by this block, in document order.
  lineIndices: number[];
  pageNumber: number;
  boundingRegion?: BoundingBox;
  confidence: number;   // 0..100
  evidence: string[];
}

// -----------------------------------------------------------------------------
// Header vocabulary — labels that mark an entity block
// -----------------------------------------------------------------------------

interface EntityHeader {
  regex: RegExp;
  entityType: DocumentEntityType;
  windowLines: number;
}

const ENTITY_HEADERS: EntityHeader[] = [
  { regex: /^\s*bill[-\s]?to\s*[:]?\s*$/i, entityType: "RECIPIENT", windowLines: 8 },
  { regex: /^\s*invoice[-\s]?to\s*[:]?\s*$/i, entityType: "RECIPIENT", windowLines: 8 },
  { regex: /^\s*sold[-\s]?to\s*[:]?\s*$/i, entityType: "RECIPIENT", windowLines: 8 },
  { regex: /^\s*customer\s*[:]?\s*$/i, entityType: "RECIPIENT", windowLines: 8 },
  { regex: /^\s*attention\s*[:]?\s*$/i, entityType: "RECIPIENT", windowLines: 8 },
  { regex: /^\s*attn\s*[:]?\s*$/i, entityType: "RECIPIENT", windowLines: 8 },
  { regex: /^\s*member\s+(?:name|address)\s*[:]?\s*$/i, entityType: "RECIPIENT", windowLines: 8 },
  { regex: /^\s*ship[-\s]?to\s*[:]?\s*$/i, entityType: "SHIP_TO", windowLines: 8 },
  { regex: /^\s*deliver\s+to\s*[:]?\s*$/i, entityType: "SHIP_TO", windowLines: 8 },
  { regex: /^\s*remit\s+to\s*[:]?\s*$/i, entityType: "REMITTANCE", windowLines: 8 },
  { regex: /^\s*remittance\s+address\s*[:]?\s*$/i, entityType: "REMITTANCE", windowLines: 8 },
  { regex: /^\s*payments?\s+to\s*[:]?\s*$/i, entityType: "REMITTANCE", windowLines: 8 },
  { regex: /^\s*make\s+cheques?\s+payable\s+to\s*[:]?\s*$/i, entityType: "REMITTANCE", windowLines: 8 },
  { regex: /^\s*service\s+(?:address|location)\s*[:]?\s*$/i, entityType: "SERVICE_LOCATION", windowLines: 6 },
  { regex: /^\s*service\s+usage\s+address\s*[:]?\s*$/i, entityType: "RECIPIENT", windowLines: 8 },
];

// Header WORDS that may appear concatenated on one line (pdf-parse
// column-header artefact — "Sold-ToBill-ToService Usage Address").
const CUSTOMER_HEADER_TOKEN = /\b(?:bill[-\s]?to|ship[-\s]?to|sold[-\s]?to|customer|invoice[-\s]?to|deliver[-\s]?to|service\s*usage\s*address)\b/i;

// -----------------------------------------------------------------------------
// Address structural detection
// -----------------------------------------------------------------------------

// Canadian postal — TOLERATES pdf-parse whitespace artefacts. Real
// invoices in the wild ship with variants like:
//   "T2P 0X8"    (canonical, single mid-space)
//   "T 2P 0X8"   (single space between first char and rest)
//   "T  2P  0X8" (double spaces — actual CPA ALBERTA letterhead)
//   "T2P0X8"     (no spaces)
// The regex allows 0-3 whitespace chars between EACH character so
// none of the above escape detection. Downstream normalization
// collapses whitespace and outputs the canonical "T2P 0X8" form.
export const CA_POSTAL_LOOSE = /[A-Z]\s{0,3}\d\s{0,3}[A-Z]\s{0,3}\d\s{0,3}[A-Z]\s{0,3}\d/i;
export const US_ZIP = /\d{5}(?:-\d{4})?/;

// Address-line signals
const STREET_LEADER = /^(?:\d+[a-zA-Z]?\s|(?:PO|P\.O\.?)\s*Box\s+|[A-Za-z]+\s+\d{1,4}[a-zA-Z]?\b|\d+\s*[-–]\s*\d+\s|\d+\s+[-–]\s+\d+[a-zA-Z]?\s+)/i;
const SUITE_PREFIX = /^\s*(?:suite|ste\.?|unit|apt\.?|apartment|building|bldg|floor|fl\.?)\b/i;

// -----------------------------------------------------------------------------
// Entity-block extraction
// -----------------------------------------------------------------------------

/**
 * Walk the document layout, seed entity blocks around each header
 * label, then infer a supplier block from the document header if no
 * explicit "From:" / "Vendor:" label exists (the common case for
 * real invoices).
 *
 * Every block gets its own line span; overlapping spans are
 * disallowed (later headers override earlier spans only for the
 * lines they explicitly claim).
 */
export function extractDocumentEntities(text: string, opts?: {
  supplierLegalName?: string | null;
  pageNumber?: number;
}): DocumentEntityBlock[] {
  const layout = parseDocumentLayout(text);
  const blocks: DocumentEntityBlock[] = [];
  const claimedLines = new Set<number>();
  const pageNumber = opts?.pageNumber ?? 1;

  // 1. Header-driven blocks — walk each line, spawn a block when a
  //    header regex matches. Windowed forward-scan until blank line
  //    OR another header.
  for (let i = 0; i < layout.lines.length; i++) {
    const line = layout.lines[i];
    if (line.kind === "BLANK") continue;
    const header = ENTITY_HEADERS.find((h) => h.regex.test(line.text));
    if (!header) continue;
    // Skip if inside a claimed span already.
    if (claimedLines.has(i)) continue;
    const block = collectBlock(layout, i, header, pageNumber);
    if (block) {
      blocks.push(block);
      for (const idx of block.lineIndices) claimedLines.add(idx);
    }
  }

  // Concatenated-header line (multiple RECIPIENT-style labels on
  // one line) — mark the following ~16 lines as RECIPIENT territory
  // per 15P-1 handling.
  for (let i = 0; i < layout.lines.length; i++) {
    if (claimedLines.has(i)) continue;
    const line = layout.lines[i];
    if (line.kind === "BLANK") continue;
    const tokens = line.text.match(new RegExp(CUSTOMER_HEADER_TOKEN.source, "gi")) ?? [];
    if (tokens.length < 2) continue;
    const block = collectBlock(layout, i, { regex: /./, entityType: "RECIPIENT", windowLines: 16 }, pageNumber);
    if (block) {
      block.evidence.push("concatenated-recipient-header");
      blocks.push(block);
      for (const idx of block.lineIndices) claimedLines.add(idx);
    }
  }

  // 2. Supplier block — inferred from the document HEADER region
  //    (typically the first 15 lines). This is the most common
  //    real-invoice shape: the vendor's own letterhead sits at
  //    the top; the recipient block appears further down with
  //    a "Bill To:" label.
  const supplierBlock = inferSupplierBlock(layout, opts?.supplierLegalName ?? null, claimedLines, pageNumber);
  if (supplierBlock) blocks.push(supplierBlock);

  // Deterministic sort — by first line index.
  blocks.sort((a, b) => (a.lineIndices[0] ?? 0) - (b.lineIndices[0] ?? 0));
  return blocks;
}

function collectBlock(
  layout: DocumentLayout,
  headerIdx: number,
  header: EntityHeader,
  pageNumber: number,
): DocumentEntityBlock | null {
  const lineIndices: number[] = [];
  const addressLines: string[] = [];
  let organizationName: string | undefined;
  let personName: string | undefined;
  let phone: string | undefined;
  let website: string | undefined;
  let email: string | undefined;
  let taxRegistrationNumber: string | undefined;
  const evidence: string[] = [`header:${header.entityType.toLowerCase()}`];

  // For header-driven blocks, skip the header line itself; for the
  // concatenated-header pattern the header is line 0 of the window
  // but its content isn't a name.
  const startBody = headerIdx + 1;
  const maxEnd = Math.min(layout.lines.length - 1, headerIdx + header.windowLines);
  let blanksSeen = 0;
  for (let j = startBody; j <= maxEnd; j++) {
    const cand = layout.lines[j];
    if (cand.kind === "BLANK") {
      blanksSeen++;
      if (blanksSeen >= 2) break;
      // Trailing single blank is tolerated.
      continue;
    }
    blanksSeen = 0;
    // Stop if we hit another entity header — that's the next block's territory.
    if (ENTITY_HEADERS.some((h) => h.regex.test(cand.text))) break;
    // Section-header amount / summary label — belongs to the invoice
    // body, not an entity.
    if (cand.kind === "SECTION_HEADER" || cand.kind === "LABEL_WITH_AMOUNT") break;
    lineIndices.push(j);
    classifyEntityLine(cand.text, {
      pushAddressLine: (v) => addressLines.push(v),
      setOrganizationName: (v) => { if (!organizationName) organizationName = v; },
      setPersonName: (v) => { if (!personName) personName = v; },
      setPhone: (v) => { if (!phone) phone = v; },
      setWebsite: (v) => { if (!website) website = v; },
      setEmail: (v) => { if (!email) email = v; },
      setTaxRegistrationNumber: (v) => { if (!taxRegistrationNumber) taxRegistrationNumber = v; },
    });
  }
  if (lineIndices.length === 0 && addressLines.length === 0) return null;
  return {
    entityType: header.entityType,
    organizationName,
    personName,
    addressLines,
    phone,
    website,
    email,
    taxRegistrationNumber,
    lineIndices: [headerIdx, ...lineIndices],
    pageNumber,
    confidence: 75,
    evidence,
  };
}

function inferSupplierBlock(
  layout: DocumentLayout,
  supplierLegalName: string | null,
  claimedLines: Set<number>,
  pageNumber: number,
): DocumentEntityBlock | null {
  // Find the first non-blank content line that isn't already claimed.
  // Extend downwards up to 10 lines until we hit a claimed line, a
  // section header, or a labelled entity header.
  const start = layout.lines.findIndex((l) =>
    l.kind !== "BLANK"
    && !claimedLines.has(l.index)
    && !ENTITY_HEADERS.some((h) => h.regex.test(l.text))
    && !/^\s*(?:invoice|statement|bill|remittance|purchase\s+order|receipt|credit\s+note)\s*$/i.test(l.text),
  );
  if (start < 0) return null;

  const evidence: string[] = ["header-region-inferred"];
  const lineIndices: number[] = [];
  const addressLines: string[] = [];
  let organizationName: string | undefined;
  let personName: string | undefined;
  let phone: string | undefined;
  let website: string | undefined;
  let email: string | undefined;
  let taxRegistrationNumber: string | undefined;

  // If the caller gave us the supplier legal name, seed the block by
  // finding that line first — even if the block extends across other
  // unrelated lines above.
  let anchor = start;
  if (supplierLegalName) {
    const idx = layout.lines.findIndex((l) => l.text.trim() === supplierLegalName.trim());
    if (idx >= 0) {
      anchor = idx;
      organizationName = supplierLegalName;
      evidence.push("anchor:supplier-legal-name-match");
    }
  }

  // Walk from the anchor outwards for a supplier-block window (max
  // ~12 lines below).
  const maxEnd = Math.min(layout.lines.length - 1, anchor + 12);
  let blanksSeen = 0;
  for (let j = anchor; j <= maxEnd; j++) {
    if (claimedLines.has(j)) break;
    const cand = layout.lines[j];
    if (cand.kind === "BLANK") {
      blanksSeen++;
      if (blanksSeen >= 2) break;
      continue;
    }
    blanksSeen = 0;
    if (ENTITY_HEADERS.some((h) => h.regex.test(cand.text))) break;
    // Stop when we hit an obvious body-content marker.
    if (/^\s*(?:invoice\s*(?:number|no\.?|#|date)|due\s+date|amount\s+due|subtotal|total|payment\s+details|charges|line\s+item|description)\b/i.test(cand.text)) break;
    lineIndices.push(j);
    classifyEntityLine(cand.text, {
      pushAddressLine: (v) => addressLines.push(v),
      setOrganizationName: (v) => { if (!organizationName) organizationName = v; },
      setPersonName: (v) => { if (!personName) personName = v; },
      setPhone: (v) => { if (!phone) phone = v; },
      setWebsite: (v) => { if (!website) website = v; },
      setEmail: (v) => { if (!email) email = v; },
      setTaxRegistrationNumber: (v) => { if (!taxRegistrationNumber) taxRegistrationNumber = v; },
    });
  }

  if (addressLines.length === 0 && !organizationName) return null;
  return {
    entityType: "SUPPLIER",
    organizationName,
    personName,
    addressLines,
    phone,
    website,
    email,
    taxRegistrationNumber,
    lineIndices,
    pageNumber,
    confidence: organizationName === supplierLegalName ? 85 : 65,
    evidence,
  };
}

// -----------------------------------------------------------------------------
// Line-level classification within a block
// -----------------------------------------------------------------------------

interface LineHandlers {
  pushAddressLine: (v: string) => void;
  setOrganizationName: (v: string) => void;
  setPersonName: (v: string) => void;
  setPhone: (v: string) => void;
  setWebsite: (v: string) => void;
  setEmail: (v: string) => void;
  setTaxRegistrationNumber: (v: string) => void;
}

const PHONE_RE = /\b(?:1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b|\b1[\s.\-]?800[\s.\-]?\d{3}[\s.\-]?\d{4}\b/;
const WEBSITE_RE = /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\/?[^\s]*/i;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const TAX_REG_RE = /\b(?:GST|HST|VAT|BN|EIN|Business\s+Number|Tax\s*(?:Registration|ID|Reg))\b\s*[:#]?\s*(?:\d{9}(?:RT\d{4})?|\d{2}-\d{7})\b/i;
const CORP_SUFFIX_RE = /\b(?:Corporation|Corp\.?|Company|Co\.?|Inc\.?|Ltd\.?|Limited|LLC|LLP|LP|ULC|PLC|GmbH|AG|SA|BV|NV|Association|Society|Institute|College|Order|Federation|Chartered)\b/i;
const REGION_SUFFIX_RE = /^[A-Z]{2,6}\s+(?:Alberta|Ontario|Manitoba|Saskatchewan|British\s+Columbia|BC|Quebec|Nova\s+Scotia|New\s+Brunswick|Newfoundland|Prince\s+Edward\s+Island|PEI|Yukon|NWT|Nunavut|Canada|USA|America)$/i;
const PERSON_WITH_CREDENTIAL_RE = /^[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)+,\s*[A-Z]{2,6}(?:\.[A-Z]{2,6})?$/;

function classifyEntityLine(rawText: string, h: LineHandlers): void {
  const text = rawText.trim();
  if (!text) return;

  const phoneMatch = text.match(PHONE_RE);
  if (phoneMatch) { h.setPhone(phoneMatch[0]); return; }

  const emailMatch = text.match(EMAIL_RE);
  if (emailMatch) { h.setEmail(emailMatch[0]); return; }

  const websiteMatch = text.match(WEBSITE_RE);
  // Website heuristic: has a dot AND at least one letter, AND the
  // matched string ISN'T already an email address.
  if (websiteMatch && !emailMatch && /\./.test(websiteMatch[0]) && /[a-zA-Z]/.test(websiteMatch[0])) {
    h.setWebsite(websiteMatch[0]);
    return;
  }

  const taxMatch = text.match(TAX_REG_RE);
  if (taxMatch) { h.setTaxRegistrationNumber(taxMatch[0]); return; }

  // Person-with-credential ("Firstname Lastname, CPA") — RECIPIENT-
  // shape signal, never a supplier organization.
  if (PERSON_WITH_CREDENTIAL_RE.test(text)) {
    h.setPersonName(text);
    return;
  }

  // Organization name — has a corporate suffix OR the "[ACRONYM]
  // [Region]" regulatory-body shape.
  if (CORP_SUFFIX_RE.test(text) || REGION_SUFFIX_RE.test(text)) {
    h.setOrganizationName(text);
    return;
  }

  // Otherwise treat as an address line if it looks address-shaped.
  if (looksLikeAddressLine(text)) {
    h.pushAddressLine(text);
    return;
  }
}

function looksLikeAddressLine(text: string): boolean {
  if (text.length < 3 || text.length > 200) return false;
  // Reject anything with a currency amount (invoice body line).
  if (/[\$€£]|\bCA\$|\bUS\$/.test(text)) return false;
  // Accept street-shaped lines (number leading OR suite/unit leading).
  if (STREET_LEADER.test(text)) return true;
  if (SUITE_PREFIX.test(text)) return true;
  // Accept city / province / postal one-liners.
  if (CA_POSTAL_LOOSE.test(text) || US_ZIP.test(text)) return true;
  // Country names alone.
  if (/^(?:Canada|United\s*States|USA|U\.S\.A\.?)$/i.test(text)) return true;
  // Multi-word capitalised phrase that isn't a person name — accept
  // as address filler (city / province).
  if (/^[A-Z][A-Za-z .'\-]{2,60}$/.test(text) && !PERSON_WITH_CREDENTIAL_RE.test(text)) return true;
  return false;
}
