// HR-1 (2026-08-16) — EmployeeTaxProfile service (TD1 tax data
// storage + reveal).
//
// Contract:
//   - Sensitive TD1 fields — federalClaim, provincialClaim,
//     additionalDeductions — are all KMS-encrypted under scope="HR".
//     Non-sensitive metadata (province, td1FormVersion, effectiveFrom,
//     notes) is plaintext for filtering / reporting.
//   - `upsertTaxProfile`: `hr:tax:write` + sensitive-action guard.
//     Encrypts the three claim amounts. Idempotent per (employeeId,
//     effectiveFrom).
//   - `getTaxProfileMasked`: `hr:tax:read`. Returns non-sensitive
//     metadata only. Not audited.
//   - `revealTaxProfile`: `hr:tax:reveal` + sensitive-action guard.
//     Returns plaintext claim amounts. Audit payload carries no
//     numeric values.
//
// The schema allows multiple tax profile rows per employee (indexed on
// [employeeId, effectiveFrom]). We treat the row whose effectiveFrom
// is closest to (but not after) `asOf` as the current profile — see
// `getCurrentTaxProfile()`. Upsert here targets the row with the
// matching effectiveFrom; older rows are left in place as historical
// evidence.

import { randomUUID } from "crypto";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { NotFoundError, ValidationError } from "../errors";
import { assertSensitiveActionAllowed } from "../posting-guard";
import { encryptSecret, decryptSecret } from "../kms";

const TAX_ENTITY = "EmployeeTaxProfile";

// Two-letter Canadian province / territory codes.
const PROVINCE_CODES = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"] as const;
type ProvinceCode = (typeof PROVINCE_CODES)[number];

export interface TaxProfileInput {
  province: string;
  td1FormVersion: string;
  effectiveFrom: Date | string;
  effectiveTo?: Date | string | null;
  federalClaim: string; // dollar amount, canonicalised to fixed-2 string
  provincialClaim: string;
  additionalDeductions?: string | null;
  notes?: string | null;
}

function normaliseMoney(input: string, field: string): string {
  if (typeof input !== "string") {
    throw new ValidationError([{ path: field, message: `${field} must be a string` }]);
  }
  const trimmed = input.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new ValidationError([{ path: field, message: `${field} must be a decimal amount` }]);
  }
  // Canonicalise to fixed-2 so ciphertext for the same amount stays
  // stable across writers.
  const num = Number(trimmed);
  if (!Number.isFinite(num)) {
    throw new ValidationError([{ path: field, message: `${field} is not a finite number` }]);
  }
  return num.toFixed(2);
}

function normaliseDate(input: Date | string, field: string): Date {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError([{ path: field, message: `${field} is not a valid date` }]);
  }
  return d;
}

function federalRef(id: string) { return `tax:${id}:federal`; }
function provincialRef(id: string) { return `tax:${id}:provincial`; }
function additionalRef(id: string) { return `tax:${id}:additional`; }

async function loadEmployee(principal: Principal, employeeId: string) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) throw new NotFoundError("Employee", employeeId);
  assertTenantOwned(employee, principal);
  return employee;
}

/**
 * Create or update the tax profile row identified by
 * (employeeId, effectiveFrom). Older rows are preserved for audit.
 */
