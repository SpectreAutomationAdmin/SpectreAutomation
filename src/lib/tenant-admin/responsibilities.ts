// TA-1B (2026-09-03) — Tenant Administration · responsibility helpers.
//
// Minimal foundation for the ResponsibilityAssignment table. TA-1B only
// wires up TENANT_ADMINISTRATION. The full resolver
// (resolveResponsibilityOwner returning RESOLVED/UNASSIGNED/AMBIGUOUS/…)
// is deferred to TA-1F. This file provides:
//
//   - listActive*Assignments — reads active PRIMARY / BACKUP rows
//   - assignPrimary          — enforces SINGLE-PRIMARY invariant with
//                              audit + transactional replacement
//   - addBackup / endAssignment
//   - ensureTenantAdministrationBootstrap — idempotent first-user grant
//
// Every write is audited. Every read is tenant-scoped (Club id required).

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
import type { ResponsibilityKey, ResponsibilityRole } from "./constants";

type Tx = Prisma.TransactionClient | PrismaClient;

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------
export async function listActiveAssignments(
  clubId: string,
  responsibilityKey: ResponsibilityKey,
  role?: ResponsibilityRole,
) {
  return prisma.responsibilityAssignment.findMany({
    where: {
      clubId,
      responsibilityKey,
      effectiveTo: null,
      ...(role ? { role } : {}),
    },
    include: {
      user: { select: { id: true, name: true, email: true, status: true } },
    },
    orderBy: [{ role: "asc" }, { effectiveFrom: "asc" }],
  });
}

export async function findActivePrimary(
  clubId: string,
  responsibilityKey: ResponsibilityKey,
) {
  return prisma.responsibilityAssignment.findFirst({
    where: {
      clubId,
      responsibilityKey,
      role: "PRIMARY",
      effectiveTo: null,
    },
    include: {
      user: { select: { id: true, name: true, email: true, status: true } },
    },
  });
}

export async function countActivePrimaries(
  clubId: string,
  responsibilityKey: ResponsibilityKey,
  tx: Tx = prisma,
): Promise<number> {
  return tx.responsibilityAssignment.count({
    where: {
      clubId,
      responsibilityKey,
      role: "PRIMARY",
      effectiveTo: null,
    },
  });
}

export function isUserActivePrimary(
  clubId: string,
  responsibilityKey: ResponsibilityKey,
  userId: string,
): Promise<boolean> {
  return prisma.responsibilityAssignment
    .count({
      where: {
        clubId,
        responsibilityKey,
        role: "PRIMARY",
        userId,
        effectiveTo: null,
      },
    })
    .then((n) => n > 0);
}

// ---------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------

/**
 * Assign the given user as PRIMARY for a responsibility. Enforces the
 * SINGLE_PRIMARY invariant: any existing active PRIMARY is closed
 * (effectiveTo := now) in the same transaction. Fails safely when the
 * user is not ACTIVE.
 *
 * If `bootstrap` is true and the responsibility already has an active
 * PRIMARY, no-ops (returns the existing row). Bootstrap NEVER replaces.
 */
export async function assignPrimary(args: {
  clubId: string;
  userId: string;
  responsibilityKey: ResponsibilityKey;
  actor: Principal | { id: string } | null;
  notes?: string;
  bootstrap?: boolean;
  tx?: Tx;
}) {
  const {
    clubId,
    userId,
    responsibilityKey,
    actor,
    notes,
    bootstrap = false,
  } = args;

  const run = async (tx: Tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true },
    });
    if (!user) throw new NotFoundError("User", userId);
    if (user.status !== "ACTIVE") {
      throw new ValidationError([
        { path: "userId", message: `User is ${user.status}; only ACTIVE users may hold responsibilities.` },
      ]);
    }

    // Membership requirement: user must have a UserClubRole at this club
    // (i.e. be a member of the tenant) or be SUPER_ADMIN. We do NOT let
    // a Club assign a responsibility to a User who is not a member of it.
    const memberships = await tx.userClubRole.findMany({
      where: { userId, OR: [{ clubId }, { clubId: null }] },
      select: { clubId: true, roleKey: true },
    });
    const isSuper = memberships.some((m) => m.clubId === null && m.roleKey === "SUPER_ADMIN");
    const isMember = memberships.some((m) => m.clubId === clubId);
    if (!isMember && !isSuper) {
      throw new ForbiddenError(
        "User is not a member of this club and cannot hold a responsibility here.",
      );
    }

    const existing = await tx.responsibilityAssignment.findFirst({
      where: { clubId, responsibilityKey, role: "PRIMARY", effectiveTo: null },
    });

    // Bootstrap short-circuit: if an active PRIMARY already exists,
    // do nothing (idempotent).
    if (existing && bootstrap) {
      if (existing.userId === userId) return existing;
      // Bootstrap must never silently replace a different primary.
      return existing;
    }

    if (existing && existing.userId === userId) {
      // Already the primary — no-op idempotent write.
      return existing;
    }

    const now = new Date();
    if (existing) {
      await tx.responsibilityAssignment.update({
        where: { id: existing.id },
        data: { effectiveTo: now, endedByUserId: actor?.id ?? null, endReason: "REPLACED" },
      });
      await audit(actor, {
        clubId,
        action: "responsibility.primary.ended",
        entityType: "ResponsibilityAssignment",
        entityId: existing.id,
        after: { responsibilityKey, previousUserId: existing.userId, endReason: "REPLACED" },
      });
    }

    const created = await tx.responsibilityAssignment.create({
      data: {
        clubId,
        userId,
        responsibilityKey,
        role: "PRIMARY",
        effectiveFrom: now,
        assignedByUserId: actor?.id ?? null,
        notes: notes ?? null,
      },
    });
    await audit(actor, {
      clubId,
      action: bootstrap ? "responsibility.primary.bootstrap" : "responsibility.primary.assigned",
      entityType: "ResponsibilityAssignment",
      entityId: created.id,
      after: { responsibilityKey, userId, previousUserId: existing?.userId ?? null },
    });
    return created;
  };

  if (args.tx) return run(args.tx);
  return prisma.$transaction(run, { timeout: 15_000 });
}

