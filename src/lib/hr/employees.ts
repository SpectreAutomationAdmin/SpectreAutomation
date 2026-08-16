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
import { getSinMasked } from "./sensitive-identity";
import { getBankAccountMasked } from "./bank-account";
import { getTaxProfileMasked } from "./tax-profile";

const EMPLOYEE_ENTITY = "Employee";

const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "SEASONAL", "CONTRACT"] as const;
const LIFECYCLES = ["PRE_HIRE", "ACTIVE", "LEAVE", "TERMINATED"] as const;
const COMPENSATION_TYPES = ["HOURLY", "SALARY", "COMMISSION", "PIECE_RATE"] as const;

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
  opts: { lifecycle?: string; includeTerminated?: boolean } = {},
) {
  requirePermission(principal, clubId, "hr:directory:view");
  if (!isSuperAdmin(principal)) {
    if (!principal.memberships.some((m) => m.clubId === clubId)) {
      throw new TenantViolationError(`no access to club ${clubId}`);
    }
  }
  const where: Record<string, unknown> = { clubId };
  if (opts.lifecycle) where.employeeLifecycle = opts.lifecycle;
  if (!opts.includeTerminated) {
    where.employeeLifecycle = where.employeeLifecycle ?? { not: "TERMINATED" };
  }
  return prisma.employee.findMany({
    where,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
}
