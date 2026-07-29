// Sprint 3 · Checkpoint 15T (2026-07-28) — shared document-layout
// association layer.
//
// Founder rule (15T §1): the extractors must associate labels to
// values, descriptions to amounts, tax labels to tax amounts,
// identifiers to values, using:
//   * same-line evidence;
//   * nearby forward and backward lines;
//   * page boundaries;
//   * coordinates or layout positions where available;
//   * arithmetic reconciliation;
//   * candidate exclusivity and conflict resolution.
//
// Every extractor now consumes this model instead of scanning the raw
// text with a bespoke regex. Bidirectional search is the default —
// pdf-parse frequently places labels after their values (the CPA
// "INVOICE TOTAL" label appears BELOW the printed total).
//
// This module is deterministic, side-effect free, and knows nothing
// about vendor identity. It classifies lines by SHAPE only.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LineKind =
  | "BARE_AMOUNT"           // "$40.50", "CA$1.92", "-CA$1.60", "$1,360.00"
  | "LABEL_ONLY"            // "SUBTOTAL", "GST/HST", "INVOICE TOTAL", "Statement number"
  | "LABEL_WITH_AMOUNT"     // "Subtotal: $1,360.00"
  | "DESCRIPTION"           // human-readable text (candidate line-item description)
  | "SECTION_HEADER"        // ALL-CAPS or heading-style ("Charges", "Summary")
  | "ADDRESS_LIKE"          // "24-15 ASPENMONT HTS SW", "Suite 800"
  | "DATE_LIKE"             // "07/28/2026", "2026-07-28", "July 28, 2026"
  | "IDENTIFIER"            // "OXIO-23375874", "1007565767"
  | "TAX_REGISTRATION"      // "GST 817930498", "234567891RT0001"
  | "ACCOUNT_NUMBER"        // "Your account number: 00108064"
  | "BLANK"                 // empty after trim
  | "OTHER";

export interface DocumentLine {
  index: number;              // 0-based line index in the source text
  raw: string;                // original line, no trim
  text: string;               // trimmed line
  kind: LineKind;
  // The trailing currency-shaped amount, if any (parsed value + raw token).
  trailingAmount: null | { raw: string; value: number; negative: boolean };
  // The bare amount if the entire line IS an amount ("$40.50" / "CA$1.92" / "-CA$1.60").
  bareAmount: null | { raw: string; value: number; negative: boolean };
}

export interface DocumentLayout {
  raw: string;
  lines: DocumentLine[];
}

// A single label → value association result.
export interface LabelValueMatch {
  label: string;              // the matched label
  labelLineIndex: number;
  value: string;              // the associated value (raw)
  valueLineIndex: number;
  amount: number | null;      // when value is currency, parsed as number
  strategy:
    | "same_line"
    | "forward_line"
    | "backward_line"
    | "arithmetic_reconciled";
  confidence: number;         // 0..100
  // Number of intervening non-blank lines between label and value
  // (0 = adjacent). Higher distance → lower confidence.
  distance: number;
  ruleKey: string;
}

// A description → amount pair produced by the layout layer.
export interface DescAmountMatch {
  description: string;
  descriptionLineIndex: number;
  amount: number;
  amountRaw: string;
  amountLineIndex: number;
  strategy: "same_line" | "forward_line";
  confidence: number;
  negative: boolean;
}

// ---------------------------------------------------------------------------
// Line classifiers
// ---------------------------------------------------------------------------

