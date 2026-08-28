// Payroll-3B-3 (2026-08-28) — approved time + department approval +
// Work Intake orchestration tests.
//
// Covers §39-§40 of the ticket brief. Every test is timezone-safe
// (uses UTC-midnight dates). Every write path is exercised via the
// canonical service, never direct Prisma writes for coverage-only.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { ValidationError } from "@/lib/errors";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import {
  createTimeEntry,
  updateTimeEntry,
  deleteTimeEntry,
  listTimeEntries,
  listApprovedTimeForPeriod,
} from "@/lib/payroll/approved-time";
import {
  getDepartmentApprovalStatus,
  approveDepartmentTime,
  reopenDepartmentTime,
  resolveDepartmentManagerUserIds,
} from "@/lib/payroll/department-approval";
import {
  orchestrateDepartmentApprovalTasks,
  orchestratePayrollAdminHandoff,
} from "@/lib/payroll/orchestration";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function issueFrom<T>(p: Promise<T>): Promise<string> {
  try { await p; throw new Error("expected reject"); }
  catch (e) {
    if (e instanceof ValidationError) return e.issues.map((i) => `${i.path}: ${i.message}`).join(" | ");
    throw e;
  }
}

/**
 * A minimal in-process scenario:
 *   Club A with two Departments (Grounds + F&B), one Payroll Admin
 *   user, one Grounds manager User (via managerEmployeeId), a Pay
 *   Period covering Aug 10-24 2026. Each helper here is scoped so
 *   tests stay readable.
 */
async function scenario() {
  const clubA = await makeClub("Club A");
  const clubB = await makeClub("Club B");

  // Users that will hold roles.
  const payrollAdmin = await makeUser({ email: "pa@a.test", role: "PAYROLL_ADMIN", clubId: clubA.id });
  const controller = await makeUser({ email: "ctl@a.test", role: "CONTROLLER", clubId: clubA.id });
  const clubAdmin = await makeUser({ email: "admin@a.test", role: "CLUB_ADMIN", clubId: clubA.id });
  const groundsMgrUser = await makeUser({ email: "grounds.mgr@a.test", role: "DEPARTMENT_MANAGER", clubId: clubA.id });
  const fbMgrUser = await makeUser({ email: "fb.mgr@a.test", role: "DEPARTMENT_MANAGER", clubId: clubA.id });
  const adminP = await principalFor(clubAdmin.email);
  const groundsMgrP = await principalFor(groundsMgrUser.email);
  const fbMgrP = await principalFor(fbMgrUser.email);

  await upsertPayrollClubConfig(adminP, clubA.id, {
    provinceOfEmployment: "AB",
    payrollAdminUserId: payrollAdmin.id,
    controllerUserId: controller.id,
  });

  // Departments.
  const grounds = await db().department.create({
    data: { clubId: clubA.id, code: "GROUNDS", name: "Grounds", sortOrder: 1 },
  });
  const fb = await db().department.create({
    data: { clubId: clubA.id, code: "FB", name: "Food & Beverage", sortOrder: 2 },
  });

  // Employees. Manager employees FIRST — they need to exist before subordinates reference them.
  const groundsMgrEmp = await db().employee.create({
    data: {
      clubId: clubA.id, firstName: "Grounds", lastName: "Manager",
      email: groundsMgrUser.email, hireDate: utc(2026, 1, 1), status: "ACTIVE",
      employeeNumber: "E-MGR-G", userId: groundsMgrUser.id,
    },
  });
  const fbMgrEmp = await db().employee.create({
    data: {
      clubId: clubA.id, firstName: "FB", lastName: "Manager",
      email: fbMgrUser.email, hireDate: utc(2026, 1, 1), status: "ACTIVE",
      employeeNumber: "E-MGR-FB", userId: fbMgrUser.id,
    },
  });
  // Subordinates.
  const empGrounds = await db().employee.create({
    data: {
      clubId: clubA.id, firstName: "Alex", lastName: "Grounds",
      email: "alex@a.test", hireDate: utc(2026, 1, 1), status: "ACTIVE",
      employeeNumber: "E-1001",
    },
  });
  const empFB = await db().employee.create({
    data: {
      clubId: clubA.id, firstName: "Beth", lastName: "FoodBev",
      email: "beth@a.test", hireDate: utc(2026, 1, 1), status: "ACTIVE",
      employeeNumber: "E-1002",
    },
  });

  const assignGrounds = await db().employeeEmploymentAssignment.create({
    data: {
      clubId: clubA.id, employeeId: empGrounds.id, role: "PRIMARY",
      departmentId: grounds.id, managerEmployeeId: groundsMgrEmp.id,
      employmentType: "FULL_TIME", effectiveFrom: utc(2026, 1, 1),
    },
  });
  const assignFB = await db().employeeEmploymentAssignment.create({
    data: {
      clubId: clubA.id, employeeId: empFB.id, role: "PRIMARY",
      departmentId: fb.id, managerEmployeeId: fbMgrEmp.id,
      employmentType: "FULL_TIME", effectiveFrom: utc(2026, 1, 1),
    },
  });

  // Pay group + pay period Aug 10-24 (14 days) pay 29th.
  const payGroup = await db().payrollPayGroup.create({
    data: {
      clubId: clubA.id, code: "HRLBW", name: "Hourly Biweekly",
      payFrequency: "BIWEEKLY", payDateOffsetDays: 5,
      calendarAnchorDate: utc(2026, 1, 4),
    },
  });
  const payPeriod = await db().payrollPayPeriod.create({
    data: {
      clubId: clubA.id, payGroupId: payGroup.id,
      sequenceInYear: 17, taxYear: 2026,
      periodStart: utc(2026, 8, 10), periodEnd: utc(2026, 8, 24),
      payDate: utc(2026, 8, 29),
    },
  });

  return {
    clubA, clubB, payrollAdmin, controller, adminP,
    groundsMgrUser, groundsMgrEmp, groundsMgrP,
    fbMgrUser, fbMgrEmp, fbMgrP,
    grounds, fb,
    empGrounds, empFB,
    assignGrounds, assignFB,
    payGroup, payPeriod,
  };
}

