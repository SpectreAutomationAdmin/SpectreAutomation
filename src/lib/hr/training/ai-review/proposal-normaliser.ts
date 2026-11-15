// EP-TRAIN-4Y-BF §3 — deterministic, meaning-preserving normalisation of
// a whole AI question proposal (stem + answer options + explanation).
//
// Why: the first unattended real run produced 13 grounded proposals and
// lost 9 of them to FORMATTING the model added despite being told not
// to — "…according to the training material?" in the stem, "This aligns
// with segment [53]." in the explanation, "(Correct Answer: …)" inside
// answer options. The questions themselves were sound. Discarding them
// left a course with zero checkpoint questions.
//
// What this module does — and all it does:
//
//   A. removes the attribution phrase "according to the training
//      material / video / transcript / …" from the stem and the
//      explanation, in the four positions where it is unambiguously an
//      aside: leading ("According to X, …"), comma-delimited
//      (", according to X,"), trailing ("… according to X?") and
//      directly before a when/while/if clause;
//   B. removes INTERNAL SEGMENT REFERENCES from the explanation — a
//      sentence that does nothing but point at a segment, an explicit
//      ", as stated in segment [53]" aside, a "(see segment 53)"
//      parenthetical, or a trailing bare citation list "[66, 67]" — and
//      only when every referenced id is already in the proposal's
//      structured `sourceSegmentIds`, so no evidence is lost;
//   C. removes "(Correct Answer: …)" / "(Correct)" style ANNOTATIONS from
//      the end of answer options, and only when they agree with the
//      structured correct-answer flag.
//
// It is deliberately narrow. "As shown in the video" or "based on the
// training material" can be the content of a sentence ("which technique
// was shown in the video?"), so those are NOT touched here. A phrase is
// only removed where what remains is still a complete sentence; if that
// cannot be established the text is left exactly as it was.
//
// What it never does:
//
//   - touch `sourceSegmentIds`, the question type, option order, option
//     count, or any `isCorrect` flag (asserted before returning);
//   - rewrite, paraphrase or re-tense anything — it only deletes the
//     matched span and repairs capitalisation / spacing around it;
//   - accept anything. Its output goes through the SAME sanitiser,
//     structural validator, grounding check, duplicate check and
//     answer-integrity validation as before. A proposal that is still
//     defective after normalisation is still rejected;
//   - guess. Any sign that the model's own key disagrees with the
//     structured key (an annotation or the explanation naming a
//     different option, a "correct" note on a wrong option, a negative
//     note on the keyed option), any malformed result, or a
//     non-idempotent result REFUSES. A refusal falls back to exactly
//     what the pipeline did before this module existed (the 4Y-AQ
//     stem-only rules), so it can never make an outcome worse.
//
// Pure functions. No I/O, no DB, no secrets.

import {
  normaliseQuestionStem,
  type NormalisationResult,
} from "./question-text-normaliser";

export type ProposalRuleId =
  | "SOURCE_REFERENCE_LEADING"
  | "SOURCE_REFERENCE_TRAILING"
  | "SOURCE_REFERENCE_PARENTHETICAL"
  | "SOURCE_REFERENCE_ADJUNCT"
  | "SEGMENT_POINTER_SENTENCE"
  | "SEGMENT_REFERENCE_ADJUNCT"
  | "SEGMENT_CITATION_LIST_TRAILING"
  | "OPTION_ANSWER_KEY_ANNOTATION"
  | "OPTION_CORRECTNESS_TAG";

export interface ProposalTransform {
  readonly field: "questionText" | "option" | "explanation";
  /** Set for `field === "option"`. */
  readonly optionIndex?: number;
  readonly ruleId: ProposalRuleId | NormalisationResult["transforms"][number]["ruleId"];
  /** Exact text that was removed (truncated to 200 chars). */
  readonly removed: string;
}

export type ProposalRefusalReason =
  | NonNullable<NormalisationResult["refusalReason"]>
  | "MULTIPLE_SOURCE_REFERENCES_IN_STEM"
  | "ANSWER_KEY_CONFLICTS_WITH_CORRECT_OPTION"
  | "ANSWER_KEY_ONLY_ON_INCORRECT_OPTION"
  | "EXPLANATION_NAMES_DIFFERENT_ANSWER"
  | "MALFORMED_AFTER_NORMALISATION"
  | "CORRECT_ANSWER_CHANGED"
  | "IDEMPOTENCY_VIOLATION";

