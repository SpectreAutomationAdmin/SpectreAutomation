// Payroll-3B-5B-2a (2026-08-31) — calculation readiness contract tests.
//
// These tests fix the readiness contract in place so the future
// 3B-5B-2b/2c dollar calculator cannot slip past any of the
// pre-calculation gates. Zero dollar arithmetic is exercised
// here; readiness is a pure assessment.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import { createTimeEntry } from "@/lib/payroll/approved-time";
import {
  approveDepartmentTime,
} from "@/lib/payroll/department-approval";
import { orchestrateDepartmentApprovalTasks } from "@/lib/payroll/orchestration";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { prepareCalculationInput } from "@/lib/payroll/calculation";
import {
  DRAFT_TIME_ENTRIES_PRESENT,
  INVALID_BATCH_LIFECYCLE,
  MISSING_ALLOWANCE_CLASSIFICATION,
  SALARY_PRORATION_POLICY_REQUIRED,
  STATUTORY_PACKAGE_UNRESOLVED,
  UNSUPPORTED_ALLOWANCE_FREQUENCY,
  UNSUPPORTED_EARNING_TYPE,
} from "@/lib/payroll/calculation-blockers";
import { seedCanadaAlbertaPackages2026 } from "@/lib/payroll/statutory/seed-ca-ab-2026";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function superAdminP() {
  const c = db();
  await c.user.deleteMany({ where: { email: "super-2a@spectre.test" } });
  const u = await c.user.create({
    data: {
      email: "super-2a@spectre.test",
      name: "Super2a",
      role: "SUPER_ADMIN",
      passwordHash: "x",
      status: "ACTIVE",
    },
  });
  await c.userClubRole.create({ data: { userId: u.id, clubId: null, roleKey: "SUPER_ADMIN" } });
  return principalFor("super-2a@spectre.test");
}

/**
 * Full scenario: two-department Club with an hourly employee (approved
 * time) and a salaried employee, both members of an active biweekly
 * Pay Group, one pay period ending 2026-08-29 (H2 of the CA/AB 2026
 * package).
 */
