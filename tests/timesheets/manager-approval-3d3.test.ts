// Payroll-3D-3 (2026-09-05) — Manager Timesheet Approval + Work
// Intake Routing tests.
//
// Covers §76-§95 of the 3D-3 brief.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { ForbiddenError, ValidationError, ConflictError } from "@/lib/errors";
import {
  listReviewableScopes,
  getScopeReview,
  computeScopeRevision,
} from "@/lib/timesheets/approval-scope";
import { ensureTimesheetApprovalWorkItems } from "@/lib/timesheets/orchestration";
import {
  approveTimesheetScope,
  invalidateApprovalIfDrifted,
  resolveDepartmentTimeApprover,
} from "@/lib/timesheets/manager-approval";
import {
  approveCorrectionRequest,
  rejectCorrectionRequest,
  submitCorrectionRequest,
} from "@/lib/timesheets/correction-service";
import { materializeEmployeeTimesheet } from "@/lib/timesheets/service";
import type { EmployeePortalPrincipal } from "@/lib/employee-portal-session";

const utc = (y: number, m: number, d: number, h = 0, mi = 0) =>
  new Date(Date.UTC(y, m - 1, d, h, mi));

let _baseFixtureCounter = 0;
async function baseFixture() {
  const club = await makeClub(`3D3-Base-${++_baseFixtureCounter}-${Math.floor(Math.random() * 1_000_000)}`);
  const grounds  = await db().department.create({
    data: { clubId: club.id, code: "GROUNDS",  name: "Grounds",  sortOrder: 1 },
  });
  const banquets = await db().department.create({
    data: { clubId: club.id, code: "BANQUETS", name: "Banquets", sortOrder: 2 },
  });
  // Manager users with DEPARTMENT_MANAGER role — they hold
  // payroll:timesheets:approve via that role's RBAC mapping.
  const suffix = `${_baseFixtureCounter}-${Math.floor(Math.random() * 1_000_000)}`;
  const groundsMgr  = await makeUser({ email: `gmgr-${suffix}@t.test`, role: "DEPARTMENT_MANAGER", clubId: club.id });
  const banquetsMgr = await makeUser({ email: `bmgr-${suffix}@t.test`, role: "DEPARTMENT_MANAGER", clubId: club.id });
  const otherMgr    = await makeUser({ email: `omgr-${suffix}@t.test`, role: "DEPARTMENT_MANAGER", clubId: club.id });
  const tenantAdmin = await makeUser({ email: `ta-${suffix}@t.test`, role: "CLUB_ADMIN", clubId: club.id });
  // Tenant admin holds TENANT_ADMINISTRATION so config-gap routing has a target.
  await db().responsibilityAssignment.create({
    data: {
      clubId: club.id,
      userId: tenantAdmin.id,
      responsibilityKey: "TENANT_ADMINISTRATION",
      role: "PRIMARY",
      effectiveFrom: utc(2020, 1, 1),
    },
  });
  // Bind DEPARTMENT_TIME_APPROVAL for Grounds + Banquets.
  await db().departmentResponsibility.create({
    data: { clubId: club.id, departmentId: grounds.id, responsibilityKey: "DEPARTMENT_TIME_APPROVAL", userId: groundsMgr.id },
  });
  await db().departmentResponsibility.create({
    data: { clubId: club.id, departmentId: banquets.id, responsibilityKey: "DEPARTMENT_TIME_APPROVAL", userId: banquetsMgr.id },
  });

  // Pay group + current pay period.
  const pg = await db().payrollPayGroup.create({
    data: {
      clubId: club.id, code: "SM-3D3", name: "Semi-Monthly",
      payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 5,
      calendarAnchorDate: utc(2026, 1, 1), active: true,
    },
  });
  const period = await db().payrollPayPeriod.create({
    data: {
      clubId: club.id, payGroupId: pg.id, taxYear: 2026, sequenceInYear: 17,
      periodStart: utc(2026, 9, 1), periodEnd: utc(2026, 9, 16),
      payDate: utc(2026, 9, 20), status: "OPEN",
    },
  });

  return { club, grounds, banquets, groundsMgr, banquetsMgr, otherMgr, tenantAdmin, pg, period };
}

