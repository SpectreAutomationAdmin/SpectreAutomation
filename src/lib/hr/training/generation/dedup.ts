// EP-TRAIN-6D-4X (2026-11-06) — Deterministic semantic duplicate
// detection for AI-generated question candidates.
//
// Design (per founder §7):
//   - deterministic + testable + explainable (same input → same
//     verdict + same justification tokens);
//   - no new paid AI provider, no new embedding model, no persistent
//     vector index, no new schema;
//   - multi-signal verdict — cosine similarity ALONE is never cited
//     as proof two questions are equivalent;
//   - versioned threshold ruleset so operator-controlled tuning is
//     recorded on each run.
//
// Signals combined:
//   1. Normalised-text identity    → EXACT_DUP
//   2. Shingle Jaccard (bi+tri)    ≥ PARAPHRASE_SHINGLE
//   3. Correct-answer value match  → corroboration for PARAPHRASE
//   4. Option-set Jaccard          → corroboration for PARAPHRASE
//   5. Explanation-token overlap   → corroboration for PARAPHRASE
//
// A verdict of PARAPHRASE_DUP requires BOTH:
//   (shingle Jaccard ≥ PARAPHRASE_SHINGLE)
//   AND (option-set Jaccard ≥ PARAPHRASE_OPTION_OVERLAP
//        OR same-correct-answer token overlap ≥ PARAPHRASE_ANSWER_OVERLAP
//        OR explanation Jaccard ≥ PARAPHRASE_EXPLANATION)
//
// A verdict of TOPIC_CANDIDATE is advisory only (the manager sees
// the warning; the system does NOT drop the candidate).

import { createHash } from "node:crypto";

export const DEDUP_RULES_VERSION = "dedup-v2" as const;

export const EXACT_SHINGLE = 1.0;
// PARAPHRASE_SHINGLE applies to the multi-shingle Jaccard (1+2+3-grams
// over lemma-normalised tokens). Set so that a reworded question
// restating the same fact — reordered verbs, noun → verb changes
// ("reports" ↔ "reporting"), insertions like "immediately" — can
// trip, while a pair sharing only a topic ("escalation") does not.
export const PARAPHRASE_SHINGLE = 0.55;
export const PARAPHRASE_OPTION_OVERLAP = 0.5;
export const PARAPHRASE_ANSWER_OVERLAP = 0.6;
export const PARAPHRASE_EXPLANATION = 0.5;
export const TOPIC_CANDIDATE_SHINGLE = 0.3;

// EP-TRAIN-4Y-N (2026-11-08) — grounded near-duplicate rule.
// Two drafts citing overlapping transcript segments AND whose
// correct-answer / explanation / shingle signal overlaps non-trivially
// are flagged as TOPIC_CANDIDATE even when the shingle alone would
// return DISTINCT (as happened with 4Y-M draft 1 vs draft 2 — both
// cited segment [4] with "last 4 digits of SIN" but shingle was only
// 0.23 because the first draft embedded the options in questionText).
//
// Requires the candidate to supply `sourceSegmentIds`. When absent
// (legacy priors from pre-4Y-N runs that didn't track this field),
// the rule is silently inactive and the original shingle-based
// classifier applies.
export const GROUNDED_SEGMENT_OVERLAP = 0.5;
export const GROUNDED_SUPPORTING_ANSWER = 0.4;
export const GROUNDED_SUPPORTING_EXPLANATION = 0.4;
export const GROUNDED_SUPPORTING_SHINGLE = 0.15;

export type DedupVerdict =
  | "EXACT_DUP"
  | "PARAPHRASE_DUP"
  | "TOPIC_CANDIDATE"
  | "DISTINCT";

export interface DuplicateSignalEvidence {
  readonly normalizedMatch: boolean;
  readonly shingleJaccard: number;
  readonly optionJaccard: number;
  readonly answerTokenJaccard: number;
  readonly explanationJaccard: number;
  readonly sharedTokens: readonly string[];
  /** EP-TRAIN-4Y-N (2026-11-08) — Jaccard of cited sourceSegmentIds
   *  between the candidate and the prior. 0 when either side omits
   *  the field (legacy priors). */
  readonly sourceSegmentJaccard: number;
}

export interface QuestionCandidate {
  readonly id?: string; // may be absent pre-persist
  readonly questionText: string;
  readonly options: readonly { readonly text: string; readonly isCorrect: boolean }[];
  readonly explanation?: string;
  readonly destination?: string; // "cp-cg-1" / "final" — crosses are decisions
  /** EP-TRAIN-4Y-N (2026-11-08) — citations into the transcript.
   *  Used by the grounded near-duplicate rule. Optional for
   *  backward-compatibility with legacy persisted candidates. */
  readonly sourceSegmentIds?: readonly number[];
}

export interface DedupDecision {
  readonly verdict: DedupVerdict;
  readonly rulesVersion: typeof DEDUP_RULES_VERSION;
  readonly againstPriorId: string | null; // id (or `${destination}:${ix}`) of the prior
  readonly againstPriorDestination: string | null;
  readonly evidence: DuplicateSignalEvidence;
  readonly explanation: string;
}

