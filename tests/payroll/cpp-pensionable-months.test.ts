// Payroll-3B-5B-1 — CPP pensionable-months determination + special
// situations (turns 18, turns 70, CPT30, disability, death).

import { describe, it, expect } from "vitest";
import { cppPensionableMonths } from "@/lib/payroll/statutory/cpp-pensionable-months";
import { resolveCppContributionEligibility } from "@/lib/payroll/statutory/cpp-eligibility";

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

describe("Payroll-3B-5B-1 — cppPensionableMonths", () => {
  it("adult 25 with no special events → 12 pensionable months", () => {
    const r = cppPensionableMonths({ taxYear: 2026, dateOfBirth: d(2001, 6, 15) });
    expect(r.pensionableMonthCount).toBe(12);
    expect(r.exclusionReasons).toEqual([]);
  });

  it("turns 18 mid-year (Aug 10) → 4 pensionable months (Sep–Dec)", () => {
    const r = cppPensionableMonths({ taxYear: 2026, dateOfBirth: d(2008, 8, 10) });
    expect(r.pensionableMonthCount).toBe(4);
    expect(r.months[7].pensionable).toBe(false); // Aug — birthday month excluded
    expect(r.months[8].pensionable).toBe(true);  // Sep
    expect(r.exclusionReasons).toContain("UNDER_18");
  });

  it("turns 70 mid-year (Nov 10) → 11 pensionable months (Jan–Nov)", () => {
    const r = cppPensionableMonths({ taxYear: 2026, dateOfBirth: d(1956, 11, 10) });
    expect(r.pensionableMonthCount).toBe(11);
    expect(r.months[10].pensionable).toBe(true);  // Nov — birthday month INCLUDED
    expect(r.months[11].pensionable).toBe(false); // Dec — after
    expect(r.exclusionReasons).toContain("OVER_70");
  });

  it("CPT30 stop election effective June 1 → 5 pensionable months (Jan–May)", () => {
    const r = cppPensionableMonths({
      taxYear: 2026,
      dateOfBirth: d(1961, 6, 15),
      cppElections: [{ kind: "ELECTION_TO_STOP", effectiveOn: d(2026, 6, 1) }],
    });
    expect(r.pensionableMonthCount).toBe(5);
    expect(r.months[4].pensionable).toBe(true);  // May
    expect(r.months[5].pensionable).toBe(false); // Jun (election takes effect)
    expect(r.exclusionReasons).toContain("CPT30_STOP_ACTIVE");
  });

  it("CPT30 revocation Apr 1 following the stop restores contributions from April", () => {
    // Stop effective 2026-06-01; revocation effective 2027-04-01.
    // In tax year 2027, months Jan–Mar are still STOPPED (per last
    // ACTIVE stop election), Apr–Dec resume.
    const r = cppPensionableMonths({
      taxYear: 2027,
      dateOfBirth: d(1961, 6, 15),
      cppElections: [
        { kind: "ELECTION_TO_STOP", effectiveOn: d(2026, 6, 1) },
        { kind: "REVOCATION_OF_ELECTION", effectiveOn: d(2027, 4, 1) },
      ],
    });
    expect(r.months[0].pensionable).toBe(false); // Jan
    expect(r.months[2].pensionable).toBe(false); // Mar
    expect(r.months[3].pensionable).toBe(true);  // Apr — revocation effective
    expect(r.months[11].pensionable).toBe(true); // Dec
    expect(r.pensionableMonthCount).toBe(9);
  });

  it("CPP disability full year → 0 pensionable months", () => {
    const r = cppPensionableMonths({
      taxYear: 2026,
      dateOfBirth: d(1980, 6, 15),
      cppDisabilities: [{ status: "CPP_DISABLED", effectiveFrom: d(2024, 1, 1), effectiveTo: null }],
    });
    expect(r.pensionableMonthCount).toBe(0);
    expect(r.exclusionReasons).toContain("CPP_DISABILITY_ACTIVE");
  });

  it("QPP disability partial year (Mar–Aug) → 6 pensionable months", () => {
    const r = cppPensionableMonths({
      taxYear: 2026,
      dateOfBirth: d(1980, 6, 15),
      cppDisabilities: [{ status: "QPP_DISABLED", effectiveFrom: d(2026, 3, 1), effectiveTo: d(2026, 9, 1) }],
    });
    // Jan, Feb, Sep–Dec pensionable = 6 months
    expect(r.pensionableMonthCount).toBe(6);
    expect(r.months[0].pensionable).toBe(true);
    expect(r.months[2].pensionable).toBe(false);
    expect(r.months[8].pensionable).toBe(true);
  });

  it("death in September → 9 pensionable months (Jan–Sep)", () => {
    const r = cppPensionableMonths({
      taxYear: 2026,
      dateOfBirth: d(1980, 6, 15),
      deceasedOn: d(2026, 9, 20),
    });
    expect(r.pensionableMonthCount).toBe(9);
    expect(r.months[8].pensionable).toBe(true); // Sep — INCLUDED
    expect(r.months[9].pensionable).toBe(false); // Oct — AFTER
    expect(r.exclusionReasons).toContain("AFTER_DEATH");
  });

  it("missing DOB → every month excluded", () => {
    const r = cppPensionableMonths({ taxYear: 2026, dateOfBirth: null });
    expect(r.pensionableMonthCount).toBe(0);
  });
});

describe("Payroll-3B-5B-1 — resolveCppContributionEligibility with disability + death", () => {
  it("CPP disability active → CPP_DISABILITY_ACTIVE", () => {
    const r = resolveCppContributionEligibility({
      dateOfBirth: d(1980, 6, 15),
      payDate: d(2026, 6, 15),
      cppDisability: { status: "CPP_DISABLED", effectiveFrom: d(2026, 1, 1), effectiveTo: null },
    });
    expect(r.cppApplicable).toBe(false);
    expect(r.reason).toBe("CPP_DISABILITY_ACTIVE");
  });

  it("Disability ended before pay date → applicable again", () => {
    const r = resolveCppContributionEligibility({
      dateOfBirth: d(1980, 6, 15),
      payDate: d(2026, 7, 15),
      cppDisability: { status: "CPP_DISABLED", effectiveFrom: d(2026, 1, 1), effectiveTo: d(2026, 7, 1) },
    });
    expect(r.cppApplicable).toBe(true);
  });

  it("Death — pay dated in death month is applicable; later month is PAST_DEATH_MONTH", () => {
    const inMonth = resolveCppContributionEligibility({
      dateOfBirth: d(1980, 6, 15),
      payDate: d(2026, 9, 20),
      deceasedOn: d(2026, 9, 20),
    });
    expect(inMonth.cppApplicable).toBe(true);
    expect(inMonth.contributionEndDate?.toISOString()).toBe(d(2026, 9, 30).toISOString());

    const nextMonth = resolveCppContributionEligibility({
      dateOfBirth: d(1980, 6, 15),
      payDate: d(2026, 10, 1),
      deceasedOn: d(2026, 9, 20),
    });
    expect(nextMonth.cppApplicable).toBe(false);
    expect(nextMonth.reason).toBe("PAST_DEATH_MONTH");
  });
});
