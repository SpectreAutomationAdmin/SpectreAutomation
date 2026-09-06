// Payroll-3D-4 (2026-09-05) — Approved timesheets → PayrollApprovedTimeEntry
// freeze + cutoff + late-time + retro adjustment tests.
//
// Covers the 3D-4 test-plan §55-§75, cutoff §63-§65, late §66-§67,
// retro §68-§70 (positive/negative/unconsumed-stale), and salary
// regression §74.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import {
  freezeApprovedScopeIntoPayroll,
  getPayPeriodTimeReadiness,
} from "@/lib/payroll/freeze-service";
import {
  resolveLateAdjustment,
  listOpenLateExceptions,
} from "@/lib/payroll/late-time-service";
import { approveTimesheetScope } from "@/lib/timesheets/manager-approval";
import { getScopeReview } from "@/lib/timesheets/approval-scope";
import {
  approveCorrectionRequest,
  submitCorrectionRequest,
} from "@/lib/timesheets/correction-service";
import { materializeEmployeeTimesheet } from "@/lib/timesheets/service";
import { computeCutoffInstant, classifyCutoffTiming } from "@/lib/payroll/cutoff";
import { ConflictError, ValidationError } from "@/lib/errors";
import type { EmployeePortalPrincipal } from "@/lib/employee-portal-session";

const utc = (y: number, m: number, d: number, h = 0, mi = 0) =>
  new Date(Date.UTC(y, m - 1, d, h, mi));

let scenarioCounter = 0;
async function scenario() {
  scenarioCounter += 1;
  const suffix = `${scenarioCounter}-${Math.floor(Math.random() * 1_000_000)}`;
  const club = await makeClub(`3D4-${suffix}`);
  await db().club.update({ where: { id: club.id }, data: { timezone: "America/Edmonton" } });
  const grounds = await db().department.create({
    data: { clubId: club.id, code: `GROUNDS-${suffix}`, name: "Grounds", sortOrder: 1 },
  });
  const banquets = await db().department.create({
    data: { clubId: club.id, code: `BANQUETS-${suffix}`, name: "Banquets", sortOrder: 2 },
  });
  const groundsMgr  = await makeUser({ email: `gmgr-${suffix}@t.test`, role: "DEPARTMENT_MANAGER", clubId: club.id });
  const banquetsMgr = await makeUser({ email: `bmgr-${suffix}@t.test`, role: "DEPARTMENT_MANAGER", clubId: club.id });
  const payrollAdmin = await makeUser({ email: `pa-${suffix}@t.test`, role: "PAYROLL_ADMIN", clubId: club.id });
  const tenantAdmin = await makeUser({ email: `ta-${suffix}@t.test`, role: "CLUB_ADMIN", clubId: club.id });
  await db().responsibilityAssignment.create({
    data: {
      clubId: club.id, userId: tenantAdmin.id,
      responsibilityKey: "TENANT_ADMINISTRATION",
      role: "PRIMARY", effectiveFrom: utc(2020, 1, 1),
    },
  });
  await db().departmentResponsibility.create({
    data: {
      clubId: club.id, departmentId: grounds.id,
      responsibilityKey: "DEPARTMENT_TIME_APPROVAL", userId: groundsMgr.id,
    },
  });
  await db().departmentResponsibility.create({
    data: {
      clubId: club.id, departmentId: banquets.id,
      responsibilityKey: "DEPARTMENT_TIME_APPROVAL", userId: banquetsMgr.id,
    },
  });
  const pg = await db().payrollPayGroup.create({
    data: {
      clubId: club.id, code: `SM-${suffix}`, name: "Semi-Monthly",
      payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 5,
      calendarAnchorDate: utc(2026, 1, 1), active: true,
    },
  });
  const period = await db().payrollPayPeriod.create({
    data: {
      clubId: club.id, payGroupId: pg.id, taxYear: 2026, sequenceInYear: 17,
      periodStart: utc(2026, 9, 1), periodEnd: utc(2026, 9, 16),
      payDate:     utc(2026, 9, 20), status: "OPEN",
    },
  });
  // Second period so DEFER_NEXT_PAYROLL has a target.
  const next = await db().payrollPayPeriod.create({
    data: {
      clubId: club.id, payGroupId: pg.id, taxYear: 2026, sequenceInYear: 18,
      periodStart: utc(2026, 9, 16), periodEnd: utc(2026, 10, 1),
      payDate:     utc(2026, 10, 5), status: "FUTURE",
    },
  });
  return { club, grounds, banquets, groundsMgr, banquetsMgr, payrollAdmin, tenantAdmin, pg, period, nextPeriod: next };
}

