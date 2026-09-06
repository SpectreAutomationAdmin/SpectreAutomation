// Payroll-3D-3A (2026-09-05) — Tenant Admin department-responsibility
// assignment service tests. Covers eligibility (§12), tenant / active
// / capability validation (§16-§18), audit (§13), and concurrency (§15).

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import {
  assignDepartmentTimeApprover,
  listDepartmentApprovers,
  listEligibleTimesheetApprovers,
} from "@/lib/tenant-admin/department-responsibilities";
import { ensureTimesheetApprovalWorkItems } from "@/lib/timesheets/orchestration";
import { materializeEmployeeTimesheet } from "@/lib/timesheets/service";

const utc = (y: number, m: number, d: number, h = 0, mi = 0) =>
  new Date(Date.UTC(y, m - 1, d, h, mi));

let seedCounter = 0;
async function scenario() {
  seedCounter += 1;
  const suffix = `${seedCounter}-${Math.floor(Math.random() * 1_000_000)}`;
  const clubA = await makeClub(`3D3A-A-${suffix}`);
  const clubB = await makeClub(`3D3A-B-${suffix}`);
  const grounds = await db().department.create({
    data: { clubId: clubA.id, code: `GROUNDS-${suffix}`, name: "Grounds", sortOrder: 1 },
  });
  const banquets = await db().department.create({
    data: { clubId: clubA.id, code: `BANQUETS-${suffix}`, name: "Banquets", sortOrder: 2 },
  });
  const tenantAdmin = await makeUser({ email: `ta-${suffix}@t.test`, role: "CLUB_ADMIN", clubId: clubA.id });
  const staffOnly = await makeUser({ email: `staff-${suffix}@t.test`, role: "STAFF", clubId: clubA.id });
  const activeMgr = await makeUser({ email: `mgr-${suffix}@t.test`, role: "DEPARTMENT_MANAGER", clubId: clubA.id });
  const inactiveMgr = await makeUser({ email: `imgr-${suffix}@t.test`, role: "DEPARTMENT_MANAGER", clubId: clubA.id });
  await db().user.update({ where: { id: inactiveMgr.id }, data: { status: "SUSPENDED" } });
  const otherTenantMgr = await makeUser({ email: `omgr-${suffix}@t.test`, role: "DEPARTMENT_MANAGER", clubId: clubB.id });
  return { clubA, clubB, grounds, banquets, tenantAdmin, staffOnly, activeMgr, inactiveMgr, otherTenantMgr };
}

// ==================================================================
// Eligibility (§12, §18)
// ==================================================================
describe("Payroll-3D-3A · listEligibleTimesheetApprovers", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("returns only ACTIVE users with payroll:timesheets:approve at THIS club", async () => {
    const s = await scenario();
    const p = await principalFor(s.tenantAdmin.email);
    const rows = await listEligibleTimesheetApprovers(p, s.clubA.id);
    const ids = rows.map((r) => r.id);
    // CLUB_ADMIN and DEPARTMENT_MANAGER hold the capability. STAFF does not.
    expect(ids).toContain(s.tenantAdmin.id);
    expect(ids).toContain(s.activeMgr.id);
    expect(ids).not.toContain(s.staffOnly.id);
    // Inactive user excluded.
    expect(ids).not.toContain(s.inactiveMgr.id);
    // Other-tenant user excluded.
    expect(ids).not.toContain(s.otherTenantMgr.id);
  });
});

