// Payroll-3D-3B Slice 4 (2026-09-06) — tests for the secure server-
// action dispatcher. Covers whitelist, WI binding, principal
// re-resolution, blocked-scope gate, stale/already-decided, wrong-
// tenant/wrong-manager/wrong-item, config-gap misuse, concurrency,
// employee denial, admin override.
//
// The dispatcher is exercised directly (not via the "use server"
// wrapper) so tests can build principals without going through
// iron-session. §Slice 4 §TESTS 23-40.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub } from "../util/db";
import { CORRECTION_REVIEW_ORIGIN_INDEX_NAME } from "@/lib/work-intake/origin-conflict";
import {
  invokeWorkIntakeAction,
  type WorkIntakeActionResult,
} from "@/lib/work-intake/action-dispatcher";
import { materializeEmployeeTimesheet } from "@/lib/timesheets/service";
import { submitCorrectionRequest } from "@/lib/timesheets/correction-service";
import { getScopeReview } from "@/lib/timesheets/approval-scope";
import {
  CORRECTION_REVIEW_KIND,
  missingApproverGapReferenceId,
} from "@/lib/work-intake/correction-review-orchestration";
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
async function makePayrollAdmin(clubId: string, email: string) {
  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.default.hash("password", 4);
  const user = await db().user.create({
    data: { email, name: email, role: "PAYROLL_ADMIN", passwordHash, clubId, status: "ACTIVE" },
  });
  await db().userClubRole.create({ data: { userId: user.id, clubId, roleKey: "PAYROLL_ADMIN" } });
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
function principal(
  user: { id: string; email: string; name: string; status: string; memberId: string | null },
  clubId: string,
  roleKey: "DEPARTMENT_MANAGER"|"CLUB_ADMIN"|"PAYROLL_ADMIN",
): Principal {
  return {
    id: user.id, name: user.name, email: user.email, status: user.status,
    memberships: [{ clubId, roleKey }], activeClubId: clubId, memberId: user.memberId,
  };
}
function empPrincipal(clubId: string, employeeId: string): EmployeePortalPrincipal {
  return { clubId, employeeId, generation: 1, establishedAt: new Date().toISOString() };
}

// Turn an EmployeePortalPrincipal into a shape TypeScript will accept
// for the dispatcher's Principal parameter — a real employee principal
// has no `memberships`, and the canonical services will reject it. We
// cast at the boundary to prove that even a well-formed "spoofed"
// principal object fails safely.
function empAsPrincipalShape(clubId: string, empUserId: string): Principal {
  return {
    id: empUserId, name: "employee", email: "emp@t.test", status: "ACTIVE",
    memberships: [], activeClubId: clubId, memberId: null,
  };
}

interface CorrectionFixture {
  club: { id: string };
  events: { id: string };
  eMgr: { id: string; email: string; name: string; status: string; memberId: string | null };
  admin: { id: string; email: string; name: string; status: string; memberId: string | null };
  emp: { id: string };
  assn: { id: string };
  period: { id: string };
  request: { id: string };
  workIntakeItemId: string;
}

async function setupCorrectionFixture(seed: string): Promise<CorrectionFixture> {
  const club = await makeClub(`3D3B-slice4-${seed}`);
  const events = await makeDept(club.id, "EVENTS", "Events");
  const eMgr = await makeManager(club.id, `events.mgr.${seed}@t.test`);
  const admin = await makeAdmin(club.id, `admin.${seed}@t.test`);
  await assignDeptApprover(club.id, events.id, eMgr.id);
  const emp = await makeEmp(club.id, `e-${seed}`);
  const assn = await makeAssn(club.id, emp.id, events.id);
  const { period } = await makePeriod(club.id, seed, emp.id);
  const clockIn = await makeClock(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), assn.id);
  await makeClock(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), assn.id);
  const submitted = await submitCorrectionRequest(empPrincipal(club.id, emp.id), {
    requestType: "CORRECT_CLOCK_IN", originalClockEventId: clockIn.id,
    requestedLocalIso: "2026-09-05T14:15", reason: "Rounded to top of the hour.",
    employmentAssignmentId: assn.id,
  });
  const origin = await db().workIntakeOrigin.findFirst({
    where: { clubId: club.id, kind: CORRECTION_REVIEW_KIND, referenceId: submitted.request.id, role: "PRIMARY" },
    select: { workIntakeItemId: true },
  });
  if (!origin) throw new Error(`fixture failed: no correction-review WI for ${submitted.request.id}`);
  return { club, events, eMgr, admin, emp, assn, period, request: submitted.request, workIntakeItemId: origin.workIntakeItemId };
}

