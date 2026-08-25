// HR-2C Employment (2026-08-24) — Multi-role assignment service.
//
// Canonical writer for `EmployeeEmploymentAssignment`. Every mutation
// enforces:
//   - tenant discipline (assertTenantOwned on employee, department,
//     position — cross-club references refused with the same 404 shape);
//   - hr:employment:write + assertPostingAllowed (training-mode +
//     support-readonly);
//   - single-active-PRIMARY invariant (open-ADDITIONAL rows may
//     overlap freely; only one PRIMARY is open at a time);
//   - historical rows are NEVER updated in place — the only mutation
//     to an existing row is closing `effectiveTo`.
//
// The service returns display-safe views for the UI. Payroll +
// Scheduling reference an assignment id when they need role-specific
// rate / department / manager.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { assertPostingAllowed } from "../posting-guard";
import { ConflictError, NotFoundError, ValidationError } from "../errors";

export type AssignmentRole = "PRIMARY" | "ADDITIONAL";
export const ASSIGNMENT_ROLES = ["PRIMARY", "ADDITIONAL"] as const;

export type EmploymentTypeCode = "FULL_TIME" | "PART_TIME" | "SEASONAL" | "CONTRACT";
export const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "SEASONAL", "CONTRACT"] as const;

const ENTITY = "EmployeeEmploymentAssignment";

export interface AssignmentView {
  id: string;
  employeeId: string;
  role: AssignmentRole;
  departmentId: string | null;
  departmentName: string | null;
  positionId: string | null;
  positionName: string | null;
  managerEmployeeId: string | null;
  managerName: string | null;
  employmentType: EmploymentTypeCode | string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  isCurrent: boolean;
  notes: string | null;
}

async function loadEmployee(principal: Principal, employeeId: string) {
  const emp = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, clubId: true },
  });
  if (!emp) throw new NotFoundError("Employee", employeeId);
  assertTenantOwned(emp, principal);
  return emp;
}

function normaliseDate(input: Date | string, field: string): Date {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError([{ path: field, message: `${field} is not a valid date` }]);
  }
  return d;
}

function assertEmploymentType(input: string): EmploymentTypeCode {
  if (!(EMPLOYMENT_TYPES as readonly string[]).includes(input)) {
    throw new ValidationError([{
      path: "employmentType",
      message: `employmentType must be one of ${EMPLOYMENT_TYPES.join(", ")}`,
    }]);
  }
  return input as EmploymentTypeCode;
}

async function assertDeptInClub(clubId: string, departmentId: string | null | undefined) {
  if (!departmentId) return;
  const d = await prisma.department.findUnique({
    where: { id: departmentId },
    select: { id: true, clubId: true },
  });
  if (!d || d.clubId !== clubId) {
    throw new ValidationError([{ path: "departmentId", message: "Department is not part of this Club." }]);
  }
}

async function assertPositionInClub(clubId: string, positionId: string | null | undefined, departmentId: string | null | undefined) {
  if (!positionId) return;
  const p = await prisma.employeePosition.findUnique({
    where: { id: positionId },
    select: { id: true, clubId: true, departmentId: true },
  });
  if (!p || p.clubId !== clubId) {
    throw new ValidationError([{ path: "positionId", message: "Position is not part of this Club." }]);
  }
  if (departmentId && p.departmentId && p.departmentId !== departmentId) {
    throw new ValidationError([{
      path: "positionId",
      message: "Position does not belong to the selected Department.",
    }]);
  }
}