// ==================================================================
// Assign flow (§13, §16, §17, §18)
// ==================================================================
describe("Payroll-3D-3A · assignDepartmentTimeApprover", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("assigns a valid approver and writes an audit event", async () => {
    const s = await scenario();
    const p = await principalFor(s.tenantAdmin.email);
    const r = await assignDepartmentTimeApprover(p, {
      clubId: s.clubA.id, departmentId: s.grounds.id, userId: s.activeMgr.id,
    });
    expect(r.changed).toBe(true);
    expect(r.current?.userId).toBe(s.activeMgr.id);
    const row = await db().departmentResponsibility.findFirstOrThrow({
      where: { clubId: s.clubA.id, departmentId: s.grounds.id, responsibilityKey: "DEPARTMENT_TIME_APPROVAL" },
    });
    expect(row.userId).toBe(s.activeMgr.id);
    const audit = await db().auditLog.findFirst({
      where: { entityType: "DepartmentResponsibility", action: "responsibility.department-time-approval.assign" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
  });

  it("§16 refuses a user from another tenant", async () => {
    const s = await scenario();
    const p = await principalFor(s.tenantAdmin.email);
    await expect(assignDepartmentTimeApprover(p, {
      clubId: s.clubA.id, departmentId: s.grounds.id, userId: s.otherTenantMgr.id,
    })).rejects.toThrow(ValidationError);
  });

  it("§17 refuses an inactive user", async () => {
    const s = await scenario();
    const p = await principalFor(s.tenantAdmin.email);
    await expect(assignDepartmentTimeApprover(p, {
      clubId: s.clubA.id, departmentId: s.grounds.id, userId: s.inactiveMgr.id,
    })).rejects.toThrow(ValidationError);
  });

  it("§18 refuses a user lacking payroll:timesheets:approve", async () => {
    const s = await scenario();
    const p = await principalFor(s.tenantAdmin.email);
    await expect(assignDepartmentTimeApprover(p, {
      clubId: s.clubA.id, departmentId: s.grounds.id, userId: s.staffOnly.id,
    })).rejects.toThrow(ValidationError);
  });

  it("caller without users:roles:write is refused", async () => {
    const s = await scenario();
    const staff = await principalFor(s.staffOnly.email);
    await expect(assignDepartmentTimeApprover(staff, {
      clubId: s.clubA.id, departmentId: s.grounds.id, userId: s.activeMgr.id,
    })).rejects.toThrow(ForbiddenError);
  });

  it("§15 concurrent assign converges to one canonical row", async () => {
    const s = await scenario();
    const p = await principalFor(s.tenantAdmin.email);
    const alt = await makeUser({
      email: `alt-${seedCounter}@t.test`, role: "DEPARTMENT_MANAGER", clubId: s.clubA.id,
    });
    await Promise.allSettled([
      assignDepartmentTimeApprover(p, { clubId: s.clubA.id, departmentId: s.grounds.id, userId: s.activeMgr.id }),
      assignDepartmentTimeApprover(p, { clubId: s.clubA.id, departmentId: s.grounds.id, userId: alt.id }),
    ]);
    const rows = await db().departmentResponsibility.findMany({
      where: { clubId: s.clubA.id, departmentId: s.grounds.id, responsibilityKey: "DEPARTMENT_TIME_APPROVAL" },
    });
    expect(rows).toHaveLength(1);
    expect([s.activeMgr.id, alt.id]).toContain(rows[0].userId);
  });

  it("unassign (userId=null) removes the row and audits", async () => {
    const s = await scenario();
    const p = await principalFor(s.tenantAdmin.email);
    await assignDepartmentTimeApprover(p, {
      clubId: s.clubA.id, departmentId: s.grounds.id, userId: s.activeMgr.id,
    });
    const r = await assignDepartmentTimeApprover(p, {
      clubId: s.clubA.id, departmentId: s.grounds.id, userId: null,
    });
    expect(r.changed).toBe(true);
    expect(r.current).toBeNull();
    const rows = await db().departmentResponsibility.count({
      where: { clubId: s.clubA.id, departmentId: s.grounds.id, responsibilityKey: "DEPARTMENT_TIME_APPROVAL" },
    });
    expect(rows).toBe(0);
  });
});

// ==================================================================
// Config-gap recovery (§14 / §T)
// ==================================================================
describe("Payroll-3D-3A · config-gap recovery", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("gap card is resolved and a manager card appears after assignment", async () => {
    const s = await scenario();
    const p = await principalFor(s.tenantAdmin.email);

    // Seed a reviewable timesheet in Grounds so listReviewableScopes returns it.
    const emp = await db().employee.create({
      data: {
        clubId: s.clubA.id, firstName: "T", lastName: "X",
        email: `tx-${seedCounter}@t.test`, hireDate: utc(2026, 1, 1),
        status: "ACTIVE", employeeLifecycle: "ACTIVE",
        employeeNumber: `E-X-${seedCounter}`, compensationType: "HOURLY",
        homeProvince: "AB", timekeepingMethod: "CLOCK_REQUIRED",
      },
    });
    const assn = await db().employeeEmploymentAssignment.create({
      data: {
        clubId: s.clubA.id, employeeId: emp.id, role: "PRIMARY",
        employmentType: "PART_TIME", effectiveFrom: utc(2026, 1, 1),
        departmentId: s.grounds.id,
      },
    });
    const pg = await db().payrollPayGroup.create({
      data: {
        clubId: s.clubA.id, code: `SM-${seedCounter}`, name: "Semi-Monthly",
        payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 5,
        calendarAnchorDate: utc(2026, 1, 1), active: true,
      },
    });
    const period = await db().payrollPayPeriod.create({
      data: {
        clubId: s.clubA.id, payGroupId: pg.id, taxYear: 2026, sequenceInYear: 17,
        periodStart: utc(2026, 9, 1), periodEnd: utc(2026, 9, 16),
        payDate: utc(2026, 9, 20), status: "OPEN",
      },
    });
    await db().payrollPayGroupMember.create({
      data: { clubId: s.clubA.id, payGroupId: pg.id, employeeId: emp.id, effectiveFrom: utc(2020, 1, 1) },
    });
    await db().timeClockEvent.create({
      data: { clubId: s.clubA.id, employeeId: emp.id, kind: "CLOCK_IN",
        occurredAt: utc(2026, 9, 5, 14, 0), source: "EMPLOYEE_PORTAL",
        employmentAssignmentId: assn.id },
    });
    await db().timeClockEvent.create({
      data: { clubId: s.clubA.id, employeeId: emp.id, kind: "CLOCK_OUT",
        occurredAt: utc(2026, 9, 5, 22, 0), source: "EMPLOYEE_PORTAL",
        employmentAssignmentId: assn.id },
    });
    await materializeEmployeeTimesheet(s.clubA.id, emp.id, period.id);

    // Tenant admin holds TENANT_ADMINISTRATION so orchestrator routes gap to them.
    await db().responsibilityAssignment.create({
      data: {
        clubId: s.clubA.id, userId: s.tenantAdmin.id,
        responsibilityKey: "TENANT_ADMINISTRATION",
        role: "PRIMARY",
        effectiveFrom: utc(2020, 1, 1),
      },
    });

    // No DepartmentResponsibility yet → gap card materialises.
    const before = await ensureTimesheetApprovalWorkItems(s.clubA.id, period.id);
    expect(before.items).toHaveLength(1);
    expect(before.items[0].gap).toBe(true);
    const gapCardId = before.items[0].workIntakeItemId;
    expect(gapCardId).toBeTruthy();

    // Assign approver → server action-equivalent flow rematerialises WI items.
    await assignDepartmentTimeApprover(p, {
      clubId: s.clubA.id, departmentId: s.grounds.id, userId: s.activeMgr.id,
    });
    const after = await ensureTimesheetApprovalWorkItems(s.clubA.id, period.id);
    expect(after.items).toHaveLength(1);
    expect(after.items[0].gap).toBe(false);
    expect(after.items[0].ownerUserId).toBe(s.activeMgr.id);

    // The gap card should be RESOLVED (materialiser retires it once the responsibility exists).
    const gapCard = await db().workIntakeItem.findUniqueOrThrow({ where: { id: gapCardId } });
    expect(gapCard.status).toBe("RESOLVED");
  });
});

// ==================================================================
// Read shape (listDepartmentApprovers)
// ==================================================================
describe("Payroll-3D-3A · listDepartmentApprovers", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("returns one row per department with approver + hasReviewableTime", async () => {
    const s = await scenario();
    const p = await principalFor(s.tenantAdmin.email);
    await assignDepartmentTimeApprover(p, {
      clubId: s.clubA.id, departmentId: s.grounds.id, userId: s.activeMgr.id,
    });
    const rows = await listDepartmentApprovers(p, s.clubA.id);
    const grounds = rows.find((r) => r.departmentId === s.grounds.id);
    expect(grounds?.approver?.userId).toBe(s.activeMgr.id);
    const banquets = rows.find((r) => r.departmentId === s.banquets.id);
    expect(banquets?.approver).toBeNull();
  });
});
