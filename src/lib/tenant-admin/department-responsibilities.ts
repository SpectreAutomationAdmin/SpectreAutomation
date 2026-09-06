// Payroll-3D-3A (2026-09-05) — Tenant Admin department-responsibility
// service (Timesheet Approver assignment, per department).
//
// Bridges the department-scoped Responsibility catalogue key
// (DEPARTMENT_TIME_APPROVAL) to a User. Until TA-1F ships the
// generic resolver, this service is the authoritative write surface;
// resolveDepartmentTimeApprover (in timesheets/manager-approval.ts)
// is the authoritative read.
//
// Authorization: caller must hold `admin:users:manage` (the Tenant
// Administrator capability) at the club. Refuses cross-tenant users
// and inactive users; refuses users lacking
// `payroll:timesheets:approve` so an assignment can always execute
// (§12 of the 3D-3A brief).
//
// Concurrency: composite unique
// (clubId, departmentId, responsibilityKey) makes concurrent
// assign-different-users collapse to one canonical row via upsert.
//
// Audit: every assign / reassign / unassign emits a canonical audit
// event so §13 traceability holds.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { hasPermission, requirePermission, type Principal } from "../rbac";
import { NotFoundError, ForbiddenError, ValidationError } from "../errors";

const ENTITY = "DepartmentResponsibility";
export const DEPT_TIME_APPROVAL_KEY = "DEPARTMENT_TIME_APPROVAL";

export interface DepartmentApproverView {
  departmentId:   string;
  departmentCode: string;
  departmentName: string;
  approver: {
    userId:     string;
    userName:   string | null;
    userEmail:  string;
    assignedAt: Date;
  } | null;
  hasReviewableTime: boolean;
}

export interface EligibleUserView {
  id:               string;
  name:             string | null;
  email:            string;
  primaryRoleKey:   string | null;
  holdsApproveCap:  boolean;
}

// -------------------------------------------------------------------
// Reads
// -------------------------------------------------------------------
export async function listDepartmentApprovers(
  principal: Principal, clubId: string,
): Promise<DepartmentApproverView[]> {
  requirePermission(principal, clubId, "payroll:timesheets:read");
  const [departments, responsibilityRows, timesheetCounts] = await Promise.all([
    prisma.department.findMany({
      where: { clubId, isActive: true },
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
      select: { id: true, code: true, name: true },
    }),
    prisma.departmentResponsibility.findMany({
      where: { clubId, responsibilityKey: DEPT_TIME_APPROVAL_KEY },
      include: { user: { select: { id: true, name: true, email: true, status: true } } },
    }),
    prisma.payrollTimesheetEntry.groupBy({
      by: ["employmentAssignmentId"],
      where: { clubId },
      _count: { _all: true },
    }),
  ]);
  const byDept = new Map<string, typeof responsibilityRows[number]>();
  for (const r of responsibilityRows) byDept.set(r.departmentId, r);

  // Compute which departments have reviewable time (any timesheet
  // entry whose assignment.departmentId matches). We do the join
  // separately to keep the query cheap.
  const assignmentIds = timesheetCounts
    .map((c) => c.employmentAssignmentId)
    .filter((x): x is string => !!x);
  const assignmentDepartmentIds = assignmentIds.length
    ? await prisma.employeeEmploymentAssignment.findMany({
        where: { id: { in: assignmentIds }, clubId },
        select: { departmentId: true },
      })
    : [];
  const reviewableDeptIds = new Set(
    assignmentDepartmentIds.map((a) => a.departmentId).filter((x): x is string => !!x),
  );

  return departments.map((d) => {
    const row = byDept.get(d.id);
    return {
      departmentId: d.id,
      departmentCode: d.code,
      departmentName: d.name,
      approver: row && row.user ? {
        userId: row.user.id,
        userName: row.user.name,
        userEmail: row.user.email,
        assignedAt: row.assignedAt,
      } : null,
      hasReviewableTime: reviewableDeptIds.has(d.id),
    };
  });
}

// -------------------------------------------------------------------
// Eligible users for the Timesheet Approver responsibility.
// - Same club (via UserClubRole)
// - Status ACTIVE
// - Holds `payroll:timesheets:approve` at this club
// -------------------------------------------------------------------
export async function listEligibleTimesheetApprovers(
  principal: Principal, clubId: string,
): Promise<EligibleUserView[]> {
  requirePermission(principal, clubId, "payroll:timesheets:read");
  const users = await prisma.user.findMany({
    where: {
      status: "ACTIVE",
      clubRoles: { some: { clubId } },
    },
    include: { clubRoles: { where: { clubId } } },
  });
  const eligible: EligibleUserView[] = [];
  for (const u of users) {
    const memberships = u.clubRoles.map((r) => ({
      clubId: r.clubId,
      roleKey: r.roleKey as import("../rbac").Principal["memberships"][number]["roleKey"],
    }));
    const principalLike = {
      id: u.id, name: u.name, email: u.email, status: u.status,
      memberships, activeClubId: clubId, memberId: u.memberId,
    } as unknown as Principal;
    const holds = hasPermission(principalLike, clubId, "payroll:timesheets:approve");
    if (!holds) continue;
    eligible.push({
      id: u.id,
      name: u.name,
      email: u.email,
      primaryRoleKey: memberships[0]?.roleKey ?? null,
      holdsApproveCap: true,
    });
  }
  eligible.sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));
  return eligible;
}