interface ScopeFixture {
  club: { id: string };
  events: { id: string };
  eMgr: { id: string; email: string; name: string; status: string; memberId: string | null };
  emp: { id: string };
  assn: { id: string };
  period: { id: string };
  workIntakeItemId: string;
  currentRevision: string;
}

async function setupReadyScopeFixture(seed: string): Promise<ScopeFixture> {
  const club = await makeClub(`3D3B-slice4-${seed}`);
  const events = await makeDept(club.id, "EVENTS", "Events");
  const eMgr = await makeManager(club.id, `events.mgr.${seed}@t.test`);
  await assignDeptApprover(club.id, events.id, eMgr.id);
  const emp = await makeEmp(club.id, `e-${seed}`);
  const assn = await makeAssn(club.id, emp.id, events.id);
  const { period } = await makePeriod(club.id, seed, emp.id);
  await makeClock(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), assn.id);
  await makeClock(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), assn.id);
  await materializeEmployeeTimesheet(club.id, emp.id, period.id);
  const origin = await db().workIntakeOrigin.findFirst({
    where: { clubId: club.id, kind: "PAYROLL_TIMESHEET_APPROVAL", referenceId: `${period.id}:${events.id}`, role: "PRIMARY" },
    select: { workIntakeItemId: true },
  });
  if (!origin) throw new Error(`fixture failed: no scope WI`);
  const review = await getScopeReview(club.id, period.id, events.id);
  return { club, events, eMgr, emp, assn, period, workIntakeItemId: origin.workIntakeItemId, currentRevision: review.currentRevision };
}

