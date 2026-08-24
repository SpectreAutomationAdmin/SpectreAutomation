// HR-2C Portal Refinement (2026-08-24) — Employee Portal self-service.
//
// Called from Employee Portal server actions. Every function:
//   - accepts an EmployeePortalPrincipal (not an admin Principal);
//   - validates the caller owns the target record (own-row only);
//   - tenants by clubId — cross-employee / cross-Club refused with
//     the same-shape NotFoundError so a portal actor cannot
//     enumerate other employees;
//   - audits with actorSource "EMPLOYEE" so payroll / HR
//     reviewers can filter self-service events from admin edits.
//
// Explicitly NOT here (deferred):
//   - Address (needs schema decision — separate slice).
//   - Banking replacement (sensitive; needs its own security review
//     + PENDING_PENNY_TEST lifecycle work — separate slice).
//
// Employees never mutate:
//   - Employee number / position / department / employment type;
//   - Compensation / allowances / manager;
//   - Any admin-authoritative field.
// Those remain Club-authoritative and can only be changed via the
// admin services.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { NotFoundError, ValidationError } from "../errors";
import type { EmployeePortalPrincipal } from "../employee-portal-session";

// ---------------------------------------------------------------------------
// Personal contact — email + mobile phone
// ---------------------------------------------------------------------------

export interface UpdatePersonalContactInput {
  personalEmail?: string | null;
  mobilePhone?: string | null;
}

function normaliseEmail(v: string | null | undefined): string | null {
  if (v == null) return null;
  const s = v.trim();
  if (s.length === 0) return null;
  if (s.length > 254) throw new ValidationError([{ path: "personalEmail", message: "Email must be 254 characters or fewer." }]);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
    throw new ValidationError([{ path: "personalEmail", message: "Please enter a valid email address." }]);
  }
  return s.toLowerCase();
}

function normalisePhone(v: string | null | undefined): string | null {
  if (v == null) return null;
  const s = v.trim();
  if (s.length === 0) return null;
  if (s.length > 32) throw new ValidationError([{ path: "mobilePhone", message: "Phone must be 32 characters or fewer." }]);
  // Accept +country, spaces, dashes, parens — the canonical field is
  // free-form and payroll doesn't consume it for CRA identity.
  if (!/^[+()\-\s\d]{7,32}$/.test(s)) {
    throw new ValidationError([{ path: "mobilePhone", message: "Please enter a valid phone number." }]);
  }
  return s;
}

export async function updateSelfPersonalContact(
  actor: EmployeePortalPrincipal,
  input: UpdatePersonalContactInput,
): Promise<void> {
  const emp = await prisma.employee.findFirst({
    where: { id: actor.employeeId, clubId: actor.clubId },
    select: { id: true, clubId: true, personalEmail: true, mobilePhone: true },
  });
  if (!emp) throw new NotFoundError("Employee", actor.employeeId);

  const data: Record<string, unknown> = {};
  if (input.personalEmail !== undefined) data.personalEmail = normaliseEmail(input.personalEmail);
  if (input.mobilePhone !== undefined) data.mobilePhone = normalisePhone(input.mobilePhone);
  if (Object.keys(data).length === 0) return;

  await prisma.employee.update({ where: { id: emp.id }, data });
  await audit(null, {
    action: "hr.employee.self_service.personal_contact.update",
    entityType: "Employee",
    entityId: emp.id,
    clubId: emp.clubId,
    before: { personalEmail: emp.personalEmail, mobilePhone: emp.mobilePhone },
    after: { ...data, actorSource: "EMPLOYEE", employeeIdTail: emp.id.slice(-8) },
  });
}

// ---------------------------------------------------------------------------
// Emergency contact — primary only (portal MVP)
// ---------------------------------------------------------------------------
//
// The admin service already supports multiple contacts. The portal
// self-service surface exposes ONE primary contact so the employee
// UI stays simple. If the employee has no primary contact yet, this
// creates one (and marks it primary). If they have one, this updates
// it in place.

export interface UpdateSelfEmergencyContactInput {
  name: string;
  relation: string;
  phone: string;
  email?: string | null;
}

function normaliseContactField(v: string, field: string, max: number): string {
  const s = v.trim();
  if (s.length === 0) throw new ValidationError([{ path: field, message: `${field} is required.` }]);
  if (s.length > max) throw new ValidationError([{ path: field, message: `${field} must be ${max} characters or fewer.` }]);
  return s;
}

function normaliseContactEmail(v: string | null | undefined): string | null {
  if (v == null) return null;
  const s = v.trim();
  if (s.length === 0) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
    throw new ValidationError([{ path: "email", message: "Please enter a valid email address." }]);
  }
  return s.toLowerCase();
}

export async function upsertSelfPrimaryEmergencyContact(
  actor: EmployeePortalPrincipal,
  input: UpdateSelfEmergencyContactInput,
): Promise<{ id: string }> {
  const emp = await prisma.employee.findFirst({
    where: { id: actor.employeeId, clubId: actor.clubId },
    select: { id: true, clubId: true },
  });
  if (!emp) throw new NotFoundError("Employee", actor.employeeId);

  const name = normaliseContactField(input.name, "name", 120);
  const relation = normaliseContactField(input.relation, "relation", 60);
  const phone = normaliseContactField(input.phone, "phone", 32);
  if (!/^[+()\-\s\d]{7,32}$/.test(phone)) {
    throw new ValidationError([{ path: "phone", message: "Please enter a valid phone number." }]);
  }
  const email = normaliseContactEmail(input.email);

  const existingPrimary = await prisma.employeeEmergencyContact.findFirst({
    where: { employeeId: emp.id, clubId: emp.clubId, isPrimary: true },
    select: { id: true, name: true, relation: true, phone: true, email: true },
  });

  const row = existingPrimary
    ? await prisma.employeeEmergencyContact.update({
        where: { id: existingPrimary.id },
        data: { name, relation, phone, email },
      })
    : await prisma.employeeEmergencyContact.create({
        data: {
          clubId: emp.clubId, employeeId: emp.id,
          name, relation, phone, email, isPrimary: true,
        },
      });

  await audit(null, {
    action: existingPrimary
      ? "hr.emergency_contact.self_service.update"
      : "hr.emergency_contact.self_service.create",
    entityType: "EmployeeEmergencyContact",
    entityId: row.id,
    clubId: emp.clubId,
    before: existingPrimary,
    after: {
      // Only field NAMES in the after payload — phone/email were
      // supplied by the employee themselves so they aren't leaked
      // here beyond the row already recording them.
      changedFields: Object.keys(input),
      actorSource: "EMPLOYEE",
      employeeIdTail: emp.id.slice(-8),
    },
  });
  return { id: row.id };
}

export async function getSelfPrimaryEmergencyContact(
  actor: EmployeePortalPrincipal,
): Promise<{ id: string; name: string; relation: string; phone: string; email: string | null } | null> {
  const row = await prisma.employeeEmergencyContact.findFirst({
    where: { employeeId: actor.employeeId, clubId: actor.clubId, isPrimary: true },
    select: { id: true, name: true, relation: true, phone: true, email: true },
  });
  return row;
}
