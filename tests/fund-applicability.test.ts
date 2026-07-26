// Founder rule 2026-07-02 v15.0 — Fund Applicability
// constants module unit tests.
//
// These tests are pure functions (no DB) — the behavioural
// end-to-end tests live alongside their surface: the service in
// coa-*.test.ts, the mapper in reporting-*.test.ts, and the
// predictor in coa-auto-mapping-engine.test.ts.

import { describe, it, expect } from "vitest";
import {
  KNOWN_FUND_KEYS,
  isFundKey,
  parseFundApplicability,
  serializeFundApplicability,
  hasFund,
  assertFundApplicability,
  defaultFundApplicabilityForAccount,
  defaultFundApplicabilityStringForAccount,
  isCapitalAccount,
  isOperatingAccount,
  FS_GROUP_DEFAULT_FUND,
} from "@/lib/accounting/fund-applicability";

describe("KNOWN_FUND_KEYS is the extensibility surface", () => {
  it("starts with OPERATING + CAPITAL in canonical order", () => {
    expect(KNOWN_FUND_KEYS).toEqual(["OPERATING", "CAPITAL"]);
  });
  it("isFundKey is a type guard against the canonical list", () => {
    expect(isFundKey("OPERATING")).toBe(true);
    expect(isFundKey("CAPITAL")).toBe(true);
    expect(isFundKey("RESTRICTED")).toBe(false);
    expect(isFundKey("")).toBe(false);
    expect(isFundKey("operating")).toBe(false); // canonical is uppercase
  });
});

describe("parseFundApplicability: canonical, deduplicated, order-independent", () => {
  it("null / empty / undefined → []", () => {
    expect(parseFundApplicability(null)).toEqual([]);
    expect(parseFundApplicability(undefined)).toEqual([]);
    expect(parseFundApplicability("")).toEqual([]);
    expect(parseFundApplicability("   ")).toEqual([]);
  });
  it("single token", () => {
    expect(parseFundApplicability("OPERATING")).toEqual(["OPERATING"]);
    expect(parseFundApplicability("CAPITAL")).toEqual(["CAPITAL"]);
  });
  it("multi-fund normalises to canonical order (OPERATING before CAPITAL)", () => {
    expect(parseFundApplicability("CAPITAL,OPERATING")).toEqual(["OPERATING", "CAPITAL"]);
    expect(parseFundApplicability("OPERATING,CAPITAL")).toEqual(["OPERATING", "CAPITAL"]);
  });
  it("deduplicates + strips whitespace", () => {
    expect(parseFundApplicability("OPERATING, OPERATING ,CAPITAL")).toEqual(["OPERATING", "CAPITAL"]);
  });
  it("case-insensitive input; uppercases on parse", () => {
    expect(parseFundApplicability("operating,capital")).toEqual(["OPERATING", "CAPITAL"]);
  });
  it("drops unknown tokens (never throws) so a rollback partial-deploy can't crash reporting", () => {
    expect(parseFundApplicability("OPERATING,RESTRICTED")).toEqual(["OPERATING"]);
    expect(parseFundApplicability("MYSTERY_FUND")).toEqual([]);
  });
});

describe("serializeFundApplicability: canonical CSV, empty → null", () => {
  it("empty → null", () => {
    expect(serializeFundApplicability([])).toBeNull();
  });
  it("single fund", () => {
    expect(serializeFundApplicability(["OPERATING"])).toBe("OPERATING");
  });
  it("multi-fund emits canonical order regardless of input order", () => {
    expect(serializeFundApplicability(["CAPITAL", "OPERATING"])).toBe("OPERATING,CAPITAL");
    expect(serializeFundApplicability(["OPERATING", "CAPITAL"])).toBe("OPERATING,CAPITAL");
  });
  it("deduplicates before emit", () => {
    expect(serializeFundApplicability(["OPERATING", "OPERATING"])).toBe("OPERATING");
  });
});

describe("hasFund: null-safe membership check", () => {
  it("null → false for every fund", () => {
    expect(hasFund(null, "OPERATING")).toBe(false);
    expect(hasFund(null, "CAPITAL")).toBe(false);
    expect(hasFund("", "OPERATING")).toBe(false);
  });
  it("single-fund matches only its own key", () => {
    expect(hasFund("OPERATING", "OPERATING")).toBe(true);
    expect(hasFund("OPERATING", "CAPITAL")).toBe(false);
    expect(hasFund("CAPITAL", "CAPITAL")).toBe(true);
    expect(hasFund("CAPITAL", "OPERATING")).toBe(false);
  });
  it("multi-fund matches every fund it carries", () => {
    expect(hasFund("OPERATING,CAPITAL", "OPERATING")).toBe(true);
    expect(hasFund("OPERATING,CAPITAL", "CAPITAL")).toBe(true);
  });
  it("unknown tokens don't leak — invalid CSVs return false", () => {
    expect(hasFund("MYSTERY_FUND", "OPERATING")).toBe(false);
  });
});

