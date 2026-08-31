// Payroll-3B-4 (2026-08-29) — structural batch preparation tests.
// Also covers the 3B-3 first-pass Work Intake linkage fix.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { ValidationError } from "@/lib/errors";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import { createTimeEntry } from "@/lib/payroll/approved-time";
import {
  approveDepartmentTime,
  reopenDepartmentTime,
} from "@/lib/payroll/department-approval";
import {
  orchestrateDepartmentApprovalTasks,
} from "@/lib/payroll/orchestration";
import {
  preparePayrollBatch,
  voidPayrollBatch,
  getPreparedBatch,
} from "@/lib/payroll/batch-preparation";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function issueFrom<T>(p: Promise<T>): Promise<string> {
  try { await p; throw new Error("expected reject"); }
  catch (e) {
    if (e instanceof ValidationError) return e.issues.map((i) => `${i.path}: ${i.message}`).join(" | ");
    throw e;
  }
}

async function scenario() {
  const clubA = await makeClub("Club A");
  const clubB = await makeClub("Club B");
  const payrollAdmin = await makeUser({ email: "pa@a.test", role: "PAYROLL_ADMIN", clubId: clubA.id });
  const controller = await makeUser({ email: "ctl@a.test", role: "CONTROLLER", clubId: clubA.id });
  const clubAdmin = await makeUser({ email: "admin@a.test", role: "CLUB_ADMIN", clubId: clubA.id });
  const adminP = await principalFor(clubAdmin.email);
  const payrollAdminP = await principalFor(payrollAdmin.email);

  await upsertPayrollClubConfig(adminP, clubA.id, {
    provinceOfEmployment: "AB",
    payrollAdminUserId: payrollAdmin.id,
    controllerUserId: controller.id,
  });

  // Two departments with managers.
  const grounds = await db().department.create({
    data: { clubId: clubA.id, code: "GROUNDS", name: "Grounds", sortOrder: 1 },
  });
  const fb = await db().department.create({
    data: { clubId: clubA.id, code: "FB", name: "F&B", sortOrder: 2 },
  });
  const groundsMgrUser = await makeUser({ email: "grounds.mgr@a.test", role: "DEPARTMENT_MANAGER", clubId: clubA.id });
  const groundsMgrEmp = await db().employee.create({
    data: {
      clubId: clubA.id, firstName: "Grounds", lastName: "Manager",
      email: groundsMgrUser.email, hireDate: utc(2026, 1, 1), dateOfBirth: utc(1990, 5, 12), status: "ACTIVE",
      employeeNumber: "E-MGR-G", userId: groundsMgrUser.id,
    },
  });

  // Hourly employee with covering assignment + compensation + banking.
  const hourlyEmp = await db().employee.create({
    data: {
      clubId: clubA.id, firstName: "Alex", lastName: "Grounds",
      email: "alex@a.test", hireDate: utc(2026, 1, 1), dateOfBirth: utc(1990, 5, 12), status: "ACTIVE",
      employeeNumber: "E-1001",
    },
  });
  const hourlyAssign = await db().employeeEmploymentAssignment.create({
    data: {
      clubId: clubA.id, employeeId: hourlyEmp.id, role: "PRIMARY",
      departmentId: grounds.id, managerEmployeeId: groundsMgrEmp.id,
      employmentType: "FULL_TIME", effectiveFrom: utc(2026, 1, 1),
    },
  });
  await db().employeeCompensation.create({
    data: {
      clubId: clubA.id, employeeId: hourlyEmp.id, assignmentId: hourlyAssign.id,
      cadence: "HOURLY", rate: "22.50", currency: "CAD",
      effectiveFrom: utc(2026, 1, 1),
    },
  });
  await db().employeeBankAccount.create({
    data: {
      clubId: clubA.id, employeeId: hourlyEmp.id,
      institutionSecretRef: "kms:test", transitSecretRef: "kms:test",
      accountSecretRef: "kms:test", holderName: "Alex Grounds",
      bankFingerprint: "fp1",
      status: "VERIFIED", activatedAt: utc(2026, 1, 1),
    },
  });

  // Salaried employee with covering assignment + compensation. NO time
  // entries — prove structural inclusion.
  const salariedEmp = await db().employee.create({
    data: {
      clubId: clubA.id, firstName: "Sam", lastName: "Salary",
      email: "sam@a.test", hireDate: utc(2026, 1, 1), dateOfBirth: utc(1990, 5, 12), status: "ACTIVE",
      employeeNumber: "E-1002",
    },
  });
  const salariedAssign = await db().employeeEmploymentAssignment.create({
    data: {
      clubId: clubA.id, employeeId: salariedEmp.id, role: "PRIMARY",
      departmentId: fb.id, employmentType: "FULL_TIME",
      effectiveFrom: utc(2026, 1, 1),
    },
  });
  await db().employeeCompensation.create({
    data: {
      clubId: clubA.id, employeeId: salariedEmp.id, assignmentId: salariedAssign.id,
      cadence: "SALARY", rate: "72000", currency: "CAD",
      effectiveFrom: utc(2026, 1, 1),
    },
  });

  // Pay group + pay period.
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

  // Both employees are members of this pay group for the period.
  await db().payrollPayGroupMember.create({
    data: { clubId: clubA.id, payGroupId: payGroup.id, employeeId: hourlyEmp.id, effectiveFrom: utc(2026, 1, 1) },
  });
  await db().payrollPayGroupMember.create({
    data: { clubId: clubA.id, payGroupId: payGroup.id, employeeId: salariedEmp.id, effectiveFrom: utc(2026, 1, 1) },
  });

  return {
    clubA, clubB, adminP, payrollAdmin, payrollAdminP,
    grounds, fb, hourlyEmp, salariedEmp, hourlyAssign, salariedAssign,
    payGroup, payPeriod,
  };
}

