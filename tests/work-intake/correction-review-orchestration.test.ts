// Payroll-3D-3B Slice 2 (2026-09-06) — tests for the correction-review
// Work Intake orchestrator. Covers routing, config gaps, remediation,
// non-PENDING guard, idempotency, tenant isolation, and the
// post-commit orchestration seam wired into submitCorrectionRequest.
//
// Founder-required §TESTS 1-16:
//   1  PENDING Events correction → Events Manager WI immediately
//   2  Grounds receives none
//   3  sequential ensure → same item
//   4  concurrent ensure → same item
//   5  missing approver → Tenant Admin config gap
//   6  missing assignment → Tenant Admin config gap
//   7  gap reason/identity differs correctly
//   8  assign missing manager + rerun → manager item appears, gap resolves
//   9  repair missing assignment + rerun → manager item appears, gap resolves
//   10 correction already APPROVED → no active review item recreated
//   11 correction already REJECTED → no active review item recreated
//   12 orchestration failure → correction persists, BackgroundJob queued
//   13 retry job → WI created
//   14 repeated retry → no duplicate
//   15 wrong tenant cannot affect routing
//   16 (staging fixture protections retained by fixture-guard tests; no touch here)

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { db, resetDb, seedRbac, makeClub } from "../util/db";
import { CORRECTION_REVIEW_ORIGIN_INDEX_NAME } from "@/lib/work-intake/origin-conflict";
import {
  ensureCorrectionReviewWorkItems,
  CORRECTION_REVIEW_KIND,
  CORRECTION_REVIEW_GAP_KIND,
  missingApproverGapReferenceId,
  missingAssignmentGapReferenceId,
} from "@/lib/work-intake/correction-review-orchestration";
import { submitCorrectionRequest } from "@/lib/timesheets/correction-service";
import type { EmployeePortalPrincipal } from "@/lib/employee-portal-session";

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

// -------------------------------------------------------------------
// Scaffolding — build a small tenant with departments, a manager, an
// employee, and an assignment.
// -------------------------------------------------------------------
async function makeDept(clubId: string, code: string, name: string) {
  return db().department.create({
    data: { clubId, code, name, isActive: true },
  });
}

async function makeManager(clubId: string, email: string) {
  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.default.hash("password", 4);
  const user = await db().user.create({
    data: {
      email, name: email, role: "DEPARTMENT_MANAGER",
      passwordHash, clubId, status: "ACTIVE",
    },
  });
  await db().userClubRole.create({
    data: { userId: user.id, clubId, roleKey: "DEPARTMENT_MANAGER" },
  });
  return user;
}

async function makeTenantAdmin(clubId: string, email: string) {
  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.default.hash("password", 4);
  const user = await db().user.create({
    data: {
      email, name: email, role: "CLUB_ADMIN",
      passwordHash, clubId, status: "ACTIVE",
    },
  });
  await db().userClubRole.create({
    data: { userId: user.id, clubId, roleKey: "CLUB_ADMIN" },
  });
  await db().responsibilityAssignment.create({
    data: {
      clubId, userId: user.id,
      responsibilityKey: "TENANT_ADMINISTRATION",
      role: "PRIMARY", effectiveFrom: new Date(),
    },
  });
  return user;
}

async function assignDeptTimeApprover(clubId: string, departmentId: string, userId: string) {
  return db().departmentResponsibility.upsert({
    where: {
      clubId_departmentId_responsibilityKey: {
        clubId, departmentId, responsibilityKey: "DEPARTMENT_TIME_APPROVAL",
      },
    },
    update: { userId },
    create: {
      clubId, departmentId, userId,
      responsibilityKey: "DEPARTMENT_TIME_APPROVAL",
    },
  });
}

