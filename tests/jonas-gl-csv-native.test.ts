// Jonas-native trial-balance CSV — regression tests.
//
// Covers the exact shape Jonas exports without any operator
// massaging: 3 preamble rows, embedded-newline column headers,
// currency-string numerics with commas, and credits-as-negative
// values. The parser must:
//
//   • detect Jonas-native vs spectre-normalised inputs,
//   • infer fiscalYear + fiscalPeriod from the period heading,
//   • normalize embedded-newline headers,
//   • compute periodBalance = |debit| − |credit| safely under both
//     sign conventions,
//   • default ytdBalance = periodBalance,
//   • surface the original validation error path when the input is
//     neither Jonas-native nor spectre-normalised.

import { describe, expect, it } from "vitest";

import { parseJonasGlCsv } from "@/lib/reporting/ledger/importers/jonas-gl-csv";

// ---------------------------------------------------------------------------
// Fixture — exactly the shape Jonas exports (preamble + multi-line headers
// + currency-string numerics + negative-credit convention).
// ---------------------------------------------------------------------------

const JONAS_NATIVE_FIXTURE = `Silver Springs Golf & Country Club
"Trial Balance for Apr, 2026"
Closing Period Balances
"G/L Account
Code","G/L Account
Description","Closing Bal
Debit","Closing Bal
Credit"
1010,"Cash - Operating Account","$2,126,855.30","$0.00"
1100,"Accounts Receivable Net","$984,200.00","$0.00"
1850,"Reserve Fund Investment","$5,000,000.00","$0.00"
1910,"Property Plant & Equipment Net","$8,000,000.00","$0.00"
2010,"Accounts Payable","$0.00","-$1,481,969.03"
2510,"Long-Term Debt","$0.00","-$1,200,000.00"
3010,"Members' Equity","$0.00","-$13,500,000.00"
4010,"Membership Dues Revenue","$0.00","-$4,500,000.00"
4020,"F&B Revenue","$0.00","-$1,500,000.00"
5010,"Operating Expenses","$5,000,000.00","$0.00"
Grand Total,"",$0.00,$0.00
`;

// ---------------------------------------------------------------------------
// Jonas-native — happy path
// ---------------------------------------------------------------------------

