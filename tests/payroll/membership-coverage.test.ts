// Payroll-3B-5A — Pay Group membership coverage windows on
// PayrollBatchEmployee. Corrects the 3B-4 assumption that overlap
// prevention implies "one batch per employee per period" — an
// Employee who transfers Pay Groups mid-period appears in TWO
// batches (one per group), each carrying the correct fractional
// coverage window.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import { createTimeEntry } from "@/lib/payroll/approved-time";
import { approveDepartmentTime } from "@/lib/payroll/department-approval";
import { preparePayrollBatch, getPreparedBatch } from "@/lib/payroll/batch-preparation";

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

async function baseClubAndAdmin() {
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

async function makeSalariedEmp(clubId: string, dept: string, num: string, hireDate: Date) {
  const dep = await db().department.create({
    data: { clubId, code: dept, name: dept, sortOrder: 1 },
  });
  const emp = await db().employee.create({
    data: {
      clubId, firstName: "Sam", lastName: "Salary" + num,
      email: `sam${num}@a.test`, hireDate, status: "ACTIVE",
      employeeNumber: num,
    },
  });
  const assign = await db().employeeEmploymentAssignment.create({
    data: {
      clubId, employeeId: emp.id, role: "PRIMARY",
      departmentId: dep.id, employmentType: "FULL_TIME",
      effectiveFrom: hireDate,
    },
  });
  await db().employeeCompensation.create({
    data: {
      clubId, employeeId: emp.id, assignmentId: assign.id,
      cadence: "SALARY", rate: "72000", currency: "CAD",
      effectiveFrom: hireDate,
    },
  });
  return { emp, assign, dep };
}

describe("Payroll-3B-5A — Pay Group membership coverage", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("full-period membership → coverage spans the entire pay period; isFullPeriod=true", async () => {
    const s = await baseClubAndAdmin();
    const { emp } = await makeSalariedEmp(s.club.id, "GROUNDS", "E-F-1", d(2026, 1, 1));
    const pg = await db().payrollPayGroup.create({
      data: { clubId: s.club.id, code: "PG", name: "PG", payFrequency: "BIWEEKLY", payDateOffsetDays: 5 },
    });
    const pp = await db().payrollPayPeriod.create({
      data: {
        clubId: s.club.id, payGroupId: pg.id,
        sequenceInYear: 1, taxYear: 2026,
        periodStart: d(2026, 8, 10), periodEnd: d(2026, 8, 24),
        payDate: d(2026, 8, 29),
      },
    });
    await db().payrollPayGroupMember.create({
      data: { clubId: s.club.id, payGroupId: pg.id, employeeId: emp.id, effectiveFrom: d(2026, 1, 1) },
    });
    const r = await preparePayrollBatch(s.paP, s.club.id, pp.id);
    const b = await getPreparedBatch(s.paP, s.club.id, r.batchId);
    const be = b!.employees.find((e) => e.employeeId === emp.id)!;
    expect(be.coverageStart?.toISOString()).toBe(d(2026, 8, 10).toISOString());
    expect(be.coverageEnd?.toISOString()).toBe(d(2026, 8, 24).toISOString());
    expect(be.sourceFacts!.coverage.isFullPeriod).toBe(true);
    expect(be.sourceFacts!.coverage.coverageDays).toBe(14);
    expect(be.sourceFacts!.coverage.periodDays).toBe(14);
  });

  it("mid-period hire → coverage starts at the membership start (hire); isFullPeriod=false", async () => {
    const s = await baseClubAndAdmin();
    const hire = d(2026, 8, 15);
    const { emp } = await makeSalariedEmp(s.club.id, "GROUNDS", "E-H-1", hire);
    const pg = await db().payrollPayGroup.create({
      data: { clubId: s.club.id, code: "PG", name: "PG", payFrequency: "BIWEEKLY", payDateOffsetDays: 5 },
    });
    const pp = await db().payrollPayPeriod.create({
      data: {
        clubId: s.club.id, payGroupId: pg.id,
        sequenceInYear: 1, taxYear: 2026,
        periodStart: d(2026, 8, 10), periodEnd: d(2026, 8, 24),
        payDate: d(2026, 8, 29),
      },
    });
    await db().payrollPayGroupMember.create({
      data: { clubId: s.club.id, payGroupId: pg.id, employeeId: emp.id, effectiveFrom: hire },
    });
    const r = await preparePayrollBatch(s.paP, s.club.id, pp.id);
    const b = await getPreparedBatch(s.paP, s.club.id, r.batchId);
    const be = b!.employees.find((e) => e.employeeId === emp.id)!;
    expect(be.coverageStart?.toISOString()).toBe(hire.toISOString());
    expect(be.coverageEnd?.toISOString()).toBe(d(2026, 8, 24).toISOString());
    expect(be.sourceFacts!.coverage.isFullPeriod).toBe(false);
    expect(be.sourceFacts!.coverage.coverageDays).toBe(9);
    expect(be.sourceFacts!.coverage.periodDays).toBe(14);
  });

  it("mid-period termination → coverage ends at the membership end; isFullPeriod=false", async () => {
    const s = await baseClubAndAdmin();
    const { emp } = await makeSalariedEmp(s.club.id, "GROUNDS", "E-T-1", d(2026, 1, 1));
    const term = d(2026, 8, 20);
    const pg = await db().payrollPayGroup.create({
      data: { clubId: s.club.id, code: "PG", name: "PG", payFrequency: "BIWEEKLY", payDateOffsetDays: 5 },
    });
    const pp = await db().payrollPayPeriod.create({
      data: {
        clubId: s.club.id, payGroupId: pg.id,
        sequenceInYear: 1, taxYear: 2026,
        periodStart: d(2026, 8, 10), periodEnd: d(2026, 8, 24),
        payDate: d(2026, 8, 29),
      },
    });
    await db().payrollPayGroupMember.create({
      data: { clubId: s.club.id, payGroupId: pg.id, employeeId: emp.id, effectiveFrom: d(2026, 1, 1), effectiveTo: term },
    });
    const r = await preparePayrollBatch(s.paP, s.club.id, pp.id);
    const b = await getPreparedBatch(s.paP, s.club.id, r.batchId);
    const be = b!.employees.find((e) => e.employeeId === emp.id)!;
    expect(be.coverageStart?.toISOString()).toBe(d(2026, 8, 10).toISOString());
    expect(be.coverageEnd?.toISOString()).toBe(term.toISOString());
    expect(be.sourceFacts!.coverage.coverageDays).toBe(10);
    expect(be.sourceFacts!.coverage.isFullPeriod).toBe(false);
  });

  it("mid-period Pay Group transfer (SALARIED) → two batches, coverages sum to period, no overlap", async () => {
    const s = await baseClubAndAdmin();
    // Two Pay Groups running concurrently for the same window.
    // The Employee is a member of Group A from Aug 1 → Aug 15 and
    // Group B from Aug 15 → open.
    const emp = await db().employee.create({
      data: {
        clubId: s.club.id, firstName: "Trans", lastName: "Fer",
        email: "tf@a.test", hireDate: d(2026, 1, 1), status: "ACTIVE",
        employeeNumber: "E-TX-1",
      },
    });
    const dep = await db().department.create({
      data: { clubId: s.club.id, code: "OPS", name: "Operations", sortOrder: 1 },
    });
    const assign = await db().employeeEmploymentAssignment.create({
      data: {
        clubId: s.club.id, employeeId: emp.id, role: "PRIMARY",
        departmentId: dep.id, employmentType: "FULL_TIME",
        effectiveFrom: d(2026, 1, 1),
      },
    });
    await db().employeeCompensation.create({
      data: {
        clubId: s.club.id, employeeId: emp.id, assignmentId: assign.id,
        cadence: "SALARY", rate: "72000", currency: "CAD",
        effectiveFrom: d(2026, 1, 1),
      },
    });

    const groupA = await db().payrollPayGroup.create({
      data: { clubId: s.club.id, code: "GA", name: "Group A", payFrequency: "MONTHLY", payDateOffsetDays: 5 },
    });
    const groupB = await db().payrollPayGroup.create({
      data: { clubId: s.club.id, code: "GB", name: "Group B", payFrequency: "MONTHLY", payDateOffsetDays: 5 },
    });
    // Each Group runs its OWN Pay Period for Aug 1 → Aug 31.
    const periodA = await db().payrollPayPeriod.create({
      data: {
        clubId: s.club.id, payGroupId: groupA.id,
        sequenceInYear: 8, taxYear: 2026,
        periodStart: d(2026, 8, 1), periodEnd: d(2026, 9, 1),
        payDate: d(2026, 9, 5),
      },
    });
    const periodB = await db().payrollPayPeriod.create({
      data: {
        clubId: s.club.id, payGroupId: groupB.id,
        sequenceInYear: 8, taxYear: 2026,
        periodStart: d(2026, 8, 1), periodEnd: d(2026, 9, 1),
        payDate: d(2026, 9, 5),
      },
    });
    // Memberships — half-open, no overlap.
    await db().payrollPayGroupMember.create({
      data: {
        clubId: s.club.id, payGroupId: groupA.id, employeeId: emp.id,
        effectiveFrom: d(2026, 8, 1), effectiveTo: d(2026, 8, 15),
      },
    });
    await db().payrollPayGroupMember.create({
      data: {
        clubId: s.club.id, payGroupId: groupB.id, employeeId: emp.id,
        effectiveFrom: d(2026, 8, 15),
      },
    });

    const rA = await preparePayrollBatch(s.paP, s.club.id, periodA.id);
    const rB = await preparePayrollBatch(s.paP, s.club.id, periodB.id);
    const bA = await getPreparedBatch(s.paP, s.club.id, rA.batchId);
    const bB = await getPreparedBatch(s.paP, s.club.id, rB.batchId);
    const beA = bA!.employees.find((e) => e.employeeId === emp.id)!;
    const beB = bB!.employees.find((e) => e.employeeId === emp.id)!;

    // Coverage A: [Aug 1, Aug 15) = 14 days; not full period.
    expect(beA.coverageStart?.toISOString()).toBe(d(2026, 8, 1).toISOString());
    expect(beA.coverageEnd?.toISOString()).toBe(d(2026, 8, 15).toISOString());
    expect(beA.sourceFacts!.coverage.coverageDays).toBe(14);
    expect(beA.sourceFacts!.coverage.isFullPeriod).toBe(false);

    // Coverage B: [Aug 15, Sep 1) = 17 days; not full period.
    expect(beB.coverageStart?.toISOString()).toBe(d(2026, 8, 15).toISOString());
    expect(beB.coverageEnd?.toISOString()).toBe(d(2026, 9, 1).toISOString());
    expect(beB.sourceFacts!.coverage.coverageDays).toBe(17);
    expect(beB.sourceFacts!.coverage.isFullPeriod).toBe(false);

    // Coverages sum to periodDays exactly and do not overlap.
    expect(beA.sourceFacts!.coverage.coverageDays + beB.sourceFacts!.coverage.coverageDays)
      .toBe(beA.sourceFacts!.coverage.periodDays);
    expect(beA.coverageEnd?.getTime()).toBe(beB.coverageStart?.getTime());
  });

  it("mid-period Pay Group transfer (HOURLY) — each batch only sees its own approved time", async () => {
    const s = await baseClubAndAdmin();
    const dep = await db().department.create({
      data: { clubId: s.club.id, code: "OPS", name: "Operations", sortOrder: 1 },
    });
    const emp = await db().employee.create({
      data: {
        clubId: s.club.id, firstName: "Xfer", lastName: "Hourly",
        email: "xh@a.test", hireDate: d(2026, 1, 1), status: "ACTIVE",
        employeeNumber: "E-TX-H",
      },
    });
    const assign = await db().employeeEmploymentAssignment.create({
      data: {
        clubId: s.club.id, employeeId: emp.id, role: "PRIMARY",
        departmentId: dep.id, employmentType: "FULL_TIME",
        effectiveFrom: d(2026, 1, 1),
      },
    });
    await db().employeeCompensation.create({
      data: {
        clubId: s.club.id, employeeId: emp.id, assignmentId: assign.id,
        cadence: "HOURLY", rate: "22.50", currency: "CAD",
        effectiveFrom: d(2026, 1, 1),
      },
    });

    // Two Pay Groups with DIFFERENT windows so approved time falls
    // deterministically into one or the other.
    const groupA = await db().payrollPayGroup.create({
      data: { clubId: s.club.id, code: "GA", name: "Group A", payFrequency: "MONTHLY", payDateOffsetDays: 5 },
    });
    const groupB = await db().payrollPayGroup.create({
      data: { clubId: s.club.id, code: "GB", name: "Group B", payFrequency: "MONTHLY", payDateOffsetDays: 5 },
    });
    const periodA = await db().payrollPayPeriod.create({
      data: {
        clubId: s.club.id, payGroupId: groupA.id,
        sequenceInYear: 8, taxYear: 2026,
        periodStart: d(2026, 8, 1), periodEnd: d(2026, 8, 15),
        payDate: d(2026, 8, 20),
      },
    });
    const periodB = await db().payrollPayPeriod.create({
      data: {
        clubId: s.club.id, payGroupId: groupB.id,
        sequenceInYear: 8, taxYear: 2026,
        periodStart: d(2026, 8, 15), periodEnd: d(2026, 9, 1),
        payDate: d(2026, 9, 5),
      },
    });
    await db().payrollPayGroupMember.create({
      data: {
        clubId: s.club.id, payGroupId: groupA.id, employeeId: emp.id,
        effectiveFrom: d(2026, 8, 1), effectiveTo: d(2026, 8, 15),
      },
    });
    await db().payrollPayGroupMember.create({
      data: {
        clubId: s.club.id, payGroupId: groupB.id, employeeId: emp.id,
        effectiveFrom: d(2026, 8, 15),
      },
    });
    await createTimeEntry(s.adminP, s.club.id, {
      employeeId: emp.id, employmentAssignmentId: assign.id,
      workDate: d(2026, 8, 8), hours: 8,
    });
    await createTimeEntry(s.adminP, s.club.id, {
      employeeId: emp.id, employmentAssignmentId: assign.id,
      workDate: d(2026, 8, 20), hours: 6,
    });
    await approveDepartmentTime(s.adminP, s.club.id, periodA.id, dep.id);
    await approveDepartmentTime(s.adminP, s.club.id, periodB.id, dep.id);

    const rA = await preparePayrollBatch(s.paP, s.club.id, periodA.id);
    const rB = await preparePayrollBatch(s.paP, s.club.id, periodB.id);
    const bA = await getPreparedBatch(s.paP, s.club.id, rA.batchId);
    const bB = await getPreparedBatch(s.paP, s.club.id, rB.batchId);
    const beA = bA!.employees.find((e) => e.employeeId === emp.id)!;
    const beB = bB!.employees.find((e) => e.employeeId === emp.id)!;
    expect(Number(beA.approvedHoursSnapshot)).toBe(8);
    expect(Number(beB.approvedHoursSnapshot)).toBe(6);
  });

  it("stored PayrollBatchEmployee row carries membership + coverage columns", async () => {
    const s = await baseClubAndAdmin();
    const { emp } = await makeSalariedEmp(s.club.id, "GROUNDS", "E-C-1", d(2026, 1, 1));
    const pg = await db().payrollPayGroup.create({
      data: { clubId: s.club.id, code: "PG", name: "PG", payFrequency: "BIWEEKLY", payDateOffsetDays: 5 },
    });
    const pp = await db().payrollPayPeriod.create({
      data: {
        clubId: s.club.id, payGroupId: pg.id,
        sequenceInYear: 1, taxYear: 2026,
        periodStart: d(2026, 8, 10), periodEnd: d(2026, 8, 24),
        payDate: d(2026, 8, 29),
      },
    });
    await db().payrollPayGroupMember.create({
      data: { clubId: s.club.id, payGroupId: pg.id, employeeId: emp.id, effectiveFrom: d(2026, 1, 1) },
    });
    const r = await preparePayrollBatch(s.paP, s.club.id, pp.id);
    const row = await db().payrollBatchEmployee.findFirstOrThrow({
      where: { batchId: r.batchId, employeeId: emp.id },
    });
    expect(row.coverageStart?.toISOString()).toBe(d(2026, 8, 10).toISOString());
    expect(row.coverageEnd?.toISOString()).toBe(d(2026, 8, 24).toISOString());
    expect(row.membershipEffectiveFrom?.toISOString()).toBe(d(2026, 1, 1).toISOString());
    expect(row.membershipEffectiveTo).toBeNull();
  });
});
