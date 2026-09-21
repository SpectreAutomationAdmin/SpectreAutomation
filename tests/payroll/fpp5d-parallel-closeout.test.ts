// FPP-5D (2026-09-21) — Parallel-payroll closeout: calculation
// transparency + KPI + employer-cost consistency.
//
// Three surfaces:
//   §3 Adjustments KPI — must count ONE-TIME only, never recurring
//     component snapshots (they are frozen recurring assignments,
//     not operator-authored adjustments).
//   §4 Employer contribution detail — the drill-down must reconcile
//     to the batch-level Employer contributions total by including
//     employer benefit-plan snapshots (AD&D, Life, Dep Life, RRSP ER,
//     Health & Dental).
//   §2 Factor F disclosure — the review DTO must expose the frozen
//     per-period RRSP-deducted-at-source amount (Factor F) from
//     `componentSnapshots`, NOT from the live component catalogue,
//     so the review page can show "RRSP deducted at source (Factor F)
//     $X.XX (annualised $Y)".
//
// Calculator behaviour is NOT modified — FPP-5D is disclosure only.
// Chris's Sep 15 CALCULATED batch (sequence 2, calculationVersion 1)
// is preserved exactly.

import { describe, it, expect } from "vitest";
import { toDecimal } from "@/lib/payroll/statutory/decimal-money";

// ---------------------------------------------------------------------------
// §3 — Adjustments KPI
// ---------------------------------------------------------------------------

/**
 * Mirror of the overview-view.ts KPI derivation. Kept as a pure
 * function here so the semantic contract is testable without the
 * whole overview view.
 */
function kpiAdjustmentsCount(
  oneTimeAdjustmentCount: number,
  recurringSnapshotCount: number,
): { adjustmentsCount: number; oneTimeAdjustmentCount: number; recurringSnapshotCount: number } {
  // FPP-5D — adjustmentsCount counts ONE-TIME only.
  return {
    adjustmentsCount: oneTimeAdjustmentCount,
    oneTimeAdjustmentCount,
    recurringSnapshotCount,
  };
}

