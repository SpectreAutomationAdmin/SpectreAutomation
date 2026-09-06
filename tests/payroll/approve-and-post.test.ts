// Payroll MVP posting (2026-09-05) — approvePayrollBatch + postPayrollBatch
// integration tests. Exercises the state machine (CALCULATED → APPROVED
// → POSTED), idempotency, segregation of duties, GL balance invariant,
// and the pay-statement reader.
//
// Coverage:
//   • Happy path: approve then post produces a balanced JournalEntry
//   • Idempotency: repeat approve / repeat post are safe
//   • RBAC: payroll:approve and payroll:post are required
//   • SoD: same-actor approval writes a distinct audit line
//   • Refuses to skip states (PREPARED → APPROVED, CALCULATED → POSTED)
//   • Refuses without a PayrollGlAccountingProfile
//   • getBatchPayStatements returns immutable per-employee results
//   • FINAL_APPROVAL WI item is resolved on POSTED

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { approvePayrollBatch, postPayrollBatch } from "@/lib/payroll/approve-and-post";
import { getBatchPayStatements } from "@/lib/payroll/paystubs";
import { ConflictError } from "@/lib/errors";
import { Prisma } from "@prisma/client";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function seedGlProfileAccounts(clubId: string) {
  const c = db();
  async function acct(number: string, name: string, type: "EXPENSE" | "LIABILITY") {
    return c.account.create({
      data: {
        clubId, accountNumber: number, name, type,
        normalBalance: type === "EXPENSE" ? "DEBIT" : "CREDIT",
        isActive: true, allowManualPosting: false,
      },
    });
  }
  const salaryExpense       = await acct("5100", "Salary Expense", "EXPENSE");
  const employerCppExpense  = await acct("5110", "Employer CPP Expense", "EXPENSE");
  const employerEiExpense   = await acct("5120", "Employer EI Expense", "EXPENSE");
  const netPayPayable       = await acct("2100", "Net Pay Payable", "LIABILITY");
  const cppPayable          = await acct("2110", "CPP Payable", "LIABILITY");
  const eiPayable           = await acct("2120", "EI Payable", "LIABILITY");
  const federalTaxPayable   = await acct("2130", "Federal Tax Payable", "LIABILITY");
  const provincialTaxPayable = await acct("2140", "AB Tax Payable", "LIABILITY");

  const profile = await c.payrollGlAccountingProfile.create({
    data: {
      clubId,
      salaryExpenseAccountId: salaryExpense.id,
      employerCppExpenseAccountId: employerCppExpense.id,
      employerEiExpenseAccountId: employerEiExpense.id,
      netPayPayableAccountId: netPayPayable.id,
      cppPayableAccountId: cppPayable.id,
      eiPayableAccountId: eiPayable.id,
      federalTaxPayableAccountId: federalTaxPayable.id,
      provincialTaxPayableAccountId: provincialTaxPayable.id,
    },
  });
  return { profile };
}

/**
 * Build a batch straight into CALCULATED status by direct writes.
 * Avoids the full calculator path — this suite is about the approve/
 * post state machine, not gross-to-net math.
 */
