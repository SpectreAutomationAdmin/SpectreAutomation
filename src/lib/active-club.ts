import { headers } from "next/headers";
import { prisma } from "./prisma";
import type { User } from "@prisma/client";
import { resolveClubByHost } from "./tenant-resolver";

// Returns the club a given admin user is "viewing".
//
// Resolution order (host wins to prevent a SUPER_ADMIN posting against the
// wrong club while looking at another club's domain):
//   1. Host-resolved clubId from middleware (`x-spectre-host` header).
//   2. The user's own `clubId` (single-tenant staff users, legacy
//      deprecated scalar) — but ONLY if the user still has an active
//      UserClubRole at that club. A stale `user.clubId` pointing at a
//      Club the user was removed from would otherwise send them into a
//      Club they can't access, tripping tenantWhere (see TA-1C hotfix
//      root-cause investigation).
//   3. The first authorised UserClubRole for this user, ordered by
//      createdAt asc. Deterministic single-club selection when the
//      user belongs to exactly one Club.
//   4. The first seeded club (SUPER_ADMIN on the platform host).
export async function getActiveClubId(
  user: Pick<User, "clubId" | "role"> & { id?: string },
): Promise<string> {
  try {
    const h = headers();
    const host = h.get("x-spectre-host") ?? h.get("host");
    if (host) {
      const resolved = await resolveClubByHost(host);
      if (resolved.mode === "club") return resolved.clubId;
    }
  } catch {
    // `headers()` only works in a request context; fall through for callers
    // outside one (e.g. background jobs, tests).
  }

  // Callers that pass a full User (including `id`) get the hardened
  // membership-aware resolution added in the TA-1C hotfix. Callers
  // that pass only `{ clubId, role }` (mostly older API route bodies
  // that plumb `principal.activeClubId` through as `clubId`) keep the
  // prior behaviour — their `clubId` was already vetted by
  // resolveActiveClubId when the principal was loaded.
  if (user.id) {
    const authorisedMemberships = await prisma.userClubRole.findMany({
      where: { userId: user.id, NOT: { clubId: null } },
      select: { clubId: true },
      orderBy: { createdAt: "asc" },
    });
    const authorisedIds = new Set(
      authorisedMemberships.map((m) => m.clubId).filter((c): c is string => c !== null),
    );

    // Legacy `user.clubId` scalar is honoured ONLY when the user
    // still has a matching UserClubRole. A stale scalar pointing at a
    // Club the user was removed from must NEVER route a query into
    // that Club.
    if (user.clubId && authorisedIds.has(user.clubId)) return user.clubId;

    // First authorised membership (deterministic order by createdAt).
    const firstAuthorised = authorisedMemberships[0]?.clubId;
    if (firstAuthorised) return firstAuthorised;
    // Otherwise user has no per-Club memberships — SUPER_ADMIN /
    // platform-only. Fall through to the oldest-Club shortcut below.
  } else if (user.clubId) {
    return user.clubId;
  }

  const first = await prisma.club.findFirst({ orderBy: { createdAt: "asc" } });
  if (!first) throw new Error("No clubs in database");
  return first.id;
}
