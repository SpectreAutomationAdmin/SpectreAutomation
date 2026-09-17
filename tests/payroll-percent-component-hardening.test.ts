// Pre-Phase-5 hardening (2026-09-16) — PERCENT_OF_ELIGIBLE_EARNINGS
// regression. Locks in the corrected calculator behaviour for the
// existing generic PayrollComponent engine.
//
// Fixes the earlier defect where the calculator's `regularEarnings`
// variable only counted DERIVED salary/hourly (via computePeriodSalary
// / computeHourlyRegular). Prepare persists the annualised salary as
// a `PayrollBatchEarning(earningType=SALARY)` row, which set
// `hasExplicitSalary=true` and caused `salaryDerived` to stay at 0.
// The persisted SALARY row landed only in the generic `earningTotals`
// bucket, not in `regularEarnings`. Result: PERCENT ×
// REGULAR_EARNINGS_ONLY resolved to $0 for every salaried employee.
//
// Fix: `regularEarnings` now counts SALARY / REGULAR / OVERTIME
// earning rows too (see src/lib/payroll/earnings-calculator.ts).
//
// Canonical eligible-earnings semantics (documented in the calculator
// header comment):
//   * REGULAR_EARNINGS_ONLY — derived salary/hourly + persisted
//     SALARY / REGULAR / OVERTIME earning rows. Excludes bonuses,
//     commissions, allowances, and component cash-adds.
//   * CASH_EARNINGS         — REGULAR_EARNINGS + non-regular earning
//     rows (BONUS, COMMISSION, etc.) + allowance grosses +
//     INCREASES_NET_PAY component cash-adds.
//
// Rounding: percent components use Decimal.js basis-point math
// (`percentBps / 10000`, then `.times(eligible)`), rounded to cents
// half-up. No binary floating-point payroll math.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "./util/db";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import { upsertPayrollComponent, createRecurringComponentAssignment } from "@/lib/payroll/components-catalogue";
import { writeEncryptedTd1Claims } from "@/lib/hr/td1-secure-write";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { calculatePayrollBatch } from "@/lib/payroll/calculation-execute";
import { seedCanadaAlbertaPackages2026 } from "@/lib/payroll/statutory/seed-ca-ab-2026";
import { declareImplementation } from "@/lib/payroll/implementation-declaration";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function superAdminP() {
  const c = db();
  await c.user.deleteMany({ where: { email: "sup-pct@spectre.test" } });
  const u = await c.user.create({
    data: { email: "sup-pct@spectre.test", name: "SupPct", role: "SUPER_ADMIN", passwordHash: "x", status: "ACTIVE" },
  });
  await c.userClubRole.create({ data: { userId: u.id, clubId: null, roleKey: "SUPER_ADMIN" } });
  return principalFor("sup-pct@spectre.test");
}

async function seedSemiMonthlyCalendar(clubId: string, payGroupId: string) {
  const c = db();
  let seq = 0;
  for (let m = 0; m < 12; m++) {
    seq += 1;
    await c.payrollPayPeriod.create({
      data: {
        clubId, payGroupId, taxYear: 2026, sequenceInYear: seq,
        periodStart: utc(2026, m + 1, 1), periodEnd: utc(2026, m + 1, 16),
        payDate: utc(2026, m + 1, 16), status: "OPEN",
      },
    });
    seq += 1;
    await c.payrollPayPeriod.create({
      data: {
        clubId, payGroupId, taxYear: 2026, sequenceInYear: seq,
        periodStart: utc(2026, m + 1, 16), periodEnd: utc(2026, m + 2, 1),
        payDate: utc(2026, m + 2, 1), status: "OPEN",
      },
    });
  }
}

