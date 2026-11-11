// EP-TRAIN-4Y-AQ §3 — deterministic, auditable, narrowly-scoped
// question-stem normaliser.
//
// Purpose: strip unambiguous leading source-reference FRAMING from a
// question stem so that a technically-grounded Qwen proposal whose
// ONLY sanitiser-rejected sin was the leading phrase
// "According to the training material, …" or a trailing parenthetical
// "(see segment 4)" can pass the existing sanitiser without altering
// substantive question meaning, answer options, correct answer,
// explanation, or provenance.
//
// What this module DOES do:
//
//   - Strip a narrow, explicit allow-list of LEADING prefixes that act
//     as pure framing on an otherwise self-contained question. Each
//     rule requires a trailing ", " + a WH-word (what|how|when|where|
//     why|which|who|if) so a rule only fires when the sentence after
//     the prefix is itself a well-formed question stem.
//   - Strip a narrow, explicit allow-list of TRAILING parenthetical /
//     bracketed segment references attached to the end of the stem.
//     These are adornments the model sometimes appends, never
//     semantically load-bearing.
//
// What this module DOES NOT do:
//
//   - Touch options, correct-answer identity, explanation, learning
//     objective, assessment destination, sourceSegmentIds, provenance,
//     or ANY other field. questionText only.
//   - Rewrite mid-sentence references, paraphrase, or re-tense.
//   - Weaken or replace the existing sanitiser. Normalisation runs
//     BEFORE the sanitiser; whatever remains after normalisation must
//     still pass the full existing validation pipeline.
//   - Normalise anything matching MORE THAN ONE leading-frame rule
//     (that pattern signals a confused / recursive stem — we
//     fail-closed and leave the original text for the sanitiser to
//     reject).
//   - Fire recursively. The output is guaranteed idempotent: feeding
//     the normalised text back in produces zero transformations.
//     An idempotency violation forces a safe-fail return of the
//     ORIGINAL input with an `idempotencyViolation: true` flag.
//
// This file is OFFLINE — pure functions, no I/O, no DB, no secrets.

export interface NormalisationTransform {
  readonly ruleId:
    | "LEADING_FRAME_ACCORDING_TO_TRAINING_MATERIAL"
    | "LEADING_FRAME_ACCORDING_TO_TRANSCRIPT"
    | "LEADING_FRAME_ACCORDING_TO_EVIDENCE_WINDOW"
    | "LEADING_FRAME_AS_STATED_IN_VIDEO"
    | "LEADING_FRAME_AS_STATED_IN_PRESENTATION"
    | "LEADING_FRAME_AS_STATED_IN_TRANSCRIPT"
    | "LEADING_FRAME_AS_STATED_IN_TRAINING_MATERIAL"
    | "LEADING_FRAME_BASED_ON_VIDEO"
    | "LEADING_FRAME_BASED_ON_PRESENTATION"
    | "LEADING_FRAME_BASED_ON_TRANSCRIPT"
    | "LEADING_FRAME_BASED_ON_TRAINING_MATERIAL"
    | "LEADING_FRAME_IN_VIDEO"
    | "LEADING_FRAME_IN_PRESENTATION"
    | "LEADING_FRAME_IN_TRAINING_MATERIAL"
    | "LEADING_FRAME_FROM_TRAINING_MATERIAL"
    | "TRAILING_SEGMENT_PARENTHETICAL_SEE_SEGMENT"
    | "TRAILING_SEGMENT_PARENTHETICAL_BRACKETED"
    | "TRAILING_SEGMENT_PARENTHETICAL_PLAIN";
  readonly position: "leading" | "trailing";
  /** The exact substring that was removed/transformed (truncated 160). */
  readonly beforeSlice: string;
  /** The exact replacement that was substituted (truncated 160). */
  readonly afterSlice: string;
}

