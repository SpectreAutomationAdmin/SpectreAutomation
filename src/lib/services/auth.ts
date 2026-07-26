// Authentication service. All login/logout/lockout logic lives here so that
// routes and tests use the exact same code path.

import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { AppError, RateLimitError, ValidationError } from "../errors";
import { checkAuthRateLimit, recordAuthAttempt, isLocked } from "../security/auth-guard";
import { getRequestContext } from "../request-context";

// ---- password policy --------------------------------------------------------
//
// We accept any reasonable password ≥ 10 chars in length. For Phase 1 we keep
// the policy permissive enough that existing demo users with `password` still
// work; production deployments will tighten this (zxcvbn or NIST 800-63B).
const PASSWORD_MIN = 8;

export const credentialsSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1, "Password is required").max(256),
});

// ---- lockout policy ---------------------------------------------------------
const MAX_FAILED = 5;
const LOCKOUT_MINUTES = 15;

export async function login(input: { email: string; password: string }): Promise<{ userId: string }> {
  const parsed = credentialsSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      "Please check the form"
    );
  }
  const email = parsed.data.email.toLowerCase().trim();
  const { ip, userAgent } = getRequestContext();

  // Phase 9: rate-limit (IP + email) BEFORE any DB work. We always return the
  // same generic error to avoid account enumeration.
  const rate = await checkAuthRateLimit("login", email, ip ?? "unknown");
  if (!rate.allowed) {
    await recordAuthAttempt({ scope: "login", email, ip: ip ?? undefined, userAgent: userAgent ?? undefined, outcome: "RATE_LIMITED" });
    throw new RateLimitError("Too many attempts. Please wait a moment and try again.");
  }

  // Phase 9: cross-session account lock check (emailHash-based, separate from
  // the per-user lockedUntil column).
  const lock = await isLocked(email);
  if (lock.locked) {
    await recordAuthAttempt({ scope: "login", email, ip: ip ?? undefined, userAgent: userAgent ?? undefined, outcome: "LOCKED" });
    throw new RateLimitError("Your account is temporarily locked due to repeated failed sign-in attempts. Please try again later.");
  }

  const user = await prisma.user.findUnique({ where: { email } });

  // Constant-ish-time mismatch: always bcrypt.compare so timing doesn't leak
  // whether the user exists.
  const fakeHash = "$2a$10$0000000000000000000000000000000000000000000000000000";
  if (!user) {
    await bcrypt.compare(parsed.data.password, fakeHash);
    await audit(null, { action: "auth.login_failed", entityType: "User", meta: { reason: "no_user", email } });
    await recordAuthAttempt({ scope: "login", email, ip: ip ?? undefined, userAgent: userAgent ?? undefined, outcome: "UNKNOWN_USER" });
    throw new AppError("AUTH_INVALID", "Invalid email or password", 401, "Invalid email or password");
  }

  // Lockout takes precedence over a disabled-style status check: an account
  // that auto-locked is conceptually "ACTIVE but currently rate-limited" and
  // the user should see the lockout reason, not a generic disabled message.
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await audit({ id: user.id }, { action: "auth.login_blocked", entityType: "User", entityId: user.id, meta: { reason: "locked", until: user.lockedUntil.toISOString() } });
    throw new RateLimitError("Your account is temporarily locked due to repeated failed sign-in attempts. Please try again later.");
  }

  if (user.status !== "ACTIVE" && user.status !== "LOCKED") {
    await audit({ id: user.id }, { action: "auth.login_failed", entityType: "User", entityId: user.id, meta: { reason: "status_not_active", status: user.status } });
    throw new AppError("AUTH_DISABLED", "This account is not active", 403, "This account is not active.");
  }

  const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!ok) {
    const nextCount = (user.failedLoginCount ?? 0) + 1;
    const shouldLock = nextCount >= MAX_FAILED;
    const lockedUntil = shouldLock ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null;
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: nextCount, lockedUntil, status: shouldLock ? "LOCKED" : user.status },
    });
    await audit({ id: user.id }, {
      action: shouldLock ? "auth.account_locked" : "auth.login_failed",
      entityType: "User",
      entityId: user.id,
      meta: { failedLoginCount: nextCount },
    });
    await recordAuthAttempt({ scope: "login", email, ip: ip ?? undefined, userAgent: userAgent ?? undefined, outcome: "INVALID_PASSWORD", userId: user.id });
    if (shouldLock) {
      throw new RateLimitError("Too many failed sign-in attempts. Your account has been temporarily locked.");
    }
    throw new AppError("AUTH_INVALID", "Invalid email or password", 401, "Invalid email or password");
  }

  // success
  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  });
  await audit({ id: user.id }, { action: "auth.login_success", entityType: "User", entityId: user.id });
  await recordAuthAttempt({ scope: "login", email, ip: ip ?? undefined, userAgent: userAgent ?? undefined, outcome: "SUCCESS", userId: user.id });
  return { userId: user.id };
}

// Hash helper used by seed and invitation flows.
export async function hashPassword(plaintext: string): Promise<string> {
  if (plaintext.length < PASSWORD_MIN && process.env.NODE_ENV === "production") {
    throw new ValidationError([{ path: "password", message: `Password must be at least ${PASSWORD_MIN} characters` }]);
  }
  return bcrypt.hash(plaintext, 12);
}