async function makeEmployee(clubId: string, seed: string) {
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

async function makeAssignment(clubId: string, employeeId: string, departmentId: string | null) {
  return db().employeeEmploymentAssignment.create({
    data: {
      clubId, employeeId, role: "PRIMARY", employmentType: "PART_TIME",
      effectiveFrom: utc(2026, 1, 1), departmentId,
    },
  });
}

async function submitPending(opts: {
  clubId: string; employeeId: string;
  assignmentId?: string | null;
  clockInAt?: Date;
}) {
  // Create a real CLOCK_IN + CLOCK_OUT so the correction has a valid
  // original event id — required for CORRECT_* types.
  const clockIn = opts.clockInAt ?? utc(2026, 9, 5, 14, 0);
  const evIn = await db().timeClockEvent.create({
    data: {
      clubId: opts.clubId, employeeId: opts.employeeId,
      kind: "CLOCK_IN", occurredAt: clockIn,
      source: "EMPLOYEE_PORTAL",
      employmentAssignmentId: opts.assignmentId ?? null,
    },
  });
  const principal: EmployeePortalPrincipal = {
    clubId: opts.clubId, employeeId: opts.employeeId,
    generation: 1, establishedAt: new Date().toISOString(),
  };
  const submitted = await submitCorrectionRequest(principal, {
    requestType: "CORRECT_CLOCK_IN",
    originalClockEventId: evIn.id,
    requestedLocalIso: "2026-09-05T14:15",
    reason: "Rounded to top of the hour by mistake.",
    employmentAssignmentId: opts.assignmentId ?? null,
  });
  return submitted.request;
}

// -------------------------------------------------------------------
// Suite
// -------------------------------------------------------------------
describe("Payroll-3D-3B Slice 2 · ensureCorrectionReviewWorkItems", () => {
  beforeAll(async () => {
    await db().$executeRawUnsafe(DDL);
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("§1 PENDING correction routes to the Events Manager immediately", async () => {
    const club = await makeClub("3D3B-slice2-01");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const eventsMgr = await makeManager(club.id, "events.mgr@t.test");
    await assignDeptTimeApprover(club.id, events.id, eventsMgr.id);
    const emp = await makeEmployee(club.id, "e01");
    const assn = await makeAssignment(club.id, emp.id, events.id);

    const request = await submitPending({ clubId: club.id, employeeId: emp.id, assignmentId: assn.id });

    // Manager card exists, owned by Events Manager, no visit to
    // Payroll Time required.
    const origin = await db().workIntakeOrigin.findFirst({
      where: { clubId: club.id, kind: CORRECTION_REVIEW_KIND, referenceId: request.id, role: "PRIMARY" },
      include: { workIntakeItem: true },
    });
    expect(origin).not.toBeNull();
    expect(origin!.workIntakeItem.ownerUserId).toBe(eventsMgr.id);
    expect(origin!.workIntakeItem.status).toBe("OPEN");
    expect(origin!.workIntakeItem.workDomain).toBe("PAYROLL");
    expect(origin!.workIntakeItem.workIntent).toBe("REVIEW");
    expect(origin!.workIntakeItem.workSubtype).toBe(CORRECTION_REVIEW_KIND);
  });

  it("§2 Grounds Manager sees nothing for an Events-worked correction", async () => {
    const club = await makeClub("3D3B-slice2-02");
    const grounds = await makeDept(club.id, "GROUNDS", "Course & Grounds");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const groundsMgr = await makeManager(club.id, "grounds.mgr@t.test");
    const eventsMgr = await makeManager(club.id, "events.mgr@t.test");
    await assignDeptTimeApprover(club.id, grounds.id, groundsMgr.id);
    await assignDeptTimeApprover(club.id, events.id, eventsMgr.id);
    const emp = await makeEmployee(club.id, "e02");
    // Employee's PRIMARY is Grounds, but they WORKED an Events shift.
    await makeAssignment(club.id, emp.id, grounds.id);
    const eventsAssn = await makeAssignment(club.id, emp.id, events.id);

    const request = await submitPending({ clubId: club.id, employeeId: emp.id, assignmentId: eventsAssn.id });

    // Exactly one manager card exists, owned by Events. Grounds owns none.
    const eventsOwned = await db().workIntakeItem.count({
      where: { clubId: club.id, ownerUserId: eventsMgr.id, workSubtype: CORRECTION_REVIEW_KIND },
    });
    const groundsOwned = await db().workIntakeItem.count({
      where: { clubId: club.id, ownerUserId: groundsMgr.id, workSubtype: CORRECTION_REVIEW_KIND },
    });
    expect(eventsOwned).toBe(1);
    expect(groundsOwned).toBe(0);
    // Sanity: refetch by refId also confirms.
    const origin = await db().workIntakeOrigin.findFirst({
      where: { clubId: club.id, kind: CORRECTION_REVIEW_KIND, referenceId: request.id },
    });
    expect(origin).not.toBeNull();
  });

  it("§3 sequential ensure returns the same canonical WI", async () => {
    const club = await makeClub("3D3B-slice2-03");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const eventsMgr = await makeManager(club.id, "events.mgr@t.test");
    await assignDeptTimeApprover(club.id, events.id, eventsMgr.id);
    const emp = await makeEmployee(club.id, "e03");
    const assn = await makeAssignment(club.id, emp.id, events.id);
    const request = await submitPending({ clubId: club.id, employeeId: emp.id, assignmentId: assn.id });

    const a = await ensureCorrectionReviewWorkItems({ clubId: club.id, correctionRequestId: request.id });
    const b = await ensureCorrectionReviewWorkItems({ clubId: club.id, correctionRequestId: request.id });
    expect(a.kind).toBe("review");
    expect(b.kind).toBe("review");
    if (a.kind === "review" && b.kind === "review") {
      expect(a.workIntakeItemId).toBe(b.workIntakeItemId);
    }
    const count = await db().workIntakeItem.count({
      where: { clubId: club.id, workSubtype: CORRECTION_REVIEW_KIND },
    });
    expect(count).toBe(1);
  });

  it("§4 concurrent ensure converges on one canonical WI", async () => {
    const club = await makeClub("3D3B-slice2-04");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const eventsMgr = await makeManager(club.id, "events.mgr@t.test");
    await assignDeptTimeApprover(club.id, events.id, eventsMgr.id);
    const emp = await makeEmployee(club.id, "e04");
    const assn = await makeAssignment(club.id, emp.id, events.id);
    const request = await submitPending({ clubId: club.id, employeeId: emp.id, assignmentId: assn.id });

    const [a, b, c] = await Promise.all([
      ensureCorrectionReviewWorkItems({ clubId: club.id, correctionRequestId: request.id }),
      ensureCorrectionReviewWorkItems({ clubId: club.id, correctionRequestId: request.id }),
      ensureCorrectionReviewWorkItems({ clubId: club.id, correctionRequestId: request.id }),
    ]);
    const ids = new Set(
      [a, b, c].map((r) => (r.kind === "review" ? r.workIntakeItemId : null))
    );
    ids.delete(null);
    expect(ids.size).toBe(1);
    expect(await db().workIntakeItem.count({
      where: { clubId: club.id, workSubtype: CORRECTION_REVIEW_KIND },
    })).toBe(1);
  });

  it("§5 missing approver — department known, no DEPARTMENT_TIME_APPROVAL owner → Tenant Admin gap", async () => {
    const club = await makeClub("3D3B-slice2-05");
    const events = await makeDept(club.id, "EVENTS", "Events");
    // NO assignDeptTimeApprover — this is the config gap.
    const admin = await makeTenantAdmin(club.id, "admin@t.test");
    const emp = await makeEmployee(club.id, "e05");
    const assn = await makeAssignment(club.id, emp.id, events.id);
    const request = await submitPending({ clubId: club.id, employeeId: emp.id, assignmentId: assn.id });

    const gap = await db().workIntakeOrigin.findFirst({
      where: {
        clubId: club.id,
        kind: CORRECTION_REVIEW_GAP_KIND,
        referenceId: missingApproverGapReferenceId(events.id, request.id),
      },
      include: { workIntakeItem: true },
    });
    expect(gap).not.toBeNull();
    expect(gap!.workIntakeItem.ownerUserId).toBe(admin.id);
    expect(gap!.workIntakeItem.workDomain).toBe("PAYROLL");
    expect(gap!.workIntakeItem.workIntent).toBe("REVIEW");
    // No manager card should exist.
    const managerCards = await db().workIntakeItem.count({
      where: { clubId: club.id, workSubtype: CORRECTION_REVIEW_KIND },
    });
    expect(managerCards).toBe(0);
  });

  it("§6 missing assignment — correction with no assignment/department → Tenant Admin gap", async () => {
    const club = await makeClub("3D3B-slice2-06");
    const admin = await makeTenantAdmin(club.id, "admin@t.test");
    const emp = await makeEmployee(club.id, "e06");
    // No assignment for this employee.
    const request = await submitPending({ clubId: club.id, employeeId: emp.id, assignmentId: null });

    const gap = await db().workIntakeOrigin.findFirst({
      where: {
        clubId: club.id,
        kind: CORRECTION_REVIEW_GAP_KIND,
        referenceId: missingAssignmentGapReferenceId(request.id),
      },
      include: { workIntakeItem: true },
    });
    expect(gap).not.toBeNull();
    expect(gap!.workIntakeItem.ownerUserId).toBe(admin.id);
    // No missing-approver gap and no manager card.
    const otherGap = await db().workIntakeOrigin.findFirst({
      where: {
        clubId: club.id, kind: CORRECTION_REVIEW_GAP_KIND,
        referenceId: { startsWith: "MISSING_APPROVER:" },
      },
    });
    expect(otherGap).toBeNull();
  });

  it("§7 gap identities distinguish MISSING_APPROVER vs MISSING_ASSIGNMENT", async () => {
    const club = await makeClub("3D3B-slice2-07");
    const events = await makeDept(club.id, "EVENTS", "Events");
    await makeTenantAdmin(club.id, "admin@t.test");
    const emp1 = await makeEmployee(club.id, "e07a");
    const emp2 = await makeEmployee(club.id, "e07b");
    const assn = await makeAssignment(club.id, emp1.id, events.id);
    const req1 = await submitPending({ clubId: club.id, employeeId: emp1.id, assignmentId: assn.id }); // approver missing
    const req2 = await submitPending({ clubId: club.id, employeeId: emp2.id, assignmentId: null });   // assignment missing

    const approverGap = await db().workIntakeOrigin.findFirst({
      where: { clubId: club.id, referenceId: missingApproverGapReferenceId(events.id, req1.id) },
    });
    const assignmentGap = await db().workIntakeOrigin.findFirst({
      where: { clubId: club.id, referenceId: missingAssignmentGapReferenceId(req2.id) },
    });
    expect(approverGap).not.toBeNull();
    expect(assignmentGap).not.toBeNull();
    // Two distinct gap cards.
    expect(approverGap!.workIntakeItemId).not.toBe(assignmentGap!.workIntakeItemId);
  });

  it("§8 assigning missing approver + rerun → manager card appears, gap RESOLVES", async () => {
    const club = await makeClub("3D3B-slice2-08");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const admin = await makeTenantAdmin(club.id, "admin@t.test");
    const emp = await makeEmployee(club.id, "e08");
    const assn = await makeAssignment(club.id, emp.id, events.id);
    const request = await submitPending({ clubId: club.id, employeeId: emp.id, assignmentId: assn.id });

    // Gap exists.
    const gapBefore = await db().workIntakeOrigin.findFirst({
      where: { clubId: club.id, referenceId: missingApproverGapReferenceId(events.id, request.id) },
      include: { workIntakeItem: true },
    });
    expect(gapBefore!.workIntakeItem.status).toBe("OPEN");

    // Remediate — Tenant Admin assigns the Events Timesheet Approver.
    const eventsMgr = await makeManager(club.id, "events.mgr@t.test");
    await assignDeptTimeApprover(club.id, events.id, eventsMgr.id);
    const outcome = await ensureCorrectionReviewWorkItems({ clubId: club.id, correctionRequestId: request.id });
    expect(outcome.kind).toBe("review");

    // Manager card exists AND the old gap is RESOLVED.
    const managerCard = await db().workIntakeItem.findFirst({
      where: { clubId: club.id, workSubtype: CORRECTION_REVIEW_KIND },
    });
    expect(managerCard!.ownerUserId).toBe(eventsMgr.id);
    expect(managerCard!.status).toBe("OPEN");
    const gapAfter = await db().workIntakeItem.findUnique({
      where: { id: gapBefore!.workIntakeItem.id },
    });
    expect(gapAfter!.status).toBe("RESOLVED");
    expect(gapAfter!.resolvedAt).not.toBeNull();
    // No duplicate active obligation.
    const activeCards = await db().workIntakeItem.count({
      where: { clubId: club.id, status: "OPEN", workDomain: "PAYROLL" },
    });
    expect(activeCards).toBe(1);
    // admin variable retained for closure — remediation still worked.
    expect(admin.id).toBeTruthy();
  });

  it("§9 repairing missing assignment + rerun → manager card appears, gap RESOLVES", async () => {
    const club = await makeClub("3D3B-slice2-09");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const eventsMgr = await makeManager(club.id, "events.mgr@t.test");
    await assignDeptTimeApprover(club.id, events.id, eventsMgr.id);
    await makeTenantAdmin(club.id, "admin@t.test");
    const emp = await makeEmployee(club.id, "e09");
    const request = await submitPending({ clubId: club.id, employeeId: emp.id, assignmentId: null });

    // Assignment-missing gap exists.
    const gapBefore = await db().workIntakeOrigin.findFirst({
      where: { clubId: club.id, referenceId: missingAssignmentGapReferenceId(request.id) },
      include: { workIntakeItem: true },
    });
    expect(gapBefore).not.toBeNull();

    // Repair — Tenant Admin retroactively assigns the correction to
    // the Events assignment (simulating an assignment repair in the
    // correction record itself).
    const assn = await makeAssignment(club.id, emp.id, events.id);
    await db().timeClockCorrectionRequest.update({
      where: { id: request.id },
      data: { employmentAssignmentId: assn.id },
    });
    const outcome = await ensureCorrectionReviewWorkItems({ clubId: club.id, correctionRequestId: request.id });
    expect(outcome.kind).toBe("review");
    const gapAfter = await db().workIntakeItem.findUnique({
      where: { id: gapBefore!.workIntakeItem.id },
    });
    expect(gapAfter!.status).toBe("RESOLVED");
  });

  it("§10 correction already APPROVED → no active review card recreated", async () => {
    const club = await makeClub("3D3B-slice2-10");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const eventsMgr = await makeManager(club.id, "events.mgr@t.test");
    await assignDeptTimeApprover(club.id, events.id, eventsMgr.id);
    const emp = await makeEmployee(club.id, "e10");
    const assn = await makeAssignment(club.id, emp.id, events.id);
    const request = await submitPending({ clubId: club.id, employeeId: emp.id, assignmentId: assn.id });

    // Simulate the correction having already been decided (Slice 5
    // will actually wire this via approveCorrectionRequest; for now
    // we mutate the status directly to exercise the guard).
    await db().timeClockCorrectionRequest.update({
      where: { id: request.id }, data: { status: "APPROVED" },
    });
    // Clear the WI that submit already created so we're testing the guard.
    await db().workIntakeOrigin.deleteMany({ where: { clubId: club.id } });
    await db().workIntakeItem.deleteMany({ where: { clubId: club.id } });

    const outcome = await ensureCorrectionReviewWorkItems({ clubId: club.id, correctionRequestId: request.id });
    expect(outcome.kind).toBe("no-op-status");
    if (outcome.kind === "no-op-status") expect(outcome.status).toBe("APPROVED");
    expect(await db().workIntakeItem.count({ where: { clubId: club.id } })).toBe(0);
  });

  it("§11 correction already REJECTED → no active review card recreated", async () => {
    const club = await makeClub("3D3B-slice2-11");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const eventsMgr = await makeManager(club.id, "events.mgr@t.test");
    await assignDeptTimeApprover(club.id, events.id, eventsMgr.id);
    const emp = await makeEmployee(club.id, "e11");
    const assn = await makeAssignment(club.id, emp.id, events.id);
    const request = await submitPending({ clubId: club.id, employeeId: emp.id, assignmentId: assn.id });

    await db().timeClockCorrectionRequest.update({
      where: { id: request.id }, data: { status: "REJECTED" },
    });
    await db().workIntakeOrigin.deleteMany({ where: { clubId: club.id } });
    await db().workIntakeItem.deleteMany({ where: { clubId: club.id } });

    const outcome = await ensureCorrectionReviewWorkItems({ clubId: club.id, correctionRequestId: request.id });
    expect(outcome.kind).toBe("no-op-status");
    if (outcome.kind === "no-op-status") expect(outcome.status).toBe("REJECTED");
  });

  it("§12 orchestration failure → correction persists, BackgroundJob queued", async () => {
    // Force ensureCorrectionReviewWorkItems to throw on the first
    // call; verify (a) the correction is still committed, (b) a
    // recovery BackgroundJob lands with the expected shape + key.
    const club = await makeClub("3D3B-slice2-12");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const eventsMgr = await makeManager(club.id, "events.mgr@t.test");
    await assignDeptTimeApprover(club.id, events.id, eventsMgr.id);
    const emp = await makeEmployee(club.id, "e12");
    const assn = await makeAssignment(club.id, emp.id, events.id);

    const orchestrationModule = await import("@/lib/work-intake/correction-review-orchestration");
    const spy = vi.spyOn(orchestrationModule, "ensureCorrectionReviewWorkItems")
      .mockRejectedValueOnce(new Error("simulated inline orchestrator failure"));

    try {
      const request = await submitPending({ clubId: club.id, employeeId: emp.id, assignmentId: assn.id });
      // Correction persisted.
      expect(request).toBeTruthy();
      // Recovery job queued with the expected key + payload.
      const job = await db().backgroundJob.findFirst({
        where: {
          clubId: club.id,
          kind: "ENSURE_TIMECLOCK_CORRECTION_REVIEW_WI",
          idempotencyKey: `ensure-tccr-wi:${club.id}:${request.id}`,
        },
      });
      expect(job).not.toBeNull();
      expect(job!.status).toBe("QUEUED");
      const payload = JSON.parse(job!.payloadJson);
      expect(payload).toEqual({ clubId: club.id, correctionRequestId: request.id });
    } finally {
      spy.mockRestore();
    }
  });

  it("§13 retry job creates the WI when handler runs (idempotent per correction)", async () => {
    // Simulate the recovery path: correction exists but no WI. Handler
    // (invoked via the orchestrator directly here — Slice 2 doesn't
    // exercise the runOne loop, but the handler shape is trivially
    // one call).
    const club = await makeClub("3D3B-slice2-13");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const eventsMgr = await makeManager(club.id, "events.mgr@t.test");
    await assignDeptTimeApprover(club.id, events.id, eventsMgr.id);
    const emp = await makeEmployee(club.id, "e13");
    const assn = await makeAssignment(club.id, emp.id, events.id);
    const request = await submitPending({ clubId: club.id, employeeId: emp.id, assignmentId: assn.id });
    // Wipe the WI to simulate the "inline failed" state.
    await db().workIntakeOrigin.deleteMany({ where: { clubId: club.id } });
    await db().workIntakeItem.deleteMany({ where: { clubId: club.id } });

    const outcome = await ensureCorrectionReviewWorkItems({ clubId: club.id, correctionRequestId: request.id });
    expect(outcome.kind).toBe("review");
    if (outcome.kind === "review") expect(outcome.created).toBe(true);
    const count = await db().workIntakeItem.count({
      where: { clubId: club.id, workSubtype: CORRECTION_REVIEW_KIND },
    });
    expect(count).toBe(1);
  });

  it("§14 repeated retry does not duplicate the WI", async () => {
    const club = await makeClub("3D3B-slice2-14");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const eventsMgr = await makeManager(club.id, "events.mgr@t.test");
    await assignDeptTimeApprover(club.id, events.id, eventsMgr.id);
    const emp = await makeEmployee(club.id, "e14");
    const assn = await makeAssignment(club.id, emp.id, events.id);
    const request = await submitPending({ clubId: club.id, employeeId: emp.id, assignmentId: assn.id });

    for (let i = 0; i < 5; i++) {
      await ensureCorrectionReviewWorkItems({ clubId: club.id, correctionRequestId: request.id });
    }
    const count = await db().workIntakeItem.count({
      where: { clubId: club.id, workSubtype: CORRECTION_REVIEW_KIND },
    });
    expect(count).toBe(1);
  });

  it("§15 wrong tenant cannot affect routing — ensure scoped by clubId", async () => {
    const clubA = await makeClub("3D3B-slice2-15-A");
    const clubB = await makeClub("3D3B-slice2-15-B");
    const eventsA = await makeDept(clubA.id, "EVENTS", "Events");
    const eventsMgrA = await makeManager(clubA.id, "events.mgrA@t.test");
    await assignDeptTimeApprover(clubA.id, eventsA.id, eventsMgrA.id);
    const empA = await makeEmployee(clubA.id, "e15A");
    const assnA = await makeAssignment(clubA.id, empA.id, eventsA.id);
    const requestA = await submitPending({ clubId: clubA.id, employeeId: empA.id, assignmentId: assnA.id });

    // Attempt to ensure correction A's WI under clubB — must no-op.
    const wrong = await ensureCorrectionReviewWorkItems({ clubId: clubB.id, correctionRequestId: requestA.id });
    expect(wrong.kind).toBe("no-op-status");
    // clubB has no WI items.
    expect(await db().workIntakeItem.count({ where: { clubId: clubB.id } })).toBe(0);
    // clubA still has exactly one manager card.
    expect(await db().workIntakeItem.count({
      where: { clubId: clubA.id, workSubtype: CORRECTION_REVIEW_KIND },
    })).toBe(1);
  });
});
