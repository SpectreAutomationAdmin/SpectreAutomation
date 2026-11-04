// EP-TRAIN-6D-3 — unit tests for the approval guard.
//
// Covers every §3 blocking case + the §8 regression requirements:
//
//   §3 blocking cases:
//     - verdict REJECTED
//     - unresolved hard errors
//     - validation missing
//     - validation pending / failed / unknown
//     - validation stale (edited after last validation)
//
//   §8 regression:
//     - rejected candidate cannot be approved
//     - candidate with unresolved hard errors cannot be approved
//     - edited candidate cannot be approved using stale validation
//     - missing validation fails closed
//     - advisory flags alone do NOT block approval

import { describe, expect, it } from "vitest";
import {
  evaluateApproval,
  type ApprovalBlockReason,
} from "@/components/ai-training/approval-guard";
import type { PipelineResult } from "@/lib/training/ai-generation";

function cleanResult(): PipelineResult {
  return {
    verdict: "GROUNDED",
    stage: "VALIDATE",
    proposal: null,
    propagatedSourceOrgFlags: [],
    errors: [],
    warnings: [],
    flags: [],
  };
}
function rhvResult(flags: string[] = ["FLAG_UNSUPPORTED_ANSWER_WORDS"]): PipelineResult {
  return { ...cleanResult(), verdict: "REQUIRES_HUMAN_VERIFICATION", flags };
}
function rejectedResult(errorCodes: string[] = ["ERR_CITATION_SEGMENT_UNAUTHORIZED"]): PipelineResult {
  return {
    ...cleanResult(),
    verdict: "REJECTED",
    errors: errorCodes.map((code) => ({ code, message: `test ${code}`, detail: {} })),
  };
}

function reasons(input: Parameters<typeof evaluateApproval>[0]): ApprovalBlockReason[] {
  return [...evaluateApproval(input).reasons];
}

describe("EP-TRAIN-6D-3 approval guard — status checks", () => {
  it("unknown status → blocked (VALIDATION_STATUS_UNKNOWN)", () => {
    const d = evaluateApproval({ latestValidation: null, validationStatus: "unknown" });
    expect(d.allowed).toBe(false);
    expect(d.reasons).toContain("VALIDATION_STATUS_UNKNOWN");
    expect(d.message).toMatch(/validation state is unknown/i);
  });

  it("pending status → blocked (VALIDATION_PENDING)", () => {
    const d = evaluateApproval({ latestValidation: null, validationStatus: "pending" });
    expect(d.allowed).toBe(false);
    expect(d.reasons).toContain("VALIDATION_PENDING");
  });

  it("failed status → blocked (VALIDATION_FAILED)", () => {
    const d = evaluateApproval({ latestValidation: null, validationStatus: "failed" });
    expect(d.allowed).toBe(false);
    expect(d.reasons).toContain("VALIDATION_FAILED");
  });

  it("stale status with otherwise-clean validation → blocked (VALIDATION_STALE)", () => {
    const d = evaluateApproval({ latestValidation: cleanResult(), validationStatus: "stale" });
    expect(d.allowed).toBe(false);
    expect(d.reasons).toContain("VALIDATION_STALE");
    expect(d.message).toMatch(/content was edited.*re-run validation/i);
  });
});