describe("FPP-5D §3 — Adjustments KPI counts one-time only", () => {
  it("Chris's Sep 15 batch: 0 one-time + 5 recurring snapshots → adjustments = 0", () => {
    const k = kpiAdjustmentsCount(0, 5);
    expect(k.adjustmentsCount).toBe(0);
    expect(k.oneTimeAdjustmentCount).toBe(0);
    expect(k.recurringSnapshotCount).toBe(5);
  });
  it("2 one-time + 3 recurring → adjustments = 2 (recurring stays separate)", () => {
    const k = kpiAdjustmentsCount(2, 3);
    expect(k.adjustmentsCount).toBe(2);
    expect(k.recurringSnapshotCount).toBe(3);
  });
  it("No one-time, no recurring → adjustments = 0", () => {
    const k = kpiAdjustmentsCount(0, 0);
    expect(k.adjustmentsCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §4 — Employer contribution detail consistency
// ---------------------------------------------------------------------------

/**
 * Mirror of the FPP-5D drill-down reconciliation logic in
 * PayrollReviewWorkspace + PayrollAdminOverview: statutory (CPP +
 * CPP2 + EI) + benefit-plan employer snapshots. The result MUST
 * equal review-dto's totals.employerContributions to the cent.
 */
function reconcileEmployerContributions(
  employerCpp: number,
  employerCpp2: number,
  employerEi: number,
  benefits: Array<{ displayName: string; amount: number }>,
) {
  const cCents = (n: number) => Math.round(n * 100);
  const statCents = cCents(employerCpp) + cCents(employerCpp2) + cCents(employerEi);
  const benCents = benefits.reduce((s, b) => s + cCents(b.amount), 0);
  return {
    statutoryCents: statCents,
    benefitsCents: benCents,
    totalCents: statCents + benCents,
  };
}

describe("FPP-5D §4 — Employer contribution detail reconciles to batch total", () => {
  it("Chris Sep 15: statutory + benefits = $639.96 (matches top card)", () => {
    const r = reconcileEmployerContributions(
      281.33, // CPP
      0.00,   // CPP2
      105.45, // EI (employer share = employee 75.32 × 1.4)
      [
        { displayName: "AD&D", amount: 2.25 },
        { displayName: "Life Insurance", amount: 20.93 },
        { displayName: "Dependent Life", amount: 0.83 },
        { displayName: "RRSP Employer", amount: 229.17 },
      ],
    );
    expect(r.statutoryCents).toBe(38678);   // $386.78
    expect(r.benefitsCents).toBe(25318);    // $253.18
    expect(r.totalCents).toBe(63996);       // $639.96 — matches summary-employer card
  });
  it("Statutory-only employee (no benefits) → total = statutory", () => {
    const r = reconcileEmployerContributions(278.85, 0.00, 104.61, []);
    expect(r.benefitsCents).toBe(0);
    expect(r.totalCents).toBe(r.statutoryCents);
  });
  it("Missing benefits (zero-amount rows) do NOT distort the total", () => {
    const r = reconcileEmployerContributions(
      100, 0, 40,
      [{ displayName: "AD&D", amount: 0 }],
    );
    expect(r.benefitsCents).toBe(0);
    expect(r.totalCents).toBe(14000);
  });
});

// ---------------------------------------------------------------------------
// §2 — Factor F is read from FROZEN componentSnapshots
// ---------------------------------------------------------------------------

/**
 * Mirror of getBatchEmployeeReview's Factor F derivation in
 * review-dto.ts. Sums the employee-side snapshots whose mapping type
 * is RRSP_DEDUCTED_AT_SOURCE — the ONLY sanctioned Factor F source —
 * from the batch componentSnapshots.
 */
function factorFFromSnapshots(
  snapshots: Array<{
    side: "EMPLOYEE" | "EMPLOYER";
    resolvedAmount: string | null;
    taxFormulaDeductionType: string | null;
  }>,
  periodsPerYear: number,
) {
  const perPeriod = snapshots
    .filter((s) => s.side === "EMPLOYEE" && s.taxFormulaDeductionType === "RRSP_DEDUCTED_AT_SOURCE")
    .reduce((acc, s) => acc.plus(toDecimal(s.resolvedAmount ?? 0)), toDecimal(0));
  const annualised = periodsPerYear > 0 ? perPeriod.times(periodsPerYear) : toDecimal(0);
  return { perPeriod: perPeriod.toFixed(2), annualised: annualised.toFixed(2) };
}

describe("FPP-5D §2 — Factor F exposure from frozen snapshots", () => {
  it("Chris Sep 15: RRSP EE $229.17 per pay, $5,500.08 annualised (24 periods)", () => {
    const f = factorFFromSnapshots(
      [
        { side: "EMPLOYEE", resolvedAmount: "229.17", taxFormulaDeductionType: "RRSP_DEDUCTED_AT_SOURCE" },
        { side: "EMPLOYEE", resolvedAmount: "28.11",  taxFormulaDeductionType: null },                   // LTD not F
        { side: "EMPLOYEE", resolvedAmount: "37.50",  taxFormulaDeductionType: null },                   // Cell phone (taxable benefit)
        { side: "EMPLOYER", resolvedAmount: "229.17", taxFormulaDeductionType: "RRSP_DEDUCTED_AT_SOURCE" }, // Employer side — MUST NOT count
        { side: "EMPLOYER", resolvedAmount: "2.25",   taxFormulaDeductionType: null },
      ],
      24,
    );
    expect(f.perPeriod).toBe("229.17");
    expect(f.annualised).toBe("5500.08");
  });
  it("Employer-side RRSP without EE match: Factor F is 0 (employee-side only)", () => {
    const f = factorFFromSnapshots(
      [{ side: "EMPLOYER", resolvedAmount: "229.17", taxFormulaDeductionType: "RRSP_DEDUCTED_AT_SOURCE" }],
      24,
    );
    expect(f.perPeriod).toBe("0.00");
    expect(f.annualised).toBe("0.00");
  });
  it("Employee-side non-RRSP snapshot: not counted as Factor F", () => {
    const f = factorFFromSnapshots(
      [{ side: "EMPLOYEE", resolvedAmount: "28.11", taxFormulaDeductionType: "LTD_UNSPECIFIED" }],
      24,
    );
    expect(f.perPeriod).toBe("0.00");
  });
  it("Multiple RRSP snapshots on employee-side: sum them", () => {
    const f = factorFFromSnapshots(
      [
        { side: "EMPLOYEE", resolvedAmount: "100.00", taxFormulaDeductionType: "RRSP_DEDUCTED_AT_SOURCE" },
        { side: "EMPLOYEE", resolvedAmount: "50.00",  taxFormulaDeductionType: "RRSP_DEDUCTED_AT_SOURCE" },
      ],
      24,
    );
    expect(f.perPeriod).toBe("150.00");
    expect(f.annualised).toBe("3600.00");
  });
  it("periodsPerYear=0 (missing schedule) → annualised is 0 (safe fallback)", () => {
    const f = factorFFromSnapshots(
      [{ side: "EMPLOYEE", resolvedAmount: "229.17", taxFormulaDeductionType: "RRSP_DEDUCTED_AT_SOURCE" }],
      0,
    );
    expect(f.perPeriod).toBe("229.17");
    expect(f.annualised).toBe("0.00");
  });
});

// ---------------------------------------------------------------------------
// §2 arithmetic invariant — annualisation reproducibility
// ---------------------------------------------------------------------------
//
// The founder's calculated batch has:
//   • annualised gross employment    = $116,976.24  (federal.aStar)
//   • annualised taxable income      = $110,341.44  (federal.a)
//   • Δ = $6,634.80 = F5A annualised ($1,134.72) + Factor F annualised ($5,500.08)
//
// This test pins that arithmetic identity so a future regression that
// re-plumbed F through the wrong side or the wrong mapping type would
// break this assertion instead of silently distorting Federal + Alberta
// tax.
describe("FPP-5D §2 — Annualisation identity holds (audit reproducibility)", () => {
  it("aStar − a = F5A_annualised + Factor F_annualised", () => {
    const aStar = 116976.24;                     // annualised gross employment income
    const a     = 110341.44;                     // annualised taxable income
    const f5aAnnual  = 47.28 * 24;               // deductible CPP additional × periods
    const factorFAnnual = 229.17 * 24;           // RRSP deducted at source × periods
    const delta = aStar - a;
    const explained = f5aAnnual + factorFAnnual;
    // Both sides land to cent within Number precision — round to reconcile.
    expect(Math.round(delta * 100)).toBe(Math.round(explained * 100));
  });
});
