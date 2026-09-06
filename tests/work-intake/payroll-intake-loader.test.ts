// Payroll-3D-3B Slice 6 (2026-09-06) — tests for the Mission Control
// payroll-intake loader's rich card projection. The loader assembles
// canonical values server-side so the presentation component
// (PayrollActionCard) can render without recomputing any payroll
// business logic. These tests prove the loader produces the correct
// discriminated-union shape for every supported card kind AND
// preserves the fallback (deep-link only) projection for legacy /
// unrecognised subtypes.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub } from "../util/db";
import { CORRECTION_REVIEW_ORIGIN_INDEX_NAME } from "@/lib/work-intake/origin-conflict";
import { loadPayrollAdminIntakeItems } from "@/lib/mission-control/payroll-intake";
import { materializeEmployeeTimesheet } from "@/lib/timesheets/service";
import { submitCorrectionRequest } from "@/lib/timesheets/correction-service";
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
    data: { clubId, code: `PG-${seed}`, name: `T-${seed}`, payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 5, calendarAnchorDate: utc(2026, 1, 1), active: true },
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
function principal(u: { id: string; email: string; name: string; status: string; memberId: string | null }, clubId: string, roleKey: "DEPARTMENT_MANAGER"|"CLUB_ADMIN"): Principal {
  return { id: u.id, name: u.name, email: u.email, status: u.status, memberships: [{ clubId, roleKey }], activeClubId: clubId, memberId: u.memberId };
}
function empPortal(clubId: string, employeeId: string): EmployeePortalPrincipal {
  return { clubId, employeeId, generation: 1, establishedAt: new Date().toISOString() };
}

