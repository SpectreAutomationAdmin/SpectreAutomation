// SIGNUP-1F (2026-10-20) — Recovery-link service.
//
// Separates email-delivered recovery credentials from the persistent
// SignupRegistration record.  Each row in SignupRecoveryLink is:
//
//   • Short-lived.    expiresAt is set at issue time (default 24h).
//                     Resolver treats expired rows as unusable.
//   • Single-use.     consumeRecoveryLink sets consumedAt in the
//                     same conditional update as the lookup, so a
//                     race between two concurrent consume calls
//                     resolves to exactly one success.
//   • Revocable.      Operator can call revokeAllForRegistration.
//                     issueRecoveryLink auto-revokes any still-active
//                     prior rows with revokeReason="SUPERSEDED".
//
// Logs:
//   • issue    — registrationIdTail + maskedEmail + linkIdTail +
//                supersededCount.  Never the token, never the full
//                email.
//   • consume  — registrationIdTail + linkIdTail + outcome.  Never
//                the token.
//
// Credential surface:
//   • The DB id is NEVER emitted in any URL.
//   • The plaintext token is returned ONCE from issueRecoveryLink
//     to its caller, who places it in the email body.
//   • Only sha-256(token) is stored.
//
// This service is a strict superset of the previous
// SignupRegistration.emailResumeTokenHash column.  That column
// remains on the row for migration compat but is no longer written
// by any code path.  resolveRegistrationByToken still accepts a
// match against it so any email already in flight at deploy time
// continues to work.

import { prisma } from "@/lib/prisma";
import { generateOpaqueToken, sha256HashHex } from "@/lib/auth/pkce";
import { logger } from "@/lib/observability/logger";

// Default link TTL — 24 hours.  Short enough that a leaked email
// link is time-boxed; long enough for a next-day click.
const RECOVERY_LINK_TTL_MS = Number(
  process.env.SIGNUP_RECOVERY_LINK_TTL_MS ?? String(24 * 60 * 60 * 1000),
);

export type RecoveryLinkRevokeReason =
  | "SUPERSEDED"
  | "ADMIN_REVOKED"
  | "ABUSE_SUSPECTED";

export type ConsumeOutcome =
  | { status: "SUCCESS"; registrationId: string; linkId: string }
  | { status: "NOT_FOUND" }
  | { status: "ALREADY_CONSUMED" }
  | { status: "REVOKED" }
  | { status: "EXPIRED" };

/**
 * Issue a fresh recovery link for a registration.  Returns the
 * plaintext token so the caller can place it in the email body.
 *
 * Auto-revokes any still-active prior links for the same
 * registration with revokeReason="SUPERSEDED".  This prevents a
 * leaked older email from working after a fresh one is sent.
 */
export async function issueRecoveryLink(args: {
  registrationId: string;
  toEmail: string;
  issuedByIp?: string | null;
  ttlMs?: number;
}): Promise<{ token: string; linkId: string; expiresAt: Date }> {
  const token = generateOpaqueToken(32);
  const tokenHash = sha256HashHex(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (args.ttlMs ?? RECOVERY_LINK_TTL_MS));

  // Supersede any still-active prior links in a single query.  We
  // deliberately do NOT delete — the audit trail must survive.
  const supersede = await prisma.signupRecoveryLink.updateMany({
    where: {
      registrationId: args.registrationId,
      consumedAt: null,
      revokedAt: null,
      expiresAt: { gt: now },
    },
    data: {
      revokedAt: now,
      revokeReason: "SUPERSEDED",
    },
  });

  const row = await prisma.signupRecoveryLink.create({
    data: {
      registrationId: args.registrationId,
      tokenHash,
      issuedAt: now,
      expiresAt,
      issuedToEmail: args.toEmail,
      issuedByIp: args.issuedByIp ?? null,
    },
    select: { id: true, expiresAt: true },
  });

  logger.info("signup.recovery_link.issued", {
    registrationIdTail: args.registrationId.slice(-6),
    linkIdTail: row.id.slice(-6),
    emailMasked: maskEmail(args.toEmail),
    supersededCount: supersede.count,
    expiresInMinutes: Math.round((row.expiresAt.getTime() - now.getTime()) / 60_000),
  });

  return { token, linkId: row.id, expiresAt: row.expiresAt };
}

/**
 * Consume a plaintext recovery token.  On success, atomically marks
 * the row as consumed and returns the registrationId.  On any
 * failure (not found, already consumed, revoked, expired) returns
 * the specific outcome without leaking which failure mode applied
 * to the caller (the API layer must return a single generic error
 * string to the end user).
 *
 * The write is conditional on consumedAt IS NULL AND revokedAt IS
 * NULL AND expiresAt > now, so a race between two concurrent
 * consumes resolves to exactly one SUCCESS.  The second call sees
 * ALREADY_CONSUMED.
 */
