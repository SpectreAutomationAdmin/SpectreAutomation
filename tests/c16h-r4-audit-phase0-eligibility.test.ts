// Sprint 3 · Checkpoint 16H rejection #4 → audit approval (2026-08-06)
// Phase 0 safety containment — pure-function unit tests.
//
// The benchmark harness exercises the wire-in end-to-end on the
// pathological case; these tests exercise every ineligibility
// reason in isolation so a future regression in one specific rule
// is caught even if no benchmark case triggers it.

import { describe, it, expect } from "vitest";
import {
  evaluateAccountForApDebit,
  applyPhase0SafetyContainment,
  type AccountSafetyView,
  type Phase0IneligibilityReason,
} from "@/lib/ap-intelligence/eligibility/phase0-safety";
import type { GlRecommendation } from "@/lib/ap-intelligence/gl-recommend";

function acct(overrides: Partial<AccountSafetyView> = {}): AccountSafetyView {
  return {
    accountNumber: "6020", name: "Grounds Maintenance",
    type: "EXPENSE", normalBalance: "DEBIT",
    isActive: true, isHeader: false, allowManualPosting: true,
    isControlAccount: false, isBankAccount: false, isCashAccount: false,
    ...overrides,
  };
}

function rec(overrides: Partial<GlRecommendation> = {}): GlRecommendation {
  return {
    ruleVersion: 3,
    accountNumber: "6020", accountName: "Grounds Maintenance",
    categoryKey: null, fsGroupKey: null,
    confidence: 85,
    reason: "test",
    source: "SEMANTIC_MATCH",
    candidates: [
      { accountNumber: "6020", accountName: "Grounds Maintenance", semanticScore: 90, evidenceSummary: "", categoryKey: null, fsGroupKey: null },
      { accountNumber: "5310", accountName: "Fuel — Grounds Equipment", semanticScore: 80, evidenceSummary: "", categoryKey: null, fsGroupKey: null },
    ] as any,
    leaderIsPostable: true,
    leaderPostingBlockers: [],
    autoApprovalEligible: true,
    rationale: {} as any,
    totalAccountsEvaluated: 20,
    requiresReview: false,
    splitRecommendations: [],
    ...overrides,
  };
}

describe("16H · Phase 0 safety — pure evaluator", () => {
  it("clean EXPENSE account is eligible", () => {
    const v = evaluateAccountForApDebit(acct());
    expect(v.eligible).toBe(true);
    expect(v.reasons).toEqual([]);
  });

  it("INACTIVE account is rejected", () => {
    const v = evaluateAccountForApDebit(acct({ isActive: false }));
    expect(v.reasons).toContain("INACTIVE" satisfies Phase0IneligibilityReason);
  });

  it("HEADER account is rejected", () => {
    const v = evaluateAccountForApDebit(acct({ isHeader: true }));
    expect(v.reasons).toContain("HEADER_ACCOUNT");
  });

  it("CONTROL account is rejected", () => {
    const v = evaluateAccountForApDebit(acct({ isControlAccount: true }));
    expect(v.reasons).toContain("CONTROL_ACCOUNT");
  });

  it("MANUAL POSTING DISALLOWED is rejected", () => {
    const v = evaluateAccountForApDebit(acct({ allowManualPosting: false }));
    expect(v.reasons).toContain("MANUAL_POSTING_DISALLOWED");
  });

  it("CONTRA-ASSET (type=ASSET, normalBalance=CREDIT) is rejected", () => {
    const v = evaluateAccountForApDebit(acct({
      type: "ASSET", normalBalance: "CREDIT",
      name: "Accum Deprec — Computer Equipment & Fixtures",
      accountNumber: "1710",
    }));
    expect(v.reasons).toContain("CONTRA_ASSET_NOT_VALID_FOR_PURCHASE");
    // The name uses the abbreviation "Deprec" that escaped the
    // pre-fix nature-scoped ranker's text pattern. Verify the
    // structural rule catches it regardless of spelling.
  });

  it("REVENUE is rejected", () => {
    const v = evaluateAccountForApDebit(acct({ type: "REVENUE", normalBalance: "CREDIT", accountNumber: "4100", name: "Green Fees" }));
    expect(v.reasons).toContain("REVENUE_NOT_VALID_FOR_AP_DEBIT");
  });

  it("EQUITY is rejected", () => {
    const v = evaluateAccountForApDebit(acct({ type: "EQUITY", normalBalance: "CREDIT", accountNumber: "3100", name: "Retained Earnings" }));
    expect(v.reasons).toContain("EQUITY_NOT_VALID_FOR_AP_DEBIT");
  });

  it("BANK account is rejected", () => {
    const v = evaluateAccountForApDebit(acct({ isBankAccount: true, accountNumber: "1100", name: "Operating Bank Account" }));
    expect(v.reasons).toContain("BANK_OR_CASH_NOT_VALID_FOR_EXPENSE_ALLOCATION");
  });

  it("CASH account is rejected", () => {
    const v = evaluateAccountForApDebit(acct({ isCashAccount: true, accountNumber: "1200", name: "Petty Cash" }));
    expect(v.reasons).toContain("BANK_OR_CASH_NOT_VALID_FOR_EXPENSE_ALLOCATION");
  });

  it("NORMAL BALANCE CONTRADICTION on EXPENSE/CREDIT is rejected", () => {
    const v = evaluateAccountForApDebit(acct({ type: "EXPENSE", normalBalance: "CREDIT" }));
    expect(v.reasons).toContain("NORMAL_BALANCE_CONTRADICTION");
  });
});

