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
  | "INLINE_OPTION_SEQUENCE_IN_STEM"
  | "OPTION_BODY_APPEARS_IN_STEM"
  | "CORRECT_ANSWER_KEY_IN_STEM"
  | "TRANSCRIPT_REFERENCE_IN_STEM"
  | "SEGMENT_ID_REFERENCE_IN_STEM"
  | "DUPLICATE_OPTION_TEXT"
  | "MISSING_CORRECT_OPTION"
  | "MULTIPLE_CORRECT_OPTIONS"
  | "OPTION_TOO_SHORT"
  | "OPTION_LABEL_PREFIX_IN_TEXT"
  // EP-TRAIN-4Y-AE1 §4 (2026-11-10) — advisory finding for
  // parenthetical notes that look editorial (e.g. "(clarified by
  // manager for publication)"). NOT auto-stripped — parentheticals
  // can be legitimate; surface for manager review.
  | "SUSPECTED_EDITORIAL_ANNOTATION";

export interface QuestionStructureFinding {
  readonly code: QuestionStructureFindingCode;
  readonly message: string;
  /** Short snippet of the matched content (≤160 chars) for audit. */
  readonly matched?: string;
  /** EP-TRAIN-4Y-AE1 §4 — advisory findings do NOT block approval
   *  (the manager verifies + removes via inline edit). Defaults to
   *  false (= blocking). */
  readonly advisory?: boolean;
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

// EP-TRAIN-4Y-AE1 §3 (2026-11-10) — inline, space-separated option
// sequence on the SAME line as the question mark: "…golf club? A) foo
// B) bar C) baz D) qux". The AE EMBEDDED_OPTION_LINE_RX required a
// newline before the letter, so this single-line pattern slipped
// past. Requires AT LEAST TWO consecutive letter-prefixed chunks to
// avoid false-positive matches on sentences like "(see A) …".
const INLINE_OPTION_SEQUENCE_RX =
  /\s(?:[*_]{0,2})A(?:[*_]{0,2})\s*[)\].:]\s+.+?\s(?:[*_]{0,2})B(?:[*_]{0,2})\s*[)\].:]\s+/;

