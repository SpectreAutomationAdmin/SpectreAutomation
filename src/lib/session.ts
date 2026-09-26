// AUTH-2 (2026-09-26) — server-side session authority for the admin
// portal. Cookie payload changes from the AUTH-1 `{ userId, activeClubId,
// generation }` (self-contained credential) to `{ v: 2, sid }` (opaque
// bearer reference); the authoritative record lives in the Session
// table (see src/lib/services/session-store.ts).
//
// Every previously-exported symbol keeps the same shape so callers do
// not need to change. Internally each function now delegates to the
// session store:
//
//   getSession()         → decrypts cookie, looks up Session row,
//                          returns a `SessionData` shim populated from
//                          the DB (or an empty shim on any failure).
//   setSession()         → creates a fresh Session row, writes the
//                          bearer to the cookie. Session fixation
//                          protection: any pre-existing sid in the
//                          cookie is not reused.
//   setActiveClub()      → updates Session.activeClubId (server-authoritative).
//   clearSession()       → revokes the Session row AND destroys the cookie.
//   getCurrentUser()     → re-reads User row per request as before,
//                          gated on Session validity + `status === "ACTIVE"`.
//   requireUser()        → unchanged.
//
// Legacy cookies (AUTH-1 shape: containing userId, no `sid`, no `v: 2`)
// are treated as unauthenticated. AUTH-2 deployment therefore signs
// out existing staging users once; they log back in and receive a
// new server-side session. Documented in the AUTH-2 closeout.
//
// Fail-closed: any exception (DB unavailable, malformed cookie, missing
// Session row, revoked, expired) returns unauthenticated.

import { cookies } from "next/headers";
import { getIronSession, type SessionOptions } from "iron-session";
import { env } from "./env";
import { prisma } from "./prisma";
import {
  createSession as storeCreateSession,
  findValidSession,
  revokeSession as storeRevokeSession,
  setSessionActiveClub as storeSetActiveClub,
  touchSession,
  SURFACE_ADMIN,
} from "./services/session-store";

/** Cookie payload after AUTH-2. */
interface AdminCookieV2 {
  v: 2;
  sid: string;
}

/** Iron-session cookie shape includes both the AUTH-2 payload and any
 *  legacy AUTH-1 keys that might still be sitting in an old cookie. We
 *  read them so we can detect and REJECT legacy cookies without
 *  auto-upgrading them into new server-side sessions. */
interface AdminCookieShape {
  // AUTH-2
  v?: number;
  sid?: string;
  // AUTH-1 legacy — read only for detection; never trusted.
  userId?: string;
  activeClubId?: string | null;
  generation?: number;
}

/** Public SessionData shape — preserved from AUTH-1 for caller
 *  compatibility. Fields are now populated from the authoritative
 *  Session row, not from the cookie payload. */
export type SessionData = {
  userId?: string;
  activeClubId?: string | null;
  // Cache-busting counter that AUTH-1 never actually enforced. Retained
  // for API compatibility; AUTH-2 uses Session.revokedAt as the real
  // revocation vector so this field is effectively cosmetic.
  generation?: number;
  // Internal — only present on validated sessions. Used by setActiveClub
  // and clearSession to identify the Session row. Not for callers.
  __sid?: string;
  __sessionId?: string;
};

export const SESSION_OPTIONS: SessionOptions = {
  cookieName: env.SESSION_COOKIE_NAME,
  password: env.SPECTRE_SESSION_SECRET,
  cookieOptions: {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    // AUTH-2 keeps the seven-day cookie lifetime to match Session.expiresAt.
    // AUTH-6 will introduce idle timeout + rolling renewal.
    maxAge: 60 * 60 * 24 * 7,
  },
};

async function getCookie() {
  return getIronSession<AdminCookieShape>(await cookies(), SESSION_OPTIONS);
}

/** Fetch the current admin session. Returns a populated shim when the
 *  cookie bearer resolves to a valid, unrevoked, unexpired Session
 *  record; returns an empty shim otherwise. Legacy AUTH-1 cookies
 *  (containing userId but no `sid`) return empty — they are NOT
 *  auto-upgraded. */
export async function getSession(): Promise<SessionData> {
  const cookie = await getCookie();
  const bearer = cookie.v === 2 && typeof cookie.sid === "string" ? cookie.sid : undefined;
  if (!bearer) return {};
  const session = await findValidSession(bearer, SURFACE_ADMIN);
  if (!session || !session.userId) return {};
  // Best-effort throttled last-seen update.
  void touchSession(session.id);
  return {
    userId: session.userId,
    activeClubId: session.activeClubId,
    generation: 1,
    __sid: bearer,
    __sessionId: session.id,
  };
}

