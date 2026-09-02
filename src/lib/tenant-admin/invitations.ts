// TA-1B (2026-09-03) — Tenant Administration · admin invitations.
//
// AdminInvitation lifecycle: PENDING → SENT → (OPENED) → ACTIVATED
// with EXPIRED / REVOKED / FAILED terminal states.
//
// Modelled on src/lib/member-invites/index.ts:
//   - token is 32 bytes from crypto.randomBytes(32), base64url-encoded
//   - stored as sha256 hash only; raw token returned once at create
//   - resend invalidates prior live tokens for the same email at the
//     same club
//   - activation is transactional: User (existing or new) + UserClubRole
//     grants + UserClubProfile + optional TENANT_ADMINISTRATION bootstrap
//     in one atomic write, then invitation status flips ACTIVATED
//
// Email normalisation: lowercased + trimmed at write, matches the
// pattern already used by member-invites and the login path
// (see src/lib/services/auth.ts).

import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../errors";
import type { Principal } from "../rbac";
import {
  DEFAULT_INVITATION_TTL_DAYS,
  LIVE_INVITATION_STATUSES,
  MAX_INVITATION_TTL_DAYS,
  MIN_INVITATION_TTL_DAYS,
  isTenantAssignableRole,
} from "./constants";
import { assertTenantUsersWrite, upsertProfile } from "./profile";
import { ensureTenantAdministrationBootstrap } from "./responsibilities";

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
function generateRawToken(): string {
  return randomBytes(32).toString("base64url");
}

// ---------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------
export const createAdminInvitationSchema = z.object({
  clubId: z.string().min(1),
  email: z.string().email(),
  firstName: z.string().min(1).max(120).optional(),
  lastName: z.string().min(1).max(120).optional(),
  displayName: z.string().max(160).optional(),
  displayTitle: z.string().max(120).optional(),
  departmentId: z.string().optional().nullable(),
  employeeId: z.string().optional().nullable(),
  initialRoleKeys: z.array(z.string().min(1)).min(1),
  ttlDays: z.number().int().min(MIN_INVITATION_TTL_DAYS).max(MAX_INVITATION_TTL_DAYS).optional(),
  bootstrap: z.boolean().optional(),
});
export type CreateAdminInvitationInput = z.infer<typeof createAdminInvitationSchema>;

export async function createAdminInvitation(
  principal: Principal,
  raw: unknown,
): Promise<{ invitation: Awaited<ReturnType<typeof prisma.adminInvitation.create>>; token: string }> {
  // Pre-normalise email so `.email()` validation accepts padded / mixed-case input.
  if (raw && typeof raw === "object" && "email" in raw && typeof (raw as { email: unknown }).email === "string") {
    (raw as { email: string }).email = normaliseEmail((raw as { email: string }).email);
  }
  const parsed = createAdminInvitationSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  const input = parsed.data;
  await assertTenantUsersWrite(principal, input.clubId);

  const invalidRoles = input.initialRoleKeys.filter((r) => !isTenantAssignableRole(r));
  if (invalidRoles.length > 0) {
    throw new ValidationError([
      { path: "initialRoleKeys", message: `Roles not tenant-assignable: ${invalidRoles.join(", ")}` },
    ]);
  }
  const uniqueRoles = Array.from(new Set(input.initialRoleKeys));
  const email = normaliseEmail(input.email);

  // Same-club invariants
  if (input.departmentId) {
    const dept = await prisma.department.findUnique({ where: { id: input.departmentId }, select: { clubId: true } });
    if (!dept) throw new NotFoundError("Department", input.departmentId);
    if (dept.clubId !== input.clubId) {
      throw new ValidationError([{ path: "departmentId", message: "Department belongs to a different club." }]);
    }
  }
  if (input.employeeId) {
    const emp = await prisma.employee.findUnique({ where: { id: input.employeeId }, select: { clubId: true } });
    if (!emp) throw new NotFoundError("Employee", input.employeeId);
    if (emp.clubId !== input.clubId) {
      throw new ValidationError([{ path: "employeeId", message: "Employee belongs to a different club." }]);
    }
  }

  // Refuse duplicate live invitations to the same email at the same club.
  const existingLive = await prisma.adminInvitation.findFirst({
    where: { clubId: input.clubId, email, status: { in: LIVE_INVITATION_STATUSES } },
  });
  if (existingLive) {
    throw new ConflictError(
      `There is already an outstanding invitation for ${email} at this club (status ${existingLive.status}). Resend or revoke that invitation first.`,
    );
  }

  // Refuse if the user is already an active member of the tenant.
  const existingUser = await prisma.user.findUnique({
    where: { email },
    include: { clubRoles: { where: { clubId: input.clubId } } },
  });
  if (existingUser && existingUser.clubRoles.length > 0) {
    const profile = await prisma.userClubProfile.findUnique({
      where: { clubId_userId: { clubId: input.clubId, userId: existingUser.id } },
    });
    if (profile && profile.status === "ACTIVE") {
      throw new ConflictError(
        `${email} is already an active administrative user at this club.`,
      );
    }
  }

  const ttlDays = input.ttlDays ?? DEFAULT_INVITATION_TTL_DAYS;
  const rawToken = generateRawToken();
  const invitation = await prisma.adminInvitation.create({
    data: {
      clubId: input.clubId,
      email,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      displayName: input.displayName ?? null,
      displayTitle: input.displayTitle ?? null,
      departmentId: input.departmentId ?? null,
      employeeId: input.employeeId ?? null,
      initialRoleKeys: uniqueRoles.join(","),
      bootstrap: Boolean(input.bootstrap),
      tokenHash: sha256(rawToken),
      status: "PENDING",
      expiresAt: new Date(Date.now() + ttlDays * 86_400_000),
      invitedByUserId: principal.id,
    },
  });
  await audit(principal, {
    clubId: input.clubId,
    action: "admin.invitation.created",
    entityType: "AdminInvitation",
    entityId: invitation.id,
    after: {
      email,
      initialRoleKeys: uniqueRoles,
      bootstrap: Boolean(input.bootstrap),
      hasDepartment: Boolean(input.departmentId),
      hasEmployee: Boolean(input.employeeId),
    },
  });
  return { invitation, token: rawToken };
}

