// Payroll-3D-3B Slice 5 (2026-09-06) — lifecycle connection between
// TimeClockCorrectionRequest and its canonical TIMECLOCK_CORRECTION_REVIEW
// Work Intake obligation.
//
// The invariant proven here:
//   PENDING correction   → active manager review WI
//   APPROVED correction  → manager review WI RESOLVED (via emitWorkCompletionEvent)
//   REJECTED correction  → manager review WI RESOLVED
//
// The lifecycle belongs to the canonical correction service, not to
// Mission Control UI code. So every terminal path — dispatcher,
// direct canonical, admin override, missing WI, RESOLVED WI, etc. —
// converges on the same WI state. Config-gap cards for the same
// correction are also resolved when the correction becomes terminal.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub } from "../util/db";
import { CORRECTION_REVIEW_ORIGIN_INDEX_NAME } from "@/lib/work-intake/origin-conflict";
import {
  CORRECTION_REVIEW_KIND,
  CORRECTION_REVIEW_GAP_KIND,
} from "@/lib/work-intake/correction-review-orchestration";
import {
  submitCorrectionRequest,
  approveCorrectionRequest,
  rejectCorrectionRequest,
} from "@/lib/timesheets/correction-service";
import { materializeEmployeeTimesheet } from "@/lib/timesheets/service";
import { invokeWorkIntakeAction } from "@/lib/work-intake/action-dispatcher";
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

// ------------ scaffolding (mirrors Slice 4 tests) ------------
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
function principal(user: { id: string; email: string; name: string; status: string; memberId: string | null }, clubId: string, roleKey: "DEPARTMENT_MANAGER"|"CLUB_ADMIN"|"PAYROLL_ADMIN"): Principal {
  return { id: user.id, name: user.name, email: user.email, status: user.status, memberships: [{ clubId, roleKey }], activeClubId: clubId, memberId: user.memberId };
}
function empPortal(clubId: string, employeeId: string): EmployeePortalPrincipal {
  return { clubId, employeeId, generation: 1, establishedAt: new Date().toISOString() };
}

interface Fixture {
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
async function setup(seed: string): Promise<Fixture> {
  const club = await makeClub(`3D3B-slice5-${seed}`);
  const events = await makeDept(club.id, "EVENTS", "Events");
  const eMgr = await makeManager(club.id, `events.mgr.${seed}@t.test`);
  const admin = await makeAdmin(club.id, `admin.${seed}@t.test`);
  await assignApprover(club.id, events.id, eMgr.id);
  const emp = await makeEmp(club.id, `e-${seed}`);
  const assn = await makeAssn(club.id, emp.id, events.id);
  const { period } = await makePeriod(club.id, seed, emp.id);
  const clockIn = await makeClock(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), assn.id);
  await makeClock(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), assn.id);
  const submitted = await submitCorrectionRequest(empPortal(club.id, emp.id), {
    requestType: "CORRECT_CLOCK_IN", originalClockEventId: clockIn.id,
    requestedLocalIso: "2026-09-05T14:15", reason: "Adjust.",
    employmentAssignmentId: assn.id,
  });
  const origin = await db().workIntakeOrigin.findFirst({
    where: { clubId: club.id, kind: CORRECTION_REVIEW_KIND, referenceId: submitted.request.id, role: "PRIMARY" },
    select: { workIntakeItemId: true },
  });
  if (!origin) throw new Error(`fixture: no WI`);
  return { club, events, eMgr, admin, emp, assn, period, request: submitted.request, workIntakeItemId: origin.workIntakeItemId };
}

