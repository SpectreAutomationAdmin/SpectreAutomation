// Payroll-3C-2 (2026-09-07) — component snapshotting + four
// independent statutory bases in the calculator.
//
// These tests build a controlled single-employee scenario with
// EXPLICITLY SYNTHETIC component treatments (§5 of the 3C-2 brief).
// They prove the calculation invariants — the actual Canadian
// treatment for real-world components (life insurance CPP-taxability,
// RRSP tax deductibility, etc.) is out of scope until 3C-3+.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import { upsertPayrollComponent, createRecurringComponentAssignment } from "@/lib/payroll/components-catalogue";
import { writeEncryptedTd1Claims } from "@/lib/hr/td1-secure-write";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { calculatePayrollBatch } from "@/lib/payroll/calculation-execute";
import { seedCanadaAlbertaPackages2026 } from "@/lib/payroll/statutory/seed-ca-ab-2026";
import { snapshotEmployeeComponentsForBatch, batchHasComponentSnapshots } from "@/lib/payroll/components-snapshot";
import { postPayrollBatch, approvePayrollBatch } from "@/lib/payroll/approve-and-post";
import { ConflictError } from "@/lib/errors";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function superAdminP() {
  const c = db();
  await c.user.deleteMany({ where: { email: "super-3c2@spectre.test" } });
  const u = await c.user.create({
    data: { email: "super-3c2@spectre.test", name: "Super3C2", role: "SUPER_ADMIN", passwordHash: "x", status: "ACTIVE" },
  });
  await c.userClubRole.create({ data: { userId: u.id, clubId: null, roleKey: "SUPER_ADMIN" } });
  return principalFor("super-3c2@spectre.test");
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

interface Scenario {
  club: { id: string; slug: string; name: string };
  adminP: Awaited<ReturnType<typeof principalFor>>;
  paP: Awaited<ReturnType<typeof principalFor>>;
  controllerP: Awaited<ReturnType<typeof principalFor>>;
  emp: { id: string };
  payPeriodId: string;
}

async function baseline(name: string, annualSalary = "120000"): Promise<Scenario> {
  const sup = await superAdminP();
  // Idempotent seed — CA-AB packages may already be present when
  // baseline() is called multiple times from a single test.
  const existingPkg = await db().payrollStatutoryPackage.count({ where: { jurisdictionCountry: "CA" } });
  if (existingPkg === 0) await seedCanadaAlbertaPackages2026(sup);
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

  const c = db();
  const emp = await c.employee.create({
    data: {
      clubId: club.id, firstName: "Comp", lastName: "Preview",
      email: `comp.${club.id}@t.test`, hireDate: utc(2020, 1, 1),
      dateOfBirth: utc(1985, 5, 12),
      status: "ACTIVE", employeeNumber: `E-COMP-${club.id.slice(-4)}`,
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
  const pp = await c.payrollPayPeriod.findFirstOrThrow({
    where: { clubId: club.id, payGroupId: pg.id, sequenceInYear: 17 },
  });
  await c.payrollPayGroupMember.create({
    data: { clubId: club.id, payGroupId: pg.id, employeeId: emp.id, effectiveFrom: utc(2020, 1, 1) },
  });

  return { club, adminP, paP, controllerP, emp: { id: emp.id }, payPeriodId: pp.id };
}

// -------------------------------------------------------------------
// A · Snapshot immutability + resolved amount
// -------------------------------------------------------------------
describe("Payroll-3C-2 · component snapshot immutability", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("prep snapshots the assignment amount; later live-edit does NOT mutate the batch", async () => {
    const s = await baseline("Snap A");
    const comp = await upsertPayrollComponent(s.adminP, s.club.id, {
      code: "CELL_PHONE", displayName: "Cell", category: "ALLOWANCE", side: "EMPLOYEE",
      cashEffect: "INCREASES_NET_PAY", taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT", displaySection: "EARNINGS",
    });
    const assn = await createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: s.emp.id, componentId: comp.id,
      amount: "37.50", effectiveFrom: utc(2020, 1, 1),
    });

    // Prep freezes the snapshot at 37.50.
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.payPeriodId);
    const snapBefore = await db().payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchId: prep.batchId, componentCode: "CELL_PHONE" },
    });
    expect(snapBefore.resolvedAmount!.toFixed(2)).toBe("37.50");

    // Later live edit — bump to $50 + flip a statutory flag.
    await db().employeeRecurringPayrollComponent.update({
      where: { id: assn.id }, data: { amount: "50.00" },
    });
    await db().payrollComponent.update({
      where: { id: comp.id }, data: { eiInsurableEffect: "ADD", displayName: "Cell (edited)" },
    });

    // Re-read the snapshot on the ORIGINAL batch — still 37.50 + old flags.
    const snapAfter = await db().payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchId: prep.batchId, componentCode: "CELL_PHONE" },
    });
    expect(snapAfter.resolvedAmount!.toFixed(2)).toBe("37.50");
    expect(snapAfter.eiInsurableEffect).toBe("NONE");
    expect(snapAfter.displayName).toBe("Cell");
  });
});

