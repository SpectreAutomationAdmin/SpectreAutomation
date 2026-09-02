// TA-1C (2026-09-04) — Organizational structure services.
//
// Provides the graph operations that stack on top of TA-1B's identity
// foundation: reporting relationships between UserClubProfile rows +
// the OrganizationalPosition catalogue per Club.
//
// Governing rules:
//   - Reporting relationships are TENANT-SCOPED. A profile may only
//     report to another profile at the SAME Club. A person may report
//     to different people in different Clubs (multi-club invariant).
//   - No cycles: A cannot report to A; no A → B → A; no A → B → C → A.
//   - Self-transfer refused. Inactive manager refused.
//   - Position library is per-Club, Club-defined free-form names.
//   - Access role (UserClubRole.roleKey) is UNCHANGED by any of these
//     operations — organizational structure is display + routing input,
//     never authorization.
//   - All writes tenant-authorised via profile.ts assertTenantUsersWrite.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { z } from "zod";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../errors";
import type { Principal } from "../rbac";
import type { Prisma, PrismaClient } from "@prisma/client";
import { assertTenantUsersWrite } from "./profile";

type Tx = Prisma.TransactionClient | PrismaClient;

// ---------------------------------------------------------------------
// Organizational Position (per-Club title catalogue)
// ---------------------------------------------------------------------

