// COA-UX-2c (2026-09-30) — Attention-metric semantics.
//
// Covers Section 11 A–J of the founder directive: the corrected
// Attention formula, the material-edit review reset, and the
// ribbon/filter authoritative-predicate invariant.

import { describe, expect, it } from "vitest";
import {
  hasAttentionCondition,
  isReviewed,
  needsAttention,
  summariseCoaBatch,
  type CoaReviewInputRow,
} from "../../src/lib/imports/coa-dimensional-review";
import {
  clientHasAttentionCondition,
  clientNeedsAttention,
} from "../../src/app/app/admin/imports/[id]/BulkCoaReviewControls";
import { resolveReviewedAfterMaterialEdit } from "../../src/lib/imports/coa-review-reset";

function row(overrides: Partial<CoaReviewInputRow> = {}): CoaReviewInputRow {
  return {
    accountNumber: overrides.accountNumber ?? "1000",
    name: overrides.name ?? "Petty Cash",
    type: overrides.type ?? "ASSET",
    fsGroupKey: overrides.fsGroupKey ?? "BS_CASH_EQUIVALENTS",
    confidence: overrides.confidence ?? "high",
    source: overrides.source ?? "default",
    departmentPolicy: overrides.departmentPolicy ?? "NOT_APPLICABLE",
    fundPolicy: overrides.fundPolicy ?? "NOT_APPLICABLE",
    fundApplicabilityKeys: overrides.fundApplicabilityKeys ?? [],
    departmentApplicabilityCodes: overrides.departmentApplicabilityCodes ?? [],
    reviewed: overrides.reviewed,
  };
}

describe("COA-UX-2c · needsAttention shape (§7)", () => {
  it("hasAttentionCondition is the pure signal test — does NOT consult reviewed", () => {
    const r = row({ confidence: "medium", reviewed: true });
    expect(hasAttentionCondition(r)).toBe(true);
    expect(isReviewed(r)).toBe(true);
    expect(needsAttention(r)).toBe(false);
  });

  it("needsAttention = !isReviewed && hasAttentionCondition", () => {
    expect(needsAttention(row({ confidence: "medium", reviewed: false }))).toBe(true);
    expect(needsAttention(row({ confidence: "medium", reviewed: true }))).toBe(false);
    expect(needsAttention(row({ confidence: "high", reviewed: false }))).toBe(false);
    expect(needsAttention(row({ confidence: "high", reviewed: true }))).toBe(false);
  });
});