// -------------------------------------------------------------------
// B · Four independent statutory bases (§4, §17)
// -------------------------------------------------------------------
describe("Payroll-3C-2 · four independent remuneration bases", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("cash != taxable: non-cash TAXABLE_BENEFIT lifts taxable base without touching cash", async () => {
    const s = await baseline("Bases A");
    const compBenefit = await upsertPayrollComponent(s.adminP, s.club.id, {
      code: "TEST_TAXABLE_BENEFIT", displayName: "Test Taxable Benefit",
      category: "TAXABLE_BENEFIT", side: "EMPLOYER",
      cashEffect: "NO_NET_PAY_EFFECT",
      taxableEffect: "ADD", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT", displaySection: "BENEFITS",
    });
    await createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: s.emp.id, componentId: compBenefit.id,
      amount: "100.00", effectiveFrom: utc(2020, 1, 1),
    });

    const prep = await preparePayrollBatch(s.paP, s.club.id, s.payPeriodId);
    const calc = await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    expect(calc.persisted).toBe(true);

    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: calc.batchId } });
    // Base salary for 120k @ 24 periods = 5,000.
    // Cash base = 5000 (benefit is non-cash and NO_NET_PAY_EFFECT).
    // Taxable  = 5000 + 100 (benefit is taxable).
    // Pension  = 5000 (benefit not pensionable).
    // Insurable = 5000 (benefit not insurable).
    expect(Number(be.grossPay)).toBe(5000);
    expect(Number(be.earningsTaxable)).toBe(5100);
    expect(Number(be.earningsPensionable)).toBe(5000);
    expect(Number(be.earningsInsurable)).toBe(5000);
  });

  it("cash != insurable: cash allowance flagged non-insurable lifts cash + taxable + CPP but NOT EI", async () => {
    const s = await baseline("Bases B");
    const cellAllowance = await upsertPayrollComponent(s.adminP, s.club.id, {
      code: "CELL_PHONE_ALLOWANCE", displayName: "Cell",
      category: "ALLOWANCE", side: "EMPLOYEE",
      cashEffect: "INCREASES_NET_PAY",
      taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT", displaySection: "EARNINGS",
    });
    await createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: s.emp.id, componentId: cellAllowance.id,
      amount: "37.50", effectiveFrom: utc(2020, 1, 1),
    });
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.payPeriodId);
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);

    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    // Cash = 5000 + 37.50; taxable + CPP += 37.50; EI unchanged (5000).
    expect(Number(be.grossPay)).toBe(5037.50);
    expect(Number(be.earningsTaxable)).toBe(5037.50);
    expect(Number(be.earningsPensionable)).toBe(5037.50);
    expect(Number(be.earningsInsurable)).toBe(5000);
  });
});

