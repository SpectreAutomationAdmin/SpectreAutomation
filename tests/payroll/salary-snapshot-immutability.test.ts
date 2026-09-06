// Payroll MVP posting hotfix (2026-09-07) — salary snapshot
// immutability regression.
//
// Rule: once a batch is PREPARED, mutating the live Employee
// compensation MUST NOT change the calculated grossPay for that
// batch. The compensation snapshot is frozen at prep time on
// PayrollBatchEmployee.sourceFactsJson; the calculator reads only
// that blob, not live HR.
//
// This proves the founder-preview economic-correctness fix is
// robust: raising an employee's salary tomorrow can't retroactively
// mutate a historical payroll — an operational correction is
// VOID → change source → PREPARE replacement.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { parseSourceFactsV1 } from "@/lib/payroll/source-facts-schema";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import { writeEncryptedTd1Claims } from "@/lib/hr/td1-secure-write";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

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

describe("Salary snapshot immutability", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("mutating live Employee compensation after PREPARED does NOT change the batch's snapshotted annual salary", async () => {
    const c = db();
    const club = await makeClub("Snap Immutability");
    const admin = await makeUser({ email: "admin.snap@t.test", role: "CLUB_ADMIN", clubId: club.id });
    const pa    = await makeUser({ email: "pa.snap@t.test",    role: "PAYROLL_ADMIN", clubId: club.id });
    const ctl   = await makeUser({ email: "ctl.snap@t.test",   role: "CONTROLLER",    clubId: club.id });
    const adminP = await principalFor(admin.email);
    const paP    = await principalFor(pa.email);
    await upsertPayrollClubConfig(adminP, club.id, {
      provinceOfEmployment: "AB",
      payrollAdminUserId: pa.id, controllerUserId: ctl.id,
    });

    // Salaried employee with $120k annual, active from 2020.
    const emp = await c.employee.create({
      data: {
        clubId: club.id, firstName: "Snap", lastName: "Shot",
        email: "snap@t.test", hireDate: utc(2020, 1, 1), dateOfBirth: utc(1985, 5, 12),
        status: "ACTIVE", employeeNumber: "SNAP-1",
        employeeLifecycle: "ACTIVE", compensationType: "SALARY", homeProvince: "AB",
      },
    });
    const assn = await c.employeeEmploymentAssignment.create({
      data: {
        clubId: club.id, employeeId: emp.id, role: "PRIMARY",
        employmentType: "FULL_TIME", effectiveFrom: utc(2020, 1, 1),
      },
    });
    const comp = await c.employeeCompensation.create({
      data: {
        clubId: club.id, employeeId: emp.id, assignmentId: assn.id,
        cadence: "SALARY", rate: "120000", currency: "CAD",
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

    // Prepare — snapshot fires here.
    const prep = await preparePayrollBatch(paP, club.id, pp.id);
    expect(prep.blockerCount).toBe(0);

    // Now the batch owns a frozen snapshot. Read it.
    const before = await c.payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    const beforeFacts = parseSourceFactsV1(before.sourceFactsJson)!;
    const beforeAnnual = beforeFacts.compensations.find((c) => c.payType === "SALARY")?.annualSalary;
    expect(beforeAnnual).toBe("120000");

    // Mutate live HR: raise Snap Shot's salary to $200,000.
    await c.employeeCompensation.update({
      where: { id: comp.id }, data: { rate: "200000" },
    });
    await c.employee.update({
      where: { id: emp.id }, data: { payRate: "200000" },
    });

    // Re-read the batch — snapshot must still say $120,000.
    const after = await c.payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    const afterFacts = parseSourceFactsV1(after.sourceFactsJson)!;
    const afterAnnual = afterFacts.compensations.find((c) => c.payType === "SALARY")?.annualSalary;
    expect(afterAnnual).toBe("120000");
  });
});
