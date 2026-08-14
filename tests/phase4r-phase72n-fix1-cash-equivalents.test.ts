// Phase 4R · Phase 7.2N · Fix 1 (2026-08-14) — cash-equivalents
// structural eligibility repair.
//
// Founder §5 regression controls modeling the real Coulee Ridge
// staging COA metadata shape:
//   - type = ASSET
//   - accountRole = STANDARD
//   - isBankAccount = FALSE
//   - isCashAccount = FALSE
//   - fsGroupKey = BS_CASH_EQUIVALENTS
//
// Expectation: these accounts MUST be structurally restricted from
// AP classification (postingRole in {BANK, CASH}, structural posting
// restriction BANK_ACCOUNT/CASH_ACCOUNT present).
//
// Founder §3 counter-controls: capital / inventory / prepaid ASSET
// accounts (NOT cash-equivalent) must remain eligible.
//
// The fix must be structural (fsGroupKey), not lexical
// (`account name contains "bank"`) — the AP ineligibility does NOT
// depend on a fragile account-name match.

import { describe, expect, it } from "vitest";
import { resolveAccountSemantics } from "@/lib/ap-intelligence/account-semantics";
import type { EligibleAccountView } from "@/lib/ap-intelligence/accounting-nature-compatibility";

function mkAccount(o: Partial<EligibleAccountView>): EligibleAccountView {
  return {
    accountNumber: "0000",
    name: "Test Account",
    type: "ASSET",
    normalBalance: "DEBIT",
    isActive: true,
    isHeader: false,
    allowManualPosting: true,
    isControlAccount: false,
    isBankAccount: false,
    isCashAccount: false,
    categoryKey: null,
    fsGroupKey: null,
    accountRole: null,
    ...o,
  };
}

describe("Phase 7.2N · Fix 1 — real-COA cash-equivalent structural eligibility", () => {
  it("Petty Cash (ASSET / STANDARD / isCash=false / fsg=BS_CASH_EQUIVALENTS) → INELIGIBLE via CASH postingRole", () => {
    const s = resolveAccountSemantics(mkAccount({
      accountNumber: "1000",
      name: "Petty Cash",
      type: "ASSET",
      accountRole: "STANDARD",
      isBankAccount: false,
      isCashAccount: false,
      categoryKey: "CURRENT_ASSETS",
      fsGroupKey: "BS_CASH_EQUIVALENTS",
    }));
    expect(s.postingRole).toBe("CASH");
    expect(s.postingRoleSource).toBe("FS_GROUP");
    expect(s.structuralPostingRestrictions).toContain("CASH_ACCOUNT");
  });

  it("Bank - General (ASSET / STANDARD / isBank=false / fsg=BS_CASH_EQUIVALENTS + name has 'Bank') → INELIGIBLE via BANK postingRole", () => {
    const s = resolveAccountSemantics(mkAccount({
      accountNumber: "1001",
      name: "Bank - General",
      type: "ASSET",
      accountRole: "STANDARD",
      isBankAccount: false,
      isCashAccount: false,
      categoryKey: "CURRENT_ASSETS",
      fsGroupKey: "BS_CASH_EQUIVALENTS",
    }));
    expect(s.postingRole).toBe("BANK");
    expect(s.postingRoleSource).toBe("FS_GROUP");
    expect(s.structuralPostingRestrictions).toContain("BANK_ACCOUNT");
  });

  it("Bank - Credit Facilities/Mortgage (real 221178 wrongly-recommended account) → INELIGIBLE via BANK postingRole", () => {
    const s = resolveAccountSemantics(mkAccount({
      accountNumber: "9900",
      name: "Bank - Credit Facilities/Mortgage",
      type: "ASSET",
      accountRole: "STANDARD",
      isBankAccount: false,
      isCashAccount: false,
      categoryKey: "CURRENT_ASSETS",
      fsGroupKey: "BS_CASH_EQUIVALENTS",
    }));
    expect(s.postingRole).toBe("BANK");
    expect(s.structuralPostingRestrictions).toContain("BANK_ACCOUNT");
    expect(s.structuralPostingRestrictions.length).toBeGreaterThan(0);
  });

  it("BS_CASH_EQUIVALENTS without 'bank' in name (e.g. Petty Cash) → CASH not BANK", () => {
    const s = resolveAccountSemantics(mkAccount({
      accountNumber: "1005",
      name: "Change Float — Front Desk",
      type: "ASSET",
      fsGroupKey: "BS_CASH_EQUIVALENTS",
    }));
    expect(s.postingRole).toBe("CASH");
    expect(s.structuralPostingRestrictions).toContain("CASH_ACCOUNT");
  });

  it("§2 — INELIGIBILITY does NOT depend on account name; a fs-group cash account with a non-'bank' name still restricted", () => {
    // Same case as previous, phrased as an anti-fragility guard.
    const s = resolveAccountSemantics(mkAccount({
      accountNumber: "1099",
      name: "Undeposited Funds Clearing Account",
      type: "ASSET",
      fsGroupKey: "BS_CASH_EQUIVALENTS",
    }));
    // No 'bank' in name → postingRole = CASH.
    expect(s.postingRole).toBe("CASH");
    // But the ineligibility fires from the fs-group, not the name.
    expect(s.structuralPostingRestrictions).toContain("CASH_ACCOUNT");
  });
});