export const upsertPositionSchema = z.object({
  clubId: z.string().min(1),
  name: z.string().min(1).max(120),
  departmentId: z.string().optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

export async function listPositions(clubId: string, opts?: { includeInactive?: boolean }) {
  return prisma.organizationalPosition.findMany({
    where: { clubId, ...(opts?.includeInactive ? {} : { isActive: true }) },
    include: { department: { select: { id: true, name: true, code: true } } },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}

export async function createPosition(principal: Principal, raw: unknown) {
  const parsed = upsertPositionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  const input = parsed.data;
  await assertTenantUsersWrite(principal, input.clubId);
  if (input.departmentId) {
    const dept = await prisma.department.findUnique({ where: { id: input.departmentId }, select: { clubId: true } });
    if (!dept) throw new NotFoundError("Department", input.departmentId);
    if (dept.clubId !== input.clubId) {
      throw new ForbiddenError("Department belongs to a different club.");
    }
  }
  const dup = await prisma.organizationalPosition.findFirst({
    where: { clubId: input.clubId, name: input.name },
  });
  if (dup) throw new ConflictError(`A position named "${input.name}" already exists at this Club.`);

  const created = await prisma.organizationalPosition.create({
    data: {
      clubId: input.clubId,
      name: input.name.trim(),
      departmentId: input.departmentId ?? null,
      description: input.description ?? null,
      sortOrder: input.sortOrder ?? 0,
      createdByUserId: principal.id,
    },
  });
  await audit(principal, {
    clubId: input.clubId,
    action: "organizational.position.created",
    entityType: "OrganizationalPosition",
    entityId: created.id,
    after: { name: created.name, departmentId: created.departmentId ?? null },
  });
  return created;
}

export async function updatePosition(principal: Principal, positionId: string, raw: unknown) {
  const parsed = upsertPositionSchema.partial({ clubId: true }).safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  const existing = await prisma.organizationalPosition.findUnique({ where: { id: positionId } });
  if (!existing) throw new NotFoundError("OrganizationalPosition", positionId);
  await assertTenantUsersWrite(principal, existing.clubId);
  const input = parsed.data;
  if (input.departmentId !== undefined && input.departmentId !== null) {
    const dept = await prisma.department.findUnique({ where: { id: input.departmentId }, select: { clubId: true } });
    if (!dept) throw new NotFoundError("Department", input.departmentId);
    if (dept.clubId !== existing.clubId) {
      throw new ForbiddenError("Department belongs to a different club.");
    }
  }
  if (input.name && input.name !== existing.name) {
    const dup = await prisma.organizationalPosition.findFirst({
      where: { clubId: existing.clubId, name: input.name, id: { not: positionId } },
    });
    if (dup) throw new ConflictError(`A position named "${input.name}" already exists at this Club.`);
  }
  const updated = await prisma.organizationalPosition.update({
    where: { id: positionId },
    data: {
      ...(input.name != null ? { name: input.name.trim() } : {}),
      ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
    },
  });
  await audit(principal, {
    clubId: existing.clubId,
    action: "organizational.position.updated",
    entityType: "OrganizationalPosition",
    entityId: positionId,
    before: { name: existing.name, departmentId: existing.departmentId, sortOrder: existing.sortOrder },
    after: { name: updated.name, departmentId: updated.departmentId, sortOrder: updated.sortOrder },
  });
  return updated;
}

export async function archivePosition(principal: Principal, positionId: string) {
  const existing = await prisma.organizationalPosition.findUnique({ where: { id: positionId } });
  if (!existing) throw new NotFoundError("OrganizationalPosition", positionId);
  await assertTenantUsersWrite(principal, existing.clubId);
  if (!existing.isActive) return existing;
  const inUse = await prisma.userClubProfile.count({ where: { positionId } });
  if (inUse > 0) {
    throw new ConflictError(
      `Cannot archive — ${inUse} tenant user${inUse === 1 ? " holds" : "s hold"} this position. Reassign them first.`,
    );
  }
  const updated = await prisma.organizationalPosition.update({
    where: { id: positionId },
    data: { isActive: false },
  });
  await audit(principal, {
    clubId: existing.clubId,
    action: "organizational.position.archived",
    entityType: "OrganizationalPosition",
    entityId: positionId,
  });
  return updated;
}

// ---------------------------------------------------------------------
// Reporting relationship
// ---------------------------------------------------------------------

/**
 * Reject any reporting graph mutation that would introduce a cycle or
 * violate tenant scope. Called from setReportsTo before writing.
 *
 * Walks upward through the proposed manager's reportsTo chain. If we
 * ever encounter `subjectProfileId`, the write would create a cycle.
 * Hard depth cap at 128 to defend against pathological graphs.
 */
async function assertNoCycle(
  tx: Tx,
  clubId: string,
  subjectProfileId: string,
  proposedManagerProfileId: string,
): Promise<void> {
  let current: string | null = proposedManagerProfileId;
  for (let depth = 0; depth < 128 && current !== null; depth++) {
    if (current === subjectProfileId) {
      throw new ConflictError("Cannot set reporting relationship — this would create a cycle.");
    }
    const step: { clubId: string; reportsToProfileId: string | null } | null =
      await tx.userClubProfile.findUnique({
        where: { id: current },
        select: { clubId: true, reportsToProfileId: true },
      });
    if (!step) return; // manager row disappeared mid-check — outer guards will surface
    if (step.clubId !== clubId) {
      throw new ForbiddenError("Cross-tenant reporting relationships are not permitted.");
    }
    current = step.reportsToProfileId;
  }
}

export const setReportsToSchema = z.object({
  clubId: z.string().min(1),
  profileId: z.string().min(1),
  reportsToProfileId: z.string().nullable(),
});

export async function setReportsTo(principal: Principal, raw: unknown) {
  const parsed = setReportsToSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  const { clubId, profileId, reportsToProfileId } = parsed.data;
  await assertTenantUsersWrite(principal, clubId);

  return prisma.$transaction(async (tx) => {
    const subject = await tx.userClubProfile.findUnique({ where: { id: profileId } });
    if (!subject) throw new NotFoundError("UserClubProfile", profileId);
    if (subject.clubId !== clubId) {
      throw new ForbiddenError("Profile belongs to a different club.");
    }

    if (reportsToProfileId === null) {
      // Detach.
      if (subject.reportsToProfileId === null) return subject;
      const updated = await tx.userClubProfile.update({
        where: { id: profileId },
        data: { reportsToProfileId: null, updatedByUserId: principal.id },
      });
      return { profile: updated, before: subject.reportsToProfileId, after: null };
    }

    if (reportsToProfileId === profileId) {
      throw new ConflictError("A profile cannot report to itself.");
    }

    const manager = await tx.userClubProfile.findUnique({
      where: { id: reportsToProfileId },
      include: { user: { select: { status: true } } },
    });
    if (!manager) throw new NotFoundError("UserClubProfile", reportsToProfileId);
    if (manager.clubId !== clubId) {
      throw new ForbiddenError("Manager profile belongs to a different club.");
    }
    if (manager.status !== "ACTIVE") {
      throw new ValidationError([
        { path: "reportsToProfileId", message: `Manager profile is ${manager.status}; only ACTIVE profiles may be assigned as manager.` },
      ]);
    }
    if (manager.user.status !== "ACTIVE") {
      throw new ValidationError([
        { path: "reportsToProfileId", message: `Manager User is ${manager.user.status}; only ACTIVE users may be assigned as manager.` },
      ]);
    }

    await assertNoCycle(tx, clubId, profileId, reportsToProfileId);

    const updated = await tx.userClubProfile.update({
      where: { id: profileId },
      data: { reportsToProfileId, updatedByUserId: principal.id },
    });
    return { profile: updated, before: subject.reportsToProfileId, after: reportsToProfileId };
  }, { timeout: 15_000 }).then(async (result) => {
    // Audit AFTER commit — matches TA-1B's pattern to avoid SQLite/WAL
    // audit-row contention with the outer transaction.
    if ("before" in result) {
      await audit(principal, {
        clubId,
        action: "tenant.profile.manager.changed",
        entityType: "UserClubProfile",
        entityId: profileId,
        before: { reportsToProfileId: result.before },
        after: { reportsToProfileId: result.after },
      });
      return result.profile;
    }
    return result;
  });
}

// ---------------------------------------------------------------------
// Profile organizational edits — title / position / department.
//
// Wraps upsertProfile with dedicated audit actions per-field so the
// founder-visible audit stream is legible.
// ---------------------------------------------------------------------

export const setProfileOrganizationalFieldsSchema = z.object({
  clubId: z.string().min(1),
  profileId: z.string().min(1),
  displayTitle: z.string().max(120).optional().nullable(),
  positionId: z.string().optional().nullable(),
  departmentId: z.string().optional().nullable(),
});

export async function setProfileOrganizationalFields(
  principal: Principal,
  raw: unknown,
) {
  const parsed = setProfileOrganizationalFieldsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  const { clubId, profileId, displayTitle, positionId, departmentId } = parsed.data;
  await assertTenantUsersWrite(principal, clubId);

  const existing = await prisma.userClubProfile.findUnique({ where: { id: profileId } });
  if (!existing) throw new NotFoundError("UserClubProfile", profileId);
  if (existing.clubId !== clubId) {
    throw new ForbiddenError("Profile belongs to a different club.");
  }

  if (positionId !== undefined && positionId !== null) {
    const pos = await prisma.organizationalPosition.findUnique({ where: { id: positionId }, select: { clubId: true, isActive: true } });
    if (!pos) throw new NotFoundError("OrganizationalPosition", positionId);
    if (pos.clubId !== clubId) throw new ForbiddenError("Position belongs to a different club.");
    if (!pos.isActive) throw new ValidationError([{ path: "positionId", message: "Position is archived." }]);
  }
  if (departmentId !== undefined && departmentId !== null) {
    const dept = await prisma.department.findUnique({ where: { id: departmentId }, select: { clubId: true } });
    if (!dept) throw new NotFoundError("Department", departmentId);
    if (dept.clubId !== clubId) throw new ForbiddenError("Department belongs to a different club.");
  }

  const updated = await prisma.userClubProfile.update({
    where: { id: profileId },
    data: {
      ...(displayTitle !== undefined ? { displayTitle } : {}),
      ...(positionId !== undefined ? { positionId } : {}),
      ...(departmentId !== undefined ? { departmentId } : {}),
      updatedByUserId: principal.id,
    },
  });

  if (displayTitle !== undefined && displayTitle !== existing.displayTitle) {
    await audit(principal, {
      clubId, action: "tenant.profile.title.changed",
      entityType: "UserClubProfile", entityId: profileId,
      before: { displayTitle: existing.displayTitle }, after: { displayTitle },
    });
  }
  if (positionId !== undefined && positionId !== existing.positionId) {
    await audit(principal, {
      clubId, action: "tenant.profile.position.changed",
      entityType: "UserClubProfile", entityId: profileId,
      before: { positionId: existing.positionId }, after: { positionId },
    });
  }
  if (departmentId !== undefined && departmentId !== existing.departmentId) {
    await audit(principal, {
      clubId, action: "tenant.profile.department.changed",
      entityType: "UserClubProfile", entityId: profileId,
      before: { departmentId: existing.departmentId }, after: { departmentId },
    });
  }
  return updated;
}

// ---------------------------------------------------------------------
// Tree read — the org view.
//
// Returns a normalised list of profile "nodes" with parent pointers
// so the client can render a tree without additional queries. Nodes
// carry the display-safe subset (never HR-sensitive fields).
// ---------------------------------------------------------------------

export type OrgNode = {
  profileId: string;
  userId: string;
  userName: string;
  userEmail: string;
  userStatus: string;
  profileStatus: string;
  displayTitle: string | null;
  positionName: string | null;
  departmentName: string | null;
  roleLabels: string[];
  roleKeys: string[];
  reportsToProfileId: string | null;
  isTenantAdmin: boolean;
  hasEmployeeLink: boolean;
};

export async function loadOrgTree(clubId: string): Promise<OrgNode[]> {
  const profiles = await prisma.userClubProfile.findMany({
    where: { clubId, status: "ACTIVE" },
    include: {
      user: {
        select: {
          id: true, name: true, email: true, status: true,
          clubRoles: { where: { clubId }, select: { roleKey: true } },
        },
      },
      position: { select: { name: true } },
      department: { select: { name: true } },
    },
  });
  const tenantAdmins = await prisma.responsibilityAssignment.findMany({
    where: {
      clubId, responsibilityKey: "TENANT_ADMINISTRATION",
      role: "PRIMARY", effectiveTo: null,
    },
    select: { userId: true },
  });
  const adminSet = new Set(tenantAdmins.map((a) => a.userId));

  // Lazy import ROLE_LABELS to avoid cycling constants across module boundaries.
  const { ROLE_LABELS } = await import("./constants");

  return profiles.map((p) => ({
    profileId: p.id,
    userId: p.userId,
    userName: p.user.name,
    userEmail: p.user.email,
    userStatus: p.user.status,
    profileStatus: p.status,
    displayTitle: p.displayTitle,
    positionName: p.position?.name ?? null,
    departmentName: p.department?.name ?? null,
    roleKeys: p.user.clubRoles.map((r) => r.roleKey),
    roleLabels: p.user.clubRoles.map((r) => (ROLE_LABELS as Record<string, string>)[r.roleKey] ?? r.roleKey),
    reportsToProfileId: p.reportsToProfileId,
    isTenantAdmin: adminSet.has(p.userId),
    hasEmployeeLink: p.employeeId !== null,
  }));
}
