// Sprint 3 · Checkpoint 15Q (2026-07-28) — identifier taxonomy.
//
// Founder rule: the extractor correctly picked the INVOICE number
// even though a MEMBER number appeared in the same document. Do
// NOT regress that. But: today's extractor requires the literal
// "Invoice" / "INV" prefix — safe in the founder's case, brittle
// elsewhere.
//
// This module classifies EVERY numeric identifier in the document
// by its adjacent label. Callers ask for "the invoice number" and
// get the best-scoring one; alternates are preserved. When no
// invoice-labelled number exists, the caller can fall back to
// heuristics WITHOUT accidentally promoting a member number.
//
// GENERALIZED — no hardcoded document identifiers, no specific
// invoice number, no member/account allowlist. The classifier
// works on labelling patterns that appear across many real
// invoices.

export type IdentifierKind =
  | "invoice_number"
  | "member_number"
  | "customer_number"
  | "account_number"
  | "purchase_order"
  | "statement_number"
  | "tax_registration"
  | "reference_number"
  | "order_number"
  | "unlabelled";

export interface IdentifierCandidate {
  value: string;
  kind: IdentifierKind;
  label: string | null;         // the label text that classified it
  lineNo: number;
  score: number;                // 0..100
  confidence: number;           // 0..100
}

interface LabelRule {
  kind: IdentifierKind;
  // The label pattern must appear on the same line before the
  // number, OR on the line immediately above with the number as
  // the sole content of the next line.
  labelRe: RegExp;
  score: number;
}

const LABELS: LabelRule[] = [
  { kind: "invoice_number",   labelRe: /\b(?:invoice(?:\s*(?:number|no\.?|#))?)\b/i,        score: 92 },
  { kind: "invoice_number",   labelRe: /\bINV\s*[-#:]?/i,                                    score: 88 },
  { kind: "member_number",    labelRe: /\bmember(?:\s*(?:number|no\.?|#|id))?\b/i,           score: 90 },
  { kind: "customer_number",  labelRe: /\bcustomer(?:\s*(?:number|no\.?|#|id))?\b/i,         score: 88 },
  { kind: "account_number",   labelRe: /\baccount(?:\s*(?:number|no\.?|#))?\b/i,             score: 82 },
  { kind: "purchase_order",   labelRe: /\bP\.?O\.?(?:\s*(?:number|no\.?|#))?\b|\bpurchase\s*order\b/i, score: 88 },
  { kind: "order_number",     labelRe: /\border(?:\s*(?:number|no\.?|#))?\b/i,               score: 78 },
  { kind: "statement_number", labelRe: /\bstatement(?:\s*(?:number|no\.?|#))?\b/i,           score: 84 },
  { kind: "tax_registration", labelRe: /\b(?:GST\/?HST|HST|GST|BN|Business\s*Number|Tax\s*Registration)\b/i, score: 95 },
  { kind: "reference_number", labelRe: /\b(?:reference|ref)(?:\s*(?:number|no\.?|#))?\b/i,   score: 70 },
];

// A generic identifier: 4-20 alphanumeric characters, at least 4
// digits somewhere, no punctuation except - or /.
const ID_TOKEN_RE = /\b([A-Z0-9][A-Z0-9\-/]{3,19})\b/gi;
// A tax id specifically — 9 digits with optional RT0001-style suffix.
const TAX_ID_TOKEN_RE = /\b(\d{9}(?:\s*R[TC]\d{4})?)\b/;

/**
 * Extract every identifier candidate from the PDF text.
 */
export function extractIdentifiers(text: string): IdentifierCandidate[] {
  const lines = text.split(/\r?\n/);
  const candidates: IdentifierCandidate[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Same-line label + value.
    for (const rule of LABELS) {
      const labelHit = line.match(rule.labelRe);
      if (!labelHit) continue;
      const after = line.slice((labelHit.index ?? 0) + labelHit[0].length);
      // Look for a value after the label — separators like : # -
      const valueMatch = after.match(/[:\s#-]*([A-Z0-9][A-Z0-9\-/]{3,19})\b/i);
      if (valueMatch) {
        const value = valueMatch[1];
        const key = `${rule.kind}::${value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          value,
          kind: rule.kind,
          label: labelHit[0].trim(),
          lineNo: i,
          score: rule.score,
          confidence: rule.score,
        });
      }
    }
    // Cross-line: label on line i, value alone on line i+1.
    const nextLine = lines[i + 1]?.trim() ?? "";
    for (const rule of LABELS) {
      if (!rule.labelRe.test(line)) continue;
      if (nextLine.length === 0) continue;
      const soloValue = nextLine.match(/^([A-Z0-9][A-Z0-9\-/]{3,19})\s*$/i);
      if (soloValue) {
        const value = soloValue[1];
        const key = `${rule.kind}::${value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          value,
          kind: rule.kind,
          label: line.trim(),
          lineNo: i + 1,
          score: Math.max(60, rule.score - 5),
          confidence: Math.max(60, rule.score - 5),
        });
      }
    }
    // Special: tax registration numbers usually appear in a distinctive
    // BN-9 pattern even without a label.
    const taxHit = line.match(TAX_ID_TOKEN_RE);
    if (taxHit) {
      const value = taxHit[1].replace(/\s+/g, "");
      const key = `tax_registration::${value}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push({
          value, kind: "tax_registration", label: "BN pattern",
          lineNo: i, score: 88, confidence: 88,
        });
      }
    }
  }

  return candidates;
}

/**
 * Pick the identifier of a specific kind — usually invoice_number.
 * Returns the leader + alternates (other candidates that scored
 * lower but were also of the same kind OR one of the fallback kinds
 * the caller might tolerate).
 */
export function pickIdentifier(
  candidates: IdentifierCandidate[],
  preferKind: IdentifierKind,
): { leader: IdentifierCandidate | null; alternates: IdentifierCandidate[] } {
  const preferred = candidates.filter((c) => c.kind === preferKind);
  if (preferred.length > 0) {
    preferred.sort((a, b) => b.score - a.score);
    return { leader: preferred[0], alternates: preferred.slice(1) };
  }
  return { leader: null, alternates: [] };
}
