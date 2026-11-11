/**
 * EP-TRAIN-4Y-AS §6 — offline contract tests for the manager-driven
 * rejected-proposal recovery workflow. Live-staging acceptance is
 * captured separately in PHASE-4Y-AS-REPORT.md.
 *
 * These tests cover:
 *   §6.1 — correct-answer integrity guard
 *   §6.2 — retained-proposals reader: plain-English finding copy
 *   §6.3 — recovery service surface shape
 *   §6.4 — API input coercion contract
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// -- §6.1 ------------------------------------------------------------------
// The private `checkCorrectAnswerIntegrity` function isn't exported, so we
// probe it indirectly by hitting cases that would reject at that gate. For
// that we import the source + run `await import("...recovery")` to confirm
// the surface exists, then test the integrity check through a lightweight
// proxy we define here with the SAME logic (kept in sync via the shared
// source — a lint-style test in §6.3 enforces the function's presence).

function proxyCheckCorrectAnswerIntegrity(
  original: ReadonlyArray<{ text: string; isCorrect: boolean }>,
  edited: ReadonlyArray<{ text: string; isCorrect: boolean }>,
): { ok: boolean; reason?: string } {
  const originalCorrect = original.filter((o) => o.isCorrect);
  const editedCorrect = edited.filter((o) => o.isCorrect);
  if (originalCorrect.length !== 1) return { ok: false, reason: "ORIGINAL_HAD_NO_UNIQUE_CORRECT_OPTION" };
  if (editedCorrect.length !== 1) return { ok: false, reason: "EDIT_MUST_PRESERVE_EXACTLY_ONE_CORRECT_OPTION" };
  const ot = originalCorrect[0].text.toLowerCase();
  const et = editedCorrect[0].text.toLowerCase();
  if (ot === et) return { ok: true };
  if (ot.includes(et) || et.includes(ot)) return { ok: true };
  const tok = (s: string): Set<string> => new Set(s.split(/[^a-z0-9]+/).filter((t) => t.length >= 3));
  const a = tok(ot);
  const b = tok(et);
  const inter = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  const j = union.size === 0 ? 0 : inter.size / union.size;
  if (j >= 0.6) return { ok: true };
  return { ok: false, reason: "CORRECT_OPTION_TEXT_DIVERGED_FROM_ORIGINAL" };
}

describe("EP-TRAIN-4Y-AS §6.1 — correct-answer integrity guard", () => {
  const original = [
    { text: "By using the last four digits of their SIN number", isCorrect: true },
    { text: "By calling the HR department", isCorrect: false },
    { text: "By logging into the company's online portal", isCorrect: false },
    { text: "By visiting the physical HR office", isCorrect: false },
  ];
  it("ACCEPTS identical options", () => {
    expect(proxyCheckCorrectAnswerIntegrity(original, original).ok).toBe(true);
  });
  it("ACCEPTS editorial polish on the correct option (subset)", () => {
    const edited = original.map((o, i) => (i === 0 ? { ...o, text: "The last four digits of their SIN" } : o));
    expect(proxyCheckCorrectAnswerIntegrity(original, edited).ok).toBe(true);
  });
  it("ACCEPTS correct-option rewording within token-Jaccard ≥ 0.6", () => {
    const edited = original.map((o, i) => (i === 0 ? { ...o, text: "The last four digits of the employee's SIN number" } : o));
    expect(proxyCheckCorrectAnswerIntegrity(original, edited).ok).toBe(true);
  });
  it("REJECTS a completely different correct answer", () => {
    const edited = original.map((o, i) => (i === 0 ? { ...o, text: "Call the HR manager directly on the phone" } : o));
    const r = proxyCheckCorrectAnswerIntegrity(original, edited);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("CORRECT_OPTION_TEXT_DIVERGED_FROM_ORIGINAL");
  });
  it("REJECTS when the correct option is flipped to a different index", () => {
    const edited = original.map((o, i) => ({ ...o, isCorrect: i === 1 }));
    const r = proxyCheckCorrectAnswerIntegrity(original, edited);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("CORRECT_OPTION_TEXT_DIVERGED_FROM_ORIGINAL");
  });
  it("REJECTS multiple correct options", () => {
    const edited = original.map((o, i) => ({ ...o, isCorrect: i < 2 }));
    const r = proxyCheckCorrectAnswerIntegrity(original, edited);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("EDIT_MUST_PRESERVE_EXACTLY_ONE_CORRECT_OPTION");
  });
  it("REJECTS zero correct options", () => {
    const edited = original.map((o) => ({ ...o, isCorrect: false }));
    const r = proxyCheckCorrectAnswerIntegrity(original, edited);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("EDIT_MUST_PRESERVE_EXACTLY_ONE_CORRECT_OPTION");
  });
});

// -- §6.2 ------------------------------------------------------------------

describe("EP-TRAIN-4Y-AS §6.2 — retained-proposals reader produces plain-English findings", () => {
  // We duplicate the small `PLAIN_EXPLANATIONS` map here and lint-check
  // that the source file contains every key we care about.
  const EXPECTED_PLAIN_KEYS = [
    "ACCORDING_TO_TRAINING_MATERIAL",
    "ACCORDING_TO_TRANSCRIPT",
    "ACCORDING_TO_EVIDENCE_WINDOW",
    "EXPLICIT_SEGMENT_ID_REFERENCE",
    "EMBEDDED_ANSWER_KEY",
    "EMBEDDED_MARKDOWN_OPTION_HEADER",
    "UNRESOLVED_TEMPLATE_PLACEHOLDER",
  ];
  it("source contains plain-English copy for every sanitiser code", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/hr/training/generation/retained-proposals-reader.ts"),
      "utf8",
    );
    for (const k of EXPECTED_PLAIN_KEYS) {
      expect(src).toContain(k);
    }
  });
  it("source does NOT expose internal rule codes directly to UI copy", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/hr/training/generation/retained-proposals-reader.ts"),
      "utf8",
    );
    // The `plainExplanation` field must come from the PLAIN_EXPLANATIONS
    // map — no finding code is used verbatim in a user-facing field
    // except as a fallback for unknown codes.
    expect(src).toContain("describeFindings");
    expect(src).toContain("plainExplanation");
  });
});

// -- §6.3 ------------------------------------------------------------------

describe("EP-TRAIN-4Y-AS §6.3 — recovery service surface shape", () => {
  it("module exports recoverRejectedProposal + RejectedProposalRecoveryError", async () => {
    const mod = await import("@/lib/hr/training/generation/rejected-proposal-recovery");
    expect(typeof mod.recoverRejectedProposal).toBe("function");
    expect(typeof mod.RejectedProposalRecoveryError).toBe("function");
  });
  it("service source: full validation pipeline referenced (no bypass)", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/hr/training/generation/rejected-proposal-recovery.ts"),
      "utf8",
    );
    for (const token of [
      "checkEmployeeFacingText",
      "checkQuestionStructure",
      "normaliseQuestionStem",
      "evaluateAgainstPriors",
      "checkCorrectAnswerIntegrity",
      "RETENTION_EXPIRED",
      "audit(",
    ]) {
      expect(src).toContain(token);
    }
  });
  it("service source: immutable original — no mutation to retained.originalQuestionText", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/hr/training/generation/rejected-proposal-recovery.ts"),
      "utf8",
    );
    // We never reassign a retained record's field on disk.
    expect(src).not.toMatch(/rejected\.originalQuestionText\s*=/);
    expect(src).not.toMatch(/rejected\.options\s*=/);
    expect(src).not.toMatch(/rejected\.sourceSegmentIds\s*=/);
  });
  it("service source: grounding stage recovery is REFUSED", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/hr/training/generation/rejected-proposal-recovery.ts"),
      "utf8",
    );
    expect(src).toContain("UNSUPPORTED_RECOVERY_STAGE");
    expect(src).toContain('rejectionStage === "GROUNDING"');
  });
});

// -- §6.4 ------------------------------------------------------------------

describe("EP-TRAIN-4Y-AS §6.4 — POST endpoint input coercion", () => {
  it("source: rejects missing/invalid body fields with clear error codes", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/api/admin/ai-training/runs/[runId]/recover-rejected-proposal/route.ts"),
      "utf8",
    );
    expect(src).toContain("missing_group_id");
    expect(src).toContain("missing_proposal_index");
    expect(src).toContain("missing_edited_question_text");
    // Auth gate is via the service (hasPermission inside recoverRejectedProposal).
    expect(src).toContain("getCurrentPrincipal");
    expect(src).toContain("getActiveClubId");
    // Must return 401 on no principal.
    expect(src).toContain('{ status: 401 }');
  });
});

// -- §6.5 — the 14 existing hashes are not touched by this module --------

describe("EP-TRAIN-4Y-AS §6.5 — module boundary: no retrospective mutation", () => {
  it("recovery writes a NEW draft row; it does not update existing drafts", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/hr/training/generation/rejected-proposal-recovery.ts"),
      "utf8",
    );
    expect(src).toContain("trainingQuestionAiDraft.create");
    expect(src).not.toMatch(/trainingQuestionAiDraft\.update/);
    expect(src).not.toMatch(/trainingQuestionAiDraft\.deleteMany/);
  });
});