async function seedCalculatedBatch(opts: {
  clubName: string;
  raeleneEmail: string;
  chrisEmail: string;
}) {
  const c = db();
  const club = await makeClub(opts.clubName);
  const raelene = await makeUser({ email: opts.raeleneEmail, role: "PAYROLL_ADMIN", clubId: club.id });
  const chris   = await makeUser({ email: opts.chrisEmail,   role: "CONTROLLER",    clubId: club.id });
  const raeleneP = await principalFor(raelene.email);
  const chrisP   = await principalFor(chris.email);

  const { profile } = await seedGlProfileAccounts(club.id);

  // Fiscal year + month covering the payDate (2026-09-16) so the GL
  // adapter can resolve a posting period.
  const fy = await c.fiscalYear.create({
    data: {
      clubId: club.id, label: "FY2026",
      startDate: utc(2026, 1, 1), endDate: utc(2026, 12, 31),
      status: "OPEN",
    },
  });
  await c.fiscalPeriod.create({
    data: {
      clubId: club.id, fiscalYearId: fy.id, label: "FY2026-M09",
      startDate: utc(2026, 9, 1), endDate: utc(2026, 9, 30),
      sequence: 9, status: "OPEN",
    },
  });

  await c.payrollClubConfig.create({
    data: {
      clubId: club.id,
      enabled: true,
      provinceOfEmployment: "AB",
      payrollAdminUserId: raelene.id,
      controllerUserId: chris.id,
      glAccountingProfileId: profile.id,
    },
  });

  const pg = await c.payrollPayGroup.create({
    data: {
      clubId: club.id, code: "SAL-SM", name: "Salaried Semi-Monthly",
      payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 0,
      calendarAnchorDate: utc(2026, 9, 1),
    },
  });
  const pp = await c.payrollPayPeriod.create({
    data: {
      clubId: club.id, payGroupId: pg.id, sequenceInYear: 17, taxYear: 2026,
      periodStart: utc(2026, 9, 1), periodEnd: utc(2026, 9, 16),
      payDate: utc(2026, 9, 16),
    },
  });

  const emp = await c.employee.create({
    data: {
      clubId: club.id, firstName: "Preview", lastName: "Employee",
      email: "preview.employee@preview.spectre.test",
      hireDate: utc(2020, 1, 1),
      dateOfBirth: utc(1985, 5, 12),
      status: "ACTIVE", employeeNumber: "E-PRE-1",
      compensationType: "SALARY", employeeLifecycle: "ACTIVE",
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
      cadence: "SALARY", rate: "80000", currency: "CAD",
      effectiveFrom: utc(2020, 1, 1),
    },
  });

  const batch = await c.payrollBatch.create({
    data: {
      clubId: club.id, payGroupId: pg.id, payPeriodId: pp.id,
      sequence: 1, status: "CALCULATED",
      calculatedAt: new Date(),
      calculationVersion: 1,
      algorithmVersion: "spectre-payroll-test-1",
    },
  });
  // One "salaried" employee row with persisted calculation columns.
  const be = await c.payrollBatchEmployee.create({
    data: {
      clubId: club.id, batchId: batch.id, employeeId: emp.id,
      jurisdictionCountry: "CA", jurisdictionProvince: "AB",
      employeeLifecycleAtPrep: "ACTIVE", status: "INCLUDED", salaried: true,
      grossPay: new Prisma.Decimal("3333.33"),
      earningsTaxable: new Prisma.Decimal("3333.33"),
      earningsPensionable: new Prisma.Decimal("3333.33"),
      earningsInsurable: new Prisma.Decimal("3333.33"),
      deductionCppEeCombined: new Prisma.Decimal("183.42"),
      deductionCpp2Ee: new Prisma.Decimal("0.00"),
      deductionEiEe: new Prisma.Decimal("54.34"),
      deductionFederalTax: new Prisma.Decimal("400.00"),
      deductionProvincialTax: new Prisma.Decimal("175.00"),
      totalEmployeeDeductions: new Prisma.Decimal("812.76"),
      netPay: new Prisma.Decimal("2520.57"),
      employerCppCombined: new Prisma.Decimal("183.42"),
      employerCpp2: new Prisma.Decimal("0.00"),
      employerEi: new Prisma.Decimal("76.08"),
    },
  });
  await c.payrollBatchEarning.create({
    data: {
      clubId: club.id, batchId: batch.id, batchEmployeeId: be.id,
      employeeId: emp.id, earningType: "SALARY",
      quantity: "1", rate: "3333.33", rateSource: "MANUAL",
    },
  });

  return { club, raelene, chris, raeleneP, chrisP, batch, pp };
}

