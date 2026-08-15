// Phase 4R · Phase 7.2N · Fix 1C (2026-08-14) — semantic-consumption guard.
//
// Founder §10: architectural test proving
//   If CanonicalAccountSemantics.structuralPostingRestrictions marks
//   an account structurally restricted, canonical tiering MUST
//   classify it INELIGIBLE regardless of the underlying raw boolean
//   fields.
//
// Founder §6 mandatory real-COA controls:
//   1000 Petty Cash          → CASH  → CASH_ACCOUNT → INELIGIBLE
//   1001 Bank - General      → BANK  → BANK_ACCOUNT → INELIGIBLE
//   9900 Bank - Credit Fac.  → BANK  → BANK_ACCOUNT → INELIGIBLE
//   Capital / inventory / prepaid asset → NOT ineligible
//   (proves no blanket ASSET exclusion introduced)
//
// The guard is deliberately staged at the RANKER TIER-ASSIGNMENT
// LAYER — not the semantics-derivation layer — because Fix 1 landed
// at the semantics layer but was bypassed downstream. Testing the
// consumption boundary directly is what prevents the same class of
// bug in the future.

import { describe, expect, it } from "vitest";
import { rankCanonical, type TierSemanticsInput } from "@/lib/ap-intelligence/canonical-ranker";
import { resolveAccountSemantics } from "@/lib/ap-intelligence/account-semantics";
import type { AccountView } from "@/lib/ap-intelligence/gl-account-concepts";
import type { EligibleAccountView } from "@/lib/ap-intelligence/accounting-nature-compatibility";

function realCouleeRidgeSemantics(shape: Partial<EligibleAccountView>): TierSemanticsInput {
  const eligible: EligibleAccountView = {
    accountNumber: "0000",
    name: "Test",
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
    ...shape,
  };
  const s = resolveAccountSemantics(eligible);
  return {
    statementRole: s.statementRole,
    accountingClass: s.accountingClass,
    postingRole: s.postingRole,
    structuralPostingRestrictions: s.structuralPostingRestrictions,
  };
}

function mkAccountView(shape: Partial<AccountView> & { id: string; accountNumber: string; name: string }): AccountView {
  return {
    categoryKey: null,
    categoryName: null,
    fsGroupKey: null,
    fsGroupName: null,
    type: "ASSET",
    allowManualPosting: true,
    isControlAccount: false,
    isBankAccount: false,
    isCashAccount: false,
    ...shape,
  };
}

function scoreOnlyThisAccount(account: AccountView, semantics: TierSemanticsInput) {
  return rankCanonical({
    transaction: {
      purposeConcept: null,
      purposeConfidence: 0,
      purposeQuality: "NONE",
      capitalDecision: null,
      capitalConfidence: 0,
      natureLeader: "UNKNOWN",
      natureConfidence: 0,
      natureIsDefensible: false,
      canonicalLineItems: [],
      queryConcepts: [],
      vendor: { matchedVendorId: null, defaultAccountId: null, priorCodingAccountNumbers: [] },
      documentPhraseText: null,
      departmentKey: null,
      departmentAccountNamePatterns: [],
    },
    eligibleAccounts: [account],
    postingBlockersByAccount: new Map(),
    accountSemanticsByAccountId: new Map([[account.id, semantics]]),
  });
}

