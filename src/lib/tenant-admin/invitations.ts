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
  ForbiddenError,
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
import {
  sendAdminInvitationEmail,
  resolvePublicHost,
  type AdminInvitationDeliveryResult,
} from "./invitation-email";

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

export type CreateAdminInvitationResult = {
  invitation: Awaited<ReturnType<typeof prisma.adminInvitation.create>>;
  delivery: AdminInvitationDeliveryResult;
  // Whether the invitation email matched an EXISTING Spectre User at
  // create time. Used by the UI copy ("They already have a Spectre
  // account — they will be prompted to sign in.").
  existingUser: boolean;
  // Callers must NOT expose this to product UI. Returned so tests +
  // controlled operator flows can build an activation URL without a
  // second DB read. The API route filters it based on
  // SPECTRE_ALLOW_ACTIVATION_URL + SUPER_ADMIN caller.
  rawToken: string;
};

export async function createAdminInvitation(
  principal: Principal,
  raw: unknown,
): Promise<CreateAdminInvitationResult> {
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

  // Deliver — reuses Spectre's canonical multi-provider email stack.
  const delivery = await deliverInvitationEmail({
    invitation,
    principal,
    rawToken,
    existingUser: existingUser !== null,
  });

  // Re-read to pick up the persistInvitationDelivery-updated status.
  const refreshed = await prisma.adminInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
  return { invitation: refreshed, delivery, existingUser: existingUser !== null, rawToken };
}

async function deliverInvitationEmail(args: {
  invitation: Awaited<ReturnType<typeof prisma.adminInvitation.create>>;
  principal: Principal;
  rawToken: string;
  existingUser: boolean;
}): Promise<AdminInvitationDeliveryResult> {
  const { invitation, principal, rawToken, existingUser } = args;
  const [club, inviter] = await Promise.all([
    prisma.club.findUnique({ where: { id: invitation.clubId }, select: { name: true } }),
    prisma.user.findUnique({ where: { id: principal.id }, select: { name: true, email: true } }),
  ]);
  const clubName = club?.name ?? "your Club";
  const inviterName = inviter?.name || inviter?.email || "A Club administrator";
  const composedName = [invitation.firstName, invitation.lastName].filter(Boolean).join(" ").trim();
  const displayName = invitation.displayName ?? composedName ?? invitation.email.split("@")[0];

  let publicHost: string;
  try {
    publicHost = resolvePublicHost();
  } catch {
    // APP_URL not configured. Persist a NOT_ATTEMPTED-style row so
    // status accurately reflects reality; do not silently mark SENT.
    await prisma.adminInvitation.update({
      where: { id: invitation.id },
      data: {
        status: "FAILED",
        failedAt: new Date(),
        lastError: "APP_URL not configured",
      },
    });
    return {
      status: "FAILED", provider: null, providerMessageId: null,
      failureReason: "APP_URL not configured", externalSendConfirmed: false, operatorAlert: true,
    };
  }

  return sendAdminInvitationEmail({
    clubId: invitation.clubId,
    invitationId: invitation.id,
    toEmail: invitation.email,
    clubName,
    inviterName,
    displayName,
    isExistingUser: existingUser,
    rawToken,
    publicHost,
    expiresAt: invitation.expiresAt,
    callerUserId: principal.id,
  });
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
export type ResendAdminInvitationResult = {
  invitation: Awaited<ReturnType<typeof prisma.adminInvitation.create>>;
  delivery: AdminInvitationDeliveryResult;
  rawToken: string;
};

export async function resendAdminInvitation(
  principal: Principal,
  invitationId: string,
): Promise<ResendAdminInvitationResult> {
  const existing = await prisma.adminInvitation.findUnique({ where: { id: invitationId } });
  if (!existing) throw new NotFoundError("AdminInvitation", invitationId);
  await assertTenantUsersWrite(principal, existing.clubId);
  if (existing.status === "ACTIVATED") throw new ConflictError("Invitation is already activated.");
  if (existing.status === "REVOKED") throw new ConflictError("Invitation is revoked and cannot be resent.");

  // Simple abuse protection: refuse resend within 60s of the prior
  // attempt. Deliberately lightweight; a full rate-limit surface is
  // out of scope for TA-1B closeout. See §37.
  if (existing.sentAt && Date.now() - existing.sentAt.getTime() < 60_000) {
    throw new ConflictError("Please wait at least one minute between invitation resends.");
  }

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

  const existingUser = await prisma.user.findUnique({ where: { email: invitation.email }, select: { id: true } });
  const delivery = await deliverInvitationEmail({
    invitation, principal, rawToken, existingUser: existingUser !== null,
  });
  const refreshed = await prisma.adminInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
  return { invitation: refreshed, delivery, rawToken };
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
// Activation — TWO EXPLICIT PATHS (TA-1B closeout §3-§7).
//
// Path A: activateAdminInvitationAsNewUser
//   Invitation email does NOT match an existing User. Creates the
//   Spectre account, hashes password, wires memberships + profile.
//
// Path B: acceptAdminInvitationAsExistingUser
//   Invitation email matches an existing User. Caller MUST be
//   authenticated as that User (verified by service). Adds the new
//   Club membership + profile. PASSWORD HASH IS NEVER TOUCHED.
//
// The public activation endpoint dispatches to the right path based on
// whether the invitation email matches an existing User AND on the
// authenticated principal's identity. Callers cannot bypass the split
// by passing a password to path B — that arg simply isn't part of B's
// signature.
// ---------------------------------------------------------------------

export type ActivationResult = {
  invitationId: string;
  userId: string;
  clubId: string;
  bootstrapPrimaryAssigned: boolean;
  createdUser: boolean;
  redirectPath: string;
};

/**
 * Look up an invitation and enforce the shared lifecycle preconditions
 * (not activated, not revoked, not expired). Never throws token or
 * plaintext into any error message. Returns the invitation row.
 */
async function loadActivatableInvitation(rawToken: string) {
  const tokenHash = sha256(rawToken);
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
  return invitation;
}

function validateAndTightenPassword(password: string, confirmPassword: string) {
  if (password !== confirmPassword) {
    throw new ValidationError([{ path: "confirmPassword", message: "Passwords do not match." }]);
  }
  if (password.length < 10 || password.length > 200) {
    throw new ValidationError([{ path: "password", message: "Password must be 10–200 characters." }]);
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
    throw new ValidationError([
      { path: "password", message: "Password must include upper case, lower case, and a digit." },
    ]);
  }
}

function normaliseRoleKeys(csv: string): string[] {
  const keys = csv.split(",").map((r) => r.trim()).filter(Boolean).filter(isTenantAssignableRole);
  if (keys.length === 0) {
    throw new ConflictError("Invitation has no tenant-assignable roles.");
  }
  return keys;
}

function invitationDisplayName(invitation: {
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string;
}): string {
  if (invitation.displayName) return invitation.displayName;
  const composed = [invitation.firstName, invitation.lastName].filter(Boolean).join(" ").trim();
  return composed || invitation.email.split("@")[0];
}

/**
 * PATH A — brand-new Spectre account.
 *
 * Refuses if the invitation email already matches a User (that caller
 * must use acceptAdminInvitationAsExistingUser). This prevents any
 * caller from silently overwriting an existing password via this path.
 */
export const activateAsNewUserSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(10).max(200),
  confirmPassword: z.string().min(10).max(200),
  fullName: z.string().min(1).max(160).optional(),
});
export type ActivateAsNewUserInput = z.infer<typeof activateAsNewUserSchema>;