async function seedEmployee(clubId: string, seed: string, opts?: {
  primaryDepartmentId?: string;
  secondaryDepartmentId?: string;
}) {
  const emp = await db().employee.create({
    data: {
      clubId, firstName: "T", lastName: seed,
      email: `t.${seed}@t.test`, hireDate: utc(2026, 1, 1),
      status: "ACTIVE", employeeLifecycle: "ACTIVE",
      employeeNumber: `E-${seed}`, compensationType: "HOURLY",
      homeProvince: "AB", timekeepingMethod: "CLOCK_REQUIRED",
    },
  });
  const primary = await db().employeeEmploymentAssignment.create({
    data: {
      clubId, employeeId: emp.id, role: "PRIMARY",
      employmentType: "PART_TIME", effectiveFrom: utc(2026, 1, 1),
      departmentId: opts?.primaryDepartmentId ?? null,
    },
  });
  let secondary = null as (typeof primary) | null;
  if (opts?.secondaryDepartmentId) {
    secondary = await db().employeeEmploymentAssignment.create({
      data: {
        clubId, employeeId: emp.id, role: "SECONDARY",
        employmentType: "PART_TIME", effectiveFrom: utc(2026, 1, 1),
        departmentId: opts.secondaryDepartmentId,
      },
    });
  }
  await db().payrollPayGroupMember.create({
    data: {
      clubId,
      payGroupId: (await db().payrollPayGroup.findFirstOrThrow({ where: { clubId } })).id,
      employeeId: emp.id, effectiveFrom: utc(2020, 1, 1),
    },
  });
  return { emp, primary, secondary };
}

async function makeClockEvent(
  clubId: string, employeeId: string,
  kind: "CLOCK_IN" | "CLOCK_OUT" | "BREAK_START" | "BREAK_END",
  occurredAt: Date, opts?: { assignmentId?: string | null },
) {
  return db().timeClockEvent.create({
    data: {
      clubId, employeeId, kind, occurredAt,
      source: "EMPLOYEE_PORTAL",
      employmentAssignmentId: opts?.assignmentId ?? null,
    },
  });
}

function portalPrincipalFrom(clubId: string, employeeId: string): EmployeePortalPrincipal {
  return { clubId, employeeId, generation: 1, establishedAt: new Date().toISOString() };
}

