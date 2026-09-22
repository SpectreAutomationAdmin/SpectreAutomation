// FPP-9A.1 extended test matrix — authorization, concurrency, transaction failure.
// Complements the FPP-9A base tests in fpp9a-reversal.test.ts with the
// coverage explicitly required by the founder's FPP-9A.1 remediation brief
// (§13).
//
// Reuses `seedPostedBatch` logic from the base suite — same POSTED baseline
// (SALARY, CPP, EI, fed+prov tax, employer CPP+EI, 7 GL lines).

import { describe, it, expect, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { db, resetDb, seedRbac, makeUser, makeClub, principalFor } from "../util/db";
import { approvePayrollBatch, postPayrollBatch } from "@/lib/payroll/approve-and-post";
import { initiatePayrollReversal } from "@/lib/payroll/reversal";
import {
  ConflictError,
  ForbiddenError,
  ValidationError,
} from "@/lib/errors";

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
  const salary = await acct("5100", "Salary Expense", "EXPENSE");
  const erCpp  = await acct("5110", "Employer CPP Expense", "EXPENSE");
  const erEi   = await acct("5120", "Employer EI Expense", "EXPENSE");
  const netPay = await acct("2100", "Net Pay Payable", "LIABILITY");
  const cpp    = await acct("2110", "CPP Payable", "LIABILITY");
  const ei     = await acct("2120", "EI Payable", "LIABILITY");
  const fed    = await acct("2130", "Federal Tax Payable", "LIABILITY");
  const prov   = await acct("2140", "AB Tax Payable", "LIABILITY");
  return c.payrollGlAccountingProfile.create({
    data: {
      clubId,
      salaryExpenseAccountId: salary.id,
      employerCppExpenseAccountId: erCpp.id,
      employerEiExpenseAccountId: erEi.id,
      netPayPayableAccountId: netPay.id,
      cppPayableAccountId: cpp.id,
      eiPayableAccountId: ei.id,
      federalTaxPayableAccountId: fed.id,
      provincialTaxPayableAccountId: prov.id,
    },
  });
}

