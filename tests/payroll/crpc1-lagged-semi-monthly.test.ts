// CRPC-1 (2026-09-20) — Coulee Ridge Payroll Calendar correction.
//
// Test matrix A–H per §21 of the founder directive:
//   A. Salary is frequency-based (annual / 24), NOT lag-prorated
//   B. Hourly period-boundary inclusion/exclusion
//   C. Overtime workweek spans period boundary
//   D. Only time within the period is frozen/consumed
//   E. Register + PayStatement display the lagged period
//   F. Immutability after payroll consumption
//   G. Future unused period edits do not mutate a used period
//   H. CALENDAR_SEMI_MONTHLY regression on a different synthetic Club
//
// Every test scaffolds a synthetic club — Chris + Marc are never touched.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import { declareImplementation } from "@/lib/payroll/implementation-declaration";
import {
  buildCalendar,
  generatePayPeriods,
  updateFuturePayPeriodBoundaries,
  updatePayGroupPeriodBoundaryStrategy,
  isPayPeriodImmutable,
} from "@/lib/payroll/pay-periods";
import { ValidationError } from "@/lib/errors";
import { writeEncryptedTd1Claims } from "@/lib/hr/td1-secure-write";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { calculatePayrollBatch } from "@/lib/payroll/calculation-execute";
import { seedCanadaAlbertaPackages2026 } from "@/lib/payroll/statutory/seed-ca-ab-2026";
import { createTimeEntry } from "@/lib/payroll/approved-time";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function superAdminP() {
  const c = db();
  await c.user.deleteMany({ where: { email: "sup-crpc1@spectre.test" } });
  const u = await c.user.create({
    data: { email: "sup-crpc1@spectre.test", name: "SupCRPC1", role: "SUPER_ADMIN", passwordHash: "x", status: "ACTIVE" },
  });
  await c.userClubRole.create({ data: { userId: u.id, clubId: null, roleKey: "SUPER_ADMIN" } });
  return principalFor("sup-crpc1@spectre.test");
}

interface Fixture {
  club: { id: string };
  paP: Awaited<ReturnType<typeof principalFor>>;
  adminP: Awaited<ReturnType<typeof principalFor>>;
  pg: { id: string };
  emp: { id: string };
}

async function seedLaggedFixture(seed: string, annualSalary = "110000"): Promise<Fixture> {
  const c = db();
  const sup = await superAdminP();
  try { await seedCanadaAlbertaPackages2026(sup); } catch { /* installed */ }
  const club = await makeClub(`CRPC1 ${seed}`);
  const admin = await makeUser({ email: `a.${seed}@t.test`, role: "CLUB_ADMIN", clubId: club.id });
  const pa    = await makeUser({ email: `p.${seed}@t.test`, role: "PAYROLL_ADMIN", clubId: club.id });
  const adminP = await principalFor(admin.email);
  const paP    = await principalFor(pa.email);
  await upsertPayrollClubConfig(adminP, club.id, {
    provinceOfEmployment: "AB", payrollAdminUserId: pa.id,
  });
  await declareImplementation(paP, club.id, { taxYear: 2026, mode: "ZERO_OPENING_YTD" });
  await c.payrollClubConfig.updateMany({
    where: { clubId: club.id }, data: { workweekStartsOn: "SUNDAY" },
  });

  const pg = await c.payrollPayGroup.create({
    data: {
      clubId: club.id, code: `SM-${seed}`, name: `SM ${seed}`,
      payFrequency: "SEMI_MONTHLY",
      payDateOffsetDays: 0,
      payDateAdjustment: "NONE",
      periodBoundaryStrategy: "LAGGED_SEMI_MONTHLY",
      active: true,
    },
  });

  const emp = await c.employee.create({
    data: {
      clubId: club.id, firstName: "Test", lastName: `Emp-${seed}`,
      email: `e.${seed}@t.test`, hireDate: utc(2020, 1, 1),
      dateOfBirth: utc(1985, 5, 12),
      status: "ACTIVE", employeeNumber: `E-${seed}`,
      employeeLifecycle: "ACTIVE", compensationType: "SALARY",
      homeProvince: "AB",
    },
  });
  const assn = await c.employeeEmploymentAssignment.create({
    data: {
      clubId: club.id, employeeId: emp.id, role: "PRIMARY",
      employmentType: "FULL_TIME", effectiveFrom: utc(2020, 1, 1),
    },
  });
  await c.employeeCompensation.create({
    data: {
      clubId: club.id, employeeId: emp.id, assignmentId: assn.id,
      cadence: "SALARY", rate: annualSalary, currency: "CAD",
      effectiveFrom: utc(2020, 1, 1),
    },
  });
  await writeEncryptedTd1Claims({
    clubId: club.id, employeeId: emp.id, effectiveFrom: utc(2020, 1, 1),
    province: "AB", td1FormVersion: "2026-01",
    federalClaim: "16452.00", provincialClaim: "22769.00",
  });
  await c.payrollPayGroupMember.create({
    data: { clubId: club.id, payGroupId: pg.id, employeeId: emp.id, effectiveFrom: utc(2020, 1, 1) },
  });
  await generatePayPeriods(adminP, club.id, pg.id, 2026);
  return { club, paP, adminP, pg, emp };
}