export async function upsertTaxProfile(
  principal: Principal,
  employeeId: string,
  input: TaxProfileInput,
): Promise<{ id: string; effectiveFrom: Date; province: string }> {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:tax:write");
  await assertSensitiveActionAllowed(
    principal,
    employee.clubId,
    "hr.tax.write.update",
    TAX_ENTITY,
    employeeId,
  );

  const province = (input.province ?? "").trim().toUpperCase();
  if (!(PROVINCE_CODES as readonly string[]).includes(province)) {
    throw new ValidationError([{ path: "province", message: "province must be a valid Canadian code" }]);
  }
  const td1FormVersion = (input.td1FormVersion ?? "").trim();
  if (!td1FormVersion || td1FormVersion.length < 3) {
    throw new ValidationError([{ path: "td1FormVersion", message: "td1FormVersion is required" }]);
  }
  const effectiveFrom = normaliseDate(input.effectiveFrom, "effectiveFrom");
  const effectiveTo = input.effectiveTo == null ? null : normaliseDate(input.effectiveTo, "effectiveTo");
  const federalClaim = normaliseMoney(input.federalClaim, "federalClaim");
  const provincialClaim = normaliseMoney(input.provincialClaim, "provincialClaim");
  const additionalDeductions = input.additionalDeductions == null
    ? null
    : normaliseMoney(input.additionalDeductions, "additionalDeductions");

  const existing = await prisma.employeeTaxProfile.findFirst({
    where: { employeeId, effectiveFrom },
  });

  const rowId = existing?.id ?? randomUUID();

  const federalCipher = await encryptSecret({
    scope: "HR",
    secretReference: federalRef(rowId),
    plaintext: federalClaim,
    clubId: employee.clubId,
    actorUserId: principal.id,
  });
  const provincialCipher = await encryptSecret({
    scope: "HR",
    secretReference: provincialRef(rowId),
    plaintext: provincialClaim,
    clubId: employee.clubId,
    actorUserId: principal.id,
  });
  const additionalCipher = additionalDeductions == null
    ? null
    : await encryptSecret({
        scope: "HR",
        secretReference: additionalRef(rowId),
        plaintext: additionalDeductions,
        clubId: employee.clubId,
        actorUserId: principal.id,
      });

  const beforeMasked = existing
    ? {
        province: existing.province,
        td1FormVersion: existing.td1FormVersion,
        effectiveFrom: existing.effectiveFrom,
        hasAdditionalDeductions: existing.additionalDeductionSecretRef != null,
      }
    : null;

  let row: { id: string; effectiveFrom: Date; province: string };
  if (existing) {
    const updated = await prisma.employeeTaxProfile.update({
      where: { id: existing.id },
      data: {
        province,
        td1FormVersion,
        effectiveTo,
        federalClaimSecretRef: federalCipher,
        provincialClaimSecretRef: provincialCipher,
        additionalDeductionSecretRef: additionalCipher,
        notes: input.notes ?? existing.notes,
      },
    });
    row = { id: updated.id, effectiveFrom: updated.effectiveFrom, province: updated.province };
  } else {
    const created = await prisma.employeeTaxProfile.create({
      data: {
        id: rowId,
        clubId: employee.clubId,
        employeeId,
        province,
        td1FormVersion,
        effectiveFrom,
        effectiveTo,
        federalClaimSecretRef: federalCipher,
        provincialClaimSecretRef: provincialCipher,
        additionalDeductionSecretRef: additionalCipher,
        notes: input.notes ?? null,
      },
    });
    row = { id: created.id, effectiveFrom: created.effectiveFrom, province: created.province };
  }

  await audit(principal, {
    action: "hr.tax.write.update",
    entityType: TAX_ENTITY,
    entityId: row.id,
    clubId: employee.clubId,
    before: beforeMasked,
    // Never include federalClaim / provincialClaim / additionalDeductions
    // in the audit payload — the generic redactor does NOT cover these
    // keys.
    after: {
      province,
      td1FormVersion,
      effectiveFrom,
      effectiveTo,
      hasAdditionalDeductions: additionalCipher != null,
    },
  });

  return row;
}

/**
 * Return non-sensitive metadata for the CURRENT tax profile (the row
 * with the latest effectiveFrom <= asOf, defaulting to now).
 * Read-only, not audited.
 */
export async function getTaxProfileMasked(
  principal: Principal,
  employeeId: string,
  asOf: Date = new Date(),
): Promise<
  | {
      id: string;
      province: ProvinceCode | string;
      td1FormVersion: string;
      effectiveFrom: Date;
      effectiveTo: Date | null;
      hasAdditionalDeductions: boolean;
    }
  | null
> {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:tax:read");
  const row = await prisma.employeeTaxProfile.findFirst({
    where: { employeeId, effectiveFrom: { lte: asOf } },
    orderBy: { effectiveFrom: "desc" },
  });
  if (!row) return null;
  return {
    id: row.id,
    province: row.province,
    td1FormVersion: row.td1FormVersion,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    hasAdditionalDeductions: row.additionalDeductionSecretRef != null,
  };
}

/**
 * Reveal plaintext claim amounts for a specific tax profile row.
 * Audit payload carries only province + effectiveFrom — never the
 * dollar amounts.
 */
export async function revealTaxProfile(
  principal: Principal,
  taxProfileId: string,
): Promise<{
  federalClaim: string;
  provincialClaim: string;
  additionalDeductions: string | null;
  province: string;
  effectiveFrom: Date;
}> {
  const row = await prisma.employeeTaxProfile.findUnique({ where: { id: taxProfileId } });
  if (!row) throw new NotFoundError(TAX_ENTITY, taxProfileId);
  assertTenantOwned(row, principal);
  requirePermission(principal, row.clubId, "hr:tax:reveal");
  await assertSensitiveActionAllowed(
    principal,
    row.clubId,
    "hr.tax.reveal.issue",
    TAX_ENTITY,
    row.id,
  );

  const [federalClaim, provincialClaim] = await Promise.all([
    decryptSecret({
      scope: "HR",
      secretReference: federalRef(row.id),
      ciphertext: row.federalClaimSecretRef,
      clubId: row.clubId,
      actorUserId: principal.id,
    }),
    decryptSecret({
      scope: "HR",
      secretReference: provincialRef(row.id),
      ciphertext: row.provincialClaimSecretRef,
      clubId: row.clubId,
      actorUserId: principal.id,
    }),
  ]);
  const additionalDeductions = row.additionalDeductionSecretRef
    ? await decryptSecret({
        scope: "HR",
        secretReference: additionalRef(row.id),
        ciphertext: row.additionalDeductionSecretRef,
        clubId: row.clubId,
        actorUserId: principal.id,
      })
    : null;

  await audit(principal, {
    action: "hr.tax.reveal.issue",
    entityType: TAX_ENTITY,
    entityId: row.id,
    clubId: row.clubId,
    meta: {
      province: row.province,
      effectiveFrom: row.effectiveFrom,
      td1FormVersion: row.td1FormVersion,
    },
  });

  return {
    federalClaim,
    provincialClaim,
    additionalDeductions,
    province: row.province,
    effectiveFrom: row.effectiveFrom,
  };
}

