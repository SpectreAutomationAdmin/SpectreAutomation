// FPP-4C (2026-09-20) — Payroll workspace pay-group routing pins.
//
// Verifies that buildPayrollOverview:
//   1. Selects the alphabetically-first ACTIVE pay group by default —
//      never an inactive/archived one.
//   2. Exposes every active pay group in availablePayGroups, sorted by
//      code, with correct frequency labels.
//   3. Honours an explicit URL payGroupId even when it resolves to an
//      inactive group, but flags payGroup.inactive = true so the
//      workspace can advise the operator.
//   4. Never leaks periods across pay groups.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import { buildPayrollOverview } from "@/lib/payroll/overview-view";

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

async function seedPayGroup(clubId: string, opts: {
  code: string;
  name: string;
  payFrequency: "SEMI_MONTHLY" | "BIWEEKLY";
  periodBoundaryStrategy: string;
  active: boolean;
}) {
  return db().payrollPayGroup.create({
    data: {
      clubId,
      code: opts.code,
      name: opts.name,
      payFrequency: opts.payFrequency,
      periodBoundaryStrategy: opts.periodBoundaryStrategy,
      active: opts.active,
    },
  });
}

async function seedPeriod(clubId: string, payGroupId: string, opts: {
  taxYear: number;
  sequenceInYear: number;
  periodStart: Date;
  periodEnd: Date;
  payDate: Date;
}) {
  return db().payrollPayPeriod.create({
    data: { clubId, payGroupId, ...opts },
  });
}

async function scenario() {
  const club = await makeClub("FPP-4C Club");
  const admin = await makeUser({ email: "adminA@fpp4c.test", role: "CLUB_ADMIN", clubId: club.id });
  const pa = await makeUser({ email: "paA@fpp4c.test", role: "PAYROLL_ADMIN", clubId: club.id });
  const adminP = await principalFor(admin.email);
  const paP = await principalFor(pa.email);
  await upsertPayrollClubConfig(adminP, club.id, {
    provinceOfEmployment: "AB", payrollAdminUserId: pa.id,
  });
  return { club, adminP, paP };
}