async function scenario(opts?: {
  salariedFullPeriod?: boolean;   // when false, salaried employee has partial coverage
}) {
  const salariedFullPeriod = opts?.salariedFullPeriod ?? true;

  // Statutory package (H1 + H2) so resolveStatutoryPackage succeeds.
  const sup = await superAdminP();
  await seedCanadaAlbertaPackages2026(sup);

  const clubA = await makeClub("Club A");
  const clubB = await makeClub("Club B");
  const payrollAdmin = await makeUser({ email: "pa2a@a.test", role: "PAYROLL_ADMIN", clubId: clubA.id });
  const controller = await makeUser({ email: "ctl2a@a.test", role: "CONTROLLER", clubId: clubA.id });
  const clubAdmin = await makeUser({ email: "admin2a@a.test", role: "CLUB_ADMIN", clubId: clubA.id });
  const adminP = await principalFor(clubAdmin.email);
  const payrollAdminP = await principalFor(payrollAdmin.email);

  await upsertPayrollClubConfig(adminP, clubA.id, {
    provinceOfEmployment: "AB",
    payrollAdminUserId: payrollAdmin.id,
    controllerUserId: controller.id,
  });

  const grounds = await db().department.create({
    data: { clubId: clubA.id, code: "GROUNDS", name: "Grounds", sortOrder: 1 },
  });
  const fb = await db().department.create({
    data: { clubId: clubA.id, code: "FB", name: "F&B", sortOrder: 2 },
  });
  const groundsMgrUser = await makeUser({ email: "grounds.mgr2a@a.test", role: "DEPARTMENT_MANAGER", clubId: clubA.id });
  const groundsMgrEmp = await db().employee.create({
    data: {
      clubId: clubA.id, firstName: "Grounds", lastName: "Manager",
      email: groundsMgrUser.email, hireDate: utc(2026, 1, 1),
      dateOfBirth: utc(1990, 5, 12), status: "ACTIVE",
      employeeNumber: "E-MGR-G-2a", userId: groundsMgrUser.id,
    },
  });

  // Hourly employee, full-period.
  const hourlyEmp = await db().employee.create({
    data: {
      clubId: clubA.id, firstName: "Alex", lastName: "Hourly",
      email: "alex.hourly@a.test", hireDate: utc(2026, 1, 1),
      dateOfBirth: utc(1990, 5, 12), status: "ACTIVE",
      employeeNumber: "E-H-1",
    },
  });
  const hourlyAssign = await db().employeeEmploymentAssignment.create({
    data: {
      clubId: clubA.id, employeeId: hourlyEmp.id, role: "PRIMARY",
      departmentId: grounds.id, managerEmployeeId: groundsMgrEmp.id,
      employmentType: "FULL_TIME", effectiveFrom: utc(2026, 1, 1),
    },
  });
  await db().employeeCompensation.create({
    data: {
      clubId: clubA.id, employeeId: hourlyEmp.id, assignmentId: hourlyAssign.id,
      cadence: "HOURLY", rate: "22.50", currency: "CAD",
      effectiveFrom: utc(2026, 1, 1),
    },
  });
  await db().employeeBankAccount.create({
    data: {
      clubId: clubA.id, employeeId: hourlyEmp.id,
      institutionSecretRef: "kms:test", transitSecretRef: "kms:test",
      accountSecretRef: "kms:test", holderName: "Alex Hourly",
      bankFingerprint: "fp-h-1",
      status: "VERIFIED", activatedAt: utc(2026, 1, 1),
    },
  });
  // Federal + Alberta TD1 (BPA only). Sensitive plaintext lives on
  // EmployeeTaxProfile via encrypted secrets — the tests don't need
  // real KMS values.
  await db().employeeTaxProfile.create({
    data: {
      clubId: clubA.id, employeeId: hourlyEmp.id,
      province: "AB", td1FormVersion: "2026-01",
      effectiveFrom: utc(2026, 1, 1),
      federalClaimSecretRef: "kms:test", provincialClaimSecretRef: "kms:test",
    },
  });

  // Salaried employee. Hire date shifts based on the option so we can
  // exercise both full-period and partial-period readiness paths.
  const salaryHireDate = salariedFullPeriod ? utc(2026, 1, 1) : utc(2026, 8, 15);
  const salariedEmp = await db().employee.create({
    data: {
      clubId: clubA.id, firstName: "Sam", lastName: "Salary",
      email: "sam.salary@a.test", hireDate: salaryHireDate,
      dateOfBirth: utc(1990, 5, 12), status: "ACTIVE",
      employeeNumber: "E-S-1",
    },
  });
  const salariedAssign = await db().employeeEmploymentAssignment.create({
    data: {
      clubId: clubA.id, employeeId: salariedEmp.id, role: "PRIMARY",
      departmentId: fb.id, employmentType: "FULL_TIME",
      effectiveFrom: salaryHireDate,
    },
  });
  await db().employeeCompensation.create({
    data: {
      clubId: clubA.id, employeeId: salariedEmp.id, assignmentId: salariedAssign.id,
      cadence: "SALARY", rate: "72000", currency: "CAD",
      effectiveFrom: salaryHireDate,
    },
  });
  await db().employeeBankAccount.create({
    data: {
      clubId: clubA.id, employeeId: salariedEmp.id,
      institutionSecretRef: "kms:test", transitSecretRef: "kms:test",
      accountSecretRef: "kms:test", holderName: "Sam Salary",
      bankFingerprint: "fp-s-1",
      status: "VERIFIED", activatedAt: utc(2026, 1, 1),
    },
  });
  await db().employeeTaxProfile.create({
    data: {
      clubId: clubA.id, employeeId: salariedEmp.id,
      province: "AB", td1FormVersion: "2026-01",
      effectiveFrom: salaryHireDate,
      federalClaimSecretRef: "kms:test", provincialClaimSecretRef: "kms:test",
    },
  });

  const payGroup = await db().payrollPayGroup.create({
    data: {
      clubId: clubA.id, code: "HRLBW-2a", name: "Hourly Biweekly (2a)",
      payFrequency: "BIWEEKLY", payDateOffsetDays: 5,
      calendarAnchorDate: utc(2026, 1, 4),
    },
  });
  const payPeriod = await db().payrollPayPeriod.create({
    data: {
      clubId: clubA.id, payGroupId: payGroup.id,
      sequenceInYear: 17, taxYear: 2026,
      periodStart: utc(2026, 8, 10), periodEnd: utc(2026, 8, 24),
      payDate: utc(2026, 8, 29),
    },
  });
  await db().payrollPayGroupMember.create({
    data: { clubId: clubA.id, payGroupId: payGroup.id, employeeId: hourlyEmp.id, effectiveFrom: utc(2026, 1, 1) },
  });
  // For the partial-period option, salaried employee joins the pay
  // group mid-period (matches the hire-date shift above). This makes
  // the coverage window a strict subset of the pay period.
  await db().payrollPayGroupMember.create({
    data: {
      clubId: clubA.id, payGroupId: payGroup.id, employeeId: salariedEmp.id,
      effectiveFrom: salariedFullPeriod ? utc(2026, 1, 1) : salaryHireDate,
    },
  });

  return {
    clubA, clubB, adminP, payrollAdminP,
    grounds, fb, groundsMgrEmp,
    hourlyEmp, salariedEmp, hourlyAssign, salariedAssign,
    payGroup, payPeriod,
  };
}

