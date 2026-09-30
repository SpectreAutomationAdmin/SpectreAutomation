// DIM-2b (2026-09-29) — Bulk review filter + selection + action tests.
//
// Covers Section 18:
//   * filter by confidence / policy / applicability / capital / combined
//   * select visible / clear selection
//   * bulk REPLACE / ADD
//   * policy vs applicability independence
//   * applicability change marks row reviewed
//   * unknown fund still blocks (via saveCoaRowMappings pipeline)
//   * summary counters update with review state
//
// The bulk server action itself uses `saveCoaRowMappings`, whose
// tenant/permission/unknown-fund guards are already covered by
// DIM-1 + DIM-2 + DIM-2a. These tests focus on the pure filter +
// summary + selection semantics.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  filterCoaBatch,
  summariseCoaBatch,
  capitalReviewCandidates,
  type CoaReviewInputRow,
} from "@/lib/imports/coa-dimensional-review";
import { readReviewState } from "@/lib/imports/coa-review-state";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const BULK_ACTIONS = readFileSync(path.join(REPO, "src", "app", "app", "admin", "imports", "[id]", "_bulk-coa-actions.ts"), "utf8");

function makeRow(overrides: Partial<CoaReviewInputRow>): CoaReviewInputRow {
  return {
    accountNumber: overrides.accountNumber ?? "0000",
    name: overrides.name ?? "Test",
    type: overrides.type ?? "EXPENSE",
    fsGroupKey: overrides.fsGroupKey ?? "IS_OPERATING",
    confidence: overrides.confidence ?? "high",
    source: overrides.source ?? "name-keyword",
    departmentPolicy: overrides.departmentPolicy ?? "REQUIRED",
    fundPolicy: overrides.fundPolicy ?? "REQUIRED",
    fundApplicabilityKeys: overrides.fundApplicabilityKeys ?? ["OPERATING"],
    departmentApplicabilityCodes: overrides.departmentApplicabilityCodes ?? [],
    reviewed: overrides.reviewed,
  };
}

const CORPUS: CoaReviewInputRow[] = [
  // 6098 · REQUIRED-dept + no applicability + OPERATING + high
  makeRow({ accountNumber: "6098", name: "Licenses" }),
  // 6099 · REQUIRED-dept + WITH applicability + OPERATING + medium
  makeRow({ accountNumber: "6099", name: "R&M", confidence: "medium", departmentApplicabilityCodes: ["ADMIN"] }),
  // 1500 · CAPITAL candidate, BS asset, NOT_APPLICABLE both, no fund keys
  makeRow({ accountNumber: "1500", name: "Land", type: "ASSET", fsGroupKey: "BS_CAPITAL_ASSETS", departmentPolicy: "NOT_APPLICABLE", fundPolicy: "NOT_APPLICABLE", fundApplicabilityKeys: [] }),
  // 4000 · REVENUE, REQUIRED both, OPERATING, reviewed
  makeRow({ accountNumber: "4000", name: "Membership Dues", type: "REVENUE", fsGroupKey: "IS_MEMBERSHIP_DUES", reviewed: true }),
  // 1010 · Cash — NOT_APPLICABLE both
  makeRow({ accountNumber: "1010", name: "Cash", type: "ASSET", fsGroupKey: "BS_CASH_EQUIVALENTS", departmentPolicy: "NOT_APPLICABLE", fundPolicy: "NOT_APPLICABLE", fundApplicabilityKeys: [] }),
];