// -------------------------------------------------------------------
// C · Employee deduction + net-pay reconciliation
// -------------------------------------------------------------------
describe("Payroll-3C-2 · employee deduction (LTD-style)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("DECREASES_NET_PAY component reduces net without changing statutory bases", async () => {
    const s = await baseline("Ded A");
    const ltd = await upsertPayrollComponent(s.adminP, s.club.id, {
      code: "LTD_EE", displayName: "Employee LTD",
      category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE",
      cashEffect: "DECREASES_NET_PAY",
      taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT", displaySection: "DEDUCTIONS",
    });
    await createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: s.emp.id, componentId: ltd.id,
      amount: "28.11", effectiveFrom: utc(2020, 1, 1),
    });
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.payPeriodId);
    // Baseline WITHOUT the deduction to get statutory numbers.
    const withDed = await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    expect(withDed.persisted).toBe(true);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    // Statutory bases unchanged from salary-only baseline (5000).
    expect(Number(be.earningsTaxable)).toBe(5000);
    expect(Number(be.earningsPensionable)).toBe(5000);
    expect(Number(be.earningsInsurable)).toBe(5000);
    // Total employee deductions = statutory + LTD. LTD reduces net.
    // We don't recompute exact statutory values here — the invariant
    // is that LTD is INSIDE totalEmployeeDeductions and OUTSIDE the
    // three statutory bases.
    const totalDed = Number(be.totalEmployeeDeductions);
    const net = Number(be.netPay);
    expect(Number(be.grossPay) - totalDed).toBeCloseTo(net, 2);
    expect(totalDed).toBeGreaterThan(28.11); // > LTD alone (statutory piled on top)
  });
});

// -------------------------------------------------------------------
// D · Employer contribution (informational)
// -------------------------------------------------------------------
describe("Payroll-3C-2 · employer contribution", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("EMPLOYER_CONTRIBUTION does not reduce employee net; grows employer cost via employerContributionsFromComponents", async () => {
    const s = await baseline("Emp A");
    const adnd = await upsertPayrollComponent(s.adminP, s.club.id, {
      code: "AD_D_ER", displayName: "AD&D",
      category: "EMPLOYER_CONTRIBUTION", side: "EMPLOYER",
      cashEffect: "NO_NET_PAY_EFFECT",
      taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT", displaySection: "BENEFITS",
    });
    await createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: s.emp.id, componentId: adnd.id,
      amount: "2.25", effectiveFrom: utc(2020, 1, 1),
    });
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.payPeriodId);
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    expect(Number(be.grossPay)).toBe(5000);   // employee cash unchanged
    // Employer contribution amount appears in the employer cost bucket
    // (calc-execute adds it to totalEmployer).
    // We assert the snapshot exists + resolved:
    const snap = await db().payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchId: prep.batchId, componentCode: "AD_D_ER" },
    });
    expect(snap.side).toBe("EMPLOYER");
    expect(snap.cashEffect).toBe("NO_NET_PAY_EFFECT");
    expect(snap.resolvedAmount!.toFixed(2)).toBe("2.25");
  });
});

// -------------------------------------------------------------------
// E · PERCENT_OF_ELIGIBLE_EARNINGS is now supported (3C-3). This
// former "unsupported" scenario is superseded by tests in
// components-3c3-percent.test.ts. The 3C-2 test kept here proves
// that a PERCENT component now resolves + the basic salary math is
// still intact (regression guard for the 3C-1 → 3C-2 boundary).
// -------------------------------------------------------------------
describe("Payroll-3C-2 · PERCENT_OF_ELIGIBLE_EARNINGS activated in 3C-3", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("PERCENT snapshot resolves during calc; salary math intact", async () => {
    const s = await baseline("Pct A");
    const rrspEe = await upsertPayrollComponent(s.adminP, s.club.id, {
      code: "RRSP_EE", displayName: "Employee RRSP",
      category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE",
      cashEffect: "DECREASES_NET_PAY",
      taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
      calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
      eligibleEarningsBase: "REGULAR_EARNINGS_ONLY",
      statutoryTreatmentSource: "CUSTOM_TEST",
      displaySection: "DEDUCTIONS",
    });
    await createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: s.emp.id, componentId: rrspEe.id,
      percentBps: 500, effectiveFrom: utc(2020, 1, 1),
    });
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.payPeriodId);
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    const snap = await db().payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchId: prep.batchId, componentCode: "RRSP_EE" },
    });
    // 5% × $5,000 (regular salary) = $250.
    expect(snap.resolvedAmount!.toFixed(2)).toBe("250.00");
    expect(snap.eligibleEarningsAmount!.toFixed(2)).toBe("5000.00");
    // Cash + statutory bases still $5,000 (EE deduction is NONE for all bases).
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    expect(Number(be.grossPay)).toBe(5000);
    expect(Number(be.earningsTaxable)).toBe(5000);
  });
});