export interface ProposalNormalisationInput {
  readonly questionText: string;
  readonly options: ReadonlyArray<{ readonly text: string; readonly isCorrect: boolean }>;
  readonly explanation?: string | null;
  readonly sourceSegmentIds: readonly number[];
}

export interface ProposalNormalisationResult {
  /** False when a safety gate refused. Options and explanation then
   *  equal the input; the stem is the 4Y-AQ stem-only result (the
   *  behaviour that predates this module), or the input if that refused. */
  readonly ok: boolean;
  readonly questionText: string;
  readonly options: ReadonlyArray<{ readonly text: string; readonly isCorrect: boolean }>;
  readonly explanation: string | null;
  readonly transforms: readonly ProposalTransform[];
  /** Rules that matched but were not applied because their safety
   *  condition did not hold. The text is left as-is for the validators. */
  readonly skipped: readonly { readonly field: ProposalTransform["field"]; readonly reason: string }[];
  readonly refusedForSafety: boolean;
  readonly refusalReason?: ProposalRefusalReason;
  /** The stem-only result of the 4Y-AQ rules. */
  readonly stem: NormalisationResult;
}

// ─── Limits ─────────────────────────────────────────────────────────
// Model output far outside these is not normalised at all (it is left
// for the validators). Bounds every regular expression below.
const MAX_STEM_CHARS = 1_200;
const MAX_OPTION_CHARS = 800;
const MAX_EXPLANATION_CHARS = 6_000;
const RE_LONG_WHITESPACE_RUN = /\s{12,}/;

// ─── Source-reference phrase ────────────────────────────────────────

const SOURCE_NOUN =
  "(?:training (?:materials?|videos?|content|session|module|course)|course (?:materials?|video|content)|video|presentation|transcript|evidence window(?: content)?)";
/** "according to <source>" as a whole phrase: not inside a longer word
 *  on the left, and not continued on the right ("the video's …",
 *  "training material-based …"). */
const SOURCE_PHRASE = `(?<![A-Za-z])according to (?:the |this |our )?${SOURCE_NOUN}(?![A-Za-z0-9'’\\-])`;

const RE_SOURCE_LEADING = new RegExp(`^(\\s*${SOURCE_PHRASE}\\s*,\\s*)(?=\\S)`, "i");
const RE_SOURCE_PARENTHETICAL = new RegExp(`(\\s*,\\s*${SOURCE_PHRASE}\\s*,\\s*)`, "i");
const RE_SOURCE_TRAILING = new RegExp(`((?:\\s*,\\s*|\\s+)${SOURCE_PHRASE})\\s*$`, "i");
/** Only before a clause introduced by when / while / if — words that
 *  cannot continue the source noun phrase itself. */
const RE_SOURCE_ADJUNCT = new RegExp(`(\\s+${SOURCE_PHRASE})(?=\\s+(?:when|while|if)\\b)`, "i");
const RE_SOURCE_ANY = new RegExp(SOURCE_PHRASE, "i");

/** A sentence cannot end on, and an aside cannot directly follow, one of
 *  these: it would mean the removed phrase was part of the statement
 *  ("… is according to X", "… is NOT according to X"). */
const DANGLING: ReadonlySet<string> = new Set([
  "is", "are", "was", "were", "am", "not", "no", "the", "a", "an", "of", "and", "or", "but", "than",
  "that", "which", "as", "this", "these", "those", "its", "their", "your", "our", "his", "her",
  "very", "also", "only", "both", "either", "neither",
]);

// ─── Segment references ─────────────────────────────────────────────

const ID_LIST = "(?:\\[\\s*\\d+(?:\\s*,\\s*\\d+)*\\s*\\]|\\d+)";
const SEG_REF = `(?<![A-Za-z])(?:transcript\\s+)?segments?(?:\\s+ids?)?\\s*:?\\s*${ID_LIST}(?:\\s*(?:,|and|&)\\s*${ID_LIST})*`;
const RE_SEG_REF_GLOBAL = new RegExp(SEG_REF, "gi");
const RE_SEG_REF_ANY = new RegExp(SEG_REF, "i");
const PARTICIPLE = "(?:stated|described|explained|shown|mentioned|covered|noted|given|found|outlined)";
/** ", as stated in segment [53]" / ", stated in segment [53]" /
 *  " as stated in segment [53]" — an explicit aside, at the end of the
 *  sentence. Either the comma or the word "as" is required, so the
 *  sentence's own verb is never consumed. */
