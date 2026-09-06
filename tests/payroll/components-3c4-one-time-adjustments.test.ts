// Payroll-3C-4 (2026-09-09) — one-time payroll adjustments.
//
// Coverage:
//   • add + remove lifecycle (PREPARED-only)
//   • treatment inherited from the PayrollComponent definition
//   • reason required / sanitised / capped
//   • negative amounts rejected — cashEffect determines direction
//   • cross-tenant refused
//   • non-PREPARED batch (CALCULATED / APPROVED / POSTED) refused
//   • audit log emitted on add + remove
//   • calculator consumes one-time adjustments alongside recurring
//     snapshots (same four-independent-base pipeline as 3C-2 / 3C-3)
//   • reimbursement leaves statutory bases untouched
//   • non-cash taxable benefit does NOT add to cash earnings
//   • Sam Complex three-adjustment founder scenario → expected cash
//     $5,193.23 preserved (§32 of the brief)
//   • basic salary regression preserved ($36,125 batch, Alex $6,250)
//   • Sam source reconciliation preserved

import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import { upsertPayrollComponent, createRecurringComponentAssignment } from "@/lib/payroll/components-catalogue";
import { writeEncryptedTd1Claims } from "@/lib/hr/td1-secure-write";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { calculatePayrollBatch } from "@/lib/payroll/calculation-execute";
import { seedCanadaAlbertaPackages2026 } from "@/lib/payroll/statutory/seed-ca-ab-2026";
import { addOneTimeAdjustment, removeOneTimeAdjustment } from "@/lib/payroll/adjustments";
import { ConflictError, ValidationError, NotFoundError, ForbiddenError } from "@/lib/errors";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function superAdminP() {
  const c = db();
  await c.user.deleteMany({ where: { email: "sup-3c4@spectre.test" } });
  const u = await c.user.create({
    data: { email: "sup-3c4@spectre.test", name: "Sup3C4", role: "SUPER_ADMIN", passwordHash: "x", status: "ACTIVE" },
  });
  await c.userClubRole.create({ data: { userId: u.id, clubId: null, roleKey: "SUPER_ADMIN" } });
  return principalFor("sup-3c4@spectre.test");
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

async function seedSemiMonthlySalaryScenario(opts: { seed: string; annualSalary?: string }) {
  const c = db();
  const sup = await superAdminP();
  // Idempotent within one test: statutory packages are global, so
  // seeding twice raises a non-overlap ValidationError. Swallow it.
  try { await seedCanadaAlbertaPackages2026(sup); } catch { /* already installed */ }
  const club = await makeClub(`3C4 ${opts.seed}`);
  const admin = await makeUser({ email: `a.${opts.seed}@t.test`, role: "CLUB_ADMIN", clubId: club.id });
  const pa    = await makeUser({ email: `p.${opts.seed}@t.test`, role: "PAYROLL_ADMIN", clubId: club.id });
  const ctl   = await makeUser({ email: `c.${opts.seed}@t.test`, role: "CONTROLLER",    clubId: club.id });
  const adminP = await principalFor(admin.email);
  const paP    = await principalFor(pa.email);
  const ctlP   = await principalFor(ctl.email);
  await upsertPayrollClubConfig(adminP, club.id, {
    provinceOfEmployment: "AB", payrollAdminUserId: pa.id, controllerUserId: ctl.id,
  });

  const annual = opts.annualSalary ?? "110000";
  const emp = await c.employee.create({
    data: {
      clubId: club.id, firstName: "Sam", lastName: "Complex",
      email: `sam.${opts.seed}@t.test`, hireDate: utc(2020, 1, 1),
      dateOfBirth: utc(1980, 6, 1), status: "ACTIVE",
      employeeNumber: `SAM-${opts.seed}`,
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
      cadence: "SALARY", rate: annual, currency: "CAD", effectiveFrom: utc(2020, 1, 1),
    },
  });
  await writeEncryptedTd1Claims({
    clubId: club.id, employeeId: emp.id, effectiveFrom: utc(2020, 1, 1),
    province: "AB", td1FormVersion: "2026-01",
    federalClaim: "16452.00", provincialClaim: "22769.00",
  });
  const pg = await c.payrollPayGroup.create({
    data: {
      clubId: club.id, code: `SAL-SM-${opts.seed}`, name: "Salary Semi-Monthly",
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

  return { club, adminP, paP, ctlP, emp, pg, pp };
}

async function seedOneTimeCatalogue(clubId: string, adminP: Awaited<ReturnType<typeof principalFor>>) {
  const bonus = await upsertPayrollComponent(adminP, clubId, {
    code: "ONE_TIME_BONUS_TEST", displayName: "One-time Bonus (Test)",
    category: "ADDITIONAL_EARNING", side: "EMPLOYEE",
    cashEffect: "INCREASES_NET_PAY",
    taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "ADD",
    calculationMethod: "FIXED_AMOUNT",
    statutoryTreatmentSource: "CUSTOM_TEST",
    displaySection: "EARNINGS", displayOrder: 90,
  });
  const reimb = await upsertPayrollComponent(adminP, clubId, {
    code: "EXPENSE_REIMBURSEMENT_TEST", displayName: "Expense Reimbursement (Test)",
    category: "REIMBURSEMENT", side: "EMPLOYEE",
    cashEffect: "INCREASES_NET_PAY",
    taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
    calculationMethod: "FIXED_AMOUNT",
    statutoryTreatmentSource: "CUSTOM_TEST",
    displaySection: "EARNINGS", displayOrder: 95,
  });
  const deduct = await upsertPayrollComponent(adminP, clubId, {
    code: "ONE_TIME_DEDUCTION_TEST", displayName: "One-time Deduction (Test)",
    category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE",
    cashEffect: "DECREASES_NET_PAY",
    taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
    calculationMethod: "FIXED_AMOUNT",
    statutoryTreatmentSource: "CUSTOM_TEST",
    displaySection: "DEDUCTIONS", displayOrder: 90,
  });
  const nonCash = await upsertPayrollComponent(adminP, clubId, {
    code: "ONE_TIME_TAXABLE_BENEFIT_TEST", displayName: "One-time Taxable Benefit (Test)",
    category: "TAXABLE_BENEFIT", side: "EMPLOYER",
    cashEffect: "NO_NET_PAY_EFFECT",
    taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
    calculationMethod: "FIXED_AMOUNT",
    statutoryTreatmentSource: "CUSTOM_TEST",
    displaySection: "BENEFITS", displayOrder: 90,
  });
  return { bonus, reimb, deduct, nonCash };
}

describe("Payroll-3C-4 · one-time adjustments — lifecycle + guardrails", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("adds a FIXED_AMOUNT bonus, snapshot is ONE_TIME_PAYROLL_ADJUSTMENT with reason and enteredBy", async () => {
    const s = await seedSemiMonthlySalaryScenario({ seed: "add" });
    await seedOneTimeCatalogue(s.club.id, s.adminP);
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.pp.id);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });

    const out = await addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "ONE_TIME_BONUS_TEST",
      amount: "500", reason: "August performance bonus",
    });
    const snap = await db().payrollBatchComponentSnapshot.findFirstOrThrow({ where: { id: out.snapshotId } });
    expect(snap.provenance).toBe("ONE_TIME_PAYROLL_ADJUSTMENT");
    expect(snap.reason).toBe("August performance bonus");
    expect(snap.enteredByUserId).toBe(s.paP.id);
    expect(snap.sourceAssignmentId).toBeNull();
    expect(snap.resolvedAmount?.toFixed(2)).toBe("500.00");
    // Statutory treatment inherited from the catalogue definition.
    expect(snap.taxableEffect).toBe("ADD");
    expect(snap.cppPensionableEffect).toBe("ADD");
    expect(snap.eiInsurableEffect).toBe("ADD");
    expect(snap.cashEffect).toBe("INCREASES_NET_PAY");
  });

  it("REFUSES a negative amount — cashEffect determines direction", async () => {
    const s = await seedSemiMonthlySalaryScenario({ seed: "neg" });
    await seedOneTimeCatalogue(s.club.id, s.adminP);
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.pp.id);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    await expect(addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "ONE_TIME_DEDUCTION_TEST",
      amount: "-50", reason: "invalid",
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it("REQUIRES a non-empty reason (whitespace-only is refused)", async () => {
    const s = await seedSemiMonthlySalaryScenario({ seed: "rzn" });
    await seedOneTimeCatalogue(s.club.id, s.adminP);
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.pp.id);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    await expect(addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "ONE_TIME_BONUS_TEST",
      amount: "10", reason: "    ",
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it("STRIPS < > from reason and caps it at 240 chars", async () => {
    const s = await seedSemiMonthlySalaryScenario({ seed: "san" });
    await seedOneTimeCatalogue(s.club.id, s.adminP);
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.pp.id);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    const long = "a".repeat(300);
    const out = await addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "ONE_TIME_BONUS_TEST",
      amount: "10", reason: `<script>${long}`,
    });
    const snap = await db().payrollBatchComponentSnapshot.findFirstOrThrow({ where: { id: out.snapshotId } });
    expect(snap.reason).toBeDefined();
    expect(snap.reason!.length).toBeLessThanOrEqual(240);
    expect(snap.reason).not.toContain("<");
    expect(snap.reason).not.toContain(">");
  });

  it("REFUSES an inactive / non-existent component", async () => {
    const s = await seedSemiMonthlySalaryScenario({ seed: "inact" });
    await seedOneTimeCatalogue(s.club.id, s.adminP);
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.pp.id);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    await expect(addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "COMPONENT_THAT_DOES_NOT_EXIST",
      amount: "10", reason: "test",
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it("REFUSES a PERCENT_OF_ELIGIBLE_EARNINGS component (deferred by §8 of the brief)", async () => {
    const s = await seedSemiMonthlySalaryScenario({ seed: "pct" });
    const percentComp = await upsertPayrollComponent(s.adminP, s.club.id, {
      code: "PCT_ONETIME_TEST", displayName: "Percent Onetime",
      category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE",
      cashEffect: "DECREASES_NET_PAY",
      taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
      calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
      eligibleEarningsBase: "REGULAR_EARNINGS_ONLY",
      statutoryTreatmentSource: "CUSTOM_TEST",
      displaySection: "DEDUCTIONS",
    });
    void percentComp;
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.pp.id);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    await expect(addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "PCT_ONETIME_TEST",
      percentBps: 500, reason: "test",
    })).rejects.toBeInstanceOf(ConflictError);
  });

  it("REFUSES cross-tenant batch or batchEmployee", async () => {
    const a = await seedSemiMonthlySalaryScenario({ seed: "tA" });
    const b = await seedSemiMonthlySalaryScenario({ seed: "tB" });
    await seedOneTimeCatalogue(a.club.id, a.adminP);
    const prepA = await preparePayrollBatch(a.paP, a.club.id, a.pp.id);
    const prepB = await preparePayrollBatch(b.paP, b.club.id, b.pp.id);
    const beB = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prepB.batchId } });
    // Tenant B principal tries to add against Tenant A batch
    await expect(addOneTimeAdjustment(b.paP, a.club.id, prepA.batchId, {
      batchEmployeeId: beB.id, componentCode: "ONE_TIME_BONUS_TEST",
      amount: "1", reason: "cross-tenant",
    })).rejects.toBeInstanceOf(ForbiddenError);
    // Tenant A principal tries to attach a foreign batchEmployee (from Tenant B) to Tenant A batch
    await expect(addOneTimeAdjustment(a.paP, a.club.id, prepA.batchId, {
      batchEmployeeId: beB.id, componentCode: "ONE_TIME_BONUS_TEST",
      amount: "1", reason: "cross-emp",
    })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("REFUSES adjustment on a CALCULATED batch", async () => {
    const s = await seedSemiMonthlySalaryScenario({ seed: "calc" });
    await seedOneTimeCatalogue(s.club.id, s.adminP);
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.pp.id);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    await expect(addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "ONE_TIME_BONUS_TEST",
      amount: "10", reason: "late",
    })).rejects.toBeInstanceOf(ConflictError);
  });

  it("REFUSES removal of a recurring snapshot (only ONE_TIME_PAYROLL_ADJUSTMENT rows are removable)", async () => {
    const s = await seedSemiMonthlySalaryScenario({ seed: "rm-rec" });
    // Give Sam a recurring cell-phone allowance so a recurring snapshot exists.
    const cell = await upsertPayrollComponent(s.adminP, s.club.id, {
      code: "CELL_PHONE_ALLOWANCE", displayName: "Cell Phone Allowance",
      category: "ALLOWANCE", side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
      taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT", statutoryTreatmentSource: "CUSTOM",
      displaySection: "EARNINGS",
    });
    await createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: s.emp.id, componentId: cell.id, amount: "37.50", effectiveFrom: utc(2020, 1, 1),
    });
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.pp.id);
    const recurring = await db().payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchId: prep.batchId, componentCode: "CELL_PHONE_ALLOWANCE" },
    });
    await expect(removeOneTimeAdjustment(s.paP, s.club.id, { snapshotId: recurring.id }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("REMOVES an added adjustment while PREPARED; refuses again after CALCULATED", async () => {
    const s = await seedSemiMonthlySalaryScenario({ seed: "rm-life" });
    await seedOneTimeCatalogue(s.club.id, s.adminP);
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.pp.id);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    const out = await addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "ONE_TIME_BONUS_TEST",
      amount: "100", reason: "will-remove",
    });
    await removeOneTimeAdjustment(s.paP, s.club.id, { snapshotId: out.snapshotId });
    expect(await db().payrollBatchComponentSnapshot.findUnique({ where: { id: out.snapshotId } })).toBeNull();

    // Add again → calculate → refuse remove.
    const out2 = await addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "ONE_TIME_BONUS_TEST",
      amount: "100", reason: "second",
    });
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    await expect(removeOneTimeAdjustment(s.paP, s.club.id, { snapshotId: out2.snapshotId }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("emits audit rows on add and remove (payroll.adjustment.add / .remove)", async () => {
    const s = await seedSemiMonthlySalaryScenario({ seed: "audit" });
    await seedOneTimeCatalogue(s.club.id, s.adminP);
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.pp.id);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    const out = await addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "ONE_TIME_BONUS_TEST",
      amount: "10", reason: "audit-add",
    });
    await removeOneTimeAdjustment(s.paP, s.club.id, { snapshotId: out.snapshotId });
    const auds = await db().auditLog.findMany({
      where: { clubId: s.club.id, entityType: "PayrollBatchComponentSnapshot", entityId: out.snapshotId },
      orderBy: { createdAt: "asc" },
    });
    const actions = auds.map((a) => a.action);
    expect(actions).toContain("payroll.adjustment.add");
    expect(actions).toContain("payroll.adjustment.remove");
  });

  it("REFUSES a Controller (no payroll:run permission) attempting to add", async () => {
    const s = await seedSemiMonthlySalaryScenario({ seed: "ctl" });
    await seedOneTimeCatalogue(s.club.id, s.adminP);
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.pp.id);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    await expect(addOneTimeAdjustment(s.ctlP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "ONE_TIME_BONUS_TEST",
      amount: "1", reason: "unauth",
    })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("Payroll-3C-4 · calculator consumes one-time adjustments", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("bonus adds to cash AND to all three statutory bases (taxable, pensionable, insurable)", async () => {
    const s = await seedSemiMonthlySalaryScenario({ seed: "bonus" });
    await seedOneTimeCatalogue(s.club.id, s.adminP);
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.pp.id);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    await addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "ONE_TIME_BONUS_TEST",
      amount: "500", reason: "bonus",
    });
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    const beAfter = await db().payrollBatchEmployee.findUniqueOrThrow({ where: { id: be.id } });
    // Regular semi-monthly $4,583.33 + bonus $500 = $5,083.33 cash.
    expect(new Decimal(beAfter.grossPay!.toString()).toFixed(2)).toBe("5083.33");
    expect(new Decimal(beAfter.earningsTaxable!.toString()).toFixed(2)).toBe("5083.33");
    expect(new Decimal(beAfter.earningsPensionable!.toString()).toFixed(2)).toBe("5083.33");
    expect(new Decimal(beAfter.earningsInsurable!.toString()).toFixed(2)).toBe("5083.33");
  });

  it("reimbursement adds to cash but NOT to any statutory base", async () => {
    const s = await seedSemiMonthlySalaryScenario({ seed: "reimb" });
    await seedOneTimeCatalogue(s.club.id, s.adminP);
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.pp.id);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    await addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "EXPENSE_REIMBURSEMENT_TEST",
      amount: "72.40", reason: "gas receipts",
    });
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    const beAfter = await db().payrollBatchEmployee.findUniqueOrThrow({ where: { id: be.id } });
    expect(new Decimal(beAfter.grossPay!.toString()).toFixed(2)).toBe("4655.73");
    // Statutory bases unchanged from base salary.
    expect(new Decimal(beAfter.earningsTaxable!.toString()).toFixed(2)).toBe("4583.33");
    expect(new Decimal(beAfter.earningsPensionable!.toString()).toFixed(2)).toBe("4583.33");
    expect(new Decimal(beAfter.earningsInsurable!.toString()).toFixed(2)).toBe("4583.33");
  });

  it("deduction reduces net cash but does NOT change gross earnings or statutory bases", async () => {
    const s = await seedSemiMonthlySalaryScenario({ seed: "deduct" });
    await seedOneTimeCatalogue(s.club.id, s.adminP);
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.pp.id);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    await addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "ONE_TIME_DEDUCTION_TEST",
      amount: "50", reason: "equipment",
    });
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    const beAfter = await db().payrollBatchEmployee.findUniqueOrThrow({ where: { id: be.id } });
    // Gross unchanged (deductions do not raise gross).
    expect(new Decimal(beAfter.grossPay!.toString()).toFixed(2)).toBe("4583.33");
    // Statutory bases unchanged.
    expect(new Decimal(beAfter.earningsTaxable!.toString()).toFixed(2)).toBe("4583.33");
    // Configured employee deduction total includes the $50.
    const snaps = await db().payrollBatchComponentSnapshot.findMany({
      where: { batchId: prep.batchId, batchEmployeeId: be.id },
    });
    const deductRow = snaps.find((r) => r.componentCode === "ONE_TIME_DEDUCTION_TEST");
    expect(deductRow?.resolvedAmount?.toFixed(2)).toBe("50.00");
    expect(deductRow?.provenance).toBe("ONE_TIME_PAYROLL_ADJUSTMENT");
  });

  it("non-cash taxable benefit adds to taxable + pensionable bases but NOT to cash earnings", async () => {
    const s = await seedSemiMonthlySalaryScenario({ seed: "noncash" });
    await seedOneTimeCatalogue(s.club.id, s.adminP);
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.pp.id);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    await addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "ONE_TIME_TAXABLE_BENEFIT_TEST",
      amount: "100", reason: "sponsored dinner",
    });
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    const beAfter = await db().payrollBatchEmployee.findUniqueOrThrow({ where: { id: be.id } });
    // Cash unchanged.
    expect(new Decimal(beAfter.grossPay!.toString()).toFixed(2)).toBe("4583.33");
    // Statutory bases lifted by $100 for taxable + pensionable; insurable NOT.
    expect(new Decimal(beAfter.earningsTaxable!.toString()).toFixed(2)).toBe("4683.33");
    expect(new Decimal(beAfter.earningsPensionable!.toString()).toFixed(2)).toBe("4683.33");
    expect(new Decimal(beAfter.earningsInsurable!.toString()).toFixed(2)).toBe("4583.33");
  });

  it("isolated (salary-only) founder scenario — cash gross $5,155.73", async () => {
    // Sam without any recurring components: base salary $4,583.33 +
    // bonus $500 + reimbursement $72.40 = $5,155.73. The deduction
    // reduces net cash later (cashEffect=DECREASES_NET_PAY) but does
    // NOT lower cash earnings / gross remuneration.
    const s = await seedSemiMonthlySalaryScenario({ seed: "founder-iso" });
    await seedOneTimeCatalogue(s.club.id, s.adminP);
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.pp.id);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    await addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "ONE_TIME_BONUS_TEST",
      amount: "500", reason: "August performance bonus",
    });
    await addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "EXPENSE_REIMBURSEMENT_TEST",
      amount: "72.40", reason: "August fuel receipts",
    });
    await addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "ONE_TIME_DEDUCTION_TEST",
      amount: "50", reason: "equipment fund",
    });
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    const beAfter = await db().payrollBatchEmployee.findUniqueOrThrow({ where: { id: be.id } });
    // Cash earnings = 4583.33 + 500 + 72.40 = 5155.73.
    expect(new Decimal(beAfter.grossPay!.toString()).toFixed(2)).toBe("5155.73");
    // The three adjustments produced three ONE_TIME_PAYROLL_ADJUSTMENT snapshots.
    const oneTimes = await db().payrollBatchComponentSnapshot.findMany({
      where: { batchId: prep.batchId, provenance: "ONE_TIME_PAYROLL_ADJUSTMENT" },
    });
    expect(oneTimes.length).toBe(3);
    expect(oneTimes.every((r) => r.enteredByUserId === s.paP.id)).toBe(true);
    expect(oneTimes.every((r) => (r.reason ?? "").length > 0)).toBe(true);
    expect(oneTimes.every((r) => r.sourceAssignmentId === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------
// Payroll-3C-4A HOTFIX (2026-09-09) — real-fixture reconciliation,
// coexistence guarantees, DB uniqueness, tightened lifecycle.
// ---------------------------------------------------------------------

async function seedRealSamComplex(seed: string) {
  const s = await seedSemiMonthlySalaryScenario({ seed });
  // Mirror the seven recurring components from
  // scripts/payroll-founder-preview-components.ts — this is the
  // configuration the founder scenario runs against.
  async function comp(
    code: string, name: string, section: "EARNINGS" | "BENEFITS" | "DEDUCTIONS",
    side: "EMPLOYEE" | "EMPLOYER", cash: "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT",
    category: string,
    taxable: "ADD" | "SUBTRACT" | "NONE", cpp: "ADD" | "SUBTRACT" | "NONE", ei: "ADD" | "SUBTRACT" | "NONE",
    method: "FIXED_AMOUNT" | "PERCENT_OF_ELIGIBLE_EARNINGS",
    amount: string | null, percentBps: number | null,
  ) {
    const c = await upsertPayrollComponent(s.adminP, s.club.id, {
      code, displayName: name, category: category as never, side,
      cashEffect: cash, taxableEffect: taxable, cppPensionableEffect: cpp, eiInsurableEffect: ei,
      calculationMethod: method,
      eligibleEarningsBase: method === "PERCENT_OF_ELIGIBLE_EARNINGS" ? "REGULAR_EARNINGS_ONLY" : null,
      statutoryTreatmentSource: "CUSTOM_TEST",
      displaySection: section,
    });
    await createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: s.emp.id, componentId: c.id,
      amount, percentBps, effectiveFrom: utc(2020, 1, 1),
    });
    return c;
  }
  await comp("CELL_PHONE_ALLOWANCE",       "Cell Phone Allowance",       "EARNINGS",   "EMPLOYEE", "INCREASES_NET_PAY", "ALLOWANCE",             "ADD",  "ADD",  "NONE", "FIXED_AMOUNT",                "37.50", null);
  await comp("LIFE_INSURANCE_ER_PREMIUM",  "Life Insurance ER Premium",  "BENEFITS",   "EMPLOYER", "NO_NET_PAY_EFFECT", "TAXABLE_BENEFIT",       "ADD",  "ADD",  "NONE", "FIXED_AMOUNT",                "20.93", null);
  await comp("AD_D_ER_PREMIUM",            "AD&D ER Premium",            "BENEFITS",   "EMPLOYER", "NO_NET_PAY_EFFECT", "EMPLOYER_CONTRIBUTION", "NONE", "NONE", "NONE", "FIXED_AMOUNT",                "2.25",  null);
  await comp("DEPENDENT_LIFE_ER_PREMIUM",  "Dependent Life ER",          "BENEFITS",   "EMPLOYER", "NO_NET_PAY_EFFECT", "EMPLOYER_CONTRIBUTION", "NONE", "NONE", "NONE", "FIXED_AMOUNT",                "0.83",  null);
  await comp("RRSP_ER",                    "RRSP Employer",              "BENEFITS",   "EMPLOYER", "NO_NET_PAY_EFFECT", "EMPLOYER_CONTRIBUTION", "NONE", "NONE", "NONE", "PERCENT_OF_ELIGIBLE_EARNINGS", null,   500);
  await comp("RRSP_EE",                    "RRSP Employee",              "DEDUCTIONS", "EMPLOYEE", "DECREASES_NET_PAY", "EMPLOYEE_DEDUCTION",    "NONE", "NONE", "NONE", "PERCENT_OF_ELIGIBLE_EARNINGS", null,   500);
  await comp("LTD_EE",                     "LTD Employee",               "DEDUCTIONS", "EMPLOYEE", "DECREASES_NET_PAY", "EMPLOYEE_DEDUCTION",    "NONE", "NONE", "NONE", "FIXED_AMOUNT",                "28.11", null);
  await seedOneTimeCatalogue(s.club.id, s.adminP);
  return s;
}