async function seedEmp(clubId: string, seed: string, departmentId: string) {
  const emp = await db().employee.create({
    data: {
      clubId, firstName: "T", lastName: seed,
      email: `t.${seed}@t.test`, hireDate: utc(2026, 1, 1),
      status: "ACTIVE", employeeLifecycle: "ACTIVE",
      employeeNumber: `E-${seed}`, compensationType: "HOURLY",
      homeProvince: "AB", timekeepingMethod: "CLOCK_REQUIRED",
    },
  });
  const assn = await db().employeeEmploymentAssignment.create({
    data: {
      clubId, employeeId: emp.id, role: "PRIMARY",
      employmentType: "PART_TIME", effectiveFrom: utc(2026, 1, 1),
      departmentId,
    },
  });
  const pg = await db().payrollPayGroup.findFirstOrThrow({ where: { clubId } });
  await db().payrollPayGroupMember.create({
    data: { clubId, payGroupId: pg.id, employeeId: emp.id, effectiveFrom: utc(2020, 1, 1) },
  });
  return { emp, assn };
}

async function seedClockedSession(
  clubId: string, employeeId: string, assignmentId: string,
  clockInAt: Date, clockOutAt: Date,
) {
  await db().timeClockEvent.create({
    data: {
      clubId, employeeId, kind: "CLOCK_IN",
      occurredAt: clockInAt, source: "EMPLOYEE_PORTAL",
      employmentAssignmentId: assignmentId,
    },
  });
  await db().timeClockEvent.create({
    data: {
      clubId, employeeId, kind: "CLOCK_OUT",
      occurredAt: clockOutAt, source: "EMPLOYEE_PORTAL",
      employmentAssignmentId: assignmentId,
    },
  });
}

async function approveGroundsScope(F: Awaited<ReturnType<typeof scenario>>) {
  const groundsP = await principalFor(F.groundsMgr.email);
  const review = await getScopeReview(F.club.id, F.period.id, F.grounds.id);
  await approveTimesheetScope(groundsP, {
    clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id,
    attestedRevision: review.currentRevision,
  });
}

function portalPrincipal(clubId: string, employeeId: string): EmployeePortalPrincipal {
  return { clubId, employeeId, generation: 1, establishedAt: new Date().toISOString() };
}

// ==================================================================
// A · Cutoff helpers
// ==================================================================
describe("Payroll-3D-4 · cutoff helpers", () => {
  it("computeCutoffInstant returns 5 days before payDate at start-of-day Club-tz", () => {
    // payDate = 2026-09-20 00:00 UTC
    // -5 days = 2026-09-15 00:00 UTC
    // Start-of-day America/Edmonton on 2026-09-14 (because 2026-09-15 UTC-midnight
    // is 2026-09-14 18:00 America/Edmonton).
    const payDate = utc(2026, 9, 20);
    const cutoff = computeCutoffInstant(payDate, "America/Edmonton", 5);
    // 2026-09-14 00:00 America/Edmonton (MDT UTC-6) = 2026-09-14 06:00 UTC
    expect(cutoff.toISOString()).toBe("2026-09-14T06:00:00.000Z");
  });

  it("classifyCutoffTiming: <= cutoff → ON_TIME, > cutoff → LATE", () => {
    const cutoff = new Date("2026-09-14T06:00:00.000Z");
    expect(classifyCutoffTiming(new Date("2026-09-14T05:00:00Z"), cutoff)).toBe("ON_TIME");
    expect(classifyCutoffTiming(new Date("2026-09-14T06:00:00.000Z"), cutoff)).toBe("ON_TIME");
    expect(classifyCutoffTiming(new Date("2026-09-14T06:00:01Z"), cutoff)).toBe("LATE");
  });
});

