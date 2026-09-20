// FPP-5 (2026-09-20) — batch reconciliation + period display pins.
//
// Root cause of the founder's Sep 15 batch reconciliation failure:
// getReviewBatch computed employeeDeductions as CPP + CPP2 + EI +
// Federal + Prov + Additional only — omitting employee-side component
// deductions (LTD $28.11, RRSP EE $229.17 = $257.28 delta). The batch
// employee's persisted `totalEmployeeDeductions` column already sums
// statutory + component correctly. Reconciliation must key off that
// authoritative value.
//
// Companion fix: employer contributions previously counted only
// employer CPP + CPP2 + EI. Employer-side componentSnapshots (AD&D,
// Life, Dep Life, RRSP ER) are equally employer payroll cost and
// must be included.
//
// Period display: header + picker now show the inclusive last day
// (Aug 24 – Sep 8) even though periodEnd remains 2026-09-09 (exclusive).

import { describe, it, expect } from "vitest";
import { periodLongLabel } from "@/lib/payroll/overview-view";

/**
 * Reproduce the reconciliation math the review DTO now uses:
 *   employeeDeductions = sum(batchEmployee.totalEmployeeDeductions)
 *   employerContributions = employerCPP + employerCPP2 + employerEI
 *                          + sum(employerSideComponentSnapshots)
 *   reconciled = gross - employeeDeductions === netPay
 */
function reconcile(
  employees: Array<{
    grossPay: number;
    netPay: number;
    totalEmployeeDeductions: number;
    employerCpp: number;
    employerCpp2: number;
    employerEi: number;
  }>,
  componentSnapshots: Array<{
    side: "EMPLOYEE" | "EMPLOYER";
    cashEffect: "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT";
    resolvedAmount: number;
  }>,
) {
  const gross = employees.reduce((s, e) => s + e.grossPay, 0);
  const employeeDeductions = employees.reduce((s, e) => s + e.totalEmployeeDeductions, 0);
  const netPay = employees.reduce((s, e) => s + e.netPay, 0);
  const employerCPP = employees.reduce((s, e) => s + e.employerCpp, 0);
  const employerCPP2 = employees.reduce((s, e) => s + e.employerCpp2, 0);
  const employerEI = employees.reduce((s, e) => s + e.employerEi, 0);
  const employerBenefits = componentSnapshots
    .filter((c) => c.side === "EMPLOYER")
    .reduce((s, c) => s + c.resolvedAmount, 0);
  const employerContributions = employerCPP + employerCPP2 + employerEI + employerBenefits;
  const componentDeductions = componentSnapshots
    .filter((c) => c.side === "EMPLOYEE" && c.cashEffect === "DECREASES_NET_PAY")
    .reduce((s, c) => s + c.resolvedAmount, 0);
  const diff = Math.round((gross - employeeDeductions) * 100) - Math.round(netPay * 100);
  return {
    gross, employeeDeductions, netPay, employerContributions,
    componentDeductions, reconciled: diff === 0, differenceCents: diff,
  };
}

