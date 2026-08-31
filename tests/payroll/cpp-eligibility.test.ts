// Payroll-3B-5B-1a — pure CPP contribution age-eligibility resolver.
// No DB / no I/O. Verifies the CRA calendar-month rules end-to-end.

import { describe, it, expect } from "vitest";
import { resolveCppContributionEligibility } from "@/lib/payroll/statutory/cpp-eligibility";

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

describe("Payroll-3B-5B-1a — CPP age eligibility", () => {
  it("MISSING_DOB is a distinct inapplicable reason", () => {
    const r = resolveCppContributionEligibility({ dateOfBirth: null, payDate: d(2026, 6, 15) });
    expect(r.cppApplicable).toBe(false);
    expect(r.reason).toBe("MISSING_DOB");
  });

  it("age 17 (born after 18th birthday year) → not eligible", () => {
    const r = resolveCppContributionEligibility({ dateOfBirth: d(2010, 6, 15), payDate: d(2026, 6, 15) });
    expect(r.cppApplicable).toBe(false);
    expect(r.reason).toBe("UNDER_18_BEFORE_BIRTHDAY_MONTH");
  });

  it("turns 18 on Aug 10 — pay dated in birthday MONTH: not yet eligible", () => {
    // DOB 2008-08-10 → 18th birthday 2026-08-10.
    // Pay dated 2026-08-15 falls in the birthday month → NOT yet eligible.
    const r = resolveCppContributionEligibility({ dateOfBirth: d(2008, 8, 10), payDate: d(2026, 8, 15) });
    expect(r.cppApplicable).toBe(false);
    expect(r.reason).toBe("TURNED_18_AND_IN_BIRTHDAY_MONTH_OR_EARLIER");
    expect(r.turned18ThisYear).toBe(true);
  });

  it("turns 18 on Aug 10 — first pay dated in NEXT MONTH (Sep 1): eligible", () => {
    const r = resolveCppContributionEligibility({ dateOfBirth: d(2008, 8, 10), payDate: d(2026, 9, 1) });
    expect(r.cppApplicable).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.contributionStartDate?.toISOString()).toBe(d(2026, 9, 1).toISOString());
    // Eligible Sep–Dec = 4 months.
    expect(r.contributoryMonthsInYear).toBe(4);
  });

  it("adult 25 mid-year — eligible; contributoryMonthsInYear = 12", () => {
    const r = resolveCppContributionEligibility({ dateOfBirth: d(2001, 6, 15), payDate: d(2026, 6, 15) });
    expect(r.cppApplicable).toBe(true);
    expect(r.contributoryMonthsInYear).toBe(12);
    expect(r.turned18ThisYear).toBe(false);
    expect(r.turned70ThisYear).toBe(false);
  });

  it("age 64 → eligible; contributoryMonthsInYear = 12", () => {
    const r = resolveCppContributionEligibility({ dateOfBirth: d(1962, 6, 15), payDate: d(2026, 6, 15) });
    expect(r.cppApplicable).toBe(true);
    expect(r.contributoryMonthsInYear).toBe(12);
  });

  it("age 65 (no CPT30 election) → still eligible", () => {
    const r = resolveCppContributionEligibility({ dateOfBirth: d(1961, 6, 15), payDate: d(2026, 8, 15) });
    expect(r.cppApplicable).toBe(true);
  });

  it("age 65 with ACTIVE CPT30 ELECTION_TO_STOP → not eligible (CPT30_ELECTION_STOP)", () => {
    const r = resolveCppContributionEligibility({
      dateOfBirth: d(1961, 6, 15),
      payDate: d(2026, 8, 15),
      cppElection: { kind: "ELECTION_TO_STOP", effectiveOn: d(2026, 8, 1) },
    });
    expect(r.cppApplicable).toBe(false);
    expect(r.reason).toBe("CPT30_ELECTION_STOP");
  });

  it("age 65 with CPT30 ELECTION_TO_STOP effective AFTER the pay date → still eligible today", () => {
    const r = resolveCppContributionEligibility({
      dateOfBirth: d(1961, 6, 15),
      payDate: d(2026, 8, 15),
      cppElection: { kind: "ELECTION_TO_STOP", effectiveOn: d(2026, 9, 1) },
    });
    expect(r.cppApplicable).toBe(true);
  });

  it("age 66 with prior ELECTION_TO_STOP + a REVOCATION_OF_ELECTION → eligible", () => {
    // A revocation is what the calculator sees at the CURRENT time —
    // it's the newest ACTIVE election. Confirms the branch selection.
    const r = resolveCppContributionEligibility({
      dateOfBirth: d(1960, 6, 15),
      payDate: d(2026, 8, 15),
      cppElection: { kind: "REVOCATION_OF_ELECTION", effectiveOn: d(2026, 6, 1) },
    });
    expect(r.cppApplicable).toBe(true);
  });

  it("turns 70 on Nov 10 — pay dated in birthday month is still applicable", () => {
    const r = resolveCppContributionEligibility({ dateOfBirth: d(1956, 11, 10), payDate: d(2026, 11, 15) });
    expect(r.cppApplicable).toBe(true);
    expect(r.turned70ThisYear).toBe(true);
    // Last CPP pay dated Nov 30, 2026.
    expect(r.contributionEndDate?.toISOString()).toBe(d(2026, 11, 30).toISOString());
    // Jan-Nov = 11 months.
    expect(r.contributoryMonthsInYear).toBe(11);
  });

  it("turns 70 on Nov 10 — first pay dated Dec 1 is NOT applicable", () => {
    const r = resolveCppContributionEligibility({ dateOfBirth: d(1956, 11, 10), payDate: d(2026, 12, 1) });
    expect(r.cppApplicable).toBe(false);
    expect(r.reason).toBe("TURNED_70_AND_PAST_BIRTHDAY_MONTH");
    expect(r.contributoryMonthsInYear).toBe(11);
  });

  it("age 71 → not eligible; contributoryMonthsInYear = 0", () => {
    const r = resolveCppContributionEligibility({ dateOfBirth: d(1955, 6, 15), payDate: d(2026, 6, 15) });
    expect(r.cppApplicable).toBe(false);
    expect(r.reason).toBe("TURNED_70_AND_PAST_BIRTHDAY_MONTH");
    expect(r.contributoryMonthsInYear).toBe(0);
  });

  it("turns 18 AND turns 70 boundary flags are correct across the year", () => {
    const r18 = resolveCppContributionEligibility({ dateOfBirth: d(2008, 3, 15), payDate: d(2026, 5, 1) });
    expect(r18.turned18ThisYear).toBe(true);
    expect(r18.turned70ThisYear).toBe(false);
    const r70 = resolveCppContributionEligibility({ dateOfBirth: d(1956, 5, 10), payDate: d(2026, 8, 1) });
    expect(r70.turned70ThisYear).toBe(true);
    expect(r70.turned18ThisYear).toBe(false);
  });
});