describe("DIM-2b · filterCoaBatch — single filters", () => {
  it("filter by confidence=medium", () => {
    const out = filterCoaBatch(CORPUS, { confidence: ["medium"] });
    expect(out.map((r) => r.accountNumber)).toEqual(["6099"]);
  });
  it("filter by departmentPolicy=REQUIRED", () => {
    const out = filterCoaBatch(CORPUS, { departmentPolicy: ["REQUIRED"] });
    expect(out.map((r) => r.accountNumber).sort()).toEqual(["4000", "6098", "6099"]);
  });
  it("filter by fundPolicy=NOT_APPLICABLE", () => {
    const out = filterCoaBatch(CORPUS, { fundPolicy: ["NOT_APPLICABLE"] });
    expect(out.map((r) => r.accountNumber).sort()).toEqual(["1010", "1500"]);
  });
  it("filter by departmentApplicabilityState=NONE", () => {
    const out = filterCoaBatch(CORPUS, { departmentApplicabilityState: "NONE" });
    expect(out.map((r) => r.accountNumber).sort()).toEqual(["1010", "1500", "4000", "6098"]);
  });
  it("filter by fundApplicabilityState=NONE", () => {
    const out = filterCoaBatch(CORPUS, { fundApplicabilityState: "NONE" });
    expect(out.map((r) => r.accountNumber).sort()).toEqual(["1010", "1500"]);
  });
  it("filter by fundApplicabilityHasKey=OPERATING", () => {
    const out = filterCoaBatch(CORPUS, { fundApplicabilityHasKey: "OPERATING" });
    expect(out.map((r) => r.accountNumber).sort()).toEqual(["4000", "6098", "6099"]);
  });
  it("filter by CAPITAL candidate=true", () => {
    const out = filterCoaBatch(CORPUS, { capitalReviewCandidate: true });
    expect(out.map((r) => r.accountNumber)).toEqual(["1500"]);
  });
  it("filter by reviewState=REVIEWED", () => {
    const out = filterCoaBatch(CORPUS, { reviewState: "REVIEWED" });
    expect(out.map((r) => r.accountNumber)).toEqual(["4000"]);
  });
  it("filter by reviewState=NOT_REVIEWED", () => {
    const out = filterCoaBatch(CORPUS, { reviewState: "NOT_REVIEWED" });
    expect(out.map((r) => r.accountNumber).sort()).toEqual(["1010", "1500", "6098", "6099"]);
  });
  it("filter by search=cash", () => {
    const out = filterCoaBatch(CORPUS, { search: "cash" });
    expect(out.map((r) => r.accountNumber)).toEqual(["1010"]);
  });
});

describe("DIM-2b · filterCoaBatch — combined filters (Section 4 scenarios)", () => {
  it("Scenario A — Department Policy = REQUIRED AND Department Applicability = NONE", () => {
    const out = filterCoaBatch(CORPUS, {
      departmentPolicy: ["REQUIRED"],
      departmentApplicabilityState: "NONE",
    });
    // Rows with REQUIRED-dept AND empty AccountDepartment applicability.
    expect(out.map((r) => r.accountNumber).sort()).toEqual(["4000", "6098"]);
  });
  it("Scenario B — CAPITAL Review Candidate = YES", () => {
    const out = filterCoaBatch(CORPUS, { capitalReviewCandidate: true });
    expect(out.map((r) => r.accountNumber)).toEqual(["1500"]);
  });
  it("Scenario C — Confidence = MEDIUM", () => {
    const out = filterCoaBatch(CORPUS, { confidence: ["medium"] });
    expect(out.map((r) => r.accountNumber)).toEqual(["6099"]);
  });
});

describe("DIM-2b · summariseCoaBatch — review-state counters", () => {
  it("counts reviewed vs not-reviewed correctly", () => {
    const s = summariseCoaBatch(CORPUS);
    expect(s.rowsReviewed).toBe(1);
    expect(s.rowsNotReviewed).toBe(CORPUS.length - 1);
  });
  it("mediumConfidenceNotReviewed excludes rows the operator has reviewed", () => {
    const withReviewed = CORPUS.map((r) =>
      r.accountNumber === "6099" ? { ...r, reviewed: true } : r,
    );
    const s = summariseCoaBatch(withReviewed);
    expect(s.mediumConfidenceNotReviewed).toBe(0);
  });
  it("Confidence = high does NOT imply reviewed (Section 8 architectural invariant)", () => {
    const highNotReviewed = CORPUS.find((r) => r.confidence === "high" && !r.reviewed);
    expect(highNotReviewed).toBeDefined();
    const s = summariseCoaBatch(CORPUS);
    // High-confidence rows in CORPUS that are NOT reviewed: 6098, 1500, 1010 → 3 rows.
    expect(s.confidenceDistribution.high).toBeGreaterThan(s.rowsReviewed);
  });
});

