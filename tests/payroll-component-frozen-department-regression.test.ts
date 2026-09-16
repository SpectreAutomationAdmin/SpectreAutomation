// Phase 3 follow-up (2026-09-16) — DB-backed component + frozen-
// department regression.
//
// Proves the founder-mandated invariant for the recurring-component
// path (which Phase 4 employee-recurring-component UI will build on):
//
//   Two employees, same recurring payroll component (Cell Phone
//   Allowance), same natural expense account. Different frozen
//   departments. After Prepare, mutate Employee B's live HR
//   department AND end the live recurring component assignment.
//   Approve + Post through the canonical domain services. Verify
//   the posted journal:
//
//     * Both cell-phone lines carry the SAME natural expense account.
//     * Employee A's line carries the frozen Administration department.
//     * Employee B's line carries the frozen Course & Grounds department
//       (NOT the mutated Events department).
//     * Events never appears on any journal line.
//     * Frozen amount is unchanged by the live assignment being ended.
//     * Preview and posted journal agree exactly on account +
//       department + debit + credit per line.
//     * A subsequent live mutation cannot alter the historical
//       posted journal.

import { describe, it, expect, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "./util/db";
import { approvePayrollBatch, postPayrollBatch } from "@/lib/payroll/approve-and-post";
import { previewPayrollJournal } from "@/lib/payroll/payroll-journal-preview";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function seedDepts(clubId: string) {
  const c = db();
  const admin   = await c.department.create({ data: { clubId, code: "ADMIN",   name: "Administration",   sortOrder: 1 } });
  const grounds = await c.department.create({ data: { clubId, code: "GROUNDS", name: "Course & Grounds", sortOrder: 2 } });
  const events  = await c.department.create({ data: { clubId, code: "EVENTS",  name: "Events",           sortOrder: 3 } });
  return { admin, grounds, events };
}

async function seedGlProfile(clubId: string) {
  const c = db();
  const acct = async (n: string, name: string, type: "EXPENSE" | "LIABILITY") =>
    c.account.create({
      data: {
        clubId, accountNumber: n, name, type,
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
  const cellExp  = await acct("6100", "Cell Phone Allowance Expense", "EXPENSE");
  const profile = await c.payrollGlAccountingProfile.create({
    data: {
      clubId,
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
  return { profile, cellExp, salary };
}

function frozenSourceFacts(deptId: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    coverage: {
      membershipEffectiveFrom: "2026-01-04T00:00:00.000Z",
      membershipEffectiveTo: null,
      coverageStart: "2026-01-04T00:00:00.000Z",
      coverageEnd:   "2026-01-18T00:00:00.000Z",
      coverageDays: 14, periodDays: 14, isFullPeriod: true,
    },
    identity: { dateOfBirth: "1980-01-01T00:00:00.000Z" },
    assignments: [{
      id: `asn-${deptId}`,
      role: "PRIMARY",
      departmentId: deptId,
      positionId: null,
      employmentType: "FULL_TIME",
      effectiveFrom: "2020-01-01T00:00:00.000Z",
      effectiveTo: null,
    }],
    compensations: [],
    allowances: [],
  });
}

describe("Phase 3 follow-up · DB-backed component + frozen-department regression", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("Same natural component account, two departments — frozen after live HR + recurring-component mutation", async () => {
    const c = db();
    const club = await makeClub("Component-Dept-Test");
    const submitter = await makeUser({ email: "pa.comp@t.test", clubId: club.id, role: "PAYROLL_ADMIN" });
    const controller = await makeUser({ email: "ctl.comp@t.test", clubId: club.id, role: "CONTROLLER" });
    const controllerP = await principalFor("ctl.comp@t.test");

    const depts = await seedDepts(club.id);
    const { profile, cellExp } = await seedGlProfile(club.id);

    // Fiscal year + period.
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
      update: { glAccountingProfileId: profile.id, payrollAdminUserId: submitter.id, controllerUserId: controller.id },
      create: { clubId: club.id, provinceOfEmployment: "AB",
        glAccountingProfileId: profile.id,
        payrollAdminUserId: submitter.id, controllerUserId: controller.id },
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

    // Cell Phone Allowance component — same natural expense account
    // for BOTH employees.
    const cellComp = await c.payrollComponent.create({
      data: {
        clubId: club.id, code: "CELL", displayName: "Cell Phone Allowance",
        category: "ALLOWANCE", side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
        displaySection: "EARNINGS", displayOrder: 10,
        calculationMethod: "FIXED_AMOUNT",
        expenseAccountId: cellExp.id,
        active: true,
      },
    });

    // Employees + primary assignments live-linked to Admin / Grounds.
    const empA = await c.employee.create({
      data: {
        clubId: club.id, firstName: "Ann", lastName: "Admin",
        employeeNumber: "T-A", hireDate: utc(2020, 1, 1),
        employeeLifecycle: "ACTIVE", timekeepingMethod: "NO_CLOCK",
        departmentId: depts.admin.id,
      },
    });
    const empB = await c.employee.create({
      data: {
        clubId: club.id, firstName: "Bob", lastName: "Grounds",
        employeeNumber: "T-B", hireDate: utc(2020, 1, 1),
        employeeLifecycle: "ACTIVE", timekeepingMethod: "NO_CLOCK",
        departmentId: depts.grounds.id,
      },
    });
    for (const e of [empA, empB]) {
      const deptId = e.id === empA.id ? depts.admin.id : depts.grounds.id;
      const assn = await c.employeeEmploymentAssignment.create({
        data: { clubId: club.id, employeeId: e.id, role: "PRIMARY",
                employmentType: "FULL_TIME", effectiveFrom: utc(2020, 1, 1),
                departmentId: deptId },
      });
      await c.employeeCompensation.create({
        data: { clubId: club.id, employeeId: e.id, assignmentId: assn.id,
                cadence: "SALARY", rate: "60000", currency: "CAD",
                effectiveFrom: utc(2020, 1, 1) },
      });
    }

    // Live recurring Cell Phone Allowance assignments — $75/pay for
    // each employee. These are the LIVE sources the Prepare phase
    // would have snapshotted.
    const recA = await c.employeeRecurringPayrollComponent.create({
      data: {
        clubId: club.id, employeeId: empA.id, componentId: cellComp.id,
        amount: new Prisma.Decimal("75.00"),
        effectiveFrom: utc(2020, 1, 1),
      },
    });
    const recB = await c.employeeRecurringPayrollComponent.create({
      data: {
        clubId: club.id, employeeId: empB.id, componentId: cellComp.id,
        amount: new Prisma.Decimal("75.00"),
        effectiveFrom: utc(2020, 1, 1),
      },
    });

    // Create the batch + prepared PayrollBatchEmployee rows with
    // frozen sourceFactsJson (each blob captures the primary
    // assignment's departmentId).
    const batch = await c.payrollBatch.create({
      data: {
        clubId: club.id, payGroupId: pg.id, payPeriodId: pp.id,
        sequence: 1, status: "SUBMITTED_FOR_APPROVAL",
        calculatedAt: new Date(), calculationVersion: 1,
        algorithmVersion: "spectre-payroll-test-1",
        submittedAt: new Date(), submittedByUserId: submitter.id,
      },
    });
    // Grosses INCLUDE the $75 cell-phone allowance. Statutory columns
    // are simplified so the arithmetic is easy to reason about.
    const beA = await c.payrollBatchEmployee.create({
      data: {
        clubId: club.id, batchId: batch.id, employeeId: empA.id,
        jurisdictionCountry: "CA", jurisdictionProvince: "AB",
        employeeLifecycleAtPrep: "ACTIVE", status: "INCLUDED", salaried: true,
        sourceFactsJson: frozenSourceFacts(depts.admin.id),
        grossPay:               new Prisma.Decimal("2575.00"),
        earningsTaxable:        new Prisma.Decimal("2575.00"),
        earningsPensionable:    new Prisma.Decimal("2575.00"),
        earningsInsurable:      new Prisma.Decimal("2575.00"),
        deductionCppEeCombined: new Prisma.Decimal("100.00"),
        deductionCpp2Ee:        new Prisma.Decimal("0.00"),
        deductionEiEe:          new Prisma.Decimal("40.00"),
        deductionFederalTax:    new Prisma.Decimal("300.00"),
        deductionProvincialTax: new Prisma.Decimal("100.00"),
        totalEmployeeDeductions: new Prisma.Decimal("540.00"),
        netPay:                 new Prisma.Decimal("2035.00"),
        employerCppCombined:    new Prisma.Decimal("100.00"),
        employerCpp2:           new Prisma.Decimal("0.00"),
        employerEi:             new Prisma.Decimal("56.00"),
      },
    });
    const beB = await c.payrollBatchEmployee.create({
      data: {
        clubId: club.id, batchId: batch.id, employeeId: empB.id,
        jurisdictionCountry: "CA", jurisdictionProvince: "AB",
        employeeLifecycleAtPrep: "ACTIVE", status: "INCLUDED", salaried: true,
        sourceFactsJson: frozenSourceFacts(depts.grounds.id),
        grossPay:               new Prisma.Decimal("3075.00"),
        earningsTaxable:        new Prisma.Decimal("3075.00"),
        earningsPensionable:    new Prisma.Decimal("3075.00"),
        earningsInsurable:      new Prisma.Decimal("3075.00"),
        deductionCppEeCombined: new Prisma.Decimal("120.00"),
        deductionCpp2Ee:        new Prisma.Decimal("0.00"),
        deductionEiEe:          new Prisma.Decimal("48.00"),
        deductionFederalTax:    new Prisma.Decimal("360.00"),
        deductionProvincialTax: new Prisma.Decimal("120.00"),
        totalEmployeeDeductions: new Prisma.Decimal("648.00"),
        netPay:                 new Prisma.Decimal("2427.00"),
        employerCppCombined:    new Prisma.Decimal("120.00"),
        employerCpp2:           new Prisma.Decimal("0.00"),
        employerEi:             new Prisma.Decimal("67.20"),
      },
    });

    // Frozen component snapshots — one per employee. Same natural
    // expense account. Frozen amount = $75 for each. `sourceAssignmentId`
    // links to the live recurring assignment; that link is what a
    // downstream mutation of the live assignment would change.
    await c.payrollBatchComponentSnapshot.create({
      data: {
        clubId: club.id, batchId: batch.id,
        batchEmployeeId: beA.id, employeeId: empA.id,
        sourceComponentId: cellComp.id,
        sourceAssignmentId: recA.id,
        provenance: "RECURRING_EMPLOYEE_SETUP",
        componentCode: "CELL", displayName: "Cell Phone Allowance",
        category: "ALLOWANCE", side: "EMPLOYEE",
        displaySection: "EARNINGS", displayOrder: 10,
        cashEffect: "INCREASES_NET_PAY",
        calculationMethod: "FIXED_AMOUNT",
        resolvedAmount: new Prisma.Decimal("75.00"),
        sourceEffectiveFrom: utc(2020, 1, 1),
        expenseAccountIdSnapshot: cellExp.id,
      },
    });
    await c.payrollBatchComponentSnapshot.create({
      data: {
        clubId: club.id, batchId: batch.id,
        batchEmployeeId: beB.id, employeeId: empB.id,
        sourceComponentId: cellComp.id,
        sourceAssignmentId: recB.id,
        provenance: "RECURRING_EMPLOYEE_SETUP",
        componentCode: "CELL", displayName: "Cell Phone Allowance",
        category: "ALLOWANCE", side: "EMPLOYEE",
        displaySection: "EARNINGS", displayOrder: 10,
        cashEffect: "INCREASES_NET_PAY",
        calculationMethod: "FIXED_AMOUNT",
        resolvedAmount: new Prisma.Decimal("75.00"),
        sourceEffectiveFrom: utc(2020, 1, 1),
        expenseAccountIdSnapshot: cellExp.id,
      },
    });

    // Frozen sanity — each snapshot has the same natural account,
    // and each batch-employee's source-facts blob froze a different
    // department.
    const snapshotsBeforeMutation = await c.payrollBatchComponentSnapshot.findMany({
      where: { batchId: batch.id },
      orderBy: [{ batchEmployeeId: "asc" }],
    });
    expect(snapshotsBeforeMutation.length).toBe(2);
    expect(new Set(snapshotsBeforeMutation.map((s) => s.expenseAccountIdSnapshot))).toEqual(new Set([cellExp.id]));
    const factsA = JSON.parse(beA.sourceFactsJson!);
    const factsB = JSON.parse(beB.sourceFactsJson!);
    expect(factsA.assignments[0].departmentId).toBe(depts.admin.id);
    expect(factsB.assignments[0].departmentId).toBe(depts.grounds.id);

    // MUTATE the live HR + live recurring component assignment for
    // Employee B AFTER Prepare. Live dept → Events; live recurring
    // assignment → ended before the pay period.
    await c.employee.update({
      where: { id: empB.id },
      data: { departmentId: depts.events.id },
    });
    await c.employeeEmploymentAssignment.updateMany({
      where: { employeeId: empB.id, role: "PRIMARY" },
      data: { departmentId: depts.events.id },
    });
    await c.employeeRecurringPayrollComponent.update({
      where: { id: recB.id },
      data: { effectiveTo: utc(2026, 1, 1) },
    });

    // Approve + Preview + Post through canonical services.
    await approvePayrollBatch(controllerP, batch.id);
    const preview = await previewPayrollJournal(controllerP, club.id, batch.id);
    expect(preview.balanced).toBe(true);

    // Preview should carry TWO Cell Phone Allowance debit lines,
    // same account, two different departments.
    const previewCell = preview.lines.filter((l) => l.accountNumber === "6100" && l.debit != null);
    expect(previewCell).toHaveLength(2);
    const previewCellDepts = previewCell.map((l) => l.departmentCode).sort();
    expect(previewCellDepts).toEqual(["ADMIN", "GROUNDS"]); // NOT "EVENTS"
    // Each cell line is $75.
    for (const l of previewCell) {
      expect(Number(l.debit)).toBe(75);
    }

    const posted = await postPayrollBatch(controllerP, batch.id);
    expect(posted.journalEntryId).toBeTruthy();

    const je = await c.journalEntry.findUnique({
      where: { id: posted.journalEntryId },
      include: {
        lines: {
          include: { account: true, department: true },
          orderBy: [{ lineNumber: "asc" }],
        },
      },
    });
    expect(je).toBeTruthy();
    expect(je!.status).toBe("POSTED");

    // A + B: two cell-phone debit lines, SAME natural account,
    // two DIFFERENT departments — the frozen ones.
    const cellLines = je!.lines.filter((l) => l.account.accountNumber === "6100");
    expect(cellLines).toHaveLength(2);
    const cellDeptCodes = cellLines.map((l) => l.department?.code).sort();
    expect(cellDeptCodes).toEqual(["ADMIN", "GROUNDS"]);
    for (const l of cellLines) {
      expect(l.account.name).toBe("Cell Phone Allowance Expense");
      expect(Number(l.debit ?? 0)).toBe(75);
    }
    // C: Events NEVER appears on any line.
    expect(je!.lines.every((l) => l.department?.code !== "EVENTS")).toBe(true);
    // D: Live recurring assignment was ended — the frozen snapshot
    // remains $75 and the posted line ALSO remains $75 (nothing
    // reads the live assignment at post time).
    const stillFrozen = await c.payrollBatchComponentSnapshot.findMany({
      where: { batchId: batch.id },
    });
    for (const s of stillFrozen) {
      expect(Number(s.resolvedAmount ?? 0)).toBe(75);
      expect(s.expenseAccountIdSnapshot).toBe(cellExp.id);
    }

    // E: preview and posted journal agree on account + department +
    // debit + credit for every line.
    const previewShaped = preview.lines.map((l) => ({
      accountNumber: l.accountNumber, deptCode: l.departmentCode ?? null,
      debit: l.debit,  credit: l.credit,
    })).sort((a, b) => (a.accountNumber + (a.deptCode ?? "")).localeCompare(b.accountNumber + (b.deptCode ?? "")));
    const postedShaped = je!.lines.map((l) => ({
      accountNumber: l.account.accountNumber, deptCode: l.department?.code ?? null,
      debit:  l.debit  != null ? new Prisma.Decimal(l.debit).toFixed(2)  : null,
      credit: l.credit != null ? new Prisma.Decimal(l.credit).toFixed(2) : null,
    })).sort((a, b) => (a.accountNumber + (a.deptCode ?? "")).localeCompare(b.accountNumber + (b.deptCode ?? "")));
    expect(previewShaped.length).toBe(postedShaped.length);
    for (let i = 0; i < previewShaped.length; i++) {
      expect(previewShaped[i].accountNumber).toBe(postedShaped[i].accountNumber);
      expect(previewShaped[i].deptCode).toBe(postedShaped[i].deptCode);
      if (previewShaped[i].debit != null) {
        expect(Number(previewShaped[i].debit)).toBeCloseTo(Number(postedShaped[i].debit), 2);
      }
      if (previewShaped[i].credit != null) {
        expect(Number(previewShaped[i].credit)).toBeCloseTo(Number(postedShaped[i].credit), 2);
      }
    }

    // F: after ANOTHER live mutation, the historical posted journal
    // remains byte-identical.
    await c.employee.update({
      where: { id: empB.id },
      data: { departmentId: depts.admin.id }, // wild live-dept swap
    });
    const jeAgain = await c.journalEntry.findUnique({
      where: { id: posted.journalEntryId },
      include: {
        lines: { include: { account: true, department: true }, orderBy: [{ lineNumber: "asc" }] },
      },
    });
    expect(jeAgain!.lines.length).toBe(je!.lines.length);
    for (let i = 0; i < je!.lines.length; i++) {
      expect(jeAgain!.lines[i].accountId).toBe(je!.lines[i].accountId);
      expect(jeAgain!.lines[i].departmentId).toBe(je!.lines[i].departmentId);
      expect(Number(jeAgain!.lines[i].debit ?? 0)).toBeCloseTo(Number(je!.lines[i].debit ?? 0), 2);
      expect(Number(jeAgain!.lines[i].credit ?? 0)).toBeCloseTo(Number(je!.lines[i].credit ?? 0), 2);
    }
  });
});