describe("Phase 7.2N · Fix 1 — §3 counter-controls (legitimate AP balance-sheet coding preserved)", () => {
  it("Capital equipment ASSET (BS_CAPITAL_ASSETS) — postingRole=STANDARD, no cash-equivalent restriction", () => {
    const s = resolveAccountSemantics(mkAccount({
      accountNumber: "1506",
      name: "Equipment & Fixtures — Grounds",
      type: "ASSET",
      categoryKey: "CAPITAL_ASSETS",
      fsGroupKey: "BS_CAPITAL_ASSETS",
    }));
    expect(s.postingRole).toBe("STANDARD");
    expect(s.structuralPostingRestrictions).not.toContain("BANK_ACCOUNT");
    expect(s.structuralPostingRestrictions).not.toContain("CASH_ACCOUNT");
  });

  it("Inventory ASSET (BS_INVENTORY) — postingRole=STANDARD, remains eligible", () => {
    const s = resolveAccountSemantics(mkAccount({
      accountNumber: "1300",
      name: "Inventory - Food",
      type: "ASSET",
      categoryKey: "CURRENT_ASSETS",
      fsGroupKey: "BS_INVENTORY",
    }));
    expect(s.postingRole).toBe("STANDARD");
    expect(s.structuralPostingRestrictions).not.toContain("BANK_ACCOUNT");
    expect(s.structuralPostingRestrictions).not.toContain("CASH_ACCOUNT");
  });

  it("Prepaid ASSET (BS_PREPAID_EXPENSES) — postingRole=STANDARD, remains eligible", () => {
    const s = resolveAccountSemantics(mkAccount({
      accountNumber: "1101",
      name: "Prepaid Expenses",
      type: "ASSET",
      categoryKey: "CURRENT_ASSETS",
      fsGroupKey: "BS_PREPAID_EXPENSES",
    }));
    expect(s.postingRole).toBe("STANDARD");
    expect(s.structuralPostingRestrictions).not.toContain("BANK_ACCOUNT");
    expect(s.structuralPostingRestrictions).not.toContain("CASH_ACCOUNT");
  });

  it("Inventory - Proshop Repairs (real Coulee Ridge account 1313) — remains STANDARD-eligible ASSET (this is the 221178 wrongly-picked account; Fix 1 should NOT restrict it — the correct fix path is elsewhere)", () => {
    const s = resolveAccountSemantics(mkAccount({
      accountNumber: "1313",
      name: "Inventory - Proshop Repairs",
      type: "ASSET",
      categoryKey: "CURRENT_ASSETS",
      fsGroupKey: "BS_INVENTORY",
    }));
    expect(s.postingRole).toBe("STANDARD");
    expect(s.structuralPostingRestrictions).not.toContain("BANK_ACCOUNT");
    expect(s.structuralPostingRestrictions).not.toContain("CASH_ACCOUNT");
    // Fix 1 addresses only the cash-equivalent leak. 1313 remains eligible
    // but for the 221178 case Fix 1 removes 9900 from the allocation
    // (the other wrongly-picked account). Whether 1313 still wins is a
    // separate treatment-defensibility question (Fix 2 territory).
  });
});

describe("Phase 7.2N · Fix 1 — legacy paths preserved", () => {
  it("Configured accountRole=BANK still wins over fs-group inference", () => {
    const s = resolveAccountSemantics(mkAccount({
      accountRole: "BANK",
      isBankAccount: false,
      fsGroupKey: "BS_INVENTORY", // conflicting fsg — configured wins
    }));
    expect(s.postingRole).toBe("BANK");
    expect(s.postingRoleSource).toBe("CONFIGURED");
  });

  it("Boolean-flag isBankAccount=true still wins over fs-group inference (accountRole absent)", () => {
    const s = resolveAccountSemantics(mkAccount({
      accountRole: null,
      isBankAccount: true,
      fsGroupKey: "BS_INVENTORY",
    }));
    expect(s.postingRole).toBe("BANK");
    expect(s.postingRoleSource).toBe("ACCOUNT_ROLE");
  });

  it("Ordinary EXPENSE account remains STANDARD (no fs-group cash-equivalent path)", () => {
    const s = resolveAccountSemantics(mkAccount({
      accountNumber: "6054",
      name: "Computer & IT Services",
      type: "EXPENSE",
      categoryKey: "ADMIN_EXPENSES",
      fsGroupKey: "IS_IT_SOFTWARE",
    }));
    expect(s.postingRole).toBe("STANDARD");
    expect(s.structuralPostingRestrictions).not.toContain("BANK_ACCOUNT");
    expect(s.structuralPostingRestrictions).not.toContain("CASH_ACCOUNT");
  });
});
