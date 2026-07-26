import { prisma } from "./prisma";
import type { User } from "@prisma/client";

// Resolve the member that the current viewer is "acting as".
// - Real members: their own member record.
// - Admins demoing the experience: pass ?welcomeMember=<id>.
// Returns null if neither resolves.
export async function getActiveMember(
  user: Pick<User, "id" | "memberId" | "role" | "clubId">,
  override?: string | null
) {
  if (override) {
    const member = await prisma.member.findUnique({ where: { id: override } });
    if (member) {
      if (user.role !== "SUPER_ADMIN" && user.clubId && member.clubId !== user.clubId) return null;
      return member;
    }
  }
  if (user.memberId) {
    return prisma.member.findUnique({ where: { id: user.memberId } });
  }
  return null;
}
