// Phase 11G — MFA (TOTP) + recovery codes + trusted devices.
//
// TOTP implementation is self-contained (no external library required) and
// produces RFC 6238-compliant codes compatible with Google Authenticator,
// 1Password, Bitwarden, etc.
//
// Recovery codes are sha256-hashed at rest; the raw codes are returned ONCE
// at enrollment.

import { createHash, createHmac, randomBytes } from "crypto";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors";

// ---------------------------------------------------------------------------
// Base32 (RFC 4648) — needed for TOTP secrets / QR codes.
// ---------------------------------------------------------------------------
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let result = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) result += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  return result;
}

function base32Decode(str: string): Buffer {
  const clean = str.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238) — 6 digits, 30-second period, SHA-1.
// ---------------------------------------------------------------------------
const TOTP_PERIOD = 30;
const TOTP_DIGITS = 6;

function generateTotpAt(secret: string, timestamp: number): string {
  const counter = Math.floor(timestamp / 1000 / TOTP_PERIOD);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", base32Decode(secret)).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const truncated =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (truncated % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, "0");
}

export function generateTotp(secret: string): string {
  return generateTotpAt(secret, Date.now());
}

// Verify with a ±1 window for clock drift.
export function verifyTotp(secret: string, code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const now = Date.now();
  for (const offset of [-TOTP_PERIOD * 1000, 0, TOTP_PERIOD * 1000]) {
    if (generateTotpAt(secret, now + offset) === code) return true;
  }
  return false;
}