describe("parseJonasGlCsv — Jonas-native trial-balance shape", () => {
  it("parses a raw Jonas export with 3 preamble rows + embedded-newline headers", () => {
    const result = parseJonasGlCsv(JONAS_NATIVE_FIXTURE);
    expect(result.ok, "Jonas-native CSV parses successfully").toBe(true);
    if (!result.ok) return;

    // 10 account rows; the "Grand Total" footer row is skipped because
    // its account code contains whitespace.
    expect(result.rows).toHaveLength(10);
  });

  it("infers fiscalYear = 2026 and fiscalPeriod = 4 from the period heading", () => {
    const result = parseJonasGlCsv(JONAS_NATIVE_FIXTURE);
    if (!result.ok) throw new Error("expected ok");
    for (const row of result.rows) {
      expect(row.fiscalYear).toBe("2026");
      expect(row.fiscalPeriod).toBe(4);
    }
  });

  it("normalises embedded-newline headers — accountNumber + accountDescription populated", () => {
    const result = parseJonasGlCsv(JONAS_NATIVE_FIXTURE);
    if (!result.ok) throw new Error("expected ok");
    const cash = result.rows.find((r) => r.accountNumber === "1010");
    expect(cash?.accountDescription).toBe("Cash - Operating Account");
  });

  it("computes periodBalance correctly when debit is positive and credit is zero", () => {
    const result = parseJonasGlCsv(JONAS_NATIVE_FIXTURE);
    if (!result.ok) throw new Error("expected ok");
    const cash = result.rows.find((r) => r.accountNumber === "1010")!;
    expect(cash.periodBalance).toBe(2_126_855.30);
  });

  it("computes periodBalance correctly when credit is a NEGATIVE value (Jonas convention)", () => {
    // The critical test from the bug report: debit $0.00 + credit
    // -$1,481,969.03 must produce periodBalance = -1,481,969.03, NOT
    // +1,481,969.03 (which would happen if the parser naïvely did
    // debit − credit on a signed credit value).
    const result = parseJonasGlCsv(JONAS_NATIVE_FIXTURE);
    if (!result.ok) throw new Error("expected ok");
    const ap = result.rows.find((r) => r.accountNumber === "2010")!;
    expect(ap.periodBalance).toBe(-1_481_969.03);
  });

  it("emits ytdBalance as the natural-side magnitude (|periodBalance|) for downstream reconciliation", () => {
    // The user's earlier-slice spec said "Set ytdBalance equal to
    // periodBalance for now if the Jonas Trial Balance does not
    // provide a separate YTD column." The MAGNITUDES are equal —
    // ytdBalance is always |periodBalance| — but the sign on a
    // credit-balance account differs (periodBalance is signed
    // negative; ytdBalance is the natural-side positive magnitude
    // the standard parser + reconciliation expect).
    const result = parseJonasGlCsv(JONAS_NATIVE_FIXTURE);
    if (!result.ok) throw new Error("expected ok");
    for (const row of result.rows) {
      expect(
        row.ytdBalance,
        `ytd = |period| for ${row.accountNumber}`,
      ).toBe(Math.abs(row.periodBalance));
    }
  });

  it("preserves debit + credit splits as POSITIVE magnitudes (sign captured in periodBalance)", () => {
    // The normalised CSV emits Debit and Credit as positive
    // magnitudes so the standard `reconcile()` totals work without
    // sign gymnastics. The signed direction lives on periodBalance:
    //   • debit balance → periodBalance > 0
    //   • credit balance → periodBalance < 0
    const result = parseJonasGlCsv(JONAS_NATIVE_FIXTURE);
    if (!result.ok) throw new Error("expected ok");
    const cash = result.rows.find((r) => r.accountNumber === "1010")!;
    expect(cash.debit).toBe(2_126_855.30);
    expect(cash.credit).toBe(0);
    expect(cash.periodBalance).toBe(2_126_855.30); // debit > 0

    const ap = result.rows.find((r) => r.accountNumber === "2010")!;
    expect(ap.debit).toBe(0);
    expect(ap.credit).toBe(1_481_969.03); // ABS magnitude
    expect(ap.periodBalance).toBe(-1_481_969.03); // signed: credit → negative
  });

  it("surfaces headingMetadata so callers can derive period dates without operator input", () => {
    const result = parseJonasGlCsv(JONAS_NATIVE_FIXTURE);
    if (!result.ok) throw new Error("expected ok");
    expect(result.headingMetadata).not.toBeNull();
    expect(result.headingMetadata!.calendarYear).toBe(2026);
    expect(result.headingMetadata!.calendarMonth).toBe(4);
    expect(result.headingMetadata!.fiscalYear).toBe(2026);
    expect(result.headingMetadata!.fiscalPeriod).toBe(4);
    // periodEndDate = last day of April 2026 at end-of-day UTC.
    expect(result.headingMetadata!.periodEndDate.toISOString()).toBe(
      "2026-04-30T23:59:59.999Z",
    );
  });

  it("skips total/subtotal rows (account codes with whitespace)", () => {
    const result = parseJonasGlCsv(JONAS_NATIVE_FIXTURE);
    if (!result.ok) throw new Error("expected ok");
    // The "Grand Total" footer row at the bottom must NOT appear.
    expect(
      result.rows.find((r) => /grand total/i.test(r.accountNumber)),
    ).toBeUndefined();
    expect(
      result.rows.find((r) => /grand total/i.test(r.accountDescription)),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Backwards compatibility — spectre-normalised inputs still pass
// ---------------------------------------------------------------------------

describe("parseJonasGlCsv — spectre-normalised input still passes", () => {
  it("parses the existing normalized header format without invoking the Jonas-native path", () => {
    const csv = [
      "AccountNumber,AccountDescription,PeriodBalance,YTDBalance,FiscalYear,FiscalPeriod",
      "1010,Cash,180000,2000000,FY2026,5",
      "4010,Dues,900000,4500000,FY2026,5",
    ].join("\n");
    const result = parseJonasGlCsv(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].fiscalYear).toBe("FY2026");
    expect(result.rows[0].fiscalPeriod).toBe(5);
    expect(result.rows[0].ytdBalance).toBe(2_000_000);
    // ytdBalance is the explicit value, NOT periodBalance.
    expect(result.rows[0].ytdBalance).not.toBe(result.rows[0].periodBalance);
  });

  it("headingMetadata is null for spectre-normalised inputs (no inference possible)", () => {
    const csv = [
      "AccountNumber,AccountDescription,PeriodBalance,YTDBalance,FiscalYear,FiscalPeriod",
      "1010,Cash,180000,2000000,FY2026,5",
    ].join("\n");
    const result = parseJonasGlCsv(csv);
    if (!result.ok) throw new Error("expected ok");
    expect(result.headingMetadata).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bad files still produce useful validation errors
// ---------------------------------------------------------------------------

describe("parseJonasGlCsv — bad files still surface useful errors", () => {
  it("missing required columns AND not Jonas-native → missing-column file error", () => {
    const csv = "AccountNumber,AccountDescription\n1010,Cash";
    const result = parseJonasGlCsv(csv);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fileErrors).toHaveLength(1);
    expect(result.fileErrors[0].kind).toBe("missing-column");
    expect(result.fileErrors[0].message).toContain("periodbalance");
  });

  it("Jonas-shaped headers but no period heading → falls through (missing-column)", () => {
    // Headers look Jonas-like but there's NO "Trial Balance for ..."
    // preamble — detector requires both signals before normalising.
    const csv = [
      '"G/L Account\nCode","G/L Account\nDescription","Closing Bal\nDebit","Closing Bal\nCredit"',
      '1010,"Cash","$100","$0"',
    ].join("\n");
    const result = parseJonasGlCsv(csv);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The Jonas-native normalizer didn't trigger (no period heading);
    // standard parser then reports missing required columns.
    expect(result.fileErrors[0].kind).toBe("missing-column");
  });

  it("empty CSV → empty file error", () => {
    const result = parseJonasGlCsv("");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fileErrors[0].kind).toBe("empty");
  });
});
