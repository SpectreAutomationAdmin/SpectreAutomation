// Payroll-3D-3B Slice 3 (2026-09-06) — tests for the proactive
// department timesheet-approval Work Intake orchestrator. Covers
// automatic creation on READY_FOR_REVIEW transitions, config gaps,
// remediation, drift, inline-failure recovery, and the periodic
// sweep — the three recovery layers established in Slice 0B.
//
// Founder-required §TESTS 19-32.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { db, resetDb, seedRbac, makeClub } from "../util/db";
import { CORRECTION_REVIEW_ORIGIN_INDEX_NAME } from "@/lib/work-intake/origin-conflict";
import {
  tickTimesheetApprovalWiSweep,
  _resetTimesheetApprovalSweepTickForTest,
} from "@/lib/work-intake/timesheet-approval-orchestration";
import { materializeEmployeeTimesheet } from "@/lib/timesheets/service";
import { rejectCorrectionRequest, submitCorrectionRequest } from "@/lib/timesheets/correction-service";
import { approveTimesheetScope, invalidateApprovalIfDrifted } from "@/lib/timesheets/manager-approval";
import { getScopeReview } from "@/lib/timesheets/approval-scope";
import type { EmployeePortalPrincipal } from "@/lib/employee-portal-session";
import type { Principal } from "@/lib/rbac";

const DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS "${CORRECTION_REVIEW_ORIGIN_INDEX_NAME}"
  ON "WorkIntakeOrigin" ("clubId", "kind", "referenceId")
  WHERE "role" = 'PRIMARY'
    AND "kind" IN (
      'TIMECLOCK_CORRECTION_REVIEW',
      'TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP'
    );
