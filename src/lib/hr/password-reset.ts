// HR mobile-hotfix (2026-08-26) — Employee Portal password reset.
//
// Founder acceptance identified that /employee/login shows a
// "Forgot your password?" link but the reset workflow was not
// implemented. This module provides the canonical service layer.
//
// Design (mirrors invitation-token discipline from src/lib/hr/invitations.ts):
//
//   * Token generation: 32 bytes from crypto.randomBytes,
//     base64url-encoded. Raw token appears ONLY in the emailed URL.
//     The DB stores sha256(rawToken) as `tokenHash`.
//   * Scope: (clubId, employeeId). A token issued for Chris at
//     Coulee Ridge cannot be redeemed to change any other employee's
//     password.
//   * Lifetime: 45 min from issuance (splits the founder-suggested
//     30-60 min band).
//   * One-time use: consumedAt is stamped on redemption; a token
//     already consumed is refused.
//   * Supersede-on-reissue: requesting a new token invalidates
//     (soft-deletes via consumedAt) all outstanding non-consumed
//     tokens for that employee. An older raw link that is still in
//     the employee's inbox stops working the moment they request a
//     new one.
//   * Enumeration resistance: requestPortalPasswordReset ALWAYS
//     returns the same neutral shape regardless of whether the email
//     matches a real employee. Timing is uniform-ish (a dummy hash
//     compare burns the same wall-time as a real token issuance).
//   * Audit: request + redemption are audited via `audit()`; the
//     entity id is the hashed email (request) or employeeId
//     (redemption). Raw token / new password never touch audit
//     payloads.

import crypto from "node:crypto";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { hashPassword } from "../services/auth";
import { NotFoundError, ValidationError } from "../errors";
import { hashEmail } from "../security/auth-guard";
import type { Principal } from "../rbac";
import { requirePermission } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { normaliseLoginEmail, PORTAL_PASSWORD_MIN, PORTAL_PASSWORD_MAX } from "./employee-portal-credential";

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 45 * 60 * 1000;

export function generateResetToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

export function hashResetToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// ---------------------------------------------------------------------------
// Request (issue a token + send the reset email)
// ---------------------------------------------------------------------------

export interface RequestPortalPasswordResetInput {
  email: string;
  /** Host-resolved Club scope (null when the request came from the
   *  shared platform host; same policy as the login lookup). */
  clubId: string | null;
  /** "EMPLOYEE" when triggered by the /employee/forgot-password form;
   *  "STAFF" when an authorised admin used the admin-side
   *  "Send password reset" action on the Employee Profile page. */
  actorSource: "EMPLOYEE" | "STAFF";
  /** Optional — set when actorSource="STAFF" so the audit row can
   *  attribute the request to the initiating admin. */
  initiatorUserId?: string | null;
  /** Public origin the emailed reset link should point to (the
   *  employee's browser origin, resolved from the request Host or
   *  x-forwarded-host at the caller). */
  publicOrigin: string;
}

export interface RequestPortalPasswordResetResult {
  /** ALWAYS "queued" regardless of whether the email matched a real
   *  employee. Neutral shape so callers cannot infer existence. */
  status: "queued";
}

/**
 * Issue a password-reset token + send an email, IFF the normalised
 * email matches exactly one employee-with-a-credential in the target
 * Club scope. Never reveals whether the email matched.
 *
 * Returns the same neutral `{status:"queued"}` result on every path
 * so the caller can render one message.
 */