// ─── Normalisation ──────────────────────────────────────────────────

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "do", "for",
  "from", "has", "have", "he", "her", "his", "i", "in", "is", "it",
  "its", "of", "on", "or", "our", "she", "that", "the", "their",
  "this", "to", "was", "we", "were", "what", "when", "where", "which",
  "who", "will", "with", "would", "you", "your", "about", "all", "any",
  "can", "if", "into", "like", "more", "no", "not", "one", "only",
  "out", "over", "so", "some", "than", "then", "there", "they", "up",
  "very",
]);

export function normaliseQuestion(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Minimal deterministic suffix-stripping lemma (NOT a full Porter
 *  stemmer; intentionally lightweight). Collapses obvious inflections
 *  so "reports" ≡ "reporting" ≡ "reported" for shingle purposes. */
function lemma(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith("ies")) return token.slice(0, -3) + "y";
  if (token.endsWith("sses")) return token.slice(0, -2);
  if (token.endsWith("es") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("ing") && token.length > 5) return token.slice(0, -3);
  if (token.endsWith("edly") && token.length > 5) return token.slice(0, -4);
  if (token.endsWith("ed") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("ly") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) return token.slice(0, -1);
  return token;
}

function tokenise(text: string): string[] {
  return normaliseQuestion(text)
    .split(" ")
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(lemma)
    .filter((t) => t.length > 1);
}

function shingles(text: string, n: number): Set<string> {
  const toks = tokenise(text);
  const out = new Set<string>();
  if (toks.length < n) return out;
  for (let i = 0; i <= toks.length - n; i++) {
    out.add(toks.slice(i, i + n).join(" "));
  }
  return out;
}

export function multiShingles(text: string): Set<string> {
  // 1-grams carry lexical content; 2/3-grams carry local word order.
  const one = shingles(text, 1);
  const two = shingles(text, 2);
  const three = shingles(text, 3);
  const out = new Set<string>();
  for (const s of one) out.add(`1:${s}`);
  for (const s of two) out.add(`2:${s}`);
  for (const s of three) out.add(`3:${s}`);
  return out;
}

function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

