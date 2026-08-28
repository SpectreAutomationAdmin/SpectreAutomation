// Payroll-3B-3 (2026-08-28) — department-level approval + Work
// Intake orchestration for a Pay Period's approved-time population.
//
// This service is one of two 3B-3 orchestration surfaces (the other
// is the Payroll Admin handoff — see `orchestration.ts`). It:
//   1. determines which Departments have payable time for a Pay
//      Period,
//   2. resolves the responsible Department manager User(s) from the
//      canonical `EmployeeEmploymentAssignment.managerEmployeeId`
//      relationship (no separate DepartmentManager table exists),
//   3. creates/updates the Work Intake task per Department idempotently,
//   4. transitions a department to APPROVED (bulk-approving its
//      DRAFT entries + resolving the WI card),
//   5. and REOPENS an approval when correction is required
//      (reactivating the WI card, flipping approved entries back to
//      DRAFT).

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, hasPermission, type Principal } from "../rbac";
import { assertPostingAllowed } from "../posting-guard";
import { ValidationError, NotFoundError } from "../errors";
import { emitWorkCompletionEvent } from "../work-intake/completion";
import { _bulkMarkApproved, _bulkMarkDraft } from "./approved-time";

const ENTITY = "PayrollDepartmentTimeApproval";

export type DepartmentApprovalState = "PENDING" | "APPROVED" | "REOPENED";

export interface DepartmentApprovalStatus {
  clubId: string;
  payPeriodId: string;
  departmentId: string;
  departmentCode: string;
  departmentName: string;
  employeeCount: number;
  entryCount: number;
  totalHours: string;                         // decimal serialized as string
  state: DepartmentApprovalState;
  approvedAt: Date | null;
  approvedByUserId: string | null;
  reopenedAt: Date | null;
  workIntakeItemId: string | null;
}

// ---------------------------------------------------------------------------
// Department discovery
// ---------------------------------------------------------------------------

interface DepartmentTallyRow {
  departmentId: string;
  code: string;
  name: string;
  employeeIds: Set<string>;
  entryIds: string[];
  totalHoursCents: bigint;
}

/**
 * For a Pay Period, return one tally row per Department that has
 * PayrollApprovedTimeEntry rows falling inside the Period's half-
 * open window. Employees without an assignment (departmentId=null)
 * are grouped under a synthetic UNASSIGNED tally, which Payroll
 * refuses to auto-approve — the admin must add an assignment first.
 */
async function tallyDepartmentsForPeriod(
  clubId: string,
  payPeriodId: string,
): Promise<Map<string, DepartmentTallyRow>> {
  const period = await prisma.payrollPayPeriod.findFirst({
    where: { id: payPeriodId, clubId },
    select: { periodStart: true, periodEnd: true },
  });
  if (!period) throw new NotFoundError("PayrollPayPeriod", payPeriodId);
  const entries = await prisma.payrollApprovedTimeEntry.findMany({
    where: {
      clubId,
      workDate: { gte: period.periodStart, lt: period.periodEnd },
    },
    select: {
      id: true,
      employeeId: true,
      hours: true,
      employmentAssignment: { select: { departmentId: true } },
    },
  });
  const departmentIds = new Set<string>();
  for (const e of entries) {
    const did = e.employmentAssignment?.departmentId;
    if (did) departmentIds.add(did);
  }
  const departments = departmentIds.size
    ? await prisma.department.findMany({
        where: { id: { in: Array.from(departmentIds) }, clubId },
        select: { id: true, code: true, name: true },
      })
    : [];
  const byId = new Map<string, { code: string; name: string }>();
  for (const d of departments) byId.set(d.id, { code: d.code, name: d.name });
  const tallies = new Map<string, DepartmentTallyRow>();
  for (const e of entries) {
    const departmentId = e.employmentAssignment?.departmentId;
    if (!departmentId) continue;
    const dept = byId.get(departmentId);
    if (!dept) continue;
    const t = tallies.get(departmentId) ?? {
      departmentId,
      code: dept.code,
      name: dept.name,
      employeeIds: new Set<string>(),
      entryIds: [],
      totalHoursCents: 0n,
    };
    t.employeeIds.add(e.employeeId);
    t.entryIds.push(e.id);
    // hours × 10_000 → integer for stable accumulation without float.
    t.totalHoursCents += BigInt(Math.round(Number(e.hours.toString()) * 10_000));
    tallies.set(departmentId, t);
  }
  return tallies;
}