export async function activateAdminInvitationAsNewUser(
  raw: unknown,
  args?: { ip?: string; userAgent?: string },
): Promise<ActivationResult> {
  const parsed = activateAsNewUserSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  const input = parsed.data;
  validateAndTightenPassword(input.password, input.confirmPassword);

  const invitation = await loadActivatableInvitation(input.token);

  const existingUser = await prisma.user.findUnique({ where: { email: invitation.email } });
  if (existingUser) {
    throw new ConflictError(
      "This email is already a Spectre account. Sign in to accept your invitation instead of creating a new account.",
    );
  }

  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.hash(input.password, 10);
  const roleKeys = normaliseRoleKeys(invitation.initialRoleKeys);
  const displayName = invitation.displayName ?? input.fullName ?? invitationDisplayName(invitation);

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: invitation.email,
        name: displayName,
        role: roleKeys[0], // deprecated scalar; kept for legacy readers
        passwordHash,
        status: "ACTIVE",
        clubId: invitation.clubId, // deprecated scalar; kept for legacy readers
      },
    });

    for (const roleKey of roleKeys) {
      await tx.userClubRole.create({ data: { userId: user.id, clubId: invitation.clubId, roleKey } });
    }
    await upsertProfile({
      clubId: invitation.clubId,
      userId: user.id,
      actor: { id: user.id },
      displayTitle: invitation.displayTitle,
      departmentId: invitation.departmentId,
      employeeId: invitation.employeeId,
      tx,
    });

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
          clubId: invitation.clubId, userId: user.id, actor: { id: user.id }, tx,
        });
        bootstrapPrimaryAssigned = true;
      }
    }

    await tx.adminInvitation.update({
      where: { id: invitation.id },
      data: {
        status: "ACTIVATED",
        activatedAt: new Date(),
        openedAt: invitation.openedAt ?? new Date(),
        activatedUserId: user.id,
      },
    });
    return { userId: user.id, bootstrapPrimaryAssigned };
  }, { timeout: 20_000 });

  await audit({ id: result.userId }, {
    clubId: invitation.clubId,
    action: "admin.invitation.activated",
    entityType: "AdminInvitation",
    entityId: invitation.id,
    after: {
      userId: result.userId, createdUser: true,
      bootstrapPrimaryAssigned: result.bootstrapPrimaryAssigned,
      roleKeys, path: "new-user", ip: args?.ip ?? null,
    },
  });

  return {
    invitationId: invitation.id, userId: result.userId, clubId: invitation.clubId,
    bootstrapPrimaryAssigned: result.bootstrapPrimaryAssigned, createdUser: true,
    redirectPath: "/app/admin",
  };
}