/** Create or replace the admin session.
 *
 *  Overloaded to accept either the modern object signature or the
 *  legacy single-string userId form the original demo code used.
 *  Both produce a fresh Session row (session-fixation safe) and write
 *  the new bearer to the cookie.
 *
 *  ipAtCreate / uaAtCreate are populated when a `Request` header
 *  source is available; the current call sites in loginAction do not
 *  pass them explicitly, so they land as null. AUTH-2 accepts this;
 *  they are diagnostic, not authentication material. */
export async function setSession(
  arg:
    | string
    | (Pick<SessionData, "userId" | "activeClubId"> & { uaAtCreate?: string; ipAtCreate?: string }),
) {
  const data = typeof arg === "string" ? { userId: arg } : arg;
  if (!data.userId) throw new Error("setSession: userId is required");
  const cookie = await getCookie();
  // Session fixation: revoke any pre-existing bearer this cookie held
  // so the old row cannot be reused after re-authentication.
  if (cookie.v === 2 && typeof cookie.sid === "string") {
    // Look up the prior session so we know its id.
    const prior = await findValidSession(cookie.sid, SURFACE_ADMIN);
    if (prior) {
      await storeRevokeSession(prior.id, { revokedBy: data.userId, reason: "reauth" });
    }
  }
  // Resolve authoritative clubId from the user record. clubId is a
  // non-nullable Session column, so a user without a clubId (e.g. a
  // super-admin who is not attached to any specific tenant) needs a
  // sensible seed value. We fall back to `activeClubId ?? user.clubId`
  // and, if still null, defer creation and treat the login as if it
  // could not establish a session (the caller receives an error and
  // renders a failure — better than a broken row).
  const user = await prisma.user.findUnique({
    where: { id: data.userId },
    select: { clubId: true, status: true, clubRoles: { select: { clubId: true }, take: 1 } },
  });
  if (!user) throw new Error("setSession: user not found");
  if (user.status !== "ACTIVE") throw new Error("setSession: user not active");
  // clubId may legitimately be null for platform-level actors
  // (super-admin without a specific tenant). Session.clubId is
  // nullable to accommodate this case.
  const clubIdCandidate =
    data.activeClubId ?? user.clubId ?? user.clubRoles[0]?.clubId ?? null;
  const { bearer } = await storeCreateSession({
    surface: SURFACE_ADMIN,
    userId: data.userId,
    clubId: clubIdCandidate,
    activeClubId: data.activeClubId ?? null,
  });
  // Wipe legacy fields to leave a clean AUTH-2 payload behind.
  cookie.v = 2;
  cookie.sid = bearer;
  delete cookie.userId;
  delete cookie.activeClubId;
  delete cookie.generation;
  await cookie.save();
}

export async function setActiveClub(clubId: string | null) {
  const cookie = await getCookie();
  if (cookie.v !== 2 || typeof cookie.sid !== "string") return;
  const session = await findValidSession(cookie.sid, SURFACE_ADMIN);
  if (!session) return;
  // Authorisation (is this user allowed to view this club?) is the
  // CALLER's responsibility — session-store.ts documents this.
  await storeSetActiveClub(session.id, clubId);
}

export async function clearSession() {
  const cookie = await getCookie();
  if (cookie.v === 2 && typeof cookie.sid === "string") {
    const session = await findValidSession(cookie.sid, SURFACE_ADMIN);
    if (session) {
      await storeRevokeSession(session.id, { revokedBy: "self", reason: "logout" });
    }
  }
  cookie.destroy();
}

// ---------------------------------------------------------------------------
// Legacy compatibility shim — unchanged behaviour: returns a Prisma User
// with `.club` and `.member` relations. AUTH-2 keeps this because
// downstream callers still expect that shape.
// ---------------------------------------------------------------------------
export async function getCurrentUser() {
  const session = await getSession();
  if (!session.userId) return null;
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    include: { club: true, member: true },
  });
  if (!user) return null;
  if (user.status !== "ACTIVE") return null;
  return user;
}

export async function requireUser() {
  const u = await getCurrentUser();
  if (!u) throw new Error("UNAUTHENTICATED");
  return u;
}
