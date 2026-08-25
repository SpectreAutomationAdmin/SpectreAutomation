// HR-1 (2026-08-16) — Employee canonical service (create / update /
// terminate / member link / manager link / profile-photo / resume).
//
// Contract:
//   - Reads: `hr:employee:read`.
//   - Writes (create / update): `hr:employee:write` +
//     sensitive-action guard.
//   - Terminate: `hr:employee:terminate` + sensitive-action guard.
//   - Member link/unlink: `hr:employee:write` + same-tenant invariant
//     — cross-club link REJECTS EVEN FOR SUPER-ADMIN (`Member.clubId`
//     must equal `Employee.clubId`).
//   - Manager: `hr:employee:write` + same-tenant on the manager row.
//   - Profile photo / resume: the target document must belong to the
//     SAME employee (validated) and to the same club.
//
// Read-payloads NEVER include plaintext SIN / bank / tax. The masked
// versions are pulled through the security-compliance service reads.
//
// Employee.payRate is a LEGACY column — the canonical source of
// compensation is EmployeeCompensation. This service does NOT write
// payRate on updates; the financial-systems slice's compensation
// service is responsible for shadow-writing payRate on activation.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { hasPermission, isSuperAdmin, requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { ConflictError, NotFoundError, TenantViolationError, ValidationError } from "../errors";
import { assertSensitiveActionAllowed } from "../posting-guard";
import { provisionInitialAssignmentIfMissing } from "./employment-assignments";
import { getSinMasked } from "./sensitive-identity";
import { getBankAccountMasked } from "./bank-account";
import { getTaxProfileMasked } from "./tax-profile";

const EMPLOYEE_ENTITY = "Employee";

const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "SEASONAL", "CONTRACT"] as const;
// HR-2B.3.6 (2026-08-19) — ARCHIVED is a canonical lifecycle. Distinct
// from TERMINATED (which implies formal employment termination); ARCHIVED
// is the "removed from active directory, all history preserved" state
// used when an admin archives an onboarding-completed employee who is
// no longer active but for whom "terminated" is not the right label.
const LIFECYCLES = ["PRE_HIRE", "ACTIVE", "LEAVE", "TERMINATED", "ARCHIVED"] as const;
const COMPENSATION_TYPES = ["HOURLY", "SALARY", "COMMISSION", "PIECE_RATE"] as const;

// HR-2B.3.6 — Terminal onboarding states. Once an employee-submitted
// onboarding reaches one of these, hard delete from the directory is
// refused; the admin must archive instead. The service also refuses
// hard delete for anyone with financial history (payroll lines,
// timesheet entries) even if onboarding was never completed — those
// records anchor real accounting entries.
const ONBOARDING_TERMINAL_STATES = new Set(["SUBMITTED", "APPROVED", "REJECTED"]);

async function nextEmployeeNumber(clubId: string): Promise<string> {
  const count = await prisma.employee.count({ where: { clubId } });
  return `E-${(count + 1).toString().padStart(5, "0")}`;
}

async function loadEmployee(principal: Principal, employeeId: string) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) throw new NotFoundError(EMPLOYEE_ENTITY, employeeId);
  assertTenantOwned(employee, principal);
  return employee;
}

// ---------------------------------------------------------------------------
// Create.
// ---------------------------------------------------------------------------
export interface CreateEmployeeInput {
  firstName: string;
  lastName: string;
  middleName?: string | null;
  preferredName?: string | null;
  email?: string | null;
  personalEmail?: string | null;
  phone?: string | null;
  mobilePhone?: string | null;
  departmentId?: string | null;
  positionId?: string | null;
  hireDate?: Date | string | null;
  expectedStartDate?: Date | string | null;
  employmentType?: string | null;
  compensationType?: string;
  payRate?: number;
  employeeLifecycle?: string;
  employeeNumber?: string;
  // HR mobile-hotfix (2026-08-30) §1 — admin optional prefill of the
  // new hire's home address. Falls straight through to the Employee
  // row so the onboarding Address step sees prefilled values.
  homeAddressLine1?: string | null;
  homeAddressLine2?: string | null;
  homeCity?: string | null;
  homeProvince?: string | null;
  homePostalCode?: string | null;
  homeCountry?: string | null;
}

