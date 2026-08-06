// Sprint 3 · Post-16H Phase 2.1 (2026-08-06) — durable accountRole
// enforcement tests. Includes mutation-guard-style tests that fail
// LOUDLY if the accountRole rule is removed from the orchestrator.

import { describe, it, expect } from "vitest";
import {
  evaluateEligibility, filterEligibleAccounts,
  type AccountEligibilityView, type AccountingTransactionContext,
} from "@/lib/accounting/eligibility";
import {
  ruleAccountRoleContraAsset, ruleAccountRoleForbidden,
} from "@/lib/accounting/eligibility/rules-structural";

function acct(over: Partial<AccountEligibilityView> = {}): AccountEligibilityView {
  return {
    id: "a1", accountNumber: "1513", name: "Accum Deprec — Computer Eqp & Fix",
    // Jonas convention — ASSET/DEBIT, so the type+normalBalance rule
    // does NOT fire. accountRole is the only structural signal.
    type: "ASSET", normalBalance: "DEBIT",
    isActive: true, isHeader: false, allowManualPosting: true,
    isControlAccount: false, isBankAccount: false, isCashAccount: false,
    archivedAt: null, fundApplicability: null,
    categoryKey: "CAPITAL_ASSETS", fsGroupKey: "BS_CAPITAL_ASSETS",
    accountRole: "CONTRA_ASSET",
    ...over,
  };
}
function ctx(role: AccountingTransactionContext["expectedDebitRole"] = "OPERATING_EXPENSE"): AccountingTransactionContext {
  return { transactionKind: "AP_INVOICE", expectedDebitRole: role };
}

describe("Phase 2.1 · ruleAccountRoleContraAsset (structural, name-independent)", () => {
  it("fires when accountRole=CONTRA_ASSET on Jonas-convention ASSET/DEBIT", () => {
    expect(ruleAccountRoleContraAsset(acct())).toBe("CONTRA_ASSET_NOT_VALID_FOR_PURCHASE");
  });
  it("fires when accountRole=CONTRA_ASSET on textbook ASSET/CREDIT (redundant but safe)", () => {
    expect(ruleAccountRoleContraAsset(acct({ normalBalance: "CREDIT" }))).toBe("CONTRA_ASSET_NOT_VALID_FOR_PURCHASE");
  });
  it("does NOT fire on STANDARD accounts regardless of name", () => {
    expect(ruleAccountRoleContraAsset(acct({ accountRole: "STANDARD" }))).toBeNull();
    expect(ruleAccountRoleContraAsset(acct({ accountRole: "STANDARD", name: "Accum Deprec — Land Improvements" }))).toBeNull();
  });
});

describe("Phase 2.1 · ruleAccountRoleForbidden", () => {
  it("CONTROL / BANK / CASH / CLEARING / CONTRA_REVENUE / CONTRA_LIABILITY all map to reasons", () => {
    for (const [role, reason] of [
      ["CONTROL", "CONTROL_ACCOUNT"],
      ["BANK", "BANK_ACCOUNT_NOT_VALID_FOR_AP_ALLOCATION"],
      ["CASH", "CASH_ACCOUNT_NOT_VALID_FOR_AP_ALLOCATION"],
      ["CLEARING", "SYSTEM_ACCOUNT_NOT_USER_POSTABLE"],
      ["CONTRA_REVENUE", "REVENUE_NOT_VALID_FOR_AP_DEBIT"],
      ["CONTRA_LIABILITY", "LIABILITY_NOT_VALID_FOR_AP_DEBIT"],
    ] as const) {
      const v = ruleAccountRoleForbidden(acct({ accountRole: role, type: "ASSET" }));
      expect(v, `role=${role}`).toBe(reason);
    }
  });
  it("STANDARD accountRole → no reason", () => {
    expect(ruleAccountRoleForbidden(acct({ accountRole: "STANDARD" }))).toBeNull();
  });
});

describe("Phase 2.1 · orchestrator — CONTRA_ASSET is INELIGIBLE under every nature", () => {
  it.each(["OPERATING_EXPENSE","CAPITAL_ASSET","INVENTORY","PREPAID_EXPENSE","REPAIR_AND_MAINTENANCE","PROFESSIONAL_SERVICE","UTILITY_OR_RECURRING_SERVICE","TAX_OR_REGULATORY","INTEREST_OR_PENALTY","UNKNOWN"] as const)(
    "%s → INELIGIBLE with CONTRA_ASSET_NOT_VALID_FOR_PURCHASE",
    (role) => {
      const v = evaluateEligibility(acct(), ctx(role));
      expect(v.eligible).toBe(false);
      expect(v.exclusionReasons).toContain("CONTRA_ASSET_NOT_VALID_FOR_PURCHASE");
    },
  );
});

describe("Phase 2.1 · mutation-guard proof (accountRole rule is load-bearing)", () => {
  // The adversarial scenario: CAPITAL context, ASSET/DEBIT contra
  // account. Without the accountRole rule the account would pass
  // structural checks + the CAPITAL nature admits ASSETs, so it
  // would enter the ranker. WITH the rule it is excluded.
  it("Jonas-convention contra is rejected under CAPITAL nature (accountRole rule required)", () => {
    const jonas = acct({ id: "j1", accountNumber: "1513", accountRole: "CONTRA_ASSET" });
    const v = evaluateEligibility(jonas, ctx("CAPITAL_ASSET"));
    expect(v.eligible).toBe(false);
    // Explicit assertion: the CONTRA_ASSET reason MUST come from the
    // accountRole rule (the type+normalBalance rule doesn't fire on
    // ASSET/DEBIT). Removing ruleAccountRoleContraAsset from the
    // orchestrator would make this expectation fail.
    expect(v.exclusionReasons).toContain("CONTRA_ASSET_NOT_VALID_FOR_PURCHASE");
    // Sanity: the un-backfilled sibling account (accountRole=STANDARD,
    // ASSET/DEBIT, same name shape) is NOT caught structurally under
    // CAPITAL context — proves the accountRole field is what closes
    // the gap.
    const unbackfilled = acct({ id: "j2", accountNumber: "1515", accountRole: "STANDARD" });
    const w = evaluateEligibility(unbackfilled, ctx("CAPITAL_ASSET"));
    expect(w.eligible).toBe(true);
    expect(w.exclusionReasons).toEqual([]);
  });

  it("filterEligibleAccounts removes CONTRA_ASSET rows from the candidate pool under CAPITAL", () => {
    const pool: AccountEligibilityView[] = [
      acct({ id: "s1", accountNumber: "1540", name: "Equipment & Vehicles", accountRole: "STANDARD" }),
      acct({ id: "s2", accountNumber: "1513", name: "Accum Deprec — Computer Eqp & Fix", accountRole: "CONTRA_ASSET" }),
      acct({ id: "s3", accountNumber: "1514", name: "Accum Deprec — Equip under financing", accountRole: "CONTRA_ASSET" }),
    ];
    const res = filterEligibleAccounts(pool, ctx("CAPITAL_ASSET"));
    const eligibleNumbers = res.eligible.map((e) => e.accountNumber).sort();
    expect(eligibleNumbers).toEqual(["1540"]);
    expect(res.rejected.map((r) => r.accountNumber).sort()).toEqual(["1513", "1514"]);
    for (const r of res.rejected) {
      expect(r.exclusionReasons).toContain("CONTRA_ASSET_NOT_VALID_FOR_PURCHASE");
    }
  });
});
