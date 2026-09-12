// Payroll 3B semantics-hotfix (2026-09-12) — approval-vs-freeze
// independence tests.
//
// Locks the two-gate distinction: Department Head approval progress
// is INDEPENDENT of Payroll Admin freeze progress. The Approvals
// tab count and Checklist item 2 report ONLY on the Manager
// approval gate; Freeze is a separate dimension tracked via the
// awaitingFreeze / frozen counts.
//
// Cases follow the §13 test matrix verbatim.

import { describe, it, expect } from "vitest";
import { PrismaClient } from "@prisma/client";
import { getTimeReadiness } from "@/lib/payroll/time-readiness";
import type { Principal } from "@/lib/rbac";

const prisma = new PrismaClient();
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

function testPrincipal(clubId: string): Principal {
  return {
    id: "system-test-user",
    kind: "user",
    memberships: [{ clubId, roleKey: "PAYROLL_ADMIN" as const }],
    activeClubId: clubId,
  } as unknown as Principal;
}

async function seedClub(): Promise<string> {
  const id = `test-club-${Math.random().toString(36).slice(2, 10)}`;
  await prisma.club.create({
    data: {
      id, slug: id, name: `Test Club ${id}`, wordmark: id,
      timezone: "America/Edmonton", payrollProvince: "AB",
    },
  });
  return id;
}
async function seedPayPeriod(clubId: string): Promise<{ id: string; payGroupId: string }> {
  const payGroupId = `test-pg-${Math.random().toString(36).slice(2, 8)}`;
  await prisma.payrollPayGroup.create({
    data: {
      id: payGroupId, clubId, code: "BW", name: "Bi-Weekly",
      payFrequency: "BIWEEKLY", payDateOffsetDays: 5,
      calendarAnchorDate: utc(2026, 8, 30), active: true,
    },
  });
  const id = `test-pp-${Math.random().toString(36).slice(2, 8)}`;
  await prisma.payrollPayPeriod.create({
    data: {
      id, clubId, payGroupId,
      sequenceInYear: 18, taxYear: 2026,
      periodStart: utc(2026, 8, 30), periodEnd: utc(2026, 9, 13),
      payDate: utc(2026, 9, 12), status: "OPEN",
    },
  });
  return { id, payGroupId };
}
async function seedDept(clubId: string, code: string) {
  const id = `dept-${code.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`;
  await prisma.department.create({ data: { id, clubId, code, name: code, sortOrder: 1 } });
  return id;
}
async function seedScope(clubId: string, payPeriodId: string, departmentId: string, opts: {
  approved?: boolean;
  frozen?: boolean;
  reopened?: boolean;
} = {}): Promise<{ employeeId: string; assignmentId: string; timesheetEntryId: string; approvalId?: string }> {
  const employeeId = `emp-${Math.random().toString(36).slice(2, 8)}`;
  await prisma.employee.create({
    data: {
      id: employeeId, clubId, firstName: "Case", lastName: "Employee",
      employeeNumber: employeeId.slice(-8),
      hireDate: utc(2026, 8, 1), employeeLifecycle: "ACTIVE",
      timekeepingMethod: "CLOCK_REQUIRED",
    },
  });
  const assignmentId = `asn-${Math.random().toString(36).slice(2, 8)}`;
  await prisma.employeeEmploymentAssignment.create({
    data: {
      id: assignmentId, clubId, employeeId, role: "PRIMARY",
      departmentId, employmentType: "PART_TIME",
      effectiveFrom: utc(2026, 8, 1),
    },
  });
  const timesheetId = `ts-${Math.random().toString(36).slice(2, 8)}`;
  await prisma.payrollTimesheet.create({
    data: { id: timesheetId, clubId, employeeId, payPeriodId, status: "READY_FOR_REVIEW" },
  });
  const timesheetEntryId = `ts-e-${Math.random().toString(36).slice(2, 8)}`;
  await prisma.payrollTimesheetEntry.create({
    data: {
      id: timesheetEntryId, clubId, timesheetId, employeeId, employmentAssignmentId: assignmentId,
      workDate: utc(2026, 9, 2),
      clockInAt: new Date("2026-09-02T14:00:00Z"),
      clockOutAt: new Date("2026-09-02T22:00:00Z"),
      recordedSeconds: 28_800, breakSeconds: 0,
    },
  });
  let approvalId: string | undefined;
  if (opts.approved || opts.frozen || opts.reopened) {
    approvalId = `appr-${Math.random().toString(36).slice(2, 8)}`;
    await prisma.payrollDepartmentTimeApproval.create({
      data: {
        id: approvalId, clubId, payPeriodId, departmentId,
        state: opts.reopened ? "REOPENED" : "APPROVED",
        approvedAt: new Date(),
        approvedByUserId: "system-test-user",
      },
    });
  }
  if (opts.frozen) {
    await prisma.payrollApprovedTimeEntry.create({
      data: {
        clubId, employeeId, employmentAssignmentId: assignmentId,
        workDate: utc(2026, 9, 2), hours: "8",
        approvalState: "APPROVED", approvedAt: new Date(),
        approvedByUserId: "system-test-user",
        payrollTimesheetEntryId: timesheetEntryId,
        sourceApprovalId: approvalId,
      },
    });
  }
  return { employeeId, assignmentId, timesheetEntryId, approvalId };
}