const RE_SEG_ADJUNCT_TRAILING = new RegExp(
  `((?:\\s*,\\s*(?:as\\s+)?|\\s+as\\s+)${PARTICIPLE}\\s+in\\s+(?:the\\s+)?${SEG_REF})\\s*$`,
  "i",
);
const RE_SEG_PARENTHETICAL = new RegExp(
  `(\\s*(?:\\(\\s*(?:see\\s+)?(?:the\\s+)?${SEG_REF}\\s*\\)|\\[\\s*(?:see\\s+)?(?:the\\s+)?${SEG_REF}\\s*\\]))`,
  "i",
);
const RE_CITATION_LIST_TRAILING = /(\s*\[\s*\d+(?:\s*,\s*\d+)*\s*\])\s*$/;

/** Words a sentence may contain, besides the segment reference itself,
 *  and still be nothing but a pointer at the source ("This aligns with
 *  the instruction given in segment [53]."). Anything else — including
 *  any digit, any bracket, or any word about the answer — is content,
 *  and a sentence with content is never deleted. */
const POINTER_VOCABULARY: ReadonlySet<string> = new Set([
  "this", "that", "it", "which", "the", "is", "are", "was", "as", "in", "with", "by", "from", "of",
  "to", "on", "also", "see", "per", "aligns", "align", "aligned", "matches", "match", "corresponds",
  "correspond", "refers", "refer", "reflects", "supported", "stated", "described", "explained",
  "shown", "mentioned", "covered", "found", "given", "provided", "noted", "based", "directly",
  "instruction", "instructions", "information", "guidance", "content", "statement", "details",
  "source", "reference", "references", "cited", "citation", "evidence", "transcript", "training",
  "material", "materials", "video",
]);

// ─── Answer-key annotations in options ──────────────────────────────

const RE_OPTION_KEY_ANNOTATION =
  /\s*[(\[]\s*\*{0,2}\s*(?:the\s+)?correct\s+answer\s*\*{0,2}\s*[:\-–—]\s*([^()\[\]]*?)\s*[)\]]\s*$/i;
const RE_OPTION_CORRECTNESS_TAG =
  /\s*[(\[]\s*\*{0,2}\s*(correct(?:\s+answer)?|right(?:\s+answer)?|incorrect|wrong)\s*\*{0,2}\s*[)\]]\s*$/i;
