// HR-1 (2026-08-16) — EmployeeCredential service (professional
// certifications, licenses; expiry, issuer).
//
// Contract:
//   - Reads: `hr:credentials:read`.
//   - Writes: `hr:credentials:write` + sensitive-action guard.
//   - Optional `documentId` MUST reference an EmployeeDocument
//     belonging to the same employee (validated).

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { NotFoundError, ValidationError } from "../errors";
import { assertSensitiveActionAllowed } from "../posting-guard";

const CREDENTIAL_ENTITY = "EmployeeCredential";

async function loadEmployee(principal: Principal, employeeId: string) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) throw new NotFoundError("Employee", employeeId);
  assertTenantOwned(employee, principal);
  return employee;
}

function normDate(v: Date | string | null | undefined, field: string): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError([{ path: field, message: `${field} is not a valid date` }]);
  }
  return d;
}

async function assertDocumentOwnedByEmployee(employeeId: string, documentId: string | null | undefined) {
  if (!documentId) return;
  const doc = await prisma.employeeDocument.findUnique({ where: { id: documentId } });
  if (!doc) throw new NotFoundError("EmployeeDocument", documentId);
  if (doc.employeeId !== employeeId) {
    throw new ValidationError([{
      path: "documentId",
      message: `document ${documentId} does not belong to employee ${employeeId}`,
    }]);
  }
}

export interface CreateCredentialInput {
  credentialCode: string;
  displayName: string;
  issuer?: string | null;
  reference?: string | null;
  issuedAt?: Date | string | null;
  expiresAt?: Date | string | null;
  documentId?: string | null;
  notes?: string | null;
}

export async function createCredential(
  principal: Principal,
  employeeId: string,
  input: CreateCredentialInput,
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:credentials:write");
  await assertSensitiveActionAllowed(
    principal,
    employee.clubId,
    "hr.credential.write.update",
    CREDENTIAL_ENTITY,
    employeeId,
  );

  const credentialCode = (input.credentialCode ?? "").trim();
  const displayName = (input.displayName ?? "").trim();
  if (!credentialCode) throw new ValidationError([{ path: "credentialCode", message: "required" }]);
  if (!displayName) throw new ValidationError([{ path: "displayName", message: "required" }]);
  await assertDocumentOwnedByEmployee(employeeId, input.documentId ?? null);

  const created = await prisma.employeeCredential.create({
    data: {
      clubId: employee.clubId,
      employeeId,
      credentialCode,
      displayName,
      issuer: input.issuer ?? null,
      reference: input.reference ?? null,
      issuedAt: normDate(input.issuedAt, "issuedAt"),
      expiresAt: normDate(input.expiresAt, "expiresAt"),
      documentId: input.documentId ?? null,
      notes: input.notes ?? null,
    },
  });

  await audit(principal, {
    action: "hr.credential.write.update",
    entityType: CREDENTIAL_ENTITY,
    entityId: created.id,
    clubId: employee.clubId,
    after: {
      id: created.id,
      credentialCode: created.credentialCode,
      displayName: created.displayName,
      issuedAt: created.issuedAt,
      expiresAt: created.expiresAt,
    },
  });

  return created;
}

export interface UpdateCredentialInput {
  displayName?: string;
  issuer?: string | null;
  reference?: string | null;
  issuedAt?: Date | string | null;
  expiresAt?: Date | string | null;
  documentId?: string | null;
  notes?: string | null;
}

export async function updateCredential(
  principal: Principal,
  credentialId: string,
  input: UpdateCredentialInput,
) {
  const row = await prisma.employeeCredential.findUnique({ where: { id: credentialId } });
  if (!row) throw new NotFoundError(CREDENTIAL_ENTITY, credentialId);
  assertTenantOwned(row, principal);
  requirePermission(principal, row.clubId, "hr:credentials:write");
  await assertSensitiveActionAllowed(
    principal,
    row.clubId,
    "hr.credential.write.update",
    CREDENTIAL_ENTITY,
    credentialId,
  );

  if (input.documentId !== undefined) {
    await assertDocumentOwnedByEmployee(row.employeeId, input.documentId ?? null);
  }

  const data: Record<string, unknown> = {};
  if (input.displayName !== undefined) data.displayName = input.displayName;
  if (input.issuer !== undefined) data.issuer = input.issuer;
  if (input.reference !== undefined) data.reference = input.reference;
  if (input.issuedAt !== undefined) data.issuedAt = normDate(input.issuedAt, "issuedAt");
  if (input.expiresAt !== undefined) data.expiresAt = normDate(input.expiresAt, "expiresAt");
  if (input.documentId !== undefined) data.documentId = input.documentId;
  if (input.notes !== undefined) data.notes = input.notes;

  const updated = await prisma.employeeCredential.update({ where: { id: credentialId }, data });

  await audit(principal, {
    action: "hr.credential.write.update",
    entityType: CREDENTIAL_ENTITY,
    entityId: credentialId,
    clubId: row.clubId,
    before: {
      displayName: row.displayName,
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
    },
    after: {
      displayName: updated.displayName,
      issuedAt: updated.issuedAt,
      expiresAt: updated.expiresAt,
    },
  });

  return updated;
}

export async function deleteCredential(
  principal: Principal,
  credentialId: string,
) {
  const row = await prisma.employeeCredential.findUnique({ where: { id: credentialId } });
  if (!row) throw new NotFoundError(CREDENTIAL_ENTITY, credentialId);
  assertTenantOwned(row, principal);
  requirePermission(principal, row.clubId, "hr:credentials:write");
  await assertSensitiveActionAllowed(
    principal,
    row.clubId,
    "hr.credential.delete",
    CREDENTIAL_ENTITY,
    credentialId,
  );

  await prisma.employeeCredential.delete({ where: { id: credentialId } });

  await audit(principal, {
    action: "hr.credential.delete",
    entityType: CREDENTIAL_ENTITY,
    entityId: credentialId,
    clubId: row.clubId,
    before: {
      credentialCode: row.credentialCode,
      displayName: row.displayName,
    },
    after: null,
  });
}

export async function listCredentials(
  principal: Principal,
  employeeId: string,
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:credentials:read");
  return prisma.employeeCredential.findMany({
    where: { employeeId },
    orderBy: [{ expiresAt: "asc" }, { credentialCode: "asc" }],
  });
}
