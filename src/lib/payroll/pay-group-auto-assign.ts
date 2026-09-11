// Payroll 3A hotfix (2026-09-11) — automatic pay-group membership
// assignment during the employee-activation lifecycle.
//
// Background: the interim audit against Coulee Ridge staging v357
// established that `resolvePopulation` at
//   src/lib/payroll/batch-preparation.ts:236
// correctly gates payroll population on `PayrollPayGroupMember`, but
// the employee activation transition
//   src/lib/hr/onboarding-approve-activate.ts:approveAndActivateEmployee
// never creates a membership row. Every ACTIVE Coulee employee without
// a manual assignment therefore disappears from every prepared run.
//
// This module closes that lifecycle gap for the SINGLE-active-pay-group
// case (Coulee's shape today). Multi-pay-group behaviour is documented
// in §3 of the founder's directive: for now we log a payroll-setup gap
// via `audit()` — no new Work Intake subtype is invented (per the
// directive, existing patterns must be reused, and no existing pattern
// covers this exactly; a follow-up slice may wire a
// PAYROLL_PAY_GROUP_MEMBERSHIP_CONFIG_GAP WorkIntakeOrigin if the
// founder authorises multi-pay-group tenants).
//
// Idempotent, tenant-safe, effective-dated, audit-covered.
//
// The helper here is called with a caller Principal representing the HR
// admin performing activation (not a payroll admin). It reuses the same
// underlying model + validations as `assignMembership`, but skips the
// `payroll:write` permission requirement — activation is an HR action.
// The training-mode + support-readonly gates from `assertPostingAllowed`
// still apply.

import { prisma } from "../prisma";
import { assertPostingAllowed } from "../posting-guard";
import { audit } from "../audit";
import type { Principal } from "../rbac";

export type PayGroupAutoAssignOutcome =
  | { status: "ASSIGNED"; payGroupId: string; membershipId: string; effectiveFrom: Date; effectiveFromSource: EffectiveFromSource }
  | { status: "ALREADY_MEMBER"; payGroupId: string; membershipId: string }
  | { status: "SKIPPED_NO_PAY_GROUP" }
  | { status: "SKIPPED_MULTI_PAY_GROUP"; candidatePayGroupCount: number }
  | { status: "SKIPPED_NO_EFFECTIVE_FROM" };

/** Documented deterministic hierarchy for the membership start date.
 *  Higher priority = earlier in this enum. */
export type EffectiveFromSource =
  | "EMPLOYEE_HIRE_DATE"
  | "EARLIEST_ACTIVE_EMPLOYMENT_ASSIGNMENT"
  | "EARLIEST_ACTIVE_COMPENSATION"
  | "ACTIVATION_NOW";

/**
 * Resolve the membership effective-from date for a newly-activated
 * employee, following §2's authoritative hierarchy:
 *
 *   1. Employee.hireDate                                         (if non-null)
 *   2. earliest active EmployeeEmploymentAssignment.effectiveFrom (if any)
 *   3. earliest active EmployeeCompensation.effectiveFrom        (if any)
 *   4. activation moment (`now`)                                 (fallback)
 *
 * Returns null only when every candidate resolves to null — meaning
 * the employee has no assignment, no compensation, no hire-date, and
 * the caller did not supply `now` (never happens because callers
 * always pass a Date).
 */
