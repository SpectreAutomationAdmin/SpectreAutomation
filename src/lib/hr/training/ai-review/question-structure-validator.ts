// EP-TRAIN-4Y-AE §4 (2026-11-10) — reusable question-structure validator.
//
// The 4Y-AA question-text sanitiser caught internal-pipeline phrasing
// (ACCORDING_TO_TRANSCRIPT, EXPLICIT_SEGMENT_ID_REFERENCE,
// EMBEDDED_ANSWER_KEY, EMBEDDED_MARKDOWN_OPTION_HEADER, …). It did
// NOT catch the broader structural defect the founder reported on
// 2026-11-10: Qwen returned responses whose question text contained
// the entire options block inlined after the stem, with the
// structured options[] array ALSO carrying the same prose. Managers
// would see the options twice.
//
// This module is a stricter, STRUCTURE-aware validator that composes
// with the 4Y-AA text sanitiser. Where the AA sanitiser said "no
// internal terminology", this one says "the stem contains only the
// question, options live only in the options array, explanation lives
// only in the explanation field."
//
// Pure functions. No I/O. Consumed by:
//   - worker-handler's proposal-persist loop (reject before create)
//   - approval-service (block approve on pre-AE rows that slipped
//     through AA)
//   - the inline-edit service (refuse a manager save that reintroduces
//     the defect)
//
// Where a corrective normalisation is UNAMBIGUOUS (e.g. strip a
// trailing "\n\nA) ... D) ..." block when every option body also
// appears verbatim in the array), `normaliseStructuredQuestion`
// returns the corrected shape. Ambiguous cases (shorter stems
// without clear option delimiters) are refused — the caller raises
// an error with the finding codes.

export type QuestionStructureFindingCode =
  | "EMBEDDED_OPTION_LINES_IN_STEM"
  | "OPTION_BODY_APPEARS_IN_STEM"
  | "CORRECT_ANSWER_KEY_IN_STEM"
  | "TRANSCRIPT_REFERENCE_IN_STEM"
  | "SEGMENT_ID_REFERENCE_IN_STEM"
  | "DUPLICATE_OPTION_TEXT"
  | "MISSING_CORRECT_OPTION"
  | "MULTIPLE_CORRECT_OPTIONS"
  | "OPTION_TOO_SHORT"
  | "OPTION_LABEL_PREFIX_IN_TEXT";

export interface QuestionStructureFinding {
  readonly code: QuestionStructureFindingCode;
  readonly message: string;
  /** Short snippet of the matched content (≤160 chars) for audit. */
  readonly matched?: string;
}

export interface StructuredQuestionDraft {
  readonly questionText: string;
  readonly options: ReadonlyArray<{ readonly text: string; readonly isCorrect: boolean }>;
  readonly explanation?: string | null | undefined;
}

export interface QuestionStructureResult {
  readonly ok: boolean;
  readonly findings: readonly QuestionStructureFinding[];
}

// Patterns ----------------------------------------------------------

// "\n\nA) option\nB) option" — classic markdown option block embedded
// after the stem. Also matches "A." / "A]" / "a)" / "*A)*" etc.
const EMBEDDED_OPTION_LINE_RX =
  /(?:\n|^)\s*(?:[*_]{0,2})([A-Da-d])(?:[*_]{0,2})\s*[)\].:]\s+\S/;

// "Correct Answer: X" inline, with or without markdown wrappers.
const CORRECT_ANSWER_KEY_RX = /\*{0,2}\s*correct\s+answer\s*\*{0,2}\s*:/i;

// Transcript / segment references in the stem.
const TRANSCRIPT_REF_RX =
  /\baccording to (?:the )?(?:transcript|evidence window|training material)|segments?\s*\[[\d, ]+\]|\b(?:transcript\s+)?segment\s+\d+/i;

// Option text that's been pre-prefixed with "A) " / "a. " / "(A) " etc.
const OPTION_LABEL_PREFIX_RX = /^\s*(?:[*_]{0,2}\(?)?([A-Da-d])(?:[*_]{0,2}\)?)\s*[)\].:]\s+/;