export async function requestPortalPasswordReset(
  input: RequestPortalPasswordResetInput,
): Promise<RequestPortalPasswordResetResult> {
  const email = normaliseLoginEmail(input.email);
  if (!email) {
    // Still record an audit + return neutral so callers cannot
    // distinguish "empty email" from "no such employee".
    await audit(null, {
      action: "employee_portal.password_reset.request",
      entityType: "EmployeePortalPasswordReset",
      entityId: `hash:${hashEmail(email)}`,
      clubId: input.clubId ?? "platform",
      meta: {
        actorSource: input.actorSource,
        initiatorUserIdTail: input.initiatorUserId?.slice(-8) ?? null,
        outcome: "no_match",
      },
    });
    return { status: "queued" };
  }

  const candidates = await prisma.employee.findMany({
    where: {
      personalEmail: email,
      ...(input.clubId ? { clubId: input.clubId } : {}),
    },
    select: {
      id: true, clubId: true, firstName: true, lastName: true, preferredName: true,
      personalEmail: true,
      portalCredential: { select: { id: true } },
    },
  });
  const withCred = candidates.filter((c) => c.portalCredential !== null);

  // Same-shape outcome for: no match / no credential / ambiguous-Club.
  // The service NEVER silently picks a Club when scope is null and
  // >1 employees match — a reset that could target either would be
  // a targeting-integrity failure. Callers see the same neutral
  // response as unknown-email.
  if (withCred.length !== 1) {
    await audit(null, {
      action: "employee_portal.password_reset.request",
      entityType: "EmployeePortalPasswordReset",
      entityId: `hash:${hashEmail(email)}`,
      clubId: input.clubId ?? "platform",
      meta: {
        actorSource: input.actorSource,
        initiatorUserIdTail: input.initiatorUserId?.slice(-8) ?? null,
        outcome: withCred.length === 0 ? "no_match" : "ambiguous",
        candidateCount: withCred.length,
      },
    });
    return { status: "queued" };
  }

  const target = withCred[0]!;
  const { raw, hash } = generateResetToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);

  await prisma.$transaction(async (tx) => {
    // Supersede all outstanding tokens for this employee. Any older
    // raw link in the employee's inbox is now inert.
    await tx.employeePortalPasswordReset.updateMany({
      where: {
        employeeId: target.id,
        clubId: target.clubId,
        consumedAt: null,
      },
      data: { consumedAt: now },
    });
    await tx.employeePortalPasswordReset.create({
      data: {
        clubId: target.clubId,
        employeeId: target.id,
        tokenHash: hash,
        expiresAt,
      },
    });
  });

  // Send the email. Best-effort: if delivery fails we still return
  // "queued" (neutral) — an operator sees the failure in the
  // audit row and via the email adapter's dev-log / provider logs.
  try {
    const { sendPortalPasswordResetEmail } = await import("./password-reset-email");
    const url = `${input.publicOrigin.replace(/\/$/, "")}/employee/reset-password?token=${encodeURIComponent(raw)}`;
    const displayName = target.preferredName?.trim()
      ? `${target.preferredName} ${target.lastName}`
      : `${target.firstName} ${target.lastName}`;
    await sendPortalPasswordResetEmail({
      clubId: target.clubId,
      toEmail: target.personalEmail!,
      employeeDisplayName: displayName,
      resetUrl: url,
      expiresAt,
      // Attribute the send to the admin user when applicable so the
      // email adapter's delegated-outbound flow uses that user's
      // Microsoft Graph identity. When null (employee self-service),
      // the adapter falls back to the Club's designated sender.
      callerUserId: input.initiatorUserId ?? null,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[hr] password-reset email send failed (non-fatal)", {
      employeeIdTail: target.id.slice(-8),
      err: err instanceof Error ? err.message : String(err),
    });
  }

  await audit(null, {
    action: "employee_portal.password_reset.request",
    entityType: "EmployeePortalPasswordReset",
    entityId: `hash:${hashEmail(email)}`,
    clubId: target.clubId,
    meta: {
      actorSource: input.actorSource,
      initiatorUserIdTail: input.initiatorUserId?.slice(-8) ?? null,
      outcome: "issued",
      employeeIdTail: target.id.slice(-8),
      expiresAtIso: expiresAt.toISOString(),
    },
  });

  return { status: "queued" };
}

// ---------------------------------------------------------------------------
// Verify (used by the reset page to gate the form render)
// ---------------------------------------------------------------------------

export interface VerifyPortalResetTokenResult {
  kind: "valid" | "invalid" | "expired" | "consumed";
  /** Present only on kind="valid". */
  employeeId?: string;
  clubId?: string;
}

export async function verifyPortalPasswordResetToken(
  rawToken: string,
): Promise<VerifyPortalResetTokenResult> {
  if (!rawToken) return { kind: "invalid" };
  const hash = hashResetToken(rawToken);
  const row = await prisma.employeePortalPasswordReset.findUnique({
    where: { tokenHash: hash },
    select: { id: true, employeeId: true, clubId: true, expiresAt: true, consumedAt: true },
  });
  if (!row) return { kind: "invalid" };
  if (row.consumedAt) return { kind: "consumed" };
  if (row.expiresAt <= new Date()) return { kind: "expired" };
  return { kind: "valid", employeeId: row.employeeId, clubId: row.clubId };
}

// ---------------------------------------------------------------------------
// Complete (rotate password + consume token + reset lockout)
// ---------------------------------------------------------------------------

export interface CompletePortalPasswordResetInput {
  rawToken: string;
  password: string;
  confirmPassword: string;
}

