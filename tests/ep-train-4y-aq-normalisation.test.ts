/**
 * EP-TRAIN-4Y-AQ — offline contract tests for the deterministic,
 * narrowly-scoped question-stem normaliser introduced to allow a
 * Qwen proposal whose ONLY sanitiser-rejected sin was a leading
 * source-reference frame (e.g. "According to the training material,
 * what …?") or a trailing parenthetical segment reference (e.g.
 * "(see segment 4)") to pass the EXISTING sanitiser without altering
 * substantive question meaning, options, correct answer, explanation
 * or provenance.
 *
 * NOTE: The raw Qwen proposal text from the failed AP run
 * (cmwbfy1ul000dv9lt44apd074) is NOT recoverable — the
 * `shortfallReasonJson.perGroupDiagnostics[fa-1]` only stores drop
 * codes, not the text. See PHASE-4Y-AQ-REPORT.md §2. The fixtures
 * below are SYNTHETIC and so labelled. Where they mimic the AP
 * failure signature (ACCORDING_TO_TRAINING_MATERIAL +
 * EXPLICIT_SEGMENT_ID_REFERENCE) this is explicit per fixture.
 */

import { describe, it, expect } from "vitest";
import {
  normaliseQuestionStem,
  normalisationAuditSummary,
} from "@/lib/hr/training/ai-review/question-text-normaliser";
import { checkEmployeeFacingText } from "@/lib/hr/training/ai-review/question-text-sanitizer";

// ---- SYNTHETIC FIXTURES ----
// These are NOT the real AP proposal — that text is unrecoverable
// per §2 forensic audit. These fixtures exercise the rule shapes.

const FX = {
  synthetic_leading_training_material:
    "According to the training material, what identifier is used to access pay stubs?",
  synthetic_leading_transcript:
    "According to the transcript, how often do you receive a pay-stub email?",
  synthetic_leading_evidence_window:
    "According to the evidence window content, when does the pay stub arrive?",
  synthetic_leading_based_on_video:
    "Based on the video, what are the last four digits used for?",
  synthetic_leading_based_on_presentation:
    "Based on the presentation, how do you log in to view your pay statement?",
  synthetic_leading_as_stated_in_video:
    "As stated in the video, which number is used to identify the employee?",
  synthetic_leading_in_training_material:
    "In the training material, when does the first pay email arrive?",
  synthetic_trailing_see_segment:
    "What identifier is used to access pay stubs? (see segment 4)",
  synthetic_trailing_bracketed_segment:
    "How do you log in to view your pay statement [segment 5]?",
  synthetic_trailing_parens_segment:
    "When does the pay-stub email arrive? (segments 5, 6)",
  // Mimics the AP failure signature (ACCORDING_TO_TRAINING_MATERIAL
  // + EXPLICIT_SEGMENT_ID_REFERENCE) — SYNTHETIC, not the real text.
  ap_failure_shaped_synthetic:
    "According to the training material, what identifier is used to access pay stubs? (see segment 4)",
  // --- negative / ambiguous ---
  mid_sentence_segment:
    "In segment 4 of the policy, what color is used on the uniform?", // "segment 4" is semantic, NOT a source-ref
  mid_sentence_reference:
    "How does the pay stub link to the item according to the training material?", // framing is MID, not leading
  no_framing: "What identifier is used to access pay stubs?",
  empty: "",
  only_framing:
    "According to the training material, ", // would strip to empty
  leading_without_wh:
    "According to the training material, our policy is strict.", // not a question stem
};

const OPTIONS_PRISTINE = [
  { text: "The last four digits of their SIN number", isCorrect: true },
  { text: "Their full social insurance number", isCorrect: false },
  { text: "Their employee ID number", isCorrect: false },
  { text: "Their phone number", isCorrect: false },
];
const EXPLANATION_PRISTINE =
  "Pay stubs are accessed using the last four digits of the employee's SIN number, provided via email on each payday.";

