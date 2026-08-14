// Phase 4R · Phase 7.2I-b (2026-08-13) — compositional capital admission tests.
//
// Founder-mandatory capital controls per §7.2I-b:
//   1. clear equipment acquisition — ASSET admission opens
//   2. clear capital improvement — preserved (7.2F fix)
//   3. ordinary equipment repair — NOT capitalized
//   4. equipment parts — NOT capitalized
//   5. high-value operating service — NOT capitalized
//   6. financed equipment acquisition — ASSET admission opens
//   7. ambiguous repair/replacement — canonical decides
//   8. completed-capital-improvement safety — preserved
//
// This test exercises the eligibility rule directly, not the full
// analyser pipeline, to isolate the admission decision from other
// factors.

import { describe, expect, it } from "vitest";
import { ruleNatureAssetExcluded } from "@/lib/accounting/eligibility/rules-structural";
import type { AccountingTransactionContext, AccountEligibilityView } from "@/lib/accounting/eligibility/types";

function mkAsset(o: Partial<AccountEligibilityView> = {}): AccountEligibilityView {
  return {
    id: "acct-1506", accountNumber: "1506",
    name: "Equipment & Fixtures — Grounds",
    type: "ASSET", normalBalance: "DEBIT",
    isActive: true, isHeader: false,
    allowManualPosting: true,
    isControlAccount: false, isBankAccount: false, isCashAccount: false,
    archivedAt: null,
    fundApplicability: "OPERATING",
    categoryKey: "CAPITAL_ASSETS",
    fsGroupKey: null,
    ...o,
  };
}
function mkCtx(o: Partial<AccountingTransactionContext> = {}): AccountingTransactionContext {
  return {
    expectedDebitRole: "UNKNOWN",
    invoiceAmountCents: 500000,
    capitalizationEvidence: null,
    hasPayrollEvidence: false,
    ...o,
  };
}

describe("Phase 7.2I-b · compositional capital admission — asset eligibility", () => {
  it("§7.2I-b PRIMARY — expectedDebitRole=CAPITAL_ASSET admits ASSET accounts (composed from defensible nature)", () => {
    // When analyse.ts sets expectedDebitRole=CAPITAL_ASSET (either
    // because capital.state==="CAPITAL" OR nature.leader===CAPITAL_ASSET+isDefensible),
    // ASSET accounts must NOT be excluded by nature.
    const result = ruleNatureAssetExcluded(mkAsset(), mkCtx({ expectedDebitRole: "CAPITAL_ASSET" }));
    expect(result).toBeNull();
  });

  it("§17 SAFETY — expectedDebitRole=UNKNOWN still excludes ASSET (no other-classifier admission)", () => {
    // If both capital.state is AMBIGUOUS AND nature does NOT commit
    // CAPITAL_ASSET defensibly, expectedDebitRole stays UNKNOWN and
    // ASSET stays excluded. This is the pre-7.2I-b default.
    const result = ruleNatureAssetExcluded(mkAsset(), mkCtx({ expectedDebitRole: "UNKNOWN" }));
    expect(result).toBe("TRANSACTION_NATURE_INCOMPATIBLE");
  });

  it("§7.2I-b — expectedDebitRole=OPERATING_EXPENSE still excludes ASSET (operating overrides)", () => {
    // If capital classifier says OPERATING, ASSET admission does not
    // reopen — the operating verdict is authoritative.
    const result = ruleNatureAssetExcluded(mkAsset(), mkCtx({ expectedDebitRole: "OPERATING_EXPENSE" }));
    expect(result).toBe("TRANSACTION_NATURE_INCOMPATIBLE");
  });

  it("§7.2I-b — R&M route unchanged (still admits ASSET only with capitalization evidence)", () => {
    const withoutCapEv = ruleNatureAssetExcluded(mkAsset(), mkCtx({ expectedDebitRole: "REPAIR_AND_MAINTENANCE" }));
    expect(withoutCapEv).toBe("TRANSACTION_NATURE_INCOMPATIBLE");
    const withCapEv = ruleNatureAssetExcluded(mkAsset(), mkCtx({
      expectedDebitRole: "REPAIR_AND_MAINTENANCE",
      capitalizationEvidence: { supported: true, reasons: ["test"] },
    }));
    expect(withCapEv).toBeNull();
  });

  it("§7.2I-b — INVENTORY / PREPAID admission preserved", () => {
    expect(ruleNatureAssetExcluded(mkAsset(), mkCtx({ expectedDebitRole: "INVENTORY" }))).toBeNull();
    expect(ruleNatureAssetExcluded(mkAsset(), mkCtx({ expectedDebitRole: "PREPAID_EXPENSE" }))).toBeNull();
  });

  it("§7.2I-b — EXPENSE accounts always pass (rule only applies to ASSET)", () => {
    const expenseAccount = mkAsset({
      id: "acct-6020", accountNumber: "6020", name: "Grounds Maintenance", type: "EXPENSE",
      categoryKey: "REPAIRS_MAINTENANCE",
    });
    expect(ruleNatureAssetExcluded(expenseAccount, mkCtx({ expectedDebitRole: "CAPITAL_ASSET" }))).toBeNull();
    expect(ruleNatureAssetExcluded(expenseAccount, mkCtx({ expectedDebitRole: "OPERATING_EXPENSE" }))).toBeNull();
    expect(ruleNatureAssetExcluded(expenseAccount, mkCtx({ expectedDebitRole: "UNKNOWN" }))).toBeNull();
  });
});