// ==================================================================
describe("Payroll-3D-3B Slice 5 · correction WI lifecycle resolution", () => {
  beforeAll(async () => {
    await db().$executeRawUnsafe(DDL);
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("§22-1 direct canonical approve → manager WI RESOLVED", async () => {
    const F = await setup("22-1");
    await approveCorrectionRequest(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      requestId: F.request.id, reviewerNote: null,
    });
    const wi = await db().workIntakeItem.findUnique({ where: { id: F.workIntakeItemId } });
    expect(wi!.status).toBe("RESOLVED");
    expect(wi!.resolvedAt).not.toBeNull();
    expect(wi!.resolvedByUserId).toBe(F.eMgr.id);
  });

  it("§22-2 direct canonical reject → manager WI RESOLVED", async () => {
    const F = await setup("22-2");
    await rejectCorrectionRequest(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      requestId: F.request.id, reviewerNote: "not warranted",
    });
    const wi = await db().workIntakeItem.findUnique({ where: { id: F.workIntakeItemId } });
    expect(wi!.status).toBe("RESOLVED");
    expect(wi!.resolvedByUserId).toBe(F.eMgr.id);
  });

  it("§22-3 dispatcher approve → WI RESOLVED", async () => {
    const F = await setup("22-3");
    const r = await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "correction.approve",
      workIntakeItemId: F.workIntakeItemId,
      correctionRequestId: F.request.id,
    });
    expect(r.ok).toBe(true);
    const wi = await db().workIntakeItem.findUnique({ where: { id: F.workIntakeItemId } });
    expect(wi!.status).toBe("RESOLVED");
  });

  it("§22-4 dispatcher reject → WI RESOLVED", async () => {
    const F = await setup("22-4");
    const r = await invokeWorkIntakeAction(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      action: "correction.reject",
      workIntakeItemId: F.workIntakeItemId,
      correctionRequestId: F.request.id,
      reviewerNote: "declined",
    });
    expect(r.ok).toBe(true);
    const wi = await db().workIntakeItem.findUnique({ where: { id: F.workIntakeItemId } });
    expect(wi!.status).toBe("RESOLVED");
  });

  it("§22-5/§22-6 resolvedAt + resolvedByUserId populated with actual decider", async () => {
    const F = await setup("22-56");
    const before = new Date();
    await approveCorrectionRequest(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      requestId: F.request.id, reviewerNote: null,
    });
    const wi = await db().workIntakeItem.findUnique({ where: { id: F.workIntakeItemId } });
    expect(wi!.resolvedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(wi!.resolvedByUserId).toBe(F.eMgr.id);
  });

  it("§22-7 WorkCompletionEvent row is written on approve", async () => {
    const F = await setup("22-7");
    await approveCorrectionRequest(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      requestId: F.request.id, reviewerNote: null,
    });
    const evts = await db().workCompletionEvent.findMany({
      where: { workIntakeItemId: F.workIntakeItemId },
    });
    expect(evts).toHaveLength(1);
    expect(evts[0].completionType).toBe("APPROVED_AND_COMPLETED");
    expect(evts[0].completedByUserId).toBe(F.eMgr.id);
  });

  it("§22-7 WorkCompletionEvent completionType=RESOLVED on reject", async () => {
    const F = await setup("22-7r");
    await rejectCorrectionRequest(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      requestId: F.request.id, reviewerNote: "n/a",
    });
    const evts = await db().workCompletionEvent.findMany({
      where: { workIntakeItemId: F.workIntakeItemId },
    });
    expect(evts).toHaveLength(1);
    expect(evts[0].completionType).toBe("RESOLVED");
  });

  it("§22-8 repeat lifecycle reconciliation is idempotent — no duplicate completion event", async () => {
    const F = await setup("22-8");
    await approveCorrectionRequest(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      requestId: F.request.id, reviewerNote: null,
    });
    // Simulate a retry of the recovery job.
    const { ensureCorrectionReviewWorkItems } = await import("@/lib/work-intake/correction-review-orchestration");
    await ensureCorrectionReviewWorkItems({ clubId: F.club.id, correctionRequestId: F.request.id });
    await ensureCorrectionReviewWorkItems({ clubId: F.club.id, correctionRequestId: F.request.id });
    const evts = await db().workCompletionEvent.findMany({
      where: { workIntakeItemId: F.workIntakeItemId },
    });
    expect(evts).toHaveLength(1);
    const wi = await db().workIntakeItem.findUnique({ where: { id: F.workIntakeItemId } });
    expect(wi!.status).toBe("RESOLVED");
  });

  it("§22-9 no active manager card after APPROVED", async () => {
    const F = await setup("22-9");
    await approveCorrectionRequest(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      requestId: F.request.id, reviewerNote: null,
    });
    const active = await db().workIntakeItem.count({
      where: {
        clubId: F.club.id, workSubtype: CORRECTION_REVIEW_KIND,
        status: { in: ["OPEN", "IN_PROGRESS"] },
      },
    });
    expect(active).toBe(0);
  });

  it("§22-10 no active manager card after REJECTED", async () => {
    const F = await setup("22-10");
    await rejectCorrectionRequest(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      requestId: F.request.id, reviewerNote: "no",
    });
    const active = await db().workIntakeItem.count({
      where: {
        clubId: F.club.id, workSubtype: CORRECTION_REVIEW_KIND,
        status: { in: ["OPEN", "IN_PROGRESS"] },
      },
    });
    expect(active).toBe(0);
  });

  it("§22-11 remediated config-gap + manager approve → all cards RESOLVED", async () => {
    // Set up correction where approver is missing → config-gap card
    // is created. Then remediate (assign approver + rerun) → manager
    // card OPEN + gap RESOLVED. Then manager approves → manager card
    // RESOLVED.
    const club = await makeClub("3D3B-slice5-22-11");
    const events = await makeDept(club.id, "EVENTS", "Events");
    // NO assignApprover initially.
    await makeAdmin(club.id, "admin@t.test");
    const emp = await makeEmp(club.id, "e22-11");
    const assn = await makeAssn(club.id, emp.id, events.id);
    await makePeriod(club.id, "22-11", emp.id);
    const clockIn = await makeClock(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), assn.id);
    await makeClock(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), assn.id);
    const submitted = await submitCorrectionRequest(empPortal(club.id, emp.id), {
      requestType: "CORRECT_CLOCK_IN", originalClockEventId: clockIn.id,
      requestedLocalIso: "2026-09-05T14:15", reason: "adjust", employmentAssignmentId: assn.id,
    });
    // Assign approver + rerun → manager card exists, gap RESOLVED.
    const eMgr = await makeManager(club.id, "events.mgr@t.test");
    await assignApprover(club.id, events.id, eMgr.id);
    const { ensureCorrectionReviewWorkItems } = await import("@/lib/work-intake/correction-review-orchestration");
    await ensureCorrectionReviewWorkItems({ clubId: club.id, correctionRequestId: submitted.request.id });
    // Approve.
    await approveCorrectionRequest(principal(eMgr, club.id, "DEPARTMENT_MANAGER"), club.id, {
      requestId: submitted.request.id, reviewerNote: null,
    });
    const active = await db().workIntakeItem.count({
      where: {
        clubId: club.id,
        workSubtype: { in: [CORRECTION_REVIEW_KIND, CORRECTION_REVIEW_GAP_KIND] },
        status: { in: ["OPEN", "IN_PROGRESS"] },
      },
    });
    expect(active).toBe(0);
  });

  it("§22-12 terminal override while config-gap exists → obsolete gap becomes historical", async () => {
    // No approver → gap card. Payroll Admin uses canonical override
    // to approve. Both the manager review card (which was never
    // created because there was no owner) AND the config-gap should
    // end up non-active.
    const club = await makeClub("3D3B-slice5-22-12");
    const events = await makeDept(club.id, "EVENTS", "Events");
    await makeAdmin(club.id, "admin@t.test");
    const pa = await makePayrollAdmin(club.id, "payroll.admin@t.test");
    const emp = await makeEmp(club.id, "e22-12");
    const assn = await makeAssn(club.id, emp.id, events.id);
    await makePeriod(club.id, "22-12", emp.id);
    const clockIn = await makeClock(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), assn.id);
    await makeClock(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), assn.id);
    const submitted = await submitCorrectionRequest(empPortal(club.id, emp.id), {
      requestType: "CORRECT_CLOCK_IN", originalClockEventId: clockIn.id,
      requestedLocalIso: "2026-09-05T14:15", reason: "adjust", employmentAssignmentId: assn.id,
    });
    // Confirm the gap card exists.
    const gapBefore = await db().workIntakeItem.findFirst({
      where: { clubId: club.id, workSubtype: CORRECTION_REVIEW_GAP_KIND, status: "OPEN" },
    });
    expect(gapBefore).not.toBeNull();
    // Payroll Admin override.
    await approveCorrectionRequest(principal(pa, club.id, "PAYROLL_ADMIN"), club.id, {
      requestId: submitted.request.id, reviewerNote: null,
    });
    // Gap card is no longer active.
    const gapAfter = await db().workIntakeItem.findUnique({ where: { id: gapBefore!.id } });
    expect(gapAfter!.status).toBe("RESOLVED");
    const active = await db().workIntakeItem.count({
      where: {
        clubId: club.id,
        workSubtype: { in: [CORRECTION_REVIEW_KIND, CORRECTION_REVIEW_GAP_KIND] },
        status: { in: ["OPEN", "IN_PROGRESS"] },
      },
    });
    expect(active).toBe(0);
  });

  it("§22-13 approve-vs-reject concurrency → exactly one decision + one WI resolution", async () => {
    const F = await setup("22-13");
    const p = principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER");
    const [a, b] = await Promise.all([
      approveCorrectionRequest(p, F.club.id, { requestId: F.request.id, reviewerNote: null })
        .then(() => "approve").catch((e) => `err:${(e as Error).name}`),
      rejectCorrectionRequest(p, F.club.id, { requestId: F.request.id, reviewerNote: "no" })
        .then(() => "reject").catch((e) => `err:${(e as Error).name}`),
    ]);
    const winners = [a, b].filter((r) => r === "approve" || r === "reject");
    const losers = [a, b].filter((r) => r.startsWith("err:"));
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    // Exactly one WorkCompletionEvent.
    const evts = await db().workCompletionEvent.findMany({
      where: { workIntakeItemId: F.workIntakeItemId },
    });
    expect(evts).toHaveLength(1);
    // Exactly one active card gone.
    const wi = await db().workIntakeItem.findUnique({ where: { id: F.workIntakeItemId } });
    expect(wi!.status).toBe("RESOLVED");
  });

  it("§22-14 double-approve concurrency → one ADMIN_CORRECTION + one WI resolution", async () => {
    const F = await setup("22-14");
    const p = principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER");
    const [a, b] = await Promise.all([
      approveCorrectionRequest(p, F.club.id, { requestId: F.request.id, reviewerNote: null })
        .then(() => true).catch(() => false),
      approveCorrectionRequest(p, F.club.id, { requestId: F.request.id, reviewerNote: null })
        .then(() => true).catch(() => false),
    ]);
    const winners = [a, b].filter(Boolean).length;
    expect(winners).toBe(1);
    const adminCorrEvents = await db().timeClockEvent.count({
      where: { clubId: F.club.id, source: "ADMIN_CORRECTION" },
    });
    expect(adminCorrEvents).toBe(1);
    const completionEvents = await db().workCompletionEvent.findMany({
      where: { workIntakeItemId: F.workIntakeItemId },
    });
    expect(completionEvents).toHaveLength(1);
  });

  it("§22-15 decision with missing WI — domain succeeds, no card recreated after", async () => {
    const F = await setup("22-15");
    // Manually delete the WI + origin to simulate the recovery case.
    await db().workIntakeOrigin.deleteMany({ where: { workIntakeItemId: F.workIntakeItemId } });
    await db().workIntakeItem.delete({ where: { id: F.workIntakeItemId } });
    // Canonical approve still succeeds.
    await approveCorrectionRequest(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      requestId: F.request.id, reviewerNote: null,
    });
    const corr = await db().timeClockCorrectionRequest.findUnique({ where: { id: F.request.id } });
    expect(corr!.status).toBe("APPROVED");
    // No active card recreated (correction is terminal, ensure short-circuits before creating).
    const active = await db().workIntakeItem.count({
      where: {
        clubId: F.club.id, workSubtype: CORRECTION_REVIEW_KIND,
        status: { in: ["OPEN", "IN_PROGRESS"] },
      },
    });
    expect(active).toBe(0);
  });

  it("§22-16 decision with already-RESOLVED WI via detailed workspace → no duplicate activity", async () => {
    const F = await setup("22-16");
    // Pre-resolve the WI to model a stale state.
    await db().workIntakeItem.update({
      where: { id: F.workIntakeItemId },
      data: { status: "RESOLVED", resolvedAt: new Date(), resolvedByUserId: F.eMgr.id },
    });
    // Canonical approve (direct workspace path) — the domain service
    // is authoritative and permits the decision.
    await approveCorrectionRequest(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      requestId: F.request.id, reviewerNote: null,
    });
    const wi = await db().workIntakeItem.findUnique({ where: { id: F.workIntakeItemId } });
    expect(wi!.status).toBe("RESOLVED");
    // Because the item was already RESOLVED, the terminal-resolver
    // skipped the completion emit — no duplicate WorkCompletionEvent.
    const evts = await db().workCompletionEvent.findMany({
      where: { workIntakeItemId: F.workIntakeItemId },
    });
    expect(evts).toHaveLength(0);
  });

  it("§22-17 responsibility changed before decision → resolvedByUserId is actual decider", async () => {
    const F = await setup("22-17");
    // Reassign to a new manager BEFORE the decision.
    const mgrB = await makeManager(F.club.id, "events.mgr2@t.test");
    await assignApprover(F.club.id, F.events.id, mgrB.id);
    // New manager approves.
    await approveCorrectionRequest(principal(mgrB, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      requestId: F.request.id, reviewerNote: null,
    });
    const wi = await db().workIntakeItem.findUnique({ where: { id: F.workIntakeItemId } });
    expect(wi!.status).toBe("RESOLVED");
    // resolvedByUserId is Manager B (actual decider), not Manager A (original owner).
    expect(wi!.resolvedByUserId).toBe(mgrB.id);
    const evts = await db().workCompletionEvent.findMany({
      where: { workIntakeItemId: F.workIntakeItemId },
    });
    expect(evts[0].completedByUserId).toBe(mgrB.id);
  });

  it("§22-18 correction approval → correction WI resolves + timesheet-approval WI proactively appears", async () => {
    const F = await setup("22-18");
    // Materialise the timesheet so PayrollTimesheet exists (Slice 3
    // wires proactive scope WI on materialise, but the fixture's
    // submitCorrection doesn't materialise). This mirrors the natural
    // real-world sequence.
    await materializeEmployeeTimesheet(F.club.id, F.emp.id, F.period.id);
    // Approve.
    await approveCorrectionRequest(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      requestId: F.request.id, reviewerNote: null,
    });
    // Correction card RESOLVED.
    const corrWi = await db().workIntakeItem.findUnique({ where: { id: F.workIntakeItemId } });
    expect(corrWi!.status).toBe("RESOLVED");
    // Timesheet-approval WI now exists (from Slice 3 post-materialise
    // orchestration triggered inside approveCorrectionRequest's own
    // materializeEmployeeTimesheet call).
    const scopeWi = await db().workIntakeItem.findFirst({
      where: { clubId: F.club.id, workSubtype: "TIMESHEET_APPROVAL", status: "OPEN" },
    });
    expect(scopeWi).not.toBeNull();
    expect(scopeWi!.ownerUserId).toBe(F.eMgr.id);
  });

  it("§22-19 rejection → correction WI resolves + scope orchestration recalculates", async () => {
    const F = await setup("22-19");
    await materializeEmployeeTimesheet(F.club.id, F.emp.id, F.period.id);
    await rejectCorrectionRequest(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      requestId: F.request.id, reviewerNote: "no",
    });
    const corrWi = await db().workIntakeItem.findUnique({ where: { id: F.workIntakeItemId } });
    expect(corrWi!.status).toBe("RESOLVED");
    // Rejection unblocks the scope (pendingCorrectionCount goes to 0).
    // Slice 3 post-reject orchestration creates the approval WI.
    const scopeWi = await db().workIntakeItem.findFirst({
      where: { clubId: F.club.id, workSubtype: "TIMESHEET_APPROVAL", status: "OPEN" },
    });
    expect(scopeWi).not.toBeNull();
  });

  it("§22-21/22/23 no PayrollApprovedTimeEntry / PayrollBatch / JournalEntry side effects", async () => {
    const F = await setup("22-21");
    await approveCorrectionRequest(principal(F.eMgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      requestId: F.request.id, reviewerNote: null,
    });
    expect(await db().payrollApprovedTimeEntry.count({ where: { clubId: F.club.id } })).toBe(0);
    expect(await db().payrollBatch.count({ where: { clubId: F.club.id } })).toBe(0);
    expect(await db().journalEntry.count({ where: { clubId: F.club.id } })).toBe(0);
  });
});
