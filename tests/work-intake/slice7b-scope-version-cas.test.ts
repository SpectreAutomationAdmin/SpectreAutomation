// Payroll-3D-3B Slice 7B (2026-09-06) — shared scope-version CAS
// concurrency tests. Attacks the atomicity boundary between
// approveTimesheetScope and every material writer that changes
// computeScopeRevision inputs.
//
// Unlike Slice 7A's mocked-hash test, these tests use REAL database
// mutations and prove the CAS via actual version increments on
// PayrollDepartmentTimeScopeState. If any material writer bumps the
// version between the manager's attestation and the approve tx's
// CAS, the CAS returns count=0 → ConflictError → tx rollback →
// no APPROVED-at-obsolete-version persists.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub } from "../util/db";
import {
  approveTimesheetScope,
} from "@/lib/timesheets/manager-approval";
import {
  getScopeReview,
} from "@/lib/timesheets/approval-scope";
import {
  ensureScopeState,
  readScopeVersion,
  bumpScopeVersion,
} from "@/lib/timesheets/scope-state";
import { materializeEmployeeTimesheet } from "@/lib/timesheets/service";
import {
  submitCorrectionRequest,
  approveCorrectionRequest,
  rejectCorrectionRequest,
  cancelCorrectionRequest,
} from "@/lib/timesheets/correction-service";
import type { EmployeePortalPrincipal } from "@/lib/employee-portal-session";
import type { Principal } from "@/lib/rbac";