// ---------------------------------------------------------------------------
// Manager resolution (§7 + §32)
// ---------------------------------------------------------------------------

/**
 * Resolve the User ids responsible for approving a Department's
 * time. Uses `EmployeeEmploymentAssignment.managerEmployeeId`:
 *   • Look at every current (effective on today's UTC date)
 *     PRIMARY assignment in the Department that carries a
 *     managerEmployeeId.
 *   • Collect the distinct managerEmployeeIds.
 *   • Resolve each manager Employee to their User account
 *     (Employee.userId) — managers without a User are dropped.
 *   • Additionally require the User to currently hold the
 *     `payroll:timesheets:approve` permission at this Club so
 *     ownership implies the ability to complete the task.
 *
 * Returns [] when no manager can be resolved. Callers surface an
 * exception in that case — Payroll cannot silently self-approve.
 */
export async function resolveDepartmentManagerUserIds(
  clubId: string,
  departmentId: string,
  asOf: Date = new Date(),
): Promise<string[]> {
  const assignments = await prisma.employeeEmploymentAssignment.findMany({
    where: {
      clubId,
      departmentId,
      role: "PRIMARY",
      effectiveFrom: { lte: asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }],
      managerEmployeeId: { not: null },
    },
    select: { managerEmployeeId: true },
  });
  const managerEmployeeIds = Array.from(
    new Set(assignments.map((a) => a.managerEmployeeId!).filter(Boolean)),
  );
  if (managerEmployeeIds.length === 0) return [];
  const managers = await prisma.employee.findMany({
    where: { id: { in: managerEmployeeIds }, clubId, userId: { not: null } },
    select: { userId: true },
  });
  const userIds = managers
    .map((m) => m.userId)
    .filter((u): u is string => !!u);
  // Filter to users who actually hold the department-approval capability.
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds }, status: "ACTIVE" },
        include: { clubRoles: { where: { clubId } } },
      })
    : [];
  const eligible: string[] = [];
  for (const u of users) {
    const principalLike = {
      id: u.id,
      name: u.name,
      email: u.email,
      status: u.status,
      memberships: u.clubRoles.map((r) => ({
        clubId: r.clubId,
        roleKey: r.roleKey as import("../rbac").Principal["memberships"][number]["roleKey"],
      })),
      activeClubId: clubId,
      memberId: u.memberId,
    } as unknown as Principal;
    if (hasPermission(principalLike, clubId, "payroll:timesheets:approve")) {
      eligible.push(u.id);
    }
  }
  return Array.from(new Set(eligible));
}

// ---------------------------------------------------------------------------
// Status read paths
// ---------------------------------------------------------------------------