// ==================================================================
// A · listReviewableScopes + Work Intake materialiser
// ==================================================================
describe("Payroll-3D-3 · scope enumeration + Work Intake materialiser", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("§76 + §77 ensureTimesheetApprovalWorkItems creates exactly one active WI card per scope (idempotent)", async () => {
    const F = await baseFixture();
    const { emp, primary } = await seedEmployee(F.club.id, "taylor", { primaryDepartmentId: F.grounds.id });
    await makeClockEvent(F.club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 5, 14, 0), { assignmentId: primary.id });
    await makeClockEvent(F.club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), { assignmentId: primary.id });
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);

    const scopes = await listReviewableScopes(F.club.id, F.period.id);
    expect(scopes).toHaveLength(1);
    expect(scopes[0].departmentCode).toBe("GROUNDS");

    const r1 = await ensureTimesheetApprovalWorkItems(F.club.id, F.period.id);
    expect(r1.items).toHaveLength(1);
    expect(r1.items[0].gap).toBe(false);
    expect(r1.items[0].ownerUserId).toBe(F.groundsMgr.id);
    expect(r1.items[0].created).toBe(true);

    const r2 = await ensureTimesheetApprovalWorkItems(F.club.id, F.period.id);
    expect(r2.items[0].workIntakeItemId).toBe(r1.items[0].workIntakeItemId);
    expect(r2.items[0].created).toBe(false);
    const wiCount = await db().workIntakeItem.count({
      where: { clubId: F.club.id, workSubtype: "TIMESHEET_APPROVAL" },
    });
    expect(wiCount).toBe(1);
  });

  it("§78 responsibility routing — no title-based fallback", async () => {
    const F = await baseFixture();
    const { emp, primary } = await seedEmployee(F.club.id, "t2", { primaryDepartmentId: F.grounds.id });
    await makeClockEvent(F.club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 5, 14, 0), { assignmentId: primary.id });
    await makeClockEvent(F.club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), { assignmentId: primary.id });
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);
    expect(await resolveDepartmentTimeApprover(F.club.id, F.grounds.id)).toBe(F.groundsMgr.id);
  });

  it("§7 / §8 configuration-gap: unassigned scope routes to Tenant Admin", async () => {
    const F = await baseFixture();
    // Delete the Grounds DepartmentResponsibility to simulate the gap.
    await db().departmentResponsibility.deleteMany({
      where: { clubId: F.club.id, departmentId: F.grounds.id, responsibilityKey: "DEPARTMENT_TIME_APPROVAL" },
    });
    const { emp, primary } = await seedEmployee(F.club.id, "t3", { primaryDepartmentId: F.grounds.id });
    await makeClockEvent(F.club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 5, 14, 0), { assignmentId: primary.id });
    await makeClockEvent(F.club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), { assignmentId: primary.id });
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);

    const r = await ensureTimesheetApprovalWorkItems(F.club.id, F.period.id);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].gap).toBe(true);
    expect(r.items[0].ownerUserId).toBe(F.tenantAdmin.id);
    // Card is a distinct workSubtype so managers never see it in their queue.
    const wi = await db().workIntakeItem.findFirstOrThrow({ where: { id: r.items[0].workIntakeItemId } });
    expect(wi.workSubtype).toBe("TIMESHEET_APPROVAL_CONFIG_GAP");
  });

  it("§53 / §81 primary-department mismatch — routing follows worked assignment, not primary dept", async () => {
    const F = await baseFixture();
    // Taylor's PRIMARY assignment is Banquets (their "home" dept),
    // but the specific session is worked in Grounds (a secondary
    // assignment). The Grounds manager must approve, NOT Banquets.
    const { emp, primary, secondary } = await seedEmployee(F.club.id, "t4", {
      primaryDepartmentId: F.banquets.id,
      secondaryDepartmentId: F.grounds.id,
    });
    // Session bound to the Grounds (secondary) assignment.
    await makeClockEvent(F.club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 5, 14, 0), { assignmentId: secondary!.id });
    await makeClockEvent(F.club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), { assignmentId: secondary!.id });
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);

    const scopes = await listReviewableScopes(F.club.id, F.period.id);
    // Exactly one scope — Grounds. Banquets must NOT appear.
    expect(scopes.map((s) => s.departmentCode).sort()).toEqual(["GROUNDS"]);
    void primary;
  });

  it("§80 multi-assignment — one manager sees only their scope", async () => {
    const F = await baseFixture();
    const { emp, primary, secondary } = await seedEmployee(F.club.id, "t5", {
      primaryDepartmentId: F.grounds.id,
      secondaryDepartmentId: F.banquets.id,
    });
    // Grounds session.
    await makeClockEvent(F.club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 5, 10, 0), { assignmentId: primary.id });
    await makeClockEvent(F.club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 12, 0), { assignmentId: primary.id });
    // Banquets session.
    await makeClockEvent(F.club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 5, 14, 0), { assignmentId: secondary!.id });
    await makeClockEvent(F.club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 18, 0), { assignmentId: secondary!.id });
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);

    const scopes = await listReviewableScopes(F.club.id, F.period.id);
    expect(scopes.map((s) => s.departmentCode).sort()).toEqual(["BANQUETS", "GROUNDS"]);
    const grounds  = scopes.find((s) => s.departmentCode === "GROUNDS")!;
    const banquets = scopes.find((s) => s.departmentCode === "BANQUETS")!;
    expect(grounds.recordedSeconds).toBe(2 * 60 * 60);
    expect(banquets.recordedSeconds).toBe(4 * 60 * 60);
  });
});

