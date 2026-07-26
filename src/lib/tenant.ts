// Tenant-aware filter helpers. Every club-scoped query must go through these
// to ensure data isolation. SUPER_ADMIN sees across all clubs; everyone else
// is constrained to their own clubId.

import type { User } from "@prisma/client";

export type Principal = Pick<User, "id" | "clubId" | "role">;

export function tenantWhere(user: Principal): { clubId?: string } {
  if (user.role === "SUPER_ADMIN") return {};
  if (!user.clubId) {
    // Defensive: any non-super user must have a clubId. Returning an
    // impossible filter prevents accidental cross-tenant reads.
    return { clubId: "__no_tenant__" };
  }
  return { clubId: user.clubId };
}

export function requireClubId(user: Principal): string {
  if (!user.clubId) throw new Error("User has no clubId");
  return user.clubId;
}
