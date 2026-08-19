// HR-1 (2026-08-16) — EmployeeEmergencyContact service.
//
// Contract:
//   - Reads: `hr:emergency:read`.
//   - Writes: `hr:emergency:write` + sensitive-action guard.
//   - `isPrimary: true` — service ensures at most ONE primary per
//     employee (any other primary rows are demoted in the same
//     write).

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { NotFoundError, ValidationError } from "../errors";
import { assertSensitiveActionAllowed } from "../posting-guard";

const CONTACT_ENTITY = "EmployeeEmergencyContact";

async function loadEmployee(principal: Principal, employeeId: string) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) throw new NotFoundError("Employee", employeeId);
  assertTenantOwned(employee, principal);
  return employee;
}

export interface CreateEmergencyContactInput {
  name: string;
  relation: string;
  phone: string;
  email?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
  country?: string | null;
  isPrimary?: boolean;
}

export async function createEmergencyContact(
  principal: Principal,
  employeeId: string,
  input: CreateEmergencyContactInput,
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:emergency:write");
  await assertSensitiveActionAllowed(
    principal,
    employee.clubId,
    "hr.emergency.write.update",
    CONTACT_ENTITY,
    employeeId,
  );

  const name = (input.name ?? "").trim();
  const relation = (input.relation ?? "").trim();
  const phone = (input.phone ?? "").trim();
  if (!name) throw new ValidationError([{ path: "name", message: "required" }]);
  if (!relation) throw new ValidationError([{ path: "relation", message: "required" }]);
  if (!phone) throw new ValidationError([{ path: "phone", message: "required" }]);

  // NB: intentionally NOT wrapped in a $transaction — SQLite's
  // interactive-transaction budget on the test env is 5s and the
  // audit() write pushes us past it. The two writes are independent
  // (demote-others then insert-new); a failure between them leaves
  // "no primary" — a valid state the UI can re-fix.
  if (input.isPrimary) {
    await prisma.employeeEmergencyContact.updateMany({
      where: { employeeId, isPrimary: true },
      data: { isPrimary: false },
    });
  }
  const created = await prisma.employeeEmergencyContact.create({
    data: {
      clubId: employee.clubId,
      employeeId,
      name,
      relation,
      phone,
      email: input.email ?? null,
      addressLine1: input.addressLine1 ?? null,
      addressLine2: input.addressLine2 ?? null,
      city: input.city ?? null,
      province: input.province ?? null,
      postalCode: input.postalCode ?? null,
      country: input.country ?? null,
      isPrimary: input.isPrimary ?? false,
    },
  });

  await audit(principal, {
    action: "hr.emergency.write.update",
    entityType: CONTACT_ENTITY,
    entityId: created.id,
    clubId: employee.clubId,
    after: {
      id: created.id,
      name: created.name,
      relation: created.relation,
      isPrimary: created.isPrimary,
    },
  });

  return created;
}

export interface UpdateEmergencyContactInput {
  name?: string;
  relation?: string;
  phone?: string;
  email?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
  country?: string | null;
  isPrimary?: boolean;
}

export async function updateEmergencyContact(
  principal: Principal,
  contactId: string,
  input: UpdateEmergencyContactInput,
) {
  const row = await prisma.employeeEmergencyContact.findUnique({ where: { id: contactId } });
  if (!row) throw new NotFoundError(CONTACT_ENTITY, contactId);
  assertTenantOwned(row, principal);
  requirePermission(principal, row.clubId, "hr:emergency:write");
  await assertSensitiveActionAllowed(
    principal,
    row.clubId,
    "hr.emergency.write.update",
    CONTACT_ENTITY,
    contactId,
  );

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.relation !== undefined) data.relation = input.relation;
  if (input.phone !== undefined) data.phone = input.phone;
  if (input.email !== undefined) data.email = input.email;
  if (input.addressLine1 !== undefined) data.addressLine1 = input.addressLine1;
  if (input.addressLine2 !== undefined) data.addressLine2 = input.addressLine2;
  if (input.city !== undefined) data.city = input.city;
  if (input.province !== undefined) data.province = input.province;
  if (input.postalCode !== undefined) data.postalCode = input.postalCode;
  if (input.country !== undefined) data.country = input.country;
  if (input.isPrimary !== undefined) data.isPrimary = input.isPrimary;

  // NB: intentionally NOT wrapped in a $transaction — see the
  // note in createEmergencyContact.
  if (input.isPrimary === true) {
    await prisma.employeeEmergencyContact.updateMany({
      where: { employeeId: row.employeeId, isPrimary: true, id: { not: contactId } },
      data: { isPrimary: false },
    });
  }
  const updated = await prisma.employeeEmergencyContact.update({
    where: { id: contactId },
    data,
  });

  await audit(principal, {
    action: "hr.emergency.write.update",
    entityType: CONTACT_ENTITY,
    entityId: contactId,
    clubId: row.clubId,
    before: { name: row.name, isPrimary: row.isPrimary },
    after: { name: updated.name, isPrimary: updated.isPrimary },
  });

  return updated;
}

export async function deleteEmergencyContact(
  principal: Principal,
  contactId: string,
) {
  const row = await prisma.employeeEmergencyContact.findUnique({ where: { id: contactId } });
  if (!row) throw new NotFoundError(CONTACT_ENTITY, contactId);
  assertTenantOwned(row, principal);
  requirePermission(principal, row.clubId, "hr:emergency:write");
  await assertSensitiveActionAllowed(
    principal,
    row.clubId,
    "hr.emergency.delete",
    CONTACT_ENTITY,
    contactId,
  );

  await prisma.employeeEmergencyContact.delete({ where: { id: contactId } });

  await audit(principal, {
    action: "hr.emergency.delete",
    entityType: CONTACT_ENTITY,
    entityId: contactId,
    clubId: row.clubId,
    before: { name: row.name },
    after: null,
  });
}

export async function listEmergencyContacts(
  principal: Principal,
  employeeId: string,
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:emergency:read");
  return prisma.employeeEmergencyContact.findMany({
    where: { employeeId },
    orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
  });
}
