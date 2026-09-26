// AUTH-2 (2026-09-26) — server-side session authority.
//
// This module is the ONLY source of truth for whether a bearer token
// (opaque, cryptographically random) resolves to an authenticated
// session. Cookies contain the raw bearer; the DB stores sha256(bearer)
// so that DB disclosure does not yield reusable browser credentials.
//
// Fail-closed semantics: any exception, malformed token, missing row,
// revoked row, or expired row → returns null / throws. Never
// speculatively reconstructs identity from stale cookie payload.
//
// See prisma.Session model and prisma/migrations/20260926_auth2_session.

import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { Prisma, Session } from "@prisma/client";

/** Session surface — matches the string values written to Session.surface. */
export const SURFACE_ADMIN = "ADMIN";
export const SURFACE_EMPLOYEE = "EMPLOYEE";
export type SessionSurface = typeof SURFACE_ADMIN | typeof SURFACE_EMPLOYEE;

/** AUTH-2 mirrors the AUTH-1 seven-day lifetime. AUTH-6 will layer
 *  idle timeout + rolling renewal on top. */
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

/** Touch throttle — update lastSeenAt only if the persisted value is
 *  older than this. Cheap protection against write amplification. */
export const LAST_SEEN_TOUCH_INTERVAL_MS = 1000 * 60 * 5; // 5 minutes

/** Raw bearer token size in bytes. 32 bytes = 256 bits of entropy;
 *  base64url encoded ≈ 43 chars. Not remotely guessable. */
const BEARER_BYTES = 32;

/** Compute the sha256 hash of a bearer token as a lowercase hex string.
 *  This is what we persist to DB and what we look up by. */
export function hashBearer(bearer: string): string {
  return crypto.createHash("sha256").update(bearer, "utf8").digest("hex");
}

/** Generate a fresh cryptographically random bearer token, base64url-encoded. */
export function mintBearer(): string {
  return crypto.randomBytes(BEARER_BYTES).toString("base64url");
}

/** Structured security-log event kinds. Consumed by an outer logger. */
export type SessionLogEvent =
  | "SESSION_CREATED"
  | "SESSION_REVOKED"
  | "SESSION_LOGOUT"
  | "SESSION_EXPIRED"
  | "SESSION_INVALID"
  | "SESSION_TOUCH";

/** Structured payload for security logs. NEVER include the raw bearer. */
export interface SessionLogPayload {
  event: SessionLogEvent;
  sessionId?: string;
  surface: SessionSurface | "UNKNOWN";
  userId?: string | null;
  employeeId?: string | null;
  clubId?: string | null;
  reason?: string;
}

// Default logger is a no-op so this module remains testable and never
// crashes if the outer app hasn't wired a real logger. Replace with
// console.log in tests or with a structured logger in production.
let sessionLog: (p: SessionLogPayload) => void = () => {};
export function setSessionLogger(fn: (p: SessionLogPayload) => void) {
  sessionLog = fn;
}
function log(p: SessionLogPayload) {
  try { sessionLog(p); } catch { /* logging must never break auth */ }
}

// ============================================================================
// CREATE
// ============================================================================

export interface CreateSessionInput {
  surface: SessionSurface;
  userId?: string | null;
  employeeId?: string | null;
  /** Authoritative tenant context. Nullable ONLY for ADMIN surface
   *  when the user is a platform-level actor without a specific
   *  tenant (super-admin). Employee sessions MUST supply a non-null
   *  clubId (enforced below). */
  clubId: string | null;
  activeClubId?: string | null;
  uaAtCreate?: string | null;
  ipAtCreate?: string | null;
  /** Override default TTL (used only by tests that need to construct
   *  a session that will expire in the near future). */
  ttlMs?: number;
}

export interface CreatedSession {
  bearer: string;      // The raw token — write to cookie ONCE, do not log.
  session: Session;    // The DB record.
}

/** Create a Session row and return the raw bearer plus the record.
 *  The raw bearer is only returned here; downstream code must persist
 *  it via cookie and forget the plaintext. */
