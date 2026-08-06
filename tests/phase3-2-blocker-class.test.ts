// Sprint 3 · Post-16H Phase 3.2 (2026-08-05) — blocker-classification
// + posting-gate policy tests (§9). Proves:
//   * every ApWorkflowBlockerCode has a deterministic severity
//   * HARD_BLOCK refuses posting regardless of acknowledgments
//   * REQUIRES_EXPLICIT_REVIEW refuses posting until acknowledged
//   * WARNING_ONLY never blocks posting
//   * Unknown codes default to HARD_BLOCK (conservative)
//   * Refusal messages name the offending codes so the founder-facing
//     surface can render them faithfully.

import { describe, it, expect } from "vitest";
import {
  classifyBlocker,
  evaluatePostingGate,
} from "@/lib/ap-intelligence/workflow/blocker-class";
import type { ApWorkflowBlockerCode } from "@/lib/ap-intelligence/workflow/decision";

describe("Phase 3.2 · classifyBlocker — every code has a deterministic severity", () => {
  const cases: Array<[ApWorkflowBlockerCode, "HARD_BLOCK" | "REQUIRES_EXPLICIT_REVIEW" | "WARNING_ONLY"]> = [
    ["DOCUMENT_UNREADABLE", "HARD_BLOCK"],
    ["GROSS_TOTAL_UNRESOLVED", "HARD_BLOCK"],
    ["GL_INELIGIBLE", "HARD_BLOCK"],
    ["ALLOCATION_VARIANCE", "HARD_BLOCK"],
    ["DUPLICATE_INVOICE_RISK", "HARD_BLOCK"],
    ["ACCOUNTING_NATURE_UNSUPPORTED", "HARD_BLOCK"],
    ["CONTRADICTORY_EVIDENCE", "HARD_BLOCK"],
    ["TAX_UNRECONCILED", "REQUIRES_EXPLICIT_REVIEW"],
    ["GL_BELOW_THRESHOLD", "REQUIRES_EXPLICIT_REVIEW"],
    ["MULTI_ALLOCATION_NOT_PER_ALLOCATION", "REQUIRES_EXPLICIT_REVIEW"],
    ["CAPITAL_TREATMENT_REVIEW_REQUIRED", "REQUIRES_EXPLICIT_REVIEW"],
    ["VENDOR_UNRESOLVED", "REQUIRES_EXPLICIT_REVIEW"],
    ["PAYABLE_REFERENCE_MISSING", "REQUIRES_EXPLICIT_REVIEW"],
    ["SUPPLIER_UNRESOLVED", "REQUIRES_EXPLICIT_REVIEW"],
    ["POSTING_BLOCKER_UNRESOLVED", "WARNING_ONLY"],
    ["LINE_ITEMS_MISSING", "WARNING_ONLY"],
  ];
  for (const [code, expected] of cases) {
    it(`${code} → ${expected}`, () => {
      expect(classifyBlocker(code)).toBe(expected);
    });
  }
  it("unknown code defaults to HARD_BLOCK (conservative)", () => {
    // Cast: intentional invalid code to prove the default branch.
    expect(classifyBlocker("SOMETHING_NEW_NOT_YET_MAPPED" as ApWorkflowBlockerCode)).toBe("HARD_BLOCK");
  });
});