export function checkQuestionStructure(
  input: StructuredQuestionDraft,
): QuestionStructureResult {
  const findings: QuestionStructureFinding[] = [];
  const stem = String(input.questionText ?? "");
  const options = input.options ?? [];

  // Embedded option lines in the stem.
  const embeddedMatch = EMBEDDED_OPTION_LINE_RX.exec(stem);
  if (embeddedMatch) {
    findings.push({
      code: "EMBEDDED_OPTION_LINES_IN_STEM",
      message:
        "Question stem contains inline option lines (e.g. '\\nA) …'). Options must live only in the options array.",
      matched: embeddedMatch[0].slice(0, 160),
    });
  }

  // Option body appears verbatim in the stem (prose duplication).
  for (const o of options) {
    const t = String(o?.text ?? "").trim();
    if (t.length <= 10) continue; // too short to be a reliable match
    if (stem.includes(t)) {
      findings.push({
        code: "OPTION_BODY_APPEARS_IN_STEM",
        message:
          "An option's body text appears verbatim inside the question stem. The stem must be the question only.",
        matched: t.slice(0, 160),
      });
      break;
    }
  }

  // Correct-answer key leaking.
  const answerKeyMatch = CORRECT_ANSWER_KEY_RX.exec(stem);
  if (answerKeyMatch) {
    findings.push({
      code: "CORRECT_ANSWER_KEY_IN_STEM",
      message:
        "Question stem reveals the correct answer (e.g. 'Correct Answer: C'). The key must live in the options array's isCorrect field.",
      matched: answerKeyMatch[0].slice(0, 160),
    });
  }

  // Transcript / segment references.
  const transcriptMatch = TRANSCRIPT_REF_RX.exec(stem);
  if (transcriptMatch) {
    findings.push({
      code: "TRANSCRIPT_REFERENCE_IN_STEM",
      message:
        "Question stem references the transcript or segment ids. Provenance belongs on the draft row, not the employee-facing text.",
      matched: transcriptMatch[0].slice(0, 160),
    });
  }

  // Option-level checks.
  const normalisedOptions = options.map((o) => String(o?.text ?? "").trim());
  const seen = new Set<string>();
  let correctCount = 0;
  for (let i = 0; i < options.length; i++) {
    const t = normalisedOptions[i];
    if (options[i]?.isCorrect) correctCount++;
    if (t.length < 2) {
      findings.push({
        code: "OPTION_TOO_SHORT",
        message: `Option ${i + 1} is empty or a single character (likely a stray label, not an answer body).`,
      });
      continue;
    }
    if (seen.has(t.toLowerCase())) {
      findings.push({
        code: "DUPLICATE_OPTION_TEXT",
        message: `Options contain a duplicate body ("${t.slice(0, 60)}").`,
        matched: t.slice(0, 160),
      });
    } else {
      seen.add(t.toLowerCase());
    }
    const prefix = OPTION_LABEL_PREFIX_RX.exec(t);
    if (prefix) {
      findings.push({
        code: "OPTION_LABEL_PREFIX_IN_TEXT",
        message: `Option ${i + 1} text begins with an "${prefix[0]}" label. The label is rendered from the index; it must not live in the text.`,
        matched: prefix[0].slice(0, 160),
      });
    }
  }
  if (correctCount === 0) {
    findings.push({
      code: "MISSING_CORRECT_OPTION",
      message: "No option is marked correct. Every question must have exactly one isCorrect=true option.",
    });
  } else if (correctCount > 1) {
    findings.push({
      code: "MULTIPLE_CORRECT_OPTIONS",
      message: `${correctCount} options are marked correct. Only one option may be correct.`,
    });
  }

  return { ok: findings.length === 0, findings };
}

// -------------------------------------------------------------------
// Normalisation: SAFE, deterministic corrections. Returns null when
// the defect cannot be corrected without guessing.
// -------------------------------------------------------------------

export interface QuestionStructureNormalisation {
  readonly normalised: StructuredQuestionDraft;
  readonly correctedFindings: readonly QuestionStructureFinding[];
  readonly remainingFindings: readonly QuestionStructureFinding[];
}

/**
 * Try to safely correct common structural defects without guessing:
 *   - If the stem ends with an inlined "A) … B) … C) … D) …" block AND
 *     every embedded option body matches a `.text` in the options
 *     array, strip the inline block from the stem.
 *   - If an option.text starts with its own letter-prefix ("A) "), strip
 *     the prefix.
 *   - If the stem contains an isolated "*Segment IDs: [N]*" or
 *     "Correct Answer: X" tail, strip it.
 *
 * Returns `null` when the stem cannot be cleaned deterministically
 * (ambiguous delimiter, missing option matches, etc.). The caller
 * must then refuse the write + log the findings.
 */