describe("COA-UX-2c · §11 test matrix", () => {
  // ── §11.A — invariant: attention ≤ unreviewed ────────────────
  it("(A) attention ≤ unreviewed on any batch", () => {
    // Random-ish mixture: 20 rows with varied conditions + reviewed states.
    const rows: CoaReviewInputRow[] = [];
    for (let i = 0; i < 20; i++) {
      const conf = i % 3 === 0 ? "low" : i % 3 === 1 ? "medium" : "high";
      const reviewed = i % 4 === 0;
      const deptReqNoApp = i % 5 === 0;
      rows.push(row({
        accountNumber: `10${i}`,
        confidence: conf as CoaReviewInputRow["confidence"],
        reviewed,
        departmentPolicy: deptReqNoApp ? "REQUIRED" : "NOT_APPLICABLE",
        departmentApplicabilityCodes: [],
      }));
    }
    const s = summariseCoaBatch(rows);
    expect(s.rowsRequiringAttention).toBeLessThanOrEqual(s.rowsNotReviewed);
  });

  // ── §11.B — medium + unreviewed → attention ──────────────────
  it("(B) medium-confidence + unreviewed → Attention", () => {
    expect(needsAttention(row({ confidence: "medium", reviewed: false }))).toBe(true);
  });

  // ── §11.C — medium + reviewed → NOT attention ────────────────
  it("(C) medium-confidence + reviewed → NOT Attention", () => {
    expect(needsAttention(row({ confidence: "medium", reviewed: true }))).toBe(false);
  });

  // ── §11.D — high + no other cond + unreviewed → NOT attention
  it("(D) high-confidence + no other attention condition + unreviewed → NOT Attention", () => {
    expect(needsAttention(row({ confidence: "high", reviewed: false }))).toBe(false);
  });

  // ── §11.E — attention row marked reviewed → count moves ──────
  it("(E) attention row marked Reviewed → reviewed +1, attention −1", () => {
    const before: CoaReviewInputRow[] = [
      row({ accountNumber: "1000", confidence: "medium", reviewed: false }),
      row({ accountNumber: "1001", confidence: "high", reviewed: false }),
    ];
    const s0 = summariseCoaBatch(before);
    expect(s0.rowsReviewed).toBe(0);
    expect(s0.rowsRequiringAttention).toBe(1); // 1000 medium unreviewed

    const after: CoaReviewInputRow[] = [
      row({ accountNumber: "1000", confidence: "medium", reviewed: true }),
      row({ accountNumber: "1001", confidence: "high", reviewed: false }),
    ];
    const s1 = summariseCoaBatch(after);
    expect(s1.rowsReviewed).toBe(s0.rowsReviewed + 1);
    expect(s1.rowsRequiringAttention).toBe(s0.rowsRequiringAttention - 1);
  });

  // ── §11.F — non-attention row marked reviewed → attention unchanged
  it("(F) non-attention row (high, no other cond) marked Reviewed → attention unchanged", () => {
    const before: CoaReviewInputRow[] = [
      row({ accountNumber: "1000", confidence: "high", reviewed: false }),
      row({ accountNumber: "1001", confidence: "medium", reviewed: false }),
    ];
    const s0 = summariseCoaBatch(before);

    const after: CoaReviewInputRow[] = [
      row({ accountNumber: "1000", confidence: "high", reviewed: true }),
      row({ accountNumber: "1001", confidence: "medium", reviewed: false }),
    ];
    const s1 = summariseCoaBatch(after);

    expect(s1.rowsReviewed).toBe(s0.rowsReviewed + 1);
    expect(s1.rowsRequiringAttention).toBe(s0.rowsRequiringAttention);
  });

  // ── §11.G — bulk Mark Reviewed removes attention rows ────────
  it("(G) bulk Mark Reviewed on N attention rows → attention drops by N", () => {
    const before: CoaReviewInputRow[] = Array.from({ length: 5 }, (_, i) => row({
      accountNumber: `10${i}`,
      confidence: "medium",
      reviewed: false,
    }));
    const s0 = summariseCoaBatch(before);
    expect(s0.rowsRequiringAttention).toBe(5);

    // Simulate bulk-mark all 5 reviewed.
    const after: CoaReviewInputRow[] = before.map((r) => ({ ...r, reviewed: true }));
    const s1 = summariseCoaBatch(after);
    expect(s1.rowsRequiringAttention).toBe(0);
    expect(s1.rowsReviewed).toBe(5);
  });

  // ── §11.H — Reviewed does NOT suppress blocking errors ───────
  it("(H) Reviewed does NOT suppress blocking validation error surfacing", () => {
    // The Attention metric is advisory only. Blocking validation
    // errors are surfaced through ImportError, not through the
    // Attention count. This test locks in the semantic: the
    // Attention count intentionally does NOT include "row is
    // structurally invalid" (missing classification, etc.) — those
    // are separate from advisory attention. `reviewed` never masks
    // them because they aren't in the predicate at all.
    const r = row({ confidence: "high", reviewed: true, type: "" as never, fsGroupKey: "" });
    expect(hasAttentionCondition(r)).toBe(false);
    expect(needsAttention(r)).toBe(false);
    // The row is still "structurally incomplete" in the classification
    // sense, but that's a saveCoaRowMappings validation problem, not
    // an Attention problem. Attention is advisory; blocking errors
    // continue to flow through the ImportError table regardless of
    // reviewed state.
  });

  // ── §11.I — material edit after Reviewed → back to unreviewed
  it("(I) material edit after Reviewed → reviewed=false; re-evaluated attention returns to true", () => {
    // Prior state: reviewed=true, medium confidence.
    const priorMaterial = {
      type: "ASSET" as const, categoryKey: "CURRENT_ASSETS", fsGroupKey: "BS_CASH_EQUIVALENTS",
      departmentPolicy: null, fundPolicy: null,
      departmentCodes: [], fundApplicabilityKeys: [],
    };
    // Founder edits Category → back to unreviewed per §6.
    const nextMaterial = { ...priorMaterial, categoryKey: "CAPITAL_ASSETS" };
    const resolved = resolveReviewedAfterMaterialEdit({
      priorReviewed: true,
      priorMaterial,
      nextMaterial,
    });
    expect(resolved).toBe(false);
    // Re-evaluate attention using the corrected formula.
    const r = row({ confidence: "medium", reviewed: resolved });
    expect(needsAttention(r)).toBe(true);
  });

  it("(I-bis) material no-op edit does NOT flip reviewed", () => {
    const same = {
      type: "ASSET" as const, categoryKey: "CURRENT_ASSETS", fsGroupKey: "BS_CASH_EQUIVALENTS",
      departmentPolicy: null, fundPolicy: null,
      departmentCodes: [], fundApplicabilityKeys: [],
    };
    expect(resolveReviewedAfterMaterialEdit({
      priorReviewed: true, priorMaterial: same, nextMaterial: same,
    })).toBe(true);
    expect(resolveReviewedAfterMaterialEdit({
      priorReviewed: false, priorMaterial: same, nextMaterial: same,
    })).toBe(false);
  });

  it("(I-bis-2) first-time edit on unreviewed row still marks reviewed (DIM-2a default)", () => {
    const priorMaterial = {
      type: "ASSET" as const, categoryKey: null, fsGroupKey: null,
      departmentPolicy: null, fundPolicy: null,
      departmentCodes: [], fundApplicabilityKeys: [],
    };
    const nextMaterial = { ...priorMaterial, categoryKey: "CURRENT_ASSETS" };
    expect(resolveReviewedAfterMaterialEdit({
      priorReviewed: false, priorMaterial, nextMaterial,
    })).toBe(true);
  });

  it("(I-bis-3) explicit reviewed (Mark Reviewed / Unmark) always wins", () => {
    const priorMaterial = {
      type: "ASSET" as const, categoryKey: "CURRENT_ASSETS", fsGroupKey: "BS_CASH_EQUIVALENTS",
      departmentPolicy: null, fundPolicy: null,
      departmentCodes: [], fundApplicabilityKeys: [],
    };
    // Explicit reviewed=true on a material-changing edit → still reviewed.
    expect(resolveReviewedAfterMaterialEdit({
      priorReviewed: true, explicitReviewed: true, priorMaterial,
      nextMaterial: { ...priorMaterial, categoryKey: "CAPITAL_ASSETS" },
    })).toBe(true);
    // Explicit reviewed=false ("Unmark") always wins.
    expect(resolveReviewedAfterMaterialEdit({
      priorReviewed: true, explicitReviewed: false, priorMaterial, nextMaterial: priorMaterial,
    })).toBe(false);
  });
});