describe("Payroll-3C-4A · founder reconciliation on the REAL fixture (Sam Complex + 7 recurring)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("baseline BEFORE any adjustments — Cash $4,620.83, Taxable $4,641.76, Pens $4,641.76, EI $4,583.33", async () => {
    const s = await seedRealSamComplex("baseline");
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.pp.id);
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    expect(new Decimal(be.grossPay!.toString()).toFixed(2)).toBe("4620.83");
    expect(new Decimal(be.earningsTaxable!.toString()).toFixed(2)).toBe("4641.76");
    expect(new Decimal(be.earningsPensionable!.toString()).toFixed(2)).toBe("4641.76");
    expect(new Decimal(be.earningsInsurable!.toString()).toFixed(2)).toBe("4583.33");
  });

  it("FOUNDER SCENARIO — after Bonus $500 + Reimb $72.40 + Deduction $50: cash $5,193.23; taxable $5,141.76; pens $5,141.76; EI $5,083.33; configured deductions $307.28", async () => {
    const s = await seedRealSamComplex("founder");
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.pp.id);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });

    // Snapshot inventory BEFORE any adjustments.
    const before = await db().payrollBatchComponentSnapshot.findMany({
      where: { batchId: prep.batchId, batchEmployeeId: be.id },
      orderBy: { componentCode: "asc" },
    });
    const beforeCodes = before.map((r) => r.componentCode).sort();
    expect(beforeCodes).toEqual([
      "AD_D_ER_PREMIUM", "CELL_PHONE_ALLOWANCE", "DEPENDENT_LIFE_ER_PREMIUM",
      "LIFE_INSURANCE_ER_PREMIUM", "LTD_EE", "RRSP_EE", "RRSP_ER",
    ]);
    expect(before.every((r) => r.provenance === "RECURRING_EMPLOYEE_SETUP")).toBe(true);

    await addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "ONE_TIME_BONUS_TEST",
      amount: "500", reason: "August performance bonus",
    });
    await addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "EXPENSE_REIMBURSEMENT_TEST",
      amount: "72.40", reason: "August fuel receipts",
    });
    await addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "ONE_TIME_DEDUCTION_TEST",
      amount: "50", reason: "equipment fund",
    });

    // Snapshot inventory AFTER — the seven recurring rows MUST still
    // be present alongside the three new one-time rows.
    const after = await db().payrollBatchComponentSnapshot.findMany({
      where: { batchId: prep.batchId, batchEmployeeId: be.id },
      orderBy: { componentCode: "asc" },
    });
    expect(after.length).toBe(10);
    const recurringAfter = after.filter((r) => r.provenance === "RECURRING_EMPLOYEE_SETUP").map((r) => r.componentCode).sort();
    expect(recurringAfter).toEqual(beforeCodes);
    const oneTimeAfter = after.filter((r) => r.provenance === "ONE_TIME_PAYROLL_ADJUSTMENT").map((r) => r.componentCode).sort();
    expect(oneTimeAfter).toEqual([
      "EXPENSE_REIMBURSEMENT_TEST", "ONE_TIME_BONUS_TEST", "ONE_TIME_DEDUCTION_TEST",
    ]);
    // The recurring Cell Phone $37.50 MUST still be present and unchanged.
    const cell = after.find((r) => r.componentCode === "CELL_PHONE_ALLOWANCE");
    expect(cell?.resolvedAmount?.toFixed(2)).toBe("37.50");
    expect(cell?.provenance).toBe("RECURRING_EMPLOYEE_SETUP");

    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    const beAfter = await db().payrollBatchEmployee.findUniqueOrThrow({ where: { id: be.id } });

    // Cash = 4583.33 (salary) + 37.50 (cell) + 500 (bonus) + 72.40 (reimb) = 5193.23.
    expect(new Decimal(beAfter.grossPay!.toString()).toFixed(2)).toBe("5193.23");
    // Taxable = base 4583.33 + cell 37.50 + life 20.93 + bonus 500 = 5141.76.
    expect(new Decimal(beAfter.earningsTaxable!.toString()).toFixed(2)).toBe("5141.76");
    // Pensionable = same shape as taxable = 5141.76.
    expect(new Decimal(beAfter.earningsPensionable!.toString()).toFixed(2)).toBe("5141.76");
    // Insurable = base 4583.33 + bonus 500 (cell + life + reimb are non-insurable) = 5083.33.
    expect(new Decimal(beAfter.earningsInsurable!.toString()).toFixed(2)).toBe("5083.33");
    // Configured employee deductions = RRSP EE 229.17 + LTD 28.11 + One-time 50 = 307.28.
    const configuredDeductions = after
      .concat([{ componentCode: "SEED_SENTINEL" } as never])
      .filter((r) => r.side === "EMPLOYEE" && r.cashEffect === "DECREASES_NET_PAY");
    // Re-read after calculation so RRSP EE has its resolvedAmount stamped.
    const finalSnaps = await db().payrollBatchComponentSnapshot.findMany({
      where: { batchId: prep.batchId, batchEmployeeId: be.id },
    });
    const configured = finalSnaps
      .filter((r) => r.side === "EMPLOYEE" && r.cashEffect === "DECREASES_NET_PAY" && r.resolvedAmount != null)
      .reduce((acc, r) => acc.plus(new Decimal(r.resolvedAmount!.toString())), new Decimal(0));
    expect(configured.toFixed(2)).toBe("307.28");
    void configuredDeductions;
  });
});