async function prepareGoldenBatch(s: Awaited<ReturnType<typeof scenario>>) {
  await createTimeEntry(s.adminP, s.clubA.id, {
    employeeId: s.hourlyEmp.id, employmentAssignmentId: s.hourlyAssign.id,
    workDate: utc(2026, 8, 15), hours: 8,
  });
  await orchestrateDepartmentApprovalTasks(s.adminP, s.clubA.id, s.payPeriod.id);
  await approveDepartmentTime(s.adminP, s.clubA.id, s.payPeriod.id, s.grounds.id);
  return preparePayrollBatch(s.adminP, s.clubA.id, s.payPeriod.id);
}

describe("Payroll-3B-5B-2a — calculation readiness contract", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  // ---- Golden path ------------------------------------------------------

  it("full-period salaried + hourly + resolved package → ready:true, no BLOCKERs, employees[] populated", async () => {
    const s = await scenario({ salariedFullPeriod: true });
    const { batchId } = await prepareGoldenBatch(s);
    const r = await prepareCalculationInput(s.payrollAdminP, s.clubA.id, batchId);

    expect(r.ready).toBe(true);
    expect(r.exceptions.filter((e) => e.severity === "BLOCKER")).toEqual([]);
    expect(r.statutoryPackage).not.toBeNull();
    expect(r.statutoryPackage!.packageVersion).toMatch(/CRA-T4127-12[23]E-CA-AB-2026-H[12]/);
    // Batch payDate is 2026-08-29 → H2 (post July 1).
    expect(r.statutoryPackage!.packageVersion).toContain("H2");
    expect(r.employees.length).toBe(2);
    expect(r.periodsPerYear).toBeGreaterThan(0);
    // Every employee carries a frozen source-facts snapshot, YTD,
    // and pensionable-months factor computed via the structured CPP
    // eligibility service.
    for (const e of r.employees) {
      expect(e.sourceFacts.schemaVersion).toBe(1);
      expect(e.ytd.taxYear).toBe(2026);
      expect(e.pensionableMonths).toBeGreaterThanOrEqual(0);
    }
    // The pre-existing PAYROLL_REVIEW Work Intake task remains OPEN;
    // no PAYROLL_FINAL_APPROVAL exists yet (2c materialises it).
    const finalApprovalTask = await db().workIntakeItem.findFirst({
      where: { clubId: s.clubA.id, workSubtype: "PAYROLL_FINAL_APPROVAL" },
    });
    expect(finalApprovalTask).toBeNull();
  });

  // ---- Batch lifecycle --------------------------------------------------

  it("DRAFT batch is refused with INVALID_BATCH_LIFECYCLE (readiness is not preparation)", async () => {
    const s = await scenario({ salariedFullPeriod: true });
    // Craft a DRAFT batch directly bypassing preparation.
    const b = await db().payrollBatch.create({
      data: { clubId: s.clubA.id, payGroupId: s.payGroup.id, payPeriodId: s.payPeriod.id, status: "DRAFT" },
    });
    const r = await prepareCalculationInput(s.payrollAdminP, s.clubA.id, b.id);
    expect(r.ready).toBe(false);
    expect(r.exceptions).toEqual(expect.arrayContaining([expect.objectContaining({ code: INVALID_BATCH_LIFECYCLE })]));
  });
  it("POSTED batch is refused with INVALID_BATCH_LIFECYCLE (never recalculable)", async () => {
    const s = await scenario({ salariedFullPeriod: true });
    const { batchId } = await prepareGoldenBatch(s);
    await db().payrollBatch.update({ where: { id: batchId }, data: { status: "POSTED" } });
    const r = await prepareCalculationInput(s.payrollAdminP, s.clubA.id, batchId);
    expect(r.ready).toBe(false);
    expect(r.exceptions).toEqual(expect.arrayContaining([expect.objectContaining({ code: INVALID_BATCH_LIFECYCLE })]));
  });

  // ---- Permission + tenant ---------------------------------------------

  it("permission gate — user without payroll:run cannot assess readiness", async () => {
    const s = await scenario({ salariedFullPeriod: true });
    const { batchId } = await prepareGoldenBatch(s);
    const staff = await makeUser({ email: "staff2a@a.test", role: "STAFF", clubId: s.clubA.id });
    const staffP = await principalFor(staff.email);
    await expect(prepareCalculationInput(staffP, s.clubA.id, batchId)).rejects.toThrow();
  });
  it("tenant isolation — Club A user cannot assess readiness for a Club B batch", async () => {
    const s = await scenario({ salariedFullPeriod: true });
    const { batchId } = await prepareGoldenBatch(s);
    // Craft the READ against clubB; the assertion should refuse.
    await expect(prepareCalculationInput(s.payrollAdminP, s.clubB.id, batchId)).rejects.toThrow();
  });

  // ---- Package pinning --------------------------------------------------

  it("missing statutory package → BLOCKER STATUTORY_PACKAGE_UNRESOLVED, ready:false", async () => {
    const s = await scenario({ salariedFullPeriod: true });
    const { batchId } = await prepareGoldenBatch(s);
    // Delete the pinned + resolvable packages for the batch's payDate.
    await db().payrollStatutoryPackage.deleteMany({
      where: { jurisdictionCountry: "CA", jurisdictionProvince: "AB" },
    });
    const r = await prepareCalculationInput(s.payrollAdminP, s.clubA.id, batchId);
    expect(r.ready).toBe(false);
    expect(r.statutoryPackage).toBeNull();
    expect(r.exceptions).toEqual(expect.arrayContaining([expect.objectContaining({ code: STATUTORY_PACKAGE_UNRESOLVED })]));
  });

  // ---- Salaried partial-period BLOCKER (§16) ---------------------------

  it("salaried employee with partial coverage → SALARY_PRORATION_POLICY_REQUIRED BLOCKER (does not silently prorate)", async () => {
    const s = await scenario({ salariedFullPeriod: false }); // mid-period hire
    const { batchId } = await prepareGoldenBatch(s);
    const r = await prepareCalculationInput(s.payrollAdminP, s.clubA.id, batchId);
    expect(r.ready).toBe(false);
    const salaryBlockers = r.exceptions.filter(
      (e) => e.code === SALARY_PRORATION_POLICY_REQUIRED && e.employeeId === s.salariedEmp.id,
    );
    expect(salaryBlockers.length).toBe(1);
    expect(salaryBlockers[0].severity).toBe("BLOCKER");
  });

  // ---- Atomicity (§21) --------------------------------------------------

  it("one employee BLOCKER prevents batch-level ready:true (calculation is batch-atomic)", async () => {
    const s = await scenario({ salariedFullPeriod: false }); // salary blocker present
    const { batchId } = await prepareGoldenBatch(s);
    const r = await prepareCalculationInput(s.payrollAdminP, s.clubA.id, batchId);
    expect(r.ready).toBe(false);
    // The hourly employee's own row is still returned (no BLOCKERs
    // against them), proving partial per-employee input can still be
    // inspected — but the batch as a whole is not ready.
    const hourlyInput = r.employees.find((e) => e.employeeId === s.hourlyEmp.id);
    expect(hourlyInput).toBeDefined();
    expect(hourlyInput!.hasApprovedHours).toBe(true);
  });

  // ---- Frozen source facts (§7) ----------------------------------------

  it("readiness consumes FROZEN source facts — a later HR mutation does NOT leak into the readiness snapshot", async () => {
    const s = await scenario({ salariedFullPeriod: true });
    const { batchId } = await prepareGoldenBatch(s);
    // Mutate the hourly employee's HR compensation AFTER preparation.
    await db().employeeCompensation.updateMany({
      where: { clubId: s.clubA.id, employeeId: s.hourlyEmp.id },
      data: { rate: "999.99" },
    });
    const r = await prepareCalculationInput(s.payrollAdminP, s.clubA.id, batchId);
    const hourly = r.employees.find((e) => e.employeeId === s.hourlyEmp.id);
    expect(hourly).toBeDefined();
    // Frozen snapshot preserves the ORIGINAL rate.
    const comp = hourly!.sourceFacts.compensations.find((c) => c.payType === "HOURLY");
    expect(comp).toBeDefined();
    // Prisma Decimal normalises trailing zeros; compare numerically.
    expect(Number(comp!.hourlyRate)).toBe(22.50);
  });

  // ---- Unsupported allowance frequency + classification (§18) ----------

  it("allowance snapshot with an unsupported frequency → UNSUPPORTED_ALLOWANCE_FREQUENCY BLOCKER", async () => {
    const s = await scenario({ salariedFullPeriod: true });
    const { batchId } = await prepareGoldenBatch(s);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({
      where: { batchId, employeeId: s.hourlyEmp.id },
    });
    // Create the source allowance first, then the snapshot.
    const allow = await db().employeeAllowance.create({
      data: {
        clubId: s.clubA.id, employeeId: s.hourlyEmp.id,
        allowanceType: "TRANSIT", amount: "150.00",
        frequency: "SEMIANNUAL_PROBABLY_A_TYPO",
        taxable: true, pensionable: true, insurable: true,
        effectiveFrom: utc(2026, 1, 1),
      },
    });
    await db().payrollBatchAllowanceSnapshot.create({
      data: {
        clubId: s.clubA.id, batchId, batchEmployeeId: be.id,
        employeeId: s.hourlyEmp.id,
        sourceAllowanceId: allow.id,
        allowanceType: "TRANSIT",
        amount: "150.00", frequency: "SEMIANNUAL_PROBABLY_A_TYPO",
        taxable: true, pensionable: true, insurable: true,
        sourceEffectiveFrom: utc(2026, 1, 1),
      },
    });
    const r = await prepareCalculationInput(s.payrollAdminP, s.clubA.id, batchId);
    expect(r.ready).toBe(false);
    expect(r.exceptions).toEqual(expect.arrayContaining([expect.objectContaining({ code: UNSUPPORTED_ALLOWANCE_FREQUENCY })]));
  });
  it("allowance snapshot with a null classification flag → MISSING_ALLOWANCE_CLASSIFICATION BLOCKER", async () => {
    const s = await scenario({ salariedFullPeriod: true });
    const { batchId } = await prepareGoldenBatch(s);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({
      where: { batchId, employeeId: s.hourlyEmp.id },
    });
    // Ambiguous-classification row: taxable set, but pensionable +
    // insurable left NULL. The current Prisma model permits this
    // shape for legacy backward compatibility; the readiness service
    // MUST refuse rather than inheriting from `taxable`.
    const allow = await db().employeeAllowance.create({
      data: {
        clubId: s.clubA.id, employeeId: s.hourlyEmp.id,
        allowanceType: "TRANSIT", amount: "100.00",
        frequency: "MONTHLY",
        taxable: true, pensionable: null, insurable: null,
        effectiveFrom: utc(2026, 1, 1),
      },
    });
    await db().payrollBatchAllowanceSnapshot.create({
      data: {
        clubId: s.clubA.id, batchId, batchEmployeeId: be.id,
        employeeId: s.hourlyEmp.id,
        sourceAllowanceId: allow.id,
        allowanceType: "TRANSIT",
        amount: "100.00", frequency: "MONTHLY",
        taxable: true, pensionable: null, insurable: null,
        sourceEffectiveFrom: utc(2026, 1, 1),
      },
    });
    const r = await prepareCalculationInput(s.payrollAdminP, s.clubA.id, batchId);
    expect(r.ready).toBe(false);
    expect(r.exceptions).toEqual(expect.arrayContaining([expect.objectContaining({ code: MISSING_ALLOWANCE_CLASSIFICATION })]));
  });

  // ---- Unsupported earning types (§19) --------------------------------

  it("earning snapshot with an unsupported earningType (BONUS) → UNSUPPORTED_EARNING_TYPE BLOCKER (never silent regular)", async () => {
    const s = await scenario({ salariedFullPeriod: true });
    const { batchId } = await prepareGoldenBatch(s);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({
      where: { batchId, employeeId: s.hourlyEmp.id },
    });
    await db().payrollBatchEarning.create({
      data: {
        clubId: s.clubA.id, batchId, batchEmployeeId: be.id,
        employeeId: s.hourlyEmp.id,
        earningType: "BONUS",
        quantity: "1.0000", rate: "500.00", rateSource: "MANUAL",
      },
    });
    const r = await prepareCalculationInput(s.payrollAdminP, s.clubA.id, batchId);
    expect(r.ready).toBe(false);
    expect(r.exceptions).toEqual(expect.arrayContaining([expect.objectContaining({ code: UNSUPPORTED_EARNING_TYPE })]));
  });

  // ---- Recalculation contract — no CALCULATED transition in 2a --------

  it("readiness NEVER transitions the batch out of PREPARED", async () => {
    const s = await scenario({ salariedFullPeriod: true });
    const { batchId } = await prepareGoldenBatch(s);
    await prepareCalculationInput(s.payrollAdminP, s.clubA.id, batchId);
    const after = await db().payrollBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(after.status).toBe("PREPARED");
    expect(after.calculatedAt).toBeNull();
    expect(after.calculationVersion).toBe(0);
  });
  it("readiness is a pure assessment — repeated calls do NOT accumulate exception rows in the DB", async () => {
    const s = await scenario({ salariedFullPeriod: false });
    const { batchId } = await prepareGoldenBatch(s);
    const before = await db().payrollBatchException.count({ where: { batchId } });
    await prepareCalculationInput(s.payrollAdminP, s.clubA.id, batchId);
    await prepareCalculationInput(s.payrollAdminP, s.clubA.id, batchId);
    await prepareCalculationInput(s.payrollAdminP, s.clubA.id, batchId);
    const after = await db().payrollBatchException.count({ where: { batchId } });
    expect(after).toBe(before); // readiness never writes exception rows
  });

  // ---- Discoverability — audit event is emitted -----------------------

  it("assess-readiness emits a `payroll.batch.assess-readiness` audit row", async () => {
    const s = await scenario({ salariedFullPeriod: true });
    const { batchId } = await prepareGoldenBatch(s);
    await prepareCalculationInput(s.payrollAdminP, s.clubA.id, batchId);
    const logs = await db().auditLog.findMany({
      where: { entityId: batchId, entityType: "PayrollBatch", action: "payroll.batch.assess-readiness" },
    });
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// §10 — Full POSTED YTD vector regression. Tests insert canonical
// result values directly into PayrollBatchEmployee (no calculator
// invocation) and prove the aggregator reads every field.
// ---------------------------------------------------------------------------
describe("Payroll-3B-5B-2a — full POSTED YTD vector aggregation (§10)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("every YTD category persisted on a POSTED batch flows through getEmployeePayrollYtd", async () => {
    const { getEmployeePayrollYtd } = await import("@/lib/payroll/ytd");
    const s = await scenario({ salariedFullPeriod: true });

    const pg = s.payGroup;
    const pp = await db().payrollPayPeriod.create({
      data: {
        clubId: s.clubA.id, payGroupId: pg.id,
        sequenceInYear: 3, taxYear: 2026,
        periodStart: utc(2026, 2, 1), periodEnd: utc(2026, 2, 14),
        payDate: utc(2026, 2, 20),
      },
    });
    const batch = await db().payrollBatch.create({
      data: { clubId: s.clubA.id, payGroupId: pg.id, payPeriodId: pp.id, sequence: 2, status: "POSTED" },
    });
    await db().payrollBatchEmployee.create({
      data: {
        clubId: s.clubA.id, batchId: batch.id, employeeId: s.hourlyEmp.id,
        jurisdictionCountry: "CA", jurisdictionProvince: "AB",
        employeeLifecycleAtPrep: "ACTIVE",
        // Full result vector persisted directly (no calculator run).
        grossPay:                "2000.00",
        earningsTaxable:         "1981.35",
        earningsPensionable:     "2000.00",
        earningsInsurable:       "2000.00",
        deductionCppEeBase:       "92.34",
        deductionCppEeFirstAdd:   "18.65",
        deductionCppEeCombined:  "110.99",
        deductionCpp2Ee:           "0.00",
        deductionEiEe:            "32.60",
        deductionFederalTax:     "163.23",
        deductionProvincialTax:   "78.45",
        employerCppBase:          "92.34",
        employerCppFirstAdd:      "18.65",
        employerCppCombined:     "110.99",
        employerCpp2:              "0.00",
        employerEi:               "45.64",
        netPay:                 "1614.73",
      },
    });

    const ytd = await getEmployeePayrollYtd(s.clubA.id, s.hourlyEmp.id, utc(2026, 3, 1));
    expect(Number(ytd.ytdGrossEarnings)).toBe(2000.00);
    expect(Number(ytd.ytdTaxableEarnings)).toBe(1981.35);
    expect(Number(ytd.ytdPensionableEarnings)).toBe(2000.00);
    expect(Number(ytd.ytdInsurableEarnings)).toBe(2000.00);
    expect(Number(ytd.ytdCppEE_Base)).toBe(92.34);
    expect(Number(ytd.ytdCppEE_FirstAdd)).toBe(18.65);
    expect(Number(ytd.ytdCppEE)).toBe(110.99);
    expect(Number(ytd.ytdCpp2EE)).toBe(0);
    expect(Number(ytd.ytdEiEE)).toBe(32.60);
    expect(Number(ytd.ytdFederalTax)).toBe(163.23);
    expect(Number(ytd.ytdProvincialTax)).toBe(78.45);
    expect(Number(ytd.ytdCppER_Base)).toBe(92.34);
    expect(Number(ytd.ytdCppER_FirstAdd)).toBe(18.65);
    expect(Number(ytd.ytdCppER)).toBe(110.99);
    expect(Number(ytd.ytdCpp2ER)).toBe(0);
    expect(Number(ytd.ytdEiER)).toBe(45.64);
  });
});