describe("isCapitalAccount / isOperatingAccount aliases", () => {
  it("isCapitalAccount checks CAPITAL", () => {
    expect(isCapitalAccount("CAPITAL")).toBe(true);
    expect(isCapitalAccount("OPERATING,CAPITAL")).toBe(true);
    expect(isCapitalAccount("OPERATING")).toBe(false);
    expect(isCapitalAccount(null)).toBe(false);
  });
  it("isOperatingAccount checks OPERATING", () => {
    expect(isOperatingAccount("OPERATING")).toBe(true);
    expect(isOperatingAccount("OPERATING,CAPITAL")).toBe(true);
    expect(isOperatingAccount("CAPITAL")).toBe(false);
    expect(isOperatingAccount(null)).toBe(false);
  });
});

describe("assertFundApplicability: validation for Zod refinements", () => {
  it("accepts null / undefined / empty string", () => {
    expect(() => assertFundApplicability(null)).not.toThrow();
    expect(() => assertFundApplicability(undefined)).not.toThrow();
    expect(() => assertFundApplicability("")).not.toThrow();
  });
  it("accepts every known fund key + combinations", () => {
    for (const k of KNOWN_FUND_KEYS) {
      expect(() => assertFundApplicability(k)).not.toThrow();
    }
    expect(() => assertFundApplicability("OPERATING,CAPITAL")).not.toThrow();
  });
  it("throws on unknown tokens (Zod surfaces the message to the operator)", () => {
    expect(() => assertFundApplicability("MYSTERY_FUND"))
      .toThrow(/Unknown fund key/);
    expect(() => assertFundApplicability("OPERATING,MYSTERY_FUND"))
      .toThrow(/Unknown fund key/);
  });
});

describe("defaultFundApplicabilityForAccount: FS Group is the derivation source (never account name)", () => {
  it("non-P&L account types return [] regardless of fs-group", () => {
    expect(defaultFundApplicabilityForAccount("ASSET", "BS_CASH_EQUIVALENTS")).toEqual([]);
    expect(defaultFundApplicabilityForAccount("LIABILITY", "BS_AP")).toEqual([]);
    expect(defaultFundApplicabilityForAccount("EQUITY", "BS_RETAINED_EARNINGS")).toEqual([]);
  });
  it("P&L account with capital fs-group defaults to CAPITAL", () => {
    expect(defaultFundApplicabilityForAccount("REVENUE", "IS_CAPITAL_ASSESSMENTS"))
      .toEqual(["CAPITAL"]);
  });
  it("P&L account with operating fs-group defaults to OPERATING", () => {
    expect(defaultFundApplicabilityForAccount("REVENUE", "IS_MEMBERSHIP_DUES"))
      .toEqual(["OPERATING"]);
    expect(defaultFundApplicabilityForAccount("EXPENSE", "IS_PAYROLL"))
      .toEqual(["OPERATING"]);
    expect(defaultFundApplicabilityForAccount("EXPENSE", "IS_UTILITIES"))
      .toEqual(["OPERATING"]);
  });
  it("P&L account with no fs-group defaults to OPERATING (safe fallback for legacy data)", () => {
    expect(defaultFundApplicabilityForAccount("REVENUE", null)).toEqual(["OPERATING"]);
    expect(defaultFundApplicabilityForAccount("EXPENSE", "")).toEqual(["OPERATING"]);
  });
});

describe("defaultFundApplicabilityStringForAccount: serialised form for direct DB write", () => {
  it("Capital revenue → 'CAPITAL'", () => {
    expect(defaultFundApplicabilityStringForAccount("REVENUE", "IS_CAPITAL_ASSESSMENTS")).toBe("CAPITAL");
  });
  it("Operating revenue → 'OPERATING'", () => {
    expect(defaultFundApplicabilityStringForAccount("REVENUE", "IS_MEMBERSHIP_DUES")).toBe("OPERATING");
  });
  it("Operating expense → 'OPERATING'", () => {
    expect(defaultFundApplicabilityStringForAccount("EXPENSE", "IS_PAYROLL")).toBe("OPERATING");
  });
  it("Non-P&L → null (no fund tag stored for balance-sheet accounts)", () => {
    expect(defaultFundApplicabilityStringForAccount("ASSET", "BS_CASH_EQUIVALENTS")).toBeNull();
  });
});

describe("FS_GROUP_DEFAULT_FUND is the extensibility hook (single edit adds future capital FS groups)", () => {
  it("only IS_CAPITAL_ASSESSMENTS is in the initial capital list", () => {
    // The initial slice explicitly ships with just one capital FS
    // group. When the founder introduces IS_CAPITAL_INVESTMENT_INCOME
    // or similar, adding it here backfills every default in one
    // edit.
    expect(FS_GROUP_DEFAULT_FUND.IS_CAPITAL_ASSESSMENTS).toEqual(["CAPITAL"]);
    expect(FS_GROUP_DEFAULT_FUND.IS_MEMBERSHIP_DUES).toBeUndefined();
  });
});