export function normaliseStructuredQuestion(
  input: StructuredQuestionDraft,
): QuestionStructureNormalisation | null {
  let stem = String(input.questionText ?? "");
  const corrected: QuestionStructureFinding[] = [];

  // Strip option-label prefixes from individual option texts.
  const options = input.options.map((o) => {
    const t = String(o?.text ?? "");
    const stripped = t.replace(OPTION_LABEL_PREFIX_RX, "").trim();
    return { text: stripped, isCorrect: !!o?.isCorrect };
  });
  if (options.some((o, i) => o.text !== String(input.options[i]?.text ?? "").trim())) {
    corrected.push({
      code: "OPTION_LABEL_PREFIX_IN_TEXT",
      message: "Stripped option label prefixes.",
    });
  }

  // Strip "\nCorrect Answer: X" lines + "*Segment IDs: [...]" blocks.
  const beforeKeyStrip = stem;
  stem = stem.replace(/\n*\*{0,2}\s*Correct\s+Answer\s*:\s*\*{0,2}\s*[A-D]\s*\n*/gi, "\n");
  if (stem !== beforeKeyStrip) {
    corrected.push({
      code: "CORRECT_ANSWER_KEY_IN_STEM",
      message: "Removed embedded 'Correct Answer: X' line.",
    });
  }
  const beforeSegStrip = stem;
  stem = stem.replace(/\n*\*?\s*Segment\s*IDs?\s*:\s*\[[\d, ]+\]\s*\*?\s*/gi, "");
  if (stem !== beforeSegStrip) {
    corrected.push({
      code: "SEGMENT_ID_REFERENCE_IN_STEM",
      message: "Removed embedded '*Segment IDs: [...]*' line.",
    });
  }

  // Strip "\n\nA) ... B) ... C) ... D) ..." inlined option block when
  // every embedded body matches an option.text. Conservative: refuses
  // to strip when any embedded body doesn't match.
  const embeddedSplitRx = /(?:\n|^)\s*(?:[*_]{0,2})([A-Da-d])(?:[*_]{0,2})\s*[)\].:]\s+/g;
  const firstEmbeddedMatch = embeddedSplitRx.exec(stem);
  if (firstEmbeddedMatch) {
    const cut = firstEmbeddedMatch.index;
    const stemCore = stem.slice(0, cut).trim();
    const inlined = stem.slice(cut);
    // Split inlined by the same regex into labelled chunks.
    const chunks = inlined
      .split(/(?:\n|^)\s*(?:[*_]{0,2})([A-Da-d])(?:[*_]{0,2})\s*[)\].:]\s+/)
      .filter((s) => s !== undefined && s !== null)
      .map((s) => String(s).trim())
      .filter((s) => s.length > 0 && !/^[A-Da-d]$/.test(s));
    const optionTextsLower = options.map((o) => o.text.toLowerCase());
    const everyChunkMatchesAnOption = chunks.length > 0 && chunks.every((c) =>
      optionTextsLower.some((ot) => ot.length > 10 && (c.toLowerCase().startsWith(ot) || ot.startsWith(c.toLowerCase().slice(0, Math.min(ot.length, c.length))))),
    );
    if (everyChunkMatchesAnOption && stemCore.length > 10) {
      stem = stemCore;
      corrected.push({
        code: "EMBEDDED_OPTION_LINES_IN_STEM",
        message: "Removed embedded option block from the stem.",
      });
    }
    // else: leave as-is; the checker below will still flag it as a
    // remaining finding, so the caller can refuse the write.
  }

  // One more pass: trim option bodies from the stem when they appear
  // as free-form paragraphs (no A) B) label). Only strip when the
  // stem clearly starts with a question mark followed by blocks of
  // option bodies.
  const qMarkIdx = stem.indexOf("?");
  if (qMarkIdx >= 10 && qMarkIdx < stem.length - 10) {
    const afterQ = stem.slice(qMarkIdx + 1).trim();
    const paragraphs = afterQ.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);
    const optionTextsLower = options.map((o) => o.text.toLowerCase());
    const everyParaMatchesAnOption = paragraphs.length > 0 && paragraphs.every((p) =>
      optionTextsLower.some((ot) => ot.length > 10 && p.toLowerCase().includes(ot.slice(0, Math.min(ot.length, 60)))),
    );
    if (everyParaMatchesAnOption) {
      stem = stem.slice(0, qMarkIdx + 1).trim();
      corrected.push({
        code: "OPTION_BODY_APPEARS_IN_STEM",
        message: "Removed option bodies that were duplicated in the stem after the question mark.",
      });
    }
  }

  stem = stem.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  const normalised: StructuredQuestionDraft = {
    questionText: stem,
    options,
    explanation: input.explanation ?? null,
  };
  const check = checkQuestionStructure(normalised);
  if (!check.ok) {
    // Could not fully normalise; return null so the caller refuses
    // the write (unless the remaining findings are only "OPTION_TOO_SHORT"
    // or similar non-ambiguous ones the caller may handle).
    return {
      normalised,
      correctedFindings: corrected,
      remainingFindings: check.findings,
    };
  }
  return {
    normalised,
    correctedFindings: corrected,
    remainingFindings: [],
  };
}
