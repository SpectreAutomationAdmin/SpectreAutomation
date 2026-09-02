// TA-1B (2026-09-03) — Tenant Administration · UserClubProfile service.
//
// One profile row per (User × Club). Kept separate from UserClubRole so
// the RBAC hot-path stays minimal. Stores organizational title, optional
// department, optional Employee link, tenant-side status
// (ACTIVE | SUSPENDED | REVOKED).
//
// Same-tenant invariants enforced here (Employee + Department must
// belong to the same Club as the profile).

import { prisma } from "../prisma";
import { audit } from "../audit";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../errors";
import type { Principal } from "../rbac";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { UserClubProfileStatus } from "./constants";
import { isUserActivePrimary } from "./responsibilities";

type Tx = Prisma.TransactionClient | PrismaClient;

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------
export async function getProfile(clubId: string, userId: string) {
  return prisma.userClubProfile.findUnique({
    where: { clubId_userId: { clubId, userId } },
    include: {
      user: {
        select: {
          id: true, name: true, email: true, status: true, lastLoginAt: true,
          clubRoles: { where: { clubId }, select: { roleKey: true } },
        },
      },
      department: { select: { id: true, name: true, code: true } },
      employee: { select: { id: true, employeeNumber: true, firstName: true, lastName: true } },
    },
  });
}

export async function listActiveProfiles(clubId: string) {
  return prisma.userClubProfile.findMany({
    where: { clubId, status: "ACTIVE" },
    include: {
      user: {
        select: {
          id: true, name: true, email: true, status: true, lastLoginAt: true,
          clubRoles: { where: { clubId }, select: { roleKey: true } },
        },
      },
      department: { select: { id: true, name: true, code: true } },
    },
    orderBy: [{ user: { name: "asc" } }],
  });
}

// ---------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------

/**
 * Create / upsert a UserClubProfile. Called by:
 *   - AdminInvitation.activate() (creates fresh)
 *   - Backfill scripts for existing tenants
 * The service-layer same-club invariants for department + employee
 * are enforced regardless of caller.
 */
export async function upsertProfile(args: {
  clubId: string;
  userId: string;
  actor: Principal | { id: string } | null;
  displayTitle?: string | null;
  departmentId?: string | null;
  employeeId?: string | null;
  tx?: Tx;
}) {
  const { clubId, userId, actor, displayTitle, departmentId, employeeId } = args;
  const run = async (tx: Tx) => {
    if (departmentId) {
      const dept = await tx.department.findUnique({ where: { id: departmentId }, select: { clubId: true } });
      if (!dept) throw new NotFoundError("Department", departmentId);
      if (dept.clubId !== clubId) {
        throw new ForbiddenError("Department belongs to a different club.");
      }
    }
    if (employeeId) {
      const emp = await tx.employee.findUnique({ where: { id: employeeId }, select: { clubId: true } });
      if (!emp) throw new NotFoundError("Employee", employeeId);
      if (emp.clubId !== clubId) {
        throw new ForbiddenError("Employee belongs to a different club.");
      }
      // employeeId is @unique on UserClubProfile — verify not already linked to a different user.
      const dup = await tx.userClubProfile.findUnique({
        where: { employeeId },
        select: { userId: true, clubId: true },
      });
      if (dup && (dup.userId !== userId || dup.clubId !== clubId)) {
        throw new ConflictError("Employee is already linked to a different tenant profile.");
      }
    }

    const now = new Date();
    const existing = await tx.userClubProfile.findUnique({
      where: { clubId_userId: { clubId, userId } },
    });

    if (existing) {
      const updated = await tx.userClubProfile.update({
        where: { id: existing.id },
        data: {
          displayTitle: displayTitle ?? existing.displayTitle,
          departmentId: departmentId === undefined ? existing.departmentId : departmentId,
          employeeId: employeeId === undefined ? existing.employeeId : employeeId,
          updatedAt: now,
          updatedByUserId: actor?.id ?? null,
        },
      });
      await audit(actor, {
        clubId,
        action: "tenant.profile.updated",
        entityType: "UserClubProfile",
        entityId: updated.id,
        before: { displayTitle: existing.displayTitle, departmentId: existing.departmentId, employeeId: existing.employeeId },
        after: { displayTitle: updated.displayTitle, departmentId: updated.departmentId, employeeId: updated.employeeId },
      });
      return updated;
    }

    const created = await tx.userClubProfile.create({
      data: {
        clubId,
        userId,
        displayTitle: displayTitle ?? null,
        departmentId: departmentId ?? null,
        employeeId: employeeId ?? null,
        status: "ACTIVE",
        createdByUserId: actor?.id ?? null,
      },
    });
    await audit(actor, {
      clubId,
      action: "tenant.profile.created",
      entityType: "UserClubProfile",
      entityId: created.id,
      after: { userId, displayTitle: created.displayTitle, departmentId: created.departmentId, employeeId: created.employeeId },
    });
    return created;
  };
  if (args.tx) return run(args.tx);
  return prisma.$transaction(run, { timeout: 15_000 });
}

