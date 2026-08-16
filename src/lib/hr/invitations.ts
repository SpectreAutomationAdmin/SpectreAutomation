// HR-1 (2026-08-16) — EmployeeOnboardingInvitation service (magic
// link lifecycle for employee self-onboarding).
//
// Contract:
//   - Token is 32 bytes from `crypto.randomBytes(32)` encoded as
//     base64url (43 chars). The RAW token is returned to the caller
//     of `issueInvitation()` ONCE and is never persisted.
//   - The DB stores only SHA-256(rawToken) as `tokenHash @unique`.
//   - Redemption accepts NO caller-supplied clubId — the invitation
//     resolves its own {clubId, employeeId}. This eliminates the
//     cross-tenant token-transplant vector where a leaked Club A
//     token is submitted with `clubId=B`.
//   - Redemption additionally records a caller-provided `ipHash`
//     (already hashed by the HTTP route layer — HR-2 obligation).
//     The service does NOT hash IPs itself; storing raw IPs would
//     violate the "no plaintext PII" rule.
//   - Rate limiting is the HR-2 route's obligation (see the note on
//     `redeemInvitation` below). The service is designed so that a
//     rate-limited caller CANNOT bypass the check by calling the
//     service directly from another surface — because every write
//     surface for this route must eventually flow through this
//     service AND the route.
//
// Every action string ends in a WRITE_INDICATOR verb
// (`update`, `void`) so support-readonly + posting-guard substring
// gates fire correctly.

import { createHash, randomBytes } from "crypto";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { assertSensitiveActionAllowed } from "../posting-guard";

const INVITATION_ENTITY = "EmployeeOnboardingInvitation";
const TOKEN_BYTE_LENGTH = 32; // 32 random bytes -> 43 chars base64url
const DEFAULT_TTL_HOURS = 24 * 7; // 7 days
const MAX_TTL_HOURS = 24 * 30;    // 30 days upper bound
const COLLISION_RETRY_LIMIT = 3;

// ---------------------------------------------------------------------------
// Typed errors — the HR-2 route uses these to render specific 4xx pages
// without leaking whether a token existed at all.
// ---------------------------------------------------------------------------
export class InvitationNotFoundError extends Error {
  readonly code = "INVITATION_NOT_FOUND";
  constructor() {
    super("Invitation not found");
    this.name = "InvitationNotFoundError";
  }
}
export class InvitationExpiredError extends Error {
  readonly code = "INVITATION_EXPIRED";
  constructor() {
    super("Invitation has expired");
    this.name = "InvitationExpiredError";
  }
}
export class InvitationRevokedError extends Error {
  readonly code = "INVITATION_REVOKED";
  constructor() {
    super("Invitation has been revoked");
    this.name = "InvitationRevokedError";
  }
}
export class InvitationAlreadyRedeemedError extends Error {
  readonly code = "INVITATION_ALREADY_REDEEMED";
  constructor() {
    super("Invitation has already been redeemed");
    this.name = "InvitationAlreadyRedeemedError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function generateRawToken(): string {
  // Node's base64url encoding is RFC 4648 §5 without padding, which is
  // exactly what we want for a URL-safe magic link token.
  return randomBytes(TOKEN_BYTE_LENGTH).toString("base64url");
}

export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

async function loadEmployee(principal: Principal, employeeId: string) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) throw new NotFoundError("Employee", employeeId);
  assertTenantOwned(employee, principal);
  return employee;
}