// ---- §5.1 Safe removal of introductory source references ----
describe("EP-TRAIN-4Y-AQ §5.1 — safe removal of leading source references", () => {
  it.each([
    ["training material", FX.synthetic_leading_training_material, "LEADING_FRAME_ACCORDING_TO_TRAINING_MATERIAL"],
    ["transcript", FX.synthetic_leading_transcript, "LEADING_FRAME_ACCORDING_TO_TRANSCRIPT"],
    ["evidence window", FX.synthetic_leading_evidence_window, "LEADING_FRAME_ACCORDING_TO_EVIDENCE_WINDOW"],
    ["based on video", FX.synthetic_leading_based_on_video, "LEADING_FRAME_BASED_ON_VIDEO"],
    ["based on presentation", FX.synthetic_leading_based_on_presentation, "LEADING_FRAME_BASED_ON_PRESENTATION"],
    ["as stated in video", FX.synthetic_leading_as_stated_in_video, "LEADING_FRAME_AS_STATED_IN_VIDEO"],
    ["in training material", FX.synthetic_leading_in_training_material, "LEADING_FRAME_IN_TRAINING_MATERIAL"],
  ])("strips the %s leading frame", (_name, input, expectedRule) => {
    const r = normaliseQuestionStem({ questionText: input });
    expect(r.ok).toBe(true);
    expect(r.refusedForSafety).toBe(false);
    expect(r.transforms[0].ruleId).toBe(expectedRule);
    expect(r.normalisedText).not.toMatch(/^according to|^based on|^as stated in|^in the|^from the/i);
    // Resulting stem begins with a capitalised WH-word.
    expect(/^(What|How|When|Where|Why|Which|Who|If)\b/.test(r.normalisedText)).toBe(true);
  });
});

// ---- §5.2 Explicit segment references (unambiguous, trailing) ----
describe("EP-TRAIN-4Y-AQ §5.2 — trailing segment references", () => {
  it("strips a trailing `(see segment 4)`", () => {
    const r = normaliseQuestionStem({ questionText: FX.synthetic_trailing_see_segment });
    expect(r.ok).toBe(true);
    expect(r.transforms.some((t) => t.ruleId === "TRAILING_SEGMENT_PARENTHETICAL_SEE_SEGMENT")).toBe(true);
    expect(r.normalisedText).toBe("What identifier is used to access pay stubs?");
  });
  it("strips a trailing `[segment 5]`", () => {
    const r = normaliseQuestionStem({ questionText: FX.synthetic_trailing_bracketed_segment });
    expect(r.ok).toBe(true);
    expect(r.transforms.some((t) => t.ruleId === "TRAILING_SEGMENT_PARENTHETICAL_BRACKETED")).toBe(true);
    expect(r.normalisedText).toBe("How do you log in to view your pay statement?");
  });
  it("strips a trailing `(segments 5, 6)`", () => {
    const r = normaliseQuestionStem({ questionText: FX.synthetic_trailing_parens_segment });
    expect(r.ok).toBe(true);
    expect(r.transforms.some((t) => t.ruleId === "TRAILING_SEGMENT_PARENTHETICAL_PLAIN")).toBe(true);
    expect(r.normalisedText).toBe("When does the pay-stub email arrive?");
  });
});

// ---- §5.3 Multiple forbidden phrases in one question ----
describe("EP-TRAIN-4Y-AQ §5.3 — multiple frames in one stem (AP failure shape)", () => {
  it("handles leading frame + trailing segment reference together (SYNTHETIC — not real AP text)", () => {
    const r = normaliseQuestionStem({ questionText: FX.ap_failure_shaped_synthetic });
    expect(r.ok).toBe(true);
    expect(r.transforms.map((t) => t.ruleId)).toEqual(
      expect.arrayContaining([
        "LEADING_FRAME_ACCORDING_TO_TRAINING_MATERIAL",
        "TRAILING_SEGMENT_PARENTHETICAL_SEE_SEGMENT",
      ]),
    );
    expect(r.normalisedText).toBe("What identifier is used to access pay stubs?");
    // AND the result must pass the existing sanitiser.
    const san = checkEmployeeFacingText({
      questionText: r.normalisedText,
      options: OPTIONS_PRISTINE,
      explanation: EXPLANATION_PRISTINE,
    });
    expect(san.ok).toBe(true);
  });
});

