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
// Acquire onboarding context (HR-2B.2 hardening) — idempotent, resume-safe.
//
// The redemption HTTP action originally called `redeemInvitation()` and
// then, in separate awaits, looked up the active session and stamped the
// employee-onboarding cookie. A failure between the DB update and the
// cookie write left the invitation permanently REDEEMED with no
// authenticated employee session — the employee could not retry the
// same magic link, and had to ask their Club for a fresh invitation.
//
// Invariant enforced by this function (per HR-2B.2 §0.A):
//
//   > A valid employee must never permanently lose onboarding access
//   > merely because Spectre fails between invitation redemption and
//   > establishment of their authenticated onboarding session.
//
// Behaviour:
//   • First call with a valid, unrevoked, unexpired invitation:
//     marks it REDEEMED, records the ipHash, audits "redeem".
//     Returns { wasFirstRedemption: true }.
//   • Subsequent call with the same token while (a) the invitation
//     itself has not expired AND (b) the linked EmployeeOnboardingSession
//     is still in INVITED or IN_PROGRESS: returns the same context
//     WITHOUT re-stamping redeemedAt, audits "resume" for forensic
//     visibility. Returns { wasFirstRedemption: false }.
//   • Once the session has moved to SUBMITTED / APPROVED / REJECTED /
//     REVOKED, resume is refused — the invitation is terminally spent.
//     The employee's completion-screen route (HR-2B.5) is the correct
//     way to see a submitted onboarding.
//
// This function is the single entry point the /hr/onboarding/[token]
// welcome server-action calls. Callers do not need to compose
// redemption + session lookup themselves; the risk window disappears.
// ---------------------------------------------------------------------------
export interface OnboardingContext {
  invitationId: string;
  clubId: string;
  employeeId: string;
  sessionId: string;
  /** True on first successful redemption; false on subsequent resumes. */
  wasFirstRedemption: boolean;
}

/**
 * Resolve a raw magic-link token into a complete, verified onboarding
 * context. Idempotent within the invitation's TTL and the session's
 * pre-terminal states. See the block comment above for full semantics.
 *
 * Throws:
 *   InvitationNotFoundError          — no invitation matches the token
 *   InvitationRevokedError           — invitation was revoked by staff
 *   InvitationExpiredError           — invitation's expiresAt is in the past
 *   InvitationAlreadyRedeemedError   — invitation was redeemed but the
 *                                      linked session is terminal (SUBMITTED,
 *                                      APPROVED, REJECTED, or REVOKED)
 */