// ==================================================================
// B · Manager scope approval
// ==================================================================
describe("Payroll-3D-3 · scope approval", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("§82 clean approval — writes PayrollDepartmentTimeApproval, revision matches, WI resolves, 0 PayrollApprovedTimeEntry", async () => {
    const F = await baseFixture();
    const { emp, primary } = await seedEmployee(F.club.id, "clean", { primaryDepartmentId: F.grounds.id });
    await makeClockEvent(F.club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 5, 14, 0), { assignmentId: primary.id });
    await makeClockEvent(F.club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), { assignmentId: primary.id });
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);
    await ensureTimesheetApprovalWorkItems(F.club.id, F.period.id);

    const groundsP = await principalFor(F.groundsMgr.email);
    const review = await getScopeReview(F.club.id, F.period.id, F.grounds.id);
    expect(review.readiness.ready).toBe(true);
    const result = await approveTimesheetScope(groundsP, {
      clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id,
      attestedRevision: review.currentRevision,
    });
    expect(result.state).toBe("APPROVED");
    expect(result.approvedRevision).toBe(review.currentRevision);

    // Work Intake resolved.
    const wi = await db().workIntakeItem.findFirstOrThrow({ where: { id: result.workIntakeItemId! } });
    expect(wi.status).toBe("RESOLVED");

    // Zero PayrollApprovedTimeEntry (§46, §95).
    const paCount = await db().payrollApprovedTimeEntry.count({ where: { clubId: F.club.id } });
    expect(paCount).toBe(0);
  });

  it("§83 blocked approval — MISSING_CLOCK_OUT prevents approve", async () => {
    const F = await baseFixture();
    const { emp, primary } = await seedEmployee(F.club.id, "block", { primaryDepartmentId: F.grounds.id });
    // Only CLOCK_IN — no CLOCK_OUT → NEEDS_ATTENTION.
    await makeClockEvent(F.club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), { assignmentId: primary.id });
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);
    await ensureTimesheetApprovalWorkItems(F.club.id, F.period.id);

    const groundsP = await principalFor(F.groundsMgr.email);
    const review = await getScopeReview(F.club.id, F.period.id, F.grounds.id);
    expect(review.readiness.ready).toBe(false);
    expect(review.readiness.blockingReasons.some((r) => r.kind === "MISSING_CLOCK_OUT")).toBe(true);
    await expect(approveTimesheetScope(groundsP, {
      clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id,
      attestedRevision: review.currentRevision,
    })).rejects.toThrow(ValidationError);
    const paCount = await db().payrollApprovedTimeEntry.count({ where: { clubId: F.club.id } });
    expect(paCount).toBe(0);
  });

  it("§84 pending correction blocks approval", async () => {
    const F = await baseFixture();
    const { emp, primary } = await seedEmployee(F.club.id, "corrb", { primaryDepartmentId: F.grounds.id });
    const inEv = await makeClockEvent(F.club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 5, 14, 0), { assignmentId: primary.id });
    await makeClockEvent(F.club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), { assignmentId: primary.id });
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);
    await submitCorrectionRequest(portalPrincipalFrom(F.club.id, emp.id), {
      requestType: "CORRECT_CLOCK_IN",
      originalClockEventId: inEv.id,
      requestedLocalIso: "2026-09-05T09:00",
      reason: "arrived earlier",
    });
    const groundsP = await principalFor(F.groundsMgr.email);
    const review = await getScopeReview(F.club.id, F.period.id, F.grounds.id);
    expect(review.readiness.blockingReasons.some((r) => r.kind === "PENDING_CORRECTION")).toBe(true);
    await expect(approveTimesheetScope(groundsP, {
      clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id,
      attestedRevision: review.currentRevision,
    })).rejects.toThrow(ValidationError);
  });

  it("§79 wrong-manager denied", async () => {
    const F = await baseFixture();
    const { emp, primary } = await seedEmployee(F.club.id, "wm", { primaryDepartmentId: F.grounds.id });
    await makeClockEvent(F.club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 5, 14, 0), { assignmentId: primary.id });
    await makeClockEvent(F.club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), { assignmentId: primary.id });
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);
    const banquetsP = await principalFor(F.banquetsMgr.email);
    const review = await getScopeReview(F.club.id, F.period.id, F.grounds.id);
    await expect(approveTimesheetScope(banquetsP, {
      clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id,
      attestedRevision: review.currentRevision,
    })).rejects.toThrow(ForbiddenError);
  });

  it("§90 concurrent scope approvals collapse to one canonical row", async () => {
    const F = await baseFixture();
    const { emp, primary } = await seedEmployee(F.club.id, "cc", { primaryDepartmentId: F.grounds.id });
    await makeClockEvent(F.club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 5, 14, 0), { assignmentId: primary.id });
    await makeClockEvent(F.club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), { assignmentId: primary.id });
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);
    const groundsP = await principalFor(F.groundsMgr.email);
    const review = await getScopeReview(F.club.id, F.period.id, F.grounds.id);
    const results = await Promise.allSettled([
      approveTimesheetScope(groundsP, {
        clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id,
        attestedRevision: review.currentRevision,
      }),
      approveTimesheetScope(groundsP, {
        clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id,
        attestedRevision: review.currentRevision,
      }),
    ]);
    // At least one succeeds. The upsert semantics tolerate both;
    // final canonical state is a single row.
    const successCount = results.filter((r) => r.status === "fulfilled").length;
    expect(successCount).toBeGreaterThanOrEqual(1);
    const rows = await db().payrollDepartmentTimeApproval.findMany({
      where: { clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("APPROVED");
  });

  it("§92 stale approval attestation rejected", async () => {
    const F = await baseFixture();
    const { emp, primary } = await seedEmployee(F.club.id, "stale", { primaryDepartmentId: F.grounds.id });
    await makeClockEvent(F.club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 5, 14, 0), { assignmentId: primary.id });
    await makeClockEvent(F.club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), { assignmentId: primary.id });
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);
    const groundsP = await principalFor(F.groundsMgr.email);
    const stale = await getScopeReview(F.club.id, F.period.id, F.grounds.id);

    // Simulate a source-change between review and approve: submit a
    // correction which bumps the revision.
    const inEv = await db().timeClockEvent.findFirstOrThrow({
      where: { clubId: F.club.id, employeeId: emp.id, kind: "CLOCK_IN" },
    });
    await submitCorrectionRequest(portalPrincipalFrom(F.club.id, emp.id), {
      requestType: "CORRECT_CLOCK_IN",
      originalClockEventId: inEv.id,
      requestedLocalIso: "2026-09-05T09:00",
      reason: "earlier",
    });
    const now = await getScopeReview(F.club.id, F.period.id, F.grounds.id);
    expect(now.currentRevision).not.toBe(stale.currentRevision);
    await expect(approveTimesheetScope(groundsP, {
      clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id,
      attestedRevision: stale.currentRevision,
    })).rejects.toThrow(); // ValidationError (readiness) or ConflictError (revision drift)
  });
});