describe("EP-TRAIN-6D-3 approval guard — payload checks", () => {
  it("complete status but missing validation → blocked (VALIDATION_MISSING)", () => {
    const d = evaluateApproval({ latestValidation: null, validationStatus: "complete" });
    expect(d.allowed).toBe(false);
    expect(d.reasons).toContain("VALIDATION_MISSING");
  });

  it("complete + verdict REJECTED → blocked (VERDICT_REJECTED)", () => {
    const d = evaluateApproval({ latestValidation: rejectedResult(), validationStatus: "complete" });
    expect(d.allowed).toBe(false);
    expect(d.reasons).toContain("VERDICT_REJECTED");
    expect(d.message).toMatch(/verdict is REJECTED/i);
  });

  it("complete + REQUIRES_HUMAN_VERIFICATION + no errors → ALLOWED (advisory flags do not block)", () => {
    const d = evaluateApproval({ latestValidation: rhvResult(["FLAG_UNSUPPORTED_ANSWER_WORDS", "SOURCE_ORG_MISMATCH"]), validationStatus: "complete" });
    expect(d.allowed).toBe(true);
    expect(d.reasons).toHaveLength(0);
    expect(d.message).toBe("");
  });

  it("complete + GROUNDED → ALLOWED", () => {
    const d = evaluateApproval({ latestValidation: cleanResult(), validationStatus: "complete" });
    expect(d.allowed).toBe(true);
  });
});

describe("EP-TRAIN-6D-3 approval guard — stacked reasons", () => {
  it("stale + REJECTED payload → both reasons surface (stale wins first message)", () => {
    const d = evaluateApproval({ latestValidation: rejectedResult(), validationStatus: "stale" });
    expect(d.allowed).toBe(false);
    expect(d.reasons).toContain("VALIDATION_STALE");
    expect(d.reasons).toContain("VERDICT_REJECTED");
    // The first reason wins the inline message.
    expect(d.message).toMatch(/content was edited/i);
  });

  it("pending + missing payload → both reasons", () => {
    const d = evaluateApproval({ latestValidation: null, validationStatus: "pending" });
    expect(d.allowed).toBe(false);
    expect(d.reasons).toContain("VALIDATION_PENDING");
    expect(d.reasons).toContain("VALIDATION_MISSING");
  });
});

describe("EP-TRAIN-6D-3 approval guard — §8 regression cases", () => {
  it("regression: rejected candidate cannot be approved", () => {
    const d = evaluateApproval({ latestValidation: rejectedResult(), validationStatus: "complete" });
    expect(d.allowed).toBe(false);
  });

  it("regression: unresolved hard error (even with non-REJECTED verdict) cannot be approved", () => {
    // Pipeline contract normally forces REJECTED when errors.length > 0, but
    // the guard defends against any future contract drift.
    const quirky: PipelineResult = {
      ...cleanResult(),
      verdict: "REQUIRES_HUMAN_VERIFICATION",
      errors: [{ code: "ERR_HYPOTHETICAL", message: "test", detail: {} }],
    };
    const d = evaluateApproval({ latestValidation: quirky, validationStatus: "complete" });
    expect(d.allowed).toBe(false);
    expect(d.reasons).toContain("UNRESOLVED_HARD_ERRORS");
  });

  it("regression: edited candidate cannot be approved using stale validation", () => {
    const d = evaluateApproval({ latestValidation: rhvResult(), validationStatus: "stale" });
    expect(d.allowed).toBe(false);
    expect(reasons({ latestValidation: rhvResult(), validationStatus: "stale" })).toContain("VALIDATION_STALE");
  });

  it("regression: missing validation fails closed", () => {
    const d = evaluateApproval({ latestValidation: null, validationStatus: "complete" });
    expect(d.allowed).toBe(false);
    expect(d.reasons).toContain("VALIDATION_MISSING");
  });

  it("regression: advisory flags alone do NOT block approval", () => {
    // Exhaustive — every advisory flag code we know about should be OK
    // when verdict is RHV + no hard errors.
    const flags = [
      "FLAG_UNSUPPORTED_ANSWER_WORDS",
      "SOURCE_ORG_MISMATCH",
      "FLAG_PRESCRIPTIVE_INSERTION",
      "FLAG_UNSUPPORTED_QUANTITY",
      "FLAG_POTENTIAL_INVENTED_POLICY_TERM",
    ];
    const d = evaluateApproval({ latestValidation: rhvResult(flags), validationStatus: "complete" });
    expect(d.allowed).toBe(true);
  });
});