async function baseline(name: string, annualSalary: string) {
  const sup = await superAdminP();
  try { await seedCanadaAlbertaPackages2026(sup); } catch { /* already installed */ }
  const club = await makeClub(name);
  const admin = await makeUser({ email: `admin.${club.id}@t.test`, role: "CLUB_ADMIN", clubId: club.id });
  const pa    = await makeUser({ email: `pa.${club.id}@t.test`,    role: "PAYROLL_ADMIN", clubId: club.id });
  const ctl   = await makeUser({ email: `ctl.${club.id}@t.test`,   role: "CONTROLLER",    clubId: club.id });
  const adminP = await principalFor(admin.email);
  const paP    = await principalFor(pa.email);
  const controllerP = await principalFor(ctl.email);
  await upsertPayrollClubConfig(adminP, club.id, {
    provinceOfEmployment: "AB", payrollAdminUserId: pa.id, controllerUserId: ctl.id,
  });
  await declareImplementation(paP, club.id, { taxYear: 2026, mode: "ZERO_OPENING_YTD" });

  const c = db();
  const emp = await c.employee.create({
    data: {
      clubId: club.id, firstName: "Pct", lastName: "Emp",
      email: `emp.${club.id}@t.test`, hireDate: utc(2020, 1, 1),
      dateOfBirth: utc(1985, 5, 12),
      status: "ACTIVE", employeeNumber: `E-PCT-${club.id.slice(-4)}`,
      employeeLifecycle: "ACTIVE", compensationType: "SALARY", homeProvince: "AB",
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
  const pg = await c.payrollPayGroup.create({
    data: {
      clubId: club.id, code: "SAL-SM", name: "Salary Semi-Monthly",
      payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 1,
      calendarAnchorDate: utc(2026, 1, 1), active: true,
    },
  });
  await seedSemiMonthlyCalendar(club.id, pg.id);
  await c.payrollPayGroupMember.create({
    data: { clubId: club.id, payGroupId: pg.id, employeeId: emp.id, effectiveFrom: utc(2020, 1, 1) },
  });
  const pp = await c.payrollPayPeriod.findFirstOrThrow({
    where: { clubId: club.id, payGroupId: pg.id, sequenceInYear: 17 },
  });
  return { club, adminP, paP, controllerP, emp, pg, payPeriodId: pp.id };
}

async function makePercentComponent(
  adminP: Awaited<ReturnType<typeof principalFor>>,
  clubId: string,
) {
  return upsertPayrollComponent(adminP, clubId, {
    code: "PCT", displayName: "Generic Percent Deduction",
    category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE",
    cashEffect: "DECREASES_NET_PAY",
    taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
    calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
    eligibleEarningsBase: "REGULAR_EARNINGS_ONLY",
    statutoryTreatmentSource: "CUSTOM_TEST",
    displaySection: "DEDUCTIONS",
  });
}

describe("Pre-Phase-5 · PERCENT_OF_ELIGIBLE_EARNINGS basis-point calculation", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("1% of a $4,000 semi-monthly base = $40.00", async () => {
    // 4000 × 24 = 96,000 annual → 4000/period.
    const s = await baseline("1pct", "96000");
    const comp = await makePercentComponent(s.adminP, s.club.id);
    await createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: s.emp.id, componentId: comp.id,
      percentBps: 100, effectiveFrom: utc(2020, 1, 1),
    });
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.payPeriodId);
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    const snap = await db().payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchId: prep.batchId, componentCode: "PCT" },
    });
    expect(snap.resolvedAmount!.toFixed(2)).toBe("40.00");
    expect(snap.eligibleEarningsAmount!.toFixed(2)).toBe("4000.00");
  });

  it("2.5% of a $4,000 base = $100.00", async () => {
    const s = await baseline("25pct", "96000");
    const comp = await makePercentComponent(s.adminP, s.club.id);
    await createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: s.emp.id, componentId: comp.id,
      percentBps: 250, effectiveFrom: utc(2020, 1, 1),
    });
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.payPeriodId);
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    const snap = await db().payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchId: prep.batchId, componentCode: "PCT" },
    });
    expect(snap.resolvedAmount!.toFixed(2)).toBe("100.00");
  });

  it("5% of a $5,000 base = $250.00 (regression for the $0 defect)", async () => {
    // 5000 × 24 = 120,000 annual → 5,000/period.
    const s = await baseline("5pct", "120000");
    const comp = await makePercentComponent(s.adminP, s.club.id);
    await createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: s.emp.id, componentId: comp.id,
      percentBps: 500, effectiveFrom: utc(2020, 1, 1),
    });
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.payPeriodId);
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    const snap = await db().payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchId: prep.batchId, componentCode: "PCT" },
    });
    expect(snap.resolvedAmount!.toFixed(2)).toBe("250.00");
    expect(snap.eligibleEarningsAmount!.toFixed(2)).toBe("5000.00");
  });

  it("3.33% of a $4,321.10 base = $143.89 (half-up cent rounding)", async () => {
    // 4321.10 × 24 = 103,706.40 annual.
    // 4321.10 × 0.0333 = 143.89263 → 143.89 half-up.
    const s = await baseline("rnd", "103706.40");
    const comp = await makePercentComponent(s.adminP, s.club.id);
    await createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: s.emp.id, componentId: comp.id,
      percentBps: 333, effectiveFrom: utc(2020, 1, 1),
    });
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.payPeriodId);
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    const snap = await db().payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchId: prep.batchId, componentCode: "PCT" },
    });
    // Round-trip via Decimal.js — no floating-point noise.
    expect(snap.resolvedAmount!.toFixed(2)).toBe("143.89");
    expect(snap.eligibleEarningsAmount!.toFixed(2)).toBe("4321.10");
  });

  it("0% resolves to $0.00 (intentional zero-participation case)", async () => {
    const s = await baseline("0pct", "120000");
    const comp = await makePercentComponent(s.adminP, s.club.id);
    await createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: s.emp.id, componentId: comp.id,
      percentBps: 0, effectiveFrom: utc(2020, 1, 1),
    });
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.payPeriodId);
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    const snap = await db().payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchId: prep.batchId, componentCode: "PCT" },
    });
    expect(snap.resolvedAmount!.toFixed(2)).toBe("0.00");
    expect(snap.eligibleEarningsAmount!.toFixed(2)).toBe("5000.00");
  });

  it("frozen resolvedAmount survives live percentBps mutation after Calculate", async () => {
    const s = await baseline("frozen", "120000");
    const comp = await makePercentComponent(s.adminP, s.club.id);
    const assn = await createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: s.emp.id, componentId: comp.id,
      percentBps: 500, effectiveFrom: utc(2020, 1, 1),
    });
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.payPeriodId);
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    const snapBefore = await db().payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchId: prep.batchId, componentCode: "PCT" },
    });
    expect(snapBefore.resolvedAmount!.toFixed(2)).toBe("250.00");
    // Live-edit the assignment's percent AFTER calculate.
    await db().employeeRecurringPayrollComponent.update({
      where: { id: assn.id }, data: { percentBps: 999 },
    });
    // Live-edit the component's eligibleEarningsBase too.
    await db().payrollComponent.update({
      where: { id: comp.id }, data: { eligibleEarningsBase: "CASH_EARNINGS" },
    });
    const snapAfter = await db().payrollBatchComponentSnapshot.findUniqueOrThrow({
      where: { id: snapBefore.id },
    });
    // Frozen — historical batch's snapshot is unchanged.
    expect(snapAfter.resolvedAmount!.toFixed(2)).toBe("250.00");
    expect(snapAfter.eligibleEarningsAmount!.toFixed(2)).toBe("5000.00");
    expect(snapAfter.sourcePercentBps).toBe(500);
    expect(snapAfter.eligibleEarningsBase).toBe("REGULAR_EARNINGS_ONLY");
  });
});
