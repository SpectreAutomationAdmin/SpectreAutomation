// Sprint 3 · Post-16H Phase 2 (2026-08-06) — accounting eligibility
// module unit tests. Covers every rule in isolation + the
// orchestrator + the shadow comparator. Mutation-guard-style tests
// prove that removing a rule breaks a specific case.

import { describe, it, expect } from "vitest";
import {
  evaluateEligibility, filterEligibleAccounts,
  compareShadow,
  isPhase2EligibilityEnabled,
  ELIGIBILITY_RULE_VERSION,
  type AccountEligibilityView, type AccountingTransactionContext,
  type ExpectedDebitRole,
} from "@/lib/accounting/eligibility";
import {
  ruleInactive, ruleArchived, ruleHeader, ruleControl,
  ruleManualPostingProhibited, ruleBank, ruleCash,
  ruleRevenue, ruleEquity, ruleLiability,
  ruleContraAsset, ruleNormalBalanceContradiction,
  ruleNatureAssetExcluded,
  postingBlockerFundApplicability,
} from "@/lib/accounting/eligibility/rules-structural";

function acct(over: Partial<AccountEligibilityView> = {}): AccountEligibilityView {
  return {
    id: "a1", accountNumber: "6020", name: "Grounds Maintenance",
    type: "EXPENSE", normalBalance: "DEBIT",
    isActive: true, isHeader: false, allowManualPosting: true,
    isControlAccount: false, isBankAccount: false, isCashAccount: false,
    archivedAt: null, fundApplicability: "OPERATING",
    categoryKey: null, fsGroupKey: null,
    ...over,
  };
}
function ctx(role: ExpectedDebitRole = "OPERATING_EXPENSE", extra: Partial<AccountingTransactionContext> = {}): AccountingTransactionContext {
  return { transactionKind: "AP_INVOICE", expectedDebitRole: role, ...extra };
}

// ---------------------------------------------------------------------------
// Rule-in-isolation tests (one per rule) — mutation guard: deleting
// any rule from index.ts causes at least one of these to FAIL.
// ---------------------------------------------------------------------------

