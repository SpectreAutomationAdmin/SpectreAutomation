// Slice D visual closeout (2026-09-19) — internal helper that builds a
// principal for a given user email WITHOUT going through the iron-session
// / cookies machinery. Used ONLY by the staging-only slice-d-pipeline
// route so it can invoke payroll services under distinct actors (PA +
// Controller) to satisfy submitter ≠ approver.
//
// DO NOT USE FROM FOUNDER-FACING SURFACES — regular request handlers
// must consume `getCurrentPrincipal()` which validates the actual
// authenticated session cookie.

import { prisma } from "@/lib/prisma";
import type { RoleKey } from "@/lib/permissions";

export async function loadPrincipalByEmail(email: string) {
  const u = await prisma.user.findUnique({
    where: { email },
    include: { clubRoles: true },
  });
  if (!u) throw new Error(`User missing: ${email}`);
  const memberships = u.clubRoles.map((r) => ({
    clubId: r.clubId,
    roleKey: r.roleKey as RoleKey,
  }));
  const firstScoped = memberships.find((m) => m.clubId)?.clubId ?? null;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    status: u.status,
    memberships,
    activeClubId: firstScoped,
    memberId: u.memberId,
  };
}