export async function consumeRecoveryLink(args: {
  token: string;
  consumedByIp?: string | null;
}): Promise<ConsumeOutcome> {
  const t = args.token;
  if (!t || typeof t !== "string" || t.length < 20 || t.length > 200) {
    return { status: "NOT_FOUND" };
  }
  const tokenHash = sha256HashHex(t);
  const now = new Date();

  // Find first — classify the exact failure.  Then conditionally
  // consume with a filter that guarantees exactly-once semantics.
  const row = await prisma.signupRecoveryLink.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      registrationId: true,
      consumedAt: true,
      revokedAt: true,
      expiresAt: true,
    },
  });

  if (!row) {
    return { status: "NOT_FOUND" };
  }
  if (row.consumedAt) {
    logger.info("signup.recovery_link.consume_rejected", {
      linkIdTail: row.id.slice(-6),
      reason: "ALREADY_CONSUMED",
    });
    return { status: "ALREADY_CONSUMED" };
  }
  if (row.revokedAt) {
    logger.info("signup.recovery_link.consume_rejected", {
      linkIdTail: row.id.slice(-6),
      reason: "REVOKED",
    });
    return { status: "REVOKED" };
  }
  if (row.expiresAt.getTime() < now.getTime()) {
    logger.info("signup.recovery_link.consume_rejected", {
      linkIdTail: row.id.slice(-6),
      reason: "EXPIRED",
    });
    return { status: "EXPIRED" };
  }

  // Conditional update: only consume if STILL unconsumed +
  // unrevoked + unexpired.  updateMany returns a count; count=1
  // means we won the race.
  const applied = await prisma.signupRecoveryLink.updateMany({
    where: {
      id: row.id,
      consumedAt: null,
      revokedAt: null,
      expiresAt: { gt: now },
    },
    data: {
      consumedAt: now,
      consumedByIp: args.consumedByIp ?? null,
    },
  });

  if (applied.count === 0) {
    // Lost a race with a concurrent consume.  Treat as already
    // consumed for the caller.
    return { status: "ALREADY_CONSUMED" };
  }

  logger.info("signup.recovery_link.consumed", {
    registrationIdTail: row.registrationId.slice(-6),
    linkIdTail: row.id.slice(-6),
  });

  return { status: "SUCCESS", registrationId: row.registrationId, linkId: row.id };
}

/**
 * Operator-facing revocation.  Revokes every still-active link for
 * a registration.  Used by the admin "lock the account" tool and by
 * the abuse-detection sweeper.
 */
export async function revokeAllForRegistration(args: {
  registrationId: string;
  reason: Exclude<RecoveryLinkRevokeReason, "SUPERSEDED">;
}): Promise<{ revokedCount: number }> {
  const now = new Date();
  const res = await prisma.signupRecoveryLink.updateMany({
    where: {
      registrationId: args.registrationId,
      consumedAt: null,
      revokedAt: null,
    },
    data: {
      revokedAt: now,
      revokeReason: args.reason,
    },
  });
  logger.info("signup.recovery_link.revoked_all", {
    registrationIdTail: args.registrationId.slice(-6),
    reason: args.reason,
    revokedCount: res.count,
  });
  return { revokedCount: res.count };
}

/**
 * Look up a registration id by the admin email captured at
 * Microsoft verification.  Used by the fresh-link request endpoint:
 * applicant submits their email, the system issues a new link for
 * the matching VERIFIED registration (if any).  Returns null for a
 * non-match or for a registration that has not yet completed
 * Microsoft verification.
 *
 * Enumeration-safe: the API layer must return the same response
 * regardless of match, so this function returning null for a miss
 * is intentional and the only place that reveals the match axis.
 */
export async function findRegistrationIdByAdminEmail(
  adminEmail: string,
): Promise<{ registrationId: string; adminDisplayName: string | null; legalName: string } | null> {
  if (!adminEmail || typeof adminEmail !== "string") return null;
  const email = adminEmail.trim().toLowerCase();
  if (email.length < 3 || email.length > 320) return null;

  // Only VERIFIED-identity registrations can issue a fresh link.  A
  // DRAFT registration has no admin email yet.
  const reg = await prisma.signupRegistration.findFirst({
    where: {
      adminEmail: email,
      adminVerifiedAt: { not: null },
      status: { not: "ABANDONED" },
    },
    select: { id: true, adminDisplayName: true, legalName: true },
    orderBy: { createdAt: "desc" },
  });
  return reg
    ? { registrationId: reg.id, adminDisplayName: reg.adminDisplayName, legalName: reg.legalName }
    : null;
}

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 2) return "***";
  return `${email.slice(0, 2)}***@${email.slice(at + 1)}`;
}