/**
 * Add a BACKUP assignment. Multiple backups are allowed for
 * PRIMARY_AND_BACKUPS-cardinality responsibilities (TENANT_ADMINISTRATION).
 * Refuses duplicate (userId, role=BACKUP) rows that are currently active.
 */
export async function addBackup(args: {
  clubId: string;
  userId: string;
  responsibilityKey: ResponsibilityKey;
  actor: Principal | { id: string } | null;
  notes?: string;
}) {
  const { clubId, userId, responsibilityKey, actor, notes } = args;
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true },
    });
    if (!user) throw new NotFoundError("User", userId);
    if (user.status !== "ACTIVE") {
      throw new ValidationError([
        { path: "userId", message: `User is ${user.status}; only ACTIVE users may hold responsibilities.` },
      ]);
    }
    const memberships = await tx.userClubRole.count({
      where: { userId, clubId },
    });
    if (memberships === 0) {
      throw new ForbiddenError("User is not a member of this club.");
    }
    const dup = await tx.responsibilityAssignment.findFirst({
      where: { clubId, responsibilityKey, role: "BACKUP", userId, effectiveTo: null },
    });
    if (dup) throw new ConflictError("User is already a backup for this responsibility.");
    const created = await tx.responsibilityAssignment.create({
      data: {
        clubId,
        userId,
        responsibilityKey,
        role: "BACKUP",
        effectiveFrom: new Date(),
        assignedByUserId: actor?.id ?? null,
        notes: notes ?? null,
      },
    });
    await audit(actor, {
      clubId,
      action: "responsibility.backup.assigned",
      entityType: "ResponsibilityAssignment",
      entityId: created.id,
      after: { responsibilityKey, userId },
    });
    return created;
  }, { timeout: 15_000 });
}

/**
 * End an assignment. For TENANT_ADMINISTRATION, refuses to end the LAST
 * active PRIMARY (leaves the club without an administrator).
 */
export async function endAssignment(args: {
  assignmentId: string;
  actor: Principal | { id: string } | null;
  endReason?: string;
}) {
  const { assignmentId, actor, endReason } = args;
  return prisma.$transaction(async (tx) => {
    const row = await tx.responsibilityAssignment.findUnique({ where: { id: assignmentId } });
    if (!row) throw new NotFoundError("ResponsibilityAssignment", assignmentId);
    if (row.effectiveTo) return row; // already ended

    if (row.role === "PRIMARY") {
      const others = await tx.responsibilityAssignment.count({
        where: {
          clubId: row.clubId,
          responsibilityKey: row.responsibilityKey,
          role: "PRIMARY",
          effectiveTo: null,
          id: { not: row.id },
        },
      });
      if (others === 0) {
        throw new ConflictError(
          `Cannot end the only active PRIMARY for ${row.responsibilityKey}. Assign another PRIMARY first.`,
        );
      }
    }

    const updated = await tx.responsibilityAssignment.update({
      where: { id: row.id },
      data: {
        effectiveTo: new Date(),
        endedByUserId: actor?.id ?? null,
        endReason: endReason ?? null,
      },
    });
    await audit(actor, {
      clubId: row.clubId,
      action: row.role === "PRIMARY" ? "responsibility.primary.ended" : "responsibility.backup.ended",
      entityType: "ResponsibilityAssignment",
      entityId: row.id,
      after: { responsibilityKey: row.responsibilityKey, userId: row.userId, endReason: endReason ?? null },
    });
    return updated;
  }, { timeout: 15_000 });
}