// ---------------------------------------------------------------------
// Mark as sent / opened / failed (handoff plumbing)
// ---------------------------------------------------------------------
export async function markInvitationSent(id: string): Promise<void> {
  const invitation = await prisma.adminInvitation.findUnique({ where: { id } });
  if (!invitation) throw new NotFoundError("AdminInvitation", id);
  if (invitation.status !== "PENDING" && invitation.status !== "SENT") return;
  await prisma.adminInvitation.update({
    where: { id },
    data: { status: "SENT", sentAt: new Date(), sendCount: { increment: 1 }, lastError: null },
  });
}

export async function markInvitationFailed(id: string, lastError: string): Promise<void> {
  await prisma.adminInvitation.update({
    where: { id },
    data: { status: "FAILED", failedAt: new Date(), lastError, sendCount: { increment: 1 } },
  });
}

export async function markInvitationOpened(token: string): Promise<void> {
  const invitation = await prisma.adminInvitation.findUnique({
    where: { tokenHash: sha256(token) },
  });
  if (!invitation) return;
  if (invitation.status === "SENT" || invitation.status === "PENDING") {
    await prisma.adminInvitation.update({
      where: { id: invitation.id },
      data: { status: "OPENED", openedAt: new Date() },
    });
  }
}

// ---------------------------------------------------------------------
// Resend
// ---------------------------------------------------------------------
export async function resendAdminInvitation(
  principal: Principal,
  invitationId: string,
): Promise<{ invitation: Awaited<ReturnType<typeof prisma.adminInvitation.create>>; token: string }> {
  const existing = await prisma.adminInvitation.findUnique({ where: { id: invitationId } });
  if (!existing) throw new NotFoundError("AdminInvitation", invitationId);
  await assertTenantUsersWrite(principal, existing.clubId);
  if (existing.status === "ACTIVATED") throw new ConflictError("Invitation is already activated.");
  if (existing.status === "REVOKED") throw new ConflictError("Invitation is revoked and cannot be resent.");

  // Invalidate the prior token by rotating hash + resetting lifecycle.
  const rawToken = generateRawToken();
  const now = new Date();
  const ttlMs = Math.max(existing.expiresAt.getTime() - existing.createdAt.getTime(),
    DEFAULT_INVITATION_TTL_DAYS * 86_400_000);
  const invitation = await prisma.adminInvitation.update({
    where: { id: existing.id },
    data: {
      tokenHash: sha256(rawToken),
      status: "PENDING",
      sentAt: null,
      openedAt: null,
      failedAt: null,
      lastError: null,
      expiresAt: new Date(now.getTime() + ttlMs),
      updatedAt: now,
    },
  });
  await audit(principal, {
    clubId: existing.clubId,
    action: "admin.invitation.resent",
    entityType: "AdminInvitation",
    entityId: existing.id,
    after: { previousStatus: existing.status },
  });
  return { invitation, token: rawToken };
}