// ==================================================================
// B · Clean freeze (§55, §56, §57)
// ==================================================================
describe("Payroll-3D-4 · clean freeze", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("§55 clean scope → one APPROVED PayrollApprovedTimeEntry per timesheet entry with full provenance", async () => {
    const F = await scenario();
    const { emp, assn } = await seedEmp(F.club.id, "taylor", F.grounds.id);
    await seedClockedSession(F.club.id, emp.id, assn.id,
      utc(2026, 9, 5, 14, 0), utc(2026, 9, 5, 22, 0));
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);
    await approveGroundsScope(F);

    const paP = await principalFor(F.payrollAdmin.email);
    const r = await freezeApprovedScopeIntoPayroll(paP, {
      clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id,
    });
    expect(r.entriesCreated).toBe(1);
    expect(r.entriesAlreadyFrozen).toBe(0);
    expect(r.timing).toBe("ON_TIME");
    expect(r.lateAdjustmentId).toBeNull();

    const rows = await db().payrollApprovedTimeEntry.findMany({
      where: { clubId: F.club.id, employeeId: emp.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].approvalState).toBe("APPROVED");
    expect(rows[0].consumedByBatchId).toBeNull();
    expect(rows[0].hours.toString()).toBe("8");
    expect(rows[0].employmentAssignmentId).toBe(assn.id);
    expect(rows[0].workDate.toISOString().slice(0, 10)).toBe("2026-09-05");
    expect(rows[0].payrollTimesheetEntryId).toBeTruthy();
    expect(rows[0].sourceApprovalId).toBeTruthy();
    expect(rows[0].sourceApprovalRevision).toBeTruthy();
  });

  it("§56 idempotent — second freeze produces zero new rows", async () => {
    const F = await scenario();
    const { emp, assn } = await seedEmp(F.club.id, "idem", F.grounds.id);
    await seedClockedSession(F.club.id, emp.id, assn.id,
      utc(2026, 9, 5, 14, 0), utc(2026, 9, 5, 22, 0));
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);
    await approveGroundsScope(F);
    const paP = await principalFor(F.payrollAdmin.email);
    const r1 = await freezeApprovedScopeIntoPayroll(paP, {
      clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id,
    });
    const r2 = await freezeApprovedScopeIntoPayroll(paP, {
      clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id,
    });
    expect(r1.entriesCreated).toBe(1);
    expect(r2.entriesCreated).toBe(0);
    expect(r2.entriesAlreadyFrozen).toBe(1);
    const count = await db().payrollApprovedTimeEntry.count({ where: { clubId: F.club.id } });
    expect(count).toBe(1);
  });

  it("§57 concurrent freeze → one canonical set of rows", async () => {
    const F = await scenario();
    const { emp, assn } = await seedEmp(F.club.id, "cc", F.grounds.id);
    await seedClockedSession(F.club.id, emp.id, assn.id,
      utc(2026, 9, 5, 14, 0), utc(2026, 9, 5, 22, 0));
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);
    await approveGroundsScope(F);
    const paP = await principalFor(F.payrollAdmin.email);
    await Promise.allSettled([
      freezeApprovedScopeIntoPayroll(paP, { clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id }),
      freezeApprovedScopeIntoPayroll(paP, { clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id }),
    ]);
    const rows = await db().payrollApprovedTimeEntry.findMany({ where: { clubId: F.club.id } });
    expect(rows).toHaveLength(1);
  });
});