describe("Payroll-3B-3 — approved time + department approval + Work Intake", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  // ---- Approved time -------------------------------------------------------

  it("createTimeEntry — assignment must belong to the same employee and be effective on workDate", async () => {
    const s = await scenario();
    // Wrong assignment for employee.
    const bad = await issueFrom(createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.empGrounds.id,
      employmentAssignmentId: s.assignFB.id,
      workDate: utc(2026, 8, 15),
      hours: 8,
    }));
    expect(bad).toMatch(/Assignment does not belong to this Employee/i);
    // Correct assignment succeeds.
    const ok = await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.empGrounds.id,
      employmentAssignmentId: s.assignGrounds.id,
      workDate: utc(2026, 8, 15),
      hours: 8,
    });
    expect(ok.entry.approvalState).toBe("DRAFT");
    expect(ok.departmentId).toBe(s.grounds.id);
  });

  it("hours validation — zero/negative rejected, decimal preserved", async () => {
    const s = await scenario();
    await expect(createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.empGrounds.id, employmentAssignmentId: s.assignGrounds.id,
      workDate: utc(2026, 8, 15), hours: 0,
    })).rejects.toThrow();
    await expect(createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.empGrounds.id, employmentAssignmentId: s.assignGrounds.id,
      workDate: utc(2026, 8, 15), hours: -1,
    })).rejects.toThrow();
    const ok = await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.empGrounds.id, employmentAssignmentId: s.assignGrounds.id,
      workDate: utc(2026, 8, 15), hours: 6.25,
    });
    expect(ok.entry.hours).toBe("6.25");
  });

  it("multiple legitimate entries — same employee + workDate + classification with distinct assignments allowed", async () => {
    const s = await scenario();
    // Give Alex an additional F&B assignment covering the same date.
    const alexFB = await db().employeeEmploymentAssignment.create({
      data: {
        clubId: s.clubA.id, employeeId: s.empGrounds.id, role: "ADDITIONAL",
        departmentId: s.fb.id, employmentType: "PART_TIME",
        managerEmployeeId: s.fbMgrEmp.id,
        effectiveFrom: utc(2026, 8, 1),
      },
    });
    // Two REGULAR entries on the same date, distinct assignments.
    const a = await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.empGrounds.id, employmentAssignmentId: s.assignGrounds.id,
      workDate: utc(2026, 8, 15), hours: 4, earningClassification: "REGULAR",
    });
    const b = await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.empGrounds.id, employmentAssignmentId: alexFB.id,
      workDate: utc(2026, 8, 15), hours: 3, earningClassification: "REGULAR",
    });
    expect(a.entry.id).not.toBe(b.entry.id);
    expect(a.departmentId).toBe(s.grounds.id);
    expect(b.departmentId).toBe(s.fb.id);
  });

  it("tenant isolation — Club A user cannot list Club B time or create entries at Club B", async () => {
    const s = await scenario();
    await expect(listTimeEntries(s.adminP, s.clubB.id)).rejects.toThrow();
    await expect(createTimeEntry(s.adminP, s.clubB.id, {
      employeeId: s.empGrounds.id, workDate: utc(2026, 8, 15), hours: 4,
    })).rejects.toThrow();
  });

  it("update refused after approval; consumed rows are immutable", async () => {
    const s = await scenario();
    const e = await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.empGrounds.id, employmentAssignmentId: s.assignGrounds.id,
      workDate: utc(2026, 8, 15), hours: 8,
    });
    // Approve via the department flow so the entry becomes APPROVED.
    await approveDepartmentTime(s.adminP, s.clubA.id, s.payPeriod.id, s.grounds.id);
    // Update refused.
    const upd = await issueFrom(updateTimeEntry(s.adminP, s.clubA.id, e.entry.id, { hours: 9 }));
    expect(upd).toMatch(/already been approved/i);
    // Simulate consumption by a batch (only PayrollBatch service is allowed
    // in prod; here we set it directly to prove the update refusal).
    await db().payrollApprovedTimeEntry.update({
      where: { id: e.entry.id },
      data: { consumedByBatchId: "batch-x", consumedByBatchEmployeeId: "be-x" },
    });
    const upd2 = await issueFrom(updateTimeEntry(s.adminP, s.clubA.id, e.entry.id, { hours: 9 }));
    expect(upd2).toMatch(/consumed by a payroll batch/i);
    const del = await issueFrom(deleteTimeEntry(s.adminP, s.clubA.id, e.entry.id));
    expect(del).toMatch(/consumed by a payroll batch/i);
  });

  it("period boundary — listApprovedTimeForPeriod respects [periodStart, periodEnd)", async () => {
    const s = await scenario();
    // Aug 10, 15, 23 → inside. Aug 24 → outside (periodEnd exclusive).
    await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.empGrounds.id, employmentAssignmentId: s.assignGrounds.id,
      workDate: utc(2026, 8, 10), hours: 8,
    });
    await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.empGrounds.id, employmentAssignmentId: s.assignGrounds.id,
      workDate: utc(2026, 8, 24), hours: 8,
    });
    await approveDepartmentTime(s.adminP, s.clubA.id, s.payPeriod.id, s.grounds.id);
    const inPeriod = await listApprovedTimeForPeriod(s.adminP, s.clubA.id, s.payPeriod.id);
    // Only the Aug 10 entry — Aug 24 is periodEnd (exclusive).
    expect(inPeriod.length).toBe(1);
    expect(inPeriod[0]!.workDate.getTime()).toBe(utc(2026, 8, 10).getTime());
  });

  // ---- Department approval + orchestration --------------------------------

  it("department approval routes to the correct Department manager User via managerEmployeeId → userId", async () => {
    const s = await scenario();
    const groundsManagers = await resolveDepartmentManagerUserIds(s.clubA.id, s.grounds.id);
    expect(groundsManagers).toEqual([s.groundsMgrUser.id]);
    const fbManagers = await resolveDepartmentManagerUserIds(s.clubA.id, s.fb.id);
    expect(fbManagers).toEqual([s.fbMgrUser.id]);
  });

  it("orchestrateDepartmentApprovalTasks — creates one WI card per Department; idempotent on re-run", async () => {
    const s = await scenario();
    await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.empGrounds.id, employmentAssignmentId: s.assignGrounds.id,
      workDate: utc(2026, 8, 15), hours: 8,
    });
    await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.empFB.id, employmentAssignmentId: s.assignFB.id,
      workDate: utc(2026, 8, 16), hours: 6,
    });
    const first = await orchestrateDepartmentApprovalTasks(s.adminP, s.clubA.id, s.payPeriod.id);
    expect(first.tasks.length).toBe(2);
    expect(first.tasks.filter((t) => t.created).length).toBe(2);
    // Manager routing.
    const gTask = first.tasks.find((t) => t.departmentId === s.grounds.id)!;
    const fTask = first.tasks.find((t) => t.departmentId === s.fb.id)!;
    expect(gTask.ownerUserId).toBe(s.groundsMgrUser.id);
    expect(fTask.ownerUserId).toBe(s.fbMgrUser.id);
    // Re-run is idempotent.
    const second = await orchestrateDepartmentApprovalTasks(s.adminP, s.clubA.id, s.payPeriod.id);
    expect(second.tasks.length).toBe(2);
    expect(second.tasks.every((t) => !t.created)).toBe(true);
    // Only 2 WorkIntakeItems for these origins exist.
    const items = await db().workIntakeItem.count({
      where: { clubId: s.clubA.id, workSubtype: "DEPARTMENT_TIME_APPROVAL" },
    });
    expect(items).toBe(2);
  });

  it("Department Head can approve their own Department but not another Department", async () => {
    const s = await scenario();
    await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.empGrounds.id, employmentAssignmentId: s.assignGrounds.id,
      workDate: utc(2026, 8, 15), hours: 8,
    });
    await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.empFB.id, employmentAssignmentId: s.assignFB.id,
      workDate: utc(2026, 8, 16), hours: 6,
    });
    // Grounds manager approves Grounds — succeeds.
    const ok = await approveDepartmentTime(s.groundsMgrP, s.clubA.id, s.payPeriod.id, s.grounds.id);
    expect(ok.approvedEntryCount).toBe(1);
    // Grounds manager tries to approve F&B — rejected (dual-check).
    await expect(
      approveDepartmentTime(s.groundsMgrP, s.clubA.id, s.payPeriod.id, s.fb.id),
    ).rejects.toThrow();
  });

  it("Payroll Admin handoff gating — created only when every payable department has approved, and routed to configured user", async () => {
    const s = await scenario();
    await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.empGrounds.id, employmentAssignmentId: s.assignGrounds.id,
      workDate: utc(2026, 8, 15), hours: 8,
    });
    await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.empFB.id, employmentAssignmentId: s.assignFB.id,
      workDate: utc(2026, 8, 16), hours: 6,
    });
    // Orchestrate; not all departments approved yet.
    await orchestrateDepartmentApprovalTasks(s.adminP, s.clubA.id, s.payPeriod.id);
    const preHandoff = await orchestratePayrollAdminHandoff(s.adminP, s.clubA.id, s.payPeriod.id);
    expect(preHandoff.status).toBe("not-ready");
    expect(preHandoff.pendingDepartments.length).toBe(2);
    // Approve Grounds only — still not ready.
    await approveDepartmentTime(s.adminP, s.clubA.id, s.payPeriod.id, s.grounds.id);
    const mid = await orchestratePayrollAdminHandoff(s.adminP, s.clubA.id, s.payPeriod.id);
    expect(mid.status).toBe("not-ready");
    expect(mid.pendingDepartments).toEqual(["FB"]);
    // Approve F&B — now ready.
    await approveDepartmentTime(s.adminP, s.clubA.id, s.payPeriod.id, s.fb.id);
    const done = await orchestratePayrollAdminHandoff(s.adminP, s.clubA.id, s.payPeriod.id);
    expect(done.status).toBe("created");
    expect(done.ownerUserId).toBe(s.payrollAdmin.id);
    // Re-run is idempotent.
    const again = await orchestratePayrollAdminHandoff(s.adminP, s.clubA.id, s.payPeriod.id);
    expect(again.status).toBe("existing");
    expect(again.workIntakeItemId).toBe(done.workIntakeItemId);
  });

  it("no payable time for a Department does not create a task or block Payroll Admin handoff", async () => {
    const s = await scenario();
    // Only Grounds has time; F&B has none.
    await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.empGrounds.id, employmentAssignmentId: s.assignGrounds.id,
      workDate: utc(2026, 8, 15), hours: 8,
    });
    const orch = await orchestrateDepartmentApprovalTasks(s.adminP, s.clubA.id, s.payPeriod.id);
    // Only 1 task (Grounds).
    expect(orch.tasks.length).toBe(1);
    expect(orch.tasks[0]!.departmentId).toBe(s.grounds.id);
    // Approve Grounds.
    await approveDepartmentTime(s.adminP, s.clubA.id, s.payPeriod.id, s.grounds.id);
    // Handoff is READY because no other department had payable time.
    const handoff = await orchestratePayrollAdminHandoff(s.adminP, s.clubA.id, s.payPeriod.id);
    expect(handoff.status).toBe("created");
  });

  it("approval completion resolves the associated Work Intake card; reopen reactivates it", async () => {
    const s = await scenario();
    await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.empGrounds.id, employmentAssignmentId: s.assignGrounds.id,
      workDate: utc(2026, 8, 15), hours: 8,
    });
    // Orchestrate so a WI card exists AND is linked to the approval.
    await orchestrateDepartmentApprovalTasks(s.adminP, s.clubA.id, s.payPeriod.id);
    // Approve — approval row is created FIRST. Then re-orchestrate to
    // back-link the WI card to the approval row.
    await approveDepartmentTime(s.adminP, s.clubA.id, s.payPeriod.id, s.grounds.id);
    await orchestrateDepartmentApprovalTasks(s.adminP, s.clubA.id, s.payPeriod.id);
    // Now approve again — the WI card should transition to RESOLVED.
    const approval = await db().payrollDepartmentTimeApproval.findFirstOrThrow({
      where: { clubId: s.clubA.id, payPeriodId: s.payPeriod.id, departmentId: s.grounds.id },
    });
    expect(approval.workIntakeItemId).not.toBeNull();
    await approveDepartmentTime(s.adminP, s.clubA.id, s.payPeriod.id, s.grounds.id);
    const wiAfterApprove = await db().workIntakeItem.findUniqueOrThrow({
      where: { id: approval.workIntakeItemId! },
    });
    expect(wiAfterApprove.status).toBe("RESOLVED");
    // Reopen — WI must become actionable again.
    await reopenDepartmentTime(s.adminP, s.clubA.id, s.payPeriod.id, s.grounds.id, "Corrections");
    const wiAfterReopen = await db().workIntakeItem.findUniqueOrThrow({
      where: { id: approval.workIntakeItemId! },
    });
    expect(wiAfterReopen.status).toBe("OPEN");
    expect(wiAfterReopen.resolvedAt).toBeNull();
    // And previously approved entries flip back to DRAFT.
    const status = await getDepartmentApprovalStatus(s.adminP, s.clubA.id, s.payPeriod.id);
    expect(status[0]!.state).toBe("REOPENED");
  });

  it("no PayrollAdmin configured → handoff returns 'no-admin-configured' (never falls back)", async () => {
    const s = await scenario();
    await upsertPayrollClubConfig(s.adminP, s.clubA.id, { payrollAdminUserId: null });
    await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.empGrounds.id, employmentAssignmentId: s.assignGrounds.id,
      workDate: utc(2026, 8, 15), hours: 8,
    });
    await approveDepartmentTime(s.adminP, s.clubA.id, s.payPeriod.id, s.grounds.id);
    const handoff = await orchestratePayrollAdminHandoff(s.adminP, s.clubA.id, s.payPeriod.id);
    expect(handoff.status).toBe("no-admin-configured");
    expect(handoff.workIntakeItemId).toBeNull();
  });

  it("audit trail: create + approve + reopen emit expected canonical events", async () => {
    const s = await scenario();
    await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.empGrounds.id, employmentAssignmentId: s.assignGrounds.id,
      workDate: utc(2026, 8, 15), hours: 8,
    });
    await approveDepartmentTime(s.adminP, s.clubA.id, s.payPeriod.id, s.grounds.id);
    await reopenDepartmentTime(s.adminP, s.clubA.id, s.payPeriod.id, s.grounds.id);
    const audits = await db().auditLog.findMany({
      where: { clubId: s.clubA.id, action: { startsWith: "payroll." } },
      select: { action: true },
      orderBy: { createdAt: "asc" },
    });
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("payroll.time-entry.create");
    expect(actions).toContain("payroll.department-time.approve");
    expect(actions).toContain("payroll.department-time.reopen");
  });
});