export async function getDepartmentApprovalStatus(
  principal: Principal,
  clubId: string,
  payPeriodId: string,
): Promise<DepartmentApprovalStatus[]> {
  requirePermission(principal, clubId, "payroll:timesheets:read");
  const tallies = await tallyDepartmentsForPeriod(clubId, payPeriodId);
  const approvals = await prisma.payrollDepartmentTimeApproval.findMany({
    where: { clubId, payPeriodId },
  });
  const byDept = new Map<string, typeof approvals[number]>();
  for (const a of approvals) byDept.set(a.departmentId, a);
  const out: DepartmentApprovalStatus[] = [];
  for (const t of Array.from(tallies.values()).sort((a, b) => a.code.localeCompare(b.code))) {
    const a = byDept.get(t.departmentId);
    const state: DepartmentApprovalState = !a
      ? "PENDING"
      : a.state === "REOPENED"
        ? "REOPENED"
        : "APPROVED";
    out.push({
      clubId,
      payPeriodId,
      departmentId: t.departmentId,
      departmentCode: t.code,
      departmentName: t.name,
      employeeCount: t.employeeIds.size,
      entryCount: t.entryIds.length,
      totalHours: (Number(t.totalHoursCents) / 10_000).toFixed(4),
      state,
      approvedAt: a?.approvedAt ?? null,
      approvedByUserId: a?.approvedByUserId ?? null,
      reopenedAt: a?.reopenedAt ?? null,
      workIntakeItemId: a?.workIntakeItemId ?? null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Write paths
// ---------------------------------------------------------------------------

export interface ApproveDepartmentResult {
  approval: {
    id: string;
    departmentId: string;
    payPeriodId: string;
    state: "APPROVED";
    approvedAt: Date;
    approvedByUserId: string;
    workIntakeItemId: string | null;
  };
  approvedEntryCount: number;
}

/**
 * Approve a Department's time for a Pay Period. Requires
 * `payroll:timesheets:approve`. The caller MUST be either
 *   (a) an enumerated Department manager for this Department, or
 *   (b) tenant-level payroll approver (CLUB_ADMIN / PAYROLL_ADMIN /
 *       GENERAL_MANAGER — anyone holding payroll:timesheets:approve
 *       plus one of those higher-scope roles).
 * A generic DEPARTMENT_MANAGER at the Club who does NOT manage
 * this specific Department is rejected — capability alone is not
 * enough (see §31 dual-check).
 */
export async function approveDepartmentTime(
  principal: Principal,
  clubId: string,
  payPeriodId: string,
  departmentId: string,
): Promise<ApproveDepartmentResult> {
  requirePermission(principal, clubId, "payroll:timesheets:approve");
  await assertPostingAllowed(
    principal, clubId, "payroll.department-time.approve", ENTITY, departmentId,
  );

  const tallies = await tallyDepartmentsForPeriod(clubId, payPeriodId);
  const tally = tallies.get(departmentId);
  if (!tally) {
    throw new ValidationError([
      {
        path: "departmentId",
        message: "This department has no payable time for the selected pay period.",
      },
    ]);
  }

  // Dual-check (§31): capability + scope. Anyone above department
  // level (`payroll:write` or `payroll:employees:manage`) is deemed
  // tenant-scoped and passes. A raw DEPARTMENT_MANAGER without
  // ownership of this Department is rejected.
  const isTenantScoped =
    hasPermission(principal, clubId, "payroll:write") ||
    hasPermission(principal, clubId, "payroll:employees:manage");
  if (!isTenantScoped) {
    const managers = await resolveDepartmentManagerUserIds(clubId, departmentId);
    if (!managers.includes(principal.id)) {
      throw new ValidationError([
        {
          path: "departmentId",
          message: "You do not manage this department. Only its Department manager or a Payroll Administrator can approve its time.",
        },
      ]);
    }
  }

  const now = new Date();
  // Payroll-3B-4 linkage fix — resolve the WI item deterministically
  // via the canonical composite origin key on the SAME pass. This
  // removes the previous "second orchestration required" dependency.
  const linkedOrigin = await prisma.workIntakeOrigin.findFirst({
    where: {
      clubId,
      kind: "PAYROLL_DEPARTMENT_APPROVAL",
      referenceId: `${payPeriodId}:${departmentId}`,
      role: "PRIMARY",
    },
    select: { workIntakeItemId: true },
  });
  const workIntakeItemId = linkedOrigin?.workIntakeItemId ?? null;

  const approval = await prisma.payrollDepartmentTimeApproval.upsert({
    where: {
      clubId_payPeriodId_departmentId: { clubId, payPeriodId, departmentId },
    },
    update: {
      state: "APPROVED",
      approvedAt: now,
      approvedByUserId: principal.id,
      reopenedAt: null,
      reopenedByUserId: null,
      reopenReason: null,
      workIntakeItemId,
    },
    create: {
      clubId,
      payPeriodId,
      departmentId,
      state: "APPROVED",
      approvedAt: now,
      approvedByUserId: principal.id,
      workIntakeItemId,
    },
  });
  const approvedCount = await _bulkMarkApproved(clubId, tally.entryIds, principal.id);
  await audit(principal, {
    action: "payroll.department-time.approve",
    entityType: ENTITY,
    entityId: approval.id,
    clubId,
    after: {
      payPeriodId,
      departmentId,
      entryCount: approvedCount,
    },
  });
  // If the approval already has a WI card, resolve it via canonical
  // completion emitter (kept OUT of this file to avoid a cycle in
  // orchestration.ts; the API/UI caller wraps this + orchestration).
  if (approval.workIntakeItemId) {
    await emitWorkCompletionEvent({
      workIntakeItemId: approval.workIntakeItemId,
      clubId,
      completedByUserId: principal.id,
      completionType: "APPROVED_AND_COMPLETED",
      metadata: {
        payroll: {
          payPeriodId,
          departmentId,
          departmentCode: tally.code,
          approvedEntryCount: approvedCount,
        },
      } as never,
    });
    await prisma.workIntakeItem.update({
      where: { id: approval.workIntakeItemId },
      data: { status: "RESOLVED", resolvedAt: now, resolvedByUserId: principal.id },
    });
  }

  return {
    approval: {
      id: approval.id,
      departmentId,
      payPeriodId,
      state: "APPROVED",
      approvedAt: approval.approvedAt,
      approvedByUserId: approval.approvedByUserId,
      workIntakeItemId: approval.workIntakeItemId,
    },
    approvedEntryCount: approvedCount,
  };
}

/** Reopen a previously-approved department for correction. Flips
 *  APPROVED entries back to DRAFT so admins can edit them, and
 *  reactivates the Work Intake card (if any). */
export async function reopenDepartmentTime(
  principal: Principal,
  clubId: string,
  payPeriodId: string,
  departmentId: string,
  reason?: string,
): Promise<{ id: string; state: "REOPENED"; reactivatedEntryCount: number }> {
  requirePermission(principal, clubId, "payroll:timesheets:approve");
  await assertPostingAllowed(
    principal, clubId, "payroll.department-time.reopen", ENTITY, departmentId,
  );

  const approval = await prisma.payrollDepartmentTimeApproval.findUnique({
    where: {
      clubId_payPeriodId_departmentId: { clubId, payPeriodId, departmentId },
    },
  });
  if (!approval) {
    throw new ValidationError([
      { path: "departmentId", message: "This department has no approval to reopen for the selected pay period." },
    ]);
  }
  if (approval.state === "REOPENED") {
    // idempotent — already reopened
    return { id: approval.id, state: "REOPENED", reactivatedEntryCount: 0 };
  }

  const tallies = await tallyDepartmentsForPeriod(clubId, payPeriodId);
  const tally = tallies.get(departmentId);
  const entryIds = tally?.entryIds ?? [];
  const reactivatedEntryCount = await _bulkMarkDraft(clubId, entryIds);

  const now = new Date();
  const updated = await prisma.payrollDepartmentTimeApproval.update({
    where: { id: approval.id },
    data: {
      state: "REOPENED",
      reopenedAt: now,
      reopenedByUserId: principal.id,
      reopenReason: reason?.trim() || null,
    },
  });

  // Reactivate the WI card. Prefer the row's own workIntakeItemId
  // when set (fast path); otherwise resolve via the canonical
  // composite origin lookup (Payroll-3B-4 linkage fix). Guarantees
  // reopen works after a single orchestrate+approve sequence.
  let wiId = updated.workIntakeItemId;
  if (!wiId) {
    const linked = await prisma.workIntakeOrigin.findFirst({
      where: {
        clubId,
        kind: "PAYROLL_DEPARTMENT_APPROVAL",
        referenceId: `${payPeriodId}:${departmentId}`,
        role: "PRIMARY",
      },
      select: { workIntakeItemId: true },
    });
    wiId = linked?.workIntakeItemId ?? null;
    if (wiId) {
      await prisma.payrollDepartmentTimeApproval.update({
        where: { id: updated.id },
        data: { workIntakeItemId: wiId },
      });
    }
  }
  if (wiId) {
    await prisma.workIntakeItem.update({
      where: { id: wiId },
      data: { status: "OPEN", resolvedAt: null, resolvedByUserId: null },
    });
    await prisma.workIntakeActivity.create({
      data: {
        workIntakeItemId: wiId,
        actorUserId: principal.id,
        action: "REOPENED",
        note: reason?.trim() || null,
      },
    });
  }

  await audit(principal, {
    action: "payroll.department-time.reopen",
    entityType: ENTITY,
    entityId: updated.id,
    clubId,
    before: { state: approval.state },
    after: {
      state: "REOPENED",
      reactivatedEntryCount,
      reopenReason: updated.reopenReason,
    },
  });
  return { id: updated.id, state: "REOPENED", reactivatedEntryCount };
}

// Re-export the tally shape for orchestration.ts.
export type { DepartmentTallyRow };
export { tallyDepartmentsForPeriod };