function toOptionalDate(v: Date | string | null | undefined, field: string): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError([{ path: field, message: `${field} is not a valid date` }]);
  }
  return d;
}

export async function createEmployee(
  principal: Principal,
  clubId: string,
  input: CreateEmployeeInput,
) {
  requirePermission(principal, clubId, "hr:employee:write");
  await assertSensitiveActionAllowed(
    principal,
    clubId,
    "hr.employee.write.update",
    EMPLOYEE_ENTITY,
    "new",
  );

  const firstName = (input.firstName ?? "").trim();
  const lastName = (input.lastName ?? "").trim();
  if (firstName.length === 0) throw new ValidationError([{ path: "firstName", message: "required" }]);
  if (lastName.length === 0) throw new ValidationError([{ path: "lastName", message: "required" }]);

  const employmentType = input.employmentType ?? null;
  if (employmentType != null && !(EMPLOYMENT_TYPES as readonly string[]).includes(employmentType)) {
    throw new ValidationError([{ path: "employmentType", message: `must be one of ${EMPLOYMENT_TYPES.join(", ")}` }]);
  }
  const lifecycle = input.employeeLifecycle ?? "PRE_HIRE";
  if (!(LIFECYCLES as readonly string[]).includes(lifecycle)) {
    throw new ValidationError([{ path: "employeeLifecycle", message: `must be one of ${LIFECYCLES.join(", ")}` }]);
  }
  const compType = input.compensationType ?? "HOURLY";
  if (!(COMPENSATION_TYPES as readonly string[]).includes(compType)) {
    throw new ValidationError([{ path: "compensationType", message: `must be one of ${COMPENSATION_TYPES.join(", ")}` }]);
  }

  const created = await prisma.employee.create({
    data: {
      clubId,
      employeeNumber: input.employeeNumber ?? (await nextEmployeeNumber(clubId)),
      firstName,
      lastName,
      middleName: input.middleName ?? null,
      preferredName: input.preferredName ?? null,
      email: input.email ?? null,
      personalEmail: input.personalEmail ?? null,
      phone: input.phone ?? null,
      mobilePhone: input.mobilePhone ?? null,
      departmentId: input.departmentId ?? null,
      positionId: input.positionId ?? null,
      hireDate: toOptionalDate(input.hireDate ?? null, "hireDate"),
      expectedStartDate: toOptionalDate(input.expectedStartDate ?? null, "expectedStartDate"),
      employmentType,
      employeeLifecycle: lifecycle,
      compensationType: compType,
      payRate: input.payRate ?? 0,
      // HR mobile-hotfix (2026-08-30) §1 — pass-through home address
      // fields from the admin AddEmployeeForm. All optional; null
      // stays null so the onboarding Address step sees blank inputs.
      homeAddressLine1: input.homeAddressLine1 ?? null,
      homeAddressLine2: input.homeAddressLine2 ?? null,
      homeCity: input.homeCity ?? null,
      homeProvince: input.homeProvince ? input.homeProvince.toUpperCase() : null,
      homePostalCode: input.homePostalCode ?? null,
      homeCountry: input.homeCountry ? input.homeCountry.toUpperCase() : null,
      createdByUserId: principal.id,
    },
  });

  await audit(principal, {
    action: "hr.employee.write.update",
    entityType: EMPLOYEE_ENTITY,
    entityId: created.id,
    clubId,
    after: {
      id: created.id,
      employeeNumber: created.employeeNumber,
      firstName: created.firstName,
      lastName: created.lastName,
      employeeLifecycle: created.employeeLifecycle,
      compensationType: created.compensationType,
    },
  });

  // HR-2C Employment Corrections (2026-08-24) — new employees must
  // carry a canonical PRIMARY assignment from day one so Overview
  // and Employment never diverge. Idempotent — a subsequent read
  // will find the assignment already exists and no-op.
  // HR mobile-hotfix (2026-08-30) — `alwaysCreate: true` so the
  // PRIMARY row lands even when the admin form submitted a subset
  // of dept/position/employmentType. The founder observed Lise
  // Montsion without a PRIMARY after admin creation; this closes
  // that gap regardless of which field was missing.
  await provisionInitialAssignmentIfMissing(
    clubId, created.id, principal.id, { alwaysCreate: true },
  );

  return created;
}