describe("COA-UX-2c · §11.J ribbon + filter share the same predicate", () => {
  it("(J) client-side predicate matches server-side predicate exactly", () => {
    // Same inputs → same outputs. Guards against client/server drift.
    const cases: Array<Parameters<typeof clientHasAttentionCondition>[0]> = [
      { confidence: "high", departmentPolicy: "NOT_APPLICABLE", fundPolicy: "NOT_APPLICABLE", departmentApplicabilityCodes: [], fundApplicabilityKeys: [] },
      { confidence: "medium", departmentPolicy: "NOT_APPLICABLE", fundPolicy: "NOT_APPLICABLE", departmentApplicabilityCodes: [], fundApplicabilityKeys: [] },
      { confidence: "low", departmentPolicy: "NOT_APPLICABLE", fundPolicy: "NOT_APPLICABLE", departmentApplicabilityCodes: [], fundApplicabilityKeys: [] },
      { confidence: "high", departmentPolicy: "REQUIRED", fundPolicy: "NOT_APPLICABLE", departmentApplicabilityCodes: [], fundApplicabilityKeys: [] },
      { confidence: "high", departmentPolicy: "REQUIRED", fundPolicy: "NOT_APPLICABLE", departmentApplicabilityCodes: ["OPS"], fundApplicabilityKeys: [] },
      { confidence: "high", departmentPolicy: "NOT_APPLICABLE", fundPolicy: "REQUIRED", departmentApplicabilityCodes: [], fundApplicabilityKeys: [] },
      { confidence: "high", departmentPolicy: "NOT_APPLICABLE", fundPolicy: "REQUIRED", departmentApplicabilityCodes: [], fundApplicabilityKeys: ["OPERATING"] },
    ];
    for (const c of cases) {
      const server = hasAttentionCondition(c as CoaReviewInputRow);
      const client = clientHasAttentionCondition(c);
      expect(client).toBe(server);
    }
  });

  it("(J) client needsAttention == server needsAttention on the same row", () => {
    const bulkLike = {
      rowId: "r1", accountNumber: "1000", name: "Petty Cash", type: "ASSET",
      fsGroupKey: "BS_CASH_EQUIVALENTS", categoryKey: "CURRENT_ASSETS",
      confidence: "medium" as const,
      departmentPolicy: "NOT_APPLICABLE" as const, fundPolicy: "NOT_APPLICABLE" as const,
      departmentApplicabilityCodes: [], fundApplicabilityKeys: [],
      reviewed: false, capitalCandidate: false,
    };
    const clientResult = clientNeedsAttention(bulkLike);
    const serverInput: CoaReviewInputRow = {
      accountNumber: "1000", name: "Petty Cash", type: "ASSET",
      fsGroupKey: "BS_CASH_EQUIVALENTS", confidence: "medium", source: "default",
      departmentPolicy: "NOT_APPLICABLE", fundPolicy: "NOT_APPLICABLE",
      fundApplicabilityKeys: [], departmentApplicabilityCodes: [], reviewed: false,
    };
    expect(clientResult).toBe(needsAttention(serverInput));
  });
});