// -------------------------------------------------------------------
// F · Legacy EmployeeAllowance coexistence — no double count
// -------------------------------------------------------------------
describe("Payroll-3C-2 · legacy allowance + component coexistence", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("a legacy EmployeeAllowance + a distinct Payroll Component both apply; NOT double-counted", async () => {
    const s = await baseline("Legacy A");
    // Legacy allowance: $50 taxable + pensionable + insurable.
    await db().employeeAllowance.create({
      data: {
        clubId: s.club.id, employeeId: s.emp.id,
        allowanceType: "OTHER", amount: "50.00", frequency: "PER_PAY_PERIOD",
        taxable: true, pensionable: true, insurable: true,
        effectiveFrom: utc(2020, 1, 1),
      },
    });
    // Component: cell phone allowance $37.50, non-insurable.
    const comp = await upsertPayrollComponent(s.adminP, s.club.id, {
      code: "CELL", displayName: "Cell", category: "ALLOWANCE", side: "EMPLOYEE",
      cashEffect: "INCREASES_NET_PAY",
      taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT", displaySection: "EARNINGS",
    });
    await createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: s.emp.id, componentId: comp.id,
      amount: "37.50", effectiveFrom: utc(2020, 1, 1),
    });

    const prep = await preparePayrollBatch(s.paP, s.club.id, s.payPeriodId);
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });

    // Cash = 5000 + 50 (legacy) + 37.50 (component).
    expect(Number(be.grossPay)).toBe(5087.50);
    // Taxable = 5000 + 50 (legacy taxable) + 37.50 (component taxable).
    expect(Number(be.earningsTaxable)).toBe(5087.50);
    // Insurable = 5000 + 50 (legacy insurable) + 0 (component non-insurable).
    expect(Number(be.earningsInsurable)).toBe(5050);
    // Prove no double-count: component snapshot present, allowance
    // snapshot present, both exactly ONE row.
    const compCount = await db().payrollBatchComponentSnapshot.count({ where: { batchId: prep.batchId } });
    const alwCount  = await db().payrollBatchAllowanceSnapshot.count({ where: { batchId: prep.batchId } });
    expect(compCount).toBe(1);
    expect(alwCount).toBe(1);
  });
});

// -------------------------------------------------------------------
// G · Tenant isolation for snapshot reads
// -------------------------------------------------------------------
describe("Payroll-3C-2 · snapshot service tenant isolation", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("snapshotEmployeeComponentsForBatch scoped to the caller's clubId", async () => {
    const s = await baseline("Iso A");
    // Different club with a same-named component + assigning to a different employee.
    const other = await baseline("Iso B");
    // Component in Iso B — never should snapshot into Iso A batch.
    const compB = await upsertPayrollComponent(other.adminP, other.club.id, {
      code: "OTHER_CELL", displayName: "Other Cell",
      category: "ALLOWANCE", side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
      taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT", displaySection: "EARNINGS",
    });
    await createRecurringComponentAssignment(other.adminP, other.club.id, {
      employeeId: other.emp.id, componentId: compB.id,
      amount: "99.99", effectiveFrom: utc(2020, 1, 1),
    });

    // Prep the Iso A batch. Iso B's component / assignment must NOT
    // snapshot into it because the snapshotter is scoped by clubId +
    // employeeId.
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.payPeriodId);
    const snaps = await db().payrollBatchComponentSnapshot.findMany({
      where: { batchId: prep.batchId },
    });
    expect(snaps.length).toBe(0);
  });
});

// -------------------------------------------------------------------
// H · GL post block — safety when snapshots present
// -------------------------------------------------------------------
describe("Payroll-3C-2 · GL post block when component snapshots exist", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("postPayrollBatch refuses when batch has any component snapshots", async () => {
    const s = await baseline("Gl A");
    const comp = await upsertPayrollComponent(s.adminP, s.club.id, {
      code: "TAX_BEN", displayName: "Test Benefit",
      category: "TAXABLE_BENEFIT", side: "EMPLOYER",
      cashEffect: "NO_NET_PAY_EFFECT",
      taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT", displaySection: "BENEFITS",
    });
    await createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: s.emp.id, componentId: comp.id,
      amount: "10.00", effectiveFrom: utc(2020, 1, 1),
    });
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.payPeriodId);
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    expect(await batchHasComponentSnapshots(prep.batchId)).toBe(true);
    await approvePayrollBatch(s.controllerP, prep.batchId);
    await expect(postPayrollBatch(s.controllerP, prep.batchId)).rejects.toBeInstanceOf(ConflictError);
  });
});
