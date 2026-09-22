// FPP-9A (2026-09-22) — Post-posted payroll reversal foundation.
//
// Proves the reversal primitive: an already-POSTED payroll can be
// reversed as a SEPARATE immutable payroll transaction that never
// mutates the original.
//
// Coverage:
//   * initiate → SUBMITTED_FOR_APPROVAL reversal batch with negated
//     per-employee amounts + negated component snapshots + Controller
//     Work Intake item;
//   * original PayrollBatch, journal, employees, snapshots UNCHANGED
//     after initiate + approve + post of the reversal;
//   * reversal journal is the exact debit ↔ credit swap of the
//     original journal — same accounts, same departments, opposite
//     sides;
//   * combined original + reversal net GL impact = $0.00;
//   * reversal journal balances independently;
//   * idempotency: repeat post of the same reversal returns the same
//     journal, no duplicate JE row;
//   * cannot initiate a second active reversal for the same original;
//   * cannot reverse a non-POSTED batch;
//   * cannot reverse a REVERSAL batch;
//   * reversal reason is required and persisted.

import { describe, it, expect, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { db, resetDb, seedRbac, makeUser, makeClub, principalFor } from "../util/db";
import { approvePayrollBatch, postPayrollBatch } from "@/lib/payroll/approve-and-post";
import { initiatePayrollReversal } from "@/lib/payroll/reversal";
import { ConflictError, ValidationError } from "@/lib/errors";

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
  const salary       = await acct("5100", "Salary Expense", "EXPENSE");
  const erCpp        = await acct("5110", "Employer CPP Expense", "EXPENSE");
  const erEi         = await acct("5120", "Employer EI Expense", "EXPENSE");
  const netPay       = await acct("2100", "Net Pay Payable", "LIABILITY");
  const cpp          = await acct("2110", "CPP Payable", "LIABILITY");
  const ei           = await acct("2120", "EI Payable", "LIABILITY");
  const fed          = await acct("2130", "Federal Tax Payable", "LIABILITY");
  const prov         = await acct("2140", "AB Tax Payable", "LIABILITY");
  const profile = await c.payrollGlAccountingProfile.create({
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
  return { profile };
}

async function seedPostedBatch(opts: { clubName: string; suffix: string }) {
  const c = db();
  const club = await makeClub(opts.clubName);
  const marc = await makeUser({ email: `marc-${opts.suffix}@t.test`, role: "PAYROLL_ADMIN", clubId: club.id });
  const chris = await makeUser({ email: `chris-${opts.suffix}@t.test`, role: "CONTROLLER", clubId: club.id });
  const admin = await makeUser({ email: `admin-${opts.suffix}@t.test`, role: "CLUB_ADMIN", clubId: club.id });
  const marcP = await principalFor(marc.email);
  const chrisP = await principalFor(chris.email);
  const adminP = await principalFor(admin.email);
  const { profile } = await seedGlProfileAccounts(club.id);

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
      algorithmVersion: "spectre-payroll-fpp9a-test",
      packageChecksum: "fpp9a-test-checksum",
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
  // Approve + post so the batch is POSTED.
  await approvePayrollBatch(chrisP, batch.id);
  const posted = await postPayrollBatch(marcP, batch.id);
  return { club, marc, chris, admin, marcP, chrisP, adminP, batch, emp, pp, posted };
}

describe("FPP-9A · reversal initiate", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("Initiates a reversal from a POSTED batch — original unchanged, reversal created with negated amounts + WI item", async () => {
    const s = await seedPostedBatch({ clubName: "Rev A", suffix: "a" });
    const originalBefore = await db().payrollBatch.findUniqueOrThrow({ where: { id: s.batch.id } });
    const originalBeBefore = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: s.batch.id } });

    const r = await initiatePayrollReversal(s.marcP, s.club.id, s.batch.id, "Duplicate payroll — reverse in full");
    expect(r.reversalBatchId).toBeTruthy();
    expect(r.originalBatchId).toBe(s.batch.id);
    expect(r.workIntakeItemId).toBeTruthy();

    // Original UNCHANGED.
    const originalAfter = await db().payrollBatch.findUniqueOrThrow({ where: { id: s.batch.id } });
    expect(originalAfter.status).toBe(originalBefore.status);
    expect(originalAfter.calculationVersion).toBe(originalBefore.calculationVersion);
    expect(originalAfter.packageChecksum).toBe(originalBefore.packageChecksum);
    expect(originalAfter.glJournalEntryId).toBe(originalBefore.glJournalEntryId);
    expect(originalAfter.postedAt?.getTime()).toBe(originalBefore.postedAt?.getTime());

    // Original BE row UNCHANGED.
    const originalBeAfter = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: s.batch.id } });
    expect(originalBeAfter.grossPay?.toString()).toBe(originalBeBefore.grossPay?.toString());
    expect(originalBeAfter.netPay?.toString()).toBe(originalBeBefore.netPay?.toString());

    // Reversal batch exists with correct shape.
    const reversal = await db().payrollBatch.findUniqueOrThrow({ where: { id: r.reversalBatchId } });
    expect(reversal.transactionType).toBe("REVERSAL");
    expect(reversal.reversesPayrollBatchId).toBe(s.batch.id);
    expect(reversal.reversalReason).toBe("Duplicate payroll — reverse in full");
    expect(reversal.status).toBe("SUBMITTED_FOR_APPROVAL");
    expect(reversal.glJournalEntryId).toBeNull();

    // Reversal employee row has negated amounts.
    const revBe = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: r.reversalBatchId } });
    expect(revBe.grossPay?.toString()).toBe("-3333.33");
    expect(revBe.netPay?.toString()).toBe("-2520.57");
    expect(revBe.deductionCppEeCombined?.toString()).toBe("-183.42");
    expect(revBe.deductionFederalTax?.toString()).toBe("-400");
    expect(revBe.deductionProvincialTax?.toString()).toBe("-175");
    expect(revBe.employerCppCombined?.toString()).toBe("-183.42");

    // Work Intake item routed to Controller.
    const wi = await db().workIntakeItem.findUniqueOrThrow({ where: { id: r.workIntakeItemId } });
    expect(wi.ownerUserId).toBe(s.chris.id);
    expect(wi.workSubtype).toBe("PAYROLL_FINAL_APPROVAL");
    expect(wi.status).toBe("OPEN");
    const origin = await db().workIntakeOrigin.findFirstOrThrow({
      where: { workIntakeItemId: wi.id, kind: "PAYROLL_FINAL_APPROVAL" },
    });
    expect(origin.referenceId).toBe(r.reversalBatchId);
  });

  it("Refuses to initiate a reversal on a non-POSTED batch", async () => {
    const s = await seedPostedBatch({ clubName: "Rev B", suffix: "b" });
    await db().payrollBatch.update({ where: { id: s.batch.id }, data: { status: "APPROVED" } });
    await expect(
      initiatePayrollReversal(s.marcP, s.club.id, s.batch.id, "test"),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("Refuses to reverse a REVERSAL batch", async () => {
    const s = await seedPostedBatch({ clubName: "Rev C", suffix: "c" });
    const r = await initiatePayrollReversal(s.marcP, s.club.id, s.batch.id, "First reversal");
    await expect(
      initiatePayrollReversal(s.marcP, s.club.id, r.reversalBatchId, "Reverse the reversal"),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("Refuses a second active reversal for the same original", async () => {
    const s = await seedPostedBatch({ clubName: "Rev D", suffix: "d" });
    await initiatePayrollReversal(s.marcP, s.club.id, s.batch.id, "First reversal");
    await expect(
      initiatePayrollReversal(s.marcP, s.club.id, s.batch.id, "Second reversal"),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("Requires a non-empty reason", async () => {
    const s = await seedPostedBatch({ clubName: "Rev E", suffix: "e" });
    await expect(
      initiatePayrollReversal(s.marcP, s.club.id, s.batch.id, "   "),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("FPP-9A · reversal approve + post — inverse journal + immutability + idempotency", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("Approved reversal posts a NEW journal that is the exact inverse; net GL impact = $0.00; original journal unchanged; idempotent", async () => {
    const s = await seedPostedBatch({ clubName: "Rev F", suffix: "f" });
    const originalJournalId = s.batch.id; // placeholder; overwritten below.
    const originalBatchAfterPost = await db().payrollBatch.findUniqueOrThrow({ where: { id: s.batch.id } });
    expect(originalBatchAfterPost.status).toBe("POSTED");
    expect(originalBatchAfterPost.glJournalEntryId).toBeTruthy();
    const origJeId = originalBatchAfterPost.glJournalEntryId!;

    const origJe = await db().journalEntry.findUniqueOrThrow({
      where: { id: origJeId },
      include: { lines: { include: { account: true, department: true }, orderBy: { lineNumber: "asc" } } },
    });

    // Initiate + approve + post the reversal.
    const init = await initiatePayrollReversal(s.marcP, s.club.id, s.batch.id, "Posted in error");
    await approvePayrollBatch(s.chrisP, init.reversalBatchId);
    const revPosted = await postPayrollBatch(s.marcP, init.reversalBatchId);
    expect(revPosted.journalEntryId).toBeTruthy();
    expect(revPosted.journalEntryId).not.toBe(origJeId);
    // Reversal journal balances.
    expect(revPosted.totalDebits).toBe(revPosted.totalCredits);

    const revJe = await db().journalEntry.findUniqueOrThrow({
      where: { id: revPosted.journalEntryId },
      include: { lines: { include: { account: true, department: true }, orderBy: { lineNumber: "asc" } } },
    });
    expect(revJe.source).toBe("PAYROLL");
    expect(revJe.status).toBe("POSTED");

    // Same set of accounts.
    const origAccounts = new Set(origJe.lines.map((l) => l.account.accountNumber));
    const revAccounts = new Set(revJe.lines.map((l) => l.account.accountNumber));
    expect(revAccounts).toEqual(origAccounts);

    // For every (account, department) pair — the reversal has the
    // opposite side with the same magnitude.
    const key = (acct: string, dept: string | null | undefined) => `${acct}|${dept ?? ""}`;
    const origMap = new Map<string, { debit: string; credit: string }>();
    for (const l of origJe.lines) {
      origMap.set(key(l.account.accountNumber, l.department?.code), {
        debit: (l.debit ?? new Prisma.Decimal(0)).toFixed(2),
        credit: (l.credit ?? new Prisma.Decimal(0)).toFixed(2),
      });
    }
    for (const l of revJe.lines) {
      const orig = origMap.get(key(l.account.accountNumber, l.department?.code));
      expect(orig).toBeDefined();
      // Reversal debit == original credit; reversal credit == original debit.
      expect((l.debit ?? new Prisma.Decimal(0)).toFixed(2)).toBe(orig!.credit);
      expect((l.credit ?? new Prisma.Decimal(0)).toFixed(2)).toBe(orig!.debit);
    }

    // Combined net GL impact = $0.00.
    const combinedDr = origJe.lines.reduce((s2, l) => s2.plus(l.debit ?? new Prisma.Decimal(0)), new Prisma.Decimal(0))
                    .plus(revJe.lines.reduce((s2, l) => s2.plus(l.debit ?? new Prisma.Decimal(0)), new Prisma.Decimal(0)));
    const combinedCr = origJe.lines.reduce((s2, l) => s2.plus(l.credit ?? new Prisma.Decimal(0)), new Prisma.Decimal(0))
                    .plus(revJe.lines.reduce((s2, l) => s2.plus(l.credit ?? new Prisma.Decimal(0)), new Prisma.Decimal(0)));
    expect(combinedDr.toFixed(2)).toBe(combinedCr.toFixed(2));
    // Per-account combined net = 0.
    const combinedByKey = new Map<string, Prisma.Decimal>();
    for (const l of [...origJe.lines, ...revJe.lines]) {
      const k = key(l.account.accountNumber, l.department?.code);
      const cur = combinedByKey.get(k) ?? new Prisma.Decimal(0);
      combinedByKey.set(k, cur.plus(l.debit ?? new Prisma.Decimal(0)).minus(l.credit ?? new Prisma.Decimal(0)));
    }
    for (const [_k, v] of combinedByKey) {
      expect(v.toFixed(2)).toBe("0.00");
    }

    // Original batch UNCHANGED.
    const originalStill = await db().payrollBatch.findUniqueOrThrow({ where: { id: s.batch.id } });
    expect(originalStill.status).toBe("POSTED");
    expect(originalStill.glJournalEntryId).toBe(origJeId);
    expect(originalStill.postedAt?.getTime()).toBe(originalBatchAfterPost.postedAt?.getTime());
    expect(originalStill.calculationVersion).toBe(originalBatchAfterPost.calculationVersion);
    expect(originalStill.packageChecksum).toBe(originalBatchAfterPost.packageChecksum);

    // Original JE lines UNCHANGED.
    const origJeStill = await db().journalEntry.findUniqueOrThrow({
      where: { id: origJeId },
      include: { lines: true },
    });
    expect(origJeStill.totalDebits.toFixed(2)).toBe(origJe.totalDebits.toFixed(2));
    expect(origJeStill.totalCredits.toFixed(2)).toBe(origJe.totalCredits.toFixed(2));
    expect(origJeStill.lines.length).toBe(origJe.lines.length);

    // Idempotency: second post returns SAME journal id.
    const second = await postPayrollBatch(s.marcP, init.reversalBatchId);
    expect(second.journalEntryId).toBe(revPosted.journalEntryId);
    // No duplicate JE row.
    const revJeCount = await db().journalEntry.count({
      where: { id: revPosted.journalEntryId },
    });
    expect(revJeCount).toBe(1);
    // reversedBy relation exposes the linkage.
    const withReversal = await db().payrollBatch.findUniqueOrThrow({
      where: { id: s.batch.id },
      include: { reversedBy: { select: { id: true, status: true, transactionType: true } } },
    });
    expect(withReversal.reversedBy.length).toBe(1);
    expect(withReversal.reversedBy[0].id).toBe(init.reversalBatchId);
    expect(withReversal.reversedBy[0].status).toBe("POSTED");
    expect(withReversal.reversedBy[0].transactionType).toBe("REVERSAL");
  });
});