describe("Payroll 3B semantics-hotfix — approval vs freeze independence", () => {
  it("Case A: 0 approved / 0 frozen → deptApproved 0/2, checklist incomplete", async () => {
    const clubId = await seedClub();
    const { id: payPeriodId } = await seedPayPeriod(clubId);
    const d1 = await seedDept(clubId, "GROUNDS");
    const d2 = await seedDept(clubId, "EVENTS");
    await seedScope(clubId, payPeriodId, d1);
    await seedScope(clubId, payPeriodId, d2);
    const r = await getTimeReadiness(testPrincipal(clubId), clubId, payPeriodId);
    expect(r.scopeCount).toBe(2);
    expect(r.departmentApprovedScopeCount).toBe(0);
    expect(r.payrollFrozenScopeCount).toBe(0);
    expect(r.awaitingFreezeScopeCount).toBe(0);
    expect(r.allDepartmentApproved).toBe(false);
    expect(r.allFrozen).toBe(false);
  });

  it("Case B: 1 approved / 0 frozen → deptApproved 1/2, checklist incomplete", async () => {
    const clubId = await seedClub();
    const { id: payPeriodId } = await seedPayPeriod(clubId);
    const d1 = await seedDept(clubId, "GROUNDS");
    const d2 = await seedDept(clubId, "EVENTS");
    await seedScope(clubId, payPeriodId, d1, { approved: true });
    await seedScope(clubId, payPeriodId, d2);
    const r = await getTimeReadiness(testPrincipal(clubId), clubId, payPeriodId);
    expect(r.departmentApprovedScopeCount).toBe(1);
    expect(r.awaitingFreezeScopeCount).toBe(1);
    expect(r.payrollFrozenScopeCount).toBe(0);
    expect(r.allDepartmentApproved).toBe(false);
  });

  it("Case C: 2 approved / 0 frozen → deptApproved 2/2 COMPLETE, freeze prerequisite false", async () => {
    const clubId = await seedClub();
    const { id: payPeriodId } = await seedPayPeriod(clubId);
    const d1 = await seedDept(clubId, "GROUNDS");
    const d2 = await seedDept(clubId, "EVENTS");
    await seedScope(clubId, payPeriodId, d1, { approved: true });
    await seedScope(clubId, payPeriodId, d2, { approved: true });
    const r = await getTimeReadiness(testPrincipal(clubId), clubId, payPeriodId);
    expect(r.departmentApprovedScopeCount).toBe(2);
    expect(r.awaitingFreezeScopeCount).toBe(2);
    expect(r.payrollFrozenScopeCount).toBe(0);
    expect(r.allDepartmentApproved).toBe(true);   // Step 3 + checklist item 2 complete
    expect(r.allFrozen).toBe(false);              // Calculate freeze prereq NOT satisfied
    expect(r.allApproved).toBe(false);            // legacy "everything frozen" gate NOT satisfied
  });

  it("Case D: 2 approved / 1 frozen → deptApproved 2/2 COMPLETE, freeze prereq still false", async () => {
    const clubId = await seedClub();
    const { id: payPeriodId } = await seedPayPeriod(clubId);
    const d1 = await seedDept(clubId, "GROUNDS");
    const d2 = await seedDept(clubId, "EVENTS");
    await seedScope(clubId, payPeriodId, d1, { approved: true, frozen: true });
    await seedScope(clubId, payPeriodId, d2, { approved: true });
    const r = await getTimeReadiness(testPrincipal(clubId), clubId, payPeriodId);
    expect(r.departmentApprovedScopeCount).toBe(2);
    expect(r.awaitingFreezeScopeCount).toBe(1);
    expect(r.payrollFrozenScopeCount).toBe(1);
    expect(r.allDepartmentApproved).toBe(true);
    expect(r.allFrozen).toBe(false);
  });

  it("Case E: 2 approved / 2 frozen → deptApproved 2/2 COMPLETE, freeze prereq TRUE", async () => {
    const clubId = await seedClub();
    const { id: payPeriodId } = await seedPayPeriod(clubId);
    const d1 = await seedDept(clubId, "GROUNDS");
    const d2 = await seedDept(clubId, "EVENTS");
    await seedScope(clubId, payPeriodId, d1, { approved: true, frozen: true });
    await seedScope(clubId, payPeriodId, d2, { approved: true, frozen: true });
    const r = await getTimeReadiness(testPrincipal(clubId), clubId, payPeriodId);
    expect(r.departmentApprovedScopeCount).toBe(2);
    expect(r.awaitingFreezeScopeCount).toBe(0);
    expect(r.payrollFrozenScopeCount).toBe(2);
    expect(r.allDepartmentApproved).toBe(true);
    expect(r.allFrozen).toBe(true);
    expect(r.allApproved).toBe(true);
  });

  it("Case F: previously approved scope becomes REOPENED → deptApproved drops, checklist becomes incomplete", async () => {
    const clubId = await seedClub();
    const { id: payPeriodId } = await seedPayPeriod(clubId);
    const d1 = await seedDept(clubId, "GROUNDS");
    const d2 = await seedDept(clubId, "EVENTS");
    await seedScope(clubId, payPeriodId, d1, { reopened: true });
    await seedScope(clubId, payPeriodId, d2, { approved: true });
    const r = await getTimeReadiness(testPrincipal(clubId), clubId, payPeriodId);
    expect(r.departmentApprovedScopeCount).toBe(1);
    expect(r.reopenedScopeCount).toBe(1);
    expect(r.allDepartmentApproved).toBe(false);
    expect(r.allFrozen).toBe(false);
  });
});