function sharedTokenList(a: ReadonlySet<string>, b: ReadonlySet<string>, cap = 8): string[] {
  const out: string[] = [];
  for (const t of a) if (b.has(t)) {
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}

// ─── Core comparison ────────────────────────────────────────────────

export function evaluatePair(
  candidate: QuestionCandidate,
  prior: QuestionCandidate,
): DedupDecision {
  const candNormalised = normaliseQuestion(candidate.questionText);
  const priNormalised = normaliseQuestion(prior.questionText);

  const normalizedMatch = candNormalised.length > 0 && candNormalised === priNormalised;

  const candShingles = multiShingles(candidate.questionText);
  const priShingles = multiShingles(prior.questionText);
  const shingleScore = jaccard(candShingles, priShingles);

  const candOptionTokens = new Set<string>();
  for (const o of candidate.options) for (const t of tokenise(o.text)) candOptionTokens.add(t);
  const priOptionTokens = new Set<string>();
  for (const o of prior.options) for (const t of tokenise(o.text)) priOptionTokens.add(t);
  const optionScore = jaccard(candOptionTokens, priOptionTokens);

  const candAnswerTokens = new Set<string>();
  for (const o of candidate.options) if (o.isCorrect) for (const t of tokenise(o.text)) candAnswerTokens.add(t);
  const priAnswerTokens = new Set<string>();
  for (const o of prior.options) if (o.isCorrect) for (const t of tokenise(o.text)) priAnswerTokens.add(t);
  const answerScore = jaccard(candAnswerTokens, priAnswerTokens);

  const candExpl = new Set(tokenise(candidate.explanation ?? ""));
  const priExpl = new Set(tokenise(prior.explanation ?? ""));
  const explanationScore = jaccard(candExpl, priExpl);

  const shared = sharedTokenList(candShingles, priShingles);

  // EP-TRAIN-4Y-N — cited-segment Jaccard. Inactive when either side
  // omits the field (pre-4Y-N persisted drafts don't carry the field).
  const candSegs = new Set<number>(candidate.sourceSegmentIds ?? []);
  const priSegs = new Set<number>(prior.sourceSegmentIds ?? []);
  const sourceSegmentJaccard = (candSegs.size > 0 && priSegs.size > 0)
    ? jaccard(candSegs, priSegs)
    : 0;

  let verdict: DedupVerdict = "DISTINCT";
  let explanation = "";

  if (normalizedMatch) {
    verdict = "EXACT_DUP";
    explanation = "normalised question text identical";
  } else if (shingleScore >= PARAPHRASE_SHINGLE &&
    (optionScore >= PARAPHRASE_OPTION_OVERLAP ||
     answerScore >= PARAPHRASE_ANSWER_OVERLAP ||
     explanationScore >= PARAPHRASE_EXPLANATION)) {
    verdict = "PARAPHRASE_DUP";
    const reasons: string[] = [`shingle ${shingleScore.toFixed(2)} ≥ ${PARAPHRASE_SHINGLE}`];
    if (optionScore >= PARAPHRASE_OPTION_OVERLAP) reasons.push(`option-set ${optionScore.toFixed(2)}`);
    if (answerScore >= PARAPHRASE_ANSWER_OVERLAP) reasons.push(`correct-answer tokens ${answerScore.toFixed(2)}`);
    if (explanationScore >= PARAPHRASE_EXPLANATION) reasons.push(`explanation ${explanationScore.toFixed(2)}`);
    explanation = reasons.join(" + ");
  } else if (shingleScore >= TOPIC_CANDIDATE_SHINGLE) {
    verdict = "TOPIC_CANDIDATE";
    explanation = `shingle ${shingleScore.toFixed(2)} within topic-candidate band (${TOPIC_CANDIDATE_SHINGLE}–${PARAPHRASE_SHINGLE})`;
  } else if (
    // EP-TRAIN-4Y-N grounded near-duplicate — conservative: requires
    // overlapping cited evidence AND at least one supporting signal.
    sourceSegmentJaccard >= GROUNDED_SEGMENT_OVERLAP &&
    (answerScore >= GROUNDED_SUPPORTING_ANSWER ||
     explanationScore >= GROUNDED_SUPPORTING_EXPLANATION ||
     shingleScore >= GROUNDED_SUPPORTING_SHINGLE)
  ) {
    verdict = "TOPIC_CANDIDATE";
    const reasons: string[] = [`cited-segment Jaccard ${sourceSegmentJaccard.toFixed(2)} ≥ ${GROUNDED_SEGMENT_OVERLAP}`];
    if (answerScore >= GROUNDED_SUPPORTING_ANSWER) reasons.push(`+ correct-answer ${answerScore.toFixed(2)} ≥ ${GROUNDED_SUPPORTING_ANSWER}`);
    if (explanationScore >= GROUNDED_SUPPORTING_EXPLANATION) reasons.push(`+ explanation ${explanationScore.toFixed(2)} ≥ ${GROUNDED_SUPPORTING_EXPLANATION}`);
    if (shingleScore >= GROUNDED_SUPPORTING_SHINGLE) reasons.push(`+ shingle ${shingleScore.toFixed(2)} ≥ ${GROUNDED_SUPPORTING_SHINGLE}`);
    explanation = `grounded near-duplicate: ${reasons.join(" ")}`;
  } else {
    verdict = "DISTINCT";
    explanation = `shingle ${shingleScore.toFixed(2)} below topic threshold ${TOPIC_CANDIDATE_SHINGLE}; cited-segment overlap ${sourceSegmentJaccard.toFixed(2)}`;
  }

  return {
    verdict,
    rulesVersion: DEDUP_RULES_VERSION,
    againstPriorId: prior.id ?? null,
    againstPriorDestination: prior.destination ?? null,
    evidence: {
      normalizedMatch,
      shingleJaccard: Math.round(shingleScore * 1000) / 1000,
      optionJaccard: Math.round(optionScore * 1000) / 1000,
      answerTokenJaccard: Math.round(answerScore * 1000) / 1000,
      explanationJaccard: Math.round(explanationScore * 1000) / 1000,
      sharedTokens: shared,
      sourceSegmentJaccard: Math.round(sourceSegmentJaccard * 1000) / 1000,
    },
    explanation,
  };
}

/** Evaluate a candidate against ALL prior questions (checkpoints +
 *  final, in any destination). Returns the single strictest verdict
 *  — EXACT > PARAPHRASE > TOPIC_CANDIDATE > DISTINCT — plus the pair
 *  that produced it. Ties broken by first-prior order. */
export function evaluateAgainstPriors(
  candidate: QuestionCandidate,
  priors: readonly QuestionCandidate[],
): DedupDecision {
  let best: DedupDecision | null = null;
  for (const p of priors) {
    const d = evaluatePair(candidate, p);
    if (!best) { best = d; continue; }
    if (verdictRank(d.verdict) > verdictRank(best.verdict)) best = d;
  }
  if (!best) {
    // No priors to compare against — always DISTINCT.
    return {
      verdict: "DISTINCT",
      rulesVersion: DEDUP_RULES_VERSION,
      againstPriorId: null,
      againstPriorDestination: null,
      evidence: {
        normalizedMatch: false,
        shingleJaccard: 0, optionJaccard: 0,
        answerTokenJaccard: 0, explanationJaccard: 0,
        sharedTokens: [],
        sourceSegmentJaccard: 0,
      },
      explanation: "no prior questions to compare against",
    };
  }
  return best;
}

function verdictRank(v: DedupVerdict): number {
  switch (v) {
    case "EXACT_DUP": return 3;
    case "PARAPHRASE_DUP": return 2;
    case "TOPIC_CANDIDATE": return 1;
    case "DISTINCT": return 0;
  }
}

export function candidateFingerprint(c: QuestionCandidate): string {
  return createHash("sha256").update(
    JSON.stringify({
      q: normaliseQuestion(c.questionText),
      opts: [...c.options].map((o) => ({ t: normaliseQuestion(o.text), c: !!o.isCorrect }))
                         .sort((a, b) => a.t.localeCompare(b.t)),
    }),
  ).digest("hex");
}