// EP-TRAIN-4Y-AE1 §4 — editorial-note parentheticals. Keywords that
// strongly suggest the parenthetical is a manager/editor annotation
// rather than legitimate question content. Matched case-insensitively.
const EDITORIAL_ANNOTATION_RX =
  /\(\s*(?:clarified|clarification|revised|edited|per manager|per founder|for publication|note:|note by)[^)]*\)/i;

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

  // Embedded option lines in the stem (newline-separated).
  const embeddedMatch = EMBEDDED_OPTION_LINE_RX.exec(stem);
  if (embeddedMatch) {
    findings.push({
      code: "EMBEDDED_OPTION_LINES_IN_STEM",
      message:
        "Question stem contains inline option lines (e.g. '\\nA) …'). Options must live only in the options array.",
      matched: embeddedMatch[0].slice(0, 160),
    });
  }

  // EP-TRAIN-4Y-AE1 §3 — inline, single-line option sequence AFTER
  // the stem's question mark.
  const inlineMatch = INLINE_OPTION_SEQUENCE_RX.exec(stem);
  if (inlineMatch) {
    findings.push({
      code: "INLINE_OPTION_SEQUENCE_IN_STEM",
      message:
        "Question stem ends with an inline option sequence (e.g. '…? A) foo B) bar …'). Options must live only in the options array.",
      matched: inlineMatch[0].slice(0, 160),
    });
  }

  // EP-TRAIN-4Y-AE1 §4 — editorial-note parentheticals (ADVISORY).
  // Never auto-stripped, never blocks approval, but surfaced to the
  // manager so an inline Edit can remove them.
  if (EDITORIAL_ANNOTATION_RX.test(stem)) {
    findings.push({
      code: "SUSPECTED_EDITORIAL_ANNOTATION",
      message: "Question stem contains a parenthetical that looks like an editorial note (e.g. '(clarified by manager for publication)'). Verify and remove if unintended.",
      matched: (EDITORIAL_ANNOTATION_RX.exec(stem)?.[0] ?? "").slice(0, 160),
      advisory: true,
    });
  }
  for (const o of options) {
    const t = String(o?.text ?? "");
    if (EDITORIAL_ANNOTATION_RX.test(t)) {
      findings.push({
        code: "SUSPECTED_EDITORIAL_ANNOTATION",
        message: "An option body contains a parenthetical that looks like an editorial note. Verify and remove if unintended.",
        matched: (EDITORIAL_ANNOTATION_RX.exec(t)?.[0] ?? "").slice(0, 160),
        advisory: true,
      });
      break;
    }
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

  // EP-TRAIN-4Y-AE1 §4 — ok reflects BLOCKING findings only.
  // Advisory findings surface alongside but don't refuse the write.
  const blocking = findings.filter((f) => f.advisory !== true);
  return { ok: blocking.length === 0, findings };
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

  // EP-TRAIN-4Y-AE1 §3 — strip "A) ... B) ... C) ... D) ..." option
  // blocks from the stem, whether newline-separated OR inline on the
  // same line as the question mark. Two passes:
  //   1. SPLIT the stem at the first letter-labeled chunk using a
  //      permissive regex (matches both "\nA) " and " A) ").
  //   2. If every chunk matches an option.text (prefix or suffix
  //      containment, length ≥ 3), cut the stem at the chunk start.
  //
  // Threshold lowered from 10 → 3 to catch short answer bodies like
  // "Mr. Judge" (9) / "Judge Sir" (9) that the AE-era normaliser
  // silently refused. The founder-reported question
  // cmwa15k3s shipped with those exact short options.
  const UNIFIED_OPTION_SPLIT_RX =
    /(?:\n|^|\s)(?:[*_]{0,2})([A-Da-d])(?:[*_]{0,2})\s*[)\].:]\s+/g;
  const firstEmbeddedMatch = UNIFIED_OPTION_SPLIT_RX.exec(stem);
  if (firstEmbeddedMatch) {
    const cut = firstEmbeddedMatch.index;
    const stemCore = stem.slice(0, cut).trim();
    const inlined = stem.slice(cut);
    const chunks = inlined
      .split(/(?:\n|^|\s)(?:[*_]{0,2})([A-Da-d])(?:[*_]{0,2})\s*[)\].:]\s+/)
      .filter((s) => s !== undefined && s !== null)
      .map((s) => String(s).trim())
      .filter((s) => s.length > 0 && !/^[A-Da-d]$/.test(s));
    const optionTextsLower = options.map((o) => o.text.toLowerCase());
    const chunkMatchesAnOption = (c: string): boolean => {
      const cl = c.toLowerCase();
      return optionTextsLower.some((ot) => {
        if (ot.length < 3) return false;
        // Chunk starts with the option body (allows a parenthetical
        // or editorial note appended to the last chunk).
        if (cl.startsWith(ot)) return true;
        // Option body starts with the chunk (chunk was truncated by
        // paragraph breaks in the stem).
        if (ot.startsWith(cl.slice(0, Math.min(ot.length, cl.length)))) return true;
        // Chunk CONTAINS the option body (prefix matched but something
        // else wraps it — defensive, still a valid match for the
        // "stem contains the option block" case).
        if (cl.includes(ot)) return true;
        return false;
      });
    };
    const everyChunkMatchesAnOption =
      chunks.length > 0 && chunks.every(chunkMatchesAnOption);
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

  // EP-TRAIN-4Y-AE2 §5 — PLACEHOLDER-LETTER RECONSTRUCTION. Covers
  // the founder-reported `cmwa2axv1` shape: options are literal
  // single letters ["A","B","C","D"] and the real option bodies live
  // in the stem as prose paragraphs after the question mark. Safe to
  // perform ONLY when:
  //   - every option is a single character A/B/C/D (no real body)
  //   - the stem contains EXACTLY the matching count of prose chunks
  //     after the "?" (so there's no ambiguity about which chunk
  //     maps to which letter)
  //   - the existing correct-answer index maps cleanly to a chunk
  //   - no chunk is longer than 400 chars (defensive: real answers
  //     are short; a very long chunk is more likely the next part of
  //     the question stem)
  //
  // Preserves correct index. Does NOT mutate isCorrect assignment.
  const allOptionsArePlaceholders =
    options.length >= 2 &&
    options.every((o) => /^[A-Da-d]$/.test(o.text.trim()));
  if (allOptionsArePlaceholders) {
    const qMark = stem.indexOf("?");
    if (qMark >= 10 && qMark < stem.length - 10) {
      const stemHead = stem.slice(0, qMark + 1).trim();
      const tail = stem.slice(qMark + 1).trim();
      // Split on \n{1,} or multiple spaces separating sentences.
      // Normalise newlines first, then split on "\n+" OR on a period
      // followed by a space when newlines aren't present.
      const chunks: string[] = [];
      if (/\n/.test(tail)) {
        for (const line of tail.split(/\n+/).map((x) => x.trim())) {
          if (line.length > 0) chunks.push(line);
        }
      } else {
        // Split on "." followed by a space + a capital letter, keeping
        // the period on the preceding chunk.
        const parts = tail.split(/(?<=\.)\s+(?=[A-Z])/);
        for (const part of parts.map((x) => x.trim())) {
          if (part.length > 0) chunks.push(part);
        }
      }
      const cleanChunks = chunks.filter((c) => c.length > 0 && c.length <= 400);
      if (cleanChunks.length === options.length) {
        stem = stemHead;
        for (let i = 0; i < options.length; i++) {
          options[i] = { text: cleanChunks[i], isCorrect: !!options[i].isCorrect };
        }
        corrected.push({
          code: "OPTION_BODY_APPEARS_IN_STEM",
          message:
            "Reconstructed placeholder options (A/B/C/D) by extracting the prose chunks after the question mark as option bodies; preserved the existing correct-answer index.",
        });
      }
    }
  }

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