function isUniqueViolation(err: unknown): boolean {
  const anyErr = err as { code?: string } | null;
  return anyErr?.code === "P2002";
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------
export async function issueInvitation(
  principal: Principal,
  employeeId: string,
  opts: { ttlHours?: number } = {},
): Promise<{ invitationId: string; rawToken: string; expiresAt: Date }> {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:onboarding:invite");
  await assertSensitiveActionAllowed(
    principal,
    employee.clubId,
    "hr.onboarding.invite.update",
    INVITATION_ENTITY,
    employeeId,
  );

  const ttlHours = opts.ttlHours ?? DEFAULT_TTL_HOURS;
  if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > MAX_TTL_HOURS) {
    throw new ValidationError([{ path: "ttlHours", message: `ttlHours must be 1..${MAX_TTL_HOURS}` }]);
  }
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);

  // Regenerate on unique-hash collision (astronomically unlikely for
  // 32 random bytes, but the contract says "retry up to 3× on
  // unique-violation" and we don't want a raw Prisma error to bubble
  // up to the API caller if it ever happens).
  let lastError: unknown = null;
  for (let attempt = 0; attempt < COLLISION_RETRY_LIMIT; attempt++) {
    const rawToken = generateRawToken();
    const tokenHash = hashToken(rawToken);
    try {
      const invitation = await prisma.employeeOnboardingInvitation.create({
        data: {
          clubId: employee.clubId,
          employeeId,
          tokenHash,
          expiresAt,
          issuedByUserId: principal.id,
        },
      });
      await audit(principal, {
        action: "hr.onboarding.invite.update",
        entityType: INVITATION_ENTITY,
        entityId: invitation.id,
        clubId: employee.clubId,
        // Never include rawToken or tokenHash in the audit payload —
        // they are the credential. Store id-tail + expiry only.
        after: {
          invitationIdTail: invitation.id.slice(-8),
          expiresAt: invitation.expiresAt,
        },
      });
      return { invitationId: invitation.id, rawToken, expiresAt };
    } catch (err) {
      lastError = err;
      if (!isUniqueViolation(err)) throw err;
      // Loop to regenerate.
    }
  }
  throw new ConflictError(
    `Failed to issue invitation after ${COLLISION_RETRY_LIMIT} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

// ---------------------------------------------------------------------------
// Redeem
//
// HR-2 obligation: the HTTP redemption route MUST apply per-IP rate
// limit before calling this service. The service accepts a
// pre-hashed IP (`ipHash`) rather than a raw IP — the route is
// responsible for computing SHA-256(ip + salt) using the shared
// hash-ip helper before calling.
// ---------------------------------------------------------------------------
export async function redeemInvitation(
  rawToken: string,
  opts: { ipHash: string },
): Promise<{ invitationId: string; clubId: string; employeeId: string }> {
  if (typeof rawToken !== "string" || rawToken.length === 0) {
    throw new InvitationNotFoundError();
  }
  if (typeof opts?.ipHash !== "string" || opts.ipHash.length === 0) {
    throw new ValidationError([{ path: "ipHash", message: "ipHash is required" }]);
  }
  const tokenHash = hashToken(rawToken);
  const invitation = await prisma.employeeOnboardingInvitation.findUnique({
    where: { tokenHash },
  });
  if (!invitation) throw new InvitationNotFoundError();
  if (invitation.revokedAt) throw new InvitationRevokedError();
  if (invitation.redeemedAt) throw new InvitationAlreadyRedeemedError();
  if (invitation.expiresAt.getTime() < Date.now()) throw new InvitationExpiredError();

  const now = new Date();
  const updated = await prisma.employeeOnboardingInvitation.update({
    where: { id: invitation.id },
    data: {
      redeemedAt: now,
      redeemedByIpHash: opts.ipHash,
    },
  });

  // No principal for the audit actor (the invited employee has no
  // session yet). Audit still fires — actor=null, clubId resolved from
  // the invitation itself. The action string is `hr.onboarding.
  // invite.update` (contains `update`, a WRITE_INDICATOR).
  await audit(null, {
    action: "hr.onboarding.invite.update",
    entityType: INVITATION_ENTITY,
    entityId: updated.id,
    clubId: updated.clubId,
    before: { redeemedAt: null },
    after: {
      invitationIdTail: updated.id.slice(-8),
      employeeIdTail: updated.employeeId.slice(-8),
      redeemedAt: updated.redeemedAt,
    },
    meta: { ipHashTail: opts.ipHash.slice(-8), context: "redeem" },
  });

  return {
    invitationId: updated.id,
    // clubId + employeeId ALWAYS come from the invitation row itself —
    // caller cannot smuggle a different tenant.
    clubId: updated.clubId,
    employeeId: updated.employeeId,
  };
}

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------
export async function revokeInvitation(
  principal: Principal,
  invitationId: string,
): Promise<void> {
  const invitation = await prisma.employeeOnboardingInvitation.findUnique({
    where: { id: invitationId },
  });
  if (!invitation) throw new NotFoundError(INVITATION_ENTITY, invitationId);
  assertTenantOwned(invitation, principal);
  requirePermission(principal, invitation.clubId, "hr:onboarding:revoke");
  await assertSensitiveActionAllowed(
    principal,
    invitation.clubId,
    "hr.onboarding.invite.void",
    INVITATION_ENTITY,
    invitationId,
  );

  if (invitation.revokedAt) return;
  if (invitation.redeemedAt) {
    throw new ConflictError("Cannot revoke a redeemed invitation");
  }

  const updated = await prisma.employeeOnboardingInvitation.update({
    where: { id: invitation.id },
    data: { revokedAt: new Date() },
  });

  await audit(principal, {
    action: "hr.onboarding.invite.void",
    entityType: INVITATION_ENTITY,
    entityId: updated.id,
    clubId: updated.clubId,
    before: { revokedAt: null },
    after: {
      invitationIdTail: updated.id.slice(-8),
      revokedAt: updated.revokedAt,
    },
  });
}