export interface NormalisationResult {
  readonly ok: boolean;
  /** Original question text, unchanged. */
  readonly originalText: string;
  /** Text after all safe transforms applied. Equal to originalText
   *  when no rule fired or when a safety gate refused. */
  readonly normalisedText: string;
  /** Ordered list of transforms applied (empty when no change). */
  readonly transforms: readonly NormalisationTransform[];
  /** True when the normaliser refused to transform for a safety
   *  reason (multiple competing leading rules, idempotency violation,
   *  etc.). Caller treats the proposal as if normalisation had done
   *  nothing — sanitiser then decides. */
  readonly refusedForSafety: boolean;
  /** Specific safety-refusal reason when refusedForSafety === true. */
  readonly refusalReason?:
    | "MULTIPLE_COMPETING_LEADING_RULES"
    | "IDEMPOTENCY_VIOLATION"
    | "EMPTY_AFTER_NORMALISATION"
    | "LOST_WH_WORD_AFTER_STRIP";
}

const WH = "(?:what|how|when|where|why|which|who|if)";

/** Each leading rule MUST end with ", " + WH-word so the sentence
 *  after the prefix is itself a well-formed question stem. We also
 *  tolerate a leading space + capitalise-anchor to avoid matching
 *  mid-sentence. */
const LEADING_RULES: ReadonlyArray<{
  readonly ruleId: NormalisationTransform["ruleId"];
  readonly regex: RegExp;
}> = [
  {
    ruleId: "LEADING_FRAME_ACCORDING_TO_TRAINING_MATERIAL",
    regex: new RegExp(`^\\s*According to (?:the )?training materials?,\\s+(${WH})\\b`, "i"),
  },
  {
    ruleId: "LEADING_FRAME_ACCORDING_TO_TRANSCRIPT",
    regex: new RegExp(`^\\s*According to (?:the )?transcript,\\s+(${WH})\\b`, "i"),
  },
  {
    ruleId: "LEADING_FRAME_ACCORDING_TO_EVIDENCE_WINDOW",
    regex: new RegExp(`^\\s*According to (?:the )?evidence window(?:\\s+content)?,\\s+(${WH})\\b`, "i"),
  },
  {
    ruleId: "LEADING_FRAME_AS_STATED_IN_VIDEO",
    regex: new RegExp(`^\\s*As stated in (?:the )?video,\\s+(${WH})\\b`, "i"),
  },
  {
    ruleId: "LEADING_FRAME_AS_STATED_IN_PRESENTATION",
    regex: new RegExp(`^\\s*As stated in (?:the )?presentation,\\s+(${WH})\\b`, "i"),
  },
  {
    ruleId: "LEADING_FRAME_AS_STATED_IN_TRANSCRIPT",
    regex: new RegExp(`^\\s*As stated in (?:the )?transcript,\\s+(${WH})\\b`, "i"),
  },
  {
    ruleId: "LEADING_FRAME_AS_STATED_IN_TRAINING_MATERIAL",
    regex: new RegExp(`^\\s*As stated in (?:the )?training materials?,\\s+(${WH})\\b`, "i"),
  },
  {
    ruleId: "LEADING_FRAME_BASED_ON_VIDEO",
    regex: new RegExp(`^\\s*Based on (?:the )?video,\\s+(${WH})\\b`, "i"),
  },
  {
    ruleId: "LEADING_FRAME_BASED_ON_PRESENTATION",
    regex: new RegExp(`^\\s*Based on (?:the )?presentation,\\s+(${WH})\\b`, "i"),
  },
  {
    ruleId: "LEADING_FRAME_BASED_ON_TRANSCRIPT",
    regex: new RegExp(`^\\s*Based on (?:the )?transcript,\\s+(${WH})\\b`, "i"),
  },
  {
    ruleId: "LEADING_FRAME_BASED_ON_TRAINING_MATERIAL",
    regex: new RegExp(`^\\s*Based on (?:the )?training materials?,\\s+(${WH})\\b`, "i"),
  },
  {
    ruleId: "LEADING_FRAME_IN_VIDEO",
    regex: new RegExp(`^\\s*In (?:the )?video,\\s+(${WH})\\b`, "i"),
  },
  {
    ruleId: "LEADING_FRAME_IN_PRESENTATION",
    regex: new RegExp(`^\\s*In (?:the )?presentation,\\s+(${WH})\\b`, "i"),
  },
  {
    ruleId: "LEADING_FRAME_IN_TRAINING_MATERIAL",
    regex: new RegExp(`^\\s*In (?:the )?training materials?,\\s+(${WH})\\b`, "i"),
  },
  {
    ruleId: "LEADING_FRAME_FROM_TRAINING_MATERIAL",
    regex: new RegExp(`^\\s*From (?:the )?training materials?,\\s+(${WH})\\b`, "i"),
  },
];