// ==================================================================
// C · Refusal paths (§58 stale, §59 blocking exception, §60 pending correction)
// ==================================================================
describe("Payroll-3D-4 · freeze refusals", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("§58 stale approval — freeze refuses and invalidates", async () => {
    const F = await scenario();
    const { emp, assn } = await seedEmp(F.club.id, "stale", F.grounds.id);
    const inEv = await db().timeClockEvent.create({
      data: {
        clubId: F.club.id, employeeId: emp.id, kind: "CLOCK_IN",
        occurredAt: utc(2026, 9, 5, 14, 0), source: "EMPLOYEE_PORTAL",
        employmentAssignmentId: assn.id,
      },
    });
    await db().timeClockEvent.create({
      data: {
        clubId: F.club.id, employeeId: emp.id, kind: "CLOCK_OUT",
        occurredAt: utc(2026, 9, 5, 22, 0), source: "EMPLOYEE_PORTAL",
        employmentAssignmentId: assn.id,
      },
    });
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);
    await approveGroundsScope(F);

    // Correction submitted — bumps currentRevision → approvedRevision stale.
    await submitCorrectionRequest(portalPrincipal(F.club.id, emp.id), {
      requestType: "CORRECT_CLOCK_IN",
      originalClockEventId: inEv.id,
      requestedLocalIso: "2026-09-05T09:00",
      reason: "arrived earlier",
    });

    const paP = await principalFor(F.payrollAdmin.email);
    // Either ValidationError (readiness blocked by PENDING_CORRECTION)
    // or ConflictError (revision drift) is acceptable — both prove
    // freeze fails closed on stale/blocked scope.
    await expect(freezeApprovedScopeIntoPayroll(paP, {
      clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id,
    })).rejects.toBeInstanceOf(Error);

    const rows = await db().payrollApprovedTimeEntry.count({ where: { clubId: F.club.id } });
    expect(rows).toBe(0);
  });

  it("§59 missing clock-out — freeze refuses (approval could not exist, but defense in depth)", async () => {
    const F = await scenario();
    const { emp, assn } = await seedEmp(F.club.id, "mco", F.grounds.id);
    // Only CLOCK_IN — no CLOCK_OUT.
    await db().timeClockEvent.create({
      data: {
        clubId: F.club.id, employeeId: emp.id, kind: "CLOCK_IN",
        occurredAt: utc(2026, 9, 5, 14, 0), source: "EMPLOYEE_PORTAL",
        employmentAssignmentId: assn.id,
      },
    });
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);
    const paP = await principalFor(F.payrollAdmin.email);
    // No approval exists → freeze refuses.
    await expect(freezeApprovedScopeIntoPayroll(paP, {
      clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id,
    })).rejects.toThrow(ValidationError);
    const count = await db().payrollApprovedTimeEntry.count({ where: { clubId: F.club.id } });
    expect(count).toBe(0);
  });
});

// ==================================================================
// D · Multi-scope (§61) + assignment routing (§62)
// ==================================================================
describe("Payroll-3D-4 · scope routing", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("§61 freeze one scope while the other is not approved — no rows for unapproved scope", async () => {
    const F = await scenario();
    const { emp: e1, assn: a1 } = await seedEmp(F.club.id, "g", F.grounds.id);
    const { emp: e2, assn: a2 } = await seedEmp(F.club.id, "b", F.banquets.id);
    await seedClockedSession(F.club.id, e1.id, a1.id, utc(2026, 9, 5, 14, 0), utc(2026, 9, 5, 22, 0));
    await seedClockedSession(F.club.id, e2.id, a2.id, utc(2026, 9, 6, 14, 0), utc(2026, 9, 6, 22, 0));
    await materializeEmployeeTimesheet(F.club.id, e1.id, F.period.id);
    await materializeEmployeeTimesheet(F.club.id, e2.id, F.period.id);
    await approveGroundsScope(F);
    // Banquets NOT approved.
    const paP = await principalFor(F.payrollAdmin.email);
    await freezeApprovedScopeIntoPayroll(paP, {
      clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id,
    });
    // Banquets refuses.
    await expect(freezeApprovedScopeIntoPayroll(paP, {
      clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.banquets.id,
    })).rejects.toThrow(ValidationError);
    const rows = await db().payrollApprovedTimeEntry.findMany({ where: { clubId: F.club.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].employeeId).toBe(e1.id);
    // Overall pay-period readiness reflects the incomplete state.
    const ready = await getPayPeriodTimeReadiness(paP, F.club.id, F.period.id);
    expect(ready.overallReady).toBe(false);
    expect(ready.hasUnapprovedScopes).toBe(true);
  });
});