describe("FPP-5 — batch reconciliation aggregation", () => {
  it("Chris Sep 15: statutory + LTD + RRSP EE all in employeeDeductions → reconciles", () => {
    // Founder's real data.
    const r = reconcile(
      [{
        grossPay: 4620.83,
        netPay: 2967.43,
        totalEmployeeDeductions: 1653.40,
        employerCpp: 281.33,
        employerCpp2: 0.00,
        employerEi: 105.45,
      }],
      [
        { side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY", resolvedAmount: 37.50 },   // Cell Phone
        { side: "EMPLOYEE", cashEffect: "DECREASES_NET_PAY", resolvedAmount: 28.11 },   // LTD
        { side: "EMPLOYEE", cashEffect: "DECREASES_NET_PAY", resolvedAmount: 229.17 },  // RRSP EE
        { side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT", resolvedAmount: 2.25 },    // AD&D
        { side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT", resolvedAmount: 20.93 },   // Life Insurance
        { side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT", resolvedAmount: 0.83 },    // Dep Life
        { side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT", resolvedAmount: 229.17 },  // RRSP ER
      ],
    );
    expect(r.gross).toBeCloseTo(4620.83, 2);
    expect(r.employeeDeductions).toBeCloseTo(1653.40, 2);
    expect(r.netPay).toBeCloseTo(2967.43, 2);
    expect(r.reconciled).toBe(true);
    expect(r.differenceCents).toBe(0);
    // Component deduction breakdown line surfaces LTD + RRSP EE = $257.28
    expect(r.componentDeductions).toBeCloseTo(257.28, 2);
    // Employer contributions = employer CPP + EI + all employer benefits
    // = 281.33 + 105.45 + 2.25 + 20.93 + 0.83 + 229.17 = 639.96
    expect(r.employerContributions).toBeCloseTo(639.96, 2);
  });

  it("Statutory-only deductions still reconcile when no components exist", () => {
    const r = reconcile(
      [{
        grossPay: 4583.33, netPay: 3187.03,
        totalEmployeeDeductions: 1396.30,
        employerCpp: 278.85, employerCpp2: 0, employerEi: 104.61,
      }],
      [],
    );
    expect(r.reconciled).toBe(true);
    expect(r.componentDeductions).toBe(0);
    // Employer contributions = statutory only
    expect(r.employerContributions).toBeCloseTo(383.46, 2);
  });

  it("Employer-side taxable benefit does NOT affect employee deductions", () => {
    const r = reconcile(
      [{
        grossPay: 1000, netPay: 800,
        totalEmployeeDeductions: 200,
        employerCpp: 50, employerCpp2: 0, employerEi: 20,
      }],
      [{ side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT", resolvedAmount: 25 }],
    );
    expect(r.reconciled).toBe(true);
    expect(r.componentDeductions).toBe(0);
    expect(r.employerContributions).toBe(50 + 20 + 25);
  });

  it("INCREASES_NET_PAY employee-side component NOT counted as deduction", () => {
    const r = reconcile(
      [{
        grossPay: 1000, netPay: 780,
        totalEmployeeDeductions: 220,
        employerCpp: 50, employerCpp2: 0, employerEi: 20,
      }],
      [
        { side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY", resolvedAmount: 37.50 },
        { side: "EMPLOYEE", cashEffect: "DECREASES_NET_PAY", resolvedAmount: 20 },
      ],
    );
    expect(r.componentDeductions).toBe(20);
    expect(r.reconciled).toBe(true);
  });
});

describe("FPP-5 — period display shows inclusive last day", () => {
  it("Aug 24 – Sep 9 (half-open) → 'Aug 24, 2026 – Sep 8, 2026'", () => {
    const s = periodLongLabel({
      id: "p1",
      label: "Aug 24, 2026 – Sep 8, 2026",
      periodStartISO: "2026-08-24",
      periodEndISO: "2026-09-09",
      payDateISO: "2026-09-15",
    });
    expect(s).toContain("Aug 24, 2026");
    expect(s).toContain("Sep 8, 2026");
    expect(s).not.toContain("Sep 9");
  });

  it("month boundary: Feb 1 – Mar 1 → 'Feb 1, 2026 – Feb 28, 2026'", () => {
    const s = periodLongLabel({
      id: "p2",
      label: "any",
      periodStartISO: "2026-02-01",
      periodEndISO: "2026-03-01",
      payDateISO: "2026-03-01",
    });
    expect(s).toContain("Feb 1, 2026");
    expect(s).toContain("Feb 28, 2026");
    expect(s).not.toContain("Mar 1");
  });

  it("year boundary: Dec 16 – Jan 1 → 'Dec 16, 2026 – Dec 31, 2026'", () => {
    const s = periodLongLabel({
      id: "p3",
      label: "any",
      periodStartISO: "2026-12-16",
      periodEndISO: "2027-01-01",
      payDateISO: "2026-12-31",
    });
    expect(s).toContain("Dec 16, 2026");
    expect(s).toContain("Dec 31, 2026");
    expect(s).not.toContain("Jan 1");
  });
});