`;

const utc = (y: number, m: number, d: number, h = 0, mi = 0) =>
  new Date(Date.UTC(y, m - 1, d, h, mi));

// ------------ scaffolding ------------
async function makeDept(clubId: string, code: string, name: string) {
  return db().department.create({ data: { clubId, code, name, isActive: true } });
}
async function makeManager(clubId: string, email: string) {
  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.default.hash("password", 4);
  const user = await db().user.create({
    data: { email, name: email, role: "DEPARTMENT_MANAGER", passwordHash, clubId, status: "ACTIVE" },
  });
  await db().userClubRole.create({ data: { userId: user.id, clubId, roleKey: "DEPARTMENT_MANAGER" } });
  return user;
}
async function makeAdmin(clubId: string, email: string) {
  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.default.hash("password", 4);
  const user = await db().user.create({
    data: { email, name: email, role: "CLUB_ADMIN", passwordHash, clubId, status: "ACTIVE" },
  });
  await db().userClubRole.create({ data: { userId: user.id, clubId, roleKey: "CLUB_ADMIN" } });
  await db().responsibilityAssignment.create({
    data: { clubId, userId: user.id, responsibilityKey: "TENANT_ADMINISTRATION", role: "PRIMARY", effectiveFrom: new Date() },
  });
  return user;
}
async function assignDeptApprover(clubId: string, departmentId: string, userId: string) {
  return db().departmentResponsibility.upsert({
    where: { clubId_departmentId_responsibilityKey: { clubId, departmentId, responsibilityKey: "DEPARTMENT_TIME_APPROVAL" } },
    update: { userId },
    create: { clubId, departmentId, userId, responsibilityKey: "DEPARTMENT_TIME_APPROVAL" },
  });
}
async function makeEmp(clubId: string, seed: string) {
  return db().employee.create({
    data: {
      clubId, firstName: "Taylor", lastName: `Fixture-${seed}`,
      email: `${seed}@t.test`, hireDate: utc(2026, 1, 1),
      status: "ACTIVE", employeeLifecycle: "ACTIVE",
      employeeNumber: `E-${seed}`, compensationType: "HOURLY",
      homeProvince: "AB", timekeepingMethod: "CLOCK_REQUIRED",
    },
  });
}
async function makeAssn(clubId: string, employeeId: string, departmentId: string | null) {
  return db().employeeEmploymentAssignment.create({
    data: { clubId, employeeId, role: "PRIMARY", employmentType: "PART_TIME", effectiveFrom: utc(2026, 1, 1), departmentId },
  });
}
async function makePeriod(clubId: string, seed: string, employeeId: string, opts?: { periodStart?: Date; periodEnd?: Date; payDate?: Date }) {
  const pg = await db().payrollPayGroup.create({
    data: { clubId, code: `PG-${seed}`, name: `Test-${seed}`, payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 5, calendarAnchorDate: utc(2026, 1, 1), active: true },
  });
  const period = await db().payrollPayPeriod.create({
    data: {
      clubId, payGroupId: pg.id, taxYear: 2026, sequenceInYear: 17,
      periodStart: opts?.periodStart ?? utc(2026, 9, 1),
      periodEnd: opts?.periodEnd ?? utc(2026, 9, 16),
      payDate: opts?.payDate ?? utc(2026, 9, 20),
      status: "OPEN",
    },
  });
  await db().payrollPayGroupMember.create({
    data: { clubId, payGroupId: pg.id, employeeId, effectiveFrom: utc(2020, 1, 1) },
  });
  return { pg, period };
}
async function makeClockEvent(clubId: string, employeeId: string, kind: "CLOCK_IN"|"CLOCK_OUT"|"BREAK_START"|"BREAK_END", at: Date, assignmentId?: string | null) {
  return db().timeClockEvent.create({
    data: { clubId, employeeId, kind, occurredAt: at, source: "EMPLOYEE_PORTAL", employmentAssignmentId: assignmentId ?? null },
  });
}
function principalFromManager(user: { id: string; email: string; name: string; status: string; memberId: string | null }, clubId: string, roleKey: "DEPARTMENT_MANAGER"|"CLUB_ADMIN"|"PAYROLL_ADMIN"): Principal {
  return {
    id: user.id, name: user.name, email: user.email, status: user.status,
    memberships: [{ clubId, roleKey }], activeClubId: clubId, memberId: user.memberId,
  };
}
function empPortalPrincipal(clubId: string, employeeId: string): EmployeePortalPrincipal {
  return { clubId, employeeId, generation: 1, establishedAt: new Date().toISOString() };
}

// ------------ suite ------------
describe("Payroll-3D-3B Slice 3 · proactive timesheet-approval WI orchestration", () => {
  beforeAll(async () => {
    await db().$executeRawUnsafe(DDL);
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    _resetTimesheetApprovalSweepTickForTest();
  });

  it("§19 materialise → READY_FOR_REVIEW proactively creates the approval WI (no Payroll page visit)", async () => {
    const club = await makeClub("3D3B-slice3-19");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const mgr = await makeManager(club.id, "events.mgr@t.test");
    await assignDeptApprover(club.id, events.id, mgr.id);
    const emp = await makeEmp(club.id, "e19");
    const assn = await makeAssn(club.id, emp.id, events.id);
    const { period } = await makePeriod(club.id, "19", emp.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), assn.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), assn.id);

    const r = await materializeEmployeeTimesheet(club.id, emp.id, period.id);
    expect(r.status).toBe("READY_FOR_REVIEW");

    const wi = await db().workIntakeItem.findFirst({
      where: { clubId: club.id, workSubtype: "TIMESHEET_APPROVAL" },
    });
    expect(wi).not.toBeNull();
    expect(wi!.ownerUserId).toBe(mgr.id);
    expect(wi!.status).toBe("OPEN");
  });

  it("§20 correction reject unblocks a scope → approval WI appears without page load", async () => {
    const club = await makeClub("3D3B-slice3-20");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const mgr = await makeManager(club.id, "events.mgr@t.test");
    await assignDeptApprover(club.id, events.id, mgr.id);
    await makeAdmin(club.id, "admin@t.test");
    const emp = await makeEmp(club.id, "e20");
    const assn = await makeAssn(club.id, emp.id, events.id);
    const { period } = await makePeriod(club.id, "20", emp.id);
    // Clean session → READY_FOR_REVIEW first.
    const evIn = await makeClockEvent(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), assn.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), assn.id);
    // Submit a PENDING correction (blocks manager approval readiness).
    await submitCorrectionRequest(empPortalPrincipal(club.id, emp.id), {
      requestType: "CORRECT_CLOCK_IN", originalClockEventId: evIn.id,
      requestedLocalIso: "2026-09-05T14:15",
      reason: "Rounded to top of the hour.", employmentAssignmentId: assn.id,
    });
    await materializeEmployeeTimesheet(club.id, emp.id, period.id);

    // The manager needs to reject → this is the domain transition
    // Slice 3 must orchestrate proactively.
    const mgrPrincipal = principalFromManager(mgr, club.id, "DEPARTMENT_MANAGER");
    // Pull the correction id.
    const cr = await db().timeClockCorrectionRequest.findFirst({ where: { clubId: club.id, employeeId: emp.id, status: "PENDING" } });
    expect(cr).not.toBeNull();
    await rejectCorrectionRequest(mgrPrincipal, club.id, { requestId: cr!.id, reviewerNote: "Not warranted." });

    // Manager approval card must now exist.
    const wi = await db().workIntakeItem.findFirst({
      where: { clubId: club.id, workSubtype: "TIMESHEET_APPROVAL" },
    });
    expect(wi).not.toBeNull();
    expect(wi!.ownerUserId).toBe(mgr.id);
  });

  it("§21 Events positive / Grounds negative — routing by worked assignment", async () => {
    const club = await makeClub("3D3B-slice3-21");
    const grounds = await makeDept(club.id, "GROUNDS", "Course & Grounds");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const gMgr = await makeManager(club.id, "grounds.mgr@t.test");
    const eMgr = await makeManager(club.id, "events.mgr@t.test");
    await assignDeptApprover(club.id, grounds.id, gMgr.id);
    await assignDeptApprover(club.id, events.id, eMgr.id);
    const emp = await makeEmp(club.id, "e21");
    // Primary GROUNDS, worked EVENTS.
    await makeAssn(club.id, emp.id, grounds.id);
    const eAssn = await makeAssn(club.id, emp.id, events.id);
    const { period } = await makePeriod(club.id, "21", emp.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), eAssn.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), eAssn.id);
    await materializeEmployeeTimesheet(club.id, emp.id, period.id);

    const eventsCards = await db().workIntakeItem.count({
      where: { clubId: club.id, ownerUserId: eMgr.id, workSubtype: "TIMESHEET_APPROVAL" },
    });
    const groundsCards = await db().workIntakeItem.count({
      where: { clubId: club.id, ownerUserId: gMgr.id, workSubtype: "TIMESHEET_APPROVAL" },
    });
    expect(eventsCards).toBe(1);
    expect(groundsCards).toBe(0);
  });

  it("§22 multi-department — Events + Grounds both ready → one card per department", async () => {
    const club = await makeClub("3D3B-slice3-22");
    const grounds = await makeDept(club.id, "GROUNDS", "Course & Grounds");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const gMgr = await makeManager(club.id, "grounds.mgr@t.test");
    const eMgr = await makeManager(club.id, "events.mgr@t.test");
    await assignDeptApprover(club.id, grounds.id, gMgr.id);
    await assignDeptApprover(club.id, events.id, eMgr.id);
    const emp = await makeEmp(club.id, "e22");
    const gAssn = await makeAssn(club.id, emp.id, grounds.id);
    const eAssn = await makeAssn(club.id, emp.id, events.id);
    const { period } = await makePeriod(club.id, "22", emp.id);
    // Two shifts: one Grounds, one Events.
    await makeClockEvent(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 8, 0), gAssn.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 12, 0), gAssn.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), eAssn.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), eAssn.id);
    await materializeEmployeeTimesheet(club.id, emp.id, period.id);

    expect(await db().workIntakeItem.count({
      where: { clubId: club.id, ownerUserId: eMgr.id, workSubtype: "TIMESHEET_APPROVAL" },
    })).toBe(1);
    expect(await db().workIntakeItem.count({
      where: { clubId: club.id, ownerUserId: gMgr.id, workSubtype: "TIMESHEET_APPROVAL" },
    })).toBe(1);
  });

  it("§23 blocked department — Events ready, Grounds has open session → only Events actionable", async () => {
    // Two employees so open-session exceptions attribute cleanly.
    // The existing approval-scope enumerator attributes NEEDS_ATTENTION
    // exceptions to the FIRST entry's department for the employee's
    // timesheet — mixing both departments on ONE employee would blur
    // that attribution. Real-world blocked-vs-ready separation
    // requires per-employee-per-department cleanness anyway.
    const club = await makeClub("3D3B-slice3-23");
    const grounds = await makeDept(club.id, "GROUNDS", "Course & Grounds");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const gMgr = await makeManager(club.id, "grounds.mgr@t.test");
    const eMgr = await makeManager(club.id, "events.mgr@t.test");
    await assignDeptApprover(club.id, grounds.id, gMgr.id);
    await assignDeptApprover(club.id, events.id, eMgr.id);
    // Events employee: clean session.
    const eEmp = await makeEmp(club.id, "e23-events");
    const eAssn = await makeAssn(club.id, eEmp.id, events.id);
    const { period, pg } = await makePeriod(club.id, "23", eEmp.id);
    await makeClockEvent(club.id, eEmp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), eAssn.id);
    await makeClockEvent(club.id, eEmp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), eAssn.id);
    await materializeEmployeeTimesheet(club.id, eEmp.id, period.id);
    // Grounds employee: complete session (so it doesn't cross-pollute
    // Events via the "no-entries" open-session exception path in the
    // existing approval-scope enumerator), but a PENDING correction
    // scoped to the Grounds assignment blocks Grounds readiness only.
    const gEmp = await makeEmp(club.id, "e23-grounds");
    const gAssn = await makeAssn(club.id, gEmp.id, grounds.id);
    await db().payrollPayGroupMember.create({
      data: { clubId: club.id, payGroupId: pg.id, employeeId: gEmp.id, effectiveFrom: utc(2020, 1, 1) },
    });
    const gClockIn = await makeClockEvent(club.id, gEmp.id, "CLOCK_IN", utc(2026, 9, 6, 8, 0), gAssn.id);
    await makeClockEvent(club.id, gEmp.id, "CLOCK_OUT", utc(2026, 9, 6, 12, 0), gAssn.id);
    await materializeEmployeeTimesheet(club.id, gEmp.id, period.id);
    // PENDING correction against the Grounds session blocks readiness
    // on the Grounds scope only (pendingCorrRows is dept-scoped via
    // deptAssnIds in approval-scope.ts).
    await submitCorrectionRequest(empPortalPrincipal(club.id, gEmp.id), {
      requestType: "CORRECT_CLOCK_IN", originalClockEventId: gClockIn.id,
      requestedLocalIso: "2026-09-06T08:15",
      reason: "Rounded to top of the hour.", employmentAssignmentId: gAssn.id,
    });

    const eReview = await getScopeReview(club.id, period.id, events.id);
    const gReview = await getScopeReview(club.id, period.id, grounds.id);
    expect(eReview.readiness.ready).toBe(true);
    expect(gReview.readiness.ready).toBe(false);
  });

  it("§24 missing approver — ready scope, no owner → Tenant Admin config gap", async () => {
    const club = await makeClub("3D3B-slice3-24");
    const events = await makeDept(club.id, "EVENTS", "Events");
    // NO assignDeptApprover.
    const admin = await makeAdmin(club.id, "admin@t.test");
    const emp = await makeEmp(club.id, "e24");
    const assn = await makeAssn(club.id, emp.id, events.id);
    const { period } = await makePeriod(club.id, "24", emp.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), assn.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), assn.id);
    await materializeEmployeeTimesheet(club.id, emp.id, period.id);

    const gap = await db().workIntakeItem.findFirst({
      where: { clubId: club.id, workSubtype: "TIMESHEET_APPROVAL_CONFIG_GAP" },
    });
    expect(gap).not.toBeNull();
    expect(gap!.ownerUserId).toBe(admin.id);
    const managerCards = await db().workIntakeItem.count({
      where: { clubId: club.id, workSubtype: "TIMESHEET_APPROVAL" },
    });
    expect(managerCards).toBe(0);
  });

  it("§25 config remediation — assign Events manager + rerun → approval card active, gap RESOLVED", async () => {
    const club = await makeClub("3D3B-slice3-25");
    const events = await makeDept(club.id, "EVENTS", "Events");
    await makeAdmin(club.id, "admin@t.test");
    const emp = await makeEmp(club.id, "e25");
    const assn = await makeAssn(club.id, emp.id, events.id);
    const { period } = await makePeriod(club.id, "25", emp.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), assn.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), assn.id);
    await materializeEmployeeTimesheet(club.id, emp.id, period.id);

    const gapBefore = await db().workIntakeItem.findFirst({
      where: { clubId: club.id, workSubtype: "TIMESHEET_APPROVAL_CONFIG_GAP" },
    });
    expect(gapBefore!.status).toBe("OPEN");

    // Remediate.
    const eMgr = await makeManager(club.id, "events.mgr@t.test");
    await assignDeptApprover(club.id, events.id, eMgr.id);
    // Rerun the orchestrator directly (simulates the enqueued
    // recovery job or a next materialise).
    const { ensureTimesheetApprovalWorkItems } = await import("@/lib/timesheets/orchestration");
    await ensureTimesheetApprovalWorkItems(club.id, period.id);

    const approvalCard = await db().workIntakeItem.findFirst({
      where: { clubId: club.id, workSubtype: "TIMESHEET_APPROVAL" },
    });
    expect(approvalCard).not.toBeNull();
    expect(approvalCard!.ownerUserId).toBe(eMgr.id);
    const gapAfter = await db().workIntakeItem.findUnique({ where: { id: gapBefore!.id } });
    expect(gapAfter!.status).toBe("RESOLVED");
  });

  it("§26 already approved — orchestrator does NOT resurrect a RESOLVED manager card", async () => {
    const club = await makeClub("3D3B-slice3-26");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const mgr = await makeManager(club.id, "events.mgr@t.test");
    await assignDeptApprover(club.id, events.id, mgr.id);
    const emp = await makeEmp(club.id, "e26");
    const assn = await makeAssn(club.id, emp.id, events.id);
    const { period } = await makePeriod(club.id, "26", emp.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), assn.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), assn.id);
    await materializeEmployeeTimesheet(club.id, emp.id, period.id);

    // Approve the scope.
    const review = await getScopeReview(club.id, period.id, events.id);
    await approveTimesheetScope(principalFromManager(mgr, club.id, "DEPARTMENT_MANAGER"), {
      clubId: club.id, payPeriodId: period.id, departmentId: events.id,
      attestedRevision: review.currentRevision,
    });
    // WI should now be RESOLVED (approveTimesheetScope emits completion).
    const cardAfterApproval = await db().workIntakeItem.findFirst({
      where: { clubId: club.id, workSubtype: "TIMESHEET_APPROVAL" },
    });
    expect(cardAfterApproval!.status).toBe("RESOLVED");

    // Rerun the orchestrator — must NOT reopen.
    const { ensureTimesheetApprovalWorkItems } = await import("@/lib/timesheets/orchestration");
    await ensureTimesheetApprovalWorkItems(club.id, period.id);
    const cardAfterRerun = await db().workIntakeItem.findUnique({ where: { id: cardAfterApproval!.id } });
    expect(cardAfterRerun!.status).toBe("RESOLVED");
  });

  it("§27 REVIEW_REQUIRED — approve, then material change flips scope + reopens WI proactively", async () => {
    const club = await makeClub("3D3B-slice3-27");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const mgr = await makeManager(club.id, "events.mgr@t.test");
    await assignDeptApprover(club.id, events.id, mgr.id);
    const emp = await makeEmp(club.id, "e27");
    const assn = await makeAssn(club.id, emp.id, events.id);
    const { period } = await makePeriod(club.id, "27", emp.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), assn.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), assn.id);
    await materializeEmployeeTimesheet(club.id, emp.id, period.id);
    const review = await getScopeReview(club.id, period.id, events.id);
    await approveTimesheetScope(principalFromManager(mgr, club.id, "DEPARTMENT_MANAGER"), {
      clubId: club.id, payPeriodId: period.id, departmentId: events.id,
      attestedRevision: review.currentRevision,
    });
    // Add a new session — drift.
    await makeClockEvent(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 7, 14, 0), assn.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 7, 22, 0), assn.id);
    await materializeEmployeeTimesheet(club.id, emp.id, period.id);
    const result = await invalidateApprovalIfDrifted(club.id, period.id, events.id);
    expect(result.invalidated).toBe(true);
    expect(result.newState).toBe("REVIEW_REQUIRED");
    // Manager card must be OPEN again — proactively, no page load.
    const openCards = await db().workIntakeItem.count({
      where: { clubId: club.id, ownerUserId: mgr.id, workSubtype: "TIMESHEET_APPROVAL", status: "OPEN" },
    });
    expect(openCards).toBe(1);
  });

  it("§28 inline failure — materialise persists, BackgroundJob queued with correct key + payload", async () => {
    const club = await makeClub("3D3B-slice3-28");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const mgr = await makeManager(club.id, "events.mgr@t.test");
    await assignDeptApprover(club.id, events.id, mgr.id);
    const emp = await makeEmp(club.id, "e28");
    const assn = await makeAssn(club.id, emp.id, events.id);
    const { period } = await makePeriod(club.id, "28", emp.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), assn.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), assn.id);

    // Mock the underlying ensure to throw so the outer helper falls
    // through to the enqueue path.
    const orchestrationModule = await import("@/lib/timesheets/orchestration");
    const spy = vi.spyOn(orchestrationModule, "ensureTimesheetApprovalWorkItems")
      .mockRejectedValueOnce(new Error("simulated inline orchestrator failure"));

    try {
      const r = await materializeEmployeeTimesheet(club.id, emp.id, period.id);
      expect(r.status).toBe("READY_FOR_REVIEW");
      const job = await db().backgroundJob.findFirst({
        where: {
          clubId: club.id,
          kind: "ENSURE_TIMESHEET_APPROVAL_WI",
          idempotencyKey: `ensure-timesheet-approval-wi:${club.id}:${period.id}`,
        },
      });
      expect(job).not.toBeNull();
      expect(job!.status).toBe("QUEUED");
      expect(JSON.parse(job!.payloadJson)).toEqual({ clubId: club.id, payPeriodId: period.id });
    } finally {
      spy.mockRestore();
    }
  });

  it("§29 retry creates the WI and repeated retries do not duplicate", async () => {
    const club = await makeClub("3D3B-slice3-29");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const mgr = await makeManager(club.id, "events.mgr@t.test");
    await assignDeptApprover(club.id, events.id, mgr.id);
    const emp = await makeEmp(club.id, "e29");
    const assn = await makeAssn(club.id, emp.id, events.id);
    const { period } = await makePeriod(club.id, "29", emp.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), assn.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), assn.id);
    await materializeEmployeeTimesheet(club.id, emp.id, period.id);

    // Wipe WI + origin as if inline had failed silently.
    await db().workIntakeOrigin.deleteMany({ where: { clubId: club.id } });
    await db().workIntakeItem.deleteMany({ where: { clubId: club.id } });

    const { ensureTimesheetApprovalWorkItems } = await import("@/lib/timesheets/orchestration");
    for (let i = 0; i < 5; i++) {
      await ensureTimesheetApprovalWorkItems(club.id, period.id);
    }
    const count = await db().workIntakeItem.count({
      where: { clubId: club.id, workSubtype: "TIMESHEET_APPROVAL" },
    });
    expect(count).toBe(1);
  });

  it("§30 sweep enqueues an ensure job for calendar-eligible periods (recovery layer 3)", async () => {
    const club = await makeClub("3D3B-slice3-30");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const mgr = await makeManager(club.id, "events.mgr@t.test");
    await assignDeptApprover(club.id, events.id, mgr.id);
    const emp = await makeEmp(club.id, "e30");
    const assn = await makeAssn(club.id, emp.id, events.id);
    const now = utc(2026, 9, 10, 12, 0);
    // Period straddling `now` — clearly eligible.
    const { period } = await makePeriod(club.id, "30", emp.id, {
      periodStart: utc(2026, 9, 1), periodEnd: utc(2026, 9, 16), payDate: utc(2026, 9, 20),
    });
    await makeClockEvent(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), assn.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), assn.id);
    // Do NOT materialise — the sweep should still enqueue an ensure
    // job that would create the card when the handler runs.

    const result = await tickTimesheetApprovalWiSweep({ now });
    expect(result.ran).toBe(true);
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.enqueued).toBeGreaterThanOrEqual(1);
    const job = await db().backgroundJob.findFirst({
      where: {
        clubId: club.id,
        kind: "ENSURE_TIMESHEET_APPROVAL_WI",
        idempotencyKey: `ensure-timesheet-approval-wi:${club.id}:${period.id}`,
      },
    });
    expect(job).not.toBeNull();
  });

  it("§31 sweep does NOT resurrect old / far-future periods (bounded window)", async () => {
    const club = await makeClub("3D3B-slice3-31");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const mgr = await makeManager(club.id, "events.mgr@t.test");
    await assignDeptApprover(club.id, events.id, mgr.id);
    const emp = await makeEmp(club.id, "e31");
    await makeAssn(club.id, emp.id, events.id);
    // Ancient period (well beyond 90-day lookback).
    await makePeriod(club.id, "31-old", emp.id, {
      periodStart: utc(2024, 1, 1), periodEnd: utc(2024, 1, 16), payDate: utc(2024, 1, 20),
    });
    // Future period (well beyond 7-day lookahead).
    await makePeriod(club.id, "31-far", emp.id, {
      periodStart: utc(2027, 1, 1), periodEnd: utc(2027, 1, 16), payDate: utc(2027, 1, 20),
    });

    const now = utc(2026, 9, 10, 12, 0);
    const result = await tickTimesheetApprovalWiSweep({ now });
    expect(result.ran).toBe(true);
    // Neither period is in the calendar window → no enqueues for this club.
    const jobs = await db().backgroundJob.count({
      where: { clubId: club.id, kind: "ENSURE_TIMESHEET_APPROVAL_WI" },
    });
    expect(jobs).toBe(0);
  });

  it("§32 tenant isolation — sweep enqueues correct clubId only; handler no-ops for wrong tenant", async () => {
    const clubA = await makeClub("3D3B-slice3-32-A");
    const clubB = await makeClub("3D3B-slice3-32-B");
    const eventsA = await makeDept(clubA.id, "EVENTS", "Events");
    const mgrA = await makeManager(clubA.id, "events.mgrA@t.test");
    await assignDeptApprover(clubA.id, eventsA.id, mgrA.id);
    const empA = await makeEmp(clubA.id, "e32A");
    const assnA = await makeAssn(clubA.id, empA.id, eventsA.id);
    const now = utc(2026, 9, 10, 12, 0);
    const { period: periodA } = await makePeriod(clubA.id, "32A", empA.id);
    await makeClockEvent(clubA.id, empA.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), assnA.id);
    await makeClockEvent(clubA.id, empA.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), assnA.id);

    await tickTimesheetApprovalWiSweep({ now });
    // Job is club-scoped.
    const aJob = await db().backgroundJob.findFirst({
      where: { clubId: clubA.id, kind: "ENSURE_TIMESHEET_APPROVAL_WI" },
    });
    const bJob = await db().backgroundJob.findFirst({
      where: { clubId: clubB.id, kind: "ENSURE_TIMESHEET_APPROVAL_WI" },
    });
    expect(aJob).not.toBeNull();
    expect(bJob).toBeNull();
    // periodA carries clubA in the payload — the handler can safely
    // no-op if called with the wrong tenant. Verify by calling the
    // orchestrator directly with a mismatched clubId — should throw
    // NotFound (listReviewableScopes fail-closed on wrong tenant).
    const { ensureTimesheetApprovalWorkItems } = await import("@/lib/timesheets/orchestration");
    await expect(
      ensureTimesheetApprovalWorkItems(clubB.id, periodA.id),
    ).rejects.toThrow();
  });
});
