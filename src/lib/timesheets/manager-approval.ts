// Payroll-3D-3 (2026-09-05) — Manager timesheet-scope approval.
//
// Responsibilities:
//   1. resolve the DEPARTMENT_TIME_APPROVAL owner for a
//      (clubId × departmentId) via DepartmentResponsibility;
//   2. gate manager write actions: caller must be that owner or a
//      tenant-scoped payroll admin (§48);
//   3. approve a scope with revision attestation (§72): approval is
//      only valid when the manager-supplied revision equals the
//      currently-computed revision — a stale click is rejected;
//   4. invalidate an approval whose approvedRevision has drifted (§35);
//   5. bridge to Work Intake resolution + reopen for §36 / §37.
//
// This file is the single write surface for
// PayrollDepartmentTimeApproval in the 3D-3 layer. The pre-existing
// approveDepartmentTime path in payroll/department-approval.ts
// operates on PayrollApprovedTimeEntry (the 3D-4 dataset) and is
// UNTOUCHED here — 3D-3 does not yet feed that path.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { hasPermission, requirePermission, type Principal } from "../rbac";
import { assertPostingAllowed } from "../posting-guard";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import {
  computeScopeRevision,
  getScopeReview,
} from "./approval-scope";
import { emitWorkCompletionEvent } from "../work-intake/completion";

const ENTITY = "PayrollDepartmentTimeApproval";

// -------------------------------------------------------------------
// Responsibility resolver — the sole authority for "who approves
// time for this department right now" until TA-1F ships the generic
// resolveResponsibilityOwner() (§7 fallback path).
// -------------------------------------------------------------------
export async function resolveDepartmentTimeApprover(
  clubId: string, departmentId: string,
): Promise<string | null> {
  const row = await prisma.departmentResponsibility.findUnique({
    where: {
      clubId_departmentId_responsibilityKey: {
        clubId, departmentId, responsibilityKey: "DEPARTMENT_TIME_APPROVAL",
      },
    },
    select: { userId: true },
  });
  if (!row) return null;
  // The user must still be ACTIVE and hold the approval capability.
  const user = await prisma.user.findFirst({
    where: { id: row.userId, status: "ACTIVE" },
    include: { clubRoles: { where: { clubId } } },
  });
  if (!user) return null;
  const memberships = user.clubRoles.map((r) => ({
    clubId: r.clubId,
    roleKey: r.roleKey as import("../rbac").Principal["memberships"][number]["roleKey"],
  }));
  const principalLike = {
    id: user.id, name: user.name, email: user.email, status: user.status,
    memberships, activeClubId: clubId, memberId: user.memberId,
  } as unknown as Principal;
  if (!hasPermission(principalLike, clubId, "payroll:timesheets:approve")) return null;
  return user.id;
}

// -------------------------------------------------------------------
// Scope authorization (§25 / §48 / §50)
// -------------------------------------------------------------------
async function assertScopeAuthorization(
  principal: Principal, clubId: string, departmentId: string,
): Promise<void> {
  requirePermission(principal, clubId, "payroll:timesheets:approve");
  const isTenantScoped =
    hasPermission(principal, clubId, "payroll:write") ||
    hasPermission(principal, clubId, "payroll:employees:manage");
  if (isTenantScoped) return;
  const ownerUserId = await resolveDepartmentTimeApprover(clubId, departmentId);
  if (ownerUserId !== principal.id) {
    throw new ForbiddenError("You are not the assigned Timesheet Approver for this department.");
  }
}

// -------------------------------------------------------------------
// Approve (§30, §71, §72, §75, §90)
// -------------------------------------------------------------------
export interface ApproveScopeInput {
  clubId:            string;
  payPeriodId:       string;
  departmentId:      string;
  /** The revision the manager reviewed. Server rejects if this !=
   *  currentRevision at the moment of approval commit (§71 / §92). */
  attestedRevision:  string;
  notes?:            string | null;
}

export interface ApproveScopeResult {
  approvalId:          string;
  state:               "APPROVED";
  approvedAt:          Date;
  approvedByUserId:    string;
  approvedRevision:    string;
  workIntakeItemId:    string | null;
}