export async function resolveMembershipEffectiveFrom(
  employeeId: string,
  now: Date,
): Promise<{ effectiveFrom: Date; source: EffectiveFromSource } | null> {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { hireDate: true },
  });
  if (employee?.hireDate) {
    return { effectiveFrom: employee.hireDate, source: "EMPLOYEE_HIRE_DATE" };
  }
  const asn = await prisma.employeeEmploymentAssignment.findFirst({
    where: {
      employeeId,
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    orderBy: { effectiveFrom: "asc" },
    select: { effectiveFrom: true },
  });
  if (asn?.effectiveFrom) {
    return { effectiveFrom: asn.effectiveFrom, source: "EARLIEST_ACTIVE_EMPLOYMENT_ASSIGNMENT" };
  }
  const comp = await prisma.employeeCompensation.findFirst({
    where: {
      employeeId,
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    orderBy: { effectiveFrom: "asc" },
    select: { effectiveFrom: true },
  });
  if (comp?.effectiveFrom) {
    return { effectiveFrom: comp.effectiveFrom, source: "EARLIEST_ACTIVE_COMPENSATION" };
  }
  return { effectiveFrom: now, source: "ACTIVATION_NOW" };
}

/**
 * Automatically assign the employee to the Club's single active
 * PayrollPayGroup when the Club has exactly one. Fully idempotent:
 * calling this repeatedly for the same employee never creates a
 * second membership row.
 *
 * The caller must have already loaded the employee, confirmed tenant
 * ownership, and be running under a Principal that authenticated as
 * the HR admin approving the activation.
 */
export async function autoAssignSinglePayGroupOnActivation(input: {
  principal: Principal;
  clubId: string;
  employeeId: string;
  now: Date;
}): Promise<PayGroupAutoAssignOutcome> {
  const { principal, clubId, employeeId, now } = input;

  await assertPostingAllowed(
    principal,
    clubId,
    "payroll.pay-group-member.auto-assign",
    "PayrollPayGroupMember",
    employeeId,
  );

  const payGroups = await prisma.payrollPayGroup.findMany({
    where: { clubId, active: true },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });

  if (payGroups.length === 0) {
    await audit(principal, {
      action: "payroll.pay-group-member.auto-assign.skipped",
      entityType: "Employee",
      entityId: employeeId,
      clubId,
      after: { reason: "SKIPPED_NO_PAY_GROUP" },
    });
    return { status: "SKIPPED_NO_PAY_GROUP" };
  }

  if (payGroups.length > 1) {
    await audit(principal, {
      action: "payroll.pay-group-member.auto-assign.skipped",
      entityType: "Employee",
      entityId: employeeId,
      clubId,
      after: {
        reason: "SKIPPED_MULTI_PAY_GROUP",
        candidatePayGroupCount: payGroups.length,
        candidatePayGroupIds: payGroups.map((g) => g.id),
      },
    });
    return { status: "SKIPPED_MULTI_PAY_GROUP", candidatePayGroupCount: payGroups.length };
  }

  const payGroup = payGroups[0];

  // Idempotency: if the employee already has any membership for this
  // pay group we return the existing row rather than creating a duplicate.
  const existing = await prisma.payrollPayGroupMember.findFirst({
    where: { clubId, employeeId, payGroupId: payGroup.id },
    select: { id: true },
  });
  if (existing) {
    return { status: "ALREADY_MEMBER", payGroupId: payGroup.id, membershipId: existing.id };
  }

  const eff = await resolveMembershipEffectiveFrom(employeeId, now);
  if (!eff) {
    await audit(principal, {
      action: "payroll.pay-group-member.auto-assign.skipped",
      entityType: "Employee",
      entityId: employeeId,
      clubId,
      after: { reason: "SKIPPED_NO_EFFECTIVE_FROM" },
    });
    return { status: "SKIPPED_NO_EFFECTIVE_FROM" };
  }

  const row = await prisma.payrollPayGroupMember.create({
    data: {
      clubId,
      payGroupId: payGroup.id,
      employeeId,
      effectiveFrom: eff.effectiveFrom,
      effectiveTo: null,
      notes: `Auto-assigned on activation (source: ${eff.source}).`,
      createdByUserId: principal.id,
    },
    select: { id: true, payGroupId: true, effectiveFrom: true },
  });
  await audit(principal, {
    action: "payroll.pay-group-member.auto-assign.assigned",
    entityType: "PayrollPayGroupMember",
    entityId: row.id,
    clubId,
    after: {
      payGroupId: row.payGroupId,
      employeeId,
      effectiveFromIso: row.effectiveFrom.toISOString(),
      effectiveFromSource: eff.source,
    },
  });
  return {
    status: "ASSIGNED",
    payGroupId: row.payGroupId,
    membershipId: row.id,
    effectiveFrom: row.effectiveFrom,
    effectiveFromSource: eff.source,
  };
}
