// Organizational Foundation closeout (2026-09-13) — canonical
// responsibility-owner resolver facade. Small — one function that
// delegates to the existing responsibility systems in documented
// precedence (§12).
//
// Precedence (deterministic; never picks arbitrarily):
//   1. Active DepartmentResponsibility for (clubId, departmentId, key).
//   2. Active ResponsibilityAssignment PRIMARY at club scope.
//   3. Preferred Position occupant at the club:
//        - single active occupant → that user.
//        - multiple occupants → ambiguous (return null + candidates).
//   4. Not resolved → { ownerUserId: null, reason: "unresolved" }.
//
// This facade never grants authorization; it identifies WHO owns an
// operational responsibility. Consumers still enforce their own
// permission checks separately.

import { prisma } from "@/lib/prisma";

export interface ResponsibilityCandidate {
  userId: string;
  displayName: string | null;
  source: "profile" | "employee-user";
}

export interface ResolveResponsibilityOwnerResult {
  ownerUserId: string | null;
  reason:
    | "department-responsibility"
    | "responsibility-assignment"
    | "position-occupancy"
    | "ambiguous"
    | "unresolved";
  candidates?: ResponsibilityCandidate[];
}

export interface ResolveResponsibilityOwnerArgs {
  clubId: string;
  responsibilityKey: string;
  departmentId?: string | null;
  preferredPositionCode?: string | null;
}

export async function resolveResponsibilityOwner(
  args: ResolveResponsibilityOwnerArgs,
): Promise<ResolveResponsibilityOwnerResult> {
  const { clubId, responsibilityKey, departmentId, preferredPositionCode } = args;

  // 1. Department-scoped responsibility (highest priority).
  if (departmentId) {
    const dr = await prisma.departmentResponsibility.findFirst({
      where: { clubId, departmentId, responsibilityKey },
      select: { userId: true },
    });
    if (dr) {
      return { ownerUserId: dr.userId, reason: "department-responsibility" };
    }
  }

  // 2. Club-wide responsibility assignment PRIMARY (active, no effectiveTo).
  const clubAssignment = await prisma.responsibilityAssignment.findFirst({
    where: {
      clubId, responsibilityKey, role: "PRIMARY", effectiveTo: null,
    },
    select: { userId: true },
  });
  if (clubAssignment) {
    return { ownerUserId: clubAssignment.userId, reason: "responsibility-assignment" };
  }

  // 3. Preferred Position occupancy.
  if (preferredPositionCode) {
    const position = await prisma.organizationalPosition.findFirst({
      where: { clubId, code: preferredPositionCode, isActive: true },
      select: { id: true },
    });
    if (position) {
      const [profileOccupants, employeeOccupants] = await Promise.all([
        prisma.userClubProfile.findMany({
          where: { clubId, positionId: position.id, status: "ACTIVE" },
          select: {
            userId: true,
            user: { select: { name: true } },
          },
        }),
        prisma.employee.findMany({
          where: {
            clubId, orgPositionId: position.id,
            employeeLifecycle: { in: ["ACTIVE", "PRE_HIRE"] },
            NOT: { userId: null },
          },
          select: {
            userId: true,
            firstName: true, lastName: true, preferredName: true,
          },
        }),
      ]);
      const candidates: ResponsibilityCandidate[] = [
        ...profileOccupants.map<ResponsibilityCandidate>((p) => ({
          userId: p.userId,
          displayName: p.user.name,
          source: "profile" as const,
        })),
        ...employeeOccupants
          .filter((e): e is typeof e & { userId: string } => !!e.userId)
          .map<ResponsibilityCandidate>((e) => ({
            userId: e.userId,
            displayName: `${e.preferredName?.trim() || e.firstName} ${e.lastName}`.trim(),
            source: "employee-user" as const,
          })),
      ];
      // Dedupe on userId in case an org User is ALSO the User backing an Employee.
      const seen = new Set<string>();
      const uniqueCandidates = candidates.filter((c) => {
        if (seen.has(c.userId)) return false;
        seen.add(c.userId);
        return true;
      });
      if (uniqueCandidates.length === 1) {
        return { ownerUserId: uniqueCandidates[0].userId, reason: "position-occupancy" };
      }
      if (uniqueCandidates.length > 1) {
        return { ownerUserId: null, reason: "ambiguous", candidates: uniqueCandidates };
      }
    }
  }

  return { ownerUserId: null, reason: "unresolved" };
}