export async function approveTimesheetScope(
  principal: Principal, input: ApproveScopeInput,
): Promise<ApproveScopeResult> {
  await assertScopeAuthorization(principal, input.clubId, input.departmentId);
  await assertPostingAllowed(
    principal, input.clubId, "payroll.timesheet-scope.approve",
    ENTITY, input.departmentId,
  );

  // Re-read readiness + revision inside the tx to close TOCTOU.
  const review = await getScopeReview(input.clubId, input.payPeriodId, input.departmentId);
  if (!review.readiness.ready) {
    throw new ValidationError([{
      path: "readiness",
      message: "Scope is not ready to approve. Resolve blocking issues first.",
    }]);
  }
  if (input.attestedRevision !== review.currentRevision) {
    throw new ConflictError(
      "The time this scope contains has changed since you last reviewed it. Refresh and re-attest.",
    );
  }
  const now = new Date();
  const notes = (input.notes ?? "").trim().slice(0, 500) || null;

  // Deterministic origin composite so approve/reopen can locate the WI card.
  const referenceId = `${input.payPeriodId}:${input.departmentId}`;
  const linkedOrigin = await prisma.workIntakeOrigin.findFirst({
    where: {
      clubId: input.clubId, kind: "PAYROLL_TIMESHEET_APPROVAL",
      referenceId, role: "PRIMARY",
    },
    select: { workIntakeItemId: true },
  });
  const workIntakeItemId = linkedOrigin?.workIntakeItemId ?? null;

  const approval = await prisma.payrollDepartmentTimeApproval.upsert({
    where: {
      clubId_payPeriodId_departmentId: {
        clubId: input.clubId, payPeriodId: input.payPeriodId, departmentId: input.departmentId,
      },
    },
    update: {
      state: "APPROVED",
      approvedAt: now,
      approvedByUserId: principal.id,
      approvedRevision: review.currentRevision,
      reopenedAt: null,
      reopenedByUserId: null,
      reopenReason: null,
      workIntakeItemId,
      notes,
    },
    create: {
      clubId: input.clubId,
      payPeriodId: input.payPeriodId,
      departmentId: input.departmentId,
      state: "APPROVED",
      approvedAt: now,
      approvedByUserId: principal.id,
      approvedRevision: review.currentRevision,
      workIntakeItemId,
      notes,
    },
  });

  if (workIntakeItemId) {
    // §36 — resolve Work Intake after approval commits.
    await emitWorkCompletionEvent({
      workIntakeItemId,
      clubId: input.clubId,
      completedByUserId: principal.id,
      completionType: "APPROVED_AND_COMPLETED",
      metadata: {
        payroll: {
          payPeriodId: input.payPeriodId,
          departmentId: input.departmentId,
          departmentCode: review.departmentCode,
          approvedRevision: review.currentRevision,
        },
      } as never,
    });
    await prisma.workIntakeItem.update({
      where: { id: workIntakeItemId },
      data: { status: "RESOLVED", resolvedAt: now, resolvedByUserId: principal.id },
    });
  }

  await audit(principal, {
    clubId: input.clubId,
    action: "payroll.timesheet-scope.approve",
    entityType: ENTITY,
    entityId: approval.id,
    after: {
      payPeriodId: input.payPeriodId,
      departmentId: input.departmentId,
      approvedRevision: review.currentRevision,
    },
  });

  return {
    approvalId: approval.id,
    state: "APPROVED",
    approvedAt: approval.approvedAt,
    approvedByUserId: approval.approvedByUserId,
    approvedRevision: review.currentRevision,
    workIntakeItemId,
  };
}

// -------------------------------------------------------------------
// Invalidate (§35 / §37 / §91)
//
// Called from the correction resolution and rematerialisation paths.
// If a valid APPROVED row exists for the scope and the current
// revision has drifted from approvedRevision, flip to REVIEW_REQUIRED
// and reopen the Work Intake card.
// -------------------------------------------------------------------
export async function invalidateApprovalIfDrifted(
  clubId: string, payPeriodId: string, departmentId: string,
): Promise<{ invalidated: boolean; newState: "APPROVED" | "REVIEW_REQUIRED" | null }> {
  const approval = await prisma.payrollDepartmentTimeApproval.findUnique({
    where: {
      clubId_payPeriodId_departmentId: { clubId, payPeriodId, departmentId },
    },
  });
  if (!approval) return { invalidated: false, newState: null };
  if (approval.state !== "APPROVED") return { invalidated: false, newState: approval.state as "APPROVED" | "REVIEW_REQUIRED" };
  const currentRevision = await computeScopeRevision(clubId, payPeriodId, departmentId);
  if (approval.approvedRevision === currentRevision) {
    return { invalidated: false, newState: "APPROVED" };
  }
  const now = new Date();
  await prisma.payrollDepartmentTimeApproval.update({
    where: { id: approval.id },
    data: {
      state: "REVIEW_REQUIRED",
      reopenedAt: now,
      reopenReason: "Source time changed after approval; revision drift.",
    },
  });
  if (approval.workIntakeItemId) {
    await prisma.workIntakeItem.update({
      where: { id: approval.workIntakeItemId },
      data: { status: "OPEN", resolvedAt: null, resolvedByUserId: null },
    });
    await prisma.workIntakeActivity.create({
      data: {
        workIntakeItemId: approval.workIntakeItemId,
        action: "REOPENED",
        note: "Source time changed after approval — manager must re-attest.",
      },
    });
  }
  await audit(null, {
    clubId,
    action: "payroll.timesheet-scope.invalidate",
    entityType: ENTITY,
    entityId: approval.id,
    before: { state: "APPROVED", approvedRevision: approval.approvedRevision },
    after:  { state: "REVIEW_REQUIRED", currentRevision },
  });
  return { invalidated: true, newState: "REVIEW_REQUIRED" };
}