// -------------------------------------------------------------------
// Writes
// -------------------------------------------------------------------
export interface AssignApproverInput {
  clubId:       string;
  departmentId: string;
  /** Pass null to UNASSIGN the current approver. */
  userId:       string | null;
}

export interface AssignApproverResult {
  clubId:       string;
  departmentId: string;
  responsibilityKey: string;
  previous: { userId: string; userEmail: string } | null;
  current:  { userId: string; userEmail: string } | null;
  changed:  boolean;
}

async function assertAdminAuthorization(principal: Principal, clubId: string): Promise<void> {
  // Tenant Administrator holds admin:users:manage (see permissions).
  // Founders / SUPER_ADMIN inherit through their role grants.
  // Tenant Administrator holds users:roles:write; SUPER_ADMIN inherits.
  if (!hasPermission(principal, clubId, "users:roles:write")) {
    throw new ForbiddenError("Only a Tenant Administrator can change Timesheet Approver assignments.");
  }
}

export async function assignDepartmentTimeApprover(
  principal: Principal, input: AssignApproverInput,
): Promise<AssignApproverResult> {
  await assertAdminAuthorization(principal, input.clubId);
  const dept = await prisma.department.findFirst({
    where: { id: input.departmentId, clubId: input.clubId },
    select: { id: true },
  });
  if (!dept) throw new NotFoundError("Department", input.departmentId);

  // If unassigning: delete any existing row.
  if (input.userId === null) {
    const existing = await prisma.departmentResponsibility.findUnique({
      where: {
        clubId_departmentId_responsibilityKey: {
          clubId: input.clubId, departmentId: input.departmentId,
          responsibilityKey: DEPT_TIME_APPROVAL_KEY,
        },
      },
      include: { user: { select: { id: true, email: true } } },
    });
    if (!existing) {
      return {
        clubId: input.clubId, departmentId: input.departmentId,
        responsibilityKey: DEPT_TIME_APPROVAL_KEY,
        previous: null, current: null, changed: false,
      };
    }
    await prisma.departmentResponsibility.delete({ where: { id: existing.id } });
    await audit(principal, {
      clubId: input.clubId,
      action: "responsibility.department-time-approval.unassign",
      entityType: ENTITY,
      entityId: existing.id,
      before: { userId: existing.userId, userEmail: existing.user?.email ?? null },
      after:  { userId: null },
    });
    return {
      clubId: input.clubId, departmentId: input.departmentId,
      responsibilityKey: DEPT_TIME_APPROVAL_KEY,
      previous: existing.user ? { userId: existing.user.id, userEmail: existing.user.email } : null,
      current: null,
      changed: true,
    };
  }

  // Validate target user: same club, ACTIVE, holds approve cap.
  const target = await prisma.user.findFirst({
    where: { id: input.userId, status: "ACTIVE", clubRoles: { some: { clubId: input.clubId } } },
    include: { clubRoles: { where: { clubId: input.clubId } } },
  });
  if (!target) {
    throw new ValidationError([{
      path: "userId",
      message: "User is not an active member of this club.",
    }]);
  }
  const memberships = target.clubRoles.map((r) => ({
    clubId: r.clubId,
    roleKey: r.roleKey as import("../rbac").Principal["memberships"][number]["roleKey"],
  }));
  const targetPrincipalLike = {
    id: target.id, name: target.name, email: target.email, status: target.status,
    memberships, activeClubId: input.clubId, memberId: target.memberId,
  } as unknown as Principal;
  if (!hasPermission(targetPrincipalLike, input.clubId, "payroll:timesheets:approve")) {
    throw new ValidationError([{
      path: "userId",
      message: "This user does not currently hold the timesheet-approval capability.",
    }]);
  }

  const existing = await prisma.departmentResponsibility.findUnique({
    where: {
      clubId_departmentId_responsibilityKey: {
        clubId: input.clubId, departmentId: input.departmentId,
        responsibilityKey: DEPT_TIME_APPROVAL_KEY,
      },
    },
    include: { user: { select: { id: true, email: true } } },
  });
  const now = new Date();
  const row = await prisma.departmentResponsibility.upsert({
    where: {
      clubId_departmentId_responsibilityKey: {
        clubId: input.clubId, departmentId: input.departmentId,
        responsibilityKey: DEPT_TIME_APPROVAL_KEY,
      },
    },
    update: { userId: target.id, assignedAt: now, assignedByUserId: principal.id },
    create: {
      clubId: input.clubId, departmentId: input.departmentId,
      responsibilityKey: DEPT_TIME_APPROVAL_KEY,
      userId: target.id,
      assignedByUserId: principal.id,
    },
    include: { user: { select: { id: true, email: true } } },
  });
  const changed = !existing || existing.userId !== target.id;
  if (changed) {
    await audit(principal, {
      clubId: input.clubId,
      action: existing
        ? "responsibility.department-time-approval.reassign"
        : "responsibility.department-time-approval.assign",
      entityType: ENTITY,
      entityId: row.id,
      before: existing
        ? { userId: existing.userId, userEmail: existing.user?.email ?? null }
        : undefined,
      after: { userId: target.id, userEmail: target.email },
    });
  }
  return {
    clubId: input.clubId, departmentId: input.departmentId,
    responsibilityKey: DEPT_TIME_APPROVAL_KEY,
    previous: existing?.user ? { userId: existing.user.id, userEmail: existing.user.email } : null,
    current:  { userId: row.user!.id, userEmail: row.user!.email },
    changed,
  };
}