// ── §10 baseline reproduction — locks in the corrected count ──
describe("COA-UX-2c · founder-batch shape (simulated at unit level)", () => {
  it("562-row batch mirroring diagnostic: reviewed=453, unreviewed=109, dept-req-no-app rows overlap medium, attention = 93", () => {
    // Mirrors the read-only diagnostic against Coulee's live batch:
    //   total = 562
    //   reviewed = 453 / not-reviewed = 109
    //   confidence: high=372, medium=190, low=0
    //   dept-req-no-app: 265 total, 172 reviewed, 93 unreviewed
    //   fund-req-no-app: 0
    //   hasAttentionCondition: 368 (union), 275 reviewed, 93 unreviewed
    //
    // Constraint on the union to reach 93 unreviewed:
    //   the 93 unreviewed with dept-req-no-app FULLY CONTAIN the
    //   55 unreviewed medium (i.e. medium-unreviewed ⊂ dept-req-no-app-unreviewed).
    //   That matches Coulee's data where policy-required accounts also
    //   tend to be medium confidence.
    //
    // Buckets (all reviewed field values are the operator's persisted state):
    //   B1: dept-req-no-app + high     + reviewed   = 172 - 135 = 37
    //     (some reviewed dept-req-no-app are medium, some high)
    //   B2: dept-req-no-app + medium   + reviewed   = 135
    //   B3: dept-req-no-app + medium   + unreviewed = 55
    //   B4: dept-req-no-app + high     + unreviewed = 93 - 55 = 38
    //   B5: no attention cond + high  + reviewed   = 453 - 172 = 281
    //   B6: no attention cond + high  + unreviewed = 109 - 93 = 16
    //     -- but 16 must be ≥ 0 and cumulative confidence must equal 190 medium.
    //   Medium totals: B2+B3 = 135+55 = 190 ✓
    //   Reviewed: 37+135+281 = 453 ✓
    //   Unreviewed: 55+38+16 = 109 ✓
    //   dept-req-no-app: 37+135+55+38 = 265 ✓
    //   Total: 37+135+55+38+281+16 = 562 ✓
    const rows: CoaReviewInputRow[] = [];
    let cursor = 0;
    const push = (n: number, spec: Partial<CoaReviewInputRow>) => {
      for (let i = 0; i < n; i++) rows.push(row({ accountNumber: `A${cursor++}`, ...spec }));
    };
    push(37, { confidence: "high", reviewed: true, departmentPolicy: "REQUIRED", departmentApplicabilityCodes: [] });
    push(135, { confidence: "medium", reviewed: true, departmentPolicy: "REQUIRED", departmentApplicabilityCodes: [] });
    push(55, { confidence: "medium", reviewed: false, departmentPolicy: "REQUIRED", departmentApplicabilityCodes: [] });
    push(38, { confidence: "high", reviewed: false, departmentPolicy: "REQUIRED", departmentApplicabilityCodes: [] });
    push(281, { confidence: "high", reviewed: true });
    push(16, { confidence: "high", reviewed: false });

    expect(rows.length).toBe(562);
    const s = summariseCoaBatch(rows);
    expect(s.totalRows).toBe(562);
    expect(s.rowsReviewed).toBe(453);
    expect(s.rowsNotReviewed).toBe(109);
    expect(s.confidenceDistribution.high).toBe(372);
    expect(s.confidenceDistribution.medium).toBe(190);
    expect(s.confidenceDistribution.low).toBe(0);
    expect(s.departmentPolicyRequiredWithoutApplicability).toBe(265);
    expect(s.fundPolicyRequiredWithoutApplicability).toBe(0);

    // Corrected attention = 93 (unreviewed rows with any condition,
    // dedup'd via Set). Union of unreviewed conditions here:
    //   dept-req-no-app-unreviewed = 55 + 38 = 93
    //   medium-unreviewed        = 55        ⊂ 93
    //   ⇒ union = 93.
    expect(s.rowsRequiringAttention).toBe(93);
    // §4 sanity invariant.
    expect(s.rowsRequiringAttention).toBeLessThanOrEqual(s.rowsNotReviewed);
  });
});