// ---------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------
export async function revokeAdminInvitation(
  principal: Principal,
  invitationId: string,
): Promise<void> {
  const existing = await prisma.adminInvitation.findUnique({ where: { id: invitationId } });
  if (!existing) throw new NotFoundError("AdminInvitation", invitationId);
  await assertTenantUsersWrite(principal, existing.clubId);
  if (existing.status === "ACTIVATED") throw new ConflictError("Cannot revoke an activated invitation.");
  if (existing.status === "REVOKED") return;
  await prisma.adminInvitation.update({
    where: { id: existing.id },
    data: {
      status: "REVOKED",
      revokedAt: new Date(),
      revokedByUserId: principal.id,
    },
  });
  await audit(principal, {
    clubId: existing.clubId,
    action: "admin.invitation.revoked",
    entityType: "AdminInvitation",
    entityId: existing.id,
    after: { previousStatus: existing.status },
  });
}

// ---------------------------------------------------------------------
// Reads (Tenant Users page)
// ---------------------------------------------------------------------
export async function listAdminInvitations(
  principal: Principal,
  clubId: string,
  opts?: { includeTerminal?: boolean },
) {
  await assertTenantUsersWrite(principal, clubId);
  const includeTerminal = opts?.includeTerminal ?? false;
  return prisma.adminInvitation.findMany({
    where: {
      clubId,
      ...(includeTerminal ? {} : { status: { in: [...LIVE_INVITATION_STATUSES, "FAILED"] } }),
    },
    orderBy: { createdAt: "desc" },
    include: {
      invitedBy: { select: { id: true, name: true, email: true } },
      department: { select: { id: true, name: true, code: true } },
      employee: { select: { id: true, firstName: true, lastName: true, employeeNumber: true } },
    },
    take: 200,
  });
}

// ---------------------------------------------------------------------
// Activation (conventional path — password-set)
// ---------------------------------------------------------------------
export const activateAdminInvitationSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(10).max(200),
  confirmPassword: z.string().min(10).max(200),
  fullName: z.string().min(1).max(160).optional(),
});
export type ActivateAdminInvitationInput = z.infer<typeof activateAdminInvitationSchema>;

export type ActivationResult = {
  invitationId: string;
  userId: string;
  clubId: string;
  bootstrapPrimaryAssigned: boolean;
  createdUser: boolean;
  redirectPath: string;
};

/**
 * Activate an invitation via the conventional password-set path.
 *
 * Transactional writes (all-or-nothing):
 *   1. User: create OR update password (existing user is attached).
 *   2. UserClubRole rows: one per requested roleKey (idempotent upsert).
 *   3. UserClubProfile: created/updated with displayTitle + department + employee link.
 *   4. If invitation.bootstrap: assign TENANT_ADMINISTRATION PRIMARY (idempotent).
 *   5. AdminInvitation.status → ACTIVATED.
 *
 * Never returns the token, never re-emits sensitive data. Audit rows
 * are written OUTSIDE the transaction so an audit failure does not
 * roll back a legitimate activation.
 */