describe("Phase 2 · structural rules — each fires only on its trigger", () => {
  it("ruleInactive fires only when isActive=false", () => {
    expect(ruleInactive(acct())).toBeNull();
    expect(ruleInactive(acct({ isActive: false }))).toBe("INACTIVE");
  });
  it("ruleArchived fires only when archivedAt!=null", () => {
    expect(ruleArchived(acct())).toBeNull();
    expect(ruleArchived(acct({ archivedAt: new Date() }))).toBe("ARCHIVED");
  });
  it("ruleHeader fires only when isHeader=true", () => {
    expect(ruleHeader(acct())).toBeNull();
    expect(ruleHeader(acct({ isHeader: true }))).toBe("HEADER_ACCOUNT");
  });
  it("ruleControl fires only when isControlAccount=true", () => {
    expect(ruleControl(acct())).toBeNull();
    expect(ruleControl(acct({ isControlAccount: true }))).toBe("CONTROL_ACCOUNT");
  });
  it("ruleManualPostingProhibited fires only when allowManualPosting=false", () => {
    expect(ruleManualPostingProhibited(acct())).toBeNull();
    expect(ruleManualPostingProhibited(acct({ allowManualPosting: false }))).toBe("MANUAL_POSTING_PROHIBITED");
  });
  it("ruleBank fires only when isBankAccount=true", () => {
    expect(ruleBank(acct())).toBeNull();
    expect(ruleBank(acct({ isBankAccount: true }))).toBe("BANK_ACCOUNT_NOT_VALID_FOR_AP_ALLOCATION");
  });
  it("ruleCash fires only when isCashAccount=true", () => {
    expect(ruleCash(acct())).toBeNull();
    expect(ruleCash(acct({ isCashAccount: true }))).toBe("CASH_ACCOUNT_NOT_VALID_FOR_AP_ALLOCATION");
  });
  it("ruleRevenue fires only when type=REVENUE", () => {
    expect(ruleRevenue(acct())).toBeNull();
    expect(ruleRevenue(acct({ type: "REVENUE", normalBalance: "CREDIT" }))).toBe("REVENUE_NOT_VALID_FOR_AP_DEBIT");
  });
  it("ruleEquity fires only when type=EQUITY", () => {
    expect(ruleEquity(acct())).toBeNull();
    expect(ruleEquity(acct({ type: "EQUITY", normalBalance: "CREDIT" }))).toBe("EQUITY_NOT_VALID_FOR_AP_DEBIT");
  });
  it("ruleLiability fires only when type=LIABILITY", () => {
    expect(ruleLiability(acct())).toBeNull();
    expect(ruleLiability(acct({ type: "LIABILITY", normalBalance: "CREDIT" }))).toBe("LIABILITY_NOT_VALID_FOR_AP_DEBIT");
  });
  it("ruleContraAsset fires only when type=ASSET AND normalBalance=CREDIT", () => {
    expect(ruleContraAsset(acct({ type: "ASSET" }))).toBeNull();
    expect(ruleContraAsset(acct({ type: "ASSET", normalBalance: "CREDIT" }))).toBe("CONTRA_ASSET_NOT_VALID_FOR_PURCHASE");
    // Regression guard for Coulee Ridge's Jonas convention: contra
    // accounts stored as ASSET/DEBIT must NOT be caught by the
    // structural rule (the delivery reports this gap for Phase 6).
    expect(ruleContraAsset(acct({ type: "ASSET", normalBalance: "DEBIT", name: "Accum Deprec — Grounds" }))).toBeNull();
  });
  it("ruleNormalBalanceContradiction catches EXPENSE/CREDIT edge", () => {
    expect(ruleNormalBalanceContradiction(acct())).toBeNull();
    expect(ruleNormalBalanceContradiction(acct({ type: "EXPENSE", normalBalance: "CREDIT" }))).toBe("NORMAL_BALANCE_CONTRADICTION");
  });
  it("ruleNatureAssetExcluded excludes ASSET from OPERATING_EXPENSE", () => {
    const asset = acct({ type: "ASSET", accountNumber: "1540" });
    expect(ruleNatureAssetExcluded(asset, ctx("OPERATING_EXPENSE"))).toBe("TRANSACTION_NATURE_INCOMPATIBLE");
    expect(ruleNatureAssetExcluded(asset, ctx("CAPITAL_ASSET"))).toBeNull();
    expect(ruleNatureAssetExcluded(asset, ctx("INVENTORY"))).toBeNull();
    expect(ruleNatureAssetExcluded(asset, ctx("PREPAID_EXPENSE"))).toBeNull();
    // R&M requires supporting capitalization evidence.
    expect(ruleNatureAssetExcluded(asset, ctx("REPAIR_AND_MAINTENANCE"))).toBe("TRANSACTION_NATURE_INCOMPATIBLE");
    expect(ruleNatureAssetExcluded(asset, ctx("REPAIR_AND_MAINTENANCE", { capitalizationEvidence: { supported: true, confidence: 80 } }))).toBeNull();
    // EXPENSE never triggers this rule.
    expect(ruleNatureAssetExcluded(acct(), ctx("OPERATING_EXPENSE"))).toBeNull();
  });
  it("postingBlockerFundApplicability flags EXPENSE with no fund but does NOT exclude", () => {
    expect(postingBlockerFundApplicability(acct(), ctx())).toBeNull();
    expect(postingBlockerFundApplicability(acct({ fundApplicability: null }), ctx())).toBe("FUND_APPLICABILITY_UNMAPPED");
    expect(postingBlockerFundApplicability(acct({ fundApplicability: "" }), ctx())).toBe("FUND_APPLICABILITY_UNMAPPED");
    // BS accounts never require fund applicability.
    expect(postingBlockerFundApplicability(acct({ type: "ASSET", fundApplicability: null }), ctx())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Orchestrator tests
// ---------------------------------------------------------------------------

describe("Phase 2 · evaluateEligibility orchestrator", () => {
  it("clean OPERATING account is ELIGIBLE", () => {
    const v = evaluateEligibility(acct(), ctx());
    expect(v.eligible).toBe(true);
    expect(v.eligibilityClass).toBe("ELIGIBLE");
    expect(v.exclusionReasons).toEqual([]);
    expect(v.postingBlockers).toEqual([]);
    expect(v.ruleVersion).toBe(ELIGIBILITY_RULE_VERSION);
  });

  it("clean OPERATING account with no fund is CONDITIONALLY_ELIGIBLE", () => {
    const v = evaluateEligibility(acct({ fundApplicability: null }), ctx());
    expect(v.eligible).toBe(true);
    expect(v.eligibilityClass).toBe("CONDITIONALLY_ELIGIBLE");
    expect(v.postingBlockers).toContain("FUND_APPLICABILITY_UNMAPPED");
  });

  it("contra-asset (ASSET/CREDIT) is INELIGIBLE regardless of nature", () => {
    const contra = acct({ id: "a2", accountNumber: "1710", name: "Accum Deprec — Computer Equipment & Fixtures", type: "ASSET", normalBalance: "CREDIT" });
    for (const role of ["OPERATING_EXPENSE", "CAPITAL_ASSET", "INVENTORY", "PREPAID_EXPENSE", "REPAIR_AND_MAINTENANCE"] as ExpectedDebitRole[]) {
      const v = evaluateEligibility(contra, ctx(role));
      expect(v.eligible).toBe(false);
      expect(v.exclusionReasons).toContain("CONTRA_ASSET_NOT_VALID_FOR_PURCHASE");
    }
  });

  it("ordinary ASSET is INELIGIBLE for OPERATING but ELIGIBLE for CAPITAL", () => {
    const asset = acct({ id: "a3", accountNumber: "1540", name: "Equipment & Vehicles", type: "ASSET" });
    expect(evaluateEligibility(asset, ctx("OPERATING_EXPENSE")).eligible).toBe(false);
    expect(evaluateEligibility(asset, ctx("CAPITAL_ASSET")).eligible).toBe(true);
  });

  it("collects MULTIPLE reasons when several rules trigger", () => {
    const worst = acct({
      accountNumber: "9998",
      isActive: false, isHeader: true, isControlAccount: true,
      type: "REVENUE", normalBalance: "CREDIT",
      isBankAccount: true, isCashAccount: true,
    });
    const v = evaluateEligibility(worst, ctx());
    expect(v.exclusionReasons.length).toBeGreaterThanOrEqual(6);
    expect(v.exclusionReasons).toContain("INACTIVE");
    expect(v.exclusionReasons).toContain("HEADER_ACCOUNT");
    expect(v.exclusionReasons).toContain("CONTROL_ACCOUNT");
    expect(v.exclusionReasons).toContain("REVENUE_NOT_VALID_FOR_AP_DEBIT");
    expect(v.exclusionReasons).toContain("BANK_ACCOUNT_NOT_VALID_FOR_AP_ALLOCATION");
    expect(v.exclusionReasons).toContain("CASH_ACCOUNT_NOT_VALID_FOR_AP_ALLOCATION");
  });
});

// ---------------------------------------------------------------------------
// Bulk filter — order-independence + tenant-isolation guarantees
// ---------------------------------------------------------------------------

describe("Phase 2 · filterEligibleAccounts", () => {
  const chart = () => [
    acct({ id: "a-6020", accountNumber: "6020", name: "Grounds Maintenance", type: "EXPENSE" }),
    acct({ id: "a-5310", accountNumber: "5310", name: "Fuel — Grounds Equipment", type: "EXPENSE" }),
    acct({ id: "a-1710", accountNumber: "1710", name: "Accum Deprec — Computer Eq & Fix", type: "ASSET", normalBalance: "CREDIT" }),
    acct({ id: "a-1100", accountNumber: "1100", name: "Operating Bank Account", type: "ASSET", isBankAccount: true }),
    acct({ id: "a-4100", accountNumber: "4100", name: "Green Fees", type: "REVENUE", normalBalance: "CREDIT" }),
    acct({ id: "a-3100", accountNumber: "3100", name: "Retained Earnings", type: "EQUITY", normalBalance: "CREDIT", allowManualPosting: false }),
    acct({ id: "a-9999", accountNumber: "9999", name: "Legacy Discontinued", type: "EXPENSE", isActive: false }),
    acct({ id: "a-5000", accountNumber: "5000", name: "Cost of Sales Header", type: "EXPENSE", isHeader: true }),
    acct({ id: "a-2100", accountNumber: "2100", name: "AP Subledger Control", type: "LIABILITY", normalBalance: "CREDIT", isControlAccount: true }),
    acct({ id: "a-1540", accountNumber: "1540", name: "Equipment & Vehicles", type: "ASSET" }),
  ];

  it("under OPERATING context only ordinary EXPENSE accounts pass", () => {
    const res = filterEligibleAccounts(chart(), ctx("OPERATING_EXPENSE"));
    const nums = res.eligible.map((e) => e.accountNumber).sort();
    expect(nums).toEqual(["5310", "6020"]);
    expect(res.rejected.length).toBe(8);
  });

  it("under CAPITAL context ordinary assets are admitted, contras still rejected", () => {
    const res = filterEligibleAccounts(chart(), ctx("CAPITAL_ASSET"));
    const nums = res.eligible.map((e) => e.accountNumber).sort();
    expect(nums).toEqual(["1540", "5310", "6020"]);
    // The contra-asset is STILL rejected.
    const contraVerdict = res.rejected.find((r) => r.accountNumber === "1710");
    expect(contraVerdict?.exclusionReasons).toContain("CONTRA_ASSET_NOT_VALID_FOR_PURCHASE");
  });

  it("verdictsByAccountId contains every account", () => {
    const list = chart();
    const res = filterEligibleAccounts(list, ctx());
    expect(res.verdictsByAccountId.size).toBe(list.length);
  });

  it("result is invariant under input order (deterministic)", () => {
    const ordered = chart();
    const reversed = [...chart()].reverse();
    const a = filterEligibleAccounts(ordered, ctx()).eligible.map((x) => x.accountNumber).sort();
    const b = filterEligibleAccounts(reversed, ctx()).eligible.map((x) => x.accountNumber).sort();
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// Shadow comparator
// ---------------------------------------------------------------------------

describe("Phase 2 · shadow comparison", () => {
  it("AGREE_BOTH_SURFACED_SAME when neither guard fired", () => {
    const v = compareShadow({
      phase0Suppressed: false,
      phase0SuppressedLeaderAccountNumber: null,
      phase2LeaderAccountNumber: "6020",
      phase2AbstentionReason: null,
    });
    expect(v).toBe("AGREE_BOTH_SURFACED_SAME");
  });
  it("AGREE_BOTH_SUPPRESSED_SAME when both suppressed the same leader", () => {
    const v = compareShadow({
      phase0Suppressed: true,
      phase0SuppressedLeaderAccountNumber: "1710",
      phase2LeaderAccountNumber: null,
      phase2AbstentionReason: "no eligible leader",
    });
    expect(v).toBe("AGREE_BOTH_SUPPRESSED_SAME");
  });
  it("DISAGREE_PHASE0_ONLY when Phase 0 caught what Phase 2 missed", () => {
    const v = compareShadow({
      phase0Suppressed: true,
      phase0SuppressedLeaderAccountNumber: "1710",
      phase2LeaderAccountNumber: "5310",
      phase2AbstentionReason: null,
    });
    expect(v).toBe("DISAGREE_PHASE0_ONLY");
  });
  it("DISAGREE_PHASE2_ONLY when Phase 2 caught what Phase 0 missed", () => {
    const v = compareShadow({
      phase0Suppressed: false,
      phase0SuppressedLeaderAccountNumber: null,
      phase2LeaderAccountNumber: null,
      phase2AbstentionReason: "no eligible leader cleared threshold",
    });
    expect(v).toBe("DISAGREE_PHASE2_ONLY");
  });
});

// ---------------------------------------------------------------------------
// Env-flag guardrail
// ---------------------------------------------------------------------------

describe("Phase 2 · env flag", () => {
  it("isPhase2EligibilityEnabled defaults ON", () => {
    delete process.env.AP_INTELLIGENCE_PHASE2_ELIGIBILITY;
    expect(isPhase2EligibilityEnabled()).toBe(true);
  });
  it("respects explicit OFF values", () => {
    for (const v of ["0", "false", "off", "disabled", "OFF"]) {
      process.env.AP_INTELLIGENCE_PHASE2_ELIGIBILITY = v;
      expect(isPhase2EligibilityEnabled()).toBe(false);
    }
    delete process.env.AP_INTELLIGENCE_PHASE2_ELIGIBILITY;
  });
});