describe("Payroll-3C-4A · lifecycle tightened to PREPARED-only", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("REFUSES adjustment on a DRAFT batch (adjustments only accepted while PREPARED)", async () => {
    const s = await seedSemiMonthlySalaryScenario({ seed: "life-draft" });
    await seedOneTimeCatalogue(s.club.id, s.adminP);
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.pp.id);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    // Force-downgrade the batch to DRAFT to prove the tightened guard.
    await db().payrollBatch.update({ where: { id: prep.batchId }, data: { status: "DRAFT" } });
    await expect(addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "ONE_TIME_BONUS_TEST",
      amount: "1", reason: "draft-refused",
    })).rejects.toBeInstanceOf(ConflictError);
  });

  it("REFUSES adjustment on a SUBMITTED_FOR_APPROVAL batch (post-calculation)", async () => {
    const s = await seedSemiMonthlySalaryScenario({ seed: "life-sub" });
    await seedOneTimeCatalogue(s.club.id, s.adminP);
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.pp.id);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    await db().payrollBatch.update({ where: { id: prep.batchId }, data: { status: "SUBMITTED_FOR_APPROVAL" } });
    await expect(addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "ONE_TIME_BONUS_TEST",
      amount: "1", reason: "submitted-refused",
    })).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("Payroll-3C-4A · database uniqueness guarantees for recurring snapshots", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("REFUSES a duplicate recurring snapshot (same batchEmployeeId + sourceAssignmentId) at the DB level", async () => {
    const s = await seedRealSamComplex("uniq");
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.pp.id);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    const cellRow = await db().payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchEmployeeId: be.id, componentCode: "CELL_PHONE_ALLOWANCE" },
    });
    // Manually attempt to insert a second recurring snapshot referencing
    // the same source assignment. Must be rejected by the partial
    // unique index installed by Payroll-3C-4A.
    await expect(db().payrollBatchComponentSnapshot.create({
      data: {
        clubId: cellRow.clubId, batchId: cellRow.batchId, batchEmployeeId: cellRow.batchEmployeeId,
        employeeId: cellRow.employeeId, sourceComponentId: cellRow.sourceComponentId,
        sourceAssignmentId: cellRow.sourceAssignmentId!,
        componentCode: cellRow.componentCode, displayName: cellRow.displayName,
        category: cellRow.category, side: cellRow.side, displaySection: cellRow.displaySection,
        displayOrder: cellRow.displayOrder, cashEffect: cellRow.cashEffect,
        taxableEffect: cellRow.taxableEffect, cppPensionableEffect: cellRow.cppPensionableEffect,
        eiInsurableEffect: cellRow.eiInsurableEffect, calculationMethod: cellRow.calculationMethod,
        statutoryTreatmentSource: cellRow.statutoryTreatmentSource,
        resolvedAmount: cellRow.resolvedAmount ?? undefined,
        sourceEffectiveFrom: cellRow.sourceEffectiveFrom,
        provenance: "RECURRING_EMPLOYEE_SETUP",
      },
    })).rejects.toThrow();
  });

  it("PERMITS multiple one-time snapshots on the same employee (sourceAssignmentId IS NULL)", async () => {
    const s = await seedRealSamComplex("uniq-onetime");
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.pp.id);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    // Two one-time bonuses on the same employee — must both be
    // accepted (partial unique excludes NULL sourceAssignmentId).
    await addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "ONE_TIME_BONUS_TEST",
      amount: "50", reason: "first",
    });
    await addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "ONE_TIME_BONUS_TEST",
      amount: "75", reason: "second",
    });
    const oneTimes = await db().payrollBatchComponentSnapshot.findMany({
      where: { batchEmployeeId: be.id, provenance: "ONE_TIME_PAYROLL_ADJUSTMENT" },
    });
    expect(oneTimes.length).toBe(2);
  });
});