describe("Payroll-3D-3B Slice 6 · payroll-intake loader (rich card projection)", () => {
  beforeAll(async () => {
    await db().$executeRawUnsafe(DDL);
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("correction card projection carries employee / department / correction type / times / reason", async () => {
    const club = await makeClub("3D3B-slice6-corr");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const eMgr = await makeManager(club.id, "events.mgr@t.test");
    await assignApprover(club.id, events.id, eMgr.id);
    const emp = await makeEmp(club.id, "e-corr");
    const assn = await makeAssn(club.id, emp.id, events.id);
    await makePeriod(club.id, "corr", emp.id);
    const clockIn = await makeClock(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), assn.id);
    await makeClock(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), assn.id);
    await submitCorrectionRequest(empPortal(club.id, emp.id), {
      requestType: "CORRECT_CLOCK_IN", originalClockEventId: clockIn.id,
      requestedLocalIso: "2026-09-05T14:15", reason: "Rounded to top of the hour by mistake.",
      employmentAssignmentId: assn.id,
    });

    const items = await loadPayrollAdminIntakeItems({
      principal: principal(eMgr, club.id, "DEPARTMENT_MANAGER"),
      clubId: club.id, now: new Date(),
    });
    expect(items).toHaveLength(1);
    const card = items[0].payrollCard;
    expect(card).toBeDefined();
    expect(card!.kind).toBe("correction");
    if (card && card.kind === "correction") {
      expect(card.employeeName).toContain("Taylor");
      expect(card.departmentName).toBe("Events");
      expect(card.correctionTypeLabel).toBe("Correct Clock In");
      expect(card.originalTimeLabel).toContain("Clocked in at 14:00");
      expect(card.requestedTimeLabel).toBe("14:15");
      expect(card.reason).toContain("Rounded");
      // Slice 6A — deep-link now uses payPeriodId + departmentId
      // (the params the workspace page actually consumes) instead of
      // the unread correctionRequestId. Verify both params present.
      expect(card.deepLink).not.toBeNull();
      expect(card.deepLink!.href).toContain("payPeriodId=");
      expect(card.deepLink!.href).toContain("departmentId=");
      expect(card.deepLink!.href).toContain("scope=timesheet");
    }
  });

  it("scope card projection carries readiness + revision + blockers", async () => {
    const club = await makeClub("3D3B-slice6-scope");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const eMgr = await makeManager(club.id, "events.mgr@t.test");
    await assignApprover(club.id, events.id, eMgr.id);
    const emp = await makeEmp(club.id, "e-scope");
    const assn = await makeAssn(club.id, emp.id, events.id);
    const { period } = await makePeriod(club.id, "scope", emp.id);
    await makeClock(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), assn.id);
    await makeClock(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), assn.id);
    await materializeEmployeeTimesheet(club.id, emp.id, period.id);

    const items = await loadPayrollAdminIntakeItems({
      principal: principal(eMgr, club.id, "DEPARTMENT_MANAGER"),
      clubId: club.id, now: new Date(),
    });
    const scopeItem = items.find((i) => i.payrollCard?.kind === "scope");
    expect(scopeItem).toBeDefined();
    const card = scopeItem!.payrollCard;
    if (card && card.kind === "scope") {
      expect(card.departmentName).toBe("Events");
      expect(card.readinessReady).toBe(true);
      expect(card.blockers).toEqual([]);
      expect(card.currentRevision).toBeTruthy();
      expect(card.recordedHours).toBeCloseTo(8, 1);
      expect(card.employeeCount).toBe(1);
    }
  });

  it("blocked scope card carries humanised blocker copy (no enum leakage)", async () => {
    const club = await makeClub("3D3B-slice6-blocked");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const eMgr = await makeManager(club.id, "events.mgr@t.test");
    await assignApprover(club.id, events.id, eMgr.id);
    const emp = await makeEmp(club.id, "e-block");
    const assn = await makeAssn(club.id, emp.id, events.id);
    const { period } = await makePeriod(club.id, "block", emp.id);
    const clockIn = await makeClock(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), assn.id);
    await makeClock(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), assn.id);
    await materializeEmployeeTimesheet(club.id, emp.id, period.id);
    // Submit a PENDING correction so the scope is blocked.
    await submitCorrectionRequest(empPortal(club.id, emp.id), {
      requestType: "CORRECT_CLOCK_IN", originalClockEventId: clockIn.id,
      requestedLocalIso: "2026-09-05T14:15", reason: "adjust",
      employmentAssignmentId: assn.id,
    });

    const items = await loadPayrollAdminIntakeItems({
      principal: principal(eMgr, club.id, "DEPARTMENT_MANAGER"),
      clubId: club.id, now: new Date(),
    });
    const scope = items.find((i) => i.payrollCard?.kind === "scope");
    expect(scope).toBeDefined();
    const card = scope!.payrollCard;
    if (card && card.kind === "scope") {
      expect(card.readinessReady).toBe(false);
      expect(card.blockers.length).toBeGreaterThan(0);
      // No enum name leakage.
      for (const b of card.blockers) {
        expect(b).not.toContain("PENDING_CORRECTION");
        expect(b).not.toContain("MISSING_CLOCK_OUT");
      }
      // Human copy for the correction blocker.
      expect(card.blockers.some((b) => b.toLowerCase().includes("correction"))).toBe(true);
    }
  });

  it("correction-gap MISSING_APPROVER card projects gap reason + department + employee", async () => {
    const club = await makeClub("3D3B-slice6-gap");
    const events = await makeDept(club.id, "EVENTS", "Events");
    // NO approver.
    const admin = await makeAdmin(club.id, "admin@t.test");
    const emp = await makeEmp(club.id, "e-gap");
    const assn = await makeAssn(club.id, emp.id, events.id);
    await makePeriod(club.id, "gap", emp.id);
    const clockIn = await makeClock(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), assn.id);
    await makeClock(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), assn.id);
    await submitCorrectionRequest(empPortal(club.id, emp.id), {
      requestType: "CORRECT_CLOCK_IN", originalClockEventId: clockIn.id,
      requestedLocalIso: "2026-09-05T14:15", reason: "adjust",
      employmentAssignmentId: assn.id,
    });

    const items = await loadPayrollAdminIntakeItems({
      principal: principal(admin, club.id, "CLUB_ADMIN"),
      clubId: club.id, now: new Date(),
    });
    const gap = items.find((i) => i.payrollCard?.kind === "correction-gap");
    expect(gap).toBeDefined();
    const card = gap!.payrollCard;
    if (card && card.kind === "correction-gap") {
      expect(card.gapReason).toBe("MISSING_APPROVER");
      expect(card.departmentName).toBe("Events");
      expect(card.employeeName).toContain("Taylor");
      expect(card.deepLink).not.toBeNull();
      expect(card.deepLink!.href).toContain("/app/admin/settings/time-approvers");
    }
  });

  it("correction-gap MISSING_ASSIGNMENT card projects correctly", async () => {
    const club = await makeClub("3D3B-slice6-gap2");
    const admin = await makeAdmin(club.id, "admin@t.test");
    const emp = await makeEmp(club.id, "e-gap2");
    await makePeriod(club.id, "gap2", emp.id);
    const clockIn = await makeClock(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), null);
    await makeClock(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), null);
    await submitCorrectionRequest(empPortal(club.id, emp.id), {
      requestType: "CORRECT_CLOCK_IN", originalClockEventId: clockIn.id,
      requestedLocalIso: "2026-09-05T14:15", reason: "adjust",
      employmentAssignmentId: null,
    });
    const items = await loadPayrollAdminIntakeItems({
      principal: principal(admin, club.id, "CLUB_ADMIN"),
      clubId: club.id, now: new Date(),
    });
    const gap = items.find((i) => i.payrollCard?.kind === "correction-gap");
    expect(gap).toBeDefined();
    const card = gap!.payrollCard;
    if (card && card.kind === "correction-gap") {
      expect(card.gapReason).toBe("MISSING_ASSIGNMENT");
      expect(card.employeeName).toContain("Taylor");
    }
  });

  it("legacy payroll subtype without rich context (PAYROLL_ADMIN_PROCESSING) falls through to FeedItem shape", async () => {
    // Simulate a legacy card by inserting one directly. The loader
    // should NOT attach payrollCard for this kind.
    const club = await makeClub("3D3B-slice6-legacy");
    const admin = await makeAdmin(club.id, "admin@t.test");
    const item = await db().workIntakeItem.create({
      data: {
        clubId: club.id, status: "OPEN", ownerUserId: admin.id,
        workDomain: "PAYROLL", workIntent: "REVIEW", workSubtype: "PAYROLL_ADMIN_PROCESSING",
        classification: "PAYROLL_ADMIN_PROCESSING",
        displaySourceLabel: "payroll", displaySender: "system",
        displaySubject: "Legacy — payroll processing",
        displayPreview: "", displayReceivedAt: new Date(),
      },
    });
    await db().workIntakeOrigin.create({
      data: {
        clubId: club.id, workIntakeItemId: item.id,
        kind: "PAYROLL_ADMIN_PROCESSING", referenceId: "some-period-id", role: "PRIMARY",
      },
    });
    const items = await loadPayrollAdminIntakeItems({
      principal: principal(admin, club.id, "CLUB_ADMIN"),
      clubId: club.id, now: new Date(),
    });
    expect(items).toHaveLength(1);
    expect(items[0].payrollCard).toBeUndefined();
    // FeedItem-style primary action still present (deep-link).
    expect(items[0].actions.some((a) => a.kind === "primary")).toBe(true);
  });
});