/**
 * Explicit governance action: transfer Primary Tenant Administrator
 * from the current holder to a named target User (TA-1B closeout §20-25).
 *
 * Distinct from the generic assignPrimary helper because the founder
 * requirement is that ownership changes are intent-expressed at the
 * public API boundary — assignPrimary silently closing an existing
 * primary was too easy to invoke by accident.
 *
 * Rules enforced here:
 *   - Refuse if no current Primary exists (this is bootstrap territory —
 *     use ensureTenantAdministrationBootstrap).
 *   - Refuse if target is the current Primary (no-op / self-transfer).
 *   - Refuse if target is not ACTIVE.
 *   - Refuse if target is not a member of the Club.
 *   - Refuse if the target profile is not ACTIVE at the Club (SUSPENDED /
 *     REVOKED profiles cannot become Primary).
 *   - Atomic within one transaction — no zero-Primary window.
 *   - Former Primary is NOT auto-assigned as BACKUP (§23).
 *   - Emits distinct audit event `tenant.administrator.transferred`.
 */
export async function transferPrimaryTenantAdministrator(args: {
  clubId: string;
  targetUserId: string;
  actor: Principal | { id: string } | null;
  notes?: string;
}) {
  const { clubId, targetUserId, actor, notes } = args;
  return prisma.$transaction(async (tx) => {
    const current = await tx.responsibilityAssignment.findFirst({
      where: {
        clubId, responsibilityKey: "TENANT_ADMINISTRATION",
        role: "PRIMARY", effectiveTo: null,
      },
    });
    if (!current) {
      throw new ConflictError(
        "No current Primary Tenant Administrator to transfer from. Bootstrap the first Primary via the invitation flow instead.",
      );
    }
    if (current.userId === targetUserId) {
      throw new ConflictError("Target is already the Primary Tenant Administrator.");
    }

    const target = await tx.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, status: true },
    });
    if (!target) throw new NotFoundError("User", targetUserId);
    if (target.status !== "ACTIVE") {
      throw new ValidationError([
        { path: "targetUserId", message: `Target User is ${target.status}; only ACTIVE users may hold Primary.` },
      ]);
    }
    const membership = await tx.userClubRole.count({ where: { userId: targetUserId, clubId } });
    if (membership === 0) {
      throw new ForbiddenError("Target User is not a member of this club.");
    }
    const targetProfile = await tx.userClubProfile.findUnique({
      where: { clubId_userId: { clubId, userId: targetUserId } },
      select: { status: true },
    });
    if (targetProfile && targetProfile.status !== "ACTIVE") {
      throw new ForbiddenError(
        `Target profile is ${targetProfile.status}; only ACTIVE profiles may hold Primary.`,
      );
    }

    const now = new Date();
    await tx.responsibilityAssignment.update({
      where: { id: current.id },
      data: {
        effectiveTo: now,
        endedByUserId: actor?.id ?? null,
        endReason: "TRANSFERRED",
      },
    });
    const created = await tx.responsibilityAssignment.create({
      data: {
        clubId, userId: targetUserId,
        responsibilityKey: "TENANT_ADMINISTRATION",
        role: "PRIMARY",
        effectiveFrom: now,
        assignedByUserId: actor?.id ?? null,
        notes: notes ?? null,
      },
    });
    return { previousPrimaryUserId: current.userId, newPrimary: created, previousAssignmentId: current.id };
  }, { timeout: 15_000 }).then(async (result) => {
    // Audit AFTER the tx commits so audit-write contention with the
    // outer transaction cannot swallow the row on SQLite/WAL.
    await audit(actor, {
      clubId,
      action: "tenant.administrator.transferred",
      entityType: "ResponsibilityAssignment",
      entityId: result.newPrimary.id,
      before: { previousPrimaryUserId: result.previousPrimaryUserId, previousAssignmentId: result.previousAssignmentId },
      after: { newPrimaryUserId: targetUserId, newAssignmentId: result.newPrimary.id, formerPrimaryBackup: false },
    });
    return { previousPrimaryUserId: result.previousPrimaryUserId, newPrimary: result.newPrimary };
  });
}

/**
 * Bootstrap the first Tenant Administrator for a Club. Idempotent:
 *   - if the Club already has an active TENANT_ADMINISTRATION PRIMARY,
 *     no-op (returns the existing row).
 *   - otherwise, creates the assignment.
 *
 * Callers: (1) the AdminInvitation activation flow when the invitation
 * carries `bootstrap: true`; (2) a targeted backfill script for
 * existing tenants (not run automatically — see docs/tenant-admin/
 * TA-1A-architecture.md §21 on offboarding safety and §20 on
 * invitation lifecycle).
 */
export async function ensureTenantAdministrationBootstrap(args: {
  clubId: string;
  userId: string;
  actor: Principal | { id: string } | null;
  tx?: Tx;
}) {
  return assignPrimary({
    clubId: args.clubId,
    userId: args.userId,
    responsibilityKey: "TENANT_ADMINISTRATION",
    actor: args.actor,
    bootstrap: true,
    tx: args.tx,
    notes: "Auto-assigned during Club bootstrap / admin invitation activation.",
  });
}