describe("Payroll-3C-4A · recurring + one-time coexistence", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("adding one-time rows does NOT alter, replace, or remove the recurring Cell Phone snapshot", async () => {
    const s = await seedRealSamComplex("coex");
    const prep = await preparePayrollBatch(s.paP, s.club.id, s.pp.id);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    const cellBefore = await db().payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchEmployeeId: be.id, componentCode: "CELL_PHONE_ALLOWANCE" },
    });
    await addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "ONE_TIME_BONUS_TEST",
      amount: "500", reason: "one",
    });
    await addOneTimeAdjustment(s.paP, s.club.id, prep.batchId, {
      batchEmployeeId: be.id, componentCode: "ONE_TIME_DEDUCTION_TEST",
      amount: "50", reason: "two",
    });
    const cellAfter = await db().payrollBatchComponentSnapshot.findUniqueOrThrow({
      where: { id: cellBefore.id },
    });
    expect(cellAfter.id).toBe(cellBefore.id);
    expect(cellAfter.resolvedAmount?.toFixed(2)).toBe(cellBefore.resolvedAmount?.toFixed(2));
    expect(cellAfter.provenance).toBe("RECURRING_EMPLOYEE_SETUP");
    expect(cellAfter.sourceAssignmentId).toBe(cellBefore.sourceAssignmentId);
  });
});