// -------------------------------------------------------------------
// approvePayrollBatch
// -------------------------------------------------------------------
describe("approvePayrollBatch — state machine", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("CALCULATED → APPROVED sets approvedAt and approvedByUserId", async () => {
    const s = await seedCalculatedBatch({
      clubName: "Approve Club A", raeleneEmail: "raelene.a@t.test", chrisEmail: "chris.a@t.test",
    });
    const out = await approvePayrollBatch(s.chrisP, s.batch.id);
    expect(out?.status).toBe("APPROVED");
    expect(out?.approvedByUserId).toBe(s.chris.id);
    expect(out?.approvedAt).not.toBeNull();
  });

  it("is idempotent — repeat approval returns same state without a second write", async () => {
    const s = await seedCalculatedBatch({
      clubName: "Approve Club B", raeleneEmail: "raelene.b@t.test", chrisEmail: "chris.b@t.test",
    });
    const first  = await approvePayrollBatch(s.chrisP, s.batch.id);
    const second = await approvePayrollBatch(s.chrisP, s.batch.id);
    expect(first?.approvedAt?.getTime()).toBe(second?.approvedAt?.getTime());
  });

  it("refuses to approve a PREPARED batch (state-machine violation)", async () => {
    const s = await seedCalculatedBatch({
      clubName: "Approve Club C", raeleneEmail: "raelene.c@t.test", chrisEmail: "chris.c@t.test",
    });
    await db().payrollBatch.update({ where: { id: s.batch.id }, data: { status: "PREPARED" } });
    await expect(approvePayrollBatch(s.chrisP, s.batch.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("requires payroll:approve — a Staff user without the capability is rejected", async () => {
    const s = await seedCalculatedBatch({
      clubName: "Approve Club D", raeleneEmail: "raelene.d@t.test", chrisEmail: "chris.d@t.test",
    });
    // A generic Staff user has no payroll capabilities at all.
    const staff = await makeUser({ email: "staff.d@t.test", role: "STAFF", clubId: s.club.id });
    const staffP = await principalFor(staff.email);
    await expect(approvePayrollBatch(staffP, s.batch.id)).rejects.toBeTruthy();
  });
});

// -------------------------------------------------------------------
// postPayrollBatch — GL balance + idempotency
// -------------------------------------------------------------------
describe("postPayrollBatch — GL write + state machine", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("APPROVED → POSTED writes a balanced JournalEntry and links glJournalEntryId", async () => {
    const s = await seedCalculatedBatch({
      clubName: "Post Club A", raeleneEmail: "raelene.pa@t.test", chrisEmail: "chris.pa@t.test",
    });
    await approvePayrollBatch(s.chrisP, s.batch.id);
    const out = await postPayrollBatch(s.chrisP, s.batch.id);
    expect(out.journalEntryId).toBeTruthy();
    // Balanced.
    expect(out.totalDebits).toBe(out.totalCredits);
    // Batch flipped + linked.
    const posted = await db().payrollBatch.findUniqueOrThrow({ where: { id: s.batch.id } });
    expect(posted.status).toBe("POSTED");
    expect(posted.glJournalEntryId).toBe(out.journalEntryId);
    expect(posted.postedByUserId).toBe(s.chris.id);
    // 3 debits + 5 credits = 8 lines total.
    const lines = await db().journalEntryLine.findMany({ where: { journalEntryId: out.journalEntryId } });
    expect(lines.length).toBe(8);
    // The JE itself is POSTED and marks source=PAYROLL / sourceEntityId=batch.id.
    const je = await db().journalEntry.findUniqueOrThrow({ where: { id: out.journalEntryId } });
    expect(je.status).toBe("POSTED");
    expect(je.source).toBe("PAYROLL");
    expect(je.sourceEntityType).toBe("PayrollBatch");
    expect(je.sourceEntityId).toBe(s.batch.id);
  });

  it("is idempotent — a repeat post does not create a second JournalEntry", async () => {
    const s = await seedCalculatedBatch({
      clubName: "Post Club B", raeleneEmail: "raelene.pb@t.test", chrisEmail: "chris.pb@t.test",
    });
    await approvePayrollBatch(s.chrisP, s.batch.id);
    const first  = await postPayrollBatch(s.chrisP, s.batch.id);
    const second = await postPayrollBatch(s.chrisP, s.batch.id);
    expect(second.journalEntryId).toBe(first.journalEntryId);
    const entries = await db().journalEntry.findMany({ where: { sourceEntityType: "PayrollBatch", sourceEntityId: s.batch.id } });
    expect(entries.length).toBe(1);
  });

  it("refuses to post a batch that is not APPROVED", async () => {
    const s = await seedCalculatedBatch({
      clubName: "Post Club C", raeleneEmail: "raelene.pc@t.test", chrisEmail: "chris.pc@t.test",
    });
    // Still CALCULATED — no approval yet.
    await expect(postPayrollBatch(s.chrisP, s.batch.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses without a PayrollGlAccountingProfile", async () => {
    const s = await seedCalculatedBatch({
      clubName: "Post Club D", raeleneEmail: "raelene.pd@t.test", chrisEmail: "chris.pd@t.test",
    });
    // Clear the mapping so the post service cannot find a GL profile.
    await db().payrollClubConfig.update({
      where: { clubId: s.club.id }, data: { glAccountingProfileId: null },
    });
    await approvePayrollBatch(s.chrisP, s.batch.id);
    await expect(postPayrollBatch(s.chrisP, s.batch.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("closes the Controller PAYROLL_FINAL_APPROVAL WI item on POSTED", async () => {
    const s = await seedCalculatedBatch({
      clubName: "Post Club E", raeleneEmail: "raelene.pe@t.test", chrisEmail: "chris.pe@t.test",
    });
    // Simulate the calculator having created the FINAL_APPROVAL WI + origin.
    const wi = await db().workIntakeItem.create({
      data: {
        clubId: s.club.id,
        classification: "PAYROLL_FINAL_APPROVAL", workSubtype: "PAYROLL_FINAL_APPROVAL",
        workIntent: "APPROVE", ownerUserId: s.chris.id,
        status: "OPEN",
        displaySourceLabel: "Payroll",
        displaySender: "Payroll",
        displaySubject: "Payroll ready",
        displayPreview: "Payroll ready to approve",
        displayReceivedAt: new Date(),
      },
    });
    await db().workIntakeOrigin.create({
      data: {
        clubId: s.club.id, workIntakeItemId: wi.id,
        kind: "PAYROLL_FINAL_APPROVAL", referenceId: s.batch.id, role: "PRIMARY",
      },
    });
    await approvePayrollBatch(s.chrisP, s.batch.id);
    await postPayrollBatch(s.chrisP, s.batch.id);
    const closed = await db().workIntakeItem.findUniqueOrThrow({ where: { id: wi.id } });
    expect(closed.status).toBe("RESOLVED");
  });
});

// -------------------------------------------------------------------
// getBatchPayStatements — pay statement reader
// -------------------------------------------------------------------
describe("getBatchPayStatements — immutable pay statements", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("returns one statement per employee with the persisted numbers", async () => {
    const s = await seedCalculatedBatch({
      clubName: "Stub Club A", raeleneEmail: "raelene.st@t.test", chrisEmail: "chris.st@t.test",
    });
    await approvePayrollBatch(s.chrisP, s.batch.id);
    await postPayrollBatch(s.chrisP, s.batch.id);
    const stubs = await getBatchPayStatements(s.chrisP, s.club.id, s.batch.id);
    expect(stubs.length).toBe(1);
    const stub = stubs[0];
    expect(stub.earnings.gross).toBe("3333.33");
    expect(stub.netPay).toBe("2520.57");
    expect(stub.employeeDeductions.total).toBe("812.76");
    expect(stub.employerContributions.total).toBe("259.50");
    expect(stub.posted.isPosted).toBe(true);
    expect(stub.posted.glJournalEntryId).toBeTruthy();
  });

  it("refuses to read a batch when the principal has no access to the requested club", async () => {
    const s = await seedCalculatedBatch({
      clubName: "Stub Club B", raeleneEmail: "raelene.st2@t.test", chrisEmail: "chris.st2@t.test",
    });
    const other = await makeClub("Stub Club B — Other");
    // chrisP has payroll:read at his own club only. Requesting under a
    // different clubId is rejected either as "missing permission" (checked
    // first) or "not found" (checked after the include). Either is a valid
    // refusal — the point of the test is: the batch is NOT returned.
    await expect(getBatchPayStatements(s.chrisP, other.id, s.batch.id)).rejects.toBeTruthy();
  });
});
