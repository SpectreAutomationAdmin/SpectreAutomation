// Encrypted+signed session via iron-session.
//
// The session is the minimum needed to recover identity (`userId`) and the
// currently selected club (`activeClubId`). All other authorization data is
// re-read from Prisma per request so revocations take effect immediately.

import { cookies } from "next/headers";
import { getIronSession, type SessionOptions } from "iron-session";
import { env } from "./env";
import { prisma } from "./prisma";

export type SessionData = {
  userId?: string;
  activeClubId?: string | null;
  // Cache-busting counter so we can force-logout all sessions if needed.
  generation?: number;
};

export const SESSION_OPTIONS: SessionOptions = {
  cookieName: env.SESSION_COOKIE_NAME,
  password: env.SPECTRE_SESSION_SECRET,
  cookieOptions: {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  },
};

export async function getSession() {
  return getIronSession<SessionData>(cookies(), SESSION_OPTIONS);
}

// Overloaded to accept either the modern object signature or the legacy
// single-string userId form from the original demo code. Both produce a
// signed+encrypted iron-session cookie.
export async function setSession(arg: string | Pick<SessionData, "userId" | "activeClubId">) {
  const data = typeof arg === "string" ? { userId: arg } : arg;
  const session = await getSession();
  session.userId = data.userId;
  if ("activeClubId" in data) session.activeClubId = data.activeClubId ?? null;
  session.generation = (session.generation ?? 0) + 1;
  await session.save();
}

export async function setActiveClub(clubId: string | null) {
  const session = await getSession();
  session.activeClubId = clubId;
  await session.save();
}

export async function clearSession() {
  const session = await getSession();
  session.destroy();
}

// ---------------------------------------------------------------------------
// Legacy compatibility shim.
//
// The original demo code expects `getCurrentUser()` returning a Prisma User
// with `.club` and `.member` relations. Pages built before Phase 1 still rely
// on this shape. New code paths should use `getCurrentPrincipal()` (see
// src/lib/services/principal.ts) — which returns the RBAC Principal.
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