/**
 * Change a profile's tenant-side status (ACTIVE|SUSPENDED|REVOKED).
 * Refuses to SUSPEND/REVOKE a user who is the last active PRIMARY of
 * TENANT_ADMINISTRATION at this Club (§37 last-primary safety).
 *
 * Note: this is the service-layer safety net. The Tenant Users UI
 * (TA-1B) does NOT yet expose suspend/revoke — that is TA-1I. The guard
 * exists here now so backfill scripts and future callers can never
 * strand a Club.
 */
export async function changeProfileStatus(args: {
  clubId: string;
  userId: string;
  nextStatus: UserClubProfileStatus;
  actor: Principal | { id: string } | null;
  reason?: string;
}) {
  const { clubId, userId, nextStatus, actor, reason } = args;
  return prisma.$transaction(async (tx) => {
    const existing = await tx.userClubProfile.findUnique({
      where: { clubId_userId: { clubId, userId } },
    });
    if (!existing) throw new NotFoundError("UserClubProfile", `${clubId}:${userId}`);
    if (existing.status === nextStatus) return existing;

    // Last-primary safety.
    if (nextStatus !== "ACTIVE") {
      const isPrimary = await isUserActivePrimary(clubId, "TENANT_ADMINISTRATION", userId);
      if (isPrimary) {
        const otherPrimaries = await tx.responsibilityAssignment.count({
          where: {
            clubId,
            responsibilityKey: "TENANT_ADMINISTRATION",
            role: "PRIMARY",
            effectiveTo: null,
            userId: { not: userId },
          },
        });
        if (otherPrimaries === 0) {
          throw new ConflictError(
            "This user is the only active Tenant Administrator for this club. Assign another Primary before suspending or revoking their access.",
          );
        }
      }
    }

    const now = new Date();
    const updated = await tx.userClubProfile.update({
      where: { id: existing.id },
      data: {
        status: nextStatus,
        suspendedAt: nextStatus === "SUSPENDED" ? now : null,
        revokedAt: nextStatus === "REVOKED" ? now : null,
        updatedAt: now,
        updatedByUserId: actor?.id ?? null,
      },
    });
    await audit(actor, {
      clubId,
      action:
        nextStatus === "SUSPENDED" ? "tenant.profile.suspended" :
        nextStatus === "REVOKED"   ? "tenant.profile.revoked" :
                                      "tenant.profile.reactivated",
      entityType: "UserClubProfile",
      entityId: updated.id,
      before: { status: existing.status },
      after: { status: nextStatus, reason: reason ?? null },
    });
    return updated;
  }, { timeout: 15_000 });
}

/**
 * Assert the caller has authority to manage tenant users at a club.
 * TA-1B compatibility policy:
 *   - SUPER_ADMIN always allowed
 *   - CLUB_ADMIN at this club allowed (compatibility period —
 *     documented in TA-1A §35)
 *   - Users holding TENANT_ADMINISTRATION (PRIMARY or BACKUP) at this
 *     club allowed
 * Fails ForbiddenError otherwise. Reads memberships from the principal,
 * responsibility rows from the DB.
 */
export async function assertTenantUsersWrite(
  principal: Principal,
  clubId: string,
): Promise<void> {
  const isSuper = principal.memberships.some(
    (m) => m.clubId === null && m.roleKey === "SUPER_ADMIN",
  );
  if (isSuper) return;

  const roles = principal.memberships
    .filter((m) => m.clubId === clubId)
    .map((m) => m.roleKey);
  if (roles.includes("CLUB_ADMIN")) return; // compatibility

  const hasResp = await prisma.responsibilityAssignment.count({
    where: {
      clubId,
      responsibilityKey: "TENANT_ADMINISTRATION",
      userId: principal.id,
      effectiveTo: null,
    },
  });
  if (hasResp > 0) return;

  throw new ForbiddenError(
    "Only a Tenant Administrator or Club Admin may manage tenant users.",
  );
}

/**
 * Simple validation helper — flag obvious profile field problems.
 * Used by the invitation form + upsert callers.
 */
export function validateTitle(title: string | null | undefined): string[] {
  const errs: string[] = [];
  if (title == null) return errs;
  if (title.length > 120) errs.push("Title must be 120 characters or fewer.");
  return errs;
}
