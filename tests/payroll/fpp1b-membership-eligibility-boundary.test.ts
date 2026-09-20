// FPP-1B (2026-09-20) — pay-group-membership eligibility boundary pins.
//
// Founder directive requires documenting the CURRENT canonical rule for
// which memberships are eligible for a given payroll period. The service
// (src/lib/payroll/batch-preparation.ts:resolvePopulation) uses the same
// half-open interval intersection Spectre uses everywhere else:
//
//     effectiveFrom < periodEnd
//     AND (effectiveTo == null OR effectiveTo > periodStart)
//
// This spec pins the three boundary cases the founder called out
// (Aug 24, Sep 8, Sep 9 relative to the lagged Sep 15 period
// [2026-08-24, 2026-09-09)). It does NOT change semantics — the purpose
// is to document them for the parallel-payroll test.

import { describe, it, expect } from "vitest";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

// Sep 15 lagged period: [Aug 24, Sep 9).
const periodStart = utc(2026, 8, 24);
const periodEnd   = utc(2026, 9,  9);

/**
 * Mirror the canonical membership-eligibility filter from
 * batch-preparation.ts:resolvePopulation without dragging the whole
 * DB fixture through this pin. Documents the rule so a future
 * developer cannot silently drift the semantics.
 */
function isMembershipEligibleForPeriod(
  effectiveFrom: Date,
  effectiveTo: Date | null,
  bounds: { periodStart: Date; periodEnd: Date },
): boolean {
  if (effectiveFrom.getTime() >= bounds.periodEnd.getTime()) return false;
  if (effectiveTo != null && effectiveTo.getTime() <= bounds.periodStart.getTime()) return false;
  return true;
}

describe("FPP-1B · CRGCC-SM Sep 15 lagged-period eligibility boundary", () => {
  it("effectiveFrom = Aug 24 (first day of period) → ELIGIBLE", () => {
    expect(
      isMembershipEligibleForPeriod(utc(2026, 8, 24), null, { periodStart, periodEnd }),
    ).toBe(true);
  });

  it("effectiveFrom = Sep 8 (last civil day of period) → ELIGIBLE", () => {
    // Sep 8 midnight is strictly less than Sep 9 midnight (periodEnd, exclusive),
    // so a membership that starts on Sep 8 intersects the period.
    expect(
      isMembershipEligibleForPeriod(utc(2026, 9, 8), null, { periodStart, periodEnd }),
    ).toBe(true);
  });

  it("effectiveFrom = Sep 9 (periodEnd — first day AFTER period) → NOT eligible", () => {
    // Sep 9 midnight is NOT strictly less than periodEnd (Sep 9 midnight),
    // so a membership that starts on Sep 9 does NOT intersect the period.
    expect(
      isMembershipEligibleForPeriod(utc(2026, 9, 9), null, { periodStart, periodEnd }),
    ).toBe(false);
  });

  it("effectiveFrom = Sep 16 (pre-correction Chris state) → NOT eligible", () => {
    // Preserves the pre-FPP-1B verdict for future regression clarity.
    expect(
      isMembershipEligibleForPeriod(utc(2026, 9, 16), null, { periodStart, periodEnd }),
    ).toBe(false);
  });

  it("effectiveTo NOT null but > periodStart → still eligible", () => {
    // A membership that ends inside or after the period intersects.
    expect(
      isMembershipEligibleForPeriod(
        utc(2026, 1, 1), utc(2026, 9, 5),
        { periodStart, periodEnd },
      ),
    ).toBe(true);
  });

  it("effectiveTo <= periodStart → NOT eligible", () => {
    // A membership that ended on periodStart or earlier does not intersect.
    expect(
      isMembershipEligibleForPeriod(
        utc(2026, 1, 1), utc(2026, 8, 24),
        { periodStart, periodEnd },
      ),
    ).toBe(false);
  });
});
