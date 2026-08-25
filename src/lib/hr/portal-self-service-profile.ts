// HR-2C Portal Refinement (2026-08-24 / expanded 2026-08-28) — Employee
// Portal self-service.
//
// Called from Employee Portal server actions. Every function:
//   - accepts an EmployeePortalPrincipal (not an admin Principal);
//   - validates the caller owns the target record (own-row only);
//   - tenants by clubId — cross-employee / cross-Club refused with
//     the same-shape NotFoundError so a portal actor cannot
//     enumerate other employees;
//   - audits with actorSource "EMPLOYEE" so payroll / HR reviewers can
//     filter self-service events from admin edits.
//
// Banking replacement composes the canonical HR-1H helpers in
// `employee-self-service.ts` (`submitSelfBankAccount`,
// `getSelfBankAccountMasked`). No duplicated write path — the portal
// caller structurally satisfies `EmployeeSelfServiceActor`, so history
// preservation (existing VERIFIED → INACTIVE, new → PENDING_PENNY_TEST)
// is guaranteed to match onboarding behaviour.
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
import {
  submitSelfBankAccount as canonicalSubmitSelfBankAccount,
  getSelfBankAccountMasked as canonicalGetSelfBankAccountMasked,
  type SelfBankAccountInput,
} from "./employee-self-service";

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
// Home / mailing address
// ---------------------------------------------------------------------------

export interface UpdateHomeAddressInput {
  homeAddressLine1?: string | null;
  homeAddressLine2?: string | null;
  homeCity?: string | null;
  homeProvince?: string | null;
  homePostalCode?: string | null;
  homeCountry?: string | null;
}

function trimOrNull(v: string | null | undefined, field: string, max: number): string | null {
  if (v == null) return null;
  const s = v.trim();
  if (s.length === 0) return null;
  if (s.length > max) throw new ValidationError([{ path: field, message: `${field} must be ${max} characters or fewer.` }]);
  return s;
}

function normaliseProvince(v: string | null | undefined): string | null {
  const s = trimOrNull(v, "homeProvince", 32);
  if (s == null) return null;
  return s.toUpperCase();
}

function normaliseCountry(v: string | null | undefined): string | null {
  const s = trimOrNull(v, "homeCountry", 2);
  if (s == null) return null;
  if (!/^[A-Za-z]{2}$/.test(s)) {
    throw new ValidationError([{ path: "homeCountry", message: "Country must be a 2-letter code (e.g. CA)." }]);
  }
  return s.toUpperCase();
}

function normalisePostalCode(v: string | null | undefined): string | null {
  const s = trimOrNull(v, "homePostalCode", 16);
  if (s == null) return null;
  return s.toUpperCase();
}

export interface SelfHomeAddress {
  homeAddressLine1: string | null;
  homeAddressLine2: string | null;
  homeCity: string | null;
  homeProvince: string | null;
  homePostalCode: string | null;
  homeCountry: string | null;
}

export async function getSelfHomeAddress(
  actor: EmployeePortalPrincipal,
): Promise<SelfHomeAddress> {
  const emp = await prisma.employee.findFirst({
    where: { id: actor.employeeId, clubId: actor.clubId },
    select: {
      homeAddressLine1: true, homeAddressLine2: true, homeCity: true,
      homeProvince: true, homePostalCode: true, homeCountry: true,
    },
  });
  if (!emp) throw new NotFoundError("Employee", actor.employeeId);
  return emp;
}

export async function updateSelfHomeAddress(
  actor: EmployeePortalPrincipal,
  input: UpdateHomeAddressInput,
): Promise<void> {
  const emp = await prisma.employee.findFirst({
    where: { id: actor.employeeId, clubId: actor.clubId },
    select: {
      id: true, clubId: true,
      homeAddressLine1: true, homeAddressLine2: true, homeCity: true,
      homeProvince: true, homePostalCode: true, homeCountry: true,
    },
  });
  if (!emp) throw new NotFoundError("Employee", actor.employeeId);

  const data: Record<string, string | null> = {};
  if (input.homeAddressLine1 !== undefined) data.homeAddressLine1 = trimOrNull(input.homeAddressLine1, "homeAddressLine1", 200);
  if (input.homeAddressLine2 !== undefined) data.homeAddressLine2 = trimOrNull(input.homeAddressLine2, "homeAddressLine2", 200);
  if (input.homeCity !== undefined) data.homeCity = trimOrNull(input.homeCity, "homeCity", 100);
  if (input.homeProvince !== undefined) data.homeProvince = normaliseProvince(input.homeProvince);
  if (input.homePostalCode !== undefined) data.homePostalCode = normalisePostalCode(input.homePostalCode);
  if (input.homeCountry !== undefined) data.homeCountry = normaliseCountry(input.homeCountry);
  if (Object.keys(data).length === 0) return;

  await prisma.employee.update({ where: { id: emp.id }, data });
  await audit(null, {
    action: "hr.employee.self_service.home_address.update",
    entityType: "Employee",
    entityId: emp.id,
    clubId: emp.clubId,
    before: {
      // Field NAMES only in before/after — the raw values are already
      // on the row; not restating them in the audit payload avoids
      // duplicating a person's address across the audit stream.
      changedFields: Object.keys(data),
    },
    after: {
      changedFields: Object.keys(data),
      actorSource: "EMPLOYEE",
      employeeIdTail: emp.id.slice(-8),
    },
  });

  // HR mobile-hotfix (2026-08-30) §3 — notify HR admins with
  // employee:read. Portal principal → actorSource EMPLOYEE.
  const { notifyHrChangeByEmployeeId } = await import("./notify-hr-change");
  await notifyHrChangeByEmployeeId(emp.clubId, emp.id, "home_address_updated", "EMPLOYEE");
}

// ---------------------------------------------------------------------------
// Emergency contact — primary only (portal MVP)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Direct deposit — masked read + secure replacement.
// ---------------------------------------------------------------------------
//
// Composes the CANONICAL HR-1H banking pipeline in
// `employee-self-service.ts`. That module:
//   - encrypts every secret through the KMS scope="HR" pipeline;
//   - preserves history (VERIFIED → INACTIVE + new PENDING_PENNY_TEST);
//   - refuses to fabricate status=VERIFIED (the DB partial-unique
//     index enforces the invariant even if a caller drifted);
//   - audits with masked values only — plaintext never enters the
//     audit stream.
//
// The portal never touches EmployeeBankAccount directly. Every call
// goes through the canonical service so admin + portal + onboarding
// share ONE write path with ONE lifecycle.

export interface SubmitSelfBankInput {
  holderName: string;
  institutionNumber: string;
  transitNumber: string;
  accountNumber: string;
}

export interface SelfBankMaskedView {
  id: string;
  accountMasked: string;
  holderName: string;
  status: string;
}

export async function getSelfBankMasked(
  actor: EmployeePortalPrincipal,
): Promise<SelfBankMaskedView | null> {
  return canonicalGetSelfBankAccountMasked(actor);
}

export async function submitSelfBankReplacement(
  actor: EmployeePortalPrincipal,
  input: SubmitSelfBankInput,
): Promise<SelfBankMaskedView> {
  // Delegate to the canonical HR-1H writer. Structural typing lets us
  // pass the portal principal directly — the canonical function reads
  // only `.employeeId` and `.clubId`, and its own asserts refuse
  // cross-employee / cross-tenant writes independently.
  const result = await canonicalSubmitSelfBankAccount(
    actor,
    input satisfies SelfBankAccountInput,
  );
  return result;
}