// ---------------------------------------------------------------------------
// Additional-tax representation (§11) — kept SEPARATE from base
// statutory tax in the persisted result contract, matching PDOC
// Scenario 3.
// ---------------------------------------------------------------------------
describe("Payroll-3B-5B-2a — additional-tax persistence contract (§11)", () => {
  it("PayrollBatchEmployee model exposes additionalFederalTax / additionalProvincialTax as distinct Decimal columns", async () => {
    // Compile-time proof lives in src/lib/payroll/calculation.ts; runtime
    // proof: the columns accept a Decimal write independently of the
    // base statutory tax fields.
    const club = await makeClub("Club Add-Tax");
    const admin = await makeUser({ email: "admin.addtax@a.test", role: "CLUB_ADMIN", clubId: club.id });
    await upsertPayrollClubConfig(await principalFor(admin.email), club.id, {
      provinceOfEmployment: "AB",
      payrollAdminUserId: admin.id,
    });
    const emp = await db().employee.create({
      data: { clubId: club.id, firstName: "T", lastName: "T", email: "t@t.a.test", hireDate: utc(2026, 1, 1), status: "ACTIVE", employeeNumber: "E-T-1" },
    });
    const pg = await db().payrollPayGroup.create({ data: { clubId: club.id, code: "PG-AT", name: "PG-AT", payFrequency: "BIWEEKLY", payDateOffsetDays: 5 } });
    const pp = await db().payrollPayPeriod.create({
      data: { clubId: club.id, payGroupId: pg.id, sequenceInYear: 1, taxYear: 2026, periodStart: utc(2026, 1, 1), periodEnd: utc(2026, 1, 14), payDate: utc(2026, 1, 20) },
    });
    const batch = await db().payrollBatch.create({
      data: { clubId: club.id, payGroupId: pg.id, payPeriodId: pp.id, status: "POSTED" },
    });
    const be = await db().payrollBatchEmployee.create({
      data: {
        clubId: club.id, batchId: batch.id, employeeId: emp.id,
        jurisdictionCountry: "CA", jurisdictionProvince: "AB",
        employeeLifecycleAtPrep: "ACTIVE",
        deductionFederalTax:    "163.23",  // base statutory
        additionalFederalTax:    "50.00",  // TD1 additional — SEPARATE
        deductionProvincialTax:  "78.45",
        additionalProvincialTax: "25.00",
      },
    });
    const round = await db().payrollBatchEmployee.findUniqueOrThrow({ where: { id: be.id } });
    expect(Number(round.deductionFederalTax)).toBe(163.23);
    expect(Number(round.additionalFederalTax)).toBe(50.00);
    expect(Number(round.deductionProvincialTax)).toBe(78.45);
    expect(Number(round.additionalProvincialTax)).toBe(25.00);
  });
});