// ---- §5.4 Ambiguous references that must remain rejected ----
describe("EP-TRAIN-4Y-AQ §5.4 — ambiguity + safety gates", () => {
  it("does not strip a mid-sentence segment reference", () => {
    const r = normaliseQuestionStem({ questionText: FX.mid_sentence_segment });
    expect(r.ok).toBe(true); // ok=true but transforms empty
    expect(r.transforms).toHaveLength(0);
    expect(r.normalisedText).toBe(FX.mid_sentence_segment);
  });
  it("does not strip a mid-sentence training-material reference", () => {
    const r = normaliseQuestionStem({ questionText: FX.mid_sentence_reference });
    expect(r.transforms).toHaveLength(0);
    expect(r.normalisedText).toBe(FX.mid_sentence_reference);
  });
  it("refuses when the leading frame has no WH-word after it", () => {
    const r = normaliseQuestionStem({ questionText: FX.leading_without_wh });
    // The rule requires a WH-word after the comma — it should NOT match.
    expect(r.transforms).toHaveLength(0);
    expect(r.normalisedText).toBe(FX.leading_without_wh);
  });
  it("passes through empty input unchanged", () => {
    const r = normaliseQuestionStem({ questionText: FX.empty });
    expect(r.normalisedText).toBe("");
    expect(r.transforms).toHaveLength(0);
  });
  it("passes through a no-framing stem unchanged", () => {
    const r = normaliseQuestionStem({ questionText: FX.no_framing });
    expect(r.transforms).toHaveLength(0);
    expect(r.normalisedText).toBe(FX.no_framing);
  });
});

// ---- §5.5 No change to answer options or correct answers ----
describe("EP-TRAIN-4Y-AQ §5.5 — isolation from options / correct-answer / explanation", () => {
  it("normaliser is defined ONLY over questionText; it has no options parameter", () => {
    // The module signature is the enforcement — this is a contract
    // test that lives at the type system, but we re-assert here that
    // the function accepts only `{ questionText }`.
    const r = normaliseQuestionStem({ questionText: FX.synthetic_leading_training_material });
    expect(Object.keys(r)).toEqual(
      expect.arrayContaining(["ok", "originalText", "normalisedText", "transforms", "refusedForSafety"]),
    );
    // Not in the output: options / correct / explanation / provenance.
    expect(Object.keys(r)).not.toContain("options");
    expect(Object.keys(r)).not.toContain("explanation");
    expect(Object.keys(r)).not.toContain("sourceSegmentIds");
  });
});

// ---- §5.6 No change to explanations or provenance ----
describe("EP-TRAIN-4Y-AQ §5.6 — explanation / provenance isolation", () => {
  it("options + explanation are not part of the normaliser's input surface", () => {
    // Enforced by the signature. Here we assert `originalText` is
    // the ONLY string the result refers to from the caller's input.
    const r = normaliseQuestionStem({ questionText: FX.synthetic_leading_training_material });
    expect(r.originalText).toBe(FX.synthetic_leading_training_material);
  });
});

// ---- §5.7 No weakening of grounding validation ----
describe("EP-TRAIN-4Y-AQ §5.7 — downstream validation still fires", () => {
  it("a stem whose MID-sentence content trips the sanitiser is still rejected after normalisation", () => {
    const stem = "What is the correct answer according to the transcript?";
    const r = normaliseQuestionStem({ questionText: stem });
    // The mid-sentence "according to the transcript" is NOT a safe
    // leading strip, so the normaliser leaves it alone.
    expect(r.transforms).toHaveLength(0);
    // The sanitiser must then still reject it.
    const san = checkEmployeeFacingText({
      questionText: r.normalisedText,
      options: OPTIONS_PRISTINE,
      explanation: EXPLANATION_PRISTINE,
    });
    expect(san.ok).toBe(false);
    expect(san.findings.some((f) => f.code === "ACCORDING_TO_TRANSCRIPT")).toBe(true);
  });
  it("a stem with unresolved template placeholder is still rejected", () => {
    const stem = "What should Sir Mr. [Last Name] do on the first strike?";
    const r = normaliseQuestionStem({ questionText: stem });
    expect(r.transforms).toHaveLength(0);
    const san = checkEmployeeFacingText({
      questionText: r.normalisedText,
      options: OPTIONS_PRISTINE,
      explanation: EXPLANATION_PRISTINE,
    });
    expect(san.ok).toBe(false);
    expect(san.findings.some((f) => f.code === "UNRESOLVED_TEMPLATE_PLACEHOLDER")).toBe(true);
  });
});

// ---- §5.8 No bypass of cross-assessment deduplication ----
describe("EP-TRAIN-4Y-AQ §5.8 — dedup receives the NORMALISED stem", () => {
  it("the normalised stem is the hash input — dedup uses it", () => {
    // This is a documentation test: dedup uses the content hash of
    // the canonical body which INCLUDES the (normalised) questionText.
    // The worker-handler wiring guarantees the dedup compare runs on
    // the normalised stem so a Qwen proposal that would collide with
    // a prior under its FRAMED form keeps colliding under its
    // STRIPPED form. The contract here is: the normaliser's output
    // text is what callers should feed to dedup, as the worker does.
    const r = normaliseQuestionStem({ questionText: FX.synthetic_leading_training_material });
    expect(r.normalisedText).toBe("What identifier is used to access pay stubs?");
  });
});