describe("Payroll-3B-4 — batch preparation", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  // ---- 3B-3 linkage fix regression ---------------------------------------

  it("REGRESSION 3B-3: orchestrate once → approve once → WI card resolves on the first pass", async () => {
    const s = await scenario();
    await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.hourlyEmp.id, employmentAssignmentId: s.hourlyAssign.id,
      workDate: utc(2026, 8, 15), hours: 8,
    });
    await orchestrateDepartmentApprovalTasks(s.adminP, s.clubA.id, s.payPeriod.id);
    // Approve — the approval row must be linked to the WI item WITHOUT
    // a second orchestrate. The WI card must then be RESOLVED.
    await approveDepartmentTime(s.adminP, s.clubA.id, s.payPeriod.id, s.grounds.id);
    const approval = await db().payrollDepartmentTimeApproval.findFirstOrThrow({
      where: { clubId: s.clubA.id, payPeriodId: s.payPeriod.id, departmentId: s.grounds.id },
    });
    expect(approval.workIntakeItemId).not.toBeNull();
    const wi = await db().workIntakeItem.findUniqueOrThrow({ where: { id: approval.workIntakeItemId! } });
    expect(wi.status).toBe("RESOLVED");
  });

  it("REGRESSION 3B-3: orchestrate once → approve → reopen → same WI card reactivates", async () => {
    const s = await scenario();
    await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.hourlyEmp.id, employmentAssignmentId: s.hourlyAssign.id,
      workDate: utc(2026, 8, 15), hours: 8,
    });
    await orchestrateDepartmentApprovalTasks(s.adminP, s.clubA.id, s.payPeriod.id);
    await approveDepartmentTime(s.adminP, s.clubA.id, s.payPeriod.id, s.grounds.id);
    const approval = await db().payrollDepartmentTimeApproval.findFirstOrThrow({
      where: { clubId: s.clubA.id, payPeriodId: s.payPeriod.id, departmentId: s.grounds.id },
    });
    const originalWi = approval.workIntakeItemId!;
    await reopenDepartmentTime(s.adminP, s.clubA.id, s.payPeriod.id, s.grounds.id, "correction");
    const wi = await db().workIntakeItem.findUniqueOrThrow({ where: { id: originalWi } });
    expect(wi.status).toBe("OPEN");
    expect(wi.resolvedAt).toBeNull();
  });

  // ---- Preparation preconditions -----------------------------------------

  it("preparation refuses while a required Department approval is missing (structured error)", async () => {
    const s = await scenario();
    await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.hourlyEmp.id, employmentAssignmentId: s.hourlyAssign.id,
      workDate: utc(2026, 8, 15), hours: 8,
    });
    const msg = await issueFrom(preparePayrollBatch(s.adminP, s.clubA.id, s.payPeriod.id));
    expect(msg).toMatch(/still awaiting time approval/i);
  });

  it("permission gate — user without payroll:run cannot prepare", async () => {
    const s = await scenario();
    // GENERAL_MANAGER holds payroll:run per the seeded matrix; STAFF does not.
    const staff = await makeUser({ email: "staff@a.test", role: "STAFF", clubId: s.clubA.id });
    const staffP = await principalFor(staff.email);
    await expect(preparePayrollBatch(staffP, s.clubA.id, s.payPeriod.id)).rejects.toThrow();
  });

  it("tenant isolation — Club A user cannot prepare a batch for Club B", async () => {
    const s = await scenario();
    await expect(preparePayrollBatch(s.adminP, s.clubB.id, s.payPeriod.id)).rejects.toThrow();
  });

  // ---- Population -------------------------------------------------------

  it("population — includes both hourly + salaried; excludes an unrelated Pay Group employee", async () => {
    const s = await scenario();
    // Employee in a DIFFERENT Pay Group — must NOT appear in the Batch.
    const otherEmp = await db().employee.create({
      data: {
        clubId: s.clubA.id, firstName: "Other", lastName: "Group",
        email: "other@a.test", hireDate: utc(2026, 1, 1), dateOfBirth: utc(1990, 5, 12), status: "ACTIVE",
        employeeNumber: "E-9999",
      },
    });
    const otherGroup = await db().payrollPayGroup.create({
      data: { clubId: s.clubA.id, code: "OTHER", name: "Other", payFrequency: "MONTHLY", payDateOffsetDays: 5 },
    });
    await db().payrollPayGroupMember.create({
      data: { clubId: s.clubA.id, payGroupId: otherGroup.id, employeeId: otherEmp.id, effectiveFrom: utc(2026, 1, 1) },
    });
    // Approve Grounds (only department with time — salaried employee has none).
    await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.hourlyEmp.id, employmentAssignmentId: s.hourlyAssign.id,
      workDate: utc(2026, 8, 15), hours: 8,
    });
    await approveDepartmentTime(s.adminP, s.clubA.id, s.payPeriod.id, s.grounds.id);
    const result = await preparePayrollBatch(s.adminP, s.clubA.id, s.payPeriod.id);
    expect(result.status).toBe("prepared");
    const batch = await getPreparedBatch(s.adminP, s.clubA.id, result.batchId);
    const employeeIds = batch!.employees.map((e) => e.employeeId).sort();
    expect(employeeIds).toEqual([s.hourlyEmp.id, s.salariedEmp.id].sort());
    expect(employeeIds).not.toContain(otherEmp.id);
  });

  // ---- Salaried structural inclusion ------------------------------------

  it("salaried employee — included without approved time; salaried=true; source facts snapshotted; NO earnings created", async () => {
    const s = await scenario();
    // Only hourly time is created; salaried has no time entries.
    await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.hourlyEmp.id, employmentAssignmentId: s.hourlyAssign.id,
      workDate: utc(2026, 8, 15), hours: 8,
    });
    await approveDepartmentTime(s.adminP, s.clubA.id, s.payPeriod.id, s.grounds.id);
    const result = await preparePayrollBatch(s.adminP, s.clubA.id, s.payPeriod.id);
    const batch = await getPreparedBatch(s.adminP, s.clubA.id, result.batchId);
    const salaried = batch!.employees.find((e) => e.employeeId === s.salariedEmp.id)!;
    expect(salaried.salaried).toBe(true);
    expect(salaried.approvedHoursSnapshot).toBeNull();
    expect(salaried.sourceFacts).not.toBeNull();
    expect(salaried.sourceFacts!.compensations.length).toBe(1);
    expect(salaried.sourceFacts!.compensations[0]!.payType).toBe("SALARY");
    expect(salaried.sourceFacts!.compensations[0]!.annualSalary).toBe("72000");
    // NO PayrollBatchEarning rows populated by 3B-4.
    const earnings = await db().payrollBatchEarning.count({ where: { batchId: result.batchId } });
    expect(earnings).toBe(0);
  });

  // ---- Hourly time attachment -------------------------------------------

  it("hourly employee — approved time attached + reserved via consumedByBatchId; hours preserved; no rate multiplication", async () => {
    const s = await scenario();
    await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.hourlyEmp.id, employmentAssignmentId: s.hourlyAssign.id,
      workDate: utc(2026, 8, 15), hours: 8,
    });
    await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.hourlyEmp.id, employmentAssignmentId: s.hourlyAssign.id,
      workDate: utc(2026, 8, 16), hours: 6,
    });
    await approveDepartmentTime(s.adminP, s.clubA.id, s.payPeriod.id, s.grounds.id);
    const result = await preparePayrollBatch(s.adminP, s.clubA.id, s.payPeriod.id);
    const batch = await getPreparedBatch(s.adminP, s.clubA.id, result.batchId);
    const hourly = batch!.employees.find((e) => e.employeeId === s.hourlyEmp.id)!;
    // Prisma Decimal normalizes "14.0000" → "14" on read. Compare
    // by numeric value for robustness across dev SQLite / prod PG.
    expect(Number(hourly.approvedHoursSnapshot)).toBe(14);
    expect(hourly.salaried).toBe(false);
    // Time entries reserved.
    const reserved = await db().payrollApprovedTimeEntry.count({
      where: { clubId: s.clubA.id, consumedByBatchId: result.batchId },
    });
    expect(reserved).toBe(2);
    // NO monetary earnings created.
    const earnings = await db().payrollBatchEarning.count({ where: { batchId: result.batchId } });
    expect(earnings).toBe(0);
  });

  // ---- Blockers / warnings ----------------------------------------------

  it("missing compensation produces a BLOCKER; batch stays DRAFT until resolved", async () => {
    const s = await scenario();
    // Second hourly employee at Grounds WITHOUT compensation.
    const empNoComp = await db().employee.create({
      data: {
        clubId: s.clubA.id, firstName: "NoComp", lastName: "Employee",
        email: "nc@a.test", hireDate: utc(2026, 1, 1), dateOfBirth: utc(1990, 5, 12), status: "ACTIVE",
        employeeNumber: "E-2000",
      },
    });
    const noCompAssign = await db().employeeEmploymentAssignment.create({
      data: {
        clubId: s.clubA.id, employeeId: empNoComp.id, role: "PRIMARY",
        departmentId: s.grounds.id, employmentType: "FULL_TIME",
        effectiveFrom: utc(2026, 1, 1),
      },
    });
    await db().payrollPayGroupMember.create({
      data: { clubId: s.clubA.id, payGroupId: s.payGroup.id, employeeId: empNoComp.id, effectiveFrom: utc(2026, 1, 1) },
    });
    await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: empNoComp.id, employmentAssignmentId: noCompAssign.id,
      workDate: utc(2026, 8, 15), hours: 8,
    });
    await approveDepartmentTime(s.adminP, s.clubA.id, s.payPeriod.id, s.grounds.id);
    const result = await preparePayrollBatch(s.adminP, s.clubA.id, s.payPeriod.id);
    expect(result.status).toBe("prepared-with-blockers");
    expect(result.blockerCount).toBeGreaterThan(0);
    const batch = await getPreparedBatch(s.adminP, s.clubA.id, result.batchId);
    expect(batch!.status).toBe("DRAFT");
    const missingComp = batch!.exceptions.filter((x) => x.code === "MISSING_COMPENSATION");
    expect(missingComp.length).toBe(1);
    expect(missingComp[0]!.employeeId).toBe(empNoComp.id);
  });

  it("banking NOT verified is a WARNING not a BLOCKER; batch reaches PREPARED", async () => {
    const s = await scenario();
    // Salaried has no banking — a warning; hourly has banking.
    await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.hourlyEmp.id, employmentAssignmentId: s.hourlyAssign.id,
      workDate: utc(2026, 8, 15), hours: 8,
    });
    await approveDepartmentTime(s.adminP, s.clubA.id, s.payPeriod.id, s.grounds.id);
    const result = await preparePayrollBatch(s.adminP, s.clubA.id, s.payPeriod.id);
    expect(result.status).toBe("prepared");
    expect(result.warningCount).toBeGreaterThan(0);
    const batch = await getPreparedBatch(s.adminP, s.clubA.id, result.batchId);
    expect(batch!.status).toBe("PREPARED");
    const bankWarn = batch!.exceptions.filter((x) => x.code === "BANKING_NOT_VERIFIED");
    expect(bankWarn.length).toBeGreaterThan(0);
    expect(bankWarn.every((x) => x.severity === "WARNING")).toBe(true);
  });

  // ---- Idempotency & void -----------------------------------------------

  it("idempotency — double-prepare returns the same batch id, no duplicates", async () => {
    const s = await scenario();
    await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.hourlyEmp.id, employmentAssignmentId: s.hourlyAssign.id,
      workDate: utc(2026, 8, 15), hours: 8,
    });
    await approveDepartmentTime(s.adminP, s.clubA.id, s.payPeriod.id, s.grounds.id);
    const first = await preparePayrollBatch(s.adminP, s.clubA.id, s.payPeriod.id);
    const second = await preparePayrollBatch(s.adminP, s.clubA.id, s.payPeriod.id);
    expect(second.batchId).toBe(first.batchId);
    expect(second.status).toBe("existing");
    const count = await db().payrollBatch.count({
      where: { clubId: s.clubA.id, payPeriodId: s.payPeriod.id, status: { not: "VOIDED" } },
    });
    expect(count).toBe(1);
  });

  it("void releases time reservations; batch history preserved; re-prepare creates a fresh sequence", async () => {
    const s = await scenario();
    await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.hourlyEmp.id, employmentAssignmentId: s.hourlyAssign.id,
      workDate: utc(2026, 8, 15), hours: 8,
    });
    await approveDepartmentTime(s.adminP, s.clubA.id, s.payPeriod.id, s.grounds.id);
    const first = await preparePayrollBatch(s.adminP, s.clubA.id, s.payPeriod.id);
    expect(first.approvedTimeEntryCount).toBe(1);
    const voidRes = await voidPayrollBatch(s.adminP, s.clubA.id, first.batchId, "correction needed");
    expect(voidRes.releasedTimeEntryCount).toBe(1);
    // Voided batch preserved.
    const voided = await db().payrollBatch.findUniqueOrThrow({ where: { id: first.batchId } });
    expect(voided.status).toBe("VOIDED");
    expect(voided.voidReason).toBe("correction needed");
    // Time entry back to unreserved.
    const stillReserved = await db().payrollApprovedTimeEntry.count({
      where: { clubId: s.clubA.id, consumedByBatchId: first.batchId },
    });
    expect(stillReserved).toBe(0);
    // Re-prepare creates a fresh batch with next sequence.
    const second = await preparePayrollBatch(s.adminP, s.clubA.id, s.payPeriod.id);
    expect(second.batchId).not.toBe(first.batchId);
    expect(second.status).toBe("prepared");
    const newBatch = await db().payrollBatch.findUniqueOrThrow({ where: { id: second.batchId } });
    expect(newBatch.sequence).toBe(voided.sequence + 1);
  });

  // ---- Snapshot immutability --------------------------------------------

  it("source change AFTER preparation does NOT mutate the frozen batch snapshot", async () => {
    const s = await scenario();
    await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.hourlyEmp.id, employmentAssignmentId: s.hourlyAssign.id,
      workDate: utc(2026, 8, 15), hours: 8,
    });
    await approveDepartmentTime(s.adminP, s.clubA.id, s.payPeriod.id, s.grounds.id);
    const result = await preparePayrollBatch(s.adminP, s.clubA.id, s.payPeriod.id);
    const before = await getPreparedBatch(s.adminP, s.clubA.id, result.batchId);
    // Now mutate the compensation OUT-OF-BAND (simulates HR change).
    await db().employeeCompensation.updateMany({
      where: { employeeId: s.hourlyEmp.id },
      data: { rate: "999.99" },
    });
    const after = await getPreparedBatch(s.adminP, s.clubA.id, result.batchId);
    const beforeFact = before!.employees.find((e) => e.employeeId === s.hourlyEmp.id)!.sourceFacts!;
    const afterFact = after!.employees.find((e) => e.employeeId === s.hourlyEmp.id)!.sourceFacts!;
    expect(afterFact.compensations[0]!.hourlyRate).toBe(beforeFact.compensations[0]!.hourlyRate);
    expect(beforeFact.compensations[0]!.hourlyRate).toBe("22.5");
  });

  // ---- Work Intake transition -------------------------------------------

  it("preparation resolves PAYROLL_ADMIN_PROCESSING and creates exactly one PAYROLL_REVIEW; idempotent on retry", async () => {
    const { orchestratePayrollAdminHandoff, orchestratePayrollReviewHandoff } =
      await import("@/lib/payroll/orchestration");
    const s = await scenario();
    await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.hourlyEmp.id, employmentAssignmentId: s.hourlyAssign.id,
      workDate: utc(2026, 8, 15), hours: 8,
    });
    await approveDepartmentTime(s.adminP, s.clubA.id, s.payPeriod.id, s.grounds.id);
    // Payroll Admin card exists (from 3B-3 handoff).
    const admin = await orchestratePayrollAdminHandoff(s.adminP, s.clubA.id, s.payPeriod.id);
    expect(admin.status).toBe("created");
    // Prepare and spawn review.
    const result = await preparePayrollBatch(s.adminP, s.clubA.id, s.payPeriod.id);
    const review = await orchestratePayrollReviewHandoff(s.adminP, s.clubA.id, s.payPeriod.id, result.batchId);
    expect(review.status).toBe("created");
    expect(review.ownerUserId).toBe(s.payrollAdmin.id);
    // Existing ADMIN_PROCESSING → RESOLVED.
    const adminItem = await db().workIntakeItem.findUniqueOrThrow({ where: { id: admin.workIntakeItemId! } });
    expect(adminItem.status).toBe("RESOLVED");
    // Retry — no duplicate REVIEW card.
    const again = await orchestratePayrollReviewHandoff(s.adminP, s.clubA.id, s.payPeriod.id, result.batchId);
    expect(again.status).toBe("existing");
    expect(again.workIntakeItemId).toBe(review.workIntakeItemId);
    const reviewCount = await db().workIntakeItem.count({
      where: { clubId: s.clubA.id, workSubtype: "PAYROLL_REVIEW" },
    });
    expect(reviewCount).toBe(1);
  });

  it("audit — canonical payroll.batch.prepare + payroll.batch.void events emitted", async () => {
    const s = await scenario();
    await createTimeEntry(s.adminP, s.clubA.id, {
      employeeId: s.hourlyEmp.id, employmentAssignmentId: s.hourlyAssign.id,
      workDate: utc(2026, 8, 15), hours: 8,
    });
    await approveDepartmentTime(s.adminP, s.clubA.id, s.payPeriod.id, s.grounds.id);
    const prep = await preparePayrollBatch(s.adminP, s.clubA.id, s.payPeriod.id);
    await voidPayrollBatch(s.adminP, s.clubA.id, prep.batchId);
    const audits = await db().auditLog.findMany({
      where: { clubId: s.clubA.id, action: { in: ["payroll.batch.prepare", "payroll.batch.void"] } },
      select: { action: true },
    });
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("payroll.batch.prepare");
    expect(actions).toContain("payroll.batch.void");
  });
});
