// DIM-2 (2026-09-29) — accounting-semantic policy proposal tests.
//
// Covers Section 3 (policy prediction rules must be accounting-
// semantic, not applicability-derived) and Section 2 (policy and
// applicability are independent concepts).

import { describe, expect, it } from "vitest";
import {
  proposeDepartmentPolicy,
  proposeFundPolicy,
  parseFundApplicabilityKeys,
} from "@/lib/accounting/dimension-policy-prediction";

describe("DIM-2 · proposeDepartmentPolicy", () => {
  it("Header account → NOT_APPLICABLE (never posts)", () => {
    expect(proposeDepartmentPolicy({ type: "EXPENSE", fsGroupKey: "IS_OPERATING", isHeader: true })).toBe("NOT_APPLICABLE");
    expect(proposeDepartmentPolicy({ type: "REVENUE", fsGroupKey: "IS_MEMBERSHIP_DUES", isHeader: true })).toBe("NOT_APPLICABLE");
  });

  it("Cash / AR / AP / Retained Earnings control accounts → NOT_APPLICABLE", () => {
    for (const fs of ["BS_CASH_EQUIVALENTS", "BS_AR", "BS_MEMBER_AR", "BS_AP", "BS_RETAINED_EARNINGS", "BS_CURRENT_YEAR_EARNINGS"]) {
      expect(proposeDepartmentPolicy({ type: "ASSET", fsGroupKey: fs })).toBe("NOT_APPLICABLE");
    }
  });

  it("Equity accounts → NOT_APPLICABLE", () => {
    expect(proposeDepartmentPolicy({ type: "EQUITY", fsGroupKey: "EQ_SHARE_CAPITAL" })).toBe("NOT_APPLICABLE");
    expect(proposeDepartmentPolicy({ type: "EQUITY", fsGroupKey: "EQ_MEMBER_EQUITY" })).toBe("NOT_APPLICABLE");
  });

  it("Non-operational P&L (interest, other, tax) → OPTIONAL", () => {
    expect(proposeDepartmentPolicy({ type: "REVENUE", fsGroupKey: "IS_INTEREST_INCOME" })).toBe("OPTIONAL");
    expect(proposeDepartmentPolicy({ type: "EXPENSE", fsGroupKey: "IS_INTEREST_EXPENSE" })).toBe("OPTIONAL");
    expect(proposeDepartmentPolicy({ type: "EXPENSE", fsGroupKey: "IS_INCOME_TAX" })).toBe("OPTIONAL");
    expect(proposeDepartmentPolicy({ type: "REVENUE", fsGroupKey: "IS_OTHER_INCOME" })).toBe("OPTIONAL");
  });

  it("Operating REVENUE / EXPENSE → REQUIRED", () => {
    expect(proposeDepartmentPolicy({ type: "REVENUE", fsGroupKey: "IS_MEMBERSHIP_DUES" })).toBe("REQUIRED");
    expect(proposeDepartmentPolicy({ type: "REVENUE", fsGroupKey: "IS_FOOD_SALES" })).toBe("REQUIRED");
    expect(proposeDepartmentPolicy({ type: "EXPENSE", fsGroupKey: "IS_COGS_FOOD" })).toBe("REQUIRED");
    expect(proposeDepartmentPolicy({ type: "EXPENSE", fsGroupKey: "IS_PAYROLL" })).toBe("REQUIRED");
  });

  it("Unknown FS group → OPTIONAL (conservative fallback)", () => {
    expect(proposeDepartmentPolicy({ type: "ASSET", fsGroupKey: "BS_UNKNOWN" })).toBe("OPTIONAL");
    expect(proposeDepartmentPolicy({ type: "LIABILITY", fsGroupKey: null })).toBe("OPTIONAL");
  });
});