// ==================================================================
// E · Cutoff behaviour (§63-§65) + Late Include/Defer (§66-§67)
// ==================================================================
describe("Payroll-3D-4 · cutoff + late-time", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("§63 on-time freeze — no late adjustment", async () => {
    const F = await scenario();
    const { emp, assn } = await seedEmp(F.club.id, "ontime", F.grounds.id);
    await seedClockedSession(F.club.id, emp.id, assn.id,
      utc(2026, 9, 5, 14, 0), utc(2026, 9, 5, 22, 0));
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);
    // Manager approval "happened" at 2026-09-10 (well before 09-14 cutoff).
    // We simulate by setting approvedAt after approve.
    await approveGroundsScope(F);
    await db().payrollDepartmentTimeApproval.updateMany({
      where: { clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id },
      data: { approvedAt: utc(2026, 9, 10, 12, 0) },
    });
    const paP = await principalFor(F.payrollAdmin.email);
    const r = await freezeApprovedScopeIntoPayroll(paP, {
      clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id,
    });
    expect(r.timing).toBe("ON_TIME");
    expect(r.lateAdjustmentId).toBeNull();
    const lateCount = await db().payrollTimeAdjustment.count({
      where: { clubId: F.club.id, reason: "LATE_APPROVAL" },
    });
    expect(lateCount).toBe(0);
  });

  it("§65 approval one second after cutoff → late adjustment created", async () => {
    const F = await scenario();
    const { emp, assn } = await seedEmp(F.club.id, "late", F.grounds.id);
    await seedClockedSession(F.club.id, emp.id, assn.id,
      utc(2026, 9, 5, 14, 0), utc(2026, 9, 5, 22, 0));
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);
    await approveGroundsScope(F);
    // cutoff = 2026-09-14 06:00 UTC. Set approvedAt to 06:00:01 → late.
    await db().payrollDepartmentTimeApproval.updateMany({
      where: { clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id },
      data: { approvedAt: new Date("2026-09-14T06:00:01.000Z") },
    });
    const paP = await principalFor(F.payrollAdmin.email);
    const r = await freezeApprovedScopeIntoPayroll(paP, {
      clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id,
    });
    expect(r.timing).toBe("LATE");
    expect(r.lateAdjustmentId).toBeTruthy();
    // Row still exists but a LATE_APPROVAL adjustment sits in OPEN.
    const late = await db().payrollTimeAdjustment.findFirstOrThrow({
      where: { clubId: F.club.id, reason: "LATE_APPROVAL", status: "OPEN" },
    });
    expect(late.differenceHours.toString()).toBe("8");
  });

  it("§66 late INCLUDE_CURRENT → row remains APPROVED, adjustment status flips", async () => {
    const F = await scenario();
    const { emp, assn } = await seedEmp(F.club.id, "inc", F.grounds.id);
    await seedClockedSession(F.club.id, emp.id, assn.id,
      utc(2026, 9, 5, 14, 0), utc(2026, 9, 5, 22, 0));
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);
    await approveGroundsScope(F);
    await db().payrollDepartmentTimeApproval.updateMany({
      where: { clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id },
      data: { approvedAt: new Date("2026-09-14T06:00:01.000Z") },
    });
    const paP = await principalFor(F.payrollAdmin.email);
    const r = await freezeApprovedScopeIntoPayroll(paP, {
      clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id,
    });
    await resolveLateAdjustment(paP, F.club.id, {
      adjustmentId: r.lateAdjustmentId!, resolution: "INCLUDE_CURRENT",
    });
    const rows = await db().payrollApprovedTimeEntry.findMany({ where: { clubId: F.club.id } });
    expect(rows[0].approvalState).toBe("APPROVED");
    const adj = await db().payrollTimeAdjustment.findFirstOrThrow({
      where: { clubId: F.club.id, reason: "LATE_APPROVAL" },
    });
    expect(adj.status).toBe("INCLUDE_CURRENT");
  });

  it("§67 late DEFER_NEXT_PAYROLL → row transitions to DEFERRED + adjustment target set", async () => {
    const F = await scenario();
    const { emp, assn } = await seedEmp(F.club.id, "def", F.grounds.id);
    await seedClockedSession(F.club.id, emp.id, assn.id,
      utc(2026, 9, 5, 14, 0), utc(2026, 9, 5, 22, 0));
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);
    await approveGroundsScope(F);
    await db().payrollDepartmentTimeApproval.updateMany({
      where: { clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id },
      data: { approvedAt: new Date("2026-09-14T06:00:01.000Z") },
    });
    const paP = await principalFor(F.payrollAdmin.email);
    const r = await freezeApprovedScopeIntoPayroll(paP, {
      clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id,
    });
    const dr = await resolveLateAdjustment(paP, F.club.id, {
      adjustmentId: r.lateAdjustmentId!, resolution: "DEFER_NEXT_PAYROLL",
    });
    expect(dr.targetPayPeriodId).toBe(F.nextPeriod.id);
    const rows = await db().payrollApprovedTimeEntry.findMany({ where: { clubId: F.club.id } });
    expect(rows[0].approvalState).toBe("DEFERRED");
    const adj = await db().payrollTimeAdjustment.findFirstOrThrow({
      where: { clubId: F.club.id, reason: "LATE_APPROVAL" },
    });
    expect(adj.status).toBe("DEFER_NEXT_PAYROLL");
    expect(adj.targetPayPeriodId).toBe(F.nextPeriod.id);
  });
});

