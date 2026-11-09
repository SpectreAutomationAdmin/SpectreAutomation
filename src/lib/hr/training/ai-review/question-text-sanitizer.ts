// EP-TRAIN-4Y-AA §7 — employee-facing question-text sanitiser.
//
// The pilot run (cmw9rrl1g000rj41xaoxvzqbb, 2026-11-09) produced 5
// checkpoint drafts whose questionText leaked internal pipeline
// terminology into the employee-facing rendering, e.g.:
//
//   "According to the transcript, what is the correct way to …"
//   "… according to the transcript segments [15] and [18]?"
//   "… according to the evidence window content?"
//   "… *Segment IDs: [22, 28]*"
//   "**Correct Answer:** C"
//   "Sir Mr. [Last Name]"
//
// The provenance of a draft (its `sourceSegmentIds`, its grounding
// projection sha, the segments the validator cites) lives on the
// draft row and its validation rows. It must NOT also live inside
// the questionText the employee reads.
//
// This module provides a pure, deterministic check that detects the
// above patterns. It is consumed at two seams:
//
//   1. worker-handler.ts — at proposal-persist time. A proposal
//      whose questionText trips any pattern is dropped BEFORE the
//      draft row is created (counted in the per-group diagnostic
//      `textSanitizerDroppedCount`). This keeps the pattern out of
//      the DB for all FUTURE generations.
//
//   2. validation-pipeline — as an additional hard-error check so
//      any draft that managed to slip through pre-AA code paths is
//      caught at approve-time (REJECTED verdict; manager cannot
//      promote).
//
// This file is OFFLINE — pure functions, no I/O, no DB, no secrets.

export interface SanitizerFinding {
  /** Short, stable slug for the pattern class. */
  readonly code:
    | "ACCORDING_TO_TRANSCRIPT"
    | "ACCORDING_TO_EVIDENCE_WINDOW"
    | "ACCORDING_TO_TRAINING_MATERIAL"
    | "EXPLICIT_SEGMENT_ID_REFERENCE"
    | "EMBEDDED_ANSWER_KEY"
    | "EMBEDDED_MARKDOWN_OPTION_HEADER"
    | "UNRESOLVED_TEMPLATE_PLACEHOLDER";
  /** One-line description for logging / audit. */
  readonly message: string;
  /** The exact substring that matched (truncated to 160 chars). */
  readonly matched: string;
}

export interface SanitizerResult {
  readonly ok: boolean;
  readonly findings: readonly SanitizerFinding[];
}

/** Patterns checked, in deterministic order. Ordering is important
 *  for test stability and audit logging. Each pattern is
 *  intentionally narrow — we do NOT reject every mention of the word
 *  "transcript"; we reject the specific internal-leakage phrasings
 *  observed in the 4Y-Z pilot and classed as "internal pipeline
 *  terminology" in the directive. */
const PATTERNS: ReadonlyArray<{
  readonly code: SanitizerFinding["code"];
  readonly regex: RegExp;
  readonly message: string;
}> = [
  // "According to the transcript …" / "according to the transcript
  // segments [15] and [18]" — the exemplar case from §7.
  {
    code: "ACCORDING_TO_TRANSCRIPT",
    // Deliberately matches both bare and bracketed forms.
    regex: /\baccording to (?:the )?transcript\b/i,
    message: "Employee-facing text references the internal transcript.",
  },
  // "according to the evidence window content" — the plan's
  // windowing concept leaking through.
  {
    code: "ACCORDING_TO_EVIDENCE_WINDOW",
    regex: /\baccording to (?:the )?evidence window\b/i,
    message: "Employee-facing text references the internal evidence window.",
  },
  // "according to the training material" — generic but still
  // internal framing. Matches singular + plural + possessive.
  {
    code: "ACCORDING_TO_TRAINING_MATERIAL",
    regex: /\baccording to (?:the )?training materials?\b/i,
    message: "Employee-facing text references the internal training material.",
  },
  // Explicit segment-id references anywhere in the text:
  //   "transcript segments [15] and [18]"
  //   "Segment IDs: [22, 28]"
  //   "*Segment IDs:*"
  //   "(see segments 15, 18)"
  //   "segment 15"
  {
    code: "EXPLICIT_SEGMENT_ID_REFERENCE",
    regex: /\b(?:transcript\s+)?segments?\b.*?(?:\[\s*\d+(?:\s*,\s*\d+)*\s*\]|\bids?\b|\d+)/i,
    message:
      "Employee-facing text names source segments explicitly — segment ids belong in provenance, not in the question.",
  },
  // Markdown "Correct Answer:" / "Answer:" written into the question
  // body. The option row already carries the correct marker.
  {
    code: "EMBEDDED_ANSWER_KEY",
    // Allow optional surrounding markdown bold/italic + colon.
    regex: /\*{0,2}\s*correct\s+answer\s*\*{0,2}\s*:/i,
    message: "Question text embeds its own answer key.",
  },
  // Markdown option headers embedded in the question text, e.g.
  // `**A)** Discuss …`. These collide with the proper options array.
  {
    code: "EMBEDDED_MARKDOWN_OPTION_HEADER",
    regex: /\*{1,2}[A-D]\)\*{1,2}/,
    message: "Question text embeds markdown option headers instead of using the options array.",
  },
  // Unresolved template placeholders the model left in:
  //   "Sir Mr. [Last Name]"
  //   "Dear [Member Name]"
  //   "[Employee Last Name]"
  // A capitalised word (or two) inside square brackets with no
  // digits — distinct from segment-id brackets which are numeric.
  {
    code: "UNRESOLVED_TEMPLATE_PLACEHOLDER",
    regex: /\[(?!\s*\d)[A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*){0,2}\]/,
    message: "Text contains an unresolved template placeholder (e.g. [Last Name]).",
  },
];

/**
 * Run every pattern against every string field a reviewer / employee
 * can see for a question — the questionText itself PLUS every option
 * text (the model sometimes leaks internal phrasing into an option
 * body instead of the stem).
 *
 * `ok` is `true` iff zero findings. `findings` lists each matched
 * pattern once per matched string; the same pattern against two
 * different option strings yields two findings so audit logs can
 * tell where the leakage landed.
 */
export function checkEmployeeFacingText(input: {
  readonly questionText: string;
  readonly options?: ReadonlyArray<{ readonly text: string }>;
  readonly explanation?: string | null | undefined;
}): SanitizerResult {
  const findings: SanitizerFinding[] = [];
  const check = (text: string | null | undefined): void => {
    if (!text) return;
    for (const p of PATTERNS) {
      const m = p.regex.exec(text);
      if (m) {
        findings.push({
          code: p.code,
          message: p.message,
          matched: m[0].slice(0, 160),
        });
      }
    }
  };
  check(input.questionText);
  for (const o of input.options ?? []) check(o.text);
  check(input.explanation ?? null);
  return { ok: findings.length === 0, findings };
}

/**
 * Convenience: return a compact, canonical-order string of unique
 * finding codes suitable for appending to a validation errorsJson
 * or a per-group diagnostic row. Stable across invocations with the
 * same input — important for audit and test determinism.
 */
export function codesForAudit(result: SanitizerResult): string {
  if (result.ok) return "";
  const seen = new Set<string>();
  for (const f of result.findings) seen.add(f.code);
  return Array.from(seen).sort().join(",");
}
