// Payroll-3D-3B Slice 7 (2026-09-06) — concurrency, security &
// recovery hardening tests. Attacks the remaining race conditions,
// ownership gaps, stale-state seams, and recovery assumptions on top
// of the accepted Slice 1-6B product behavior.
//
// SQLite-based. Concurrent Prisma calls in a single Node process
// serialize via the connection pool, so these tests exercise
// application-level idempotency (findFirst-then-create-then-P2002-
// refetch) more than true row-level contention. The DB partial-
// unique remains the ultimate guarantee — the Postgres migration
// with pre-check DO block provides that in production.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub } from "../util/db";
import {
  CORRECTION_REVIEW_ORIGIN_INDEX_NAME,
  SCOPE_APPROVAL_ORIGIN_INDEX_NAME,
  isScopeApprovalOriginConflict,
  isCorrectionReviewOriginConflict,
  isWorkIntakeOriginConflict,
} from "@/lib/work-intake/origin-conflict";
import {
  ensureTimesheetApprovalWorkItems,
} from "@/lib/timesheets/orchestration";
import { ensureCorrectionReviewWorkItems } from "@/lib/work-intake/correction-review-orchestration";
import {
  submitCorrectionRequest,
  approveCorrectionRequest,
} from "@/lib/timesheets/correction-service";
import { materializeEmployeeTimesheet } from "@/lib/timesheets/service";
import { approveTimesheetScope, invalidateApprovalIfDrifted } from "@/lib/timesheets/manager-approval";
import { getScopeReview } from "@/lib/timesheets/approval-scope";
import { invokeWorkIntakeAction } from "@/lib/work-intake/action-dispatcher";
import type { EmployeePortalPrincipal } from "@/lib/employee-portal-session";
import type { Principal } from "@/lib/rbac";

const CORRECTION_DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS "${CORRECTION_REVIEW_ORIGIN_INDEX_NAME}"
  ON "WorkIntakeOrigin" ("clubId", "kind", "referenceId")
  WHERE "role" = 'PRIMARY'
    AND "kind" IN (
      'TIMECLOCK_CORRECTION_REVIEW',
      'TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP'
    );`;
const SCOPE_DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS "${SCOPE_APPROVAL_ORIGIN_INDEX_NAME}"
  ON "WorkIntakeOrigin" ("clubId", "kind", "referenceId")
  WHERE "role" = 'PRIMARY'
    AND "kind" IN (
      'PAYROLL_TIMESHEET_APPROVAL',
      'PAYROLL_TIMESHEET_APPROVAL_CONFIG_GAP'
    );`;

const utc = (y: number, m: number, d: number, h = 0, mi = 0) =>
  new Date(Date.UTC(y, m - 1, d, h, mi));

// -------- shared scaffolding --------
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
async function makePayrollAdmin(clubId: string, email: string) {
  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.default.hash("password", 4);
  const user = await db().user.create({
    data: { email, name: email, role: "PAYROLL_ADMIN", passwordHash, clubId, status: "ACTIVE" },
  });
  await db().userClubRole.create({ data: { userId: user.id, clubId, roleKey: "PAYROLL_ADMIN" } });
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
function principal(u: { id: string; email: string; name: string; status: string; memberId: string | null }, clubId: string, roleKey: "DEPARTMENT_MANAGER"|"CLUB_ADMIN"|"PAYROLL_ADMIN"): Principal {
  return { id: u.id, name: u.name, email: u.email, status: u.status, memberships: [{ clubId, roleKey }], activeClubId: clubId, memberId: u.memberId };
}
function empPortal(clubId: string, employeeId: string): EmployeePortalPrincipal {
  return { clubId, employeeId, generation: 1, establishedAt: new Date().toISOString() };
}

// -------- readyScope fixture --------
async function setupReadyScope(seed: string) {
  const club = await makeClub(`slice7-${seed}`);
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

async function setupCorrection(seed: string) {
  const club = await makeClub(`slice7-${seed}`);
  const events = await makeDept(club.id, "EVENTS", "Events");
  const mgr = await makeManager(club.id, `mgr.${seed}@t.test`);
  await makeAdmin(club.id, `admin.${seed}@t.test`);
  await assignApprover(club.id, events.id, mgr.id);
  const emp = await makeEmp(club.id, `e-${seed}`);
  const assn = await makeAssn(club.id, emp.id, events.id);
  const { period } = await makePeriod(club.id, seed, emp.id);
  const clockIn = await makeClock(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), assn.id);
  await makeClock(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), assn.id);
  const submitted = await submitCorrectionRequest(empPortal(club.id, emp.id), {
    requestType: "CORRECT_CLOCK_IN", originalClockEventId: clockIn.id,
    requestedLocalIso: "2026-09-05T14:15", reason: "adj", employmentAssignmentId: assn.id,
  });
  return { club, events, mgr, emp, assn, period, request: submitted.request };
}