export async function createSession(input: CreateSessionInput): Promise<CreatedSession> {
  // Fail loudly if the surface / identity mapping is malformed. This
  // is a programmer error, not a runtime failure mode.
  if (input.surface === SURFACE_ADMIN) {
    if (!input.userId) throw new Error("createSession: ADMIN surface requires userId");
    if (input.employeeId) throw new Error("createSession: ADMIN surface must not have employeeId");
  } else if (input.surface === SURFACE_EMPLOYEE) {
    if (!input.employeeId) throw new Error("createSession: EMPLOYEE surface requires employeeId");
    if (input.userId) throw new Error("createSession: EMPLOYEE surface must not have userId");
    if (input.activeClubId) throw new Error("createSession: EMPLOYEE surface must not have activeClubId");
    if (!input.clubId) throw new Error("createSession: EMPLOYEE surface requires clubId");
  } else {
    // Exhaustiveness — TypeScript catches this, but guard against future misuse.
    throw new Error(`createSession: unknown surface "${(input as unknown as { surface: string }).surface}"`);
  }

  const bearer = mintBearer();
  const tokenHash = hashBearer(bearer);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? SESSION_TTL_MS));

  // Prisma-client type-generation may lag schema changes on Windows
  // (query-engine DLL locked by dev server / vitest). Explicit cast on
  // the nullable clubId keeps typecheck stable regardless of whether
  // the generated client has been refreshed.
  const session = await prisma.session.create({
    data: {
      tokenHash,
      surface: input.surface,
      userId: input.userId ?? null,
      employeeId: input.employeeId ?? null,
      clubId: (input.clubId ?? null) as string,
      activeClubId: input.surface === SURFACE_ADMIN ? (input.activeClubId ?? null) : null,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
      uaAtCreate: input.uaAtCreate ?? null,
      ipAtCreate: input.ipAtCreate ?? null,
    },
  });

  log({
    event: "SESSION_CREATED",
    sessionId: session.id,
    surface: input.surface,
    userId: session.userId,
    employeeId: session.employeeId,
    clubId: session.clubId,
  });

  return { bearer, session };
}

// ============================================================================
// LOOKUP + VALIDATE
// ============================================================================

/** Result of validating a bearer token. `null` means unauthenticated. */
export type ValidatedSession = Session;

/** Look up a bearer token. Returns the Session row iff:
 *   - the bearer is a non-empty string
 *   - a Session row exists with the matching hash
 *   - the row's surface matches the requested surface (defense against
 *     an admin bearer being presented on the employee cookie or vice versa)
 *   - revokedAt is null
 *   - expiresAt > now
 *
 *  Otherwise returns null. Any exception is caught and logged as
 *  SESSION_INVALID; the function still returns null (fail closed). */
export async function findValidSession(
  bearer: string | undefined | null,
  expectedSurface: SessionSurface,
): Promise<ValidatedSession | null> {
  if (!bearer || typeof bearer !== "string") return null;
  let session: Session | null;
  try {
    const tokenHash = hashBearer(bearer);
    session = await prisma.session.findUnique({ where: { tokenHash } });
  } catch {
    // DB unavailable — fail closed, do not trust the cookie.
    log({ event: "SESSION_INVALID", surface: expectedSurface, reason: "db-lookup-failed" });
    return null;
  }
  if (!session) {
    log({ event: "SESSION_INVALID", surface: expectedSurface, reason: "not-found" });
    return null;
  }
  if (session.surface !== expectedSurface) {
    log({
      event: "SESSION_INVALID",
      sessionId: session.id,
      surface: expectedSurface,
      reason: `surface-mismatch:${session.surface}`,
    });
    return null;
  }
  if (session.revokedAt !== null) {
    log({
      event: "SESSION_INVALID",
      sessionId: session.id,
      surface: expectedSurface,
      userId: session.userId,
      employeeId: session.employeeId,
      reason: "revoked",
    });
    return null;
  }
  if (session.expiresAt.getTime() <= Date.now()) {
    log({
      event: "SESSION_EXPIRED",
      sessionId: session.id,
      surface: expectedSurface,
      userId: session.userId,
      employeeId: session.employeeId,
    });
    return null;
  }
  return session;
}

// ============================================================================
// TOUCH (throttled)
// ============================================================================

export async function touchSession(sessionId: string): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - LAST_SEEN_TOUCH_INTERVAL_MS);
    // Update ONLY if lastSeenAt is older than the throttle window.
    // Cheap upsert-like update — a single indexed write when triggered.
    await prisma.session.updateMany({
      where: { id: sessionId, lastSeenAt: { lt: cutoff } },
      data: { lastSeenAt: new Date() },
    });
  } catch {
    // Never break auth on a throttle-touch failure.
  }
}