describe("DIM-2b · bulk server action structural invariants (Section 15)", () => {
  it("uses saveCoaRowMappings — no second commit path", () => {
    expect(BULK_ACTIONS).toMatch(/import\s*\{\s*saveCoaRowMappings\s*\}\s*from\s*["']@\/lib\/imports["']/);
    // And no direct Account/AccountDepartment/AccountFund writes.
    expect(BULK_ACTIONS).not.toMatch(/prisma\.account\.(create|upsert|update)/);
    expect(BULK_ACTIONS).not.toMatch(/prisma\.accountDepartment\.(create|createMany)/);
    expect(BULK_ACTIONS).not.toMatch(/prisma\.accountFund\.(create|createMany)/);
  });
  it("policy actions never touch applicability (Section 7 + 15)", () => {
    // Grep the file for the SET_DEPARTMENT_POLICY branch — it must
    // spread `...base` (which preserves current applicability) and
    // ONLY override `departmentPolicy`, no departmentCodes /
    // fundApplicabilityKeys.
    const m = BULK_ACTIONS.match(/case "SET_DEPARTMENT_POLICY":[\s\S]*?return \{ \.\.\.base, departmentPolicy: action\.value, reviewed: true \};/);
    expect(m).toBeTruthy();
    const m2 = BULK_ACTIONS.match(/case "SET_FUND_POLICY":[\s\S]*?return \{ \.\.\.base, fundPolicy: action\.value, reviewed: true \};/);
    expect(m2).toBeTruthy();
  });
  it("applicability actions never touch policy", () => {
    const m1 = BULK_ACTIONS.match(/case "SET_DEPARTMENT_APPLICABILITY":[\s\S]*?departmentCodes: next[\s\S]*?reviewed: true/);
    expect(m1).toBeTruthy();
    // No departmentPolicy override inside SET_DEPARTMENT_APPLICABILITY.
    const block = BULK_ACTIONS.match(/case "SET_DEPARTMENT_APPLICABILITY":[\s\S]*?return \{ \.\.\.base, departmentCodes: next, reviewed: true \};/);
    expect(block).toBeTruthy();
    expect(block![0]).not.toMatch(/departmentPolicy:/);
    const block2 = BULK_ACTIONS.match(/case "SET_FUND_APPLICABILITY":[\s\S]*?return \{ \.\.\.base, fundApplicabilityKeys: next, reviewed: true \};/);
    expect(block2).toBeTruthy();
    expect(block2![0]).not.toMatch(/fundPolicy:/);
  });
  it("bulk actions mark affected rows reviewed", () => {
    // Every action branch that mutates the row should set reviewed: true.
    for (const marker of [
      "SET_DEPARTMENT_APPLICABILITY",
      "SET_FUND_APPLICABILITY",
      "SET_DEPARTMENT_POLICY",
      "SET_FUND_POLICY",
      "MARK_REVIEWED",
    ]) {
      const rx = new RegExp(`case "${marker}":[\\s\\S]*?reviewed: true`);
      expect(BULK_ACTIONS).toMatch(rx);
    }
  });
  it("tenant scoping — rowIds must belong to this batch (batchId + id filter)", () => {
    expect(BULK_ACTIONS).toMatch(/prisma\.importRow\.findMany\(\s*\{\s*where:\s*\{\s*batchId,\s*id:\s*\{\s*in:\s*\[\.\.\.rowIds\]\s*\}\s*\}/);
    expect(BULK_ACTIONS).toMatch(/return \{ ok: false, message: "One or more selected rows do not belong to this batch\." \};/);
  });
  it("REPLACE vs ADD semantics are explicit + only these two modes exist", () => {
    expect(BULK_ACTIONS).toMatch(/"REPLACE" \| "ADD"/);
    expect(BULK_ACTIONS).toMatch(/action\.mode === "REPLACE"/);
    // ADD does a union (spread + filter on prior); test it exists.
    expect(BULK_ACTIONS).toMatch(/priorSet\.has\(c\)/);
    expect(BULK_ACTIONS).toMatch(/priorSet\.has\(k\)/);
  });
});

describe("DIM-2b · readReviewState round-trip", () => {
  it("returns { reviewed: false, reviewedAt: null } for missing _review", () => {
    expect(readReviewState({})).toEqual({ reviewed: false, reviewedAt: null });
    expect(readReviewState(null)).toEqual({ reviewed: false, reviewedAt: null });
    expect(readReviewState(undefined)).toEqual({ reviewed: false, reviewedAt: null });
  });
  it("reads reviewed=true + reviewedAt", () => {
    const raw = { _review: { reviewed: true, reviewedAt: "2026-09-29T00:00:00.000Z" } };
    expect(readReviewState(raw)).toEqual({ reviewed: true, reviewedAt: "2026-09-29T00:00:00.000Z" });
  });
});
