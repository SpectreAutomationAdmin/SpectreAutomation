// Scheduling Foundation (2026-09-07) — informational manager Work
// Intake notification emitted after a successful shift pickup.
//
// Founder amendments §7 + §9 + §14:
//   - No approval gate. This is an INFORMATIONAL card so the
//     department manager sees the reassignment happened.
//   - Routed to the DEPARTMENT_TIME_APPROVAL owner (reuse existing
//     bridge; no new responsibility key). Tenant-admin fallback if
//     the responsibility is unassigned (config gap).
//   - Origin kind: `SHIFT_REASSIGNMENT_NOTIFICATION` (not conflicting
//     with any existing registered kind per Phase A audit).
//
// This service is called from the shift-pickup path AFTER the
// atomic pickup transaction commits. If notification creation fails
// (e.g. transient DB error), the pickup itself stays committed; a
// future worker sweep can reconcile.

import { prisma } from "../prisma";
import { ensureOriginBackedItem } from "../work-intake/ensure-origin-backed-item";

const ORIGIN_KIND = "SHIFT_REASSIGNMENT_NOTIFICATION";
const GAP_ORIGIN_KIND = "SHIFT_REASSIGNMENT_CONFIG_GAP";

async function resolveDepartmentApprover(
  clubId: string, departmentId: string,
): Promise<string | null> {
  const row = await prisma.departmentResponsibility.findFirst({
    where: {
      clubId, departmentId,
      responsibilityKey: "DEPARTMENT_TIME_APPROVAL",
    },
    select: { userId: true },
  });
  if (!row) return null;
  const user = await prisma.user.findUnique({
    where: { id: row.userId },
    select: { id: true, status: true },
  });
  if (!user || user.status !== "ACTIVE") return null;
  return user.id;
}

async function resolveTenantAdmin(clubId: string): Promise<string | null> {
  const asn = await prisma.responsibilityAssignment.findFirst({
    where: {
      clubId,
      responsibilityKey: "TENANT_ADMINISTRATION",
      role: "PRIMARY",
      effectiveFrom: { lte: new Date() },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }],
    },
    orderBy: { effectiveFrom: "asc" },
    select: { userId: true },
  });
  return asn?.userId ?? null;
}

export interface NotifyShiftReassignmentInput {
  clubId: string;
  shiftId: string;
  departmentId: string;
  originalEmployeeId: string;
  newEmployeeId: string;
  opportunityId: string;
}

export interface NotifyShiftReassignmentResult {
  workIntakeItemId: string;
  ownerUserId: string | null;
  gap: boolean;
  created: boolean;
}

/**
 * Emit (or update) the informational manager Work Intake item for
 * this shift reassignment. `referenceId` = shiftId so subsequent
 * mutations on the same shift (a second give-up cycle after this
 * pickup) reuse the same canonical WI card.
 */
export async function notifyShiftReassignment(
  input: NotifyShiftReassignmentInput,
): Promise<NotifyShiftReassignmentResult> {
  const [approver, shift, oldEmp, newEmp] = await Promise.all([
    resolveDepartmentApprover(input.clubId, input.departmentId),
    prisma.shift.findUnique({
      where: { id: input.shiftId },
      include: {
        department: { select: { code: true, name: true } },
        shiftTemplate: { select: { name: true } },
      },
    }),
    prisma.employee.findUnique({
      where: { id: input.originalEmployeeId },
      select: { firstName: true, lastName: true, preferredName: true },
    }),
    prisma.employee.findUnique({
      where: { id: input.newEmployeeId },
      select: { firstName: true, lastName: true, preferredName: true },
    }),
  ]);
  if (!shift) throw new Error(`Shift not found: ${input.shiftId}`);

  const displayName = (e: { firstName: string; lastName: string; preferredName: string | null } | null) =>
    e ? `${e.preferredName ?? e.firstName} ${e.lastName}` : "Unknown employee";

  const shiftLabel = `${shift.shiftTemplate.name} · ${shift.department.name}`;
  const dateLabel = shift.startAt.toISOString().slice(0, 10);
  const subject = `Shift reassigned — ${shiftLabel}`;
  const preview = `${dateLabel} · ${displayName(oldEmp)} → ${displayName(newEmp)}`;
  const linkReason = `Shift ${input.shiftId} picked up by another eligible employee.`;

  const kind = approver ? ORIGIN_KIND : GAP_ORIGIN_KIND;
  const owner = approver ?? (await resolveTenantAdmin(input.clubId));

  const result = await ensureOriginBackedItem({
    clubId: input.clubId,
    originKind: kind,
    originReferenceId: input.shiftId,
    workDomain: "SCHEDULING",
    workIntent: "NOTIFY",
    workSubtype: "SHIFT_REASSIGNMENT",
    ownerUserId: owner,
    subject,
    preview,
    linkReason,
    classification: "INFORMATIONAL",
    classificationReason: "Spectre Scheduling notified of a shift reassignment.",
    classificationRuleKey: "scheduling-shift-reassignment.v1",
    classificationRuleVersion: 1,
    displaySourceLabel: "Spectre Scheduling",
    displaySender: "Scheduling orchestration",
    workDomainClassifierVersion: "scheduling-shift-reassignment.v1",
    // No caller-specific origin-conflict predicate — the SHIFT_REASSIGNMENT_NOTIFICATION
    // origin has no partial-unique index in this phase, so a race
    // is not possible via that mechanism. Any P2002 rethrows.
  });
  return {
    workIntakeItemId: result.workIntakeItemId,
    ownerUserId: owner,
    gap: !approver,
    created: result.created,
  };
}
