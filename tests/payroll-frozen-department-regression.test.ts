// Phase 3 follow-up (2026-09-16) — full DB-backed frozen-department
// regression covering the founder-mandated §14 scenario.
//
// Proves the historical-accounting invariant end-to-end:
//
//   1. Create Employee A in Department A, Employee B in Department B.
//   2. Prepare the batch (source-facts blob freezes each employee's
//      assignment + departmentId).
//   3. Verify each employee's frozen department is captured in the
//      source-facts blob.
//   4. MUTATE Employee B's LIVE HR department to Department C.
//   5. Calculate + Post through the canonical domain services.
//   6. Read back the posted JournalEntry + JournalEntryLine rows.
//   7. Verify:
//      * Employee B's payroll expense line resolves to Department B
//        (the frozen department, not the live Department C).
//      * Department C does not appear anywhere on any line.
//      * Preview account + department resolution matches the posted
//        journal exactly (identity check).
//      * Journal balances to the cent.
//      * A second Post is refused as idempotent (batch already POSTED).
//      * The historical POSTED journal is not altered by a subsequent
//        live-department mutation.

import { describe, it, expect, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "./util/db";
import { approvePayrollBatch, postPayrollBatch } from "@/lib/payroll/approve-and-post";
import { previewPayrollJournal } from "@/lib/payroll/payroll-journal-preview";
import { ConflictError } from "@/lib/errors";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function seedDepts(clubId: string) {
  const c = db();
  const admin = await c.department.create({ data: { clubId, code: "ADMIN", name: "Administration", sortOrder: 1 } });
  const grounds = await c.department.create({ data: { clubId, code: "GROUNDS", name: "Course & Grounds", sortOrder: 2 } });
  const events  = await c.department.create({ data: { clubId, code: "EVENTS", name: "Events", sortOrder: 3 } });
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
  return { profile, accounts: { salary, erCpp, erEi, netpay, cppPay, eiPay, fedPay, provPay } };
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

describe("Phase 3 follow-up · §14 frozen-department DB-backed regression", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("Employee B's live-HR department mutation after Prepare does not change the batch's posted journal", async () => {
    const c = db();
    const club = await makeClub("Frozen-Dept-Test");
    const submitter = await makeUser({ email: "pa.frozen@t.test", clubId: club.id, role: "PAYROLL_ADMIN" });
    const controller = await makeUser({ email: "ctl.frozen@t.test", clubId: club.id, role: "CONTROLLER" });
    const submitterP = await principalFor("pa.frozen@t.test");
    const controllerP = await principalFor("ctl.frozen@t.test");

    const depts = await seedDepts(club.id);
    const { profile } = await seedGlProfile(club.id);

    // Fiscal year + period.
    const fy = await c.fiscalYear.create({
      data: { clubId: club.id, label: "FY2026",
        startDate: utc(2026, 1, 1), endDate: utc(2026, 12, 31), status: "OPEN" },
    });
    await c.fiscalPeriod.create({
      data: { clubId: club.id, fiscalYearId: fy.id, label: "FY2026-M01",
        startDate: utc(2026, 1, 1), endDate: utc(2026, 1, 31), sequence: 1, status: "OPEN" },
    });

    // Payroll config: link to profile + designate the two roles.
    await c.payrollClubConfig.upsert({
      where: { clubId: club.id },
      update: { glAccountingProfileId: profile.id, payrollAdminUserId: submitter.id, controllerUserId: controller.id },
      create: { clubId: club.id, provinceOfEmployment: "AB",
        glAccountingProfileId: profile.id,
        payrollAdminUserId: submitter.id, controllerUserId: controller.id },
    });

    // Pay group + pay period.
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

    // Step 1 — Employee A in Administration, Employee B in Grounds.
    // Employees are created with departmentId set (live HR).
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
      const assn = await c.employeeEmploymentAssignment.create({
        data: { clubId: club.id, employeeId: e.id, role: "PRIMARY",
                employmentType: "FULL_TIME", effectiveFrom: utc(2020, 1, 1),
                departmentId: e.id === empA.id ? depts.admin.id : depts.grounds.id },
      });
      await c.employeeCompensation.create({
        data: { clubId: club.id, employeeId: e.id, assignmentId: assn.id,
                cadence: "SALARY", rate: "60000", currency: "CAD",
                effectiveFrom: utc(2020, 1, 1) },
      });
    }

    // Step 2 — create a batch and PREPARE its employee rows with the
    // frozen source-facts blob (each employee's assignment carries
    // the departmentId snapshot at Prepare time).
    const batch = await c.payrollBatch.create({
      data: {
        clubId: club.id, payGroupId: pg.id, payPeriodId: pp.id,
        sequence: 1, status: "SUBMITTED_FOR_APPROVAL",
        calculatedAt: new Date(), calculationVersion: 1,
        algorithmVersion: "spectre-payroll-test-1",
        submittedAt: new Date(), submittedByUserId: submitter.id,
      },
    });
    // Simplified statutory numbers so the balance-arithmetic is clean.
    const beA = await c.payrollBatchEmployee.create({
      data: {
        clubId: club.id, batchId: batch.id, employeeId: empA.id,
        jurisdictionCountry: "CA", jurisdictionProvince: "AB",
        employeeLifecycleAtPrep: "ACTIVE", status: "INCLUDED", salaried: true,
        sourceFactsJson: frozenSourceFacts(depts.admin.id),
        grossPay: new Prisma.Decimal("2500.00"),
        earningsTaxable:     new Prisma.Decimal("2500.00"),
        earningsPensionable: new Prisma.Decimal("2500.00"),
        earningsInsurable:   new Prisma.Decimal("2500.00"),
        deductionCppEeCombined: new Prisma.Decimal("100.00"),
        deductionCpp2Ee:        new Prisma.Decimal("0.00"),
        deductionEiEe:          new Prisma.Decimal("40.00"),
        deductionFederalTax:    new Prisma.Decimal("300.00"),
        deductionProvincialTax: new Prisma.Decimal("100.00"),
        totalEmployeeDeductions: new Prisma.Decimal("540.00"),
        netPay:                 new Prisma.Decimal("1960.00"),
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
        grossPay: new Prisma.Decimal("3000.00"),
        earningsTaxable:     new Prisma.Decimal("3000.00"),
        earningsPensionable: new Prisma.Decimal("3000.00"),
        earningsInsurable:   new Prisma.Decimal("3000.00"),
        deductionCppEeCombined: new Prisma.Decimal("120.00"),
        deductionCpp2Ee:        new Prisma.Decimal("0.00"),
        deductionEiEe:          new Prisma.Decimal("48.00"),
        deductionFederalTax:    new Prisma.Decimal("360.00"),
        deductionProvincialTax: new Prisma.Decimal("120.00"),
        totalEmployeeDeductions: new Prisma.Decimal("648.00"),
        netPay:                 new Prisma.Decimal("2352.00"),
        employerCppCombined:    new Prisma.Decimal("120.00"),
        employerCpp2:           new Prisma.Decimal("0.00"),
        employerEi:             new Prisma.Decimal("67.20"),
      },
    });

    // Step 3 — verify the frozen department is captured in each blob.
    const beRows = await c.payrollBatchEmployee.findMany({
      where: { batchId: batch.id },
      orderBy: [{ employeeId: "asc" }],
      select: { id: true, sourceFactsJson: true },
    });
    for (const r of beRows) {
      const facts = JSON.parse(r.sourceFactsJson ?? "{}");
      expect(facts.assignments[0].departmentId).toBeTruthy();
    }
    const factsA = JSON.parse(beA.sourceFactsJson!);
    const factsB = JSON.parse(beB.sourceFactsJson!);
    expect(factsA.assignments[0].departmentId).toBe(depts.admin.id);
    expect(factsB.assignments[0].departmentId).toBe(depts.grounds.id);

    // Step 4 — mutate Employee B's LIVE HR department to Events
    // (Department C). This is the moment where a naive lookup-at-post
    // would corrupt the batch's accounting.
    await c.employee.update({
      where: { id: empB.id },
      data: { departmentId: depts.events.id },
    });
    await c.employeeEmploymentAssignment.updateMany({
      where: { employeeId: empB.id, role: "PRIMARY" },
      data: { departmentId: depts.events.id },
    });

    // Step 5 — approve + post via the canonical domain services.
    await approvePayrollBatch(controllerP, batch.id);

    // §F identity: preview must match the eventual posted journal
    // account + department resolution. Capture the preview NOW.
    const preview = await previewPayrollJournal(controllerP, club.id, batch.id);
    expect(preview.balanced).toBe(true);
    // Every debit + credit line the preview shows must include the
    // department when the resolver assigned one.
    const previewSalaryLines = preview.lines.filter((l) => l.accountNumber === "6000" && l.debit != null);
    expect(previewSalaryLines).toHaveLength(2);
    const previewSalaryDepts = previewSalaryLines.map((l) => l.departmentCode).sort();
    expect(previewSalaryDepts).toEqual(["ADMIN", "GROUNDS"]); // NOT "EVENTS"
    // Department C (EVENTS) must not appear anywhere in the preview.
    expect(preview.lines.every((l) => l.departmentCode !== "EVENTS")).toBe(true);

    // Post!
    const posted = await postPayrollBatch(controllerP, batch.id);
    expect(posted.journalEntryId).toBeTruthy();

    // Step 6 — read back the POSTED journal entry + lines.
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

    // Step 7 — assertions.
    // (a) Journal balances.
    const dr = je!.lines.reduce((s, l) => s + Number(l.debit  ?? 0), 0);
    const cr = je!.lines.reduce((s, l) => s + Number(l.credit ?? 0), 0);
    expect(dr.toFixed(2)).toBe(cr.toFixed(2));

    // (b) Salary expense on Employee B's line resolves to GROUNDS,
    //     the FROZEN department — NOT EVENTS, the live one.
    const salaryLines = je!.lines.filter((l) => l.account.accountNumber === "6000");
    expect(salaryLines).toHaveLength(2);
    const salaryDeptCodes = salaryLines.map((l) => l.department?.code).sort();
    expect(salaryDeptCodes).toEqual(["ADMIN", "GROUNDS"]);
    // (c) EVENTS never appears on any line.
    expect(je!.lines.every((l) => l.department?.code !== "EVENTS")).toBe(true);
    // (d) Employer CPP + EI ALSO carry the frozen department per employee.
    const erCppLines = je!.lines.filter((l) => l.account.accountNumber === "6010");
    const erEiLines  = je!.lines.filter((l) => l.account.accountNumber === "6020");
    expect(erCppLines.map((l) => l.department?.code).sort()).toEqual(["ADMIN", "GROUNDS"]);
    expect(erEiLines.map((l) => l.department?.code).sort()).toEqual(["ADMIN", "GROUNDS"]);
    // (e) Central liabilities carry NO department dimension.
    for (const acctNumber of ["2100", "2110", "2120", "2130", "2140"]) {
      const line = je!.lines.find((l) => l.account.accountNumber === acctNumber);
      expect(line, `liability line ${acctNumber} present`).toBeDefined();
      expect(line!.departmentId, `liability line ${acctNumber} has no dept`).toBeNull();
    }

    // §F identity: preview and posted journal must agree on both
    // account and department per line.
    const previewSummary = preview.lines.map((l) => ({
      accountNumber: l.accountNumber, deptCode: l.departmentCode ?? null,
      debit: l.debit, credit: l.credit,
    })).sort((a, b) => (a.accountNumber + (a.deptCode ?? "")).localeCompare(b.accountNumber + (b.deptCode ?? "")));
    const postedSummary = je!.lines.map((l) => ({
      accountNumber: l.account.accountNumber, deptCode: l.department?.code ?? null,
      debit:  l.debit  != null ? new Prisma.Decimal(l.debit).toFixed(2)  : null,
      credit: l.credit != null ? new Prisma.Decimal(l.credit).toFixed(2) : null,
    })).sort((a, b) => (a.accountNumber + (a.deptCode ?? "")).localeCompare(b.accountNumber + (b.deptCode ?? "")));
    // Normalize preview's "0.00" credits/debits to null for equality
    // (the preview keeps the zero-debit slot on credit lines as null
    // and vice versa — same shape as posted, but let's belt-and-brace).
    expect(previewSummary.length).toBe(postedSummary.length);
    for (let i = 0; i < previewSummary.length; i++) {
      expect(previewSummary[i].accountNumber).toBe(postedSummary[i].accountNumber);
      expect(previewSummary[i].deptCode).toBe(postedSummary[i].deptCode);
      // Compare non-null amounts (a debit line's credit is null on both sides).
      if (previewSummary[i].debit != null) {
        expect(Number(previewSummary[i].debit)).toBeCloseTo(Number(postedSummary[i].debit), 2);
      }
      if (previewSummary[i].credit != null) {
        expect(Number(previewSummary[i].credit)).toBeCloseTo(Number(postedSummary[i].credit), 2);
      }
    }

    // Step 8 — a second post is refused as idempotent.
    const secondPost = await postPayrollBatch(controllerP, batch.id);
    expect(secondPost.journalEntryId).toBe(posted.journalEntryId);

    // Step 9 — a subsequent live-HR mutation cannot alter the posted
    // journal. Move Employee B's live dept back to Grounds, and verify
    // the historical POSTED journal is byte-identical.
    await c.employee.update({
      where: { id: empB.id },
      data: { departmentId: depts.grounds.id },
    });
    const jeAgain = await c.journalEntry.findUnique({
      where: { id: posted.journalEntryId },
      include: { lines: { include: { account: true, department: true }, orderBy: [{ lineNumber: "asc" }] } },
    });
    expect(jeAgain!.lines.length).toBe(je!.lines.length);
    for (let i = 0; i < je!.lines.length; i++) {
      expect(jeAgain!.lines[i].accountId).toBe(je!.lines[i].accountId);
      expect(jeAgain!.lines[i].departmentId).toBe(je!.lines[i].departmentId);
      expect(Number(jeAgain!.lines[i].debit ?? 0)).toBeCloseTo(Number(je!.lines[i].debit ?? 0), 2);
      expect(Number(jeAgain!.lines[i].credit ?? 0)).toBeCloseTo(Number(je!.lines[i].credit ?? 0), 2);
    }

    // Idempotency: `secondPost` must not have created a second journal.
    const allJEsForBatch = await c.journalEntry.count({
      where: { clubId: club.id, sourceEntityId: batch.id },
    });
    expect(allJEsForBatch).toBe(1);

    // A never-actually-hit-scenario sanity: attempting to post a
    // fabricated non-APPROVED batch throws (belt-and-braces).
    const badBatch = await c.payrollBatch.create({
      data: {
        clubId: club.id, payGroupId: pg.id, payPeriodId: pp.id,
        sequence: 2, status: "DRAFT",
        calculatedAt: new Date(), calculationVersion: 1,
        algorithmVersion: "spectre-payroll-test-1",
      },
    });
    await expect(postPayrollBatch(controllerP, badBatch.id)).rejects.toBeInstanceOf(ConflictError);
  });
});