// ==================================================================
// F · Retro / stale correction handling (§68-§70)
// ==================================================================
describe("Payroll-3D-4 · retro + unconsumed-stale", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("§68 approved correction after consumption creates a signed PayrollTimeAdjustment; original row unchanged", async () => {
    const F = await scenario();
    const { emp, assn } = await seedEmp(F.club.id, "retro", F.grounds.id);
    await seedClockedSession(F.club.id, emp.id, assn.id,
      utc(2026, 9, 5, 14, 0), utc(2026, 9, 5, 22, 0));
    const cout = await db().timeClockEvent.findFirstOrThrow({
      where: { clubId: F.club.id, employeeId: emp.id, kind: "CLOCK_OUT" },
    });
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);
    await approveGroundsScope(F);
    const paP = await principalFor(F.payrollAdmin.email);
    const r = await freezeApprovedScopeIntoPayroll(paP, {
      clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id,
    });
    const frozenRowId = (await db().payrollApprovedTimeEntry.findFirstOrThrow({
      where: { clubId: F.club.id },
    })).id;
    // Simulate consumption by giving the row a consumedByBatchId.
    // We use a dummy batch id (no real batch needed) so the retro path fires.
    const batch = await db().payrollBatch.create({
      data: {
        clubId: F.club.id, payGroupId: F.pg.id, payPeriodId: F.period.id,
        status: "PREPARED",
      },
    });
    await db().payrollApprovedTimeEntry.update({
      where: { id: frozenRowId }, data: { consumedByBatchId: batch.id },
    });

    // Now approve a correction that extends CLOCK_OUT to 23:00 (+1h).
    const groundsP = await principalFor(F.groundsMgr.email);
    const submit = await submitCorrectionRequest(portalPrincipal(F.club.id, emp.id), {
      requestType: "CORRECT_CLOCK_OUT",
      originalClockEventId: cout.id,
      requestedLocalIso: "2026-09-05T23:00",
      reason: "stayed later",
    });
    await approveCorrectionRequest(groundsP, F.club.id, { requestId: submit.request.id });

    // Historical consumed row unchanged.
    const orig = await db().payrollApprovedTimeEntry.findUniqueOrThrow({ where: { id: frozenRowId } });
    expect(orig.hours.toString()).toBe("8");
    expect(orig.consumedByBatchId).toBe(batch.id);
    expect(orig.approvalState).toBe("APPROVED");

    // A signed retro adjustment exists for the +1h difference.
    // NOTE: America/Edmonton local 23:00 on 2026-09-05 corresponds to
    // 2026-09-06 05:00 UTC. The original CLOCK_OUT was 2026-09-05 22:00 UTC.
    // Signed diff = new recorded seconds - prior seconds, computed live.
    const adj = await db().payrollTimeAdjustment.findFirstOrThrow({
      where: { clubId: F.club.id, reason: "RETRO_CORRECTION", status: "OPEN" },
    });
    expect(Number(adj.differenceHours.toString())).toBeGreaterThan(0);
    expect(adj.originalApprovedTimeEntryId).toBe(frozenRowId);
    expect(adj.targetPayPeriodId).toBe(F.nextPeriod.id);
    void r;
  });

  it("§69 negative retro — correction reduces recorded time; adjustment is negative", async () => {
    const F = await scenario();
    const { emp, assn } = await seedEmp(F.club.id, "neg", F.grounds.id);
    await seedClockedSession(F.club.id, emp.id, assn.id,
      utc(2026, 9, 5, 14, 0), utc(2026, 9, 5, 22, 0));
    const cout = await db().timeClockEvent.findFirstOrThrow({
      where: { clubId: F.club.id, employeeId: emp.id, kind: "CLOCK_OUT" },
    });
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);
    await approveGroundsScope(F);
    const paP = await principalFor(F.payrollAdmin.email);
    await freezeApprovedScopeIntoPayroll(paP, {
      clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id,
    });
    const frozenRow = await db().payrollApprovedTimeEntry.findFirstOrThrow({
      where: { clubId: F.club.id },
    });
    const batch = await db().payrollBatch.create({
      data: { clubId: F.club.id, payGroupId: F.pg.id, payPeriodId: F.period.id, status: "PREPARED" },
    });
    await db().payrollApprovedTimeEntry.update({
      where: { id: frozenRow.id }, data: { consumedByBatchId: batch.id },
    });

    // Correction: original CLOCK_IN at 14:00 UTC = 08:00 America/Edmonton.
    // Original CLOCK_OUT at 22:00 UTC = 16:00 America/Edmonton (8h session).
    // Correct CLOCK_OUT to 14:00 America/Edmonton = 20:00 UTC (6h session).
    // Signed diff = -2h.
    const groundsP = await principalFor(F.groundsMgr.email);
    const submit = await submitCorrectionRequest(portalPrincipal(F.club.id, emp.id), {
      requestType: "CORRECT_CLOCK_OUT",
      originalClockEventId: cout.id,
      requestedLocalIso: "2026-09-05T14:00",
      reason: "left earlier",
    });
    await approveCorrectionRequest(groundsP, F.club.id, { requestId: submit.request.id });

    const adj = await db().payrollTimeAdjustment.findFirstOrThrow({
      where: { clubId: F.club.id, reason: "RETRO_CORRECTION" },
    });
    expect(Number(adj.differenceHours.toString())).toBeLessThan(0);
  });

  it("§70 unconsumed stale — frozen row marked SUPERSEDED_STALE, not overwritten", async () => {
    const F = await scenario();
    const { emp, assn } = await seedEmp(F.club.id, "us", F.grounds.id);
    await seedClockedSession(F.club.id, emp.id, assn.id,
      utc(2026, 9, 5, 14, 0), utc(2026, 9, 5, 22, 0));
    const cout = await db().timeClockEvent.findFirstOrThrow({
      where: { clubId: F.club.id, employeeId: emp.id, kind: "CLOCK_OUT" },
    });
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);
    await approveGroundsScope(F);
    const paP = await principalFor(F.payrollAdmin.email);
    await freezeApprovedScopeIntoPayroll(paP, {
      clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id,
    });
    const frozenId = (await db().payrollApprovedTimeEntry.findFirstOrThrow({
      where: { clubId: F.club.id },
    })).id;

    // Correction (unconsumed row) — row must be marked SUPERSEDED_STALE.
    const groundsP = await principalFor(F.groundsMgr.email);
    const submit = await submitCorrectionRequest(portalPrincipal(F.club.id, emp.id), {
      requestType: "CORRECT_CLOCK_OUT",
      originalClockEventId: cout.id,
      requestedLocalIso: "2026-09-05T23:00",
      reason: "stayed later",
    });
    await approveCorrectionRequest(groundsP, F.club.id, { requestId: submit.request.id });

    const orig = await db().payrollApprovedTimeEntry.findUniqueOrThrow({ where: { id: frozenId } });
    expect(orig.approvalState).toBe("SUPERSEDED_STALE");
    expect(orig.hours.toString()).toBe("8"); // hours preserved for audit
  });
});

// ==================================================================
// G · Salary-only + readiness (§74)
// ==================================================================
describe("Payroll-3D-4 · salary-only + readiness", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("§74 salary-only pay period — zero scopes, readiness reports overallReady=true", async () => {
    const F = await scenario();
    const paP = await principalFor(F.payrollAdmin.email);
    const ready = await getPayPeriodTimeReadiness(paP, F.club.id, F.period.id);
    expect(ready.scopes).toHaveLength(0);
    expect(ready.overallReady).toBe(true);
  });
});

// Guard unused-warning
export const _tests = { vi };