describe("16H · Phase 0 safety — containment wrapper", () => {
  it("passes through when the leader is eligible", () => {
    const r = rec();
    const m = new Map([["6020", acct()]]);
    const g = applyPhase0SafetyContainment(r, m);
    expect(g.suppressed).toBe(false);
    expect(g.recommendation.accountNumber).toBe("6020");
    expect(g.diagnostic).toBeNull();
  });

  it("suppresses to abstention when the leader is a contra-asset", () => {
    const contra = acct({ accountNumber: "1710", name: "Accum Deprec — Computer Equipment & Fixtures", type: "ASSET", normalBalance: "CREDIT" });
    const r = rec({ accountNumber: "1710", accountName: contra.name, candidates: [{ accountNumber: "1710", accountName: contra.name, semanticScore: 45, evidenceSummary: "", categoryKey: null, fsGroupKey: null }] as any });
    const m = new Map([["1710", contra]]);
    const g = applyPhase0SafetyContainment(r, m);
    expect(g.suppressed).toBe(true);
    expect(g.recommendation.accountNumber).toBeNull();
    expect(g.recommendation.source).toBe("NONE");
    expect(g.recommendation.confidence).toBeNull();
    expect(g.recommendation.requiresReview).toBe(true);
    expect(g.recommendation.candidates).toEqual([]);
    expect(g.diagnostic).not.toBeNull();
    expect(g.diagnostic!.suppressedLeaderAccountNumber).toBe("1710");
    expect(g.diagnostic!.suppressedLeaderReasons).toContain("CONTRA_ASSET_NOT_VALID_FOR_PURCHASE");
  });

  it("does NOT silently substitute the next eligible candidate", () => {
    // Founder §0.5 — no silent substitution. Leader ineligible →
    // abstain, even if the next candidate is fine.
    const contra = acct({ accountNumber: "1710", type: "ASSET", normalBalance: "CREDIT" });
    const fine = acct({ accountNumber: "5310", name: "Fuel — Grounds Equipment" });
    const r = rec({
      accountNumber: "1710",
      accountName: "Accum Deprec — Computer Equipment & Fixtures",
      candidates: [
        { accountNumber: "1710", accountName: "Accum Deprec — Computer Equipment & Fixtures", semanticScore: 60, evidenceSummary: "", categoryKey: null, fsGroupKey: null },
        { accountNumber: "5310", accountName: "Fuel — Grounds Equipment", semanticScore: 40, evidenceSummary: "", categoryKey: null, fsGroupKey: null },
      ] as any,
    });
    const m = new Map([["1710", contra], ["5310", fine]]);
    const g = applyPhase0SafetyContainment(r, m);
    expect(g.suppressed).toBe(true);
    expect(g.recommendation.accountNumber).toBeNull();
    // Diagnostic must include BOTH candidates' verdicts so the
    // reviewer can see the eligible alternative existed.
    expect(g.diagnostic!.candidateAudit.length).toBe(2);
    const fineAudit = g.diagnostic!.candidateAudit.find((c) => c.accountNumber === "5310");
    expect(fineAudit?.eligible).toBe(true);
  });

  it("passes through unchanged when the base ranker already abstained", () => {
    const r = rec({ accountNumber: null, accountName: null, source: "NONE", confidence: null, candidates: [] as any });
    const g = applyPhase0SafetyContainment(r, new Map());
    expect(g.suppressed).toBe(false);
    expect(g.recommendation.accountNumber).toBeNull();
    expect(g.diagnostic).toBeNull();
  });
});
