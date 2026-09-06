// Payroll-3C-3D.7 (2026-09-09) — CRA PDOC Option 1 reference suite.
//
// PURPOSE: prove Spectre's underlying tax calculators reproduce the
// CRA Payroll Deductions Online Calculator (PDOC) Option 1 baseline
// values when invoked WITHOUT the projected YTD credit basis.
//
// Production (`calculatePayrollBatch`) uses the CRA projected YTD
// CPP/EI tax-credit method as its STANDARD (per Payroll-3C-3D.7
// founder decision). CRA states the T4127 formulas generally produce
// more precise results than PDOC, so production output intentionally
// differs from PDOC. These tests document the Option 1 baseline that
// PDOC publishes and prove Spectre's calculators still reproduce it
// via the legacy pathway.
//
// SOURCE OF TRUTH: T4127 122nd Edition (H1, Jan 1 2026) + 123rd
// Edition (H2, Jul 1 2026); PDOC published expected values for the
// four scenarios documented in `calculation-execute.test.ts` (now
// `describe.skip` there — this file is their new home).

import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { calculateFederalTax } from "@/lib/payroll/statutory/federal-tax-calculator";
import { calculateAlbertaTax } from "@/lib/payroll/statutory/alberta-tax-calculator";
import { CA_AB_2026_PARAMS_H2 } from "@/lib/payroll/statutory/seed-ca-ab-2026";

const fedParams  = CA_AB_2026_PARAMS_H2.federal;
const provParams = CA_AB_2026_PARAMS_H2.provincial!;

// PDOC Scenario 1 statutory intermediate values:
//   biweekly gross I = $2,000
//   base CPP    = $92.34
//   first-add   = $18.65
//   combined    = $110.99
//   CPP2        = 0
//   EI          = $32.60
//   TD1 fed     = $16,452  (2026 BPA max)
//   TD1AB       = $22,769
const S1 = {
  I:            "2000",
  cppBase:      "92.34",
  cppFirstAdd:  "18.65",
  cpp2:         "0",
  ei:           "32.60",
  fedTd1:       "16452",
  abTd1:        "22769",
  P:            26,   // biweekly
} as const;

describe("CRA PDOC Option 1 reference · Scenario 1 (default TD1)", () => {
  it("Federal $163.23 · Alberta $78.45 (Option 1, no YTD credit basis)", () => {
    const F5A = new Decimal(S1.cppFirstAdd).plus(S1.cpp2).toFixed(2);
    const fed = calculateFederalTax({
      periodicTaxableRemuneration: S1.I,
      f5aThisPay: F5A,
      baseCppThisPay: S1.cppBase,
      eiThisPay: S1.ei,
      periodsPerYear: S1.P,
      federalClaim: S1.fedTd1,
      claimZeroFederal: false,
      totalIncomeLessThanClaim: false,
      federal: fedParams,
      // ytdCreditBasis absent → Option 1 K2 (annualisation) used.
    });
    const ab = calculateAlbertaTax({
      periodicTaxableRemuneration: S1.I,
      f5aThisPay: F5A,
      baseCppThisPay: S1.cppBase,
      eiThisPay: S1.ei,
      periodsPerYear: S1.P,
      provincialClaim: S1.abTd1,
      claimZeroProvincial: false,
      totalIncomeLessThanClaim: false,
      provincial: provParams,
    });
    expect(fed.t4PerPeriod.toFixed(2)).toBe("163.23");
    expect(ab.t4pPerPeriod.toFixed(2)).toBe("78.45");
  });
});

describe("CRA PDOC Option 1 reference · Scenario 2 (elevated TD1)", () => {
  it("Federal $144.12 · Alberta $68.51 (TD1 20000 / 26000)", () => {
    const F5A = new Decimal(S1.cppFirstAdd).plus(S1.cpp2).toFixed(2);
    const fed = calculateFederalTax({
      periodicTaxableRemuneration: S1.I,
      f5aThisPay: F5A,
      baseCppThisPay: S1.cppBase,
      eiThisPay: S1.ei,
      periodsPerYear: S1.P,
      federalClaim: "20000",
      claimZeroFederal: false,
      totalIncomeLessThanClaim: false,
      federal: fedParams,
    });
    const ab = calculateAlbertaTax({
      periodicTaxableRemuneration: S1.I,
      f5aThisPay: F5A,
      baseCppThisPay: S1.cppBase,
      eiThisPay: S1.ei,
      periodsPerYear: S1.P,
      provincialClaim: "26000",
      claimZeroProvincial: false,
      totalIncomeLessThanClaim: false,
      provincial: provParams,
    });
    expect(fed.t4PerPeriod.toFixed(2)).toBe("144.12");
    expect(ab.t4pPerPeriod.toFixed(2)).toBe("68.51");
  });
});

describe("CRA PDOC Option 1 reference · Scenario 4 (claim-zero federal)", () => {
  it("Federal $251.82 · Alberta $78.45 (claimZeroFederal=true)", () => {
    const F5A = new Decimal(S1.cppFirstAdd).plus(S1.cpp2).toFixed(2);
    const fed = calculateFederalTax({
      periodicTaxableRemuneration: S1.I,
      f5aThisPay: F5A,
      baseCppThisPay: S1.cppBase,
      eiThisPay: S1.ei,
      periodsPerYear: S1.P,
      federalClaim: "0",
      claimZeroFederal: true,
      totalIncomeLessThanClaim: false,
      federal: fedParams,
    });
    const ab = calculateAlbertaTax({
      periodicTaxableRemuneration: S1.I,
      f5aThisPay: F5A,
      baseCppThisPay: S1.cppBase,
      eiThisPay: S1.ei,
      periodsPerYear: S1.P,
      provincialClaim: S1.abTd1,
      claimZeroProvincial: false,
      totalIncomeLessThanClaim: false,
      provincial: provParams,
    });
    expect(fed.t4PerPeriod.toFixed(2)).toBe("251.82");
    expect(ab.t4pPerPeriod.toFixed(2)).toBe("78.45");
  });
});

describe("CRA PDOC Option 1 reference · ytdCreditBasis omitted → K2 uses Option 1 annualisation", () => {
  it("supplying ytdCreditBasis produces a DIFFERENT federal from omitting it", () => {
    const F5A = new Decimal(S1.cppFirstAdd).plus(S1.cpp2).toFixed(2);
    const optionOne = calculateFederalTax({
      periodicTaxableRemuneration: S1.I,
      f5aThisPay: F5A,
      baseCppThisPay: S1.cppBase,
      eiThisPay: S1.ei,
      periodsPerYear: S1.P,
      federalClaim: S1.fedTd1,
      claimZeroFederal: false,
      totalIncomeLessThanClaim: false,
      federal: fedParams,
    });
    const withYtd = calculateFederalTax({
      periodicTaxableRemuneration: S1.I,
      f5aThisPay: F5A,
      baseCppThisPay: S1.cppBase,
      eiThisPay: S1.ei,
      periodsPerYear: S1.P,
      federalClaim: S1.fedTd1,
      claimZeroFederal: false,
      totalIncomeLessThanClaim: false,
      federal: fedParams,
      // Zero prior YTD + full-year PR + max PM → the projected basis
      // will differ from the Option 1 annualisation for a first-pay.
      ytdCreditBasis: { combinedSelectedBasis: "500" },
    });
    // Different K2 → different T3 → different per-period tax.
    expect(optionOne.t4PerPeriod.toFixed(2)).not.toBe(withYtd.t4PerPeriod.toFixed(2));
    expect(optionOne.t4PerPeriod.toFixed(2)).toBe("163.23"); // Option 1 baseline
  });
});
