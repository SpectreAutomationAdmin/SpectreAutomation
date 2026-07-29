// Sprint 3 · Checkpoint 15U (2026-07-28) — normalized token /
// phrase-similarity utilities used by the GL recommender.
//
// Deliberately deterministic. No LLM, no external service. Every
// input is normalized the same way; the same inputs always produce
// the same output. Numeric outputs are stable across JS engines.

// -----------------------------------------------------------------------------
// Text normalization
// -----------------------------------------------------------------------------

// Small stop-list — highly common English words that carry no
// accounting-domain signal. Deliberately conservative so we don't
// strip meaningful tokens ("service", "account", "fee" all kept).
const STOPWORDS = new Set([
  "a", "an", "and", "the", "or", "of", "for", "to", "in", "on",
  "at", "by", "with", "as", "is", "are", "was", "were", "be",
  "this", "that", "these", "those", "&",
]);

// Small suffix-stripping stemmer for accounting terms. Only removes
// endings that meaningfully change token identity ("subscriptions" →
// "subscription", "fees" → "fee"). Kept minimal on purpose.
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
  if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("es") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) return w.slice(0, -1);
  return w;
}

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[_/\-,.:;!?()\[\]{}"']+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(text: string): string[] {
  const normalized = normalize(text);
  if (!normalized) return [];
  return normalized
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t))
    .map(stem);
}

// -----------------------------------------------------------------------------
// Phrase matching against a synonym list
// -----------------------------------------------------------------------------

export interface PhraseMatch {
  // The synonym phrase from the concept catalog that matched (verbatim).
  matchedPhrase: string;
  // The evidence snippet from the input text that produced the match
  // (also normalized for reporting).
  matchedSnippet: string;
  // 0..100. 100 = full-phrase exact substring; lower = token-only match.
  strength: number;
  // Kind of match — used by callers to weight the evidence.
  kind: "exact_phrase" | "all_tokens_present" | "partial_tokens";
}

// Given a query text and a list of synonyms (each a natural-language
// phrase), find the strongest match. Returns null when nothing hits
// above `minStrength` (default 40).
export function matchStrongestPhrase(text: string, synonyms: string[], opts: { minStrength?: number } = {}): PhraseMatch | null {
  if (!text) return null;
  const minStrength = opts.minStrength ?? 40;
  const normalizedText = normalize(text);
  const tokens = new Set(tokenize(text));
  let best: PhraseMatch | null = null;

  for (const raw of synonyms) {
    const phrase = normalize(raw);
    if (!phrase) continue;

    // 1. Exact substring — strongest.
    if (normalizedText.includes(phrase)) {
      const strength = Math.min(100, 80 + Math.min(20, phrase.length / 2));
      const cand: PhraseMatch = {
        matchedPhrase: raw,
        matchedSnippet: phrase,
        strength,
        kind: "exact_phrase",
      };
      if (!best || cand.strength > best.strength) best = cand;
      continue;
    }

    // 2. All-token match — every stemmed token of the phrase appears
    //    in the tokenized text. Strength scales with token count.
    const phraseTokens = tokenize(raw);
    if (phraseTokens.length === 0) continue;
    const allPresent = phraseTokens.every((t) => tokens.has(t));
    if (allPresent) {
      const strength = Math.min(80, 50 + phraseTokens.length * 5);
      const cand: PhraseMatch = {
        matchedPhrase: raw,
        matchedSnippet: phraseTokens.join(" "),
        strength,
        kind: "all_tokens_present",
      };
      if (!best || cand.strength > best.strength) best = cand;
      continue;
    }

    // 3. Partial-token match — at least half the phrase tokens
    //    appear. Weak signal; only useful for supporting evidence.
    const overlap = phraseTokens.filter((t) => tokens.has(t)).length;
    if (overlap > 0 && overlap * 2 >= phraseTokens.length) {
      const strength = Math.min(55, 25 + (overlap / phraseTokens.length) * 25);
      const cand: PhraseMatch = {
        matchedPhrase: raw,
        matchedSnippet: phraseTokens.filter((t) => tokens.has(t)).join(" "),
        strength,
        kind: "partial_tokens",
      };
      if (!best || cand.strength > best.strength) best = cand;
    }
  }

  return best && best.strength >= minStrength ? best : null;
}

// -----------------------------------------------------------------------------
// Token overlap (Jaccard-like) — used for account-name ↔ query-text
// coarse similarity as a supporting signal.
// -----------------------------------------------------------------------------

export function tokenOverlap(a: string, b: string): number {
  const aT = new Set(tokenize(a));
  const bT = new Set(tokenize(b));
  if (aT.size === 0 || bT.size === 0) return 0;
  let inter = 0;
  for (const t of aT) if (bT.has(t)) inter++;
  const union = aT.size + bT.size - inter;
  return union === 0 ? 0 : (inter / union) * 100;
}
