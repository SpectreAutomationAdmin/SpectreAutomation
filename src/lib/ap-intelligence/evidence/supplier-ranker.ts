// Sprint 3 · Post-16H Phase 4 Slice 3 (2026-08-06) — supplier
// ranker v2. Founder rule §3: replace single-signal supplier
// selection with SCORED multi-evidence composition.
//
// Design principles:
//   * Every candidate carries a set of positive + negative
//     signals, each contributing a bounded weight.
//   * No single signal can dominate — the top score must beat
//     runners-up by a margin, otherwise abstention is preferred
//     over guessing.
//   * The ranker is a pure function over already-extracted
//     text-anchored candidates. It does NOT re-extract text —
//     upstream extractors provide the candidate pool.
//   * Negative signals subtract from a candidate's score so a
//     "Coulee Ridge" candidate that is ALSO a recipient-block
//     line cannot win regardless of how strong its positive
//     signals look in isolation.

export type SupplierSignal =
  // ---- positive ----
  | "HEADER_POSITION"          // first N lines of the document
  | "TOP_OF_PAGE"              // first 5% of the page height (when positioned text available)
  | "ORG_NAME_SHAPE"           // has a canonical corporate suffix (Inc / Ltd / LLC / Corp)
  | "ADDRESS_ADJACENT"         // immediately followed by an address block
  | "WEBSITE_DOMAIN"           // has a web address / www. line nearby
  | "EMAIL_DOMAIN"             // sender / support email domain match
  | "PHONE_ADJACENT"           // has a phone line nearby (weaker)
  | "TAX_REGISTRATION_OWNER"   // GST/HST/EIN registered to the same block
  | "REMITTANCE_IDENTITY"      // appears in "Remit to:" block
  | "REPEATED_ACROSS_PAGES"    // shows up on ≥2 pages (multi-page docs)
  | "PROVIDER_EXTRACTED_ROLE"  // Textract / provider identified as VENDOR / SUPPLIER
  | "FONT_PROMINENCE"          // positioned-text: font-size > body average

  // ---- negative ----
  | "BILL_TO_PROXIMITY"        // appears within the bill-to / sold-to block
  | "SHIP_TO_ROLE"             // marked ship-to / service-location
  | "TABLE_HEADING"            // matches known table-heading vocabulary
  | "GENERIC_FIELD_LABEL"      // is a bare label word ("Invoice", "Description", "Number")
  | "PERSON_ONLY"              // looks like a person's name (First Last, no org suffix)
  | "PRODUCT_DESCRIPTION"      // matches product-line heuristics
  | "PAGE_FOOTER"              // in the last 5% of a page
  | "DOCUMENT_TITLE"           // is a title word ("INVOICE", "FACTURE", "STATEMENT")
  | "CUSTOMER_LABEL"           // preceded by CUSTOMER / MEMBER / ACCOUNT HOLDER
  ;

const POSITIVE_WEIGHT: Record<string, number> = {
  HEADER_POSITION: 20,
  TOP_OF_PAGE: 12,
  ORG_NAME_SHAPE: 25,
  ADDRESS_ADJACENT: 18,
  WEBSITE_DOMAIN: 10,
  EMAIL_DOMAIN: 10,
  PHONE_ADJACENT: 6,
  TAX_REGISTRATION_OWNER: 22,
  REMITTANCE_IDENTITY: 20,
  REPEATED_ACROSS_PAGES: 15,
  PROVIDER_EXTRACTED_ROLE: 25,
  FONT_PROMINENCE: 8,
};

const NEGATIVE_WEIGHT: Record<string, number> = {
  BILL_TO_PROXIMITY: 45,        // strong — dominant refutation
  SHIP_TO_ROLE: 35,
  TABLE_HEADING: 40,
  GENERIC_FIELD_LABEL: 40,
  PERSON_ONLY: 20,
  PRODUCT_DESCRIPTION: 30,
  PAGE_FOOTER: 15,
  DOCUMENT_TITLE: 45,
  CUSTOMER_LABEL: 40,
};

export interface RankableSupplierCandidate {
  value: string;
  positive: SupplierSignal[];
  negative: SupplierSignal[];
  /** Optional prior confidence from the source extractor (0..100). */
  prior?: number;
  /** Free-form provenance for diagnostics — safe to log. */
  provenance?: string;
}

export interface RankedSupplier extends RankableSupplierCandidate {
  score: number;
  positiveWeight: number;
  negativeWeight: number;
  survivedNegatives: boolean;
}

export interface SupplierRankResult {
  winner: RankedSupplier | null;
  ranked: RankedSupplier[];
  /** True when the top score does not beat the runner-up by the
   *  margin threshold. In that case the ranker prefers
   *  abstention — the caller should surface a low-confidence /
   *  workflow-review outcome rather than pick a marginal winner. */
  ambiguous: boolean;
  /** The margin (top − runnerUp). Zero for single-candidate pools. */
  margin: number;
}

