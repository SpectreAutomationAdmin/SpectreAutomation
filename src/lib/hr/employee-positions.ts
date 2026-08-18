// HR-2B.3.1 (2026-08-18) §4 — canonical EmployeePosition service.
//
// The HR-1 canonical services own every Employee-related write path
// (createEmployee, uploadEmployeeDocument, setProfilePhoto, …). Prior
// to this slice, position catalogue maintenance was a raw Prisma
// concern handled either by seed scripts (`prisma/seed.ts`) or by
// direct read from `AddEmployeePage`'s loader. This module lands the
// canonical wrapper so admin add-position flows share the same RBAC +
// audit + tenant discipline as every other HR write.
//
// Contract:
//   - Reads: `hr:directory:view` (catalogue is metadata, not sensitive).
//   - Writes (create / update / activate / deactivate):
//     `hr:employee:write` + sensitive-action guard. There is no
//     dedicated `hr:positions:write` in the permission catalogue —
//     the founder brief §4 defers that separation, and the closest
//     existing grant (positions ARE employee configuration) is
//     `hr:employee:write` (CLUB_ADMIN + SUPER_ADMIN).
//
// Every action string ends in a WRITE_INDICATOR verb (`update`) so
// support-readonly + posting-guard substring gates fire correctly.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { assertSensitiveActionAllowed } from "../posting-guard";

const POSITION_ENTITY = "EmployeePosition";

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------
export async function listEmployeePositions(
  principal: Principal,
  clubId: string,
  opts: { includeInactive?: boolean } = {},
) {
  requirePermission(principal, clubId, "hr:directory:view");
  const where: Record<string, unknown> = { clubId };
  if (!opts.includeInactive) where.isActive = true;
  return prisma.employeePosition.findMany({
    where,
    orderBy: { name: "asc" },
    select: {
      id: true,
      code: true,
      name: true,
      defaultPayRate: true,
      isExempt: true,
      isActive: true,
      createdAt: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Create.
// ---------------------------------------------------------------------------
export interface CreateEmployeePositionInput {
  name: string;
  code?: string;
  defaultPayRate?: number;
  isExempt?: boolean;
}

/**
 * Derive a canonical code from a free-form name when the operator did
 * not supply one. Uppercase ASCII letters + digits only, joined with
 * underscores, truncated to 32 chars — matches the shape the seed
 * scripts use (`GREENSKEEPER`, `SERVER`, `ADMIN_ASST`).
 */
function deriveCode(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .toUpperCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join("_")
    .slice(0, 32);
  return cleaned || "POSITION";
}

async function ensureUniqueCode(clubId: string, base: string): Promise<string> {
  const existing = await prisma.employeePosition.findFirst({
    where: { clubId, code: base },
    select: { id: true },
  });
  if (!existing) return base;
  // Suffix -N until the (clubId, code) unique constraint is
  // satisfied. Bounded loop — 99 attempts is overkill but survives
  // adversarial names like "Server".
  for (let n = 2; n <= 99; n += 1) {
    const candidate = `${base.slice(0, 32 - String(n).length - 1)}_${n}`;
    const clash = await prisma.employeePosition.findFirst({
      where: { clubId, code: candidate },
      select: { id: true },
    });
    if (!clash) return candidate;
  }
  throw new ConflictError(`Could not derive a unique code from ${base}`);
}

export async function createEmployeePosition(
  principal: Principal,
  clubId: string,
  input: CreateEmployeePositionInput,
) {
  requirePermission(principal, clubId, "hr:employee:write");
  await assertSensitiveActionAllowed(
    principal,
    clubId,
    "hr.position.write.update",
    POSITION_ENTITY,
    "new",
  );

  const name = (input.name ?? "").trim();
  if (!name) {
    throw new ValidationError([{ path: "name", message: "required" }]);
  }
  if (name.length > 80) {
    throw new ValidationError([{ path: "name", message: "must be 80 chars or fewer" }]);
  }
  const rawCode = (input.code ?? "").trim().toUpperCase();
  const baseCode = rawCode ? rawCode.replace(/[^A-Z0-9_]/g, "_").slice(0, 32) : deriveCode(name);
  if (!baseCode) {
    throw new ValidationError([{ path: "code", message: "could not derive a code from the name" }]);
  }
  const code = await ensureUniqueCode(clubId, baseCode);

  const defaultPayRate = input.defaultPayRate ?? 0;
  if (!Number.isFinite(defaultPayRate) || defaultPayRate < 0) {
    throw new ValidationError([{ path: "defaultPayRate", message: "must be a non-negative number" }]);
  }

  const created = await prisma.employeePosition.create({
    data: {
      clubId,
      code,
      name,
      defaultPayRate,
      isExempt: input.isExempt ?? false,
      isActive: true,
    },
  });

  await audit(principal, {
    action: "hr.position.write.update",
    entityType: POSITION_ENTITY,
    entityId: created.id,
    clubId,
    after: {
      id: created.id,
      code: created.code,
      name: created.name,
      defaultPayRate: created.defaultPayRate.toString(),
      isExempt: created.isExempt,
      isActive: created.isActive,
    },
  });

  return created;
}

// ---------------------------------------------------------------------------
// Update.
// ---------------------------------------------------------------------------
export interface UpdateEmployeePositionInput {
  name?: string;
  defaultPayRate?: number;
  isExempt?: boolean;
  isActive?: boolean;
}

export async function updateEmployeePosition(
  principal: Principal,
  positionId: string,
  input: UpdateEmployeePositionInput,
) {
  const position = await prisma.employeePosition.findUnique({ where: { id: positionId } });
  if (!position) throw new NotFoundError(POSITION_ENTITY, positionId);
  assertTenantOwned(position, principal);
  requirePermission(principal, position.clubId, "hr:employee:write");
  await assertSensitiveActionAllowed(
    principal,
    position.clubId,
    "hr.position.write.update",
    POSITION_ENTITY,
    positionId,
  );

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const n = input.name.trim();
    if (!n) throw new ValidationError([{ path: "name", message: "required" }]);
    if (n.length > 80) throw new ValidationError([{ path: "name", message: "must be 80 chars or fewer" }]);
    data.name = n;
  }
  if (input.defaultPayRate !== undefined) {
    if (!Number.isFinite(input.defaultPayRate) || input.defaultPayRate < 0) {
      throw new ValidationError([{ path: "defaultPayRate", message: "must be a non-negative number" }]);
    }
    data.defaultPayRate = input.defaultPayRate;
  }
  if (input.isExempt !== undefined) data.isExempt = input.isExempt;
  if (input.isActive !== undefined) data.isActive = input.isActive;

  const updated = await prisma.employeePosition.update({
    where: { id: positionId },
    data,
  });

  await audit(principal, {
    action: "hr.position.write.update",
    entityType: POSITION_ENTITY,
    entityId: positionId,
    clubId: position.clubId,
    before: {
      name: position.name,
      defaultPayRate: position.defaultPayRate.toString(),
      isExempt: position.isExempt,
      isActive: position.isActive,
    },
    after: {
      name: updated.name,
      defaultPayRate: updated.defaultPayRate.toString(),
      isExempt: updated.isExempt,
      isActive: updated.isActive,
    },
  });

  return updated;
}