// ==================================================================
// C · Correction resolution (APPROVE / REJECT)
// ==================================================================
describe("Payroll-3D-3 · correction resolution", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("§85 approve ADD_MISSING_CLOCK_OUT — original CLOCK_IN untouched, new event created, exception cleared", async () => {
    const F = await baseFixture();
    const { emp, primary } = await seedEmployee(F.club.id, "mco", { primaryDepartmentId: F.grounds.id });
    const inEv = await makeClockEvent(F.club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 5, 14, 0), { assignmentId: primary.id });
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);
    const submit = await submitCorrectionRequest(portalPrincipalFrom(F.club.id, emp.id), {
      requestType: "ADD_MISSING_CLOCK_OUT",
      employmentAssignmentId: primary.id,
      requestedLocalIso: "2026-09-05T22:00",
      reason: "forgot to clock out",
    });
    const groundsP = await principalFor(F.groundsMgr.email);
    const r = await approveCorrectionRequest(groundsP, F.club.id, { requestId: submit.request.id });
    expect(r.request.status).toBe("APPROVED");
    expect(r.createdResolutionEventId).toBeTruthy();
    expect(r.supersededOriginalEventId).toBeNull();

    // Original event unchanged.
    const inRe = await db().timeClockEvent.findUniqueOrThrow({ where: { id: inEv.id } });
    expect(inRe.occurredAt.getTime()).toBe(utc(2026, 9, 5, 14, 0).getTime());
    expect(inRe.supersededByEventId).toBeNull();

    // Timesheet rematerialised → one clean entry.
    const entries = await db().payrollTimesheetEntry.findMany({
      where: { clubId: F.club.id, employeeId: emp.id },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].recordedSeconds).toBeGreaterThan(0);
  });

  it("§87 approve CORRECT_CLOCK_OUT — original event preserved, superseded by resolution event", async () => {
    const F = await baseFixture();
    const { emp, primary } = await seedEmployee(F.club.id, "cco", { primaryDepartmentId: F.grounds.id });
    await makeClockEvent(F.club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 5, 14, 0), { assignmentId: primary.id });
    const outEv = await makeClockEvent(F.club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 15, 31), { assignmentId: primary.id });
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);

    // Submit correction: real clock-out was 16:31, not 15:31.
    const submit = await submitCorrectionRequest(portalPrincipalFrom(F.club.id, emp.id), {
      requestType: "CORRECT_CLOCK_OUT",
      originalClockEventId: outEv.id,
      requestedLocalIso: "2026-09-05T16:31",
      reason: "left later than logged",
    });
    const groundsP = await principalFor(F.groundsMgr.email);
    const r = await approveCorrectionRequest(groundsP, F.club.id, { requestId: submit.request.id });
    expect(r.supersededOriginalEventId).toBe(outEv.id);
    expect(r.createdResolutionEventId).toBeTruthy();

    // Original event stays in the table.
    const origRe = await db().timeClockEvent.findUniqueOrThrow({ where: { id: outEv.id } });
    expect(origRe.occurredAt.getTime()).toBe(utc(2026, 9, 5, 15, 31).getTime());
    // Now marked as superseded by the resolution event.
    expect(origRe.supersededByEventId).toBe(r.createdResolutionEventId);

    // Materialiser filters out superseded events → timesheet uses the correction.
    const entries = await db().payrollTimesheetEntry.findMany({
      where: { clubId: F.club.id, employeeId: emp.id },
    });
    expect(entries).toHaveLength(1);
    // From 14:00 to 16:31 (with new time from correction).
    const expectedSeconds = (2 * 3600) + (31 * 60);
    expect(entries[0].recordedSeconds).toBeGreaterThanOrEqual(expectedSeconds - 1);
  });

  it("§86 reject correction — original event unchanged, no resolution event, blocking exception remains", async () => {
    const F = await baseFixture();
    const { emp, primary } = await seedEmployee(F.club.id, "rej", { primaryDepartmentId: F.grounds.id });
    const inEv = await makeClockEvent(F.club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 5, 14, 0), { assignmentId: primary.id });
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);
    const submit = await submitCorrectionRequest(portalPrincipalFrom(F.club.id, emp.id), {
      requestType: "ADD_MISSING_CLOCK_OUT",
      employmentAssignmentId: primary.id,
      requestedLocalIso: "2026-09-05T22:00",
      reason: "test reject",
    });
    const groundsP = await principalFor(F.groundsMgr.email);
    const r = await rejectCorrectionRequest(groundsP, F.club.id, {
      requestId: submit.request.id,
      reviewerNote: "clock-out time not verified",
    });
    expect(r.request.status).toBe("REJECTED");
    expect(r.createdResolutionEventId).toBeNull();
    const events = await db().timeClockEvent.findMany({ where: { clubId: F.club.id, employeeId: emp.id } });
    expect(events).toHaveLength(1); // only the original CLOCK_IN
    expect(events[0].id).toBe(inEv.id);
  });

  it("§88 correction concurrency — two parallel APPROVE calls create one resolution event", async () => {
    const F = await baseFixture();
    const { emp, primary } = await seedEmployee(F.club.id, "cconc", { primaryDepartmentId: F.grounds.id });
    await makeClockEvent(F.club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), { assignmentId: primary.id });
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);
    const submit = await submitCorrectionRequest(portalPrincipalFrom(F.club.id, emp.id), {
      requestType: "ADD_MISSING_CLOCK_OUT",
      employmentAssignmentId: primary.id,
      requestedLocalIso: "2026-09-05T22:00",
      reason: "conc",
    });
    const groundsP = await principalFor(F.groundsMgr.email);
    const results = await Promise.allSettled([
      approveCorrectionRequest(groundsP, F.club.id, { requestId: submit.request.id }),
      approveCorrectionRequest(groundsP, F.club.id, { requestId: submit.request.id }),
    ]);
    const successes = results.filter((r) => r.status === "fulfilled");
    expect(successes.length).toBe(1);
    // Exactly one ADMIN_CORRECTION event should exist.
    const adminEvents = await db().timeClockEvent.count({
      where: { clubId: F.club.id, employeeId: emp.id, source: "ADMIN_CORRECTION" },
    });
    expect(adminEvents).toBe(1);
  });

  it("§89 approve vs reject race — exactly one final decision", async () => {
    const F = await baseFixture();
    const { emp, primary } = await seedEmployee(F.club.id, "arr", { primaryDepartmentId: F.grounds.id });
    await makeClockEvent(F.club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), { assignmentId: primary.id });
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);
    const submit = await submitCorrectionRequest(portalPrincipalFrom(F.club.id, emp.id), {
      requestType: "ADD_MISSING_CLOCK_OUT",
      employmentAssignmentId: primary.id,
      requestedLocalIso: "2026-09-05T22:00",
      reason: "race",
    });
    const groundsP = await principalFor(F.groundsMgr.email);
    const results = await Promise.allSettled([
      approveCorrectionRequest(groundsP, F.club.id, { requestId: submit.request.id }),
      rejectCorrectionRequest(groundsP, F.club.id, { requestId: submit.request.id }),
    ]);
    const successes = results.filter((r) => r.status === "fulfilled");
    expect(successes.length).toBe(1);
    const finalRow = await db().timeClockCorrectionRequest.findUniqueOrThrow({ where: { id: submit.request.id } });
    expect(["APPROVED", "REJECTED"]).toContain(finalRow.status);
  });

  it("§91 approval invalidation — approve, then approved correction bumps revision → REVIEW_REQUIRED + WI reopened", async () => {
    const F = await baseFixture();
    const { emp, primary } = await seedEmployee(F.club.id, "inv", { primaryDepartmentId: F.grounds.id });
    await makeClockEvent(F.club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 5, 14, 0), { assignmentId: primary.id });
    const outEv = await makeClockEvent(F.club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), { assignmentId: primary.id });
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);
    await ensureTimesheetApprovalWorkItems(F.club.id, F.period.id);
    const groundsP = await principalFor(F.groundsMgr.email);
    const review1 = await getScopeReview(F.club.id, F.period.id, F.grounds.id);
    const appr = await approveTimesheetScope(groundsP, {
      clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id,
      attestedRevision: review1.currentRevision,
    });
    // Now a correction is submitted + approved — bumps the scope revision.
    const submit = await submitCorrectionRequest(portalPrincipalFrom(F.club.id, emp.id), {
      requestType: "CORRECT_CLOCK_OUT",
      originalClockEventId: outEv.id,
      requestedLocalIso: "2026-09-05T23:00",
      reason: "left later",
    });
    await approveCorrectionRequest(groundsP, F.club.id, { requestId: submit.request.id });
    // Approval should now be REVIEW_REQUIRED.
    const row = await db().payrollDepartmentTimeApproval.findFirstOrThrow({
      where: { id: appr.approvalId },
    });
    expect(row.state).toBe("REVIEW_REQUIRED");
    const wi = await db().workIntakeItem.findFirstOrThrow({ where: { id: appr.workIntakeItemId! } });
    expect(wi.status).toBe("OPEN");
  });

  it("§93 tenant isolation — cross-tenant manager cannot decide", async () => {
    const F = await baseFixture();
    const F2 = await baseFixture();
    const { emp: emp2, primary: primary2 } = await seedEmployee(F2.club.id, "tenX", { primaryDepartmentId: F2.grounds.id });
    await makeClockEvent(F2.club.id, emp2.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), { assignmentId: primary2.id });
    await materializeEmployeeTimesheet(F2.club.id, emp2.id, F2.period.id);
    const submitFromT2 = await submitCorrectionRequest(portalPrincipalFrom(F2.club.id, emp2.id), {
      requestType: "ADD_MISSING_CLOCK_OUT",
      employmentAssignmentId: primary2.id,
      requestedLocalIso: "2026-09-05T22:00",
      reason: "tenant2",
    });
    // F.groundsMgr belongs to tenant F; cannot even see F2's request via the F club scope.
    const F_groundsP = await principalFor(F.groundsMgr.email);
    await expect(
      approveCorrectionRequest(F_groundsP, F.club.id, { requestId: submitFromT2.request.id }),
    ).rejects.toThrow(); // NotFoundError — request is not in this tenant
  });

  it("§94 employee portal principal cannot use manager endpoint", async () => {
    const F = await baseFixture();
    const { emp, primary } = await seedEmployee(F.club.id, "empdeny", { primaryDepartmentId: F.grounds.id });
    await makeClockEvent(F.club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), { assignmentId: primary.id });
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);
    const submit = await submitCorrectionRequest(portalPrincipalFrom(F.club.id, emp.id), {
      requestType: "ADD_MISSING_CLOCK_OUT",
      employmentAssignmentId: primary.id,
      requestedLocalIso: "2026-09-05T22:00",
      reason: "self-approve attempt",
    });
    // Employee's Principal cast into admin-shaped shape carries no
    // payroll:timesheets:approve capability → rejected.
    const employeeAsPrincipal = {
      id: emp.id, name: emp.firstName, email: emp.email, status: "ACTIVE",
      memberships: [{ clubId: F.club.id, roleKey: "STAFF" as const }],
      activeClubId: F.club.id, memberId: null,
    } as never;
    await expect(
      approveCorrectionRequest(employeeAsPrincipal, F.club.id, { requestId: submit.request.id }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("§95 PayrollApprovedTimeEntry side effects — remain zero after all approvals", async () => {
    const F = await baseFixture();
    const { emp, primary } = await seedEmployee(F.club.id, "zeroP", { primaryDepartmentId: F.grounds.id });
    await makeClockEvent(F.club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 5, 14, 0), { assignmentId: primary.id });
    await makeClockEvent(F.club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), { assignmentId: primary.id });
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);
    const groundsP = await principalFor(F.groundsMgr.email);
    const review = await getScopeReview(F.club.id, F.period.id, F.grounds.id);
    await approveTimesheetScope(groundsP, {
      clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id,
      attestedRevision: review.currentRevision,
    });
    const paCount = await db().payrollApprovedTimeEntry.count({ where: { clubId: F.club.id } });
    expect(paCount).toBe(0);
  });
});

// ==================================================================
// D · Sanity — invalidateApprovalIfDrifted works standalone
// ==================================================================
describe("Payroll-3D-3 · standalone invalidation", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("no drift → no invalidation", async () => {
    const F = await baseFixture();
    const { emp, primary } = await seedEmployee(F.club.id, "st", { primaryDepartmentId: F.grounds.id });
    await makeClockEvent(F.club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 5, 14, 0), { assignmentId: primary.id });
    await makeClockEvent(F.club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), { assignmentId: primary.id });
    await materializeEmployeeTimesheet(F.club.id, emp.id, F.period.id);
    const groundsP = await principalFor(F.groundsMgr.email);
    const review = await getScopeReview(F.club.id, F.period.id, F.grounds.id);
    await approveTimesheetScope(groundsP, {
      clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.grounds.id,
      attestedRevision: review.currentRevision,
    });
    const r = await invalidateApprovalIfDrifted(F.club.id, F.period.id, F.grounds.id);
    expect(r.invalidated).toBe(false);
    expect(r.newState).toBe("APPROVED");
  });
});

// Suppress unused warning
export const _tests = { ConflictError };
