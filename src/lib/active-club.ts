import { headers } from "next/headers";
import { prisma } from "./prisma";
import type { User } from "@prisma/client";
import { resolveClubByHost } from "./tenant-resolver";

// Returns the club a given admin user is "viewing".
//
// Resolution order (host wins to prevent a SUPER_ADMIN posting against the
// wrong club while looking at another club's domain):
//   1. Host-resolved clubId from middleware (`x-spectre-host` header).
//   2. The user's own `clubId` (single-tenant staff users).
//   3. The first seeded club (SUPER_ADMIN on the platform host).
export async function getActiveClubId(user: Pick<User, "clubId" | "role">): Promise<string> {
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
  if (user.clubId) return user.clubId;
  const first = await prisma.club.findFirst({ orderBy: { createdAt: "asc" } });
  if (!first) throw new Error("No clubs in database");
  return first.id;
}