const utc = (y: number, m: number, d: number, h = 0, mi = 0) =>
  new Date(Date.UTC(y, m - 1, d, h, mi));

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
async function assignApprover(clubId: string, deptId: string, userId: string) {
  return db().departmentResponsibility.upsert({
    where: { clubId_departmentId_responsibilityKey: { clubId, departmentId: deptId, responsibilityKey: "DEPARTMENT_TIME_APPROVAL" } },
    update: { userId },
    create: { clubId, departmentId: deptId, userId, responsibilityKey: "DEPARTMENT_TIME_APPROVAL" },
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
async function makePeriod(clubId: string, seed: string, employeeId: string) {
  const pg = await db().payrollPayGroup.create({
    data: { clubId, code: `PG-${seed}`, name: `Test-${seed}`, payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 5, calendarAnchorDate: utc(2026, 1, 1), active: true },
  });
  const period = await db().payrollPayPeriod.create({
    data: {
      clubId, payGroupId: pg.id, taxYear: 2026, sequenceInYear: 17,
      periodStart: utc(2026, 9, 1), periodEnd: utc(2026, 9, 16),
      payDate: utc(2026, 9, 20), status: "OPEN",
    },
  });
  await db().payrollPayGroupMember.create({
    data: { clubId, payGroupId: pg.id, employeeId, effectiveFrom: utc(2020, 1, 1) },
  });
  return { pg, period };
}
async function makeClock(clubId: string, employeeId: string, kind: "CLOCK_IN"|"CLOCK_OUT", at: Date, assignmentId?: string | null) {
  return db().timeClockEvent.create({
    data: { clubId, employeeId, kind, occurredAt: at, source: "EMPLOYEE_PORTAL", employmentAssignmentId: assignmentId ?? null },
  });
}
function principal(u: { id: string; email: string; name: string; status: string; memberId: string | null }, clubId: string, roleKey: "DEPARTMENT_MANAGER"): Principal {
  return { id: u.id, name: u.name, email: u.email, status: u.status, memberships: [{ clubId, roleKey }], activeClubId: clubId, memberId: u.memberId };
}
function empPortal(clubId: string, employeeId: string): EmployeePortalPrincipal {
  return { clubId, employeeId, generation: 1, establishedAt: new Date().toISOString() };
}

async function setupReadyScope(seed: string) {
  const club = await makeClub(`slice7b-${seed}`);
  const events = await makeDept(club.id, "EVENTS", "Events");
  const mgr = await makeManager(club.id, `mgr.${seed}@t.test`);
  await assignApprover(club.id, events.id, mgr.id);
  const emp = await makeEmp(club.id, `e-${seed}`);
  const assn = await makeAssn(club.id, emp.id, events.id);
  const { period } = await makePeriod(club.id, seed, emp.id);
  await makeClock(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), assn.id);
  await makeClock(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), assn.id);
  await materializeEmployeeTimesheet(club.id, emp.id, period.id);
  return { club, events, mgr, emp, assn, period };
}

// ==================================================================
describe("Payroll-3D-3B Slice 7B · shared scope-version CAS", () => {
  beforeAll(async () => { /* schema already applied via db push */ });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  // ---------------- scope-state helpers ----------------
  it("§O ensureScopeState first-create is race-safe (10 concurrent → 1 row)", async () => {
    const club = await makeClub("slice7b-O");
    const dept = await makeDept(club.id, "EVENTS", "Events");
    const emp = await makeEmp(club.id, "e-O");
    const { period } = await makePeriod(club.id, "O", emp.id);
    await Promise.all(
      Array.from({ length: 10 }, () => ensureScopeState(club.id, period.id, dept.id)),
    );
    expect(await db().payrollDepartmentTimeScopeState.count({ where: { clubId: club.id } })).toBe(1);
  });

  it("readScopeVersion returns 0 for uncreated scope; ensureScopeState creates row at version 0", async () => {
    const club = await makeClub("slice7b-read");
    const dept = await makeDept(club.id, "EVENTS", "Events");
    const emp = await makeEmp(club.id, "e-read");
    const { period } = await makePeriod(club.id, "read", emp.id);
    expect(await readScopeVersion(club.id, period.id, dept.id)).toBe(0);
    const row = await ensureScopeState(club.id, period.id, dept.id);
    expect(row.version).toBe(0);
    expect(await readScopeVersion(club.id, period.id, dept.id)).toBe(0);
  });

  it("bumpScopeVersion increments atomically; 5 sequential bumps → version 5", async () => {
    const club = await makeClub("slice7b-bump");
    const dept = await makeDept(club.id, "EVENTS", "Events");
    const emp = await makeEmp(club.id, "e-bump");
    const { period } = await makePeriod(club.id, "bump", emp.id);
    for (let i = 0; i < 5; i++) {
      await bumpScopeVersion(club.id, period.id, dept.id);
    }
    expect(await readScopeVersion(club.id, period.id, dept.id)).toBe(5);
  });

  // ---------------- material writer bumps ----------------
  it("§V materializeEmployeeTimesheet bumps scope version for affected departments", async () => {
    const F = await setupReadyScope("V");
    const vAfterFirstMaterialise = await readScopeVersion(F.club.id, F.period.id, F.events.id);
    expect(vAfterFirstMaterialise).toBeGreaterThanOrEqual(1);
    // Additional clock events → materialise again → version increments.
    await makeClock(F.club.id, F.emp.id, "CLOCK_IN", utc(2026, 9, 7, 14, 0), F.assn.id);
    await makeClock(F.club.id, F.emp.id, "CLOCK_OUT", utc(2026, 9, 7, 22, 0), F.assn.id);
    await materializeEmployeeTimesheet(F.club.id, F.emp.id, F.period.id);
    const vAfterSecond = await readScopeVersion(F.club.id, F.period.id, F.events.id);
    expect(vAfterSecond).toBeGreaterThan(vAfterFirstMaterialise);
  });

  it("§W no-op materialize (no events added, no status change) does not bump version", async () => {
    const F = await setupReadyScope("W");
    const v1 = await readScopeVersion(F.club.id, F.period.id, F.events.id);
    // Second materialise with no new events → no-op.
    await materializeEmployeeTimesheet(F.club.id, F.emp.id, F.period.id);
    const v2 = await readScopeVersion(F.club.id, F.period.id, F.events.id);
    expect(v2).toBe(v1);
  });

  it("§S correction submit bumps scope version", async () => {
    const F = await setupReadyScope("submit");
    const clockIn = await db().timeClockEvent.findFirst({
      where: { clubId: F.club.id, employeeId: F.emp.id, kind: "CLOCK_IN" },
    });
    const v1 = await readScopeVersion(F.club.id, F.period.id, F.events.id);
    await submitCorrectionRequest(empPortal(F.club.id, F.emp.id), {
      requestType: "CORRECT_CLOCK_IN", originalClockEventId: clockIn!.id,
      requestedLocalIso: "2026-09-05T14:15", reason: "adj", employmentAssignmentId: F.assn.id,
    });
    const v2 = await readScopeVersion(F.club.id, F.period.id, F.events.id);
    expect(v2).toBeGreaterThan(v1);
  });

  it("§T correction reject bumps scope version", async () => {
    const F = await setupReadyScope("reject");
    const clockIn = await db().timeClockEvent.findFirst({
      where: { clubId: F.club.id, employeeId: F.emp.id, kind: "CLOCK_IN" },
    });
    await submitCorrectionRequest(empPortal(F.club.id, F.emp.id), {
      requestType: "CORRECT_CLOCK_IN", originalClockEventId: clockIn!.id,
      requestedLocalIso: "2026-09-05T14:15", reason: "adj", employmentAssignmentId: F.assn.id,
    });
    const v1 = await readScopeVersion(F.club.id, F.period.id, F.events.id);
    const corr = await db().timeClockCorrectionRequest.findFirst({
      where: { clubId: F.club.id, status: "PENDING" },
    });
    await rejectCorrectionRequest(principal(F.mgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      requestId: corr!.id, reviewerNote: "no",
    });
    const v2 = await readScopeVersion(F.club.id, F.period.id, F.events.id);
    expect(v2).toBeGreaterThan(v1);
  });

  it("§U correction cancel bumps scope version", async () => {
    const F = await setupReadyScope("cancel");
    const clockIn = await db().timeClockEvent.findFirst({
      where: { clubId: F.club.id, employeeId: F.emp.id, kind: "CLOCK_IN" },
    });
    const submitted = await submitCorrectionRequest(empPortal(F.club.id, F.emp.id), {
      requestType: "CORRECT_CLOCK_IN", originalClockEventId: clockIn!.id,
      requestedLocalIso: "2026-09-05T14:15", reason: "adj", employmentAssignmentId: F.assn.id,
    });
    const v1 = await readScopeVersion(F.club.id, F.period.id, F.events.id);
    await cancelCorrectionRequest(empPortal(F.club.id, F.emp.id), submitted.request.id);
    const v2 = await readScopeVersion(F.club.id, F.period.id, F.events.id);
    expect(v2).toBeGreaterThan(v1);
  });

  // ---------------- REAL CAS approval-vs-writer ----------------
  it("§P/§Z approval with stale scope version → ConflictError; no APPROVED persisted", async () => {
    // Snapshot version V1, real material writer bumps to V2, then
    // approve with V1 → CAS returns count=0 → ConflictError.
    // NO mocked hash — the bump is a REAL DB mutation via
    // bumpScopeVersion (same code path production material writers use).
    const F = await setupReadyScope("P");
    const review = await getScopeReview(F.club.id, F.period.id, F.events.id);
    const V1 = review.currentScopeVersion;
    // REAL material writer bumps version.
    await bumpScopeVersion(F.club.id, F.period.id, F.events.id);
    const V2 = await readScopeVersion(F.club.id, F.period.id, F.events.id);
    expect(V2).toBe(V1 + 1);
    // Approve with stale V1 — CAS fails.
    await expect(
      approveTimesheetScope(principal(F.mgr, F.club.id, "DEPARTMENT_MANAGER"), {
        clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.events.id,
        attestedRevision: review.currentRevision,
        expectedScopeVersion: V1,
      }),
    ).rejects.toThrow(/changed while approval was committing|Refresh and re-attest/);
    // No APPROVED persisted (upsert inside tx rolled back).
    expect(await db().payrollDepartmentTimeApproval.count({
      where: { clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.events.id },
    })).toBe(0);
  });

  it("§AA approval-wins → V1 approved; subsequent bump → REVIEW_REQUIRED via invalidate", async () => {
    const F = await setupReadyScope("AA");
    const review = await getScopeReview(F.club.id, F.period.id, F.events.id);
    const V1 = review.currentScopeVersion;
    await approveTimesheetScope(principal(F.mgr, F.club.id, "DEPARTMENT_MANAGER"), {
      clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.events.id,
      attestedRevision: review.currentRevision, expectedScopeVersion: V1,
    });
    const approval = await db().payrollDepartmentTimeApproval.findFirst({
      where: { clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.events.id },
    });
    expect(approval!.state).toBe("APPROVED");
    expect(approval!.approvedScopeVersion).toBe(V1);
    // Bump post-approve → scope version diverges → invalidateApprovalIfDrifted.
    await makeClock(F.club.id, F.emp.id, "CLOCK_IN", utc(2026, 9, 7, 14, 0), F.assn.id);
    await makeClock(F.club.id, F.emp.id, "CLOCK_OUT", utc(2026, 9, 7, 22, 0), F.assn.id);
    await materializeEmployeeTimesheet(F.club.id, F.emp.id, F.period.id);
    const { invalidateApprovalIfDrifted } = await import("@/lib/timesheets/manager-approval");
    await invalidateApprovalIfDrifted(F.club.id, F.period.id, F.events.id);
    const after = await db().payrollDepartmentTimeApproval.findFirst({
      where: { clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.events.id },
    });
    expect(after!.state).toBe("REVIEW_REQUIRED");
  });

  it("§Q reverse-order: writer commits first → approval CAS fails STALE", async () => {
    // Reverse-order of §P: bump the version BEFORE the manager even
    // snapshots. Manager's attest reads V2 but code uses stale V1 →
    // CAS fails.
    const F = await setupReadyScope("Q");
    const review1 = await getScopeReview(F.club.id, F.period.id, F.events.id);
    // Bump.
    await bumpScopeVersion(F.club.id, F.period.id, F.events.id);
    // Manager attests stale V1.
    await expect(
      approveTimesheetScope(principal(F.mgr, F.club.id, "DEPARTMENT_MANAGER"), {
        clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.events.id,
        attestedRevision: review1.currentRevision,
        expectedScopeVersion: review1.currentScopeVersion,
      }),
    ).rejects.toThrow();
    expect(await db().payrollDepartmentTimeApproval.count({
      where: { clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.events.id },
    })).toBe(0);
  });

  it("§R approval-vs-correction-approve concurrency: correction approves + bumps → subsequent approve at stale V fails", async () => {
    const F = await setupReadyScope("R");
    const clockIn = await db().timeClockEvent.findFirst({
      where: { clubId: F.club.id, employeeId: F.emp.id, kind: "CLOCK_IN" },
    });
    const submitted = await submitCorrectionRequest(empPortal(F.club.id, F.emp.id), {
      requestType: "CORRECT_CLOCK_IN", originalClockEventId: clockIn!.id,
      requestedLocalIso: "2026-09-05T14:15", reason: "adj", employmentAssignmentId: F.assn.id,
    });
    const review1 = await getScopeReview(F.club.id, F.period.id, F.events.id);
    // Correction approve → bumps + materialize (which also bumps).
    await approveCorrectionRequest(principal(F.mgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      requestId: submitted.request.id, reviewerNote: null,
    });
    // Attempt approve with the pre-correction attest.
    await expect(
      approveTimesheetScope(principal(F.mgr, F.club.id, "DEPARTMENT_MANAGER"), {
        clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.events.id,
        attestedRevision: review1.currentRevision,
        expectedScopeVersion: review1.currentScopeVersion,
      }),
    ).rejects.toThrow();
  });

  // ---------------- getScopeReview contract ----------------
  it("§L getScopeReview returns currentScopeVersion alongside currentRevision", async () => {
    const F = await setupReadyScope("L");
    const review = await getScopeReview(F.club.id, F.period.id, F.events.id);
    expect(review.currentRevision).toBeTruthy();
    expect(typeof review.currentScopeVersion).toBe("number");
    expect(review.currentScopeVersion).toBeGreaterThanOrEqual(0);
  });

  // ---------------- side-effect guard ----------------
  it("§AH/§AI/§AJ zero PayrollApprovedTimeEntry / PayrollBatch / JournalEntry across Slice 7B flows", async () => {
    const F = await setupReadyScope("side");
    const review = await getScopeReview(F.club.id, F.period.id, F.events.id);
    await approveTimesheetScope(principal(F.mgr, F.club.id, "DEPARTMENT_MANAGER"), {
      clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.events.id,
      attestedRevision: review.currentRevision,
      expectedScopeVersion: review.currentScopeVersion,
    });
    expect(await db().payrollApprovedTimeEntry.count({ where: { clubId: F.club.id } })).toBe(0);
    expect(await db().payrollBatch.count({ where: { clubId: F.club.id } })).toBe(0);
    expect(await db().journalEntry.count({ where: { clubId: F.club.id } })).toBe(0);
  });
});