// ==================================================================
// Suite
// ==================================================================
describe("Payroll-3D-3B Slice 4 · Work Intake action dispatcher", () => {
  beforeAll(async () => {
    await db().$executeRawUnsafe(DDL);
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  // ------------- success paths -------------
  it("§23 correction.approve — valid Events Manager + matching WI → SUCCESS", async () => {
    const F = await setupCorrectionFixture("23");
    const r = await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "correction.approve",
      workIntakeItemId: F.workIntakeItemId,
      correctionRequestId: F.request.id,
    });
    expect(r.ok).toBe(true);
    const after = await db().timeClockCorrectionRequest.findUnique({ where: { id: F.request.id } });
    expect(after!.status).toBe("APPROVED");
  });

  it("§24 correction.reject — valid Events Manager + valid note → SUCCESS", async () => {
    const F = await setupCorrectionFixture("24");
    const r = await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "correction.reject",
      workIntakeItemId: F.workIntakeItemId,
      correctionRequestId: F.request.id,
      reviewerNote: "Not warranted — session time was correct.",
    });
    expect(r.ok).toBe(true);
    const after = await db().timeClockCorrectionRequest.findUnique({ where: { id: F.request.id } });
    expect(after!.status).toBe("REJECTED");
  });

  it("§25 correction.reject — canonical validation still applies (missing reviewerNote handled)", async () => {
    // The canonical rejectCorrectionRequest accepts optional reviewerNote
    // (`(input.reviewerNote ?? "").trim() || null`), so a blank note
    // is not itself a validation error. To exercise the validation
    // path, we submit a whitespace-only note — the canonical service
    // trims it to null; verify by asserting the persisted row's
    // reviewerNote is null and status flipped.
    const F = await setupCorrectionFixture("25");
    const r = await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "correction.reject",
      workIntakeItemId: F.workIntakeItemId,
      correctionRequestId: F.request.id,
      reviewerNote: "   ",
    });
    expect(r.ok).toBe(true);
    const after = await db().timeClockCorrectionRequest.findUnique({ where: { id: F.request.id } });
    expect(after!.status).toBe("REJECTED");
    expect(after!.reviewerNote).toBeNull();
  });

  it("§26 timesheetScope.approve — ready scope + Events Manager + revision → SUCCESS", async () => {
    const F = await setupReadyScopeFixture("26");
    const r = await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "timesheetScope.approve",
      workIntakeItemId: F.workIntakeItemId,
      payPeriodId: F.period.id,
      departmentId: F.events.id,
      expectedRevision: F.currentRevision,
    });
    expect(r.ok).toBe(true);
    const approval = await db().payrollDepartmentTimeApproval.findFirst({
      where: { clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.events.id },
    });
    expect(approval!.state).toBe("APPROVED");
  });

  // ------------- gates -------------
  it("§27 blocked scope — pending correction present → NOT_READY", async () => {
    const F = await setupReadyScopeFixture("27");
    // Submit a PENDING correction to block readiness (see Slice 3 §23).
    const clockIn = await db().timeClockEvent.findFirst({
      where: { clubId: F.club.id, employeeId: F.emp.id, kind: "CLOCK_IN" },
    });
    await submitCorrectionRequest(empPrincipal(F.club.id, F.emp.id), {
      requestType: "CORRECT_CLOCK_IN", originalClockEventId: clockIn!.id,
      requestedLocalIso: "2026-09-05T14:15", reason: "Small adjustment.",
      employmentAssignmentId: F.assn.id,
    });
    // Revision has now changed — refresh.
    const review = await getScopeReview(F.club.id, F.period.id, F.events.id);
    expect(review.readiness.ready).toBe(false);
    const r = await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "timesheetScope.approve",
      workIntakeItemId: F.workIntakeItemId,
      payPeriodId: F.period.id,
      departmentId: F.events.id,
      expectedRevision: review.currentRevision,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("NOT_READY");
    const approval = await db().payrollDepartmentTimeApproval.findFirst({
      where: { clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.events.id },
    });
    expect(approval).toBeNull();
  });

  it("§28 wrong tenant — Club B manager tries Club A target → NOT_FOUND (no leakage)", async () => {
    const F = await setupCorrectionFixture("28a");
    const clubB = await makeClub("3D3B-slice4-28b");
    const bMgr = await makeManager(clubB.id, "b.mgr@t.test");
    // Attempt with a principal whose activeClubId is clubB.
    const r = await invokeWorkIntakeAction(principal(bMgr, clubB.id, "DEPARTMENT_MANAGER"), clubB.id, {
      action: "correction.approve",
      workIntakeItemId: F.workIntakeItemId,
      correctionRequestId: F.request.id,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("NOT_FOUND");
  });

  it("§29 wrong manager — Grounds Manager tries Events correction → UNAUTHORIZED", async () => {
    const F = await setupCorrectionFixture("29");
    const grounds = await makeDept(F.club.id, "GROUNDS", "Course & Grounds");
    const gMgr = await makeManager(F.club.id, "grounds.mgr@t.test");
    await assignDeptApprover(F.club.id, grounds.id, gMgr.id);
    const r = await invokeWorkIntakeAction(principal(gMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "correction.approve",
      workIntakeItemId: F.workIntakeItemId,
      correctionRequestId: F.request.id,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNAUTHORIZED");
  });

  it("§30 responsibility changed — Manager A loses assignment mid-flight → UNAUTHORIZED", async () => {
    const F = await setupCorrectionFixture("30");
    // Reassign responsibility to a new manager BEFORE A acts.
    const mgrB = await makeManager(F.club.id, "events.mgr2@t.test");
    await assignDeptApprover(F.club.id, F.events.id, mgrB.id);
    // Old manager (F.eMgr) tries to act.
    const r = await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "correction.approve",
      workIntakeItemId: F.workIntakeItemId,
      correctionRequestId: F.request.id,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNAUTHORIZED");
    // New manager succeeds.
    const r2 = await invokeWorkIntakeAction(principal(mgrB, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "correction.approve",
      workIntakeItemId: F.workIntakeItemId,
      correctionRequestId: F.request.id,
    });
    expect(r2.ok).toBe(true);
  });

  it("§31a wrong WI binding — correction A WI + correction B target → NOT_FOUND", async () => {
    const A = await setupCorrectionFixture("31A");
    // Submit a second correction inside the same club.
    const clockIn2 = await makeClock(A.club.id, A.emp.id, "CLOCK_IN", utc(2026, 9, 7, 14, 0), A.assn.id);
    await makeClock(A.club.id, A.emp.id, "CLOCK_OUT", utc(2026, 9, 7, 22, 0), A.assn.id);
    const B = await submitCorrectionRequest(empPrincipal(A.club.id, A.emp.id), {
      requestType: "CORRECT_CLOCK_IN", originalClockEventId: clockIn2.id,
      requestedLocalIso: "2026-09-07T14:15", reason: "Second correction.",
      employmentAssignmentId: A.assn.id,
    });
    // Use A's WI id with B's correctionRequestId.
    const r = await invokeWorkIntakeAction(principal(A.eMgr, A.club.id, "DEPARTMENT_MANAGER"), A.club.id, {
      action: "correction.approve",
      workIntakeItemId: A.workIntakeItemId,
      correctionRequestId: B.request.id,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("NOT_FOUND");
  });

  it("§31b wrong WI binding — Events scope WI + Grounds target → NOT_FOUND", async () => {
    const F = await setupReadyScopeFixture("31B");
    const grounds = await makeDept(F.club.id, "GROUNDS", "Course & Grounds");
    const gMgr = await makeManager(F.club.id, "grounds.mgr@t.test");
    await assignDeptApprover(F.club.id, grounds.id, gMgr.id);
    const r = await invokeWorkIntakeAction(principal(gMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "timesheetScope.approve",
      workIntakeItemId: F.workIntakeItemId, // Events WI
      payPeriodId: F.period.id,
      departmentId: grounds.id,             // Grounds target
      expectedRevision: F.currentRevision,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("NOT_FOUND");
  });

  it("§32a config-gap misuse — correction gap WI used for correction.approve → CONFIG_GAP", async () => {
    // Create a scenario where the department has NO owner so the WI
    // that gets created is the correction config-gap card.
    const club = await makeClub("3D3B-slice4-32a");
    const events = await makeDept(club.id, "EVENTS", "Events");
    // NO assignDeptApprover.
    const admin = await makeAdmin(club.id, "admin@t.test");
    const emp = await makeEmp(club.id, "e32a");
    const assn = await makeAssn(club.id, emp.id, events.id);
    await makePeriod(club.id, "32a", emp.id);
    const clockIn = await makeClock(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), assn.id);
    await makeClock(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), assn.id);
    const submitted = await submitCorrectionRequest(empPrincipal(club.id, emp.id), {
      requestType: "CORRECT_CLOCK_IN", originalClockEventId: clockIn.id,
      requestedLocalIso: "2026-09-05T14:15", reason: "Adjust.", employmentAssignmentId: assn.id,
    });
    // The gap WI is what got created — its origin refId is prefixed
    // with MISSING_APPROVER.
    const gapOrigin = await db().workIntakeOrigin.findFirst({
      where: { clubId: club.id, referenceId: missingApproverGapReferenceId(events.id, submitted.request.id) },
      select: { workIntakeItemId: true },
    });
    expect(gapOrigin).not.toBeNull();
    const r = await invokeWorkIntakeAction(principal(admin, club.id, "CLUB_ADMIN"), club.id, {
      action: "correction.approve",
      workIntakeItemId: gapOrigin!.workIntakeItemId,
      correctionRequestId: submitted.request.id,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("CONFIG_GAP");
    const after = await db().timeClockCorrectionRequest.findUnique({ where: { id: submitted.request.id } });
    expect(after!.status).toBe("PENDING");
  });

  it("§32b config-gap misuse — scope gap WI used for timesheetScope.approve → CONFIG_GAP", async () => {
    // Create a ready scope but no DEPARTMENT_TIME_APPROVAL owner → gap.
    const club = await makeClub("3D3B-slice4-32b");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const admin = await makeAdmin(club.id, "admin@t.test");
    const emp = await makeEmp(club.id, "e32b");
    const assn = await makeAssn(club.id, emp.id, events.id);
    const { period } = await makePeriod(club.id, "32b", emp.id);
    await makeClock(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), assn.id);
    await makeClock(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), assn.id);
    await materializeEmployeeTimesheet(club.id, emp.id, period.id);
    const scopeGap = await db().workIntakeOrigin.findFirst({
      where: { clubId: club.id, kind: "PAYROLL_TIMESHEET_APPROVAL_CONFIG_GAP" },
      select: { workIntakeItemId: true },
    });
    expect(scopeGap).not.toBeNull();
    const r = await invokeWorkIntakeAction(principal(admin, club.id, "CLUB_ADMIN"), club.id, {
      action: "timesheetScope.approve",
      workIntakeItemId: scopeGap!.workIntakeItemId,
      payPeriodId: period.id,
      departmentId: events.id,
      expectedRevision: "does-not-matter",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("CONFIG_GAP");
  });

  // ------------- lifecycle -------------
  it("§33 stale correction — after first-wins the WI is RESOLVED so second click returns STALE", async () => {
    // Slice 5 (2026-09-06) lifecycle update: the first successful
    // approve now resolves the WI via emitWorkCompletionEvent, so the
    // second click hits the Slice 4A actionable-status gate FIRST
    // (STALE) rather than the domain ALREADY_DECIDED gate. Both
    // codes are structured, both fail-closed, and the STALE message
    // is the more actionable one for the manager ("refresh MC").
    // Domain-side "exactly one decision" invariant is preserved.
    const F = await setupCorrectionFixture("33");
    const first = await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "correction.approve",
      workIntakeItemId: F.workIntakeItemId,
      correctionRequestId: F.request.id,
    });
    expect(first.ok).toBe(true);
    const second = await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "correction.reject",
      workIntakeItemId: F.workIntakeItemId,
      correctionRequestId: F.request.id,
      reviewerNote: "trying too late",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(["STALE", "ALREADY_DECIDED"]).toContain(second.code);
    // Exactly one ADMIN_CORRECTION event.
    const adminCorr = await db().timeClockEvent.count({
      where: { clubId: F.club.id, source: "ADMIN_CORRECTION" },
    });
    expect(adminCorr).toBe(1);
  });

  it("§34 approve vs reject concurrency — exactly one wins, other is structured stale", async () => {
    const F = await setupCorrectionFixture("34");
    const p = principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER");
    const [a, b] = await Promise.all([
      invokeWorkIntakeAction(p, F.club.id, {
        action: "correction.approve",
        workIntakeItemId: F.workIntakeItemId,
        correctionRequestId: F.request.id,
      }),
      invokeWorkIntakeAction(p, F.club.id, {
        action: "correction.reject",
        workIntakeItemId: F.workIntakeItemId,
        correctionRequestId: F.request.id,
        reviewerNote: "reject",
      }),
    ]);
    const winners = [a, b].filter((r) => r.ok).length;
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toBe(1);
    expect(losers).toHaveLength(1);
    // The loser MUST be a structured failure, never an unhandled exception.
    for (const l of losers) {
      if (!l.ok) expect(["ALREADY_DECIDED", "STALE", "CONFLICT"]).toContain(l.code);
    }
  });

  it("§35 stale revision — approve with old revision → STALE (no approval)", async () => {
    const F = await setupReadyScopeFixture("35");
    // Add another session → revision changes.
    await makeClock(F.club.id, F.emp.id, "CLOCK_IN", utc(2026, 9, 7, 14, 0), F.assn.id);
    await makeClock(F.club.id, F.emp.id, "CLOCK_OUT", utc(2026, 9, 7, 22, 0), F.assn.id);
    await materializeEmployeeTimesheet(F.club.id, F.emp.id, F.period.id);
    // Try to approve with the ORIGINAL (stale) revision.
    const r = await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "timesheetScope.approve",
      workIntakeItemId: F.workIntakeItemId,
      payPeriodId: F.period.id,
      departmentId: F.events.id,
      expectedRevision: F.currentRevision,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("STALE");
    const approval = await db().payrollDepartmentTimeApproval.findFirst({
      where: { clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.events.id },
    });
    expect(approval).toBeNull();
  });

  it("§36 (Slice 4A revised) RESOLVED WI + PENDING correction — STALE + reconciliation reopens card", async () => {
    // Slice 4A INVARIANT: a RESOLVED card is not a valid execution
    // path even when the underlying correction is still PENDING. The
    // dispatcher must return STALE and trigger canonical
    // reconciliation so the card is reopened for the responsible
    // manager — the user then acts from the current active
    // obligation, not the stale card.
    const F = await setupCorrectionFixture("36");
    // Manually resolve the WI to simulate a stale-card scenario.
    await db().workIntakeItem.update({
      where: { id: F.workIntakeItemId },
      data: { status: "RESOLVED", resolvedAt: new Date(), resolvedByUserId: F.eMgr.id },
    });
    const r = await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "correction.approve",
      workIntakeItemId: F.workIntakeItemId,
      correctionRequestId: F.request.id,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("STALE");
    // Correction was NOT decided.
    const corr = await db().timeClockCorrectionRequest.findUnique({ where: { id: F.request.id } });
    expect(corr!.status).toBe("PENDING");
    // Reconciliation reopened the card — it's now OPEN, still owned
    // by the same responsible manager, ready to act from.
    const reopened = await db().workIntakeItem.findUnique({ where: { id: F.workIntakeItemId } });
    expect(reopened!.status).toBe("OPEN");
    expect(reopened!.ownerUserId).toBe(F.eMgr.id);
  });

  it("§37 employee denial — a portal-shaped principal without memberships is rejected", async () => {
    const F = await setupCorrectionFixture("37");
    // Build a Principal-shaped object that has NO clubRoles/memberships
    // — the canonical services will reject via hasPermission.
    const emp = empAsPrincipalShape(F.club.id, F.emp.id);
    const r = await invokeWorkIntakeAction(emp, F.club.id, {
      action: "correction.approve",
      workIntakeItemId: F.workIntakeItemId,
      correctionRequestId: F.request.id,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNAUTHORIZED");
  });

  it("§38 admin override — tenant-scoped payroll:write may still act on correction (canonical behaviour)", async () => {
    // Documents the intentional pre-existing override: a tenant-
    // scoped Payroll Admin may decide corrections independent of
    // DEPARTMENT_TIME_APPROVAL ownership (see
    // assertCorrectionScopeAuthorization in correction-service.ts).
    // Slice 4 preserves this. It does NOT invent a new privilege.
    const F = await setupCorrectionFixture("38");
    const pa = await makePayrollAdmin(F.club.id, "payroll.admin@t.test");
    const r = await invokeWorkIntakeAction(principal(pa, F.club.id, "PAYROLL_ADMIN"), F.club.id, {
      action: "correction.approve",
      workIntakeItemId: F.workIntakeItemId,
      correctionRequestId: F.request.id,
    });
    expect(r.ok).toBe(true);
  });

  it("§39/§40 correction approve → no PayrollApprovedTimeEntry, no PayrollBatch, no JournalEntry", async () => {
    const F = await setupCorrectionFixture("39");
    await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "correction.approve",
      workIntakeItemId: F.workIntakeItemId,
      correctionRequestId: F.request.id,
    });
    expect(await db().payrollApprovedTimeEntry.count({ where: { clubId: F.club.id } })).toBe(0);
    expect(await db().payrollBatch.count({ where: { clubId: F.club.id } })).toBe(0);
    expect(await db().journalEntry.count({ where: { clubId: F.club.id } })).toBe(0);
  });

  it("timesheetScope.approve → no PayrollApprovedTimeEntry / PayrollBatch / JournalEntry", async () => {
    const F = await setupReadyScopeFixture("39b");
    await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "timesheetScope.approve",
      workIntakeItemId: F.workIntakeItemId,
      payPeriodId: F.period.id,
      departmentId: F.events.id,
      expectedRevision: F.currentRevision,
    });
    expect(await db().payrollApprovedTimeEntry.count({ where: { clubId: F.club.id } })).toBe(0);
    expect(await db().payrollBatch.count({ where: { clubId: F.club.id } })).toBe(0);
    expect(await db().journalEntry.count({ where: { clubId: F.club.id } })).toBe(0);
  });

  it("unknown action name is rejected as VALIDATION_ERROR (whitelist enforcement)", async () => {
    const F = await setupCorrectionFixture("wl");
    const r: WorkIntakeActionResult = await invokeWorkIntakeAction(
      principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"),
      F.club.id,
      // Force an unknown action to exercise the exhaustiveness branch.
      { action: "correction.forge", workIntakeItemId: F.workIntakeItemId, correctionRequestId: F.request.id } as unknown as Parameters<typeof invokeWorkIntakeAction>[2],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(["VALIDATION_ERROR", "INTERNAL_ERROR"]).toContain(r.code);
  });
});

// ==================================================================
// Slice 4A · Work Intake actionable-status invariant
// ==================================================================
describe("Payroll-3D-3B Slice 4A · WI actionable-status invariant", () => {
  beforeAll(async () => {
    await db().$executeRawUnsafe(DDL);
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("§4A-1 OPEN correction WI + PENDING correction → action still succeeds (baseline)", async () => {
    const F = await setupCorrectionFixture("4A-1");
    const r = await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "correction.approve",
      workIntakeItemId: F.workIntakeItemId,
      correctionRequestId: F.request.id,
    });
    expect(r.ok).toBe(true);
  });

  it("§4A-2 RESOLVED correction WI + PENDING correction → STALE + reconciliation reopens", async () => {
    const F = await setupCorrectionFixture("4A-2");
    await db().workIntakeItem.update({
      where: { id: F.workIntakeItemId },
      data: { status: "RESOLVED", resolvedAt: new Date(), resolvedByUserId: F.eMgr.id },
    });
    const r = await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "correction.approve",
      workIntakeItemId: F.workIntakeItemId,
      correctionRequestId: F.request.id,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("STALE");
    // Domain unchanged.
    const corr = await db().timeClockCorrectionRequest.findUnique({ where: { id: F.request.id } });
    expect(corr!.status).toBe("PENDING");
    // Reconciliation reopened the canonical WI.
    const reopened = await db().workIntakeItem.findUnique({ where: { id: F.workIntakeItemId } });
    expect(reopened!.status).toBe("OPEN");
    expect(reopened!.resolvedAt).toBeNull();
    expect(reopened!.resolvedByUserId).toBeNull();
    // Fresh invocation from the (now-active) card succeeds.
    const r2 = await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "correction.approve",
      workIntakeItemId: F.workIntakeItemId,
      correctionRequestId: F.request.id,
    });
    expect(r2.ok).toBe(true);
  });

  it("§4A-3 RESOLVED correction WI + APPROVED correction → STALE, no duplicate action, no reopen", async () => {
    const F = await setupCorrectionFixture("4A-3");
    // Approve first (valid) → WI resolves normally via Slice 5 (not yet
    // wired), so manually flip to APPROVED + RESOLVED to model the
    // "already decided + resolved" state.
    await db().timeClockCorrectionRequest.update({
      where: { id: F.request.id }, data: { status: "APPROVED" },
    });
    await db().workIntakeItem.update({
      where: { id: F.workIntakeItemId },
      data: { status: "RESOLVED", resolvedAt: new Date(), resolvedByUserId: F.eMgr.id },
    });
    const r = await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "correction.approve",
      workIntakeItemId: F.workIntakeItemId,
      correctionRequestId: F.request.id,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("STALE");
    // Reconciliation runs `ensureCorrectionReviewWorkItems` — that
    // helper short-circuits on non-PENDING status, so no reopen.
    const still = await db().workIntakeItem.findUnique({ where: { id: F.workIntakeItemId } });
    expect(still!.status).toBe("RESOLVED");
    // Correction stays APPROVED (single decision).
    const corr = await db().timeClockCorrectionRequest.findUnique({ where: { id: F.request.id } });
    expect(corr!.status).toBe("APPROVED");
  });

  it("§4A-4 RESOLVED correction WI + REJECTED correction → same invariant, no duplicate", async () => {
    const F = await setupCorrectionFixture("4A-4");
    await db().timeClockCorrectionRequest.update({
      where: { id: F.request.id }, data: { status: "REJECTED" },
    });
    await db().workIntakeItem.update({
      where: { id: F.workIntakeItemId },
      data: { status: "RESOLVED", resolvedAt: new Date(), resolvedByUserId: F.eMgr.id },
    });
    const r = await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "correction.reject",
      workIntakeItemId: F.workIntakeItemId,
      correctionRequestId: F.request.id,
      reviewerNote: "second attempt",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("STALE");
    const still = await db().workIntakeItem.findUnique({ where: { id: F.workIntakeItemId } });
    expect(still!.status).toBe("RESOLVED");
  });

  it("§4A-5 SUPPRESSED correction WI → STALE + NO reconciliation (user intent preserved)", async () => {
    const F = await setupCorrectionFixture("4A-5");
    await db().workIntakeItem.update({
      where: { id: F.workIntakeItemId },
      data: { status: "SUPPRESSED" },
    });
    const r = await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "correction.approve",
      workIntakeItemId: F.workIntakeItemId,
      correctionRequestId: F.request.id,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("STALE");
    // Stays SUPPRESSED — reconciliation must NOT fight the user's intent.
    const still = await db().workIntakeItem.findUnique({ where: { id: F.workIntakeItemId } });
    expect(still!.status).toBe("SUPPRESSED");
  });

  it("§4A-6 INFORMATIONAL correction WI → STALE + NO reconciliation", async () => {
    const F = await setupCorrectionFixture("4A-6");
    await db().workIntakeItem.update({
      where: { id: F.workIntakeItemId },
      data: { status: "INFORMATIONAL" },
    });
    const r = await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "correction.approve",
      workIntakeItemId: F.workIntakeItemId,
      correctionRequestId: F.request.id,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("STALE");
    const still = await db().workIntakeItem.findUnique({ where: { id: F.workIntakeItemId } });
    expect(still!.status).toBe("INFORMATIONAL");
  });

  it("§4A-7 DEFERRED correction WI → STALE + NO reconciliation (postponed by user)", async () => {
    const F = await setupCorrectionFixture("4A-7");
    await db().workIntakeItem.update({
      where: { id: F.workIntakeItemId },
      data: { status: "DEFERRED", deferredUntil: new Date(Date.now() + 86400_000) },
    });
    const r = await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "correction.approve",
      workIntakeItemId: F.workIntakeItemId,
      correctionRequestId: F.request.id,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("STALE");
    const still = await db().workIntakeItem.findUnique({ where: { id: F.workIntakeItemId } });
    expect(still!.status).toBe("DEFERRED");
  });

  it("§4A-8 RESOLVED timesheet WI + ready scope → STALE + reconciliation reopens", async () => {
    const F = await setupReadyScopeFixture("4A-8");
    await db().workIntakeItem.update({
      where: { id: F.workIntakeItemId },
      data: { status: "RESOLVED", resolvedAt: new Date(), resolvedByUserId: F.eMgr.id },
    });
    const r = await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "timesheetScope.approve",
      workIntakeItemId: F.workIntakeItemId,
      payPeriodId: F.period.id,
      departmentId: F.events.id,
      expectedRevision: F.currentRevision,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("STALE");
    // No approval row created.
    const approval = await db().payrollDepartmentTimeApproval.findFirst({
      where: { clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.events.id },
    });
    expect(approval).toBeNull();
    // Reconciliation reopened the card.
    const reopened = await db().workIntakeItem.findUnique({ where: { id: F.workIntakeItemId } });
    expect(reopened!.status).toBe("OPEN");
  });

  it("§4A-9 RESOLVED timesheet WI + already APPROVED scope at current revision → STALE, no reopen", async () => {
    // Set up a fully-approved scope, then manually clear the WI ID
    // link + mark WI resolved to model the invariant.
    const F = await setupReadyScopeFixture("4A-9");
    // Approve first via canonical service.
    await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "timesheetScope.approve",
      workIntakeItemId: F.workIntakeItemId,
      payPeriodId: F.period.id,
      departmentId: F.events.id,
      expectedRevision: F.currentRevision,
    });
    // WI is now RESOLVED naturally via approveTimesheetScope's emit.
    const afterApproval = await db().workIntakeItem.findUnique({ where: { id: F.workIntakeItemId } });
    expect(afterApproval!.status).toBe("RESOLVED");
    // Second click on the (still RESOLVED) card.
    const r = await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "timesheetScope.approve",
      workIntakeItemId: F.workIntakeItemId,
      payPeriodId: F.period.id,
      departmentId: F.events.id,
      expectedRevision: F.currentRevision,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("STALE");
    // Slice 3 already-approved guard prevents reopen.
    const still = await db().workIntakeItem.findUnique({ where: { id: F.workIntakeItemId } });
    expect(still!.status).toBe("RESOLVED");
    // Exactly one approval — no duplicate.
    const approvalCount = await db().payrollDepartmentTimeApproval.count({
      where: { clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.events.id },
    });
    expect(approvalCount).toBe(1);
  });

  it("§4A-10 REVIEW_REQUIRED after drift — orchestration reactivates WI, action succeeds from active card", async () => {
    const F = await setupReadyScopeFixture("4A-10");
    // Approve.
    await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "timesheetScope.approve",
      workIntakeItemId: F.workIntakeItemId,
      payPeriodId: F.period.id,
      departmentId: F.events.id,
      expectedRevision: F.currentRevision,
    });
    // Drift the scope.
    await makeClock(F.club.id, F.emp.id, "CLOCK_IN", utc(2026, 9, 7, 14, 0), F.assn.id);
    await makeClock(F.club.id, F.emp.id, "CLOCK_OUT", utc(2026, 9, 7, 22, 0), F.assn.id);
    await materializeEmployeeTimesheet(F.club.id, F.emp.id, F.period.id);
    const { invalidateApprovalIfDrifted } = await import("@/lib/timesheets/manager-approval");
    await invalidateApprovalIfDrifted(F.club.id, F.period.id, F.events.id);
    // WI should now be OPEN again (reactivated by invalidate path in Slice 3).
    const reopened = await db().workIntakeItem.findUnique({ where: { id: F.workIntakeItemId } });
    expect(reopened!.status).toBe("OPEN");
    // Approve with the NEW revision.
    const freshReview = await getScopeReview(F.club.id, F.period.id, F.events.id);
    const r = await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "timesheetScope.approve",
      workIntakeItemId: F.workIntakeItemId,
      payPeriodId: F.period.id,
      departmentId: F.events.id,
      expectedRevision: freshReview.currentRevision,
    });
    expect(r.ok).toBe(true);
  });

  it("§4A-11 Payroll Admin override + RESOLVED card → cannot use stale card", async () => {
    const F = await setupCorrectionFixture("4A-11");
    const pa = await makePayrollAdmin(F.club.id, "payroll.admin@t.test");
    await db().workIntakeItem.update({
      where: { id: F.workIntakeItemId },
      data: { status: "RESOLVED", resolvedAt: new Date(), resolvedByUserId: pa.id },
    });
    const r = await invokeWorkIntakeAction(principal(pa, F.club.id, "PAYROLL_ADMIN"), F.club.id, {
      action: "correction.approve",
      workIntakeItemId: F.workIntakeItemId,
      correctionRequestId: F.request.id,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("STALE");
    // Correction unchanged.
    const corr = await db().timeClockCorrectionRequest.findUnique({ where: { id: F.request.id } });
    expect(corr!.status).toBe("PENDING");
    // Reconciliation reopened → PA can act via canonical override on
    // the fresh active card.
    const reopened = await db().workIntakeItem.findUnique({ where: { id: F.workIntakeItemId } });
    expect(reopened!.status).toBe("OPEN");
    const r2 = await invokeWorkIntakeAction(principal(pa, F.club.id, "PAYROLL_ADMIN"), F.club.id, {
      action: "correction.approve",
      workIntakeItemId: F.workIntakeItemId,
      correctionRequestId: F.request.id,
    });
    expect(r2.ok).toBe(true);
  });

  it("§4A-14/§4A-15 side-effect isolation: PayrollApprovedTimeEntry / PayrollBatch / JournalEntry unchanged", async () => {
    const F = await setupCorrectionFixture("4A-14");
    await db().workIntakeItem.update({
      where: { id: F.workIntakeItemId },
      data: { status: "RESOLVED", resolvedAt: new Date(), resolvedByUserId: F.eMgr.id },
    });
    await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "correction.approve",
      workIntakeItemId: F.workIntakeItemId,
      correctionRequestId: F.request.id,
    });
    expect(await db().payrollApprovedTimeEntry.count({ where: { clubId: F.club.id } })).toBe(0);
    expect(await db().payrollBatch.count({ where: { clubId: F.club.id } })).toBe(0);
    expect(await db().journalEntry.count({ where: { clubId: F.club.id } })).toBe(0);
  });
});