describe("Phase 3.2 · evaluatePostingGate — policy enforcement", () => {
  it("no blockers → allowed, refusalCode OK", () => {
    const v = evaluatePostingGate([], []);
    expect(v.allowed).toBe(true);
    expect(v.refusalCode).toBe("OK");
    expect(v.refusalMessage).toBeNull();
  });

  it("HARD_BLOCK refuses posting even when acknowledged", () => {
    const v = evaluatePostingGate(
      ["GROSS_TOTAL_UNRESOLVED"],
      ["GROSS_TOTAL_UNRESOLVED"],  // acknowledgment on HARD is a no-op
    );
    expect(v.allowed).toBe(false);
    expect(v.refusalCode).toBe("HARD_BLOCK");
    expect(v.hardBlockers).toContain("GROSS_TOTAL_UNRESOLVED");
    expect(v.refusalMessage).toMatch(/GROSS_TOTAL_UNRESOLVED/);
  });

  it("REQUIRES_EXPLICIT_REVIEW refuses when NOT acknowledged", () => {
    const v = evaluatePostingGate(["TAX_UNRECONCILED"], []);
    expect(v.allowed).toBe(false);
    expect(v.refusalCode).toBe("UNACKNOWLEDGED_REVIEW");
    expect(v.unacknowledgedRequiresReview).toContain("TAX_UNRECONCILED");
    expect(v.refusalMessage).toMatch(/TAX_UNRECONCILED/);
  });

  it("REQUIRES_EXPLICIT_REVIEW passes when acknowledged", () => {
    const v = evaluatePostingGate(
      ["TAX_UNRECONCILED", "VENDOR_UNRESOLVED"],
      ["TAX_UNRECONCILED", "VENDOR_UNRESOLVED"],
    );
    expect(v.allowed).toBe(true);
    expect(v.refusalCode).toBe("OK");
    expect(v.acknowledgedByReview).toEqual(
      expect.arrayContaining(["TAX_UNRECONCILED", "VENDOR_UNRESOLVED"]),
    );
    expect(v.unacknowledgedRequiresReview).toHaveLength(0);
  });

  it("HARD_BLOCK dominates REQUIRES_EXPLICIT_REVIEW acknowledgments", () => {
    const v = evaluatePostingGate(
      ["GROSS_TOTAL_UNRESOLVED", "TAX_UNRECONCILED"],
      ["TAX_UNRECONCILED"],
    );
    expect(v.allowed).toBe(false);
    expect(v.refusalCode).toBe("HARD_BLOCK");
  });

  it("WARNING_ONLY never blocks posting", () => {
    const v = evaluatePostingGate(
      ["POSTING_BLOCKER_UNRESOLVED", "LINE_ITEMS_MISSING"],
      [],
    );
    expect(v.allowed).toBe(true);
    expect(v.refusalCode).toBe("OK");
    expect(v.warningOnlyBlockers).toEqual(
      expect.arrayContaining(["POSTING_BLOCKER_UNRESOLVED", "LINE_ITEMS_MISSING"]),
    );
  });

  it("partial acknowledgment on multiple review blockers refuses with the unacknowledged list", () => {
    const v = evaluatePostingGate(
      ["TAX_UNRECONCILED", "VENDOR_UNRESOLVED", "GL_BELOW_THRESHOLD"],
      ["TAX_UNRECONCILED"],
    );
    expect(v.allowed).toBe(false);
    expect(v.refusalCode).toBe("UNACKNOWLEDGED_REVIEW");
    expect(v.acknowledgedByReview).toEqual(["TAX_UNRECONCILED"]);
    expect(v.unacknowledgedRequiresReview).toEqual(
      expect.arrayContaining(["VENDOR_UNRESOLVED", "GL_BELOW_THRESHOLD"]),
    );
    expect(v.refusalMessage).toMatch(/VENDOR_UNRESOLVED/);
    expect(v.refusalMessage).toMatch(/GL_BELOW_THRESHOLD/);
    expect(v.refusalMessage).not.toMatch(/TAX_UNRECONCILED/);
  });

  it("mixed severity: HARD + REQUIRES_EXPLICIT_REVIEW + WARNING → HARD refusal, all buckets populated", () => {
    const v = evaluatePostingGate(
      ["ALLOCATION_VARIANCE", "TAX_UNRECONCILED", "POSTING_BLOCKER_UNRESOLVED"],
      ["TAX_UNRECONCILED"],
    );
    expect(v.allowed).toBe(false);
    expect(v.refusalCode).toBe("HARD_BLOCK");
    expect(v.hardBlockers).toContain("ALLOCATION_VARIANCE");
    expect(v.requiresReviewBlockers).toContain("TAX_UNRECONCILED");
    expect(v.warningOnlyBlockers).toContain("POSTING_BLOCKER_UNRESOLVED");
    expect(v.acknowledgedByReview).toContain("TAX_UNRECONCILED");
  });
});