/** Trailing adornments only. Each rule ANCHORS at the end of the stem
 *  (optional trailing ? or . kept so the sentence punctuation is
 *  preserved). Rules run after all leading rules. */
const TRAILING_RULES: ReadonlyArray<{
  readonly ruleId: NormalisationTransform["ruleId"];
  readonly regex: RegExp;
}> = [
  {
    ruleId: "TRAILING_SEGMENT_PARENTHETICAL_SEE_SEGMENT",
    regex: /\s*\(\s*see segments?\s+\d+(?:\s*,\s*\d+)*\s*\)(?=\s*[?.]?\s*$)/i,
  },
  {
    ruleId: "TRAILING_SEGMENT_PARENTHETICAL_BRACKETED",
    regex: /\s*\[\s*segments?\s+\d+(?:\s*,\s*\d+)*\s*\](?=\s*[?.]?\s*$)/i,
  },
  {
    ruleId: "TRAILING_SEGMENT_PARENTHETICAL_PLAIN",
    regex: /\s*\(\s*segments?\s+\d+(?:\s*,\s*\d+)*\s*\)(?=\s*[?.]?\s*$)/i,
  },
];

function capitaliseFirstLetter(text: string): string {
  if (text.length === 0) return text;
  // Preserve a leading quote / bracket if present.
  const first = text[0];
  if (/[A-Z]/.test(first)) return text;
  if (/[a-z]/.test(first)) return first.toUpperCase() + text.slice(1);
  return text;
}

function applyLeadingRulesOnce(stem: string): {
  text: string;
  transform: NormalisationTransform | null;
  competingMatches: number;
} {
  let hit: { ruleId: NormalisationTransform["ruleId"]; match: RegExpExecArray } | null = null;
  let competing = 0;
  for (const r of LEADING_RULES) {
    const m = r.regex.exec(stem);
    if (m) {
      competing++;
      if (!hit) hit = { ruleId: r.ruleId, match: m };
    }
  }
  if (!hit) return { text: stem, transform: null, competingMatches: 0 };
  // The matched prefix ends at `hit.match[0].length` BUT includes the
  // WH-word in the lookahead-less capture. We strip only the framing
  // portion before the WH-word, then capitalise.
  const whWord = hit.match[1];
  const whStart = stem.toLowerCase().indexOf(whWord.toLowerCase(), hit.match.index);
  const removed = stem.slice(0, whStart);
  const rest = stem.slice(whStart);
  const normalised = capitaliseFirstLetter(rest);
  return {
    text: normalised,
    transform: {
      ruleId: hit.ruleId,
      position: "leading",
      beforeSlice: removed.slice(0, 160),
      afterSlice: "".slice(0, 160),
    },
    competingMatches: competing,
  };
}