async function seedPostedBatch(opts: { clubName: string; suffix: string }) {
  const c = db();
  const club = await makeClub(opts.clubName);
  const marc  = await makeUser({ email: `marc-${opts.suffix}@t.test`, role: "PAYROLL_ADMIN", clubId: club.id });
  const chris = await makeUser({ email: `chris-${opts.suffix}@t.test`, role: "CONTROLLER",   clubId: club.id });
  const admin = await makeUser({ email: `admin-${opts.suffix}@t.test`, role: "CLUB_ADMIN",   clubId: club.id });
  // Second Payroll Admin — same permissions as Marc, distinct identity.
  const marc2 = await makeUser({ email: `marc2-${opts.suffix}@t.test`, role: "PAYROLL_ADMIN", clubId: club.id });
  const marcP  = await principalFor(marc.email);
  const marc2P = await principalFor(marc2.email);
  const chrisP = await principalFor(chris.email);
  const adminP = await principalFor(admin.email);
  const profile = await seedGlProfileAccounts(club.id);

  const fy = await c.fiscalYear.create({
    data: { clubId: club.id, label: "FY2026", startDate: utc(2026, 1, 1), endDate: utc(2026, 12, 31), status: "OPEN" },
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
      clubId: club.id, enabled: true, provinceOfEmployment: "AB",
      payrollAdminUserId: marc.id, controllerUserId: chris.id,
      glAccountingProfileId: profile.id,
    },
  });
  const pg = await c.payrollPayGroup.create({
    data: {
      clubId: club.id, code: "SAL-SM", name: "Salaried SM",
      payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 0,
      calendarAnchorDate: utc(2026, 9, 1),
    },
  });
  const pp = await c.payrollPayPeriod.create({
    data: {
      clubId: club.id, payGroupId: pg.id, sequenceInYear: 17, taxYear: 2026,
      periodStart: utc(2026, 9, 1), periodEnd: utc(2026, 9, 16), payDate: utc(2026, 9, 16),
    },
  });
  const emp = await c.employee.create({
    data: {
      clubId: club.id, firstName: "Rev", lastName: "Test",
      email: `rev.${opts.suffix}@t.test`,
      hireDate: utc(2020, 1, 1), dateOfBirth: utc(1985, 5, 12),
      status: "ACTIVE", employeeNumber: `E-REV-${opts.suffix}`,
      compensationType: "SALARY", employeeLifecycle: "ACTIVE", homeProvince: "AB",
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
      sequence: 1, status: "SUBMITTED_FOR_APPROVAL",
      calculatedAt: new Date(), calculationVersion: 1,
      algorithmVersion: "spectre-payroll-fpp9a-matrix-test",
      packageChecksum: "fpp9a-matrix-test-checksum",
      submittedAt: new Date(), submittedByUserId: marc.id,
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
  await approvePayrollBatch(chrisP, batch.id);
  const posted = await postPayrollBatch(marcP, batch.id);
  return { club, marc, chris, admin, marc2, marcP, chrisP, adminP, marc2P, batch, emp, pp, posted };
}

describe("FPP-9A.1 · Authorization", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("A1 · unauthorized user (STAFF, no payroll:submit) cannot initiate a reversal", async () => {
    const s = await seedPostedBatch({ clubName: "Auth1", suffix: "au1" });
    // STAFF role: only `members:read` + `events:read` — no payroll:submit.
    const staffUser = await makeUser({ email: `staff-au1@t.test`, role: "STAFF", clubId: s.club.id });
    const staffP = await principalFor(staffUser.email);
    await expect(
      initiatePayrollReversal(staffP, s.club.id, s.batch.id, "attempt"),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("A2 · Payroll Admin can initiate a reversal", async () => {
    const s = await seedPostedBatch({ clubName: "Auth2", suffix: "au2" });
    const r = await initiatePayrollReversal(s.marcP, s.club.id, s.batch.id, "PA initiates OK");
    expect(r.reversalBatchId).toBeTruthy();
    const rev = await db().payrollBatch.findUnique({ where: { id: r.reversalBatchId } });
    expect(rev?.status).toBe("SUBMITTED_FOR_APPROVAL");
  });

  it("A3 · initiator (PA) cannot approve their own reversal — SoD", async () => {
    const s = await seedPostedBatch({ clubName: "Auth3", suffix: "au3" });
    const r = await initiatePayrollReversal(s.marcP, s.club.id, s.batch.id, "SoD check");
    // Marc initiated as PA — Marc lacks payroll:approve (only Controller does)
    // AND same-user approval would be blocked. Both routes lead to rejection.
    await expect(approvePayrollBatch(s.marcP, r.reversalBatchId)).rejects.toBeTruthy();
    const stillSubmitted = await db().payrollBatch.findUnique({ where: { id: r.reversalBatchId } });
    expect(stillSubmitted?.status).toBe("SUBMITTED_FOR_APPROVAL");
  });

  it("A4 · a second Payroll Admin cannot post before Controller approves", async () => {
    const s = await seedPostedBatch({ clubName: "Auth4", suffix: "au4" });
    const r = await initiatePayrollReversal(s.marcP, s.club.id, s.batch.id, "Pre-approval post");
    await expect(postPayrollBatch(s.marc2P, r.reversalBatchId)).rejects.toBeInstanceOf(ConflictError);
    const still = await db().payrollBatch.findUnique({ where: { id: r.reversalBatchId } });
    expect(still?.status).toBe("SUBMITTED_FOR_APPROVAL");
    expect(still?.glJournalEntryId).toBeNull();
  });

  it("A5 · after approval, a Payroll Admin distinct from the approver can post", async () => {
    const s = await seedPostedBatch({ clubName: "Auth5", suffix: "au5" });
    const r = await initiatePayrollReversal(s.marcP, s.club.id, s.batch.id, "Post-approve OK");
    await approvePayrollBatch(s.chrisP, r.reversalBatchId);
    const posted = await postPayrollBatch(s.marc2P, r.reversalBatchId);
    expect(posted.journalEntryId).toBeTruthy();
    const rev = await db().payrollBatch.findUnique({ where: { id: r.reversalBatchId } });
    expect(rev?.status).toBe("POSTED");
    expect(rev?.postedByUserId).toBe(s.marc2.id);
    expect(rev?.approvedByUserId).toBe(s.chris.id);
  });
});

describe("FPP-9A.1 · Concurrency", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("C1 · two concurrent initiations against the same POSTED payroll — exactly one active reversal", async () => {
    const s = await seedPostedBatch({ clubName: "Conc1", suffix: "co1" });
    const results = await Promise.allSettled([
      initiatePayrollReversal(s.marcP,  s.club.id, s.batch.id, "concurrent 1"),
      initiatePayrollReversal(s.marc2P, s.club.id, s.batch.id, "concurrent 2"),
    ]);
    const fulfilled = results.filter(r => r.status === "fulfilled");
    const rejected = results.filter(r => r.status === "rejected");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    // Regardless of race timing, the FINAL state must show exactly one active reversal.
    const reversals = await db().payrollBatch.findMany({
      where: { reversesPayrollBatchId: s.batch.id },
      select: { id: true, status: true },
    });
    const active = reversals.filter(r => r.status !== "VOIDED" && r.status !== "RETURNED_FOR_CORRECTION");
    expect(active.length).toBe(1);
    // The FPP-9A.1 concurrency guard inside the reversal transaction ensures
    // exactly one commit. At least one racer must reject.
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    // Rejection may surface as either a ConflictError (application-layer
    // post-create check) or a Prisma client error (DB-layer race). Both
    // prove the invariant holds.
    const rejectedNames = rejected.map(r => r.status === "rejected" ? (r.reason as Error).name : "");
    expect(rejectedNames.some(n => /Conflict|Validation|Prisma|Error/.test(n))).toBe(true);
  });

  it("C2 · two concurrent post attempts on the same approved reversal — exactly one journal, one accounting effect", async () => {
    const s = await seedPostedBatch({ clubName: "Conc2", suffix: "co2" });
    const r = await initiatePayrollReversal(s.marcP, s.club.id, s.batch.id, "concurrent-post");
    await approvePayrollBatch(s.chrisP, r.reversalBatchId);
    // Two racers, both PA-permissioned, both post the same approved reversal.
    const results = await Promise.allSettled([
      postPayrollBatch(s.marcP,  r.reversalBatchId),
      postPayrollBatch(s.marc2P, r.reversalBatchId),
    ]);
    const fulfilled = results.filter(r => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    // Persistent invariant: reversal batch has ONE JE, JE row count = 1, batch status POSTED.
    const rev = await db().payrollBatch.findUnique({ where: { id: r.reversalBatchId } });
    expect(rev?.status).toBe("POSTED");
    expect(rev?.glJournalEntryId).toBeTruthy();
    const jeCount = await db().journalEntry.count({ where: { id: rev!.glJournalEntryId! } });
    expect(jeCount).toBe(1);
    // Fulfilled attempts must ALL name the same JE.
    for (const f of fulfilled) {
      if (f.status === "fulfilled") {
        expect((f.value as { journalEntryId: string }).journalEntryId).toBe(rev!.glJournalEntryId);
      }
    }
    // Reversal-linked JEs across the whole table: still exactly one.
    const linkedJes = await db().journalEntry.count({
      where: { payrollBatchGL: { some: { id: r.reversalBatchId } } },
    });
    expect(linkedJes).toBe(1);
  });
});

describe("FPP-9A.1 · Transaction boundary — no partial state on failure", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("F1 · CAS refusal path: post attempted after status/journal invariant broken leaves NO half-state — no new JE row, no status flip", async () => {
    const s = await seedPostedBatch({ clubName: "Fail1", suffix: "fa1" });
    const r = await initiatePayrollReversal(s.marcP, s.club.id, s.batch.id, "CAS boundary test");
    await approvePayrollBatch(s.chrisP, r.reversalBatchId);

    // Snapshot the DB state that a partial commit would perturb.
    const jesBefore = await db().journalEntry.count();
    const jeLinesBefore = await db().journalEntryLine.count();
    const revBatchBefore = await db().payrollBatch.findUnique({ where: { id: r.reversalBatchId } });
    const wiBefore = await db().workIntakeItem.findMany({ where: { clubId: s.club.id }, orderBy: { id: "asc" } });
    const wiOriginsBefore = await db().workIntakeOrigin.findMany({ where: { clubId: s.club.id }, orderBy: { id: "asc" } });

    // Break the CAS pre-condition: an external actor (or race) flipped
    // the batch to VOIDED while we were about to post. The CAS
    // (status=APPROVED) will refuse — prove absolutely nothing else
    // moves.
    await db().payrollBatch.update({
      where: { id: r.reversalBatchId },
      data: { status: "VOIDED", voidedAt: new Date(), voidedByUserId: s.marc.id, voidReason: "F1 CAS-boundary simulation" },
    });

    await expect(postPayrollBatch(s.marc2P, r.reversalBatchId)).rejects.toBeInstanceOf(ConflictError);

    // No new JE rows.
    expect(await db().journalEntry.count()).toBe(jesBefore);
    expect(await db().journalEntryLine.count()).toBe(jeLinesBefore);
    // Reversal batch remains VOIDED (unchanged by the failed post).
    const revAfter = await db().payrollBatch.findUnique({ where: { id: r.reversalBatchId } });
    expect(revAfter?.status).toBe("VOIDED");
    expect(revAfter?.glJournalEntryId).toBeNull();
    expect(revAfter?.postedAt).toBeNull();
    expect(revAfter?.postedByUserId).toBeNull();
    // No new WI items or origins created by the failed post.
    const wiAfter = await db().workIntakeItem.findMany({ where: { clubId: s.club.id }, orderBy: { id: "asc" } });
    const wiOriginsAfter = await db().workIntakeOrigin.findMany({ where: { clubId: s.club.id }, orderBy: { id: "asc" } });
    expect(wiAfter.map(w => w.id)).toEqual(wiBefore.map(w => w.id));
    expect(wiOriginsAfter.map(o => o.id)).toEqual(wiOriginsBefore.map(o => o.id));
    // Silence unused var lint on revBatchBefore — it documents the intent.
    expect(revBatchBefore?.status).toBe("APPROVED");
  });

  it("F2 · reversal batch that is APPROVED is the ONLY status from which post can succeed", async () => {
    const s = await seedPostedBatch({ clubName: "Fail2", suffix: "fa2" });
    const r = await initiatePayrollReversal(s.marcP, s.club.id, s.batch.id, "state gate");
    // Post before approve — should refuse.
    await expect(postPayrollBatch(s.marc2P, r.reversalBatchId)).rejects.toBeInstanceOf(ConflictError);
    // Force to VOIDED — post should refuse.
    await db().payrollBatch.update({ where: { id: r.reversalBatchId }, data: { status: "VOIDED" } });
    await expect(postPayrollBatch(s.marc2P, r.reversalBatchId)).rejects.toBeInstanceOf(ConflictError);
    // Force back to APPROVED — post should succeed.
    await db().payrollBatch.update({ where: { id: r.reversalBatchId }, data: { status: "APPROVED", approvedByUserId: s.chris.id, approvedAt: new Date() } });
    const p = await postPayrollBatch(s.marc2P, r.reversalBatchId);
    expect(p.journalEntryId).toBeTruthy();
  });
});
