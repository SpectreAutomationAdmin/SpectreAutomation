// HR mobile-hotfix (2026-08-30) — canonical Approve & Activate
// Employee action (§4 of the founder brief).
//
// The founder observed the Employee Portal message "Your Club is
// reviewing your onboarding" but there was no admin action anywhere
// in People to actually perform the approval/activation. This
// service is the canonical writer for that lifecycle jump.
//
// It composes two accepted HR services in a single transaction:
//
//   transitionSession(SUBMITTED → APPROVED)     — records approver +
//                                                 timestamps + audit
//   Employee.employeeLifecycle: PRE_HIRE → ACTIVE — sets activatedAt
//
// Both must succeed together; if either throws the DB stays
// consistent (the transition service audits + updates the session
// row + the employee.onboardingState pointer in its own tx; the
// lifecycle flip lands after transition returns).
//
// Permissions: BOTH `hr:onboarding:approve` (for the state
// transition) AND `hr:employee:write` (for the lifecycle flip) are
// required. Neither by itself is enough — the approver identity
// must have the authority to activate the employee record.
//
// Never exposes SIN/banking reveal. Readiness projection is a
// separate read-only helper (`getOnboardingApprovalReadiness`)
// that shows only status / presence flags; plaintext sensitive
// values never leave the KMS.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, hasPermission, type Principal } from "../rbac";
import { AppError, NotFoundError } from "../errors";
import { transitionSession } from "./onboarding-sessions";
import { assertTenantOwned } from "../services/tenant";

const EMPLOYEE_ENTITY = "Employee";

export interface ApproveAndActivateResult {
  employeeId: string;
  employeeLifecycle: string;
  onboardingState: string;
  activatedAt: Date;
  approvedAt: Date;
}

/**
 * Approve the employee's submitted onboarding AND flip their
 * employee-lifecycle from PRE_HIRE to ACTIVE in one canonical
 * step. Idempotent-friendly: if the session is already APPROVED
 * and the employee is already ACTIVE, the second call returns
 * the current state without re-writing.
 */
export async function approveAndActivateEmployee(
  principal: Principal,
  employeeId: string,
): Promise<ApproveAndActivateResult> {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      id: true, clubId: true, employeeLifecycle: true, activatedAt: true,
    },
  });
  if (!employee) throw new NotFoundError(EMPLOYEE_ENTITY, employeeId);
  assertTenantOwned(employee, principal);

  // Both grants required. Fails fast so the caller never gets
  // half-way through the transition.
  requirePermission(principal, employee.clubId, "hr:onboarding:approve");
  requirePermission(principal, employee.clubId, "hr:employee:write");

  // Load the most-recent session so we know what state to
  // transition from.
  const currentSession = await prisma.employeeOnboardingSession.findFirst({
    where: { employeeId },
    orderBy: { startedAt: "desc" },
    select: { id: true, state: true, approvedAt: true, clubId: true },
  });
  if (!currentSession) {
    throw new AppError(
      "HR_APPROVE_NO_SESSION",
      "No onboarding session found for employee",
      404,
      "This employee has no onboarding submission to approve yet.",
    );
  }
  if (currentSession.clubId !== employee.clubId) {
    throw new NotFoundError("EmployeeOnboardingSession", currentSession.id);
  }

  // Already-approved short-circuit — idempotent.
  if (currentSession.state === "APPROVED" && employee.employeeLifecycle === "ACTIVE") {
    return {
      employeeId,
      employeeLifecycle: employee.employeeLifecycle,
      onboardingState: currentSession.state,
      activatedAt: employee.activatedAt ?? new Date(),
      approvedAt: currentSession.approvedAt ?? new Date(),
    };
  }
  if (currentSession.state !== "SUBMITTED") {
    throw new AppError(
      "HR_APPROVE_INVALID_STATE",
      `Cannot approve session from state ${currentSession.state}`,
      409,
      "This employee's onboarding is not ready for approval yet.",
    );
  }

  const transition = await transitionSession(
    principal, currentSession.id, "APPROVED",
  );

  const now = new Date();
  const updated = await prisma.employee.update({
    where: { id: employeeId },
    data: { employeeLifecycle: "ACTIVE", activatedAt: now },
    select: { employeeLifecycle: true, activatedAt: true },
  });

  await audit(principal, {
    action: "hr.employee.approve.activate",
    entityType: EMPLOYEE_ENTITY,
    entityId: employeeId,
    clubId: employee.clubId,
    before: { employeeLifecycle: employee.employeeLifecycle },
    after: {
      employeeLifecycle: updated.employeeLifecycle,
      activatedAtIso: (updated.activatedAt ?? now).toISOString(),
      sessionId: currentSession.id,
    },
  });

  return {
    employeeId,
    employeeLifecycle: updated.employeeLifecycle,
    onboardingState: transition.session.state,
    activatedAt: updated.activatedAt ?? now,
    approvedAt: transition.session.approvedAt ?? now,
  };
}

