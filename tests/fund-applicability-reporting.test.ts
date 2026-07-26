// Founder rule 2026-07-02 v15.0 — reporting-engine tests for
// the Fund Applicability refactor.
//
// Locks:
//   • mapIncomeStatementAccount routes CAPITAL-tagged accounts
//     to capital-income / capital-expense (single source of
//     truth is the account's fundApplicability tag, not the
//     account number).
//   • A P&L account with `accountFundApplicability = null`
//     returns the `unmapped-fund` bucket — surfaces as a
//     diagnostic in the projection layer.
//   • Retired range rules: 9xxx accounts no longer land in
//     capital-* by default; they need the CAPITAL flag to be
//     promoted.
//   • bucketToFund returns null for unmapped-fund (never
//     silently classifies as operating or capital).

import { describe, it, expect } from "vitest";

import {
  DEFAULT_INCOME_STATEMENT_MAPPING,
  bucketToCategory,
  bucketToFund,
  mapIncomeStatementAccount,
} from "@/lib/reporting/ledger/projections/income-statement-mapping";

describe("v15.0 mapIncomeStatementAccount — Fund Applicability drives capital classification", () => {
  it("REVENUE + CAPITAL-tagged → capital-income (regardless of account number)", () => {
    const mapped = mapIncomeStatementAccount(
      {
        accountNumber: "4085",           // 4xxx = revenue range
        accountName: "Special Assessment",
        accountCategory: "revenue",
        accountFundApplicability: "CAPITAL",
      },
      DEFAULT_INCOME_STATEMENT_MAPPING,
    );
    expect(mapped).not.toBeNull();
    expect(mapped!.bucket).toBe("capital-income");
  });

  it("EXPENSE + CAPITAL-tagged → capital-expense (regardless of account number)", () => {
    const mapped = mapIncomeStatementAccount(
      {
        accountNumber: "6250",           // 6xxx = expense range
        accountName: "Capital Project Labour",
        accountCategory: "expense",
        accountFundApplicability: "CAPITAL",
      },
      DEFAULT_INCOME_STATEMENT_MAPPING,
    );
    expect(mapped).not.toBeNull();
    expect(mapped!.bucket).toBe("capital-expense");
  });

  it("REVENUE + OPERATING-tagged → keeps operating sub-bucket (revenue / departmental-revenue)", () => {
    const mapped = mapIncomeStatementAccount(
      {
        accountNumber: "4110",           // Golf revenue range
        accountName: "Green Fees",
        accountCategory: "revenue",
        accountFundApplicability: "OPERATING",
      },
      DEFAULT_INCOME_STATEMENT_MAPPING,
    );
    expect(mapped!.bucket).toBe("departmental-revenue");
    expect(mapped!.departmentCode).toBe("GOLF");
  });

  it("9xxx account WITHOUT CAPITAL flag stays in the operating sub-bucket (retired range rule)", () => {
    // Pre-v15.0 the 9000-9499 range dumped everything into
    // capital-income by number. v15.0 requires the account
    // itself to be tagged CAPITAL — otherwise it lands as
    // regular revenue.
    const mapped = mapIncomeStatementAccount(
      {
        accountNumber: "9010",
        accountName: "Uncategorised Revenue",
        accountCategory: "revenue",
        accountFundApplicability: "OPERATING",
      },
      DEFAULT_INCOME_STATEMENT_MAPPING,
    );
    expect(mapped!.bucket).toBe("revenue");
    expect(mapped!.bucket).not.toBe("capital-income");
  });
});

describe("v15.0 mapIncomeStatementAccount — null fundApplicability surfaces the diagnostic", () => {
  it("REVENUE + null fund → unmapped-fund bucket (not silently defaulted to operating)", () => {
    const mapped = mapIncomeStatementAccount(
      {
        accountNumber: "4110",
        accountName: "Missing Fund Config",
        accountCategory: "revenue",
        accountFundApplicability: null,
      },
      DEFAULT_INCOME_STATEMENT_MAPPING,
    );
    expect(mapped).not.toBeNull();
    expect(mapped!.bucket).toBe("unmapped-fund");
  });

  it("EXPENSE + empty-string fund → unmapped-fund bucket", () => {
    const mapped = mapIncomeStatementAccount(
      {
        accountNumber: "6010",
        accountName: "Empty Fund String",
        accountCategory: "expense",
        accountFundApplicability: "",
      },
      DEFAULT_INCOME_STATEMENT_MAPPING,
    );
    expect(mapped!.bucket).toBe("unmapped-fund");
  });

  it("multi-fund (OPERATING,CAPITAL) → primary bucket is CAPITAL-promoted (CAPITAL flag wins)", () => {
    // The founder's semantic: an account carrying BOTH funds
    // contributes to capital reporting. In the initial slice
    // primary-fund = CAPITAL (the capital-first tie-break
    // matches the reporting intent when both flags are set).
    const mapped = mapIncomeStatementAccount(
      {
        accountNumber: "4100",
        accountName: "Multi-Fund Interest",
        accountCategory: "revenue",
        accountFundApplicability: "OPERATING,CAPITAL",
      },
      DEFAULT_INCOME_STATEMENT_MAPPING,
    );
    expect(mapped!.bucket).toBe("capital-income");
  });
});

describe("v15.0 bucketToFund and bucketToCategory handle unmapped-fund safely", () => {
  it("bucketToFund returns null for unmapped-fund (never silently 'operating' or 'capital')", () => {
    expect(bucketToFund("unmapped-fund")).toBeNull();
  });
  it("bucketToCategory uses the caller's fallback for unmapped-fund", () => {
    expect(bucketToCategory("unmapped-fund", "revenue")).toBe("revenue");
    expect(bucketToCategory("unmapped-fund", "expense")).toBe("expense");
  });
  it("existing buckets still round-trip through bucketToFund", () => {
    expect(bucketToFund("capital-income")).toBe("capital");
    expect(bucketToFund("capital-expense")).toBe("capital");
    expect(bucketToFund("revenue")).toBe("operating");
    expect(bucketToFund("departmental-revenue")).toBe("operating");
    expect(bucketToFund("payroll")).toBe("operating");
    expect(bucketToFund("operating-expense")).toBe("operating");
    expect(bucketToFund("depreciation")).toBe("operating");
  });
});