export async function activateAdminInvitation(
  raw: unknown,
  args?: { ip?: string; userAgent?: string },
): Promise<ActivationResult> {
  const parsed = activateAdminInvitationSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  const input = parsed.data;
  if (input.password !== input.confirmPassword) {
    throw new ValidationError([{ path: "confirmPassword", message: "Passwords do not match." }]);
  }
  if (!/[A-Z]/.test(input.password) || !/[a-z]/.test(input.password) || !/\d/.test(input.password)) {
    throw new ValidationError([
      { path: "password", message: "Password must include upper case, lower case, and a digit." },
    ]);
  }

  const tokenHash = sha256(input.token);
  const invitation = await prisma.adminInvitation.findUnique({ where: { tokenHash } });
  if (!invitation) throw new NotFoundError("AdminInvitation", "token");
  if (invitation.status === "ACTIVATED") throw new ConflictError("Invitation is already activated.");
  if (invitation.status === "REVOKED") throw new ConflictError("Invitation has been revoked.");
  if (invitation.status === "EXPIRED" || invitation.expiresAt.getTime() < Date.now()) {
    if (invitation.status !== "EXPIRED") {
      await prisma.adminInvitation.update({ where: { id: invitation.id }, data: { status: "EXPIRED" } });
    }
    throw new ConflictError("Invitation has expired.");
  }

  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.hash(input.password, 10);
  const roleKeys = invitation.initialRoleKeys
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .filter(isTenantAssignableRole);
  if (roleKeys.length === 0) {
    throw new ConflictError("Invitation has no tenant-assignable roles.");
  }

  const composedName = [invitation.firstName, invitation.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  const displayName =
    invitation.displayName ??
    (composedName || input.fullName || invitation.email.split("@")[0]);

  const result = await prisma.$transaction(async (tx) => {
    // 1. User — create or attach.
    let user = await tx.user.findUnique({ where: { email: invitation.email } });
    let createdUser = false;
    if (user) {
      user = await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          status: "ACTIVE",
          name: user.name || displayName,
        },
      });
    } else {
      user = await tx.user.create({
        data: {
          email: invitation.email,
          name: displayName,
          role: roleKeys[0], // deprecated scalar; keep in sync
          passwordHash,
          status: "ACTIVE",
          clubId: invitation.clubId, // deprecated scalar; kept for legacy readers
        },
      });
      createdUser = true;
    }

    // 2. UserClubRole rows.
    for (const roleKey of roleKeys) {
      await tx.userClubRole.upsert({
        where: { userId_clubId_roleKey: { userId: user.id, clubId: invitation.clubId, roleKey } },
        update: {},
        create: { userId: user.id, clubId: invitation.clubId, roleKey },
      });
    }

    // 3. UserClubProfile.
    await upsertProfile({
      clubId: invitation.clubId,
      userId: user.id,
      actor: { id: user.id },
      displayTitle: invitation.displayTitle,
      departmentId: invitation.departmentId,
      employeeId: invitation.employeeId,
      tx,
    });

    // 4. Bootstrap TENANT_ADMINISTRATION if this is the club's first admin.
    let bootstrapPrimaryAssigned = false;
    if (invitation.bootstrap) {
      const existingPrimary = await tx.responsibilityAssignment.findFirst({
        where: {
          clubId: invitation.clubId,
          responsibilityKey: "TENANT_ADMINISTRATION",
          role: "PRIMARY",
          effectiveTo: null,
        },
      });
      if (!existingPrimary) {
        await ensureTenantAdministrationBootstrap({
          clubId: invitation.clubId,
          userId: user.id,
          actor: { id: user.id },
          tx,
        });
        bootstrapPrimaryAssigned = true;
      }
    }

    // 5. Flip invitation status.
    await tx.adminInvitation.update({
      where: { id: invitation.id },
      data: {
        status: "ACTIVATED",
        activatedAt: new Date(),
        openedAt: invitation.openedAt ?? new Date(),
        activatedUserId: user.id,
      },
    });

    return { userId: user.id, createdUser, bootstrapPrimaryAssigned };
  }, { timeout: 20_000 });

  await audit({ id: result.userId }, {
    clubId: invitation.clubId,
    action: "admin.invitation.activated",
    entityType: "AdminInvitation",
    entityId: invitation.id,
    after: {
      userId: result.userId,
      createdUser: result.createdUser,
      bootstrapPrimaryAssigned: result.bootstrapPrimaryAssigned,
      roleKeys,
      ip: args?.ip ?? null,
    },
  });

  return {
    invitationId: invitation.id,
    userId: result.userId,
    clubId: invitation.clubId,
    bootstrapPrimaryAssigned: result.bootstrapPrimaryAssigned,
    createdUser: result.createdUser,
    redirectPath: "/app/admin",
  };
}

// ---------------------------------------------------------------------
// Email content (subject + plain-text body)
// ---------------------------------------------------------------------
export function buildAdminInvitationEmail(args: {
  clubName: string;
  inviterName: string;
  displayName: string;
  activationUrl: string;
  expiresAt: Date;
}) {
  const subject = `You've been invited to Spectre — ${args.clubName}`;
  const body = [
    `Hello ${args.displayName || "there"},`,
    ``,
    `${args.inviterName} has invited you to help operate ${args.clubName} on Spectre.`,
    ``,
    `Activate your access here:`,
    args.activationUrl,
    ``,
    `This link expires on ${args.expiresAt.toDateString()}. If you did not expect this email you can ignore it — the link will expire automatically.`,
    ``,
    `Warm regards,`,
    args.clubName,
  ].join("\n");
  return { subject, body };
}

// Lookup by token (used by the /invite/[token] page for read-only display).
export async function findInvitationByToken(token: string) {
  const tokenHash = sha256(token);
  return prisma.adminInvitation.findUnique({
    where: { tokenHash },
    include: {
      club: { select: { id: true, name: true, slug: true, wordmark: true, logoUrl: true } },
      invitedBy: { select: { name: true, email: true } },
    },
  });
}
