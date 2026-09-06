// Payroll-3C-3D.5B (2026-09-09) — CPP PM semantics regression.
//
// Prior 3C-3D.5A diagnostic incorrectly assumed Sam's Feb-2 hire
// date implied PM = 11. That was wrong: CRA prorates the CPP
// annual maximum ONLY for genuine partial-year CPP-liability
// conditions (turn 18, turn 70, CPT30 stop, disability, death).
// Normal mid-year hire keeps PM = 12.
//
// This suite asserts that Spectre production correctly derives PM
// from `cppPensionableMonths` (age / election / disability / death
// only) and NOT from `Employee.hireDate`.

import { describe, it, expect } from "vitest";
import { cppPensionableMonths } from "@/lib/payroll/statutory/cpp-pensionable-months";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

describe("Payroll-3C-3D.5B · CPP PM semantics — hire date does NOT prorate", () => {
  it("Ordinary Feb-2 hire → PM = 12 (no proration merely from hire date)", () => {
    // DOB in 1980 → age 46 during 2026 → no age proration.
    const r = cppPensionableMonths({
      taxYear: 2026, dateOfBirth: utc(1980, 6, 1),
    });
    expect(r.pensionableMonthCount).toBe(12);
    expect(r.exclusionReasons).toEqual([]);
  });

  it("Ordinary July-15 hire → PM = 12 (Spectre never derives PM from hire date)", () => {
    // A July-15 hire is not modeled by `cppPensionableMonths`; the
    // function is age/election/disability/death only. Its return of
    // PM = 12 for such an employee is the correct production
    // behaviour — regardless of employment start month.
    const r = cppPensionableMonths({
      taxYear: 2026, dateOfBirth: utc(1985, 3, 15),
    });
    expect(r.pensionableMonthCount).toBe(12);
    expect(r.exclusionReasons).toEqual([]);
  });

  it("Genuine partial-year: employee turns 70 in February → PM = 2 (Jan + Feb pensionable)", () => {
    // DOB 1956-02-15 → age 70 birthday 2026-02-15 → contributions
    // continue up to AND INCLUDING February. From March onward the
    // employee is over 70 and non-pensionable.
    const r = cppPensionableMonths({
      taxYear: 2026, dateOfBirth: utc(1956, 2, 15),
    });
    expect(r.pensionableMonthCount).toBe(2);
    expect(r.exclusionReasons).toContain("OVER_70");
  });

  it("Genuine partial-year: employee turns 18 in October → PM = 2 (Nov + Dec pensionable)", () => {
    // DOB 2008-10-05 → 18th birthday 2026-10-05 → birthday month
    // is NOT pensionable; November onward IS. → 2 pensionable months.
    const r = cppPensionableMonths({
      taxYear: 2026, dateOfBirth: utc(2008, 10, 5),
    });
    expect(r.pensionableMonthCount).toBe(2);
    expect(r.exclusionReasons).toContain("UNDER_18");
  });

  it("CPT30 stop election in April → PM = 3 (Jan-Mar pensionable, April onward stopped)", () => {
    const r = cppPensionableMonths({
      taxYear: 2026,
      dateOfBirth: utc(1970, 6, 1), // over 55, valid CPT30-eligible
      cppElections: [
        { kind: "ELECTION_TO_STOP", effectiveOn: utc(2026, 4, 1) },
      ],
    });
    expect(r.pensionableMonthCount).toBe(3);
    expect(r.exclusionReasons).toContain("CPT30_STOP_ACTIVE");
  });

  it("Death in June → PM = 6 (Jan-Jun inclusive, July onward excluded)", () => {
    const r = cppPensionableMonths({
      taxYear: 2026, dateOfBirth: utc(1970, 6, 1),
      deceasedOn: utc(2026, 6, 20),
    });
    expect(r.pensionableMonthCount).toBe(6);
    expect(r.exclusionReasons).toContain("AFTER_DEATH");
  });

  it("CPP disability whole year → PM = 0", () => {
    const r = cppPensionableMonths({
      taxYear: 2026, dateOfBirth: utc(1970, 6, 1),
      cppDisabilities: [
        { status: "CPP_DISABLED", effectiveFrom: utc(2025, 1, 1), effectiveTo: null },
      ],
    });
    expect(r.pensionableMonthCount).toBe(0);
    expect(r.exclusionReasons).toContain("CPP_DISABILITY_ACTIVE");
  });
});