// ---------------------------------------------------------------------------
// Update (partial).
// ---------------------------------------------------------------------------
export interface UpdateEmployeeInput {
  firstName?: string;
  lastName?: string;
  middleName?: string | null;
  preferredName?: string | null;
  email?: string | null;
  personalEmail?: string | null;
  phone?: string | null;
  mobilePhone?: string | null;
  departmentId?: string | null;
  positionId?: string | null;
  hireDate?: Date | string | null;
  expectedStartDate?: Date | string | null;
  employmentType?: string | null;
  employeeLifecycle?: string;
  compensationType?: string;
  payrollIdExternal?: string | null;
  // HR mobile-hotfix (2026-08-30) §1 — admin-side home address writes.
  // Admin optionally captures address at hire so the employee sees a
  // prefilled Address step in onboarding. Employee still owns the
  // acknowledgement — the admin writing these fields does NOT mark
  // the step complete.
  homeAddressLine1?: string | null;
  homeAddressLine2?: string | null;
  homeCity?: string | null;
  homeProvince?: string | null;
  homePostalCode?: string | null;
  homeCountry?: string | null;
}

export async function updateEmployee(
  principal: Principal,
  employeeId: string,
  input: UpdateEmployeeInput,
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:employee:write");
  await assertSensitiveActionAllowed(
    principal,
    employee.clubId,
    "hr.employee.write.update",
    EMPLOYEE_ENTITY,
    employeeId,
  );

  // HR-2C Employment Corrections (2026-08-24) — just-in-time backfill.
  // Any legacy employee opened for an edit gets a canonical PRIMARY
  // assignment created from their legacy fields BEFORE the edit runs.
  // Idempotent; safe on already-migrated employees.
  await provisionInitialAssignmentIfMissing(employee.clubId, employeeId, principal.id);

  if (input.employmentType != null && !(EMPLOYMENT_TYPES as readonly string[]).includes(input.employmentType)) {
    throw new ValidationError([{ path: "employmentType", message: `must be one of ${EMPLOYMENT_TYPES.join(", ")}` }]);
  }
  if (input.employeeLifecycle != null && !(LIFECYCLES as readonly string[]).includes(input.employeeLifecycle)) {
    throw new ValidationError([{ path: "employeeLifecycle", message: `must be one of ${LIFECYCLES.join(", ")}` }]);
  }
  if (input.compensationType != null && !(COMPENSATION_TYPES as readonly string[]).includes(input.compensationType)) {
    throw new ValidationError([{ path: "compensationType", message: `must be one of ${COMPENSATION_TYPES.join(", ")}` }]);
  }

  const data: Record<string, unknown> = {};
  if (input.firstName !== undefined) data.firstName = input.firstName.trim();
  if (input.lastName !== undefined) data.lastName = input.lastName.trim();
  if (input.middleName !== undefined) data.middleName = input.middleName;
  if (input.preferredName !== undefined) data.preferredName = input.preferredName;
  if (input.email !== undefined) data.email = input.email;
  if (input.personalEmail !== undefined) data.personalEmail = input.personalEmail;
  if (input.phone !== undefined) data.phone = input.phone;
  if (input.mobilePhone !== undefined) data.mobilePhone = input.mobilePhone;
  if (input.departmentId !== undefined) data.departmentId = input.departmentId;
  if (input.positionId !== undefined) data.positionId = input.positionId;
  if (input.hireDate !== undefined) data.hireDate = toOptionalDate(input.hireDate, "hireDate");
  if (input.expectedStartDate !== undefined) data.expectedStartDate = toOptionalDate(input.expectedStartDate, "expectedStartDate");
  if (input.employmentType !== undefined) data.employmentType = input.employmentType;
  if (input.employeeLifecycle !== undefined) data.employeeLifecycle = input.employeeLifecycle;
  if (input.compensationType !== undefined) data.compensationType = input.compensationType;
  if (input.payrollIdExternal !== undefined) data.payrollIdExternal = input.payrollIdExternal;
  // HR mobile-hotfix (2026-08-30) §1 — admin home-address writes.
  if (input.homeAddressLine1 !== undefined) data.homeAddressLine1 = input.homeAddressLine1;
  if (input.homeAddressLine2 !== undefined) data.homeAddressLine2 = input.homeAddressLine2;
  if (input.homeCity !== undefined) data.homeCity = input.homeCity;
  if (input.homeProvince !== undefined) data.homeProvince = input.homeProvince ? input.homeProvince.toUpperCase() : input.homeProvince;
  if (input.homePostalCode !== undefined) data.homePostalCode = input.homePostalCode;
  if (input.homeCountry !== undefined) data.homeCountry = input.homeCountry ? input.homeCountry.toUpperCase() : input.homeCountry;

  const updated = await prisma.employee.update({
    where: { id: employeeId },
    data,
  });

  await audit(principal, {
    action: "hr.employee.write.update",
    entityType: EMPLOYEE_ENTITY,
    entityId: employeeId,
    clubId: employee.clubId,
    before: {
      firstName: employee.firstName,
      lastName: employee.lastName,
      employeeLifecycle: employee.employeeLifecycle,
      compensationType: employee.compensationType,
    },
    after: {
      firstName: updated.firstName,
      lastName: updated.lastName,
      employeeLifecycle: updated.employeeLifecycle,
      compensationType: updated.compensationType,
    },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Terminate.
// ---------------------------------------------------------------------------
export async function terminateEmployee(
  principal: Principal,
  employeeId: string,
  opts: { terminationDate?: Date | string | null; reason?: string } = {},
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:employee:terminate");
  await assertSensitiveActionAllowed(
    principal,
    employee.clubId,
    "hr.employee.terminate.post",
    EMPLOYEE_ENTITY,
    employeeId,
  );

  const terminationDate = toOptionalDate(opts.terminationDate ?? new Date(), "terminationDate")!;

  const updated = await prisma.employee.update({
    where: { id: employeeId },
    data: {
      employeeLifecycle: "TERMINATED",
      status: "TERMINATED",
      terminationDate,
    },
  });

  await audit(principal, {
    action: "hr.employee.terminate.post",
    entityType: EMPLOYEE_ENTITY,
    entityId: employeeId,
    clubId: employee.clubId,
    before: {
      employeeLifecycle: employee.employeeLifecycle,
      status: employee.status,
      terminationDate: employee.terminationDate,
    },
    after: {
      employeeLifecycle: updated.employeeLifecycle,
      status: updated.status,
      terminationDate: updated.terminationDate,
    },
    meta: { reason: opts.reason ?? null },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Archive.
// ---------------------------------------------------------------------------

/**
 * HR-2B.3.6 (2026-08-19) — Move the employee out of the active
 * directory without destroying any history. Reversible in principle;
 * a separate `unarchiveEmployee` is intentionally NOT part of this
 * slice (founder brief §2.2: "Do not use archive as an irreversible
 * delete" — reversibility can be added when the founder needs it).
 *
 * Preserves: EmploymentPeriod, PayrollLine, TimesheetEntry, audit log,
 * EmployeeDocument, EmployeeSensitiveIdentity, EmployeeBankAccount,
 * EmployeeTaxProfile, EmployeeOnboardingSession, and every other
 * child row. Only `employeeLifecycle` flips to `ARCHIVED`.
 */
export async function archiveEmployee(
  principal: Principal,
  employeeId: string,
  opts: { reason?: string } = {},
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:employee:write");
  await assertSensitiveActionAllowed(
    principal,
    employee.clubId,
    "hr.employee.archive.update",
    EMPLOYEE_ENTITY,
    employeeId,
  );

  if (employee.employeeLifecycle === "ARCHIVED") return employee;

  const updated = await prisma.employee.update({
    where: { id: employeeId },
    data: { employeeLifecycle: "ARCHIVED" },
  });

  await audit(principal, {
    action: "hr.employee.archive.update",
    entityType: EMPLOYEE_ENTITY,
    entityId: employeeId,
    clubId: employee.clubId,
    before: { employeeLifecycle: employee.employeeLifecycle },
    after: { employeeLifecycle: updated.employeeLifecycle },
    meta: { reason: opts.reason ?? null },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Delete.
// ---------------------------------------------------------------------------

export interface DeleteEmployeeEligibility {
  eligible: boolean;
  /** When `eligible: false`, a machine-readable reason for the caller
   *  (UI decides which copy to show). Admin sees an archive-instead CTA. */
  reason?:
    | "onboarding_completed"
    | "has_payroll_lines"
    | "has_timesheet_entries"
    | "has_employment_period_activated";
}

/**
 * Cheap pre-flight: is the employee eligible for a HARD delete right
 * now? Reads the same signals `deleteEmployee` would enforce, without
 * mutating anything. Used by the profile UI to pick between Delete
 * and Archive.
 */
export async function getDeleteEligibility(
  principal: Principal,
  employeeId: string,
): Promise<DeleteEmployeeEligibility> {
  const employee = await loadEmployee(principal, employeeId);
  if (ONBOARDING_TERMINAL_STATES.has(employee.onboardingState)) {
    return { eligible: false, reason: "onboarding_completed" };
  }
  const [payrollCount, timesheetCount, activePeriodCount] = await Promise.all([
    prisma.payrollLine.count({ where: { employeeId } }),
    // TimesheetEntry.employeeId doesn't exist directly — the FK is on
    // the parent Timesheet, so we count via the join.
    prisma.timesheetEntry.count({ where: { timesheet: { employeeId } } }),
    prisma.employmentPeriod.count({ where: { employeeId, effectiveTo: null } }),
  ]);
  if (payrollCount > 0) return { eligible: false, reason: "has_payroll_lines" };
  if (timesheetCount > 0) return { eligible: false, reason: "has_timesheet_entries" };
  if (activePeriodCount > 0 && employee.employeeLifecycle === "ACTIVE") {
    return { eligible: false, reason: "has_employment_period_activated" };
  }
  return { eligible: true };
}

/**
 * HR-2B.3.6 (2026-08-19) — Hard-delete an employee whose onboarding
 * has NOT yet reached a terminal state and who has no financial /
 * timekeeping history. Deletes the following child rows in FK-safe
 * order inside a single transaction; refuses if the employee is
 * ineligible.
 *
 * Deletes (canonical order):
 *   1. EmployeeOnboardingCorrection
 *   2. EmployeeOnboardingAcknowledgement
 *   3. EmployeeOnboardingResponse
 *   4. EmployeeOnboardingInvitation
 *   5. EmployeeOnboardingSession
 *   6. EmployeeSensitiveIdentity
 *   7. EmployeeBankAccount
 *   8. EmployeeTaxProfile
 *   9. EmployeeEmergencyContact
 *  10. EmployeeCredential
 *  11. EmployeeDocument (PII-bearing rows — see `sensitivity`)
 *  12. EmployeeCompensation (HR-1 canonical rate history)
 *  13. EmploymentPeriod (only if no PayrollLine / TimesheetEntry — enforced above)
 *  14. Employee itself.
 *
 * Explicitly NOT touched: PayrollLine, TimesheetEntry, JournalEntryLine,
 * AuditLog. If any of these exist, the eligibility check refuses the
 * delete BEFORE any mutation runs.
 */
export async function deleteEmployee(
  principal: Principal,
  employeeId: string,
  opts: { reason?: string } = {},
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:employee:write");
  await assertSensitiveActionAllowed(
    principal,
    employee.clubId,
    "hr.employee.delete.post",
    EMPLOYEE_ENTITY,
    employeeId,
  );

  const eligibility = await getDeleteEligibility(principal, employeeId);
  if (!eligibility.eligible) {
    throw new ConflictError(
      `Employee ${employeeId} is not eligible for hard delete (${eligibility.reason ?? "unknown"}). Archive instead.`,
    );
  }

  const before = {
    employeeLifecycle: employee.employeeLifecycle,
    onboardingState: employee.onboardingState,
    firstName: employee.firstName,
    lastName: employee.lastName,
    employeeNumber: employee.employeeNumber,
  };

  await prisma.$transaction(async (tx) => {
    // 1. Onboarding-related.
    //
    // EmployeeOnboardingResponse rows are keyed on sessionId, not
    // employeeId — delete via a subquery on this employee's sessions.
    await tx.employeeOnboardingCorrection.deleteMany({ where: { employeeId } });
    await tx.employeeOnboardingAcknowledgement.deleteMany({ where: { employeeId } });
    await tx.employeeOnboardingResponse.deleteMany({
      where: { session: { employeeId } },
    });
    await tx.employeeOnboardingInvitation.deleteMany({ where: { employeeId } });
    await tx.employeeOnboardingSession.deleteMany({ where: { employeeId } });
    // 2. Sensitive HR rows.
    await tx.employeeSensitiveIdentity.deleteMany({ where: { employeeId } });
    await tx.employeeBankAccount.deleteMany({ where: { employeeId } });
    await tx.employeeTaxProfile.deleteMany({ where: { employeeId } });
    // 3. Directory adjuncts.
    await tx.employeeEmergencyContact.deleteMany({ where: { employeeId } });
    await tx.employeeCredential.deleteMany({ where: { employeeId } });
    // 4. Documents (may include void cheques, resume, profile photo).
    await tx.employeeDocument.deleteMany({ where: { employeeId } });
    // 5. Compensation history (HR-1 canonical rate table). Table may
    //    not exist in every older schema — guard the delete.
    if ((tx as unknown as { employeeCompensation?: { deleteMany?: (arg: unknown) => Promise<unknown> } }).employeeCompensation?.deleteMany) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tx as any).employeeCompensation.deleteMany({ where: { employeeId } });
    }
    // 6. Employment period. Eligibility check above already refused if
    //    payroll/timesheet history exists.
    await tx.employmentPeriod.deleteMany({ where: { employeeId } });
    // 7. Unpin the profile-photo / resume pointers before deleting
    //    the Employee row — the FK on Employee → EmployeeDocument
    //    references the document, not the reverse.
    // Already handled by step 4 (documents deleted before employee).
    // 8. Employee itself.
    await tx.employee.delete({ where: { id: employeeId } });
  });

  await audit(principal, {
    action: "hr.employee.delete.post",
    entityType: EMPLOYEE_ENTITY,
    entityId: employeeId,
    clubId: employee.clubId,
    before,
    meta: { reason: opts.reason ?? null },
  });
}

// ---------------------------------------------------------------------------
// Member link / unlink.
// ---------------------------------------------------------------------------
export async function linkEmployeeToMember(
  principal: Principal,
  employeeId: string,
  memberId: string,
  opts: { replace?: boolean } = {},
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:employee:write");
  await assertSensitiveActionAllowed(
    principal,
    employee.clubId,
    "hr.employee.member.update",
    EMPLOYEE_ENTITY,
    employeeId,
  );

  const member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member) throw new NotFoundError("Member", memberId);
  assertTenantOwned(member, principal);

  // Same-tenant invariant — REJECTS EVEN FOR SUPER-ADMIN. Members
  // and their Employee record MUST belong to the same club.
  if (member.clubId !== employee.clubId) {
    throw new TenantViolationError(
      `Member.clubId=${member.clubId} does not match Employee.clubId=${employee.clubId}`,
    );
  }

  if (employee.memberId != null && employee.memberId !== memberId && !opts.replace) {
    throw new ConflictError(
      `Employee is already linked to member ${employee.memberId} — pass {replace: true} to overwrite`,
    );
  }

  // DB @unique on memberId catches the "member already linked to
  // another employee" case — pre-empt with a friendlier error.
  const otherEmployee = await prisma.employee.findFirst({
    where: { memberId, id: { not: employeeId } },
  });
  if (otherEmployee) {
    throw new ConflictError(
      `Member ${memberId} is already linked to another employee`,
    );
  }

  const before = { memberId: employee.memberId };
  const updated = await prisma.employee.update({
    where: { id: employeeId },
    data: { memberId },
  });

  await audit(principal, {
    action: "hr.employee.member.update",
    entityType: EMPLOYEE_ENTITY,
    entityId: employeeId,
    clubId: employee.clubId,
    before,
    after: { memberId: updated.memberId },
  });

  return updated;
}

export async function unlinkEmployeeFromMember(
  principal: Principal,
  employeeId: string,
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:employee:write");
  await assertSensitiveActionAllowed(
    principal,
    employee.clubId,
    "hr.employee.member.delete",
    EMPLOYEE_ENTITY,
    employeeId,
  );

  if (employee.memberId == null) return employee;

  const before = { memberId: employee.memberId };
  const updated = await prisma.employee.update({
    where: { id: employeeId },
    data: { memberId: null },
  });

  await audit(principal, {
    action: "hr.employee.member.delete",
    entityType: EMPLOYEE_ENTITY,
    entityId: employeeId,
    clubId: employee.clubId,
    before,
    after: { memberId: updated.memberId },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Manager link.
// ---------------------------------------------------------------------------
export async function setManager(
  principal: Principal,
  employeeId: string,
  managerEmployeeId: string | null,
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:employee:write");
  await assertSensitiveActionAllowed(
    principal,
    employee.clubId,
    "hr.employee.write.update",
    EMPLOYEE_ENTITY,
    employeeId,
  );

  if (managerEmployeeId != null) {
    if (managerEmployeeId === employeeId) {
      throw new ValidationError([{ path: "managerEmployeeId", message: "employee cannot manage themselves" }]);
    }
    const manager = await prisma.employee.findUnique({ where: { id: managerEmployeeId } });
    if (!manager) throw new NotFoundError(EMPLOYEE_ENTITY, managerEmployeeId);
    assertTenantOwned(manager, principal);
    if (manager.clubId !== employee.clubId) {
      throw new TenantViolationError(
        `Manager.clubId=${manager.clubId} does not match Employee.clubId=${employee.clubId}`,
      );
    }
  }

  const before = { managerEmployeeId: employee.managerEmployeeId };
  const updated = await prisma.employee.update({
    where: { id: employeeId },
    data: { managerEmployeeId },
  });

  await audit(principal, {
    action: "hr.employee.write.update",
    entityType: EMPLOYEE_ENTITY,
    entityId: employeeId,
    clubId: employee.clubId,
    before,
    after: { managerEmployeeId: updated.managerEmployeeId },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Profile photo / resume.
// ---------------------------------------------------------------------------
async function assertDocumentOwnedByEmployee(
  employeeId: string,
  documentId: string | null,
  field: string,
) {
  if (documentId == null) return;
  const doc = await prisma.employeeDocument.findUnique({ where: { id: documentId } });
  if (!doc) throw new NotFoundError("EmployeeDocument", documentId);
  if (doc.employeeId !== employeeId) {
    throw new ValidationError([{
      path: field,
      message: `document ${documentId} does not belong to employee ${employeeId}`,
    }]);
  }
}

export async function setProfilePhoto(
  principal: Principal,
  employeeId: string,
  documentId: string | null,
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:employee:write");
  await assertSensitiveActionAllowed(
    principal,
    employee.clubId,
    "hr.employee.write.update",
    EMPLOYEE_ENTITY,
    employeeId,
  );
  await assertDocumentOwnedByEmployee(employeeId, documentId, "profilePhotoDocumentId");
  const before = { profilePhotoDocumentId: employee.profilePhotoDocumentId };
  const updated = await prisma.employee.update({
    where: { id: employeeId },
    data: { profilePhotoDocumentId: documentId },
  });
  await audit(principal, {
    action: "hr.employee.write.update",
    entityType: EMPLOYEE_ENTITY,
    entityId: employeeId,
    clubId: employee.clubId,
    before,
    after: { profilePhotoDocumentId: updated.profilePhotoDocumentId },
  });
  return updated;
}

export async function setResume(
  principal: Principal,
  employeeId: string,
  documentId: string | null,
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:employee:write");
  await assertSensitiveActionAllowed(
    principal,
    employee.clubId,
    "hr.employee.write.update",
    EMPLOYEE_ENTITY,
    employeeId,
  );
  await assertDocumentOwnedByEmployee(employeeId, documentId, "resumeDocumentId");
  const before = { resumeDocumentId: employee.resumeDocumentId };
  const updated = await prisma.employee.update({
    where: { id: employeeId },
    data: { resumeDocumentId: documentId },
  });
  await audit(principal, {
    action: "hr.employee.write.update",
    entityType: EMPLOYEE_ENTITY,
    entityId: employeeId,
    clubId: employee.clubId,
    before,
    after: { resumeDocumentId: updated.resumeDocumentId },
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Read (single employee, safe payload).
// ---------------------------------------------------------------------------
/**
 * Return the safe Employee payload with masked sensitive references.
 * NEVER returns plaintext SIN / bank / tax. The masked helpers
 * enforce their own permission checks — if the caller lacks
 * hr:sin:read the sinMasked field is null instead of throwing.
 */
export async function getEmployee(
  principal: Principal,
  employeeId: string,
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:employee:read");

  const sinMasked = hasPermission(principal, employee.clubId, "hr:sin:read")
    ? await getSinMasked(principal, employeeId)
    : null;
  const bankMasked = hasPermission(principal, employee.clubId, "hr:banking:read")
    ? await getBankAccountMasked(principal, employeeId)
    : null;
  const taxMasked = hasPermission(principal, employee.clubId, "hr:tax:read")
    ? await getTaxProfileMasked(principal, employeeId)
    : null;

  return {
    id: employee.id,
    clubId: employee.clubId,
    employeeNumber: employee.employeeNumber,
    firstName: employee.firstName,
    lastName: employee.lastName,
    middleName: employee.middleName,
    preferredName: employee.preferredName,
    email: employee.email,
    personalEmail: employee.personalEmail,
    phone: employee.phone,
    mobilePhone: employee.mobilePhone,
    departmentId: employee.departmentId,
    positionId: employee.positionId,
    hireDate: employee.hireDate,
    expectedStartDate: employee.expectedStartDate,
    activatedAt: employee.activatedAt,
    terminationDate: employee.terminationDate,
    status: employee.status,
    employmentType: employee.employmentType,
    employeeLifecycle: employee.employeeLifecycle,
    onboardingState: employee.onboardingState,
    payrollReadiness: employee.payrollReadiness,
    compensationType: employee.compensationType,
    memberId: employee.memberId,
    managerEmployeeId: employee.managerEmployeeId,
    profilePhotoDocumentId: employee.profilePhotoDocumentId,
    resumeDocumentId: employee.resumeDocumentId,
    // Sensitive summaries — pulled through the security-compliance
    // service reads. Never plaintext.
    sinMasked,
    bankMasked: bankMasked
      ? {
          holderName: bankMasked.holderName,
          accountLastFour: bankMasked.accountMasked, // "•••• 3210"
          status: bankMasked.status,
        }
      : null,
    taxMasked,
  };
}

// ---------------------------------------------------------------------------
// List (directory).
// ---------------------------------------------------------------------------
export async function listEmployees(
  principal: Principal,
  clubId: string,
  opts: {
    lifecycle?: string;
    includeTerminated?: boolean;
    /** HR-2B.3.6 (2026-08-19) — Directory filter mode.
     *   "active"   (default) — hide ARCHIVED and TERMINATED (pre-hire + active + leave).
     *   "archived" — only ARCHIVED (and TERMINATED, historical continuity).
     *   "all"      — every lifecycle. */
    directoryScope?: "active" | "archived" | "all";
  } = {},
) {
  requirePermission(principal, clubId, "hr:directory:view");
  if (!isSuperAdmin(principal)) {
    if (!principal.memberships.some((m) => m.clubId === clubId)) {
      throw new TenantViolationError(`no access to club ${clubId}`);
    }
  }
  const where: Record<string, unknown> = { clubId };
  if (opts.lifecycle) {
    where.employeeLifecycle = opts.lifecycle;
  } else {
    const scope = opts.directoryScope ?? (opts.includeTerminated ? "all" : "active");
    if (scope === "active") {
      where.employeeLifecycle = { in: ["PRE_HIRE", "ACTIVE", "LEAVE"] };
    } else if (scope === "archived") {
      where.employeeLifecycle = { in: ["ARCHIVED", "TERMINATED"] };
    }
    // "all" → no lifecycle filter.
  }
  return prisma.employee.findMany({
    where,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
}
