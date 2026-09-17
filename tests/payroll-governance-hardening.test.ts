// Pre-Phase-5 governance hardening (2026-09-16) — role matrix +
// lifecycle SoD + Ready-to-Post routing regressions.
//
// Governance model (restored):
//   PAYROLL_ADMIN: Prepare → Calculate → Review & Adjust → Submit
//   CONTROLLER:    independent financial Approve
//   PAYROLL_ADMIN: Post approved payroll to the GL
//
// Critical SoD: submitter ≠ approver. A PAYROLL_ADMIN who submits
// MAY post the same batch AFTER an independent Controller approves
// the exact frozen calculationVersion.
//
// Locks in:
//   * Effective role grants (payroll:post NOT on CONTROLLER; ON
//     PAYROLL_ADMIN).
//   * Approve refuses when actor === submitter (unchanged).
//   * Post refuses when batch is not APPROVED.
//   * Post permission check refuses a Controller principal.
//   * PA who submitted can post AFTER Controller approves.
//   * Ready-to-Post WI is assigned to Payroll Admin (payrollAdminUserId
//     from PayrollClubConfig).
//   * Existing Phase 4 posting lifecycle regressions remain green
//     (idempotency covered by tests/payroll-3f-post-payroll.test.ts).

import { describe, it, expect, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "./util/db";
import { hasPermission } from "@/lib/rbac";
import { approvePayrollBatch, postPayrollBatch } from "@/lib/payroll/approve-and-post";
import { ApproveSegregationOfDutiesError } from "@/lib/payroll/approve-and-post";
import { ConflictError, ForbiddenError } from "@/lib/errors";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

// ---------------------------------------------------------------------------
// RBAC — effective role grants
// ---------------------------------------------------------------------------
describe("Pre-Phase-5 · effective role grants", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("CONTROLLER: payroll:read YES, payroll:approve YES, payroll:post NO", async () => {
    const club = await makeClub("rbac-ctl");
    const ctl = await makeUser({ email: `ctl.${club.id}@t.test`, role: "CONTROLLER", clubId: club.id });
    const p = await principalFor(ctl.email);
    expect(hasPermission(p, club.id, "payroll:read")).toBe(true);
    expect(hasPermission(p, club.id, "payroll:approve")).toBe(true);
    expect(hasPermission(p, club.id, "payroll:post")).toBe(false);
  });

  it("PAYROLL_ADMIN: payroll:read YES, payroll:run YES, payroll:submit YES, payroll:post YES, payroll:approve NO", async () => {
    const club = await makeClub("rbac-pa");
    const pa = await makeUser({ email: `pa.${club.id}@t.test`, role: "PAYROLL_ADMIN", clubId: club.id });
    const p = await principalFor(pa.email);
    expect(hasPermission(p, club.id, "payroll:read")).toBe(true);
    expect(hasPermission(p, club.id, "payroll:run")).toBe(true);
    expect(hasPermission(p, club.id, "payroll:submit")).toBe(true);
    expect(hasPermission(p, club.id, "payroll:post")).toBe(true);
    expect(hasPermission(p, club.id, "payroll:approve")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle SoD — submitter ≠ approver + PA-can-post-after-approve
// ---------------------------------------------------------------------------
async function seedApprovedBatch(opts: { name: string; submitterEmail: string; approverEmail: string }) {
  const c = db();
  const club = await makeClub(opts.name);
  const sub = await makeUser({ email: opts.submitterEmail, clubId: club.id, role: "PAYROLL_ADMIN" });
  const app = await makeUser({ email: opts.approverEmail, clubId: club.id, role: "CONTROLLER" });
  const subP = await principalFor(opts.submitterEmail);
  const appP = await principalFor(opts.approverEmail);

  const acct = async (n: string, name: string, type: "EXPENSE" | "LIABILITY") => c.account.create({
    data: {
      clubId: club.id, accountNumber: n, name, type,
      normalBalance: type === "EXPENSE" ? "DEBIT" : "CREDIT",
      isActive: true, allowManualPosting: false,
    },
  });
  const salary   = await acct("6000", "Salaries & Wages",       "EXPENSE");
  const erCpp    = await acct("6010", "Employer CPP Expense",   "EXPENSE");
  const erEi     = await acct("6020", "Employer EI Expense",    "EXPENSE");
  const netpay   = await acct("2100", "Net Pay Payable",        "LIABILITY");
  const cppPay   = await acct("2110", "CPP Payable",            "LIABILITY");
  const eiPay    = await acct("2120", "EI Payable",             "LIABILITY");
  const fedPay   = await acct("2130", "Federal Tax Payable",    "LIABILITY");
  const provPay  = await acct("2140", "AB Tax Payable",         "LIABILITY");
  const profile = await c.payrollGlAccountingProfile.create({
    data: {
      clubId: club.id,
      salaryExpenseAccountId:        salary.id,
      employerCppExpenseAccountId:   erCpp.id,
      employerEiExpenseAccountId:    erEi.id,
      netPayPayableAccountId:        netpay.id,
      cppPayableAccountId:           cppPay.id,
      eiPayableAccountId:            eiPay.id,
      federalTaxPayableAccountId:    fedPay.id,
      provincialTaxPayableAccountId: provPay.id,
    },
  });
  const fy = await c.fiscalYear.create({
    data: { clubId: club.id, label: "FY2026",
      startDate: utc(2026, 1, 1), endDate: utc(2026, 12, 31), status: "OPEN" },
  });
  await c.fiscalPeriod.create({
    data: { clubId: club.id, fiscalYearId: fy.id, label: "FY2026-M01",
      startDate: utc(2026, 1, 1), endDate: utc(2026, 1, 31), sequence: 1, status: "OPEN" },
  });
  await c.payrollClubConfig.upsert({
    where: { clubId: club.id },
    update: { glAccountingProfileId: profile.id, controllerUserId: app.id, payrollAdminUserId: sub.id },
    create: { clubId: club.id, provinceOfEmployment: "AB",
      glAccountingProfileId: profile.id,
      controllerUserId: app.id, payrollAdminUserId: sub.id },
  });
  const pg = await c.payrollPayGroup.create({
    data: { clubId: club.id, code: "BW", name: "Bi-Weekly",
      payFrequency: "BIWEEKLY", payDateOffsetDays: 0,
      calendarAnchorDate: utc(2026, 1, 4), active: true },
  });
  const pp = await c.payrollPayPeriod.create({
    data: { clubId: club.id, payGroupId: pg.id, sequenceInYear: 1, taxYear: 2026,
      periodStart: utc(2026, 1, 4), periodEnd: utc(2026, 1, 18),
      payDate: utc(2026, 1, 17), status: "OPEN" },
  });
  const emp = await c.employee.create({
    data: {
      clubId: club.id, firstName: "Gov", lastName: "Test",
      employeeNumber: "G-001", hireDate: utc(2020, 1, 1),
      employeeLifecycle: "ACTIVE", timekeepingMethod: "NO_CLOCK",
    },
  });
  const batch = await c.payrollBatch.create({
    data: {
      clubId: club.id, payGroupId: pg.id, payPeriodId: pp.id,
      sequence: 1, status: "SUBMITTED_FOR_APPROVAL",
      calculatedAt: new Date(), calculationVersion: 1,
      algorithmVersion: "spectre-payroll-test-1",
      submittedAt: new Date(), submittedByUserId: sub.id,
    },
  });
  await c.payrollBatchEmployee.create({
    data: {
      clubId: club.id, batchId: batch.id, employeeId: emp.id,
      jurisdictionCountry: "CA", jurisdictionProvince: "AB",
      employeeLifecycleAtPrep: "ACTIVE", status: "INCLUDED", salaried: true,
      grossPay: new Prisma.Decimal("3000.00"),
      earningsTaxable: new Prisma.Decimal("3000.00"),
      earningsPensionable: new Prisma.Decimal("3000.00"),
      earningsInsurable: new Prisma.Decimal("3000.00"),
      deductionCppEeCombined: new Prisma.Decimal("120.00"),
      deductionCpp2Ee: new Prisma.Decimal("0.00"),
      deductionEiEe: new Prisma.Decimal("48.00"),
      deductionFederalTax: new Prisma.Decimal("300.00"),
      deductionProvincialTax: new Prisma.Decimal("120.00"),
      totalEmployeeDeductions: new Prisma.Decimal("588.00"),
      netPay: new Prisma.Decimal("2412.00"),
      employerCppCombined: new Prisma.Decimal("120.00"),
      employerCpp2: new Prisma.Decimal("0.00"),
      employerEi: new Prisma.Decimal("67.20"),
    },
  });
  return { club, sub, app, subP, appP, batch };
}

describe("Pre-Phase-5 · lifecycle SoD", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("Submitter cannot approve their own payroll (submitter === approver → ApproveSegregationOfDutiesError)", async () => {
    // Give the submitter BOTH roles so the RBAC check passes and the
    // SoD guard fires. This is the "legitimate multi-role holder"
    // case the same-actor SoD defends against.
    const s = await seedApprovedBatch({
      name: "sod-self", submitterEmail: "sub.sod@t.test", approverEmail: "app.sod@t.test",
    });
    await db().userClubRole.create({
      data: { userId: s.sub.id, clubId: s.club.id, roleKey: "CONTROLLER" },
    });
    // Re-load principal with the new role.
    const subP2 = await principalFor("sub.sod@t.test");
    await expect(approvePayrollBatch(subP2, s.batch.id))
      .rejects.toBeInstanceOf(ApproveSegregationOfDutiesError);
  });

  it("Controller principal is refused when attempting Post (payroll:post NOT granted)", async () => {
    const s = await seedApprovedBatch({
      name: "sod-ctl-post", submitterEmail: "sub.ctlpost@t.test", approverEmail: "app.ctlpost@t.test",
    });
    await approvePayrollBatch(s.appP, s.batch.id);
    // Controller lacks payroll:post — postPayrollBatch requirePermission throws ForbiddenError.
    await expect(postPayrollBatch(s.appP, s.batch.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Payroll Admin who SUBMITTED can Post AFTER independent Controller Approval", async () => {
    const s = await seedApprovedBatch({
      name: "sod-pa-post", submitterEmail: "sub.papost@t.test", approverEmail: "app.papost@t.test",
    });
    await approvePayrollBatch(s.appP, s.batch.id);
    const posted = await postPayrollBatch(s.subP, s.batch.id);
    expect(posted.journalEntryId).toBeTruthy();
  });

  it("Post is refused when batch is not APPROVED (status guard)", async () => {
    const s = await seedApprovedBatch({
      name: "sod-not-approved", submitterEmail: "sub.notap@t.test", approverEmail: "app.notap@t.test",
    });
    await expect(postPayrollBatch(s.subP, s.batch.id)).rejects.toBeInstanceOf(ConflictError);
  });
});

// ---------------------------------------------------------------------------
// Ready-to-Post Work Intake — assigned to Payroll Admin
// ---------------------------------------------------------------------------
describe("Pre-Phase-5 · Ready-to-Post Work Intake ownership", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("Approve materialises PAYROLL_READY_TO_POST assigned to the Club's Payroll Admin", async () => {
    const s = await seedApprovedBatch({
      name: "rtp", submitterEmail: "sub.rtp@t.test", approverEmail: "app.rtp@t.test",
    });
    await approvePayrollBatch(s.appP, s.batch.id);
    const origin = await db().workIntakeOrigin.findFirstOrThrow({
      where: { clubId: s.club.id, kind: "PAYROLL_READY_TO_POST", referenceId: s.batch.id, role: "PRIMARY" },
    });
    const item = await db().workIntakeItem.findUniqueOrThrow({
      where: { id: origin.workIntakeItemId },
    });
    expect(item.status).toBe("OPEN");
    // Assigned to the Payroll Admin per pre-Phase-5 governance.
    expect(item.ownerUserId).toBe(s.sub.id);
    // Not assigned to the Controller.
    expect(item.ownerUserId).not.toBe(s.app.id);
  });
});