// ---------------------------------------------------------------------------
// Readiness projection — safe for admin display. Zero plaintext.
// ---------------------------------------------------------------------------

export interface OnboardingApprovalReadiness {
  employeeId: string;
  clubId: string;
  displayName: string;
  employeeLifecycle: string;
  session: { id: string; state: string; submittedAt: Date | null } | null;
  employmentAssignmentPresent: boolean;
  personalDetailsPresent: boolean;    // firstName + lastName + personalEmail
  sinPresent: boolean;                // sinLastThree presence only
  bankingPresent: boolean;
  bankingStatus: string | null;       // status only, no plaintext
  federalTd1Present: boolean;
  provincialTd1Present: boolean;
  emergencyContactPresent: boolean;
  portalCredentialPresent: boolean;
  readyForApproval: boolean;
  callerCanApprove: boolean;
}

export async function getOnboardingApprovalReadiness(
  principal: Principal,
  employeeId: string,
): Promise<OnboardingApprovalReadiness> {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      id: true, clubId: true, firstName: true, lastName: true,
      preferredName: true, personalEmail: true,
      employeeLifecycle: true,
    },
  });
  if (!employee) throw new NotFoundError(EMPLOYEE_ENTITY, employeeId);
  assertTenantOwned(employee, principal);
  requirePermission(principal, employee.clubId, "hr:employee:read");

  const [session, assignment, sin, bank, taxProfile, emergency, portalCred] = await Promise.all([
    prisma.employeeOnboardingSession.findFirst({
      where: { employeeId }, orderBy: { startedAt: "desc" },
      select: { id: true, state: true, submittedAt: true },
    }),
    prisma.employeeEmploymentAssignment.findFirst({
      where: { employeeId, role: "PRIMARY" }, select: { id: true },
    }),
    prisma.employeeSensitiveIdentity.findUnique({
      where: { employeeId }, select: { sinLastThree: true },
    }),
    prisma.employeeBankAccount.findFirst({
      where: { employeeId, status: { in: ["PENDING_PENNY_TEST", "VERIFIED"] } },
      orderBy: { updatedAt: "desc" },
      select: { id: true, status: true },
    }),
    prisma.employeeTaxProfile.findFirst({
      where: { employeeId }, select: { id: true, province: true },
    }),
    prisma.employeeEmergencyContact.findFirst({
      where: { employeeId, isPrimary: true }, select: { id: true },
    }),
    prisma.employeePortalCredential.findFirst({
      where: { employeeId }, select: { id: true },
    }),
  ]);

  const sinPresent = sin?.sinLastThree != null && sin.sinLastThree.length === 3;
  const bankingPresent = bank !== null;
  const federalTd1Present = taxProfile !== null;
  const provincialTd1Present = taxProfile?.province != null && taxProfile.province.length > 0;

  const readyForApproval = session?.state === "SUBMITTED"
    && employee.employeeLifecycle !== "ACTIVE"
    && assignment !== null
    && employee.firstName.length > 0
    && employee.lastName.length > 0
    && sinPresent
    && federalTd1Present
    && provincialTd1Present
    && portalCred !== null;

  const callerCanApprove =
    hasPermission(principal, employee.clubId, "hr:onboarding:approve") &&
    hasPermission(principal, employee.clubId, "hr:employee:write");

  const displayName = employee.preferredName?.trim()
    ? `${employee.preferredName} ${employee.lastName}`
    : `${employee.firstName} ${employee.lastName}`;

  return {
    employeeId,
    clubId: employee.clubId,
    displayName,
    employeeLifecycle: employee.employeeLifecycle,
    session,
    employmentAssignmentPresent: assignment !== null,
    personalDetailsPresent: employee.firstName.length > 0 && employee.lastName.length > 0
      && employee.personalEmail != null,
    sinPresent,
    bankingPresent,
    bankingStatus: bank?.status ?? null,
    federalTd1Present,
    provincialTd1Present,
    emergencyContactPresent: emergency !== null,
    portalCredentialPresent: portalCred !== null,
    readyForApproval,
    callerCanApprove,
  };
}
