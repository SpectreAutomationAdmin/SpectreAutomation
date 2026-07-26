// Phase 9C — Auth rate limit + account lockout + suspicious-activity tracking.
//
// Used by /api/login, /api/password-reset, /api/invite/accept, and the
// public application submission route.
//
// Key design choices:
//   - Email is never stored in raw form on AuthAttempt — we hash sha256 of
//     the lowercased email so a leaked DB doesn't disclose the username space.
//   - Generic error messages are returned by the caller regardless of
//     outcome (UNKNOWN_USER, INVALID_PASSWORD, LOCKED) to avoid account
//     enumeration. The truth lives only in AuthAttempt.outcome.
//   - Lockouts escalate: 5 failures in 15min → 15-minute lockout; 10 → 1 hour.

import { createHash } from "crypto";
import { prisma } from "../prisma";
import { logger } from "../observability/logger";
import { consumeRate } from "./rate-limit";

export type AuthScope = "login" | "password_reset" | "invite_accept" | "apply";

export type AuthOutcome = "SUCCESS" | "INVALID_PASSWORD" | "UNKNOWN_USER" | "LOCKED" | "RATE_LIMITED";

export function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

// Per-scope rate limit profile (IP + email) — uses the Phase 8 token-bucket
// limiter. Returns { allowed, ipRetryAfterMs, emailRetryAfterMs }.
export async function checkAuthRateLimit(scope: AuthScope, email: string, ip: string): Promise<{ allowed: boolean; reason?: string; retryAfterMs?: number }> {
  const emailHash = hashEmail(email);
  // Map scope to rate-limit profile. apply maps to public_application.
  const profile = scope === "login" ? "login"
    : scope === "password_reset" ? "password_reset"
    : scope === "invite_accept" ? "login"
    : "public_application";

  const ipResult = await consumeRate(profile, `${scope}:ip:${ip}`);
  if (!ipResult.allowed) return { allowed: false, reason: "ip", retryAfterMs: ipResult.retryAfterMs };
  const emailResult = await consumeRate(profile, `${scope}:email:${emailHash}`);
  if (!emailResult.allowed) return { allowed: false, reason: "email", retryAfterMs: emailResult.retryAfterMs };
  return { allowed: true };
}

// Check whether an email is currently locked.
export async function isLocked(email: string): Promise<{ locked: boolean; until?: Date; reason?: string }> {
  const emailHash = hashEmail(email);
  const lock = await prisma.accountLock.findFirst({
    where: { emailHash, status: "ACTIVE" },
    orderBy: { lockedAt: "desc" },
  });
  if (!lock) return { locked: false };
  if (lock.expiresAt && lock.expiresAt < new Date()) {
    // Auto-expire.
    await prisma.accountLock.update({ where: { id: lock.id }, data: { status: "EXPIRED", releasedAt: new Date() } });
    return { locked: false };
  }
  return { locked: true, until: lock.expiresAt ?? undefined, reason: lock.reason ?? undefined };
}

// Record an auth attempt. Failures escalate to a temporary lockout once
// thresholds are crossed.
export async function recordAuthAttempt(args: {
  scope: AuthScope;
  email: string;
  ip?: string;
  userAgent?: string;
  outcome: AuthOutcome;
  clubId?: string | null;
  userId?: string | null;
}) {
  const emailHash = hashEmail(args.email);
  await prisma.authAttempt.create({
    data: {
      scope: args.scope, emailHash, ip: args.ip ?? null, userAgent: args.userAgent ?? null,
      outcome: args.outcome, clubId: args.clubId ?? null,
    },
  });

  // Successful attempts release any active automatic lock.
  if (args.outcome === "SUCCESS") {
    await prisma.accountLock.updateMany({
      where: { emailHash, status: "ACTIVE", kind: "AUTOMATIC" },
      data: { status: "RELEASED", releasedAt: new Date() },
    });
    return;
  }

  // Count recent failures in the last 15 minutes.
  if (args.outcome === "INVALID_PASSWORD" || args.outcome === "UNKNOWN_USER") {
    const since = new Date(Date.now() - 15 * 60_000);
    const recentFails = await prisma.authAttempt.count({
      where: { emailHash, scope: args.scope, outcome: { in: ["INVALID_PASSWORD", "UNKNOWN_USER"] }, occurredAt: { gte: since } },
    });
    let lockMinutes: number | null = null;
    if (recentFails >= 10) lockMinutes = 60;
    else if (recentFails >= 5) lockMinutes = 15;
    if (lockMinutes != null) {
      const expiresAt = new Date(Date.now() + lockMinutes * 60_000);
      // Suppress duplicate locks within a window.
      const existing = await prisma.accountLock.findFirst({
        where: { emailHash, status: "ACTIVE", kind: "AUTOMATIC" },
      });
      if (!existing) {
        await prisma.accountLock.create({
          data: { emailHash, kind: "AUTOMATIC", reason: `${recentFails} failed ${args.scope} attempts`, expiresAt, clubId: args.clubId ?? null, userId: args.userId ?? null },
        });
        await prisma.suspiciousActivityEvent.create({
          data: {
            kind: "BRUTE_FORCE", severity: "WARN",
            emailHash, ip: args.ip ?? null, userAgent: args.userAgent ?? null,
            clubId: args.clubId ?? null,
            metaJson: JSON.stringify({ scope: args.scope, recentFails, lockMinutes }),
          },
        });
        logger.warn("auth.brute_force_lock", { scope: args.scope, recentFails, lockMinutes });
      }
    }
  }
}

// Admin-side manual unlock.
export async function releaseLock(args: { lockId: string; actorUserId: string }) {
  return prisma.accountLock.update({
    where: { id: args.lockId },
    data: { status: "RELEASED", releasedAt: new Date(), releasedByUserId: args.actorUserId },
  });
}

// Convenience admin reads.
export async function listAccountLocks(args: { clubId?: string | null; activeOnly?: boolean }) {
  return prisma.accountLock.findMany({
    where: {
      ...(args.activeOnly !== false ? { status: "ACTIVE" } : {}),
      ...(args.clubId ? { clubId: args.clubId } : {}),
    },
    orderBy: { lockedAt: "desc" },
    take: 100,
  });
}

export async function listSuspiciousActivity(args: { clubId?: string | null }) {
  return prisma.suspiciousActivityEvent.findMany({
    where: { ...(args.clubId ? { clubId: args.clubId } : {}) },
    orderBy: { occurredAt: "desc" },
    take: 100,
  });
}