// Currency-token regex — captures optional sign, currency prefix,
// digits with thousands separators, optional decimal.
const CURRENCY_TOKEN_RE = /(-?)\s*(?:CA\$|US\$|[\$€£])\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2}))/;
// A signed / prefix-optional amount at the tail of a line — accepts
// bare "$40.50" and also allows "-CA$1.60".
const TRAILING_AMOUNT_RE = /([-+]?\s*(?:CA\$|US\$|[\$€£])?\s*[0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[-+]?\s*(?:CA\$|US\$|[\$€£])?\s*[0-9]+\.[0-9]{2})\s*$/;
// A line whose ENTIRE non-whitespace content is a currency amount.
// Sprint 3 · Checkpoint 15T — REQUIRES either a currency prefix
// (CA$/US$/$/€/£) OR a decimal component. Without this guard, a
// pure-digit invoice number ("1007565767") would classify as
// BARE_AMOUNT and pollute both money extraction and the payable-
// reference fallback.
const BARE_AMOUNT_RE = /^\s*([-+]?\s*(?:CA\$|US\$|[\$€£])\s*[0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[-+]?\s*(?:CA\$|US\$|[\$€£])?\s*[0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{1,2}|[-+]?\s*(?:CA\$|US\$|[\$€£])?\s*[0-9]+\.[0-9]{1,2})\s*$/;

// A leading label with a colon / dash / equals separator.
const LABEL_SEPARATOR_RE = /^([A-Za-z][A-Za-z0-9 /()\-#.&']{1,40})\s*[:=\-#]\s*/;

// Address-like lines: leading number + street, or Suite/Unit/Apt/PO prefix.
const ADDRESS_RE = /^\s*(?:\d+\s+[A-Za-z]|Suite\b|Unit\b|Apt\b|Bldg\b|Floor\b|PO\s+Box\b|P\.O\.?\s+Box\b|\d+\s*[-\/]\s*\d+\s+[A-Za-z])/i;
// Sprint 3 · Checkpoint 15T — require whitespace between parts so
// a single all-caps word ("SUBTOTAL") is not misclassified as a
// city/state/postal-code line.
const CITY_STATE_POSTAL_RE = /[A-Z]{2}\s+[A-Z0-9]{3}\s+[A-Z0-9]{3}/;

// Date-like lines.
const DATE_RE = /\b\d{4}[-\/]\d{1,2}[-\/]\d{1,2}\b|\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,?\s+\d{4})?\b/i;

// Identifier-like lines: DASH-separated alphanumeric, e.g. OXIO-23375874,
// A-20260714, INV-00123. Sprint 3 · Checkpoint 15T — also match a
// pure digit string (5-15 chars) that is neither a currency amount
// (BARE_AMOUNT check runs first) nor a date. This lets the payable-
// reference forward scan pick up an invoice number that appears on
// its own line ("Invoice #:" on line N, "1007565767" on line N+1).
const IDENTIFIER_RE = /^[A-Z]{2,10}-[A-Z0-9]{4,20}$|^[A-Z]{2,5}\s*[-#]?\s*\d{4,15}$|^\d{5,15}$/i;

// Tax registration numbers — Canadian BN (9 digits + optional RT0001)
// or US EIN (nn-nnnnnnn). Includes standalone "GST 817930498" pattern.
const TAX_REG_RE = /\b(?:GST|HST|BN|VAT|EIN|Business\s+Number|Tax\s*(?:Registration|ID|Reg))\b\s*[:#]?\s*(?:\d{9}(?:RT\d{4})?|\d{2}-\d{7})\b/i;
const TAX_REG_INLINE_RE = /^(?:GST|HST|VAT|BN)\s+\d{9}(?:RT\d{4})?$/i;

// Account / member / customer number lines — "Your account number: X",
// "Member number 1006061".
const ACCOUNT_NUMBER_RE = /^(?:Your\s+)?(?:account|member|customer|client)\s+(?:number|no\.?|#|id)\s*[:#]?\s*\S/i;

// Section header — short ALL-CAPS line without an amount.
function looksSectionHeader(text: string): boolean {
  if (text.length < 3 || text.length > 40) return false;
  const letters = text.replace(/[^A-Za-z]/g, "");
  if (letters.length < 3) return false;
  const upperRatio = (text.match(/[A-Z]/g) ?? []).length / Math.max(1, letters.length);
  if (upperRatio < 0.8) return false;
  return !TRAILING_AMOUNT_RE.test(text);
}

// Description candidate — must contain enough letters + not look like an
// address / date / identifier / tax-reg. Kept permissive; excluded by
// later filters when consumed.
function looksDescription(text: string): boolean {
  if (text.length < 3) return false;
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  if (letters < 3) return false;
  if (letters / text.length < 0.35) return false;
  return true;
}

function parseCurrencyToken(raw: string): { value: number; negative: boolean } | null {
  const cleaned = raw.replace(/\s+/g, "");
  const negative = cleaned.startsWith("-");
  const stripped = cleaned.replace(/^[-+]/, "").replace(/(?:CA\$|US\$|[\$€£])/, "").replace(/,/g, "");
  if (!stripped) return null;
  const n = Number(stripped);
  if (!Number.isFinite(n)) return null;
  return { value: negative ? -Math.abs(n) : n, negative };
}

// ---------------------------------------------------------------------------
// Layout parser
// ---------------------------------------------------------------------------

export function parseDocumentLayout(text: string): DocumentLayout {
  const rawLines = text.split(/\r?\n/);
  const lines: DocumentLine[] = rawLines.map((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      return { index, raw, text: trimmed, kind: "BLANK", trailingAmount: null, bareAmount: null };
    }

    // Bare amount check comes first — highest specificity.
    const bareMatch = trimmed.match(BARE_AMOUNT_RE);
    if (bareMatch) {
      const parsed = parseCurrencyToken(bareMatch[1]);
      if (parsed) {
        return {
          index, raw, text: trimmed, kind: "BARE_AMOUNT",
          trailingAmount: { raw: bareMatch[1].trim(), value: parsed.value, negative: parsed.negative },
          bareAmount: { raw: bareMatch[1].trim(), value: parsed.value, negative: parsed.negative },
        };
      }
    }

    // Trailing amount — attached to a longer line.
    const trailingMatch = trimmed.match(TRAILING_AMOUNT_RE);
    const trailingAmount = trailingMatch
      ? (() => {
          const parsed = parseCurrencyToken(trailingMatch[1]);
          return parsed ? { raw: trailingMatch[1].trim(), value: parsed.value, negative: parsed.negative } : null;
        })()
      : null;

    // Tax registration check comes early — always classified as such.
    if (TAX_REG_RE.test(trimmed) || TAX_REG_INLINE_RE.test(trimmed)) {
      return { index, raw, text: trimmed, kind: "TAX_REGISTRATION", trailingAmount, bareAmount: null };
    }

    if (ACCOUNT_NUMBER_RE.test(trimmed)) {
      return { index, raw, text: trimmed, kind: "ACCOUNT_NUMBER", trailingAmount, bareAmount: null };
    }

    if (ADDRESS_RE.test(trimmed) || CITY_STATE_POSTAL_RE.test(trimmed)) {
      return { index, raw, text: trimmed, kind: "ADDRESS_LIKE", trailingAmount, bareAmount: null };
    }

    if (DATE_RE.test(trimmed) && !trailingAmount) {
      return { index, raw, text: trimmed, kind: "DATE_LIKE", trailingAmount: null, bareAmount: null };
    }

    // Standalone identifier line ("OXIO-23375874", "1007565767").
    if (IDENTIFIER_RE.test(trimmed)) {
      return { index, raw, text: trimmed, kind: "IDENTIFIER", trailingAmount: null, bareAmount: null };
    }

    if (trailingAmount) {
      // Does the leading portion look like a label with a separator?
      if (LABEL_SEPARATOR_RE.test(trimmed)) {
        return { index, raw, text: trimmed, kind: "LABEL_WITH_AMOUNT", trailingAmount, bareAmount: null };
      }
      // Otherwise treat as description with attached amount.
      return { index, raw, text: trimmed, kind: "LABEL_WITH_AMOUNT", trailingAmount, bareAmount: null };
    }

    if (looksSectionHeader(trimmed)) {
      return { index, raw, text: trimmed, kind: "SECTION_HEADER", trailingAmount: null, bareAmount: null };
    }

    if (looksDescription(trimmed)) {
      // Label-only vs description-only: a short line (≤ 40 chars) that
      // matches known label vocabulary is LABEL_ONLY; otherwise DESCRIPTION.
      if (trimmed.length <= 40) {
        // Anything looking like a "Total", "Subtotal", "Tax" — mark as LABEL_ONLY.
        // Actual matching to specific labels is done in the association pass.
        return { index, raw, text: trimmed, kind: "LABEL_ONLY", trailingAmount: null, bareAmount: null };
      }
      return { index, raw, text: trimmed, kind: "DESCRIPTION", trailingAmount: null, bareAmount: null };
    }

    return { index, raw, text: trimmed, kind: "OTHER", trailingAmount: null, bareAmount: null };
  });

  return { raw: text, lines };
}

// ---------------------------------------------------------------------------
// Label → value association
// ---------------------------------------------------------------------------

export interface AssociateLabelValueOpts {
  labels: string[];           // e.g. ["Subtotal", "Sub Total", "Net"]
  ruleKeyBase: string;        // e.g. "subtotal"
  // Preferred value kind: "amount" (currency), or "text" (any non-blank).
  valueKind: "amount" | "text";
  // Maximum forward / backward line distance to scan for the value.
  forwardMaxLines?: number;   // default 4
  backwardMaxLines?: number;  // default 0 (only enabled when explicitly requested)
  // Lines that would DISQUALIFY a value from being paired — e.g. when
  // searching for "Invoice Number" value, an identifier is fine but a
  // BARE_AMOUNT is not.
  skipKinds?: LineKind[];
  // Sprint 3 · Checkpoint 15T — line indices already consumed by a
  // description→amount pair. The label→value scan MUST skip these so
  // e.g. SUBTOTAL doesn't grab the amount that already belongs to
  // "Support Program / HST $25.00".
  consumedLineIndices?: Set<number>;
}

const DEFAULT_SKIP_KINDS: LineKind[] = ["BLANK"];

// Sprint 3 · Checkpoint 15T — recognised summary-label vocabulary
// used to determine when a scan should HALT because another labelled
// section has begun. Distinguishes "SUBTOTAL" (halt) from
// "Support Program / HST" (arbitrary description — do not halt).
// Identical to DEFAULT_EXCLUDE_SUMMARY_LABELS (declared later);
// keep them in sync.
const SUMMARY_LABEL_HALT_RE =
  /^\s*(?:sub[-\s]?total|total(?:\s+(?:amount(?:\s+due)?|due))?|invoice\s+total|balance(?:\s+due|\s+owing)?|amount\s+(?:due|enclosed|owed)|payment|please\s+remit|make\s+cheque|GST|HST|VAT|QST|PST|GST\/HST|HST\/GST|GST\s*\/\s*HST|sales\s+tax|tax\s+total|tax(?:es)?\/fees?|taxes?\s*(?:and|&)\s*fees|taxes|tax|shipping|handling|charges?|discount|credits?|ongoing\s+charges|pending\s+payments|previous\s+balance|new\s+charges|thank\s+you)\s*[:%]?\s*$/i;

export function associateLabelValue(
  layout: DocumentLayout,
  opts: AssociateLabelValueOpts,
): LabelValueMatch | null {
  const forwardMax = opts.forwardMaxLines ?? 4;
  const backwardMax = opts.backwardMaxLines ?? 0;
  const skipKinds = new Set([...DEFAULT_SKIP_KINDS, ...(opts.skipKinds ?? [])]);
  const labelPattern = buildLabelPattern(opts.labels);
  const consumed = opts.consumedLineIndices ?? new Set<number>();
  // Value gate — whether a candidate line qualifies.
  const valueGate = (line: DocumentLine): boolean => {
    if (consumed.has(line.index)) return false;
    if (skipKinds.has(line.kind)) return false;
    if (opts.valueKind === "amount") {
      return line.bareAmount != null;
    }
    // text: identifier, description, or short label-like line
    if (line.kind === "IDENTIFIER") return true;
    if (line.kind === "DESCRIPTION") return true;
    if (line.kind === "LABEL_ONLY" && line.text.length <= 60) return true;
    if (line.kind === "OTHER" && line.text.length >= 2) return true;
    return false;
  };

  const isAnotherLabelLine = (line: DocumentLine): boolean => {
    // Only lines whose text is a KNOWN summary label vocabulary
    // count as a halt-boundary. Arbitrary short description-like
    // lines ("Support Program / HST") do NOT halt the scan.
    // Includes SECTION_HEADER because all-caps summary labels
    // ("GST/HST") classify as SECTION_HEADER, not LABEL_ONLY.
    if (line.kind !== "LABEL_ONLY" && line.kind !== "LABEL_WITH_AMOUNT" && line.kind !== "SECTION_HEADER") return false;
    return SUMMARY_LABEL_HALT_RE.test(line.text);
  };

  // Pass 1: same-line label + trailing value.
  for (const line of layout.lines) {
    const m = line.text.match(labelPattern);
    if (!m) continue;
    // Same-line label with trailing amount / value:
    if (opts.valueKind === "amount" && line.trailingAmount) {
      // Guard: the trailing amount must be AFTER the label — the label
      // itself should occupy the start of the line.
      const labelStart = m.index ?? 0;
      if (labelStart <= 5) {
        return {
          label: m[0].trim(),
          labelLineIndex: line.index,
          value: line.trailingAmount.raw,
          valueLineIndex: line.index,
          amount: line.trailingAmount.value,
          strategy: "same_line",
          confidence: 92,
          distance: 0,
          ruleKey: `${opts.ruleKeyBase}.same_line`,
        };
      }
    }
    if (opts.valueKind === "text") {
      // Look for label + separator + text on same line, e.g. "Invoice #: 1007565767"
      const separator = line.text.match(new RegExp(`^\\s*(?:${escapeLabelsForRegex(opts.labels)})\\s*[:#=\\-]\\s*(\\S.{0,60}\\S)\\s*$`, "i"));
      if (separator && separator[1]) {
        return {
          label: m[0].trim(),
          labelLineIndex: line.index,
          value: separator[1].trim(),
          valueLineIndex: line.index,
          amount: null,
          strategy: "same_line",
          confidence: 92,
          distance: 0,
          ruleKey: `${opts.ruleKeyBase}.same_line`,
        };
      }
    }
  }

  // Pass 2: label alone, scan forward for a value.
  for (const line of layout.lines) {
    const m = line.text.match(labelPattern);
    if (!m) continue;
    if (line.trailingAmount) continue; // covered by same-line pass
    // Look forward, skipping BLANK and (for amount lookups) other labels
    // that would introduce ambiguity.
    let distance = 0;
    for (let j = line.index + 1; j < layout.lines.length && distance <= forwardMax; j++) {
      const cand = layout.lines[j];
      if (cand.kind === "BLANK") continue;
      distance++;
      if (skipKinds.has(cand.kind)) continue;
      if (opts.valueKind === "amount" && isAnotherLabelLine(cand) && !cand.trailingAmount) {
        // Another naked label appeared before our value — halt the
        // forward scan to preserve candidate exclusivity (each label
        // owns the FIRST value after it).
        break;
      }
      if (valueGate(cand)) {
        const amount = opts.valueKind === "amount" ? (cand.bareAmount?.value ?? null) : null;
        return {
          label: m[0].trim(),
          labelLineIndex: line.index,
          value: opts.valueKind === "amount" ? (cand.bareAmount?.raw ?? cand.text) : cand.text,
          valueLineIndex: cand.index,
          amount,
          strategy: "forward_line",
          confidence: distance === 1 ? 85 : distance === 2 ? 72 : distance === 3 ? 58 : 45,
          distance,
          ruleKey: `${opts.ruleKeyBase}.forward_line_${distance}`,
        };
      }
    }
  }

  // Pass 3 (opt-in): label alone, scan backward for a value.
  // Enabled for totals that appear before their label (e.g. the
  // founder-observed payment-stub layout where the printed total is
  // above and its "INVOICE TOTAL" label is at the bottom).
  //
  // Unlike the forward scan we do NOT halt on intervening summary
  // labels — a "Total" label at the bottom of the doc is naturally
  // separated from its own printed value by SUBTOTAL / TAX / etc.
  // We rely on `consumedLineIndices` (populated by earlier subtotal
  // / tax extractions and by description→amount pairing) to prevent
  // the total from grabbing an amount that already belongs to a
  // different label.
  if (backwardMax > 0) {
    for (const line of layout.lines) {
      const m = line.text.match(labelPattern);
      if (!m) continue;
      if (line.trailingAmount) continue;
      let distance = 0;
      for (let j = line.index - 1; j >= 0 && distance <= backwardMax; j--) {
        const cand = layout.lines[j];
        if (cand.kind === "BLANK") continue;
        distance++;
        if (skipKinds.has(cand.kind)) continue;
        if (valueGate(cand)) {
          const amount = opts.valueKind === "amount" ? (cand.bareAmount?.value ?? null) : null;
          return {
            label: m[0].trim(),
            labelLineIndex: line.index,
            value: opts.valueKind === "amount" ? (cand.bareAmount?.raw ?? cand.text) : cand.text,
            valueLineIndex: cand.index,
            amount,
            strategy: "backward_line",
            confidence: distance === 1 ? 78 : distance === 2 ? 62 : 50,
            distance,
            ruleKey: `${opts.ruleKeyBase}.backward_line_${distance}`,
          };
        }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Description → amount pairing (line items)
// ---------------------------------------------------------------------------

export interface AssociateDescAmountOpts {
  forwardMaxLines?: number;   // default 2
  // Label vocabulary that must NOT be paired as a description.
  excludeSummaryLabels?: RegExp;
  // Additional per-line exclusion (return true to skip a candidate).
  excludeDescription?: (line: DocumentLine) => boolean;
  maxRows?: number;           // default 64
}

// Sprint 3 · Checkpoint 15T — consolidated vocabulary. Covers both
// bare rollup labels ("SUBTOTAL", "Ongoing charges") and full-form
// labels ("Total amount due", "Balance owing") that the founder-
// observed layouts print. Keep in sync with SUMMARY_LABEL_HALT_RE.
const DEFAULT_EXCLUDE_SUMMARY_LABELS =
  /^\s*(?:sub[-\s]?total|total(?:\s+(?:amount(?:\s+due)?|due))?|invoice\s+total|balance(?:\s+due|\s+owing)?|amount\s+(?:due|enclosed|owed)|payment|please\s+remit|make\s+cheque|GST|HST|VAT|QST|PST|GST\/HST|HST\/GST|GST\s*\/\s*HST|sales\s+tax|tax\s+total|tax(?:es)?\/fees?|taxes?\s*(?:and|&)\s*fees|taxes|tax|shipping|handling|charges?|discount|credits?|ongoing\s+charges|pending\s+payments|previous\s+balance|new\s+charges|thank\s+you)\s*[:%]?\s*$/i;

export function associateDescriptionAmounts(
  layout: DocumentLayout,
  opts: AssociateDescAmountOpts = {},
): DescAmountMatch[] {
  const out: DescAmountMatch[] = [];
  const forwardMax = opts.forwardMaxLines ?? 2;
  const excludeSummary = opts.excludeSummaryLabels ?? DEFAULT_EXCLUDE_SUMMARY_LABELS;
  const excludeDescription = opts.excludeDescription ?? (() => false);
  const maxRows = opts.maxRows ?? 64;
  const consumed = new Set<number>();

  const isValidDescription = (line: DocumentLine): boolean => {
    if (line.kind === "BLANK") return false;
    if (line.kind === "SECTION_HEADER") return false;
    if (line.kind === "ADDRESS_LIKE") return false;
    if (line.kind === "DATE_LIKE") return false;
    if (line.kind === "TAX_REGISTRATION") return false;
    if (line.kind === "ACCOUNT_NUMBER") return false;
    if (line.kind === "IDENTIFIER") return false;
    if (line.kind === "BARE_AMOUNT") return false;
    if (excludeSummary.test(line.text)) return false;
    if (line.text.length < 3 || line.text.length > 200) return false;
    if (!/[A-Za-z]{2,}/.test(line.text)) return false;
    if (excludeDescription(line)) return false;
    return true;
  };

  for (let i = 0; i < layout.lines.length && out.length < maxRows; i++) {
    if (consumed.has(i)) continue;
    const line = layout.lines[i];

    // Case A — same-line description + trailing amount.
    if (line.kind === "LABEL_WITH_AMOUNT" && line.trailingAmount) {
      const desc = line.text.slice(0, line.text.length - line.trailingAmount.raw.length).trim();
      // Strip trailing punctuation.
      const descCleaned = desc.replace(/[:\-\s]+$/, "");
      if (
        descCleaned.length >= 3
        && /[A-Za-z]{2,}/.test(descCleaned)
        && !excludeSummary.test(line.text)
        && !excludeSummary.test(descCleaned)
      ) {
        out.push({
          description: descCleaned,
          descriptionLineIndex: line.index,
          amount: Math.abs(line.trailingAmount.value),
          amountRaw: line.trailingAmount.raw,
          amountLineIndex: line.index,
          strategy: "same_line",
          confidence: 88,
          negative: line.trailingAmount.negative,
        });
        consumed.add(i);
      }
      continue;
    }

    // Case B — description-only line, scan forward for a bare amount.
    if (!isValidDescription(line)) continue;
    let distance = 0;
    for (let j = i + 1; j < layout.lines.length && distance <= forwardMax; j++) {
      const cand = layout.lines[j];
      if (cand.kind === "BLANK") continue;
      distance++;
      // If another VALID description appears first, halt — pairing must
      // stay adjacent.
      if (isValidDescription(cand)) break;
      // If a section header / label appears with its own trailing
      // amount, halt — we've hit a new labelled section.
      if (cand.kind === "LABEL_WITH_AMOUNT" && excludeSummary.test(cand.text)) break;
      // Sprint 3 · Checkpoint 15T — bare summary label (SUBTOTAL,
      // Ongoing charges, Credits, GST/HST) on its own line also
      // halts: the amount that follows belongs to the label, not
      // the earlier description. All-caps rollup labels ("GST/HST",
      // "SUBTOTAL") classify as SECTION_HEADER, not LABEL_ONLY, so
      // include that kind here too.
      if ((cand.kind === "LABEL_ONLY" || cand.kind === "DESCRIPTION" || cand.kind === "SECTION_HEADER") && excludeSummary.test(cand.text)) break;
      if (cand.kind === "BARE_AMOUNT" && cand.bareAmount) {
        out.push({
          description: line.text,
          descriptionLineIndex: line.index,
          amount: Math.abs(cand.bareAmount.value),
          amountRaw: cand.bareAmount.raw,
          amountLineIndex: cand.index,
          strategy: "forward_line",
          confidence: distance === 1 ? 82 : 65,
          negative: cand.bareAmount.negative,
        });
        consumed.add(i);
        consumed.add(j);
        break;
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildLabelPattern(labels: string[]): RegExp {
  const alt = escapeLabelsForRegex(labels);
  // Match at start-of-line (leading whitespace allowed). The label
  // itself must be followed by end-of-line OR a separator OR
  // whitespace-then-currency (in which case the trailing-amount check
  // will pick up the value).
  return new RegExp(`^\\s*(?:${alt})(?=\\s*(?:$|[:#=\\-(%]|\\s+(?:CA\\$|US\\$|[\\$€£]|\\d)))`, "i");
}

function escapeLabelsForRegex(labels: string[]): string {
  return labels
    .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"))
    .join("|");
}

// Utility — round a number to 2 decimals.
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