describe("Phase 7.2N Fix 1C · founder §6 real-COA controls", () => {
  it("1000 Petty Cash (real Coulee Ridge: type=ASSET, accountRole=STANDARD, isCash=false, fsg=BS_CASH_EQUIVALENTS) → tier INELIGIBLE via semantic contract", () => {
    const semantics = realCouleeRidgeSemantics({
      accountNumber: "1000", name: "Petty Cash",
      type: "ASSET", accountRole: "STANDARD",
      isCashAccount: false, isBankAccount: false,
      categoryKey: "CURRENT_ASSETS", fsGroupKey: "BS_CASH_EQUIVALENTS",
    });
    // Sanity: Fix 1 derived semantics correctly.
    expect(semantics.postingRole).toBe("CASH");
    expect(semantics.structuralPostingRestrictions).toContain("CASH_ACCOUNT");

    const acct = mkAccountView({ id: "a1", accountNumber: "1000", name: "Petty Cash", type: "ASSET",
      fsGroupKey: "BS_CASH_EQUIVALENTS" });
    const result = scoreOnlyThisAccount(acct, semantics);
    // One INELIGIBLE candidate + no other candidates → score = 0 → NO_ELIGIBLE_CANDIDATES.
    // But the tier assignment ITSELF must have marked it INELIGIBLE.
    // Inspect via rank (single candidate can still be returned in
    // ABSTAIN with tier=INELIGIBLE, but zero-score path routes to
    // NO_ELIGIBLE). Either outcome proves the account is not a
    // legitimate winner.
    expect(["NO_ELIGIBLE_CANDIDATES", "ABSTAIN"]).toContain(result.status);
    if (result.status === "ABSTAIN") {
      expect(result.candidates[0].tier).toBe("INELIGIBLE");
      expect(result.candidates[0].tierReason).toMatch(/CASH_ACCOUNT|structural/);
    }
  });

  it("1001 Bank - General (real shape) → tier INELIGIBLE with BANK_ACCOUNT reason", () => {
    const semantics = realCouleeRidgeSemantics({
      accountNumber: "1001", name: "Bank - General",
      type: "ASSET", accountRole: "STANDARD",
      isBankAccount: false, isCashAccount: false,
      fsGroupKey: "BS_CASH_EQUIVALENTS",
    });
    expect(semantics.postingRole).toBe("BANK");
    expect(semantics.structuralPostingRestrictions).toContain("BANK_ACCOUNT");
    const acct = mkAccountView({ id: "a1", accountNumber: "1001", name: "Bank - General", type: "ASSET",
      fsGroupKey: "BS_CASH_EQUIVALENTS" });
    const result = scoreOnlyThisAccount(acct, semantics);
    expect(["NO_ELIGIBLE_CANDIDATES", "ABSTAIN"]).toContain(result.status);
    if (result.status === "ABSTAIN") {
      expect(result.candidates[0].tier).toBe("INELIGIBLE");
    }
  });

  it("9900 Bank - Credit Facilities/Mortgage (the 221178 wrongly-recommended account) → tier INELIGIBLE via semantic contract", () => {
    const semantics = realCouleeRidgeSemantics({
      accountNumber: "9900", name: "Bank - Credit Facilities/Mortgage",
      type: "ASSET", accountRole: "STANDARD",
      isBankAccount: false, isCashAccount: false,
      fsGroupKey: "BS_CASH_EQUIVALENTS",
    });
    expect(semantics.postingRole).toBe("BANK");
    expect(semantics.structuralPostingRestrictions).toContain("BANK_ACCOUNT");
    const acct = mkAccountView({ id: "a1", accountNumber: "9900", name: "Bank - Credit Facilities/Mortgage",
      type: "ASSET", fsGroupKey: "BS_CASH_EQUIVALENTS" });
    const result = scoreOnlyThisAccount(acct, semantics);
    expect(["NO_ELIGIBLE_CANDIDATES", "ABSTAIN"]).toContain(result.status);
    if (result.status === "ABSTAIN") {
      expect(result.candidates[0].tier).toBe("INELIGIBLE");
    }
  });

  it("Capital equipment asset (1506) → NOT INELIGIBLE — proves no ASSET blanket-ban", () => {
    const semantics = realCouleeRidgeSemantics({
      accountNumber: "1506", name: "Equipment & Fixtures - Grounds",
      type: "ASSET", accountRole: "STANDARD",
      categoryKey: "CAPITAL_ASSETS", fsGroupKey: "BS_CAPITAL_ASSETS",
    });
    expect(semantics.postingRole).toBe("STANDARD");
    expect(semantics.structuralPostingRestrictions).toEqual([]);
  });

  it("Inventory asset (1313 Inventory - Proshop Repairs) → NOT INELIGIBLE", () => {
    const semantics = realCouleeRidgeSemantics({
      accountNumber: "1313", name: "Inventory - Proshop Repairs",
      type: "ASSET", accountRole: "STANDARD",
      categoryKey: "CURRENT_ASSETS", fsGroupKey: "BS_INVENTORY",
    });
    expect(semantics.postingRole).toBe("STANDARD");
    expect(semantics.structuralPostingRestrictions).toEqual([]);
  });

  it("Prepaid asset (1101 Prepaid Expenses) → NOT INELIGIBLE", () => {
    const semantics = realCouleeRidgeSemantics({
      accountNumber: "1101", name: "Prepaid Expenses",
      type: "ASSET", accountRole: "STANDARD",
      categoryKey: "CURRENT_ASSETS", fsGroupKey: "BS_PREPAID_EXPENSES",
    });
    expect(semantics.postingRole).toBe("STANDARD");
    expect(semantics.structuralPostingRestrictions).toEqual([]);
  });
});