async function assertManagerInClub(clubId: string, managerEmployeeId: string | null | undefined, selfEmployeeId: string) {
  if (!managerEmployeeId) return;
  if (managerEmployeeId === selfEmployeeId) {
    throw new ValidationError([{ path: "managerEmployeeId", message: "An employee cannot report to themselves." }]);
  }
  const m = await prisma.employee.findUnique({
    where: { id: managerEmployeeId },
    select: { id: true, clubId: true },
  });
  if (!m || m.clubId !== clubId) {
    throw new ValidationError([{ path: "managerEmployeeId", message: "Manager is not part of this Club." }]);
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listAssignments(
  principal: Principal,
  employeeId: string,
): Promise<AssignmentView[]> {
  const emp = await loadEmployee(principal, employeeId);
  requirePermission(principal, emp.clubId, "hr:employment:read");
  const rows = await prisma.employeeEmploymentAssignment.findMany({
    where: { employeeId, clubId: emp.clubId },
    orderBy: [{ role: "asc" }, { effectiveFrom: "desc" }],
  });
  const deptIds = new Set(rows.map((r) => r.departmentId).filter((v): v is string => !!v));
  const posIds = new Set(rows.map((r) => r.positionId).filter((v): v is string => !!v));
  const mgrIds = new Set(rows.map((r) => r.managerEmployeeId).filter((v): v is string => !!v));
  const [depts, pos, mgrs] = await Promise.all([
    deptIds.size ? prisma.department.findMany({ where: { id: { in: [...deptIds] } }, select: { id: true, name: true } }) : [],
    posIds.size ? prisma.employeePosition.findMany({ where: { id: { in: [...posIds] } }, select: { id: true, name: true } }) : [],
    mgrIds.size ? prisma.employee.findMany({ where: { id: { in: [...mgrIds] } }, select: { id: true, firstName: true, preferredName: true, lastName: true } }) : [],
  ]);
  const deptMap = new Map(depts.map((d) => [d.id, d.name]));
  const posMap = new Map(pos.map((p) => [p.id, p.name]));
  const mgrMap = new Map(mgrs.map((m) => [
    m.id,
    `${m.preferredName ?? m.firstName} ${m.lastName}`,
  ]));
  const now = new Date();
  return rows.map((r) => ({
    id: r.id,
    employeeId: r.employeeId,
    role: r.role as AssignmentRole,
    departmentId: r.departmentId,
    departmentName: r.departmentId ? deptMap.get(r.departmentId) ?? null : null,
    positionId: r.positionId,
    positionName: r.positionId ? posMap.get(r.positionId) ?? null : null,
    managerEmployeeId: r.managerEmployeeId,
    managerName: r.managerEmployeeId ? mgrMap.get(r.managerEmployeeId) ?? null : null,
    employmentType: r.employmentType,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
    isCurrent: r.effectiveFrom <= now && (r.effectiveTo === null || r.effectiveTo > now),
    notes: r.notes,
  }));
}

// ---------------------------------------------------------------------------
// Canonical current-role display resolver (HR-2C Employment Corrections
// Portal Parity, 2026-08-24)
// ---------------------------------------------------------------------------
//
// The single canonical read for any surface that displays the
// employee's CURRENT role name (Admin Overview subtitle, Employee
// Portal hero subtitle, Portal Profile "Your roles"). Consumers must
// not join `Employee.position` / `Employee.department` for display —
// those legacy fields are cache-only and are not updated by the
// assignment write path.
//
// Semantics:
//   - PRIMARY current at time `t` is the one with role=PRIMARY,
//     effectiveFrom <= t, and (effectiveTo IS NULL OR effectiveTo > t).
//   - If none, returns nulls — caller may fall back to legacy fields
//     for pre-provisioned employees (currently only expected for
//     employees with no legacy data either).
//   - Never accepts a Principal — this is a display resolver used
//     across admin AND portal surfaces; tenant scope is enforced by
//     the employeeId lookup upstream (portal principal already tenants
//     by clubId; admin loader already permission-gates the page).
export interface CurrentRoleDisplay {
  assignmentId: string | null;
  positionId: string | null;
  positionName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  employmentType: string | null;
  managerEmployeeId: string | null;
  effectiveFrom: Date | null;
}

export async function getCurrentPrimaryRoleDisplay(
  employeeId: string,
  at: Date = new Date(),
): Promise<CurrentRoleDisplay> {
  // First try the CURRENTLY-effective PRIMARY row.
  let row = await prisma.employeeEmploymentAssignment.findFirst({
    where: {
      employeeId,
      role: "PRIMARY",
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    orderBy: { effectiveFrom: "desc" },
    select: {
      id: true, positionId: true, departmentId: true,
      managerEmployeeId: true, employmentType: true, effectiveFrom: true,
    },
  });
  // HR mobile-hotfix (2026-08-30) — display fallback for pre-hire
  // onboarding: if no currently-effective PRIMARY exists, fall back
  // to the SOONEST UPCOMING PRIMARY assignment. Payroll continues
  // to use its own effective-at-pay-period reader
  // (getActiveAssignmentsAt) so this fallback affects DISPLAY only.
  // Fixes founder-reported "No role assigned yet" for a freshly-
  // onboarded employee whose start date is a few days out.
  if (!row) {
    row = await prisma.employeeEmploymentAssignment.findFirst({
      where: {
        employeeId,
        role: "PRIMARY",
        effectiveFrom: { gt: at },
      },
      orderBy: { effectiveFrom: "asc" },
      select: {
        id: true, positionId: true, departmentId: true,
        managerEmployeeId: true, employmentType: true, effectiveFrom: true,
      },
    });
  }
  if (!row) {
    return {
      assignmentId: null, positionId: null, positionName: null,
      departmentId: null, departmentName: null,
      employmentType: null, managerEmployeeId: null, effectiveFrom: null,
    };
  }
  const [pos, dept] = await Promise.all([
    row.positionId
      ? prisma.employeePosition.findUnique({ where: { id: row.positionId }, select: { name: true } })
      : Promise.resolve(null),
    row.departmentId
      ? prisma.department.findUnique({ where: { id: row.departmentId }, select: { name: true } })
      : Promise.resolve(null),
  ]);
  return {
    assignmentId: row.id,
    positionId: row.positionId,
    positionName: pos?.name ?? null,
    departmentId: row.departmentId,
    departmentName: dept?.name ?? null,
    employmentType: row.employmentType,
    managerEmployeeId: row.managerEmployeeId,
    effectiveFrom: row.effectiveFrom,
  };
}

/** Active assignments at a given instant. Used by training
 *  applicability + future scheduling. Not permission-guarded because
 *  applicability resolvers are read-only, tenant-scoped by
 *  employeeId (loaded upstream). */
export async function getActiveAssignmentsAt(
  employeeId: string,
  at: Date = new Date(),
): Promise<Array<{
  id: string;
  role: AssignmentRole;
  departmentId: string | null;
  positionId: string | null;
  employmentType: string;
}>> {
  const rows = await prisma.employeeEmploymentAssignment.findMany({
    where: {
      employeeId,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    select: {
      id: true, role: true,
      departmentId: true, positionId: true, employmentType: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    role: r.role as AssignmentRole,
    departmentId: r.departmentId,
    positionId: r.positionId,
    employmentType: r.employmentType,
  }));
}

// ---------------------------------------------------------------------------
// Add assignment (primary or additional)
// ---------------------------------------------------------------------------

export interface AddAssignmentInput {
  role: AssignmentRole;
  departmentId?: string | null;
  positionId?: string | null;
  managerEmployeeId?: string | null;
  employmentType: string;
  effectiveFrom: Date | string;
  notes?: string | null;
}

export async function addAssignment(
  principal: Principal,
  employeeId: string,
  input: AddAssignmentInput,
): Promise<{ id: string }> {
  const emp = await loadEmployee(principal, employeeId);
  requirePermission(principal, emp.clubId, "hr:employment:write");
  await assertPostingAllowed(principal, emp.clubId, "hr.employment_assignment.add", ENTITY, employeeId);

  if (!(ASSIGNMENT_ROLES as readonly string[]).includes(input.role)) {
    throw new ValidationError([{ path: "role", message: `role must be one of ${ASSIGNMENT_ROLES.join(", ")}` }]);
  }
  const employmentType = assertEmploymentType(input.employmentType);
  const effectiveFrom = normaliseDate(input.effectiveFrom, "effectiveFrom");
  await assertDeptInClub(emp.clubId, input.departmentId ?? null);
  await assertPositionInClub(emp.clubId, input.positionId ?? null, input.departmentId ?? null);
  await assertManagerInClub(emp.clubId, input.managerEmployeeId ?? null, employeeId);

  const created = await prisma.$transaction(async (tx) => {
    if (input.role === "PRIMARY") {
      // Close the current open PRIMARY (if any) at the new
      // effectiveFrom. Only one open PRIMARY at a time.
      await tx.employeeEmploymentAssignment.updateMany({
        where: {
          employeeId, clubId: emp.clubId, role: "PRIMARY",
          effectiveTo: null,
        },
        data: { effectiveTo: effectiveFrom },
      });
    }
    return tx.employeeEmploymentAssignment.create({
      data: {
        clubId: emp.clubId,
        employeeId,
        role: input.role,
        departmentId: input.departmentId ?? null,
        positionId: input.positionId ?? null,
        managerEmployeeId: input.managerEmployeeId ?? null,
        employmentType,
        effectiveFrom,
        effectiveTo: null,
        notes: input.notes?.trim() || null,
        createdByUserId: principal.id,
      },
    });
  });

  await audit(principal, {
    action: input.role === "PRIMARY"
      ? "hr.employment_assignment.set_primary"
      : "hr.employment_assignment.add_additional",
    entityType: ENTITY,
    entityId: created.id,
    clubId: emp.clubId,
    after: {
      employeeIdTail: employeeId.slice(-8),
      role: input.role,
      departmentId: input.departmentId ?? null,
      positionId: input.positionId ?? null,
      employmentType,
      effectiveFrom: effectiveFrom.toISOString(),
    },
  });

  return { id: created.id };
}

// ---------------------------------------------------------------------------
// End an assignment (§24 — end a role without terminating the employee)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Backfill / provisioning — idempotent
// ---------------------------------------------------------------------------
//
// HR-2C Employment Corrections (2026-08-24) — Fixes the founder-
// surfaced defect where existing employees created before the
// multi-role architecture (or by any code path that skipped the
// Employment tab flow) had populated legacy Employee.departmentId /
// positionId / employmentType / managerEmployeeId fields but ZERO
// EmployeeEmploymentAssignment rows — so Overview showed a populated
// role while Employment reported "No primary role assigned yet."
//
// This helper is IDEMPOTENT: it creates a PRIMARY assignment from
// the legacy Employee fields only when the employee has no
// assignments at all. If ANY assignment exists (PRIMARY or
// ADDITIONAL, open or historical), it does nothing.
//
// Callable from:
//   1. createEmployee — immediately after creation, so new employees
//      never diverge.
//   2. updateEmployee — at the top of the update path, so opening
//      an old employee to edit provisions on-the-fly.
//   3. The admin profile-page loader — so viewing an old employee
//      triggers backfill even without an edit.
//   4. A one-shot backfill script (scripts/hr-2c-employment-backfill.mjs)
//      for staging + eventual production migration.
//
// The provision is a plain prisma insert (not addAssignment) so it
// bypasses the posting-guard + audit + Principal permission gates —
// the caller is trusted context (a service that just created the
// employee, or a system script). System-provisioned rows are audited
// distinctly so an auditor can tell them apart from admin-authored
// role changes.
export interface ProvisionResult {
  provisioned: boolean;
  assignmentId: string | null;
  reason: "already_has_assignment" | "no_legacy_data" | "provisioned";
}

export async function provisionInitialAssignmentIfMissing(
  clubId: string,
  employeeId: string,
  actorUserId: string | null = null,
  opts: { alwaysCreate?: boolean } = {},
): Promise<ProvisionResult> {
  const existing = await prisma.employeeEmploymentAssignment.findFirst({
    where: { employeeId },
    select: { id: true },
  });
  if (existing) {
    return { provisioned: false, assignmentId: null, reason: "already_has_assignment" };
  }
  const emp = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      id: true, clubId: true,
      departmentId: true, positionId: true, managerEmployeeId: true,
      employmentType: true, hireDate: true, expectedStartDate: true,
      createdAt: true,
    },
  });
  if (!emp || emp.clubId !== clubId) {
    return { provisioned: false, assignmentId: null, reason: "no_legacy_data" };
  }
  // If the employee has NO legacy dept/position/type at all AND the
  // caller is not explicitly requiring creation, do not fabricate a
  // synthetic role. HR mobile-hotfix (2026-08-30): the founder
  // observed a freshly-onboarded employee with position + department
  // populated but PRIMARY missing, because if either the just-in-
  // time backfill or the create-time provisioning had raced / failed
  // silently, the employee shipped without a canonical PRIMARY. The
  // fix is defence-in-depth: `createEmployee` passes
  // `alwaysCreate: true` so a PRIMARY row always exists after
  // creation, even if the admin form submitted only a subset of the
  // three role fields. Just-in-time backfill callers keep the
  // legacy `alwaysCreate: false` default.
  const hasAnyLegacyData =
    emp.departmentId != null ||
    emp.positionId != null ||
    (emp.employmentType != null && emp.employmentType.length > 0);
  if (!hasAnyLegacyData && !opts.alwaysCreate) {
    return { provisioned: false, assignmentId: null, reason: "no_legacy_data" };
  }
  const effectiveFrom = emp.hireDate ?? emp.expectedStartDate ?? emp.createdAt;
  // Default employmentType when the legacy field is blank — FULL_TIME
  // is the historically-most-common Spectre default. This matches
  // what the founder screenshot shows for Chris Turcato.
  const employmentType = emp.employmentType && (EMPLOYMENT_TYPES as readonly string[]).includes(emp.employmentType)
    ? emp.employmentType
    : "FULL_TIME";
  const row = await prisma.employeeEmploymentAssignment.create({
    data: {
      clubId,
      employeeId,
      role: "PRIMARY",
      departmentId: emp.departmentId,
      positionId: emp.positionId,
      managerEmployeeId: emp.managerEmployeeId,
      employmentType,
      effectiveFrom,
      effectiveTo: null,
      notes: "Backfilled from legacy Employee fields (HR-2C Employment Corrections).",
      createdByUserId: actorUserId,
    },
  });
  await audit(null, {
    action: "hr.employment_assignment.provision_backfill",
    entityType: ENTITY,
    entityId: row.id,
    clubId,
    after: {
      employeeIdTail: employeeId.slice(-8),
      role: "PRIMARY",
      departmentId: emp.departmentId,
      positionId: emp.positionId,
      employmentType,
      effectiveFrom: effectiveFrom.toISOString(),
      actorSource: actorUserId ? "SYSTEM_ON_BEHALF" : "SYSTEM",
    },
  });
  return { provisioned: true, assignmentId: row.id, reason: "provisioned" };
}

export async function endAssignment(
  principal: Principal,
  assignmentId: string,
  input: { effectiveTo: Date | string; notes?: string | null },
): Promise<void> {
  const row = await prisma.employeeEmploymentAssignment.findUnique({
    where: { id: assignmentId },
    select: { id: true, clubId: true, employeeId: true, role: true, effectiveFrom: true, effectiveTo: true },
  });
  if (!row) throw new NotFoundError(ENTITY, assignmentId);
  assertTenantOwned({ clubId: row.clubId }, principal);
  requirePermission(principal, row.clubId, "hr:employment:write");
  await assertPostingAllowed(principal, row.clubId, "hr.employment_assignment.end", ENTITY, assignmentId);
  if (row.effectiveTo !== null) {
    throw new ConflictError("Assignment already ended.");
  }
  const effectiveTo = normaliseDate(input.effectiveTo, "effectiveTo");
  if (effectiveTo <= row.effectiveFrom) {
    throw new ValidationError([{ path: "effectiveTo", message: "End date must be after start date." }]);
  }
  await prisma.employeeEmploymentAssignment.update({
    where: { id: assignmentId },
    data: { effectiveTo, notes: input.notes?.trim() || undefined },
  });
  await audit(principal, {
    action: "hr.employment_assignment.end",
    entityType: ENTITY,
    entityId: assignmentId,
    clubId: row.clubId,
    after: {
      employeeIdTail: row.employeeId.slice(-8),
      role: row.role,
      effectiveTo: effectiveTo.toISOString(),
    },
  });
}
