// Payroll Post Payroll domain regression — updated 2026-09-13 for
// two-person governance (superseding 3F §7 §25).
//
// Covers:
//   §51 Concurrent Post: exactly one succeeds, exactly one journal.
//   §52 Idempotency: a second Post returns the same journal.
//   §54 Missing mapping: profile removed → Post refuses.
//   §F  Preview returns the same journal as Post (identity check).
//   §3-4 Ready-to-Post WI item materialised on Approve, resolved on Post.
//   Two-person: golden PA→submits/Controller→approves+posts test.
//   Two-person: submitter (CLUB_ADMIN) may post after distinct approval.
//   Two-person: pre-approval Post refuses.
//   Two-person: PAYROLL_ADMIN cannot post (permission refused).

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "./util/db";
import { approvePayrollBatch, postPayrollBatch } from "@/lib/payroll/approve-and-post";
import { previewPayrollJournal } from "@/lib/payroll/payroll-journal-preview";
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

async function seedApprovedBatch(opts: {
  clubName: string; submitterEmail: string; approverEmail: string;
}) {
  const c = db();
  const club = await makeClub(opts.clubName);
  const submitter = await makeUser({ email: opts.submitterEmail, clubId: club.id, role: "PAYROLL_ADMIN" });
  const approver  = await makeUser({ email: opts.approverEmail, clubId: club.id, role: "CONTROLLER" });
  const submitterP = await principalFor(opts.submitterEmail);
  const approverP  = await principalFor(opts.approverEmail);
  const { profile } = await seedGlProfileAccounts(club.id);
  // Fiscal year + month covering the payDate (2026-01-17).
  const fy = await c.fiscalYear.create({
    data: {
      clubId: club.id, label: "FY2026",
      startDate: utc(2026, 1, 1), endDate: utc(2026, 12, 31),
      status: "OPEN",
    },
  });
  await c.fiscalPeriod.create({
    data: {
      clubId: club.id, fiscalYearId: fy.id, label: "FY2026-M01",
      startDate: utc(2026, 1, 1), endDate: utc(2026, 1, 31),
      sequence: 1, status: "OPEN",
    },
  });
  await c.payrollClubConfig.upsert({
    where: { clubId: club.id },
    update: { glAccountingProfileId: profile.id, controllerUserId: approver.id, payrollAdminUserId: submitter.id },
    create: { clubId: club.id, provinceOfEmployment: "AB", glAccountingProfileId: profile.id,
             controllerUserId: approver.id, payrollAdminUserId: submitter.id },
  });
  const pg = await c.payrollPayGroup.create({
    data: {
      clubId: club.id, code: "BW", name: "Bi-Weekly", payFrequency: "BIWEEKLY",
      payDateOffsetDays: 0, calendarAnchorDate: utc(2026, 1, 4), active: true,
    },
  });
  const pp = await c.payrollPayPeriod.create({
    data: {
      clubId: club.id, payGroupId: pg.id, sequenceInYear: 1, taxYear: 2026,
      periodStart: utc(2026, 1, 4), periodEnd: utc(2026, 1, 18),
      payDate: utc(2026, 1, 17), status: "OPEN",
    },
  });
  const emp = await c.employee.create({
    data: {
      clubId: club.id, firstName: "Test", lastName: "Employee",
      employeeNumber: "T-001", hireDate: utc(2020, 1, 1),
      employeeLifecycle: "ACTIVE", timekeepingMethod: "NO_CLOCK",
    },
  });
  const assn = await c.employeeEmploymentAssignment.create({
    data: { clubId: club.id, employeeId: emp.id, role: "PRIMARY",
            employmentType: "FULL_TIME", effectiveFrom: utc(2020, 1, 1) },
  });
  await c.employeeCompensation.create({
    data: { clubId: club.id, employeeId: emp.id, assignmentId: assn.id,
            cadence: "SALARY", rate: "80000", currency: "CAD",
            effectiveFrom: utc(2020, 1, 1) },
  });
  const batch = await c.payrollBatch.create({
    data: {
      clubId: club.id, payGroupId: pg.id, payPeriodId: pp.id,
      sequence: 1, status: "SUBMITTED_FOR_APPROVAL",
      calculatedAt: new Date(), calculationVersion: 1,
      algorithmVersion: "spectre-payroll-test-1",
      submittedAt: new Date(), submittedByUserId: submitter.id,
    },
  });
  await c.payrollBatchEmployee.create({
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
  // Approve so the batch is at APPROVED.
  await approvePayrollBatch(approverP, batch.id);
  return { club, submitter, approver, submitterP, approverP, batch, pp };
}

describe("Payroll 3F — Post Payroll (§51-55)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("§51 concurrent Post: exactly one succeeds; exactly one JournalEntry linked", async () => {
    // Note: the two callers race the CAS on
    // updateMany({status:APPROVED, glJournalEntryId:null}). The winner
    // links its JE and the loser observes count=0. On observed POSTED
    // state the loser returns idempotently with the same journalEntryId.
    const s = await seedApprovedBatch({
      clubName: "Post Club A", submitterEmail: "sub.a@t.test", approverEmail: "ctrl.a@t.test",
    });
    // A THIRD principal — the Payroll Admin poster (must be distinct from submitter).
    const poster = await makeUser({ email: "poster.a@t.test", clubId: s.club.id, role: "CLUB_ADMIN" });
    const posterP = await principalFor("poster.a@t.test");
    const [r1, r2] = await Promise.allSettled([
      postPayrollBatch(posterP, s.batch.id),
      postPayrollBatch(posterP, s.batch.id),
    ]);
    // At LEAST one succeeds; the loser may either fulfill idempotently
    // (observing POSTED after the winner committed) or reject with the
    // in-flight race ConflictError. Both are acceptable outcomes for
    // §51 "exactly one succeeds".
    const successes = [r1, r2].filter((x) => x.status === "fulfilled");
    expect(successes.length).toBeGreaterThanOrEqual(1);
    // If both fulfilled, they must reference the same journal.
    if (r1.status === "fulfilled" && r2.status === "fulfilled") {
      expect(r1.value.journalEntryId).toBe(r2.value.journalEntryId);
    }
    // Exactly one JournalEntry regardless.
    const jeCount = await db().journalEntry.count({
      where: { source: "PAYROLL", sourceEntityId: s.batch.id },
    });
    expect(jeCount).toBe(1);
  });

  it("§52 idempotent second Post: same journalEntryId, no second JournalEntry", async () => {
    const s = await seedApprovedBatch({
      clubName: "Post Club B", submitterEmail: "sub.b@t.test", approverEmail: "ctrl.b@t.test",
    });
    const poster = await makeUser({ email: "poster.b@t.test", clubId: s.club.id, role: "CLUB_ADMIN" });
    const posterP = await principalFor("poster.b@t.test");
    const first  = await postPayrollBatch(posterP, s.batch.id);
    const second = await postPayrollBatch(posterP, s.batch.id);
    expect(second.journalEntryId).toBe(first.journalEntryId);
    const jeCount = await db().journalEntry.count({
      where: { source: "PAYROLL", sourceEntityId: s.batch.id },
    });
    expect(jeCount).toBe(1);
  });

  // Two-person governance (2026-09-13) — golden test: PAYROLL_ADMIN
  // submits, CONTROLLER approves + posts. Matches the intended
  // organizational workflow. Assertions cover A ≠ B, approved==posted
  // by the same Controller, and a single balanced JournalEntry.
  it("golden two-person: PA(A) submits, Controller(B) approves + posts", async () => {
    const s = await seedApprovedBatch({
      clubName: "Post Club Golden", submitterEmail: "pa.g@t.test", approverEmail: "ctrl.g@t.test",
    });
    // Controller B has payroll:approve + payroll:return + payroll:post
    // via the two-person governance restore; approve was performed in
    // seedApprovedBatch. Now B posts.
    const posted = await postPayrollBatch(s.approverP, s.batch.id);
    const b = await db().payrollBatch.findUniqueOrThrow({ where: { id: s.batch.id } });
    expect(b.status).toBe("POSTED");
    expect(b.submittedByUserId).toBe(s.submitter.id);
    expect(b.approvedByUserId).toBe(s.approver.id);
    expect(b.postedByUserId).toBe(s.approver.id);
    expect(s.submitter.id).not.toBe(s.approver.id);
    expect(b.approvedByUserId).toBe(b.postedByUserId);
    expect(b.glJournalEntryId).toBe(posted.journalEntryId);
    // JournalEntry balances.
    expect(Number(posted.totalDebits)).toBeCloseTo(Number(posted.totalCredits), 2);
  });

  // Two-person governance (2026-09-13) — the submitter (with an
  // added CLUB_ADMIN role for payroll:post) may now post their own
  // submission PROVIDED a distinct Controller approved it first.
  it("submitter (CLUB_ADMIN) may post after a distinct Controller-approval", async () => {
    const s = await seedApprovedBatch({
      clubName: "Post Club C", submitterEmail: "sub.c@t.test", approverEmail: "ctrl.c@t.test",
    });
    // Grant the submitter CLUB_ADMIN so they hold payroll:post, then
    // re-derive the principal so the added role is present on it. The
    // approver is a distinct Controller.
    await db().userClubRole.create({
      data: { userId: s.submitter.id, clubId: s.club.id, roleKey: "CLUB_ADMIN" },
    });
    const submitterAsAdminP = await principalFor("sub.c@t.test");
    const posted = await postPayrollBatch(submitterAsAdminP, s.batch.id);
    const b = await db().payrollBatch.findUniqueOrThrow({ where: { id: s.batch.id } });
    expect(b.status).toBe("POSTED");
    expect(b.submittedByUserId).toBe(s.submitter.id);
    expect(b.postedByUserId).toBe(s.submitter.id);
    expect(b.approvedByUserId).toBe(s.approver.id);
    expect(b.glJournalEntryId).toBe(posted.journalEntryId);
  });

  // Two-person governance retains the accounting-control invariant
  // that posting cannot happen before Controller approval.
  it("pre-approval Post refuses (removing submitter≠poster must not permit posting unapproved payroll)", async () => {
    // Build a batch that is CALCULATED but NOT approved.
    const s = await seedApprovedBatch({
      clubName: "Post Club Pre", submitterEmail: "sub.p@t.test", approverEmail: "ctrl.p@t.test",
    });
    // Force the batch back to CALCULATED to simulate the pre-approval
    // state without re-plumbing the seed helper.
    await db().payrollBatch.update({
      where: { id: s.batch.id },
      data: { status: "CALCULATED", approvedAt: null, approvedByUserId: null },
    });
    const poster = await makeUser({ email: "poster.p@t.test", clubId: s.club.id, role: "CLUB_ADMIN" });
    const posterP = await principalFor("poster.p@t.test");
    await expect(postPayrollBatch(posterP, s.batch.id))
      .rejects.toThrow(/must be APPROVED before it can be posted/);
    const b = await db().payrollBatch.findUniqueOrThrow({ where: { id: s.batch.id } });
    expect(b.status).toBe("CALCULATED");
    expect(b.glJournalEntryId).toBeNull();
  });

  // Two-person governance regression: PAYROLL_ADMIN no longer holds
  // payroll:post. A pure PAYROLL_ADMIN cannot post; RBAC refuses.
  it("PAYROLL_ADMIN cannot post — permission refused", async () => {
    const s = await seedApprovedBatch({
      clubName: "Post Club PA", submitterEmail: "sub.pa@t.test", approverEmail: "ctrl.pa@t.test",
    });
    // A distinct PAYROLL_ADMIN who did not submit this batch.
    const pa = await makeUser({ email: "another.pa@t.test", clubId: s.club.id, role: "PAYROLL_ADMIN" });
    const paP = await principalFor("another.pa@t.test");
    await expect(postPayrollBatch(paP, s.batch.id))
      .rejects.toThrow(/permission|payroll:post|forbidden/i);
    const b = await db().payrollBatch.findUniqueOrThrow({ where: { id: s.batch.id } });
    expect(b.status).toBe("APPROVED");
    expect(b.glJournalEntryId).toBeNull();
  });

  it("§54 missing GL mapping: Post refuses; batch stays APPROVED; no JournalEntry", async () => {
    const s = await seedApprovedBatch({
      clubName: "Post Club D", submitterEmail: "sub.d@t.test", approverEmail: "ctrl.d@t.test",
    });
    const poster = await makeUser({ email: "poster.d@t.test", clubId: s.club.id, role: "CLUB_ADMIN" });
    const posterP = await principalFor("poster.d@t.test");
    // Remove the GL profile.
    await db().payrollClubConfig.update({
      where: { clubId: s.club.id },
      data: { glAccountingProfileId: null },
    });
    await expect(postPayrollBatch(posterP, s.batch.id))
      .rejects.toThrow(/PayrollGlAccountingProfile|MISSING_GLOBAL_PAYROLL_ACCOUNT|readiness failed/);
    const b = await db().payrollBatch.findUniqueOrThrow({ where: { id: s.batch.id } });
    expect(b.status).toBe("APPROVED");
    expect(b.glJournalEntryId).toBeNull();
    const jeCount = await db().journalEntry.count({
      where: { source: "PAYROLL", sourceEntityId: s.batch.id },
    });
    expect(jeCount).toBe(0);
  });

  it("§F preview identity: previewPayrollJournal produces the SAME line-set as the Post", async () => {
    const s = await seedApprovedBatch({
      clubName: "Post Club E", submitterEmail: "sub.e@t.test", approverEmail: "ctrl.e@t.test",
    });
    const preview = await previewPayrollJournal(s.approverP, s.club.id, s.batch.id);
    expect(preview.balanced).toBe(true);
    expect(Number(preview.totalDebits)).toBeCloseTo(Number(preview.totalCredits), 2);
    // Post the batch as a distinct Club Admin.
    const poster = await makeUser({ email: "poster.e@t.test", clubId: s.club.id, role: "CLUB_ADMIN" });
    const posterP = await principalFor("poster.e@t.test");
    const posted = await postPayrollBatch(posterP, s.batch.id);
    expect(posted.totalDebits).toBe(preview.totalDebits);
    expect(posted.totalCredits).toBe(preview.totalCredits);
  });

  it("§3-4 PAYROLL_READY_TO_POST card materialised on Approve; resolved on Post", async () => {
    // The Approve helper in `seedApprovedBatch` already fires approve.
    // Verify the Ready-to-Post WI item exists OPEN with correct owner.
    const s = await seedApprovedBatch({
      clubName: "Post Club F", submitterEmail: "sub.f@t.test", approverEmail: "ctrl.f@t.test",
    });
    const origin = await db().workIntakeOrigin.findFirst({
      where: {
        clubId: s.club.id, kind: "PAYROLL_READY_TO_POST",
        referenceId: s.batch.id, role: "PRIMARY",
      },
      include: { workIntakeItem: true },
    });
    expect(origin).not.toBeNull();
    expect(origin!.workIntakeItem.status).toBe("OPEN");
    // Two-person governance (2026-09-13): the Ready-to-Post card is
    // owned by the Controller who approved, not the Payroll Admin who
    // submitted.
    expect(origin!.workIntakeItem.ownerUserId).toBe(s.approver.id);
    // Post the batch as a Club Admin distinct from the submitter.
    const poster = await makeUser({ email: "poster.f@t.test", clubId: s.club.id, role: "CLUB_ADMIN" });
    const posterP = await principalFor("poster.f@t.test");
    await postPayrollBatch(posterP, s.batch.id);
    const afterOrigin = await db().workIntakeOrigin.findFirst({
      where: {
        clubId: s.club.id, kind: "PAYROLL_READY_TO_POST",
        referenceId: s.batch.id, role: "PRIMARY",
      },
      include: { workIntakeItem: true },
    });
    expect(afterOrigin!.workIntakeItem.status).toBe("RESOLVED");
    expect(afterOrigin!.workIntakeItem.resolvedAt).not.toBeNull();
  });
});
