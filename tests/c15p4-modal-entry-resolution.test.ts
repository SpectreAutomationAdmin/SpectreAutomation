// Sprint 3 · Checkpoint 15P-4 (2026-07-28) — shared vendor-
// resolution rule (lib/vendor-matching/resolve-modal-entry).
//
// Covers every branch of the founder-required routing decision:
//
//   • empty candidate list       → review_required "no_match"
//   • leader.classification === "possible"     → review "limited_evidence"
//   • leader.classification === "conflicting"  → review "conflicting"
//   • leader has any differed field            → review "conflicting"
//   • leader = exact + runner-up too close     → review "ambiguous"
//   • leader = exact + clear separation        → resolved
//   • leader = strong + clear separation       → resolved
//   • only weak (possible) runners             → resolved

import { describe, expect, it } from "vitest";
import {
  resolveModalEntry, AMBIGUITY_MATCHED_WEIGHT_GAP,
  type CandidateForResolution,
} from "@/lib/vendor-matching/resolve-modal-entry";

const mkCandidate = (
  id: string,
  overrides: Partial<CandidateForResolution> = {},
): CandidateForResolution => ({
  id,
  legalName: `Vendor ${id}`,
  classification: "exact",
  matchedWeight: 100,
  differedFields: [],
  ...overrides,
});

describe("15P-4 · resolveModalEntry — auto-resolve happy paths", () => {
  it("empty list → review_required 'no_match'", () => {
    const r = resolveModalEntry([]);
    expect(r.status).toBe("review_required");
    if (r.status === "review_required") expect(r.reason).toBe("no_match");
  });

  it("single exact leader, no rivals → resolved", () => {
    const r = resolveModalEntry([mkCandidate("v1", { classification: "exact", matchedWeight: 118 })]);
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") expect(r.vendorId).toBe("v1");
  });

  it("single strong leader, no rivals → resolved", () => {
    const r = resolveModalEntry([mkCandidate("v1", { classification: "strong", matchedWeight: 55 })]);
    expect(r.status).toBe("resolved");
  });

  it("exact leader well ahead of a strong rival (gap ≥ threshold) → resolved", () => {
    const r = resolveModalEntry([
      mkCandidate("v1", { classification: "exact", matchedWeight: 118 }),
      mkCandidate("v2", { classification: "strong", matchedWeight: 40 }),  // gap 78, well past threshold
    ]);
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") expect(r.vendorId).toBe("v1");
  });

  it("exact leader with only possible rivals below → resolved (possible rivals do not create ambiguity)", () => {
    const r = resolveModalEntry([
      mkCandidate("v1", { classification: "exact", matchedWeight: 90 }),
      mkCandidate("v2", { classification: "possible", matchedWeight: 25 }),
      mkCandidate("v3", { classification: "possible", matchedWeight: 25 }),
    ]);
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") expect(r.vendorId).toBe("v1");
  });
});

describe("15P-4 · resolveModalEntry — review_required paths", () => {
  it("leader.classification = 'possible' → review 'limited_evidence'", () => {
    const r = resolveModalEntry([mkCandidate("v1", { classification: "possible", matchedWeight: 25 })]);
    expect(r.status).toBe("review_required");
    if (r.status === "review_required") expect(r.reason).toBe("limited_evidence");
  });

  it("leader.classification = 'conflicting' → review 'conflicting'", () => {
    const r = resolveModalEntry([mkCandidate("v1", { classification: "conflicting", matchedWeight: 40, differedFields: ["taxRegistrationNumber"] })]);
    expect(r.status).toBe("review_required");
    if (r.status === "review_required") expect(r.reason).toBe("conflicting");
  });

  it("otherwise-exact leader with any differed field → review 'conflicting' (belt + braces)", () => {
    // Belt-and-braces: if the classifier said 'exact' but somehow
    // differedFields is non-empty, we STILL send to review.
    const r = resolveModalEntry([mkCandidate("v1", { classification: "exact", matchedWeight: 100, differedFields: ["phone"] })]);
    expect(r.status).toBe("review_required");
    if (r.status === "review_required") expect(r.reason).toBe("conflicting");
  });
});

describe("15P-4 · resolveModalEntry — ambiguity threshold", () => {
  it("two exact candidates within the gap → review 'ambiguous'", () => {
    const r = resolveModalEntry([
      mkCandidate("v1", { classification: "exact", matchedWeight: 100 }),
      mkCandidate("v2", { classification: "exact", matchedWeight: 100 - (AMBIGUITY_MATCHED_WEIGHT_GAP - 1) }),  // 86
    ]);
    expect(r.status).toBe("review_required");
    if (r.status === "review_required") expect(r.reason).toBe("ambiguous");
  });

  it("two exact candidates AT the gap boundary → resolved", () => {
    // The rule is `leader - rival < GAP` → ambiguous. Equal-to-gap
    // therefore resolves.
    const r = resolveModalEntry([
      mkCandidate("v1", { classification: "exact", matchedWeight: 100 }),
      mkCandidate("v2", { classification: "exact", matchedWeight: 100 - AMBIGUITY_MATCHED_WEIGHT_GAP }),  // 85
    ]);
    expect(r.status).toBe("resolved");
  });

  it("exact leader + strong rival within the gap → ambiguous", () => {
    const r = resolveModalEntry([
      mkCandidate("v1", { classification: "exact", matchedWeight: 60 }),
      mkCandidate("v2", { classification: "strong", matchedWeight: 50 }),
    ]);
    expect(r.status).toBe("review_required");
    if (r.status === "review_required") expect(r.reason).toBe("ambiguous");
  });

  it("possible or conflicting rivals never trigger the ambiguity check", () => {
    const r = resolveModalEntry([
      mkCandidate("v1", { classification: "exact", matchedWeight: 60 }),
      mkCandidate("v2", { classification: "possible", matchedWeight: 55 }),
      mkCandidate("v3", { classification: "conflicting", matchedWeight: 55, differedFields: ["taxRegistrationNumber"] }),
    ]);
    expect(r.status).toBe("resolved");
  });
});

describe("15P-4 · resolveModalEntry — returned data preserves the full ranked list", () => {
  it("resolved response includes allCandidates", () => {
    const c1 = mkCandidate("v1", { classification: "exact", matchedWeight: 100 });
    const c2 = mkCandidate("v2", { classification: "possible", matchedWeight: 25 });
    const r = resolveModalEntry([c1, c2]);
    if (r.status !== "resolved") throw new Error("expected resolved");
    expect(r.allCandidates).toHaveLength(2);
  });
  it("review_required response includes allCandidates", () => {
    const c1 = mkCandidate("v1", { classification: "possible", matchedWeight: 25 });
    const r = resolveModalEntry([c1]);
    if (r.status !== "review_required") throw new Error("expected review_required");
    expect(r.allCandidates).toHaveLength(1);
  });
});