const RE_NEGATION = /(?<![A-Za-z])(?:not|no|incorrect|wrong|never|isn['’]t|aren['’]t|doesn['’]t|don['’]t|cannot|can['’]t)(?![A-Za-z])/i;
const RE_ASSERTS_CORRECT =
  /(?<![A-Za-z])(?:is|this is|it is)\s+(?:the\s+)?(?:correct|right|best)(?![A-Za-z])|(?<![A-Za-z])correct\s+(?:answer|choice|option)(?![A-Za-z])/i;
const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];

// ─── Helpers ────────────────────────────────────────────────────────

function clip(text: string): string {
  return text.slice(0, 200);
}

function loose(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function capitaliseFirst(text: string): string {
  const m = /^(\s*["'“‘(\[]*)([a-z])/.exec(text);
  if (!m) return text;
  return m[1] + m[2].toUpperCase() + text.slice(m[0].length);
}

function lastWord(text: string): string {
  const words = text.toLowerCase().match(/[a-z']+/g);
  return words ? words[words.length - 1] : "";
}

/** Callers return the ORIGINAL string unless a transform fired, so the
 *  split never has to be lossless. */
function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?]["'”’)\]]*)\s+(?=[A-Z0-9"'“‘(\[*])/);
}

function splitTerminal(sentence: string): { body: string; terminal: string } {
  const m = /^([\s\S]*?)([.!?]+["'”’)\]]*)?\s*$/.exec(sentence);
  return { body: m ? m[1] : sentence, terminal: m?.[2] ?? "" };
}

function idsIn(text: string): number[] {
  return (text.match(/\d+/g) ?? []).map((d) => Number(d));
}

type Skipped = { field: ProposalTransform["field"]; reason: string };

interface FieldOutcome {
  readonly text: string;
  readonly transforms: ProposalTransform[];
  readonly skipped: Skipped[];
}

/** Remove "according to <source>" asides from one sentence body. A rule
 *  is applied only when what is left still stands as a sentence;
 *  otherwise the sentence is left untouched and the reason recorded. */
function stripSourceReferences(
  body: string,
  field: ProposalTransform["field"],
  transforms: ProposalTransform[],
  skipped: Skipped[],
): string {
  let current = body;
  // Bounded: each pass removes one phrase or stops.
  for (let pass = 0; pass < 4; pass++) {
    let m = RE_SOURCE_LEADING.exec(current);
    if (m) {
      const rest = current.slice(m[1].length);
      // "According to the video, which stresses safety, what …" — the
      // phrase is the head of a relative clause, not a detachable aside.
      if (/^(?:which|who|whom|that|where)\b[^,?]*,/i.test(rest)) {
        skipped.push({ field, reason: "leading source reference is followed by a relative clause" });
        break;
      }
      transforms.push({ field, ruleId: "SOURCE_REFERENCE_LEADING", removed: clip(m[1]) });
      current = capitaliseFirst(rest);
      continue;
    }
    m = RE_SOURCE_PARENTHETICAL.exec(current);
    if (m) {
      transforms.push({ field, ruleId: "SOURCE_REFERENCE_PARENTHETICAL", removed: clip(m[1]) });
      current = current.slice(0, m.index) + " " + current.slice(m.index + m[1].length);
      continue;
    }
    m = RE_SOURCE_TRAILING.exec(current);
    if (m) {
      const left = current.slice(0, m.index);
      if (left.trim().length === 0 || DANGLING.has(lastWord(left))) {
        skipped.push({ field, reason: "source reference is part of the statement, not an aside" });
        break;
      }
      transforms.push({ field, ruleId: "SOURCE_REFERENCE_TRAILING", removed: clip(m[1]) });
      current = left;
      continue;
    }
    m = RE_SOURCE_ADJUNCT.exec(current);
    if (m) {
      const left = current.slice(0, m.index);
      if (left.trim().length === 0 || DANGLING.has(lastWord(left))) {
        skipped.push({ field, reason: "source reference is part of the statement, not an aside" });
        break;
      }
      transforms.push({ field, ruleId: "SOURCE_REFERENCE_ADJUNCT", removed: clip(m[1]) });
      current = left + current.slice(m.index + m[1].length);
      continue;
    }
    break;
  }
  return current;
}

function normaliseStemText(stemAfterAq: string): FieldOutcome {
  const transforms: ProposalTransform[] = [];
  const skipped: Skipped[] = [];
  const out = splitSentences(stemAfterAq).map((sentence) => {
    const { body, terminal } = splitTerminal(sentence);
    return stripSourceReferences(body, "questionText", transforms, skipped) + terminal;
  });
  return {
    text: transforms.length === 0 ? stemAfterAq : out.join(" ").replace(/\s{2,}/g, " ").trim(),
    transforms,
    skipped,
  };
}

function normaliseExplanationText(explanation: string, sourceSegmentIds: ReadonlySet<number>): FieldOutcome {
  const transforms: ProposalTransform[] = [];
  const skipped: Skipped[] = [];
  const allCited = (text: string): boolean => {
    const ids = idsIn(text);
    return ids.length > 0 && ids.every((id) => sourceSegmentIds.has(id));
  };

  let working = explanation;

  // Trailing bare citation list, e.g. "… as described. [66, 67]".
  const list = RE_CITATION_LIST_TRAILING.exec(working);
  if (list) {
    if (allCited(list[1])) {
      transforms.push({ field: "explanation", ruleId: "SEGMENT_CITATION_LIST_TRAILING", removed: clip(list[1]) });
      working = working.slice(0, list.index);
    } else {
      skipped.push({ field: "explanation", reason: "trailing citation list names ids outside sourceSegmentIds" });
    }
  }

  const kept: string[] = [];
  for (const sentence of splitSentences(working)) {
    const { body: rawBody, terminal } = splitTerminal(sentence);
    let body = rawBody;

    const refs = body.match(RE_SEG_REF_GLOBAL);
    if (refs) {
      if (!refs.every((r) => allCited(r))) {
        skipped.push({ field: "explanation", reason: "segment reference names ids outside sourceSegmentIds" });
        kept.push(sentence);
        continue;
      }
      const remainder = body.replace(RE_SEG_REF_GLOBAL, " ").replace(/[*_`]/g, " ");
      const words = remainder.toLowerCase().match(/[a-z']+/g) ?? [];
      const onlyPointerWords = words.every((w) => POINTER_VOCABULARY.has(w));
      // Any other digit or bracket is content (another citation, a
      // quantity, an option number) — never part of a pure pointer.
      const hasOtherContent = /[\d\[\](){}]/.test(remainder);
      if (onlyPointerWords && !hasOtherContent) {
        transforms.push({ field: "explanation", ruleId: "SEGMENT_POINTER_SENTENCE", removed: clip(sentence) });
        continue;
      }
      const adjunct = RE_SEG_ADJUNCT_TRAILING.exec(body) ?? RE_SEG_PARENTHETICAL.exec(body);
      const candidate = adjunct ? body.slice(0, adjunct.index) + body.slice(adjunct.index + adjunct[1].length) : null;
      if (
        adjunct === null ||
        candidate === null ||
        candidate.trim().length === 0 ||
        DANGLING.has(lastWord(candidate)) ||
        RE_SEG_REF_ANY.test(candidate)
      ) {
        // The reference is woven into a sentence that carries content.
        // Not safe to cut; leave it for the sanitiser to reject.
        skipped.push({ field: "explanation", reason: "segment reference is part of a content sentence" });
        kept.push(sentence);
        continue;
      }
      transforms.push({ field: "explanation", ruleId: "SEGMENT_REFERENCE_ADJUNCT", removed: clip(adjunct[1]) });
      body = candidate;
    }

    body = stripSourceReferences(body, "explanation", transforms, skipped);
    kept.push(body + terminal);
  }

  return {
    text: transforms.length === 0 ? explanation : kept.join(" ").replace(/\s{2,}/g, " ").trim(),
    transforms,
    skipped,
  };
}

/** Which option does a piece of text point at? `"CONFLICT"` when it
 *  names an option that does not exist. `null` when it names none. */
function designatedOption(text: string, bases: readonly string[]): number | "CONFLICT" | null {
  const trimmed = text.trim().replace(/^["'“‘(\[]+/, "");
  const marker = /^(?:option\s+|choice\s+)?([A-H]|\d)(?=\s*(?:$|[.,;:)\]"'”’\-–—]|\s+is\b))/i.exec(trimmed);
  if (marker) {
    const token = marker[1].toUpperCase();
    const idx = /\d/.test(token) ? Number(token) - 1 : token.charCodeAt(0) - 65;
    return idx >= 0 && idx < bases.length ? idx : "CONFLICT";
  }
  const ordinal = new RegExp(`^(?:the\\s+)?(${ORDINALS.join("|")})\\s+(?:option|choice|answer)\\b`, "i").exec(trimmed);
  if (ordinal) {
    const idx = ORDINALS.indexOf(ordinal[1].toLowerCase());
    return idx < bases.length ? idx : "CONFLICT";
  }
  const target = loose(trimmed);
  if (target.length === 0) return null;
  let best: number | null = null;
  let bestLength = 0;
  bases.forEach((base, i) => {
    const b = loose(base);
    if (b.length < 3) return;
    if ((target === b || target.startsWith(b + " ")) && b.length > bestLength) {
      best = i;
      bestLength = b.length;
    }
  });
  return best;
}

/** Does the explanation name an answer other than the structured key? */
function explanationNamesDifferentAnswer(
  explanation: string | null,
  bases: readonly string[],
  correct: number,
): boolean {
  if (!explanation) return false;
  const patterns = [
    /(?<![A-Za-z])correct\s+(?:answer|option|choice|response)\s+is\s*[:\-–—]?\s*([^.!?\n]{1,240})/gi,
    /(?<![A-Za-z])(?:answer|option|choice)\s+([A-H])\s+is\s+(?:the\s+)?(?:correct|right)(?![A-Za-z])/gi,
  ];
  for (const re of patterns) {
    for (let m = re.exec(explanation); m; m = re.exec(explanation)) {
      const target = designatedOption(m[1], bases);
      if (target === "CONFLICT") return true;
      if (target !== null && target !== correct) return true;
    }
  }
  return false;
}

interface OptionOutcome {
  readonly options: { text: string; isCorrect: boolean }[];
  readonly bases: string[];
  readonly correct: number | null;
  readonly transforms: ProposalTransform[];
  readonly refusal: ProposalRefusalReason | null;
}

function normaliseOptions(options: ProposalNormalisationInput["options"]): OptionOutcome {
  const untouched = options.map((o) => ({ text: o.text, isCorrect: o.isCorrect }));
  const plainBases = options.map((o) => o.text.trim());
  const correctIndices = options.map((o, i) => (o.isCorrect ? i : -1)).filter((i) => i >= 0);
  // Without exactly one structured correct answer there is nothing to
  // check an annotation against; leave everything to the validators.
  if (correctIndices.length !== 1) {
    return { options: untouched, bases: plainBases, correct: null, transforms: [], refusal: null };
  }
  const correct = correctIndices[0];
  const refuse = (refusal: ProposalRefusalReason): OptionOutcome => ({
    options: untouched,
    bases: plainBases,
    correct,
    transforms: [],
    refusal,
  });

  interface Found { readonly base: string; readonly kind: "KEY" | "TAG"; readonly payload: string; readonly removed: string }
  const found: (Found | null)[] = options.map((o) => {
    const key = RE_OPTION_KEY_ANNOTATION.exec(o.text);
    if (key) return { base: o.text.slice(0, key.index).trim(), kind: "KEY", payload: key[1].trim(), removed: key[0] };
    const tag = RE_OPTION_CORRECTNESS_TAG.exec(o.text);
    if (tag) return { base: o.text.slice(0, tag.index).trim(), kind: "TAG", payload: tag[1].toLowerCase(), removed: tag[0] };
    return null;
  });
  if (found.every((f) => f === null)) {
    return { options: untouched, bases: plainBases, correct, transforms: [], refusal: null };
  }

  const bases = options.map((o, i) => found[i]?.base ?? o.text.trim());
  if (bases.some((b) => b.length === 0)) return refuse("MALFORMED_AFTER_NORMALISATION");

  const freeTextAnnotated = new Set<number>();
  for (let i = 0; i < found.length; i++) {
    const f = found[i];
    if (!f) continue;
    if (f.kind === "TAG") {
      const saysCorrect = f.payload.startsWith("correct") || f.payload.startsWith("right");
      if (saysCorrect !== (i === correct)) return refuse("ANSWER_KEY_CONFLICTS_WITH_CORRECT_OPTION");
      continue;
    }
    const target = designatedOption(f.payload, bases);
    if (target === "CONFLICT") return refuse("ANSWER_KEY_CONFLICTS_WITH_CORRECT_OPTION");
    if (target !== null) {
      if (target !== correct) return refuse("ANSWER_KEY_CONFLICTS_WITH_CORRECT_OPTION");
      continue;
    }
    // Free-text note. It must not contradict the structured key: a
    // negative note on the keyed option, or a note claiming correctness
    // on any other option, means the two keys disagree.
    if (i === correct ? RE_NEGATION.test(f.payload) : RE_ASSERTS_CORRECT.test(f.payload)) {
      return refuse("ANSWER_KEY_CONFLICTS_WITH_CORRECT_OPTION");
    }
    freeTextAnnotated.add(i);
  }
  // A free-text "(Correct Answer: …)" note that sits only on wrong
  // options suggests the model's key and the structured key disagree.
  if (freeTextAnnotated.size > 0 && !freeTextAnnotated.has(correct)) {
    return refuse("ANSWER_KEY_ONLY_ON_INCORRECT_OPTION");
  }

  const transforms: ProposalTransform[] = [];
  const next = options.map((o, i) => {
    const f = found[i];
    if (!f) return { text: o.text, isCorrect: o.isCorrect };
    transforms.push({
      field: "option",
      optionIndex: i,
      ruleId: f.kind === "KEY" ? "OPTION_ANSWER_KEY_ANNOTATION" : "OPTION_CORRECTNESS_TAG",
      removed: clip(f.removed),
    });
    return { text: f.base, isCorrect: o.isCorrect };
  });
  return { options: next, bases, correct, transforms, refusal: null };
}

/** A normalised field must still read as a complete piece of text. */
function wellFormed(original: string, result: string, kind: "stem" | "explanation"): boolean {
  const t = result.trim();
  if (t.length === 0) return false;
  if (/^[,;:.!?)\]\-–—]/.test(t)) return false;
  const withoutTerminal = t.replace(/[.!?]+["'”’)\]]*$/, "");
  if (/[,;:(\[\-–—]\s*$/.test(withoutTerminal)) return false;
  if (DANGLING.has(lastWord(withoutTerminal))) return false;
  if (/,\s*[,.?!]/.test(t) || /\(\s*\)|\[\s*\]/.test(t)) return false;
  if (/\s[.,;:?!]/.test(t) || /[.?!]\s*[.?!]\s*$/.test(t.replace(/\.\.\.$/, ""))) return false;
  const wordCount = (t.match(/[A-Za-z0-9']+/g) ?? []).length;
  if (wordCount < 3) return false;
  const originalTrimmed = original.trim();
  if (kind === "stem") {
    if (originalTrimmed.endsWith("?") && !t.endsWith("?")) return false;
    if (!/^["'“‘(\[]*[A-Z0-9]/.test(t)) return false;
  } else if (/[.!?]["'”’)\]]*$/.test(originalTrimmed) && !/[.!?]["'”’)\]]*$/.test(t)) {
    return false;
  }
  return true;
}

function withinLimits(input: ProposalNormalisationInput): boolean {
  if (input.questionText.length > MAX_STEM_CHARS || RE_LONG_WHITESPACE_RUN.test(input.questionText)) return false;
  for (const o of input.options) {
    if (o.text.length > MAX_OPTION_CHARS || RE_LONG_WHITESPACE_RUN.test(o.text)) return false;
  }
  const explanation = input.explanation ?? "";
  return explanation.length <= MAX_EXPLANATION_CHARS && !RE_LONG_WHITESPACE_RUN.test(explanation);
}

interface PassResult {
  readonly questionText: string;
  readonly options: { text: string; isCorrect: boolean }[];
  readonly explanation: string | null;
  readonly transforms: ProposalTransform[];
  readonly skipped: Skipped[];
  readonly refusal: ProposalRefusalReason | null;
  readonly stem: NormalisationResult;
}

function runOnce(input: ProposalNormalisationInput): PassResult {
  const originalOptions = input.options.map((o) => ({ text: o.text, isCorrect: o.isCorrect }));
  const originalExplanation = input.explanation ?? null;
  const stem = normaliseQuestionStem({ questionText: input.questionText });
  /** What the pipeline did before this module: the 4Y-AQ stem only. */
  const stemOnlyText = stem.ok ? stem.normalisedText : input.questionText;
  const refuse = (reason: ProposalRefusalReason): PassResult => ({
    questionText: stemOnlyText,
    options: originalOptions,
    explanation: originalExplanation,
    transforms: [],
    skipped: [],
    refusal: reason,
    stem,
  });
  if (stem.refusedForSafety) return refuse(stem.refusalReason ?? "MALFORMED_AFTER_NORMALISATION");
  if (!withinLimits(input)) {
    // Out-of-range output is not examined further; the stem keeps its
    // 4Y-AQ result and the validators decide.
    return {
      questionText: stemOnlyText,
      options: originalOptions,
      explanation: originalExplanation,
      transforms: stem.transforms.map((t) => ({ field: "questionText" as const, ruleId: t.ruleId, removed: clip(t.beforeSlice) })),
      skipped: [{ field: "questionText", reason: "proposal exceeds normalisation size limits" }],
      refusal: null,
      stem,
    };
  }

  const transforms: ProposalTransform[] = stem.transforms.map((t) => ({
    field: "questionText" as const,
    ruleId: t.ruleId,
    removed: clip(t.beforeSlice),
  }));
  const skipped: Skipped[] = [];

  // A. stem
  const stemOutcome = normaliseStemText(stem.normalisedText);
  skipped.push(...stemOutcome.skipped);
  const stemPhraseCount = stem.transforms.filter((t) => t.position === "leading").length + stemOutcome.transforms.length;
  if (stemPhraseCount > 1) return refuse("MULTIPLE_SOURCE_REFERENCES_IN_STEM");
  transforms.push(...stemOutcome.transforms);
  const questionText = stemOutcome.text;
  if (stemOutcome.transforms.length > 0 && !wellFormed(input.questionText, questionText, "stem")) {
    return refuse("MALFORMED_AFTER_NORMALISATION");
  }

  // C. options
  const optionOutcome = normaliseOptions(input.options);
  if (optionOutcome.refusal) return refuse(optionOutcome.refusal);
  transforms.push(...optionOutcome.transforms);

  // B. explanation
  let explanation = originalExplanation;
  if (originalExplanation && originalExplanation.trim().length > 0) {
    const outcome = normaliseExplanationText(originalExplanation, new Set(input.sourceSegmentIds));
    skipped.push(...outcome.skipped);
    if (outcome.transforms.length > 0) {
      if (!wellFormed(originalExplanation, outcome.text, "explanation")) {
        return refuse("MALFORMED_AFTER_NORMALISATION");
      }
      transforms.push(...outcome.transforms);
      explanation = outcome.text;
    }
  }

  // Whenever this module changes anything beyond the 4Y-AQ stem rules,
  // the explanation must not name a different answer than the
  // structured key: such a proposal is mis-keyed or ambiguous, and
  // cleaning its formatting must not be what gets it accepted.
  const changedBeyondStemRules = transforms.length > stem.transforms.length;
  if (
    changedBeyondStemRules &&
    optionOutcome.correct !== null &&
    (explanationNamesDifferentAnswer(originalExplanation, optionOutcome.bases, optionOutcome.correct) ||
      explanationNamesDifferentAnswer(explanation, optionOutcome.bases, optionOutcome.correct))
  ) {
    return refuse("EXPLANATION_NAMES_DIFFERENT_ANSWER");
  }

  return { questionText, options: optionOutcome.options, explanation, transforms, skipped, refusal: null, stem };
}

/**
 * Normalise one proposal. Deterministic and idempotent: feeding the
 * result back in produces no further change (checked; a violation
 * refuses).
 */
export function normaliseProposal(input: ProposalNormalisationInput): ProposalNormalisationResult {
  const originalOptions = input.options.map((o) => ({ text: o.text, isCorrect: o.isCorrect }));
  const originalExplanation = input.explanation ?? null;
  const first = runOnce(input);
  const stemOnlyText = first.stem.ok ? first.stem.normalisedText : input.questionText;
  const refused = (reason: ProposalRefusalReason): ProposalNormalisationResult => ({
    ok: false,
    questionText: stemOnlyText,
    options: originalOptions,
    explanation: originalExplanation,
    transforms: [],
    skipped: first.skipped,
    refusedForSafety: true,
    refusalReason: reason,
    stem: first.stem,
  });
  if (first.refusal) return refused(first.refusal);
  if (first.transforms.length === 0) {
    return {
      ok: true,
      questionText: input.questionText,
      options: originalOptions,
      explanation: originalExplanation,
      transforms: [],
      skipped: first.skipped,
      refusedForSafety: false,
      stem: first.stem,
    };
  }

  // The structured answer key is never altered.
  const sameKey =
    first.options.length === input.options.length &&
    first.options.every((o, i) => o.isCorrect === input.options[i].isCorrect);
  if (!sameKey) return refused("CORRECT_ANSWER_CHANGED");

  const second = runOnce({
    questionText: first.questionText,
    options: first.options,
    explanation: first.explanation,
    sourceSegmentIds: input.sourceSegmentIds,
  });
  if (second.refusal || second.transforms.length > 0) return refused("IDEMPOTENCY_VIOLATION");

  return {
    ok: true,
    questionText: first.questionText,
    options: first.options,
    explanation: first.explanation,
    transforms: first.transforms,
    skipped: first.skipped,
    refusedForSafety: false,
    stem: first.stem,
  };
}

/** Compact, canonical-order list of rule ids for audit rows. */
export function proposalNormalisationRuleSummary(result: ProposalNormalisationResult): string {
  if (!result.ok || result.transforms.length === 0) return "";
  return Array.from(new Set(result.transforms.map((t) => String(t.ruleId)))).sort().join(",");
}

/** True when a source reference this module recognises is still present. */
export function hasResidualSourceReference(text: string): boolean {
  return RE_SOURCE_ANY.test(text);
}
