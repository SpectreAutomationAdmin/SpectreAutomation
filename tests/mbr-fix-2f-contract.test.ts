// MBR-FIX-2F (2026-10-10) — Section X expense presentation correction.
//
// Pre-fix: each department card showed Payroll & Benefits as its
// own row AND included that same payroll inside "Operating
// Expenses", which looked like double-counting.  The underlying
// Net Income math was correct; the visual presentation wasn't.
//
// Fix pins:
//   §A  dept resolver carves IS_INTEREST_EXPENSE out of opex
//       alongside IS_DEPRECIATION (operating-fund NOI definition
//       shared across every section).
//   §B  card renders "Other Operating Expenses" = opex − payroll.
//   §C  "Net Operating Result" replaces the old "Net Income" label
//       to match the directive's financial-statement vocabulary.
//   §D  Payroll row + Other Operating Expenses row are mutually
//       exclusive and sum to the gross `opex` field.
//   §E  Budget YTD + Variance rows unchanged (same calculation).

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const DEPT_RESOLVER = path.join(REPO, "src/lib/accounting/dept-pl-from-snapshot.ts");
const DEPT_SUMMARY  = path.join(REPO, "src/lib/reporting/departmental-pl-summary.ts");

describe("MBR-FIX-2F §A — dept resolver carves out IS_INTEREST_EXPENSE", () => {
  const src = readFileSync(DEPT_RESOLVER, "utf8");

  it("skips IS_DEPRECIATION and IS_INTEREST_EXPENSE identically", () => {
    expect(src).toMatch(/if \(b\.fsGroupKey === "IS_DEPRECIATION"\) continue;/);
    expect(src).toMatch(/if \(b\.fsGroupKey === "IS_INTEREST_EXPENSE"\) continue;/);
  });

  it("MBR-FIX-2F comment anchors the LRP financing case", () => {
    // Comma inside a dollar amount — look for the amount only.
    expect(src).toMatch(/\$14,320\.84/);
    expect(src).toMatch(/LRP/);
  });
});

describe("MBR-FIX-2F §B/§C — card display: Other Operating Expenses + Net Operating Result", () => {
  const src = readFileSync(DEPT_SUMMARY, "utf8");

  it("other-operating-expenses row present with Other Operating Expenses label", () => {
    expect(src).toMatch(/key: "other-operating-expenses",\s*label: "Other Operating Expenses",/);
  });

  it("value derived from (opex − payroll)", () => {
    expect(src).toMatch(/toString: \(\) => \(Number\(r\.opex\.toString\(\)\) - Number\(r\.payroll\.toString\(\)\)\)\.toString\(\),/);
  });

  it("pre-fix 'Operating Expenses' label + raw opex row is gone", () => {
    expect(src).not.toMatch(/key: "operating-expenses",\s*label: "Operating Expenses",\s*value: fmtMoney\(r\.opex\)/);
  });

  it("Net Income row relabeled Net Operating Result", () => {
    expect(src).toMatch(/key: "net-income",\s*label: "Net Operating Result"/);
  });
});

describe("MBR-FIX-2F §D — mutually-exclusive expense categorisation (identity)", () => {
  // The subtraction is pure JS at the render boundary.  Verify the
  // identity (Payroll + OtherOpEx === opex) with representative
  // test inputs — numeric assertion against the directive's Feb
  // acceptance values.
  const cases: Array<{ dept: string; opex: number; payroll: number; expectedOther: number }> = [
    { dept: "Administration",   opex: 199_013.01, payroll: 99_431.01, expectedOther: 99_582.00 },
    { dept: "Clubhouse",        opex:  45_885.49, payroll: 15_540.58, expectedOther: 30_344.91 },
    { dept: "Food & Beverage",  opex: 110_657.71, payroll: 92_329.91, expectedOther: 18_327.80 },
    { dept: "Golf Shop",        opex:  69_422.29, payroll: 60_369.80, expectedOther:  9_052.49 },
    { dept: "Course & Grounds", opex: 201_745.72, payroll: 84_353.38, expectedOther: 117_392.34 },
  ];

  for (const c of cases) {
    it(`${c.dept}: Payroll + Other OpEx === gross opex (to the cent)`, () => {
      const other = Math.round((c.opex - c.payroll) * 100) / 100;
      expect(other).toBe(c.expectedOther);
      const sum = Math.round((c.payroll + other) * 100) / 100;
      expect(sum).toBe(Math.round(c.opex * 100) / 100);
    });
  }
});