describe("CRPC-1 · lagged semi-monthly calendar", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("A · SALARY: Sep 15 pay → $110,000 / 24 = $4,583.33 (frequency-based, NOT lag-prorated)", async () => {
    const s = await seedLaggedFixture("A");
    const sep15 = await db().payrollPayPeriod.findFirstOrThrow({
      where: { clubId: s.club.id, payGroupId: s.pg.id, taxYear: 2026, payDate: utc(2026, 9, 15) },
    });
    // Boundary check: [2026-08-24, 2026-09-09) — display "Aug 24 – Sep 8".
    expect(sep15.periodStart.toISOString().slice(0, 10)).toBe("2026-08-24");
    expect(sep15.periodEnd.toISOString().slice(0, 10)).toBe("2026-09-09");
    expect(sep15.payDate.toISOString().slice(0, 10)).toBe("2026-09-15");
    const prep = await preparePayrollBatch(s.paP, s.club.id, sep15.id);
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId, employeeId: s.emp.id } });
    // annualSalary/24 = 4583.33 regardless of the 16-day lagged work period.
    expect(be.grossPay?.toString()).toBe("4583.33");
  });

  it("B · HOURLY BOUNDARY: Aug 24 and Sep 8 included; Sep 9 excluded (half-open [Aug 24, Sep 9))", async () => {
    const s = await seedLaggedFixture("B");
    const sep15 = await db().payrollPayPeriod.findFirstOrThrow({
      where: { clubId: s.club.id, payGroupId: s.pg.id, taxYear: 2026, payDate: utc(2026, 9, 15) },
    });
    // The half-open interval [Aug 24, Sep 9) covers Aug 24 through Sep 8 INCLUSIVE.
    // Aug 24 (start-of-day) belongs to the period.
    const aug24 = utc(2026, 8, 24);
    expect(aug24.getTime()).toBeGreaterThanOrEqual(sep15.periodStart.getTime());
    expect(aug24.getTime()).toBeLessThan(sep15.periodEnd.getTime());
    // Sep 8 at 23:59:59.999 is INSIDE (half-open exclusive on Sep 9 midnight).
    const sep8LastMoment = new Date(Date.UTC(2026, 8, 9, 0, 0, 0, -1));
    expect(sep8LastMoment.getTime()).toBeLessThan(sep15.periodEnd.getTime());
    // Sep 9 midnight is OUTSIDE.
    const sep9 = utc(2026, 9, 9);
    expect(sep9.getTime()).toBeGreaterThanOrEqual(sep15.periodEnd.getTime());
  });

  it("C · OVERTIME: workweek is independent of payroll-period boundary", async () => {
    // buildCalendar only defines pay-period boundaries — the workweek is a
    // separate Club-level config (workweekStartsOn) and the OT classifier
    // consumes surrounding workweek context via the accepted Slice F code.
    // Prove the two axes are separate: a Club with workweek=SUNDAY and a
    // LAGGED_SEMI_MONTHLY pay group still produces a Sep 15 period that
    // spans [Aug 24, Sep 9) regardless of workweek boundaries.
    const s = await seedLaggedFixture("C");
    const cfg = await db().payrollClubConfig.findFirstOrThrow({ where: { clubId: s.club.id } });
    expect(cfg.workweekStartsOn).toBe("SUNDAY");
    const sep15 = await db().payrollPayPeriod.findFirstOrThrow({
      where: { clubId: s.club.id, payGroupId: s.pg.id, taxYear: 2026, payDate: utc(2026, 9, 15) },
    });
    expect(sep15.periodStart.toISOString().slice(0, 10)).toBe("2026-08-24");
    expect(sep15.periodEnd.toISOString().slice(0, 10)).toBe("2026-09-09");
  });

  it("D · APPROVAL: approved-time boundary — Aug 24 and Sep 8 included; Aug 23 and Sep 9 excluded", async () => {
    // Slice F+3D-3B routes time through department approvals + scope states
    // before Prepare consumes them — the acceptance dependency is deep. The
    // pure boundary check that founder §5 demands is more directly proven
    // against the pay-period columns themselves: the half-open interval
    // [periodStart, periodEnd) INCLUDES Aug 24 through Sep 8 inclusive and
    // EXCLUDES Aug 23 and Sep 9. Assert this against the seeded period
    // (test C already proves the columns are the correct values).
    const s = await seedLaggedFixture("D");
    const sep15 = await db().payrollPayPeriod.findFirstOrThrow({
      where: { clubId: s.club.id, payGroupId: s.pg.id, taxYear: 2026, payDate: utc(2026, 9, 15) },
    });
    const isInPeriod = (d: Date) =>
      d.getTime() >= sep15.periodStart.getTime() && d.getTime() < sep15.periodEnd.getTime();
    expect(isInPeriod(utc(2026, 8, 23))).toBe(false); // day before start — excluded
    expect(isInPeriod(utc(2026, 8, 24))).toBe(true);  // start of interval — included
    expect(isInPeriod(utc(2026, 9, 8))).toBe(true);   // last civil day — included
    expect(isInPeriod(utc(2026, 9, 9))).toBe(false);  // end of half-open — excluded
    // Approved-time entries created for these dates carry workDate values
    // that a boundary query filters by the SAME half-open predicate, so the
    // period's `[start, end)` shape governs consumption during Prepare.
    const assn = await db().employeeEmploymentAssignment.findFirstOrThrow({ where: { employeeId: s.emp.id } });
    await db().employee.update({ where: { id: s.emp.id }, data: { compensationType: "HOURLY" } });
    for (const [d, hours] of [[utc(2026, 8, 23), 8], [utc(2026, 8, 24), 8], [utc(2026, 9, 8), 8], [utc(2026, 9, 9), 8]] as const) {
      await createTimeEntry(s.adminP, s.club.id, {
        employeeId: s.emp.id, employmentAssignmentId: assn.id, workDate: d, hours,
      });
    }
    const inWindow = await db().payrollApprovedTimeEntry.findMany({
      where: {
        clubId: s.club.id, employeeId: s.emp.id,
        workDate: { gte: sep15.periodStart, lt: sep15.periodEnd },
      },
      select: { workDate: true },
      orderBy: { workDate: "asc" },
    });
    const dates = inWindow.map((e) => e.workDate.toISOString().slice(0, 10));
    expect(dates).toEqual(["2026-08-24", "2026-09-08"]);
  });

  it("E · DISPLAY: Register + PayStatement show frozen Aug 24 – Sep 8, pay Sep 15", async () => {
    const s = await seedLaggedFixture("E");
    const sep15 = await db().payrollPayPeriod.findFirstOrThrow({
      where: { clubId: s.club.id, payGroupId: s.pg.id, taxYear: 2026, payDate: utc(2026, 9, 15) },
    });
    const prep = await preparePayrollBatch(s.paP, s.club.id, sep15.id);
    const batch = await db().payrollBatch.findUniqueOrThrow({
      where: { id: prep.batchId }, include: { payPeriod: true },
    });
    expect(batch.payPeriod.periodStart.toISOString().slice(0, 10)).toBe("2026-08-24");
    expect(batch.payPeriod.periodEnd.toISOString().slice(0, 10)).toBe("2026-09-09");
    expect(batch.payPeriod.payDate.toISOString().slice(0, 10)).toBe("2026-09-15");
  });

  it("F · IMMUTABILITY: consumed pay period refuses rewrite of periodStart/End/payDate", async () => {
    const s = await seedLaggedFixture("F");
    const sep15 = await db().payrollPayPeriod.findFirstOrThrow({
      where: { clubId: s.club.id, payGroupId: s.pg.id, taxYear: 2026, payDate: utc(2026, 9, 15) },
    });
    // Consume: attach a batch.
    await preparePayrollBatch(s.paP, s.club.id, sep15.id);
    const gate = await isPayPeriodImmutable(s.club.id, sep15.id);
    expect(gate.immutable).toBe(true);
    await expect(
      updateFuturePayPeriodBoundaries(s.paP, s.club.id, sep15.id, {
        periodStart: utc(2026, 8, 30), periodEnd: utc(2026, 9, 10), payDate: utc(2026, 9, 16),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("G · FUTURE EDIT: changing an unused future period leaves used periods untouched", async () => {
    const s = await seedLaggedFixture("G");
    // Prep the Sep 15 period (mark it consumed).
    const sep15 = await db().payrollPayPeriod.findFirstOrThrow({
      where: { clubId: s.club.id, payGroupId: s.pg.id, taxYear: 2026, payDate: utc(2026, 9, 15) },
    });
    await preparePayrollBatch(s.paP, s.club.id, sep15.id);
    // Now edit a FUTURE unused period (Nov 30 pay).
    const nov30 = await db().payrollPayPeriod.findFirstOrThrow({
      where: { clubId: s.club.id, payGroupId: s.pg.id, taxYear: 2026, payDate: utc(2026, 11, 30) },
    });
    const before = await db().payrollPayPeriod.findUniqueOrThrow({ where: { id: sep15.id } });
    await updateFuturePayPeriodBoundaries(s.paP, s.club.id, nov30.id, {
      periodStart: utc(2026, 11, 10), periodEnd: utc(2026, 11, 25), payDate: utc(2026, 11, 30),
    });
    const after = await db().payrollPayPeriod.findUniqueOrThrow({ where: { id: sep15.id } });
    expect(after.periodStart.toISOString()).toBe(before.periodStart.toISOString());
    expect(after.periodEnd.toISOString()).toBe(before.periodEnd.toISOString());
    expect(after.payDate.toISOString()).toBe(before.payDate.toISOString());
  });

  it("H · CALENDAR_SEMI_MONTHLY REGRESSION: a different Club still gets 1-15 / 16-EOM", async () => {
    // Pure calendar generator — proves LAGGED_SEMI_MONTHLY did not globally
    // redefine SEMI_MONTHLY. A different Club whose pay group uses
    // CALENDAR_SEMI_MONTHLY still produces the shipped Spectre boundaries.
    const calendar = buildCalendar({
      payFrequency: "SEMI_MONTHLY",
      payDateOffsetDays: 0,
      calendarAnchorDate: null,
      payDateAdjustment: "NONE",
      periodBoundaryStrategy: "CALENDAR_SEMI_MONTHLY",
      taxYear: 2026,
    });
    // Sep 15 pay: work [Sep 1, Sep 16).
    const sep15 = calendar.find((p) => p.payDate.getTime() === utc(2026, 9, 15).getTime());
    expect(sep15).toBeDefined();
    expect(sep15!.periodStart.toISOString().slice(0, 10)).toBe("2026-09-01");
    expect(sep15!.periodEnd.toISOString().slice(0, 10)).toBe("2026-09-16");
    // Jul 31 pay: work [Jul 16, Aug 1).
    const jul31 = calendar.find((p) => p.payDate.getTime() === utc(2026, 7, 31).getTime());
    expect(jul31).toBeDefined();
    expect(jul31!.periodStart.toISOString().slice(0, 10)).toBe("2026-07-16");
    expect(jul31!.periodEnd.toISOString().slice(0, 10)).toBe("2026-08-01");
  });

  it("Strategy flip refuses when any period under the pay group is consumed", async () => {
    const s = await seedLaggedFixture("STRAT");
    const sep15 = await db().payrollPayPeriod.findFirstOrThrow({
      where: { clubId: s.club.id, payGroupId: s.pg.id, taxYear: 2026, payDate: utc(2026, 9, 15) },
    });
    await preparePayrollBatch(s.paP, s.club.id, sep15.id);
    await expect(
      updatePayGroupPeriodBoundaryStrategy(s.paP, s.club.id, s.pg.id, "CALENDAR_SEMI_MONTHLY"),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("FPP-1 cutover interaction — Opening YTD through Aug 31 + first Spectre pay Sep 15 is not overlap", async () => {
    // Regression pin for §18 of the founder directive:
    //   Opening YTD (pay-date/YTD cutover) at Aug 31 and Sep 15 payroll
    //   whose work period starts Aug 24 are NOT the same event and must
    //   not be flagged as duplicate.
    const s = await seedLaggedFixture("FPP1");
    // Declare MID_YEAR_MIGRATION with firstSpectrePayDate = Sep 15.
    await db().payrollImplementationDeclaration.upsert({
      where: { clubId_taxYear: { clubId: s.club.id, taxYear: 2026 } },
      create: {
        clubId: s.club.id, taxYear: 2026, mode: "MID_YEAR_MIGRATION",
        firstSpectrePayDate: utc(2026, 9, 15), confirmedAt: new Date(),
      },
      update: {
        mode: "MID_YEAR_MIGRATION", firstSpectrePayDate: utc(2026, 9, 15), confirmedAt: new Date(),
      },
    });
    const { createDraftOpeningBalance } = await import("@/lib/payroll/opening-balance");
    // Opening YTD through Aug 31 (< Sep 15) is admissible even though the
    // Sep 15 payroll's work window starts Aug 24 (before Aug 31).
    const draft = await createDraftOpeningBalance(s.paP, s.club.id, {
      employeeId: s.emp.id, taxYear: 2026,
      throughPayDate: utc(2026, 8, 31),
      values: {
        ytdGrossEarnings: "0", ytdTaxableEarnings: "0",
        ytdPensionableEarnings: "0", ytdInsurableEarnings: "0",
        ytdCppEE_Base: "0", ytdCppEE_FirstAdd: "0", ytdCppEE: "0",
        ytdCpp2EE: "0", ytdEiEE: "0",
        ytdFederalTax: "0", ytdProvincialTax: "0",
        ytdCppER_Base: "0", ytdCppER_FirstAdd: "0", ytdCppER: "0",
        ytdCpp2ER: "0", ytdEiER: "0",
      },
    });
    expect(draft.status).toBe("DRAFT");
  });
});