// Build an otpauth URI (Google Authenticator format) — caller renders QR.
export function buildOtpauthUri(args: { secret: string; accountName: string; issuer?: string }): string {
  const params = new URLSearchParams({
    secret: args.secret,
    issuer: args.issuer ?? "Spectre",
    algorithm: "SHA1",
    digits: TOTP_DIGITS.toString(),
    period: TOTP_PERIOD.toString(),
  });
  return `otpauth://totp/${encodeURIComponent(args.issuer ?? "Spectre")}:${encodeURIComponent(args.accountName)}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------
export async function startEnrollment(principal: Principal) {
  // Generate a fresh secret + create a PENDING factor row.
  const secret = base32Encode(randomBytes(20));
  const existing = await prisma.mfaFactor.findUnique({ where: { userId_kind: { userId: principal.id, kind: "TOTP" } } });
  if (existing && existing.status === "ACTIVE") throw new ConflictError("MFA is already enrolled");
  const factor = existing
    ? await prisma.mfaFactor.update({ where: { id: existing.id }, data: { secret, status: "PENDING" } })
    : await prisma.mfaFactor.create({ data: { userId: principal.id, kind: "TOTP", secret, status: "PENDING" } });
  const otpauth = buildOtpauthUri({ secret, accountName: principal.email, issuer: "Spectre" });
  await audit(principal, { action: "mfa.enroll.start", entityType: "MfaFactor", entityId: factor.id });
  return { factor, secret, otpauth };
}

export async function completeEnrollment(principal: Principal, code: string) {
  const factor = await prisma.mfaFactor.findUnique({ where: { userId_kind: { userId: principal.id, kind: "TOTP" } } });
  if (!factor || factor.status === "ACTIVE") throw new ConflictError("No pending MFA enrollment");
  if (!verifyTotp(factor.secret, code)) throw new ForbiddenError("Invalid code");
  // Generate 8 recovery codes; show raw to caller once.
  const rawCodes: string[] = [];
  for (let i = 0; i < 8; i++) {
    rawCodes.push(randomBytes(5).toString("hex"));
  }
  await prisma.recoveryCode.deleteMany({ where: { userId: principal.id } });
  await prisma.$transaction([
    prisma.mfaFactor.update({
      where: { id: factor.id },
      data: { status: "ACTIVE", enrolledAt: new Date() },
    }),
    prisma.user.update({ where: { id: principal.id }, data: { mfaEnabled: true } }),
    ...rawCodes.map((code) => prisma.recoveryCode.create({
      data: { userId: principal.id, codeHash: createHash("sha256").update(code).digest("hex") },
    })),
  ]);
  await audit(principal, { action: "mfa.enroll.complete", entityType: "MfaFactor", entityId: factor.id, after: { recoveryCodes: rawCodes.length } });
  return { recoveryCodes: rawCodes };
}

// Verify a TOTP code OR a recovery code (single-use). Used at sensitive
// action gates and at login step-up.
export async function verifyMfa(userId: string, code: string): Promise<{ ok: boolean; usedRecovery?: boolean }> {
  const factor = await prisma.mfaFactor.findUnique({ where: { userId_kind: { userId, kind: "TOTP" } } });
  if (!factor || factor.status !== "ACTIVE") return { ok: false };
  if (/^\d{6}$/.test(code) && verifyTotp(factor.secret, code)) {
    await prisma.mfaFactor.update({ where: { id: factor.id }, data: { lastUsedAt: new Date() } });
    return { ok: true };
  }
  // Recovery code path.
  const hash = createHash("sha256").update(code.toLowerCase().trim()).digest("hex");
  const rc = await prisma.recoveryCode.findFirst({ where: { userId, codeHash: hash, usedAt: null } });
  if (rc) {
    await prisma.recoveryCode.update({ where: { id: rc.id }, data: { usedAt: new Date() } });
    return { ok: true, usedRecovery: true };
  }
  return { ok: false };
}

export async function disableMfa(principal: Principal, targetUserId: string, reason: string) {
  // Admins (CLUB_ADMIN at the user's primary club, or SUPER_ADMIN) can reset.
  const target = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!target) throw new NotFoundError("User", targetUserId);
  const isSuper = principal.memberships.some((m) => m.clubId === null && m.roleKey === "SUPER_ADMIN");
  if (!isSuper) {
    if (target.clubId) requirePermission(principal, target.clubId, "users:roles:write");
    else throw new ForbiddenError("Only SUPER_ADMIN can reset MFA for users without a primary club");
  }
  await prisma.$transaction([
    prisma.mfaFactor.updateMany({ where: { userId: targetUserId }, data: { status: "DISABLED" } }),
    prisma.recoveryCode.deleteMany({ where: { userId: targetUserId } }),
    prisma.user.update({ where: { id: targetUserId }, data: { mfaEnabled: false } }),
  ]);
  await audit(principal, { action: "mfa.disable", entityType: "User", entityId: targetUserId, after: { reason } });
}

// ---------------------------------------------------------------------------
// Per-role MFA enforcement (read from ClubSetting scope=SECURITY)
// ---------------------------------------------------------------------------
export const ROLES_REQUIRING_MFA = ["SUPER_ADMIN", "CLUB_ADMIN", "CONTROLLER", "FINANCE_ADMIN"] as const;

export async function isMfaRequiredForUser(userId: string): Promise<boolean> {
  const memberships = await prisma.userClubRole.findMany({ where: { userId } });
  return memberships.some((m) => (ROLES_REQUIRING_MFA as readonly string[]).includes(m.roleKey));
}

// ---------------------------------------------------------------------------
// Trusted devices (remember-this-device)
// ---------------------------------------------------------------------------
export async function rememberDevice(args: { userId: string; ip?: string; userAgent?: string; days?: number }) {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + (args.days ?? 30) * 86400000);
  await prisma.trustedDevice.create({
    data: { userId: args.userId, tokenHash, ip: args.ip ?? null, userAgent: args.userAgent ?? null, expiresAt },
  });
  return { rawToken, expiresAt };
}

export async function isDeviceTrusted(userId: string, rawToken: string): Promise<boolean> {
  if (!rawToken) return false;
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const td = await prisma.trustedDevice.findUnique({ where: { tokenHash } });
  return !!td && td.userId === userId && td.expiresAt > new Date();
}