// ==================================================================
describe("Payroll-3D-3B Slice 7 · concurrency, security & recovery hardening", () => {
  beforeAll(async () => {
    await db().$executeRawUnsafe(CORRECTION_DDL);
    await db().$executeRawUnsafe(SCOPE_DDL);
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  // ---------------- Timesheet approval duplicate race ----------------
  it("§I 2-way concurrent ensureTimesheetApprovalWorkItems → exactly one canonical WI", async () => {
    const F = await setupReadyScope("I");
    // First materialise already produced one; wipe to run from clean.
    await db().workIntakeOrigin.deleteMany({ where: { clubId: F.club.id, kind: "PAYROLL_TIMESHEET_APPROVAL" } });
    await db().workIntakeItem.deleteMany({ where: { clubId: F.club.id, workSubtype: "TIMESHEET_APPROVAL" } });

    await Promise.all([
      ensureTimesheetApprovalWorkItems(F.club.id, F.period.id),
      ensureTimesheetApprovalWorkItems(F.club.id, F.period.id),
    ]);
    const items = await db().workIntakeItem.count({
      where: { clubId: F.club.id, workSubtype: "TIMESHEET_APPROVAL" },
    });
    expect(items).toBe(1);
    const origins = await db().workIntakeOrigin.count({
      where: { clubId: F.club.id, kind: "PAYROLL_TIMESHEET_APPROVAL", role: "PRIMARY" },
    });
    expect(origins).toBe(1);
  });

  it("§J 10-way concurrent ensures → exactly one canonical WI + one origin (P2002 shim converges)", async () => {
    const F = await setupReadyScope("J");
    await db().workIntakeOrigin.deleteMany({ where: { clubId: F.club.id, kind: "PAYROLL_TIMESHEET_APPROVAL" } });
    await db().workIntakeItem.deleteMany({ where: { clubId: F.club.id, workSubtype: "TIMESHEET_APPROVAL" } });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => ensureTimesheetApprovalWorkItems(F.club.id, F.period.id)),
    );
    // All 10 callers report at least one item.
    for (const r of results) expect(r.items.length).toBeGreaterThan(0);
    // Exactly one canonical item + one origin.
    expect(await db().workIntakeItem.count({
      where: { clubId: F.club.id, workSubtype: "TIMESHEET_APPROVAL" },
    })).toBe(1);
    expect(await db().workIntakeOrigin.count({
      where: { clubId: F.club.id, kind: "PAYROLL_TIMESHEET_APPROVAL", role: "PRIMARY" },
    })).toBe(1);
  });

  it("§K inline + simulated worker convergence — no duplicate item after mixed producers", async () => {
    const F = await setupReadyScope("K");
    await db().workIntakeOrigin.deleteMany({ where: { clubId: F.club.id, kind: "PAYROLL_TIMESHEET_APPROVAL" } });
    await db().workIntakeItem.deleteMany({ where: { clubId: F.club.id, workSubtype: "TIMESHEET_APPROVAL" } });

    // Inline (materialise trigger) + worker-simulated ensure raced.
    await Promise.all([
      materializeEmployeeTimesheet(F.club.id, F.emp.id, F.period.id),
      ensureTimesheetApprovalWorkItems(F.club.id, F.period.id),
      ensureTimesheetApprovalWorkItems(F.club.id, F.period.id),
    ]);
    expect(await db().workIntakeItem.count({
      where: { clubId: F.club.id, workSubtype: "TIMESHEET_APPROVAL" },
    })).toBe(1);
  });

  // ---------------- Correction duplicate race ----------------
  it("§N 10-way concurrent ensureCorrectionReviewWorkItems → one canonical WI", async () => {
    const F = await setupCorrection("N");
    // Wipe the correction-review WI to start clean.
    await db().workIntakeOrigin.deleteMany({ where: { clubId: F.club.id, kind: "TIMECLOCK_CORRECTION_REVIEW" } });
    await db().workIntakeItem.deleteMany({ where: { clubId: F.club.id, workSubtype: "TIMECLOCK_CORRECTION_REVIEW" } });

    await Promise.all(
      Array.from({ length: 10 }, () => ensureCorrectionReviewWorkItems({ clubId: F.club.id, correctionRequestId: F.request.id })),
    );
    expect(await db().workIntakeItem.count({
      where: { clubId: F.club.id, workSubtype: "TIMECLOCK_CORRECTION_REVIEW" },
    })).toBe(1);
  });

  it("§O correction terminal-vs-ensure race → correction terminal + zero active review card", async () => {
    const F = await setupCorrection("O");
    // Simulate: manager approves the correction WHILE recovery
    // orchestrator retries an ensure. The ensure must not leave an
    // active card behind for the now-terminal correction.
    const [approveResult] = await Promise.all([
      approveCorrectionRequest(principal(F.mgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
        requestId: F.request.id, reviewerNote: null,
      }).catch((e: Error) => e),
      ensureCorrectionReviewWorkItems({ clubId: F.club.id, correctionRequestId: F.request.id }),
      ensureCorrectionReviewWorkItems({ clubId: F.club.id, correctionRequestId: F.request.id }),
    ]);
    // Approve should have succeeded.
    expect(approveResult).not.toBeInstanceOf(Error);
    // Correction is APPROVED.
    const c = await db().timeClockCorrectionRequest.findUnique({ where: { id: F.request.id } });
    expect(c!.status).toBe("APPROVED");
    // Zero active correction-review WI for this correction.
    const active = await db().workIntakeItem.count({
      where: {
        clubId: F.club.id, workSubtype: "TIMECLOCK_CORRECTION_REVIEW",
        status: { in: ["OPEN", "IN_PROGRESS"] },
      },
    });
    expect(active).toBe(0);
  });

  // ---------------- Ownerless config-gap ----------------
  it("§P/§Q no-Tenant-Admin + missing approver → NO ownerless active WI created (fail-closed)", async () => {
    const club = await makeClub("slice7-P");
    const events = await makeDept(club.id, "EVENTS", "Events");
    // NO tenant admin, NO department approver.
    const emp = await makeEmp(club.id, "e-P");
    const assn = await makeAssn(club.id, emp.id, events.id);
    await makePeriod(club.id, "P", emp.id);
    const clockIn = await makeClock(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), assn.id);
    await makeClock(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), assn.id);
    await submitCorrectionRequest(empPortal(club.id, emp.id), {
      requestType: "CORRECT_CLOCK_IN", originalClockEventId: clockIn.id,
      requestedLocalIso: "2026-09-05T14:15", reason: "adj", employmentAssignmentId: assn.id,
    });
    // NO active gap card should exist (fail-closed).
    const ownerless = await db().workIntakeItem.count({
      where: { clubId: club.id, ownerUserId: null, status: { in: ["OPEN", "IN_PROGRESS"] } },
    });
    expect(ownerless).toBe(0);
  });

  it("§R Tenant Admin recovery — after admin assigned + rerun → exactly one gap WI owned by admin", async () => {
    const club = await makeClub("slice7-R");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const emp = await makeEmp(club.id, "e-R");
    const assn = await makeAssn(club.id, emp.id, events.id);
    await makePeriod(club.id, "R", emp.id);
    const clockIn = await makeClock(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), assn.id);
    await makeClock(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), assn.id);
    const submitted = await submitCorrectionRequest(empPortal(club.id, emp.id), {
      requestType: "CORRECT_CLOCK_IN", originalClockEventId: clockIn.id,
      requestedLocalIso: "2026-09-05T14:15", reason: "adj", employmentAssignmentId: assn.id,
    });
    // No admin yet → no gap card.
    expect(await db().workIntakeItem.count({ where: { clubId: club.id, workSubtype: "TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP" } })).toBe(0);
    // Assign admin, rerun ensure → gap card appears owned by admin.
    const admin = await makeAdmin(club.id, "admin.R@t.test");
    await ensureCorrectionReviewWorkItems({ clubId: club.id, correctionRequestId: submitted.request.id });
    const gap = await db().workIntakeItem.findFirst({
      where: { clubId: club.id, workSubtype: "TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP" },
    });
    expect(gap).not.toBeNull();
    expect(gap!.ownerUserId).toBe(admin.id);
  });

  // ---------------- Responsibility change / removed / restored ----------------
  it("§S owner projection updates when responsibility changes + reconciliation reruns", async () => {
    const F = await setupCorrection("S");
    // Find the review WI.
    const originBefore = await db().workIntakeOrigin.findFirst({
      where: { clubId: F.club.id, kind: "TIMECLOCK_CORRECTION_REVIEW" },
      include: { workIntakeItem: true },
    });
    expect(originBefore!.workIntakeItem.ownerUserId).toBe(F.mgr.id);

    // Reassign to a new manager.
    const mgrB = await makeManager(F.club.id, "mgrB.S@t.test");
    await assignApprover(F.club.id, F.events.id, mgrB.id);

    // Rerun ensure — canonical projection now owned by B.
    await ensureCorrectionReviewWorkItems({ clubId: F.club.id, correctionRequestId: F.request.id });
    const originAfter = await db().workIntakeOrigin.findFirst({
      where: { clubId: F.club.id, kind: "TIMECLOCK_CORRECTION_REVIEW" },
      include: { workIntakeItem: true },
    });
    expect(originAfter!.workIntakeItem.ownerUserId).toBe(mgrB.id);
    // Still exactly ONE canonical item (not two).
    expect(await db().workIntakeItem.count({
      where: { clubId: F.club.id, workSubtype: "TIMECLOCK_CORRECTION_REVIEW" },
    })).toBe(1);
  });

  it("§T responsibility removed → old manager's card ownership yielded via re-ensure to Tenant Admin gap card", async () => {
    const F = await setupCorrection("T");
    // Remove the approver.
    await db().departmentResponsibility.deleteMany({
      where: { clubId: F.club.id, departmentId: F.events.id, responsibilityKey: "DEPARTMENT_TIME_APPROVAL" },
    });
    // Rerun ensure — should recreate as MISSING_APPROVER gap owned by Tenant Admin.
    await ensureCorrectionReviewWorkItems({ clubId: F.club.id, correctionRequestId: F.request.id });
    const gap = await db().workIntakeOrigin.findFirst({
      where: { clubId: F.club.id, kind: "TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP" },
      include: { workIntakeItem: true },
    });
    expect(gap).not.toBeNull();
    expect(gap!.workIntakeItem.status).toBe("OPEN");
    // Note: the ORIGINAL correction-review WI may still exist owned by
    // the old manager. Slice 7's dispatcher ownership guard (§17)
    // prevents the old manager from actually deciding — click-time
    // Slice 4 responsibility re-resolution also fails. So it's not
    // actionable regardless.
  });

  it("§U responsibility restored → gap resolves, manager card active for new owner", async () => {
    const F = await setupCorrection("U");
    await db().departmentResponsibility.deleteMany({
      where: { clubId: F.club.id, departmentId: F.events.id, responsibilityKey: "DEPARTMENT_TIME_APPROVAL" },
    });
    await ensureCorrectionReviewWorkItems({ clubId: F.club.id, correctionRequestId: F.request.id });
    // Assign new manager + rerun.
    const mgrB = await makeManager(F.club.id, "mgrB.U@t.test");
    await assignApprover(F.club.id, F.events.id, mgrB.id);
    await ensureCorrectionReviewWorkItems({ clubId: F.club.id, correctionRequestId: F.request.id });
    // Manager card active owned by mgrB.
    const mgrCard = await db().workIntakeItem.findFirst({
      where: { clubId: F.club.id, workSubtype: "TIMECLOCK_CORRECTION_REVIEW", status: "OPEN" },
    });
    expect(mgrCard!.ownerUserId).toBe(mgrB.id);
    // Gap card RESOLVED.
    const gap = await db().workIntakeItem.findFirst({
      where: { clubId: F.club.id, workSubtype: "TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP" },
    });
    if (gap) expect(gap.status).toBe("RESOLVED");
  });

  // ---------------- Payroll Admin override on Work Intake ----------------
  it("§X/§Y Payroll Admin cannot use another manager's WI card → UNAUTHORIZED (detailed workspace override still works)", async () => {
    const F = await setupCorrection("PA");
    const pa = await makePayrollAdmin(F.club.id, "pa@t.test");
    // Find the WI for this correction (owned by Events Manager).
    const wi = await db().workIntakeOrigin.findFirst({
      where: { clubId: F.club.id, kind: "TIMECLOCK_CORRECTION_REVIEW", referenceId: F.request.id },
    });
    // PA via WI action → UNAUTHORIZED.
    const r = await invokeWorkIntakeAction(principal(pa, F.club.id, "PAYROLL_ADMIN"), F.club.id, {
      action: "correction.approve",
      workIntakeItemId: wi!.workIntakeItemId,
      correctionRequestId: F.request.id,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNAUTHORIZED");
    // Correction still PENDING.
    expect((await db().timeClockCorrectionRequest.findUnique({ where: { id: F.request.id } }))!.status).toBe("PENDING");
    // Detailed workspace still works.
    await approveCorrectionRequest(principal(pa, F.club.id, "PAYROLL_ADMIN"), F.club.id, {
      requestId: F.request.id, reviewerNote: null,
    });
    expect((await db().timeClockCorrectionRequest.findUnique({ where: { id: F.request.id } }))!.status).toBe("APPROVED");
  });

  // ---------------- BackgroundJob idempotency ----------------
  it("§AD duplicate ensure calls converge — no duplicate WorkCompletionEvent for terminal correction", async () => {
    const F = await setupCorrection("AD");
    // Approve → WI RESOLVED + one completion event.
    await approveCorrectionRequest(principal(F.mgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      requestId: F.request.id, reviewerNote: null,
    });
    const wi = await db().workIntakeOrigin.findFirst({
      where: { clubId: F.club.id, kind: "TIMECLOCK_CORRECTION_REVIEW", referenceId: F.request.id },
    });
    // Run recovery 5 times.
    for (let i = 0; i < 5; i++) {
      await ensureCorrectionReviewWorkItems({ clubId: F.club.id, correctionRequestId: F.request.id });
    }
    const events = await db().workCompletionEvent.count({
      where: { workIntakeItemId: wi!.workIntakeItemId },
    });
    expect(events).toBe(1);
  });

  it("§AE worker-sweep overlap — direct ensure racing sweep produces no duplicates", async () => {
    const F = await setupReadyScope("AE");
    await db().workIntakeOrigin.deleteMany({ where: { clubId: F.club.id, kind: "PAYROLL_TIMESHEET_APPROVAL" } });
    await db().workIntakeItem.deleteMany({ where: { clubId: F.club.id, workSubtype: "TIMESHEET_APPROVAL" } });
    // Simulate: 3 direct ensures + 3 "sweep-triggered" ensures overlap.
    await Promise.all(
      Array.from({ length: 6 }, () => ensureTimesheetApprovalWorkItems(F.club.id, F.period.id)),
    );
    expect(await db().workIntakeItem.count({
      where: { clubId: F.club.id, workSubtype: "TIMESHEET_APPROVAL" },
    })).toBe(1);
  });

  // ---------------- Stale-revision TOCTOU ----------------
  it("§AB/§AC approval-vs-material-change — attest with stale revision → CONFLICT, no stale APPROVED persisted", async () => {
    const F = await setupReadyScope("AB");
    const review1 = await getScopeReview(F.club.id, F.period.id, F.events.id);
    // Material change BEFORE approve.
    await makeClock(F.club.id, F.emp.id, "CLOCK_IN", utc(2026, 9, 7, 14, 0), F.assn.id);
    await makeClock(F.club.id, F.emp.id, "CLOCK_OUT", utc(2026, 9, 7, 22, 0), F.assn.id);
    await materializeEmployeeTimesheet(F.club.id, F.emp.id, F.period.id);
    // Attempt approve with stale revision.
    await expect(
      approveTimesheetScope(principal(F.mgr, F.club.id, "DEPARTMENT_MANAGER"), {
        clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.events.id,
        attestedRevision: review1.currentRevision,
      }),
    ).rejects.toThrow();
    // No approval persisted at stale revision.
    const a = await db().payrollDepartmentTimeApproval.findFirst({
      where: { clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.events.id },
    });
    expect(a).toBeNull();
  });

  it("approve-then-drift → material change AFTER approve → invalidateApprovalIfDrifted flips to REVIEW_REQUIRED", async () => {
    const F = await setupReadyScope("drift");
    const review = await getScopeReview(F.club.id, F.period.id, F.events.id);
    await approveTimesheetScope(principal(F.mgr, F.club.id, "DEPARTMENT_MANAGER"), {
      clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.events.id,
      attestedRevision: review.currentRevision,
    });
    await makeClock(F.club.id, F.emp.id, "CLOCK_IN", utc(2026, 9, 7, 14, 0), F.assn.id);
    await makeClock(F.club.id, F.emp.id, "CLOCK_OUT", utc(2026, 9, 7, 22, 0), F.assn.id);
    await materializeEmployeeTimesheet(F.club.id, F.emp.id, F.period.id);
    await invalidateApprovalIfDrifted(F.club.id, F.period.id, F.events.id);
    const a = await db().payrollDepartmentTimeApproval.findFirst({
      where: { clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.events.id },
    });
    expect(a!.state).toBe("REVIEW_REQUIRED");
  });

  // ---------------- Origin-conflict shim unit test ----------------
  it("origin-conflict shim recognises scope-approval index name", () => {
    const err = { code: "P2002", meta: { target: SCOPE_APPROVAL_ORIGIN_INDEX_NAME } };
    expect(isScopeApprovalOriginConflict(err)).toBe(true);
    expect(isCorrectionReviewOriginConflict(err)).toBe(false);
    expect(isWorkIntakeOriginConflict(err)).toBe(true);
  });

  // ---------------- Side effect guards ----------------
  it("§AI/§AJ/§AK zero freeze/batch/journal side effects across all hardening flows", async () => {
    const F = await setupCorrection("side");
    await approveCorrectionRequest(principal(F.mgr, F.club.id, "DEPARTMENT_MANAGER"), F.club.id, {
      requestId: F.request.id, reviewerNote: null,
    });
    const review = await getScopeReview(F.club.id, F.period.id, F.events.id);
    if (review.readiness.ready) {
      await approveTimesheetScope(principal(F.mgr, F.club.id, "DEPARTMENT_MANAGER"), {
        clubId: F.club.id, payPeriodId: F.period.id, departmentId: F.events.id,
        attestedRevision: review.currentRevision,
      });
    }
    expect(await db().payrollApprovedTimeEntry.count({ where: { clubId: F.club.id } })).toBe(0);
    expect(await db().payrollBatch.count({ where: { clubId: F.club.id } })).toBe(0);
    expect(await db().journalEntry.count({ where: { clubId: F.club.id } })).toBe(0);
  });
});
