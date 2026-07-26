// RBAC helpers — authorization is centralized here.
//
// Authoritative model: a Principal is a User plus the set of UserClubRole
// rows they hold. Every check resolves a permission key against those rows
// for a specific clubId (or globally for SUPER_ADMIN).

import { prisma } from "./prisma";
import { ROLE_PERMISSIONS, type PermissionKey, type RoleKey } from "./permissions";
import { ForbiddenError, UnauthenticatedError } from "./errors";

export type Principal = {
  id: string;
  name: string;
  email: string;
  status: string;
  // The set of clubs (and global) this user has roles in, with the role keys.
  // A null clubId in a row means a global role (SUPER_ADMIN).
  memberships: Array<{ clubId: string | null; roleKey: RoleKey }>;
  // Convenience: the active club the user is "viewing".
  activeClubId: string | null;
  // For convenience in member portal code paths.
  memberId: string | null;
};

export function isSuperAdmin(p: Principal): boolean {
  return p.memberships.some((m) => m.clubId === null && m.roleKey === "SUPER_ADMIN");
}

export function clubsForPrincipal(p: Principal): string[] {
  if (isSuperAdmin(p)) return []; // empty means "all clubs"
  const set = new Set<string>();
  for (const m of p.memberships) if (m.clubId) set.add(m.clubId);
  return Array.from(set);
}

export function rolesAtClub(p: Principal, clubId: string | null): RoleKey[] {
  if (isSuperAdmin(p)) return ["SUPER_ADMIN"];
  return p.memberships.filter((m) => m.clubId === clubId).map((m) => m.roleKey);
}

// Core check. Returns true if the principal holds any role at `clubId`
// (or globally) that grants `permission`. SUPER_ADMIN always wins.
export function hasPermission(p: Principal, clubId: string | null, permission: PermissionKey): boolean {
  if (isSuperAdmin(p)) return true;
  const roles = rolesAtClub(p, clubId);
  for (const role of roles) {
    const grants = ROLE_PERMISSIONS[role];
    if (grants.includes(permission)) return true;
  }
  return false;
}

export function canAccessClub(p: Principal, clubId: string): boolean {
  if (isSuperAdmin(p)) return true;
  return p.memberships.some((m) => m.clubId === clubId);
}

// Throwing helpers (preferred in service-layer code paths). Use these so that
// every authorization failure produces a typed error route handlers can render.
export function requirePermission(p: Principal | null, clubId: string | null, permission: PermissionKey): asserts p is Principal {
  if (!p) throw new UnauthenticatedError();
  if (!hasPermission(p, clubId, permission)) {
    throw new ForbiddenError(`Missing permission: ${permission}`);
  }
}

export function requireClubAccess(p: Principal | null, clubId: string): asserts p is Principal {
  if (!p) throw new UnauthenticatedError();
  if (!canAccessClub(p, clubId)) throw new ForbiddenError("No access to this club");
}

// Load a Principal from the DB given a userId. Used by getCurrentPrincipal()
// (session.ts wrapper) and by tests.
export async function loadPrincipal(userId: string, activeClubId: string | null): Promise<Principal | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { clubRoles: true },
  });
  if (!user) return null;
  if (user.status !== "ACTIVE") return null;

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    status: user.status,
    memberships: user.clubRoles.map((r) => ({ clubId: r.clubId, roleKey: r.roleKey as RoleKey })),
    activeClubId,
    memberId: user.memberId,
  };
}

// Resolve the active club for the current request. Order:
//   1. session.activeClubId, if the principal still has access.
//   2. The user's first non-global membership.
//   3. For super-admin demo, the first club in the system.
//   4. Null.
export async function resolveActiveClubId(
  principal: Principal,
  sessionActiveClubId: string | null | undefined
): Promise<string | null> {
  if (sessionActiveClubId && canAccessClub(principal, sessionActiveClubId)) {
    return sessionActiveClubId;
  }
  const firstScoped = principal.memberships.find((m) => m.clubId !== null);
  if (firstScoped?.clubId) return firstScoped.clubId;
  if (isSuperAdmin(principal)) {
    const first = await prisma.club.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
    return first?.id ?? null;
  }
  return null;
}