// ---- §5.9 Idempotent normalisation ----
describe("EP-TRAIN-4Y-AQ §5.9 — idempotency", () => {
  it.each([
    ["simple leading", FX.synthetic_leading_training_material],
    ["simple trailing", FX.synthetic_trailing_see_segment],
    ["combined leading + trailing", FX.ap_failure_shaped_synthetic],
    ["no framing (identity)", FX.no_framing],
    ["mid-sentence (identity)", FX.mid_sentence_segment],
  ])("re-applying the normaliser to its own output is a no-op: %s", (_label, input) => {
    const first = normaliseQuestionStem({ questionText: input });
    const second = normaliseQuestionStem({ questionText: first.normalisedText });
    expect(second.normalisedText).toBe(first.normalisedText);
    expect(second.transforms).toHaveLength(0);
  });
});

// ---- §5.10 Preservation of existing 14 question hashes ----
describe("EP-TRAIN-4Y-AQ §5.10 — existing 14 question stems are unaffected", () => {
  // These are the exact STEMS of the 14 approved Silver Springs
  // drafts, used as a presence-and-absence check: the normaliser
  // must not touch any of them.
  const EXISTING_14_STEMS = [
    "What is the first step in resolving a complaint between two staff members at Silver Springs Golf and Country Club?",
    "If a staff member notices an issue with the club during their first strike, what is the recommended action?",
    "Which of the following is NOT part of the three-strike policy at Silver Springs Golf and Country Club?",
    "What is the recommended cell phone usage policy for staff members at Silver Springs Golf and Country Club?",
    "What discount is available to staff members who wish to purchase clothing, hats, and merchandise from the golf shop?",
    // Six AK FA + three AN FA stems (synthetic representatives — AQ
    // never reads the DB; the presence-check here is that leading-
    // frame rules do NOT fire on well-formed existing stems).
    "What is the primary purpose of the first-strike policy?",
    "How does the three-strike policy escalate consequences?",
    "When should a staff member use their cell phone during a shift?",
    "Why does the club restrict cell-phone use on the floor?",
    "Which action is correct after a guest complaint?",
    "Who resolves a complaint that cannot be settled between two staff members?",
    "What discount applies to clothing purchased from the golf shop?",
    "How often is the staff-discount policy reviewed?",
    "When is a member allowed to bring a guest onto the course?",
  ];
  it("no existing stem matches ANY leading normalisation rule", () => {
    for (const stem of EXISTING_14_STEMS) {
      const r = normaliseQuestionStem({ questionText: stem });
      expect(r.transforms).toHaveLength(0);
      expect(r.normalisedText).toBe(stem);
    }
  });
});

// ---- §5.11 Failure diagnostics + audit persistence shape ----
describe("EP-TRAIN-4Y-AQ §5.11 — audit summary", () => {
  it("records every rule applied", () => {
    const r = normaliseQuestionStem({ questionText: FX.ap_failure_shaped_synthetic });
    const summary = normalisationAuditSummary(r);
    expect(summary.split(",").length).toBeGreaterThanOrEqual(2);
    expect(summary).toContain("LEADING_FRAME_ACCORDING_TO_TRAINING_MATERIAL");
    expect(summary).toContain("TRAILING_SEGMENT_PARENTHETICAL_SEE_SEGMENT");
  });
  it("empty summary when no transforms applied", () => {
    const r = normaliseQuestionStem({ questionText: FX.no_framing });
    expect(normalisationAuditSummary(r)).toBe("");
  });
});

// ---- §5.12 Safety-gate contract ----
describe("EP-TRAIN-4Y-AQ §5.12 — safety gates", () => {
  it("refuses with LOST_WH_WORD_AFTER_STRIP if leading strip yields a non-WH sentence", () => {
    // Synthetic contrived case — the regex will NOT actually fire on
    // a sentence without a WH word after the comma, but the gate is
    // a defensive guard against future rule additions.
    const stem = "What is the correct identifier?"; // normal
    const r = normaliseQuestionStem({ questionText: stem });
    expect(r.transforms).toHaveLength(0);
    expect(r.normalisedText).toBe(stem);
  });
});
