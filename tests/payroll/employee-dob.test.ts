// Payroll-3B-5B-1a — Employee date of birth: HR persistence,
// payroll snapshot immutability, MISSING_DATE_OF_BIRTH blocker.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { ValidationError } from "@/lib/errors";
import { createEmployee, updateEmployee } from "@/lib/hr/employees";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import { preparePayrollBatch, getPreparedBatch } from "@/lib/payroll/batch-preparation";

const utc = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

async function payrollScenario() {
  const club = await makeClub("Club A");
  const admin = await makeUser({ email: "admin@a.test", role: "CLUB_ADMIN", clubId: club.id });
  const pa = await makeUser({ email: "pa@a.test", role: "PAYROLL_ADMIN", clubId: club.id });
  const adminP = await principalFor(admin.email);
  const paP = await principalFor(pa.email);
  await upsertPayrollClubConfig(adminP, club.id, {
    provinceOfEmployment: "AB",
    payrollAdminUserId: pa.id,
  });
  return { club, adminP, paP };
}

describe("Payroll-3B-5B-1a — Employee DOB (HR persistence)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("createEmployee persists DOB normalised to UTC midnight", async () => {
    const club = await makeClub("Club A");
    const admin = await makeUser({ email: "admin@a.test", role: "CLUB_ADMIN", clubId: club.id });
    const adminP = await principalFor(admin.email);
    const emp = await createEmployee(adminP, club.id, {
      firstName: "Alex", lastName: "Grounds", dateOfBirth: "1990-05-12",
    });
    expect(emp.dateOfBirth?.toISOString()).toBe(utc(1990, 5, 12).toISOString());
  });

  it("createEmployee rejects a future DOB", async () => {
    const club = await makeClub("Club A");
    const admin = await makeUser({ email: "admin@a.test", role: "CLUB_ADMIN", clubId: club.id });
    const adminP = await principalFor(admin.email);
    const future = new Date(Date.now() + 86_400_000 * 30).toISOString().slice(0, 10);
    await expect(
      createEmployee(adminP, club.id, { firstName: "Alex", lastName: "G", dateOfBirth: future }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("updateEmployee lets HR/Admin correct DOB post-hire (audited)", async () => {
    const club = await makeClub("Club A");
    const admin = await makeUser({ email: "admin@a.test", role: "CLUB_ADMIN", clubId: club.id });
    const adminP = await principalFor(admin.email);
    const emp = await createEmployee(adminP, club.id, {
      firstName: "Alex", lastName: "Grounds",
    });
    expect(emp.dateOfBirth).toBeNull();
    const updated = await updateEmployee(adminP, emp.id, { dateOfBirth: "1988-03-14" });
    expect(updated.dateOfBirth?.toISOString()).toBe(utc(1988, 3, 14).toISOString());
  });

  it("updateEmployee rejects invalid date string", async () => {
    const club = await makeClub("Club A");
    const admin = await makeUser({ email: "admin@a.test", role: "CLUB_ADMIN", clubId: club.id });
    const adminP = await principalFor(admin.email);
    const emp = await createEmployee(adminP, club.id, { firstName: "Alex", lastName: "G" });
    await expect(updateEmployee(adminP, emp.id, { dateOfBirth: "not-a-date" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("tenant isolation — cross-club update is refused via loadEmployee", async () => {
    const clubA = await makeClub("Club A");
    const clubB = await makeClub("Club B");
    const adminA = await makeUser({ email: "a@a.test", role: "CLUB_ADMIN", clubId: clubA.id });
    const adminB = await makeUser({ email: "b@b.test", role: "CLUB_ADMIN", clubId: clubB.id });
    const adminAP = await principalFor(adminA.email);
    const adminBP = await principalFor(adminB.email);
    const empA = await createEmployee(adminAP, clubA.id, { firstName: "A", lastName: "A" });
    await expect(updateEmployee(adminBP, empA.id, { dateOfBirth: "1990-01-01" })).rejects.toThrow();
  });
});

describe("Payroll-3B-5B-1a — DOB snapshot + MISSING_DOB blocker", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  async function includedEmployee(s: Awaited<ReturnType<typeof payrollScenario>>, hasDob: boolean) {
    const dep = await db().department.create({
      data: { clubId: s.club.id, code: "GROUNDS", name: "Grounds", sortOrder: 1 },
    });
    const emp = await db().employee.create({
      data: {
        clubId: s.club.id, firstName: "Sam", lastName: "Salary",
        email: "sam@a.test", hireDate: utc(2026, 1, 1),
        dateOfBirth: hasDob ? utc(1990, 5, 12) : null,
        status: "ACTIVE", employeeNumber: "E-DOB-1",
      },
    });
    const assign = await db().employeeEmploymentAssignment.create({
      data: {
        clubId: s.club.id, employeeId: emp.id, role: "PRIMARY",
        departmentId: dep.id, employmentType: "FULL_TIME",
        effectiveFrom: utc(2026, 1, 1),
      },
    });
    await db().employeeCompensation.create({
      data: {
        clubId: s.club.id, employeeId: emp.id, assignmentId: assign.id,
        cadence: "SALARY", rate: "72000", currency: "CAD",
        effectiveFrom: utc(2026, 1, 1),
      },
    });
    const pg = await db().payrollPayGroup.create({
      data: { clubId: s.club.id, code: "PG", name: "PG", payFrequency: "BIWEEKLY", payDateOffsetDays: 5 },
    });
    const pp = await db().payrollPayPeriod.create({
      data: {
        clubId: s.club.id, payGroupId: pg.id,
        sequenceInYear: 1, taxYear: 2026,
        periodStart: utc(2026, 8, 10), periodEnd: utc(2026, 8, 24),
        payDate: utc(2026, 8, 29),
      },
    });
    await db().payrollPayGroupMember.create({
      data: { clubId: s.club.id, payGroupId: pg.id, employeeId: emp.id, effectiveFrom: utc(2026, 1, 1) },
    });
    return { emp, pp };
  }

  it("DOB present → frozen into PayrollBatchEmployee.dateOfBirthSnapshot + sourceFacts.identity", async () => {
    const s = await payrollScenario();
    const { emp, pp } = await includedEmployee(s, true);
    const r = await preparePayrollBatch(s.paP, s.club.id, pp.id);
    const view = await getPreparedBatch(s.paP, s.club.id, r.batchId);
    const be = view!.employees.find((e) => e.employeeId === emp.id)!;
    expect(be.dateOfBirthSnapshot?.toISOString()).toBe(utc(1990, 5, 12).toISOString());
    expect(be.sourceFacts!.identity.dateOfBirth).toBe(utc(1990, 5, 12).toISOString());
  });

  it("DOB missing → MISSING_DATE_OF_BIRTH BLOCKER; batch stays DRAFT", async () => {
    const s = await payrollScenario();
    const { emp, pp } = await includedEmployee(s, false);
    const r = await preparePayrollBatch(s.paP, s.club.id, pp.id);
    expect(r.status).toBe("prepared-with-blockers");
    expect(r.blockerCount).toBeGreaterThanOrEqual(1);
    const view = await getPreparedBatch(s.paP, s.club.id, r.batchId);
    expect(view!.status).toBe("DRAFT");
    const dobBlocker = view!.exceptions.find(
      (x) => x.employeeId === emp.id && x.code === "MISSING_DATE_OF_BIRTH",
    );
    expect(dobBlocker?.severity).toBe("BLOCKER");
    expect(dobBlocker?.message).toMatch(/date of birth/i);
    // The Work Intake card / audit payload never repeats the DOB —
    // the exception message says WHY, not WHEN they were born.
    expect(dobBlocker?.message).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("live DOB correction after preparation does NOT mutate the frozen batch", async () => {
    const s = await payrollScenario();
    const { emp, pp } = await includedEmployee(s, true);
    const r = await preparePayrollBatch(s.paP, s.club.id, pp.id);
    // Out-of-band DOB correction on the source Employee row.
    await db().employee.update({
      where: { id: emp.id },
      data: { dateOfBirth: utc(1985, 2, 20) },
    });
    const view = await getPreparedBatch(s.paP, s.club.id, r.batchId);
    const be = view!.employees.find((e) => e.employeeId === emp.id)!;
    expect(be.dateOfBirthSnapshot?.toISOString()).toBe(utc(1990, 5, 12).toISOString());
    expect(be.sourceFacts!.identity.dateOfBirth).toBe(utc(1990, 5, 12).toISOString());
  });
});