export interface CompletePortalPasswordResetSuccess {
  kind: "success";
  employeeId: string;
  clubId: string;
}
export interface CompletePortalPasswordResetFailure {
  kind: "invalid_token" | "expired_token" | "consumed_token" | "password_mismatch" | "password_policy";
  policyMessage?: string;
}
export type CompletePortalPasswordResetResult =
  | CompletePortalPasswordResetSuccess
  | CompletePortalPasswordResetFailure;

export async function completePortalPasswordReset(
  input: CompletePortalPasswordResetInput,
): Promise<CompletePortalPasswordResetResult> {
  if (input.password !== input.confirmPassword) {
    return { kind: "password_mismatch" };
  }
  if (typeof input.password !== "string") {
    return { kind: "password_policy", policyMessage: "Password is required" };
  }
  if (input.password.length < PORTAL_PASSWORD_MIN) {
    return {
      kind: "password_policy",
      policyMessage: `Password must be at least ${PORTAL_PASSWORD_MIN} characters`,
    };
  }
  if (input.password.length > PORTAL_PASSWORD_MAX) {
    return {
      kind: "password_policy",
      policyMessage: `Password must be at most ${PORTAL_PASSWORD_MAX} characters`,
    };
  }

  const hash = hashResetToken(input.rawToken);
  const now = new Date();

  const row = await prisma.employeePortalPasswordReset.findUnique({
    where: { tokenHash: hash },
    select: { id: true, employeeId: true, clubId: true, expiresAt: true, consumedAt: true },
  });
  if (!row) return { kind: "invalid_token" };
  if (row.consumedAt) return { kind: "consumed_token" };
  if (row.expiresAt <= now) return { kind: "expired_token" };

  const passwordHash = await hashPassword(input.password);

  await prisma.$transaction(async (tx) => {
    // Rotate the credential row: new hash, clear failed-attempt
    // counter + lockout (successful reset = fresh start).
    await tx.employeePortalCredential.update({
      where: { employeeId: row.employeeId },
      data: {
        passwordHash,
        passwordUpdatedAt: now,
        failedAttemptCount: 0,
        lockedUntil: null,
      },
    });
    // Consume THIS token.
    await tx.employeePortalPasswordReset.update({
      where: { id: row.id },
      data: { consumedAt: now },
    });
    // Belt-and-suspenders: invalidate any OTHER outstanding tokens
    // for the same employee (there shouldn't be any thanks to
    // supersede-on-reissue, but this closes a race).
    await tx.employeePortalPasswordReset.updateMany({
      where: {
        employeeId: row.employeeId,
        clubId: row.clubId,
        consumedAt: null,
      },
      data: { consumedAt: now },
    });
  });

  await audit(null, {
    action: "employee_portal.password_reset.consume",
    entityType: "EmployeePortalCredential",
    entityId: row.employeeId,
    clubId: row.clubId,
    meta: {
      actorSource: "EMPLOYEE",
      employeeIdTail: row.employeeId.slice(-8),
    },
  });

  return { kind: "success", employeeId: row.employeeId, clubId: row.clubId };
}

// ---------------------------------------------------------------------------
// Admin action: "Send password reset" — canonical wrapper around
// requestPortalPasswordReset with the admin's Principal as the
// initiator. Enforces the write permission at the service layer.
// ---------------------------------------------------------------------------

export async function adminSendPortalPasswordReset(
  principal: Principal,
  employeeId: string,
  opts: { publicOrigin: string },
): Promise<{ status: "queued" }> {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, clubId: true, personalEmail: true },
  });
  if (!employee) throw new NotFoundError("Employee", employeeId);
  assertTenantOwned(employee, principal);
  requirePermission(principal, employee.clubId, "hr:employee:write");

  if (!employee.personalEmail) {
    throw new ValidationError([
      { path: "personalEmail", message: "This employee has no email address on file." },
    ]);
  }

  const result = await requestPortalPasswordReset({
    email: employee.personalEmail,
    clubId: employee.clubId,
    actorSource: "STAFF",
    initiatorUserId: principal.id,
    publicOrigin: opts.publicOrigin,
  });

  await audit(principal, {
    action: "employee_portal.password_reset.admin_request",
    entityType: "EmployeePortalPasswordReset",
    entityId: employeeId,
    clubId: employee.clubId,
    meta: {
      initiatorUserIdTail: principal.id.slice(-8),
      employeeIdTail: employeeId.slice(-8),
    },
  });

  return result;
}