const WIN_MARGIN_THRESHOLD = 15;

/**
 * Rank supplier candidates. Every candidate is scored:
 *
 *     score = prior/2 + Σ positive − Σ negative
 *
 * where prior contributes at most 50 points, positives are summed
 * from POSITIVE_WEIGHT, and negatives are summed from
 * NEGATIVE_WEIGHT.  A negative sum that exceeds the positive sum
 * marks the candidate as `survivedNegatives = false` — those
 * candidates remain in the ranked list for diagnostics but are
 * excluded from winning.
 *
 * When the top surviving score does not beat the runner-up by
 * WIN_MARGIN_THRESHOLD points, `ambiguous = true` and the caller
 * should defer to abstention.
 */
export function rankSuppliers(candidates: RankableSupplierCandidate[]): SupplierRankResult {
  const ranked: RankedSupplier[] = candidates.map((c) => {
    const positiveWeight = c.positive.reduce((a, s) => a + (POSITIVE_WEIGHT[s] ?? 0), 0);
    const negativeWeight = c.negative.reduce((a, s) => a + (NEGATIVE_WEIGHT[s] ?? 0), 0);
    // Sprint 3 · Post-16H Phase 4 Slice 3-hotfix (2026-08-06) —
    // stronger prior weighting so a candidate the legacy extractor
    // already picked with high confidence cannot be cheaply
    // overturned by a handful of context signals on a rival
    // candidate. Founder §3: "Do not let one weak signal defeat
    // several contradictory signals." Applied symmetrically —
    // a strong legacy pick has genuine weight; the ranker's job
    // is to REFINE not to REPLACE without strong reason.
    const priorContribution = Math.min(100, Math.max(0, (c.prior ?? 0) * 0.8));
    const score = priorContribution + positiveWeight - negativeWeight;
    // Sprint 3 · Post-16H Phase 4 Slice 3 (2026-08-06) — VETO
    // negatives. Some signals are semantic disqualifications: a
    // BILL_TO_PROXIMITY / TABLE_HEADING / DOCUMENT_TITLE /
    // CUSTOMER_LABEL / SHIP_TO_ROLE candidate CANNOT be the
    // supplier regardless of how strong its other positives look.
    const VETO: SupplierSignal[] = [
      "BILL_TO_PROXIMITY",
      "TABLE_HEADING",
      "DOCUMENT_TITLE",
      "CUSTOMER_LABEL",
      "SHIP_TO_ROLE",
    ];
    const vetoed = c.negative.some((s) => VETO.includes(s));
    // Sprint 3 · Post-16H Phase 4 Slice 3-hotfix (2026-08-06) —
    // extra hard-veto for line-item contamination. A supplier
    // candidate that CONTAINS a money-shaped token (e.g. "Annual
    // membership dues — 2026 renewal      1420.50") is a line-item
    // description that leaked into the candidate pool. Organizations
    // do not embed prices in their name.
    const hasMoney = /-?\d{1,3}(?:,\d{3})*\.\d{2}\b|-?\d+\.\d{2}\b/.test(c.value);
    return {
      ...c,
      score,
      positiveWeight,
      negativeWeight,
      survivedNegatives: !vetoed && !hasMoney && negativeWeight <= positiveWeight,
    };
  });
  ranked.sort((a, b) => b.score - a.score);

  const survivors = ranked.filter((r) => r.survivedNegatives);
  const winner = survivors[0] ?? null;
  const runnerUp = survivors[1] ?? null;
  const margin = winner && runnerUp ? winner.score - runnerUp.score : winner ? winner.score : 0;
  const ambiguous = !winner || (runnerUp != null && margin < WIN_MARGIN_THRESHOLD);

  return { winner, ranked, ambiguous, margin };
}

/**
 * Convenience — classify a raw candidate string against a known
 * document text so callers that don't yet have full evidence-graph
 * awareness can bootstrap. Returns positive + negative signals
 * derivable from context.
 */