// ============================================================================
// REVOKE
// ============================================================================

/** Revoke a single session by DB id. Idempotent — repeat revokes are
 *  no-ops (revokedAt is not overwritten). */
export async function revokeSession(
  sessionId: string,
  opts: { revokedBy?: string; reason?: string } = {},
): Promise<void> {
  try {
    const updated = await prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: {
        revokedAt: new Date(),
        revokedBy: opts.revokedBy ?? null,
        revokeReason: opts.reason ?? null,
      },
    });
    if (updated.count > 0) {
      log({
        event: opts.reason === "logout" ? "SESSION_LOGOUT" : "SESSION_REVOKED",
        sessionId,
        surface: "UNKNOWN",
        reason: opts.reason,
      });
    }
  } catch {
    // Fail closed on DB errors: caller must decide UX.
  }
}

/** Revoke every non-revoked session belonging to a user. Returns the
 *  count of rows updated. Used by AUTH-3 for password-change /
 *  role-change / deactivation revocations. Present here as a primitive
 *  so downstream phases can wire it without another schema change. */
export async function revokeAllForUser(
  userId: string,
  opts: { revokedBy?: string; reason?: string } = {},
): Promise<number> {
  const res = await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: {
      revokedAt: new Date(),
      revokedBy: opts.revokedBy ?? null,
      revokeReason: opts.reason ?? null,
    },
  });
  log({ event: "SESSION_REVOKED", surface: SURFACE_ADMIN, userId, reason: opts.reason });
  return res.count;
}

/** Revoke every non-revoked session belonging to an employee. */
export async function revokeAllForEmployee(
  employeeId: string,
  opts: { revokedBy?: string; reason?: string } = {},
): Promise<number> {
  const res = await prisma.session.updateMany({
    where: { employeeId, revokedAt: null },
    data: {
      revokedAt: new Date(),
      revokedBy: opts.revokedBy ?? null,
      revokeReason: opts.reason ?? null,
    },
  });
  log({ event: "SESSION_REVOKED", surface: SURFACE_EMPLOYEE, employeeId, reason: opts.reason });
  return res.count;
}

// ============================================================================
// AUTH-3B — Transactional revoke variants
// ============================================================================
//
// These accept a Prisma.TransactionClient so callers can compose a business
// mutation (e.g. Employee.status → TERMINATED) with the corresponding
// session revocation into a SINGLE atomic transaction: either both commit
// or both roll back. Prevents the "terminated employee still authenticated"
// window that would exist if the two writes ran independently and the
// revoke failed after the mutation succeeded.
//
// These do NOT emit their own audit rows. Callers extend their existing
// event's `meta` with `sessionsRevoked: <count>`.

export async function revokeAllForEmployeeTx(
  tx: Prisma.TransactionClient,
  employeeId: string,
  opts: { revokedBy?: string | null; reason?: string } = {},
): Promise<number> {
  const res = await tx.session.updateMany({
    where: { employeeId, revokedAt: null },
    data: {
      revokedAt: new Date(),
      revokedBy: opts.revokedBy ?? null,
      revokeReason: opts.reason ?? null,
    },
  });
  return res.count;
}

export async function revokeAllForUserTx(
  tx: Prisma.TransactionClient,
  userId: string,
  opts: { revokedBy?: string | null; reason?: string } = {},
): Promise<number> {
  const res = await tx.session.updateMany({
    where: { userId, revokedAt: null },
    data: {
      revokedAt: new Date(),
      revokedBy: opts.revokedBy ?? null,
      revokeReason: opts.reason ?? null,
    },
  });
  return res.count;
}

// ============================================================================
// ADMIN activeClub mutation
// ============================================================================

/** Move the admin session's activeClubId to the specified value.
 *  Membership authorisation is the CALLER's responsibility — this
 *  function only writes the value the caller has already validated. */
export async function setSessionActiveClub(sessionId: string, activeClubId: string | null): Promise<void> {
  await prisma.session.updateMany({
    where: { id: sessionId, surface: SURFACE_ADMIN, revokedAt: null },
    data: { activeClubId },
  });
}