/**
 * PATH B — existing Spectre account accepting a new tenant membership.
 *
 * Caller MUST be authenticated as the User whose email matches the
 * invitation. The caller's Principal.id is compared to the User row
 * matched by invitation.email (case-insensitive, already normalised).
 * On mismatch → ForbiddenError (§32 wrong-session refusal).
 *
 * Never touches the User's passwordHash, name, or global auth state.
 * Only writes:
 *   - UserClubRole rows for this club
 *   - UserClubProfile (this club only)
 *   - Optional TENANT_ADMINISTRATION bootstrap
 *   - Invitation status → ACTIVATED
 */
export async function acceptAdminInvitationAsExistingUser(
  args: { token: string; principal: Principal; ip?: string; userAgent?: string },
): Promise<ActivationResult> {
  const invitation = await loadActivatableInvitation(args.token);

  const targetUser = await prisma.user.findUnique({ where: { email: invitation.email } });
  if (!targetUser) {
    throw new ConflictError(
      "This invitation is for a new Spectre account. Complete the account-creation flow instead.",
    );
  }

  if (targetUser.id !== args.principal.id) {
    // Wrong-session refusal — never silently sign the caller out and
    // proceed. Do not mutate anything.
    throw new ForbiddenError(
      "This invitation belongs to a different Spectre account. Sign in as that account to accept it.",
    );
  }
  if (targetUser.status !== "ACTIVE") {
    throw new ConflictError(`This Spectre account is ${targetUser.status.toLowerCase()}; contact support before accepting.`);
  }

  const roleKeys = normaliseRoleKeys(invitation.initialRoleKeys);

  const result = await prisma.$transaction(async (tx) => {
    // Wire memberships — idempotent.
    for (const roleKey of roleKeys) {
      await tx.userClubRole.upsert({
        where: { userId_clubId_roleKey: { userId: targetUser.id, clubId: invitation.clubId, roleKey } },
        update: {},
        create: { userId: targetUser.id, clubId: invitation.clubId, roleKey },
      });
    }
    await upsertProfile({
      clubId: invitation.clubId,
      userId: targetUser.id,
      actor: { id: targetUser.id },
      displayTitle: invitation.displayTitle,
      departmentId: invitation.departmentId,
      employeeId: invitation.employeeId,
      tx,
    });

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
          clubId: invitation.clubId, userId: targetUser.id, actor: { id: targetUser.id }, tx,
        });
        bootstrapPrimaryAssigned = true;
      }
    }

    await tx.adminInvitation.update({
      where: { id: invitation.id },
      data: {
        status: "ACTIVATED",
        activatedAt: new Date(),
        openedAt: invitation.openedAt ?? new Date(),
        activatedUserId: targetUser.id,
      },
    });
    return { userId: targetUser.id, bootstrapPrimaryAssigned };
  }, { timeout: 20_000 });

  await audit({ id: result.userId }, {
    clubId: invitation.clubId,
    action: "admin.invitation.activated",
    entityType: "AdminInvitation",
    entityId: invitation.id,
    after: {
      userId: result.userId, createdUser: false,
      bootstrapPrimaryAssigned: result.bootstrapPrimaryAssigned,
      roleKeys, path: "existing-user", ip: args.ip ?? null,
    },
  });

  return {
    invitationId: invitation.id, userId: result.userId, clubId: invitation.clubId,
    bootstrapPrimaryAssigned: result.bootstrapPrimaryAssigned, createdUser: false,
    redirectPath: "/app/admin",
  };
}

/**
 * Introspect an invitation without mutating it. Used by the landing
 * page + the /accept endpoint to decide which path to render.
 * Returns a public-safe subset — no token, no hash, no role keys.
 */
export async function describeInvitationForLanding(rawToken: string): Promise<{
  invitationId: string;
  clubId: string;
  clubName: string;
  email: string;
  displayName: string;
  displayTitle: string | null;
  expiresAt: Date;
  status: string;
  bootstrap: boolean;
  requiresExistingUserSignIn: boolean;
  existingUserId: string | null;
  inviterName: string | null;
}> {
  const tokenHash = sha256(rawToken);
  const invitation = await prisma.adminInvitation.findUnique({
    where: { tokenHash },
    include: {
      club: { select: { id: true, name: true } },
      invitedBy: { select: { name: true, email: true } },
    },
  });
  if (!invitation) throw new NotFoundError("AdminInvitation", "token");
  const existingUser = await prisma.user.findUnique({
    where: { email: invitation.email },
    select: { id: true },
  });
  return {
    invitationId: invitation.id,
    clubId: invitation.clubId,
    clubName: invitation.club.name,
    email: invitation.email,
    displayName: invitationDisplayName(invitation),
    displayTitle: invitation.displayTitle,
    expiresAt: invitation.expiresAt,
    status: invitation.status,
    bootstrap: invitation.bootstrap,
    requiresExistingUserSignIn: existingUser !== null,
    existingUserId: existingUser?.id ?? null,
    inviterName: invitation.invitedBy?.name ?? invitation.invitedBy?.email ?? null,
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