export function deriveSignals(candidate: string, opts: {
  text: string;
  lineIndex?: number;
  totalLines?: number;
  senderDomain?: string;
}): { positive: SupplierSignal[]; negative: SupplierSignal[] } {
  const positive: SupplierSignal[] = [];
  const negative: SupplierSignal[] = [];
  const lines = opts.text.split(/\r?\n/);
  const idx = opts.lineIndex ?? lines.findIndex((l) => l.includes(candidate));
  const totalLines = opts.totalLines ?? lines.length;

  // ---- header position (top 20 %) ----
  if (idx >= 0 && idx < Math.ceil(totalLines * 0.2)) positive.push("HEADER_POSITION");
  // ---- footer (bottom 5 %) ----
  if (idx >= 0 && idx > Math.floor(totalLines * 0.95)) negative.push("PAGE_FOOTER");
  // ---- org-name shape ----
  if (/\b(Inc|Corp(?:oration)?|Ltd|Limited|LLC|LLP|LP|ULC|PLC|Company|Co\.|GmbH|AG|SA|BV|NV)\.?$/i.test(candidate.trim())) {
    positive.push("ORG_NAME_SHAPE");
  }
  // ---- address adjacent (next 3 lines look address-ish) ----
  if (idx >= 0 && idx + 1 < lines.length) {
    const tail = lines.slice(idx + 1, idx + 4).join(" ");
    if (/\d{1,5}\s+[A-Z][A-Za-z\-.'\s]+\s+(?:Rd|Road|St|Street|Ave|Avenue|Blvd|Boulevard|Way|Highway|Hwy|Drive|Dr|Lane|Ln)/i.test(tail)) {
      positive.push("ADDRESS_ADJACENT");
    }
  }
  // ---- website / email ----
  if (idx >= 0) {
    const context = lines.slice(Math.max(0, idx - 1), idx + 4).join(" ");
    if (/\bwww\.[a-z0-9\-]+\.[a-z]{2,}\b/i.test(context)) positive.push("WEBSITE_DOMAIN");
    if (/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(context)) positive.push("EMAIL_DOMAIN");
  }
  // ---- email-domain match with sender ----
  if (opts.senderDomain) {
    const norm = candidate.toLowerCase().replace(/\s+/g, "");
    const dom = opts.senderDomain.split(".")[0]?.toLowerCase();
    if (dom && norm.includes(dom)) positive.push("EMAIL_DOMAIN");
  }
  // ---- tax registration owner ----
  if (idx >= 0) {
    const tailCtx = lines.slice(idx, idx + 5).join("\n");
    if (/\b(GST|HST|TPS|Business\s*Number|BN|Tax\s*Reg(?:istration)?)\s*[:#]?\s*\d/i.test(tailCtx)) {
      positive.push("TAX_REGISTRATION_OWNER");
    }
  }
  // ---- remittance identity ----
  if (idx >= 0) {
    const remit = lines.slice(Math.max(0, idx - 2), Math.min(lines.length, idx + 3)).join("\n");
    if (/\bRemit\s+to\b/i.test(remit)) positive.push("REMITTANCE_IDENTITY");
  }

  // ---- negative signals ----
  const upper = candidate.toUpperCase();
  const bareUpper = candidate.trim().toUpperCase();
  const TABLE_HEADINGS = new Set([
    "DESCRIPTION", "ITEM", "QTY", "QUANTITY", "QUANTITÉ", "AMOUNT", "MONTANT",
    "PRICE", "RATE", "UNIT", "PRIX", "PRODUIT", "PRODUCT", "SKU", "TOTAL",
  ]);
  if (TABLE_HEADINGS.has(bareUpper)) negative.push("TABLE_HEADING");
  const DOCUMENT_TITLES = new Set([
    "INVOICE", "FACTURE", "STATEMENT", "BILL", "CREDIT MEMO", "CREDIT NOTE",
    "RECEIPT", "QUOTE", "QUOTATION", "STATEMENT OF ACCOUNT",
  ]);
  if (DOCUMENT_TITLES.has(bareUpper)) negative.push("DOCUMENT_TITLE");
  const GENERIC_LABELS = new Set([
    "NUMBER", "NO", "REF", "REFERENCE", "DATE", "DUE", "SUBTOTAL", "TAX",
    "SUB TOTAL", "GRAND TOTAL", "TERMS", "PAGE", "PAID",
  ]);
  if (GENERIC_LABELS.has(bareUpper)) negative.push("GENERIC_FIELD_LABEL");
  // Bill-to proximity — candidate line follows a BILL TO / SOLD TO / SHIP TO label.
  if (idx > 0) {
    const prev = (lines[idx - 1] ?? "").trim().toUpperCase();
    if (/^(BILL\s*TO|SOLD\s*TO|SHIP\s*TO|CUSTOMER|CLIENT|ACCOUNT\s*HOLDER)[:\s]*$/.test(prev)) {
      negative.push("BILL_TO_PROXIMITY");
    }
    if (/^SHIP\s*TO/.test(prev)) negative.push("SHIP_TO_ROLE");
    if (/^(CUSTOMER|MEMBER|ACCOUNT\s*HOLDER)/.test(prev)) negative.push("CUSTOMER_LABEL");
  }
  // Person-only shape ("First Last" with no org suffix).
  if (
    /^[A-Z][a-z]+\s+[A-Z][a-z]+$/.test(candidate.trim())
    && !positive.includes("ORG_NAME_SHAPE")
  ) {
    negative.push("PERSON_ONLY");
  }
  // Product-description shape — starts with a lowercase modifier or has typical product tokens.
  if (/^[a-z]/.test(candidate) && /\b(low\-sulphur|biodegradable|premium|granular|liquid|tote|barrel|litre|kg|lb)\b/i.test(upper)) {
    negative.push("PRODUCT_DESCRIPTION");
  }

  return { positive, negative };
}
