// Payroll-3D-3B Slice 1 (2026-09-06) — unit tests for the P2002
// detection shim used to swallow benign race losses on the
// correction-review WorkIntakeOrigin partial-unique.
//
// Pure-function tests only — no DB, no Prisma. This suite proves the
// shim distinguishes OUR constraint from every other P2002 shape it
// could plausibly see across Prisma adapter surface variations.

import { describe, it, expect } from "vitest";
import {
  isCorrectionReviewOriginConflict,
  CORRECTION_REVIEW_ORIGIN_INDEX_NAME,
} from "@/lib/work-intake/origin-conflict";

function mockP2002(meta: unknown): unknown {
  return {
    code: "P2002",
    name: "PrismaClientKnownRequestError",
    meta,
  };
}

describe("Payroll-3D-3B Slice 1 · isCorrectionReviewOriginConflict", () => {
  // Positive — the four legitimate surfaces Prisma may report.
  it("matches when meta.target is the exact index name (string)", () => {
    const err = mockP2002({ target: CORRECTION_REVIEW_ORIGIN_INDEX_NAME });
    expect(isCorrectionReviewOriginConflict(err)).toBe(true);
  });

  it("matches when meta.target is a string containing the index name", () => {
    const err = mockP2002({
      target: `WorkIntakeOrigin_${CORRECTION_REVIEW_ORIGIN_INDEX_NAME}_pkey`,
    });
    expect(isCorrectionReviewOriginConflict(err)).toBe(true);
  });

  it("matches when meta.target is the column-name array (index order)", () => {
    const err = mockP2002({ target: ["clubId", "kind", "referenceId"] });
    expect(isCorrectionReviewOriginConflict(err)).toBe(true);
  });

  it("matches when meta.target is the column-name array (alphabetical order)", () => {
    const err = mockP2002({ target: ["clubId", "kind", "referenceId"].sort() });
    expect(isCorrectionReviewOriginConflict(err)).toBe(true);
  });

  it("matches when meta.target is a comma-separated column-name string", () => {
    const err = mockP2002({ target: "clubId,kind,referenceId" });
    expect(isCorrectionReviewOriginConflict(err)).toBe(true);
  });

  // Negative — every case that MUST NOT match, or we'd silently swallow
  // an unrelated bug.
  it("does not match a non-error value", () => {
    expect(isCorrectionReviewOriginConflict(null)).toBe(false);
    expect(isCorrectionReviewOriginConflict(undefined)).toBe(false);
    expect(isCorrectionReviewOriginConflict("P2002")).toBe(false);
    expect(isCorrectionReviewOriginConflict(42)).toBe(false);
  });

  it("does not match a generic Error", () => {
    expect(isCorrectionReviewOriginConflict(new Error("boom"))).toBe(false);
  });

  it("matches a P2002 with matching target even when .name is missing", () => {
    // Some Prisma wrappers strip .name. The target-tuple match is
    // narrow enough (3 exact columns) that we accept the error without
    // requiring .name too — a bespoke shape that fakes .code alone
    // would still need to fake the whole tuple to slip through.
    const err = { code: "P2002", meta: { target: ["clubId", "kind", "referenceId"] } };
    expect(isCorrectionReviewOriginConflict(err)).toBe(true);
  });

  it("does not match a different Prisma error code", () => {
    const err = {
      code: "P2025",
      name: "PrismaClientKnownRequestError",
      meta: { target: ["clubId", "kind", "referenceId"] },
    };
    expect(isCorrectionReviewOriginConflict(err)).toBe(false);
  });

  it("does not match a P2002 with missing meta", () => {
    const err = { code: "P2002", name: "PrismaClientKnownRequestError" };
    expect(isCorrectionReviewOriginConflict(err)).toBe(false);
  });

  it("does not match a P2002 on a different index name", () => {
    const err = mockP2002({ target: "TimeClockCorrectionRequest_employee_type_original_status_key" });
    expect(isCorrectionReviewOriginConflict(err)).toBe(false);
  });

  it("does not match a P2002 on a different column tuple (superset)", () => {
    const err = mockP2002({ target: ["clubId", "kind", "referenceId", "role"] });
    expect(isCorrectionReviewOriginConflict(err)).toBe(false);
  });

  it("does not match a P2002 on a different column tuple (subset)", () => {
    const err = mockP2002({ target: ["clubId", "kind"] });
    expect(isCorrectionReviewOriginConflict(err)).toBe(false);
  });

  it("does not match a P2002 on a different column tuple (partial overlap)", () => {
    const err = mockP2002({ target: ["clubId", "kind", "role"] });
    expect(isCorrectionReviewOriginConflict(err)).toBe(false);
  });

  it("does not match a P2002 with a non-string, non-array target", () => {
    const err = mockP2002({ target: 42 });
    expect(isCorrectionReviewOriginConflict(err)).toBe(false);
    const err2 = mockP2002({ target: { columns: ["clubId", "kind", "referenceId"] } });
    expect(isCorrectionReviewOriginConflict(err2)).toBe(false);
  });
});