export async function acquireInvitationContext(
  rawToken: string,
  opts: { ipHash: string },
): Promise<OnboardingContext> {
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
  if (invitation.expiresAt.getTime() < Date.now()) throw new InvitationExpiredError();

  // Look up the active onboarding session BEFORE we mutate anything.
  // Order-by startedAt DESC so a re-invitation-after-rejection scenario
  // resolves to the current session, not the historic rejected one.
  const activeSession = await prisma.employeeOnboardingSession.findFirst({
    where: {
      employeeId: invitation.employeeId,
      clubId: invitation.clubId,
    },
    orderBy: { startedAt: "desc" },
    select: { id: true, state: true },
  });
  if (!activeSession) {
    // No session at all — invitation issued against an employee that
    // was subsequently deleted or whose session was hard-purged.
    // Treat as revoked from the employee's perspective (neutral copy).
    throw new InvitationRevokedError();
  }

  // Sessions in SUBMITTED / APPROVED / REJECTED / REVOKED are terminal
  // from the employee's self-service perspective. The invitation is
  // spent — either the employee already finished, or staff moved on.
  const RESUMABLE = ["DRAFT", "INVITED", "IN_PROGRESS"] as const;
  const isResumable = (RESUMABLE as readonly string[]).includes(activeSession.state);

  if (invitation.redeemedAt) {
    // Resume path. Invitation was already consumed. Allow only if the
    // session is still resumable; otherwise the invitation is spent.
    if (!isResumable) {
      throw new InvitationAlreadyRedeemedError();
    }
    await audit(null, {
      action: "hr.onboarding.invite.update",
      entityType: INVITATION_ENTITY,
      entityId: invitation.id,
      clubId: invitation.clubId,
      after: {
        invitationIdTail: invitation.id.slice(-8),
        employeeIdTail: invitation.employeeId.slice(-8),
        sessionState: activeSession.state,
      },
      meta: {
        ipHashTail: opts.ipHash.slice(-8),
        context: "resume",
        note: "invitation already redeemed; resuming with existing session",
      },
    });
    return {
      invitationId: invitation.id,
      clubId: invitation.clubId,
      employeeId: invitation.employeeId,
      sessionId: activeSession.id,
      wasFirstRedemption: false,
    };
  }

  // First-redemption path. Mark REDEEMED + record ipHash + audit.
  // The session must also be resumable — if not (e.g. staff revoked
  // it between issue and first redeem), refuse cleanly.
  if (!isResumable) {
    throw new InvitationRevokedError();
  }
  const now = new Date();
  const updated = await prisma.employeeOnboardingInvitation.update({
    where: { id: invitation.id },
    data: {
      redeemedAt: now,
      redeemedByIpHash: opts.ipHash,
    },
  });
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
      sessionState: activeSession.state,
    },
    meta: { ipHashTail: opts.ipHash.slice(-8), context: "redeem" },
  });
  return {
    invitationId: updated.id,
    clubId: updated.clubId,
    employeeId: updated.employeeId,
    sessionId: activeSession.id,
    wasFirstRedemption: true,
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

// ---------------------------------------------------------------------------
// Supersede — for the resend-invitation flow (HR-2B.3.1 §5).
//
// `revokeInvitation` refuses to revoke a REDEEMED invitation for good
// reason: the historic revocation vocabulary is "the invitation was
// killed before use". A resend, however, must be permitted even when
// the current invitation IS redeemed — the employee already claimed
// their session but lost the email or needs a fresh link.
//
// `supersedeInvitation` uses the same `revokedAt` DB column (there is
// no separate `supersededAt` column on the invitation model), but the
// audit action string is `hr.onboarding.invite.supersede.void` so a
// forensic reader can distinguish "operator killed an active
// invitation" from "operator issued a replacement over a spent one".
// Both actions end in a WRITE_INDICATOR verb (`.void`) so support-
// readonly and posting-guard substring gates fire correctly.
//
// The old token becomes unusable regardless of prior redemption:
//   • not-yet-redeemed  → `acquireInvitationContext` throws
//                          `InvitationRevokedError` (revokedAt set).
//   • already-redeemed  → `acquireInvitationContext` still throws
//                          `InvitationRevokedError` because the
//                          revokedAt check fires BEFORE the redeemedAt
//                          branch.
// ---------------------------------------------------------------------------
export async function supersedeInvitation(
  principal: Principal,
  invitationId: string,
): Promise<void> {
  const invitation = await prisma.employeeOnboardingInvitation.findUnique({
    where: { id: invitationId },
  });
  if (!invitation) throw new NotFoundError(INVITATION_ENTITY, invitationId);
  assertTenantOwned(invitation, principal);
  requirePermission(principal, invitation.clubId, "hr:onboarding:invite");
  await assertSensitiveActionAllowed(
    principal,
    invitation.clubId,
    "hr.onboarding.invite.supersede.void",
    INVITATION_ENTITY,
    invitationId,
  );

  if (invitation.revokedAt) return; // already superseded / revoked

  const updated = await prisma.employeeOnboardingInvitation.update({
    where: { id: invitation.id },
    data: { revokedAt: new Date() },
  });

  await audit(principal, {
    action: "hr.onboarding.invite.supersede.void",
    entityType: INVITATION_ENTITY,
    entityId: updated.id,
    clubId: updated.clubId,
    before: { revokedAt: null, wasRedeemed: !!invitation.redeemedAt },
    after: {
      invitationIdTail: updated.id.slice(-8),
      revokedAt: updated.revokedAt,
    },
    meta: { reason: "superseded_by_resend" },
  });
}

// ---------------------------------------------------------------------------
// Reissue — orchestrator for the HR-2B.3.1 §5 resend-invitation flow.
//
// Rules (founder brief §5 + §5.1 + §5.2):
//   • Active session (DRAFT / INVITED / IN_PROGRESS) + no active
//     invitation → issue a fresh one.
//   • Active session + prior invitation still open (not revoked, not
//     redeemed) → supersede that invitation, issue a fresh one.
//   • Active session + prior invitation already redeemed → supersede
//     it (same DB column, distinct action string), issue a fresh one.
//     The employee's session + all their onboarding responses /
//     acknowledgements / corrections are UNTOUCHED.
//   • Terminal session (SUBMITTED / APPROVED / REJECTED / REVOKED) →
//     `ConflictError` — resend is a no-op on a finished onboarding.
//
// This function is Principal-gated (`hr:onboarding:invite`) and
// tenant-scoped through the underlying `loadEmployee` in
// `issueInvitation` and `supersedeInvitation`. Callers who want the
// email to actually leave the building must call
// `sendInvitationEmail` themselves with the returned `rawToken`.
// ---------------------------------------------------------------------------

const REISSUE_ELIGIBLE_STATES = ["DRAFT", "INVITED", "IN_PROGRESS"] as const;

export async function reissueInvitation(
  principal: Principal,
  employeeId: string,
  opts: { ttlHours?: number } = {},
): Promise<{
  invitationId: string;
  rawToken: string;
  expiresAt: Date;
  sessionState: string;
  supersededInvitationId: string | null;
}> {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:onboarding:invite");
  // The heavier per-write guards fire inside issueInvitation +
  // supersedeInvitation; this early check just refuses obviously
  // wrong callers without any DB churn.

  // Find the currently-active session for this employee. Ordered by
  // startedAt desc so a re-invite-after-rejection resolves to the
  // current session, not the historic rejected one.
  const session = await prisma.employeeOnboardingSession.findFirst({
    where: { employeeId, clubId: employee.clubId },
    orderBy: { startedAt: "desc" },
    select: { id: true, state: true, clubId: true },
  });
  if (!session) {
    throw new ConflictError(
      "No onboarding session exists for this employee — create one first.",
    );
  }
  if (!(REISSUE_ELIGIBLE_STATES as readonly string[]).includes(session.state)) {
    throw new ConflictError(
      `Cannot resend invitation for a ${session.state} session — the onboarding is already finished.`,
    );
  }

  // Find the most recent NON-REVOKED invitation for this employee, if
  // any. That is the one we need to supersede — leaving a revoked
  // row already-revoked is intentional (its own audit trail).
  const priorLive = await prisma.employeeOnboardingInvitation.findFirst({
    where: { employeeId, clubId: employee.clubId, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  let supersededInvitationId: string | null = null;
  if (priorLive) {
    await supersedeInvitation(principal, priorLive.id);
    supersededInvitationId = priorLive.id;
  }

  // Issue the fresh one via the canonical service — this fires its
  // own audit event (`hr.onboarding.invite.update`) with a distinct
  // invitation id.
  const fresh = await issueInvitation(principal, employeeId, {
    ttlHours: opts.ttlHours,
  });

  return {
    invitationId: fresh.invitationId,
    rawToken: fresh.rawToken,
    expiresAt: fresh.expiresAt,
    sessionState: session.state,
    supersededInvitationId,
  };
}