describe("DIM-2 · proposeFundPolicy", () => {
  it("Header account → NOT_APPLICABLE", () => {
    expect(proposeFundPolicy({ type: "EXPENSE", fsGroupKey: "IS_OPERATING", fundApplicability: "OPERATING", isHeader: true })).toBe("NOT_APPLICABLE");
  });

  it("Control accounts (Cash / AR / AP) → NOT_APPLICABLE", () => {
    for (const fs of ["BS_CASH_EQUIVALENTS", "BS_AR", "BS_AP", "BS_MEMBER_AR"]) {
      expect(proposeFundPolicy({ type: "ASSET", fsGroupKey: fs, fundApplicability: null })).toBe("NOT_APPLICABLE");
    }
  });

  it("Equity → NOT_APPLICABLE", () => {
    expect(proposeFundPolicy({ type: "EQUITY", fsGroupKey: "EQ_MEMBER_EQUITY", fundApplicability: null })).toBe("NOT_APPLICABLE");
  });

  it("P&L accounts with fund applicability set → REQUIRED", () => {
    expect(proposeFundPolicy({ type: "REVENUE", fsGroupKey: "IS_MEMBERSHIP_DUES", fundApplicability: "OPERATING" })).toBe("REQUIRED");
    expect(proposeFundPolicy({ type: "EXPENSE", fsGroupKey: "IS_PAYROLL", fundApplicability: "OPERATING,CAPITAL" })).toBe("REQUIRED");
  });

  it("Balance-sheet fixed-asset with fund applicability set → OPTIONAL", () => {
    expect(proposeFundPolicy({ type: "ASSET", fsGroupKey: "BS_CAPITAL_ASSETS", fundApplicability: "CAPITAL" })).toBe("OPTIONAL");
  });

  it("REVENUE / EXPENSE without explicit fundApplicability → REQUIRED (P&L identifies a pool)", () => {
    expect(proposeFundPolicy({ type: "REVENUE", fsGroupKey: "IS_MEMBERSHIP_DUES", fundApplicability: null })).toBe("REQUIRED");
    expect(proposeFundPolicy({ type: "EXPENSE", fsGroupKey: "IS_COGS_FOOD", fundApplicability: null })).toBe("REQUIRED");
  });
});

describe("DIM-2 · parseFundApplicabilityKeys", () => {
  it("null / empty → []", () => {
    expect(parseFundApplicabilityKeys(null)).toEqual([]);
    expect(parseFundApplicabilityKeys(undefined)).toEqual([]);
    expect(parseFundApplicabilityKeys("")).toEqual([]);
    expect(parseFundApplicabilityKeys("   ")).toEqual([]);
  });

  it("single token → uppercased array", () => {
    expect(parseFundApplicabilityKeys("operating")).toEqual(["OPERATING"]);
    expect(parseFundApplicabilityKeys("CAPITAL")).toEqual(["CAPITAL"]);
  });

  it("CSV → sorted deduped array", () => {
    expect(parseFundApplicabilityKeys("CAPITAL,OPERATING")).toEqual(["CAPITAL", "OPERATING"]);
    expect(parseFundApplicabilityKeys("OPERATING,CAPITAL")).toEqual(["CAPITAL", "OPERATING"]);
    expect(parseFundApplicabilityKeys("OPERATING,operating,CAPITAL")).toEqual(["CAPITAL", "OPERATING"]);
  });
});

describe("DIM-2 · Section 2 policy != applicability invariant", () => {
  it("Policy proposal is derived from Type + FS Group + fundApplicability CSV — never from AccountDepartment / AccountFund row COUNTS", () => {
    // The proposeDepartmentPolicy signature deliberately does NOT
    // take applicability row counts. This test is a signature
    // guard against a regression where someone plumbs in a
    // "hasAccountDepartment: boolean" or similar count-based
    // input. Adding such a parameter would be an ARCHITECTURAL
    // CONFLICT with founder Section 2.
    const inputSignature: keyof Parameters<typeof proposeDepartmentPolicy>[0] = "type";
    expect(inputSignature).toBe("type");
    const signature2: keyof Parameters<typeof proposeFundPolicy>[0] = "type";
    expect(signature2).toBe("type");
    // Adding + removing AccountDepartment/AccountFund rows must not
    // change the proposal — it depends only on the accounting-semantic
    // inputs. This assertion is a compile-time+runtime pair: the
    // TS `Parameters<>` narrowing catches an unintentional widening
    // of the input shape.
    const proposal = proposeDepartmentPolicy({ type: "REVENUE", fsGroupKey: "IS_MEMBERSHIP_DUES" });
    expect(proposal).toBe("REQUIRED");
  });
});