function applyTrailingRulesAll(stem: string): {
  text: string;
  transforms: NormalisationTransform[];
} {
  let current = stem;
  const applied: NormalisationTransform[] = [];
  // Deterministic order. Repeat until no rule fires — but with a
  // bounded loop to guarantee termination even against pathological
  // input.
  let iteration = 0;
  const MAX = 4;
  while (iteration < MAX) {
    let changedThisRound = false;
    for (const r of TRAILING_RULES) {
      const m = r.regex.exec(current);
      if (m) {
        const before = current;
        current = current.replace(r.regex, "");
        applied.push({
          ruleId: r.ruleId,
          position: "trailing",
          beforeSlice: (before.match(r.regex)?.[0] ?? "").slice(0, 160),
          afterSlice: "".slice(0, 160),
        });
        changedThisRound = true;
        break;
      }
    }
    if (!changedThisRound) break;
    iteration++;
  }
  return { text: current, transforms: applied };
}

/**
 * Narrowly-scoped deterministic question-stem normaliser.
 *
 * Returns the original text unchanged under any of:
 *   - No rule matches.
 *   - Two or more LEADING rules match the same input (ambiguity).
 *   - Normalisation would leave an empty stem.
 *   - Normalisation would strip the WH-word (safety gate).
 *   - Feeding the normalised text back in produces further transforms
 *     (idempotency violation).
 *
 * The caller passes the result to the EXISTING sanitiser. If the
 * sanitiser still finds a violation, the proposal remains rejected.
 */
export function normaliseQuestionStem(input: {
  readonly questionText: string;
}): NormalisationResult {
  const original = input.questionText;
  const transforms: NormalisationTransform[] = [];

  // 1. Leading (only once — not recursive — see MULTIPLE_COMPETING).
  const leading = applyLeadingRulesOnce(original);
  if (leading.competingMatches > 1) {
    return {
      ok: false,
      originalText: original,
      normalisedText: original,
      transforms: [],
      refusedForSafety: true,
      refusalReason: "MULTIPLE_COMPETING_LEADING_RULES",
    };
  }
  let current = leading.text;
  if (leading.transform) transforms.push(leading.transform);

  // 2. Trailing (iterated to a fixed point, deterministic).
  const trailing = applyTrailingRulesAll(current);
  current = trailing.text;
  transforms.push(...trailing.transforms);

  // 3. Safety gates.
  const stripped = current.trim();
  if (stripped.length === 0) {
    return {
      ok: false,
      originalText: original,
      normalisedText: original,
      transforms: [],
      refusedForSafety: true,
      refusalReason: "EMPTY_AFTER_NORMALISATION",
    };
  }
  // The stem must still start with a WH-word (or a capital letter that
  // the WH regex can see). If the leading strip somehow removed it,
  // refuse.
  if (transforms.some((t) => t.position === "leading")) {
    if (!new RegExp(`^${WH}\\b`, "i").test(stripped)) {
      return {
        ok: false,
        originalText: original,
        normalisedText: original,
        transforms: [],
        refusedForSafety: true,
        refusalReason: "LOST_WH_WORD_AFTER_STRIP",
      };
    }
  }

  // 4. Idempotency check. Feed the result back through — if any rule
  // fires, we return the ORIGINAL unchanged.
  const recheck = applyLeadingRulesOnce(current);
  const retrailing = applyTrailingRulesAll(recheck.text);
  if (recheck.transform || retrailing.transforms.length > 0) {
    return {
      ok: false,
      originalText: original,
      normalisedText: original,
      transforms: [],
      refusedForSafety: true,
      refusalReason: "IDEMPOTENCY_VIOLATION",
    };
  }

  return {
    ok: true,
    originalText: original,
    normalisedText: current,
    transforms,
    refusedForSafety: false,
  };
}

/** Compact, canonical-order string of rule ids for audit rows. */
export function normalisationAuditSummary(result: NormalisationResult): string {
  if (!result.ok || result.transforms.length === 0) return "";
  const seen = new Set<string>();
  for (const t of result.transforms) seen.add(t.ruleId);
  return Array.from(seen).sort().join(",");
}