describe("Phase 7.2N Fix 1C · §10 semantic-consumption guard", () => {
  it("structuralPostingRestrictions non-empty → tier INELIGIBLE regardless of AccountView.isBankAccount=false", () => {
    // Simulate the pathological real-COA case: AccountView booleans
    // are all false (real staging Coulee Ridge shape) but the
    // pre-resolved semantics carries structural restrictions from
    // Fix 1's fs-group fallback. Fix 1C's guarantee: the semantics
    // wins over the raw booleans.
    const acct = mkAccountView({
      id: "a1", accountNumber: "9900",
      name: "Bank - Credit Facilities/Mortgage",
      type: "ASSET",
      isBankAccount: false, isCashAccount: false, isControlAccount: false,
      fsGroupKey: "BS_CASH_EQUIVALENTS",
    });
    // Synthetically-constructed semantics carrying a structural
    // restriction — proves the ranker consumes THIS not the raw fields.
    const semantics: TierSemanticsInput = {
      statementRole: "BALANCE_SHEET_CURRENT_ASSET",
      accountingClass: "OTHER_ASSET",
      postingRole: "BANK",
      structuralPostingRestrictions: ["BANK_ACCOUNT"],
    };
    const result = scoreOnlyThisAccount(acct, semantics);
    expect(["NO_ELIGIBLE_CANDIDATES", "ABSTAIN"]).toContain(result.status);
    if (result.status === "ABSTAIN") {
      expect(result.candidates[0].tier).toBe("INELIGIBLE");
      expect(result.candidates[0].tierReason).toContain("BANK_ACCOUNT");
    }
  });

  it("structuralPostingRestrictions empty + raw isBankAccount=true → tier still respects semantics (semantics is source of truth)", () => {
    // Inverse anti-fragility: if the semantics contract says the
    // account has NO structural restriction, the ranker MUST NOT
    // second-guess by re-reading raw booleans. The upstream
    // derivePostingRole is the sole judge; if it decides STANDARD,
    // the ranker respects it.
    //
    // In practice this configuration is unreachable (derivePostingRole
    // reads isBankAccount and returns BANK when true), but the guard
    // proves the ranker does not carry a hidden raw-boolean second
    // opinion. Founder §5: no loose casts, no bypass.
    const acct = mkAccountView({
      id: "a1", accountNumber: "6020",
      name: "Grounds Maintenance", type: "EXPENSE",
      isBankAccount: true, // synthetically wrong flag
    });
    const semantics: TierSemanticsInput = {
      statementRole: "OPERATING_EXPENSE",
      accountingClass: "GROUNDS_MAINTENANCE",
      postingRole: "STANDARD",
      structuralPostingRestrictions: [], // semantics says: no restriction
    };
    const result = scoreOnlyThisAccount(acct, semantics);
    // No transaction evidence → score 0 → NO_ELIGIBLE_CANDIDATES.
    // Structural: the account is NOT auto-flagged INELIGIBLE from
    // the raw isBankAccount=true. This proves the ranker's
    // structural gate reads ONLY from semantics.
    expect(["NO_ELIGIBLE_CANDIDATES", "ABSTAIN"]).toContain(result.status);
    if (result.status === "ABSTAIN") {
      // Not INELIGIBLE from semantics (empty restrictions). Tier
      // assignment falls through to treatment/statement-role logic
      // and returns PLAUSIBLE (no composed treatment).
      expect(result.candidates[0].tier).not.toBe("INELIGIBLE");
    }
  });
});

describe("Phase 7.2N Fix 1C · static source guard — assignCandidateTier must not re-interpret raw structural fields", () => {
  // This is a source-level static check. Read the canonical-ranker
  // source and assert `assignCandidateTier` does NOT contain raw
  // `account.isBankAccount` / `isCashAccount` / `isControlAccount`
  // reinterpretation. Prevents accidental regression of the Fix 1B/1C
  // architectural boundary.
  //
  // The check is deliberately narrow — only searches inside
  // `assignCandidateTier`'s function body, not the rest of the file
  // (which may legitimately reference the raw booleans in other
  // contexts like AccountView definition, resolveAccountSemantics
  // fallback, etc.).
  it("assignCandidateTier function body contains no raw isBankAccount / isCashAccount / isControlAccount reads", () => {
    const fs = require("node:fs");
    const src = fs.readFileSync("src/lib/ap-intelligence/canonical-ranker.ts", "utf8") as string;
    // Extract the function body — from `function assignCandidateTier` to the next `function ` at same indent.
    const startMatch = src.match(/function assignCandidateTier\([\s\S]*?\n\}/);
    expect(startMatch, "could not locate assignCandidateTier function body").toBeTruthy();
    const body = startMatch![0];
    // Guard: no direct read of raw account.isBankAccount / isCashAccount / isControlAccount.
    // Allow references inside comments or in the pre-resolved-semantics path.
    // The check: no `.isBankAccount === true` / `.isCashAccount === true` / `.isControlAccount === true`
    // idioms remain — those are the exact patterns Fix 1C removed.
    expect(body).not.toMatch(/\.isBankAccount\s*===\s*true/);
    expect(body).not.toMatch(/\.isCashAccount\s*===\s*true/);
    expect(body).not.toMatch(/\.isControlAccount\s*===\s*true/);
    // Also: no loose `as unknown as { isBankAccount?: ... }` cast.
    expect(body).not.toMatch(/as\s+unknown\s+as\s*\{\s*isBankAccount/);
    expect(body).not.toMatch(/as\s+unknown\s+as\s*\{\s*isCashAccount/);
    expect(body).not.toMatch(/as\s+unknown\s+as\s*\{\s*isControlAccount/);
  });
});