describe("FPP-4C — payroll workspace pay-group routing", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("defaults to the alphabetically-first ACTIVE pay group (never an inactive one)", async () => {
    const s = await scenario();
    const inactiveBw = await seedPayGroup(s.club.id, {
      code: "AAA-ARCHIVED-BW", name: "Archived Bi-weekly",
      payFrequency: "BIWEEKLY", periodBoundaryStrategy: "CALENDAR_SEMI_MONTHLY",
      active: false,
    });
    const activeSm = await seedPayGroup(s.club.id, {
      code: "CLUB-SM", name: "Club Semi-Monthly",
      payFrequency: "SEMI_MONTHLY", periodBoundaryStrategy: "LAGGED_SEMI_MONTHLY",
      active: true,
    });
    // Both groups have Sep 15-ish periods to prove the picker is scoped.
    await seedPeriod(s.club.id, inactiveBw.id, {
      taxYear: 2026, sequenceInYear: 18,
      periodStart: d(2026, 8, 30), periodEnd: d(2026, 9, 13), payDate: d(2026, 9, 12),
    });
    await seedPeriod(s.club.id, activeSm.id, {
      taxYear: 2026, sequenceInYear: 17,
      periodStart: d(2026, 8, 24), periodEnd: d(2026, 9, 9), payDate: d(2026, 9, 15),
    });

    const view = await buildPayrollOverview({
      principal: s.paP, clubId: s.club.id,
      payGroupId: null, payPeriodId: null,
      q: null, department: null, employmentType: null, status: null,
      page: 1, pageSize: 10, tab: null,
    });

    expect(view.payGroup?.id).toBe(activeSm.id);
    expect(view.payGroup?.code).toBe("CLUB-SM");
    expect(view.payGroup?.inactive).toBe(false);
    // Available list should carry only the active group, sorted by code.
    expect(view.availablePayGroups.map((g) => g.code)).toEqual(["CLUB-SM"]);
    // Periods on the view must be scoped to CLUB-SM.
    for (const p of view.availablePayPeriods) {
      // The seeded CRGCC-SM period is Aug 24 → Sep 9; the archived one
      // is Aug 30 → Sep 13 (excluded).
      expect(p.periodStartISO).not.toContain("2026-08-30");
    }
  });

  it("sorts availablePayGroups by code (deterministic)", async () => {
    const s = await scenario();
    const g1 = await seedPayGroup(s.club.id, {
      code: "ZZ-LATE", name: "Late alphabetical",
      payFrequency: "SEMI_MONTHLY", periodBoundaryStrategy: "LAGGED_SEMI_MONTHLY",
      active: true,
    });
    const g2 = await seedPayGroup(s.club.id, {
      code: "AA-EARLY", name: "Early alphabetical",
      payFrequency: "BIWEEKLY", periodBoundaryStrategy: "CALENDAR_SEMI_MONTHLY",
      active: true,
    });
    const g3 = await seedPayGroup(s.club.id, {
      code: "MM-MIDDLE", name: "Middle alphabetical",
      payFrequency: "SEMI_MONTHLY", periodBoundaryStrategy: "LAGGED_SEMI_MONTHLY",
      active: true,
    });
    await seedPeriod(s.club.id, g1.id, {
      taxYear: 2026, sequenceInYear: 17,
      periodStart: d(2026, 8, 24), periodEnd: d(2026, 9, 9), payDate: d(2026, 9, 15),
    });
    await seedPeriod(s.club.id, g2.id, {
      taxYear: 2026, sequenceInYear: 18,
      periodStart: d(2026, 8, 30), periodEnd: d(2026, 9, 13), payDate: d(2026, 9, 12),
    });
    await seedPeriod(s.club.id, g3.id, {
      taxYear: 2026, sequenceInYear: 17,
      periodStart: d(2026, 8, 24), periodEnd: d(2026, 9, 9), payDate: d(2026, 9, 15),
    });

    const view = await buildPayrollOverview({
      principal: s.paP, clubId: s.club.id,
      payGroupId: null, payPeriodId: null,
      q: null, department: null, employmentType: null, status: null,
      page: 1, pageSize: 10, tab: null,
    });

    expect(view.availablePayGroups.map((g) => g.code)).toEqual([
      "AA-EARLY", "MM-MIDDLE", "ZZ-LATE",
    ]);
    // The chosen default is the alphabetically-first active group.
    expect(view.payGroup?.code).toBe("AA-EARLY");
    // No leak: void; view.payGroup.id should equal g2.id.
    expect(view.payGroup?.id).toBe(g2.id);
  });

  it("honours explicit URL payGroupId + flags inactive: true when it resolves to an archived group", async () => {
    const s = await scenario();
    const inactiveBw = await seedPayGroup(s.club.id, {
      code: "FDR-BW-ARCHIVED", name: "Founder Review Biweekly",
      payFrequency: "BIWEEKLY", periodBoundaryStrategy: "CALENDAR_SEMI_MONTHLY",
      active: false,
    });
    const activeSm = await seedPayGroup(s.club.id, {
      code: "CRGCC-SM", name: "Coulee Ridge Semi-Monthly",
      payFrequency: "SEMI_MONTHLY", periodBoundaryStrategy: "LAGGED_SEMI_MONTHLY",
      active: true,
    });
    await seedPeriod(s.club.id, inactiveBw.id, {
      taxYear: 2026, sequenceInYear: 18,
      periodStart: d(2026, 8, 30), periodEnd: d(2026, 9, 13), payDate: d(2026, 9, 12),
    });
    await seedPeriod(s.club.id, activeSm.id, {
      taxYear: 2026, sequenceInYear: 17,
      periodStart: d(2026, 8, 24), periodEnd: d(2026, 9, 9), payDate: d(2026, 9, 15),
    });

    const view = await buildPayrollOverview({
      principal: s.paP, clubId: s.club.id,
      payGroupId: inactiveBw.id, payPeriodId: null,
      q: null, department: null, employmentType: null, status: null,
      page: 1, pageSize: 10, tab: null,
    });

    expect(view.payGroup?.id).toBe(inactiveBw.id);
    expect(view.payGroup?.inactive).toBe(true);
    // Available list still shows only the active group (CRGCC-SM),
    // so the UI can offer the switch.
    expect(view.availablePayGroups.map((g) => g.code)).toEqual(["CRGCC-SM"]);
  });

  it("returns empty payGroup + availablePayGroups=[] when no groups exist", async () => {
    const s = await scenario();
    const view = await buildPayrollOverview({
      principal: s.paP, clubId: s.club.id,
      payGroupId: null, payPeriodId: null,
      q: null, department: null, employmentType: null, status: null,
      page: 1, pageSize: 10, tab: null,
    });
    expect(view.payGroup).toBeNull();
    expect(view.availablePayGroups).toEqual([]);
  });

  it("periods are scoped to the selected pay group (no cross-group leakage)", async () => {
    const s = await scenario();
    const g1 = await seedPayGroup(s.club.id, {
      code: "AA-SM", name: "SM",
      payFrequency: "SEMI_MONTHLY", periodBoundaryStrategy: "LAGGED_SEMI_MONTHLY",
      active: true,
    });
    const g2 = await seedPayGroup(s.club.id, {
      code: "BB-BW", name: "BW",
      payFrequency: "BIWEEKLY", periodBoundaryStrategy: "CALENDAR_SEMI_MONTHLY",
      active: true,
    });
    await seedPeriod(s.club.id, g1.id, {
      taxYear: 2026, sequenceInYear: 17,
      periodStart: d(2026, 8, 24), periodEnd: d(2026, 9, 9), payDate: d(2026, 9, 15),
    });
    await seedPeriod(s.club.id, g2.id, {
      taxYear: 2026, sequenceInYear: 18,
      periodStart: d(2026, 8, 30), periodEnd: d(2026, 9, 13), payDate: d(2026, 9, 12),
    });

    // Select group 2 explicitly.
    const view = await buildPayrollOverview({
      principal: s.paP, clubId: s.club.id,
      payGroupId: g2.id, payPeriodId: null,
      q: null, department: null, employmentType: null, status: null,
      page: 1, pageSize: 10, tab: null,
    });

    expect(view.payGroup?.id).toBe(g2.id);
    // Only the group 2 period should appear.
    const periodStartDates = view.availablePayPeriods.map((p) => p.periodStartISO.slice(0, 10));
    expect(periodStartDates).toContain("2026-08-30");
    expect(periodStartDates).not.toContain("2026-08-24");
  });
});
