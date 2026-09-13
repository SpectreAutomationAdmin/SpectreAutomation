// Organizational Foundation (2026-09-13) — canonical manager
// resolution. One code path for "who does this person report to?".
//
// Priority (§5):
//   1. Explicit effective person-level manager override:
//        - Employee.managerProfileId or Employee.managerEmployeeId
//        - UserClubProfile.reportsToProfileId
//   2. Person's Position.reportsToPositionId → find active occupant(s)
//   3. Ambiguous (multiple occupants, no PRIMARY): return null with reason
//   4. Not resolved
//
// This resolver NEVER infers by department name, display title,
// security role, alphabetical order, or arbitrary first-user (§5).

import { prisma } from "@/lib/prisma";

export interface ManagerRef {
  kind: "employee" | "profile";
  id: string;
  displayName: string;
  positionName: string | null;
}

export interface ResolveResult {
  manager: ManagerRef | null;
  reason: "override" | "position-hierarchy" | "not-found" | "ambiguous" | "no-position";
  candidates?: ManagerRef[]; // populated on "ambiguous"
}

/**
 * Resolve who an Employee reports to.
 */
export async function resolveEmployeeManager(employeeId: string): Promise<ResolveResult> {
  const emp = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      clubId: true,
      managerProfileId: true,
      managerEmployeeId: true,
      orgPositionId: true,
      positionId: true, // legacy fallback
    },
  });
  if (!emp) return { manager: null, reason: "not-found" };

  // 1. explicit override wins
  if (emp.managerProfileId) {
    const p = await lookupProfile(emp.managerProfileId);
    if (p) return { manager: p, reason: "override" };
  }
  if (emp.managerEmployeeId) {
    const p = await lookupEmployee(emp.managerEmployeeId);
    if (p) return { manager: p, reason: "override" };
  }

  // 2. position hierarchy
  const positionId = emp.orgPositionId;
  if (!positionId) return { manager: null, reason: "no-position" };
  return resolveByPositionHierarchy(emp.clubId, positionId);
}

/**
 * Resolve who a UserClubProfile reports to. Priority is:
 *   1. explicit reportsToProfileId
 *   2. Position.reportsToPositionId → occupant
 */
export async function resolveProfileManager(profileId: string): Promise<ResolveResult> {
  const profile = await prisma.userClubProfile.findUnique({
    where: { id: profileId },
    select: {
      clubId: true,
      reportsToProfileId: true,
      positionId: true,
    },
  });
  if (!profile) return { manager: null, reason: "not-found" };
  if (profile.reportsToProfileId) {
    const p = await lookupProfile(profile.reportsToProfileId);
    if (p) return { manager: p, reason: "override" };
  }
  if (!profile.positionId) return { manager: null, reason: "no-position" };
  return resolveByPositionHierarchy(profile.clubId, profile.positionId);
}

async function resolveByPositionHierarchy(
  clubId: string,
  positionId: string,
): Promise<ResolveResult> {
  const pos = await prisma.organizationalPosition.findUnique({
    where: { id: positionId },
    select: {
      reportsToPositionId: true,
    },
  });
  if (!pos?.reportsToPositionId) return { manager: null, reason: "no-position" };

  // Find occupants of the parent Position at this Club.
  const [profileOccupants, employeeOccupants] = await Promise.all([
    prisma.userClubProfile.findMany({
      where: { clubId, positionId: pos.reportsToPositionId, status: "ACTIVE" },
      select: {
        id: true,
        displayTitle: true,
        user: { select: { name: true } },
        position: { select: { name: true } },
      },
    }),
    prisma.employee.findMany({
      where: {
        clubId,
        orgPositionId: pos.reportsToPositionId,
        employeeLifecycle: { in: ["ACTIVE", "PRE_HIRE"] },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        preferredName: true,
        orgPosition: { select: { name: true } },
      },
    }),
  ]);

  const candidates: ManagerRef[] = [
    ...profileOccupants.map<ManagerRef>((p) => ({
      kind: "profile",
      id: p.id,
      displayName: p.user.name,
      positionName: p.position?.name ?? p.displayTitle ?? null,
    })),
    ...employeeOccupants.map<ManagerRef>((e) => ({
      kind: "employee",
      id: e.id,
      displayName: `${e.preferredName?.trim() || e.firstName} ${e.lastName}`.trim(),
      positionName: e.orgPosition?.name ?? null,
    })),
  ];

  if (candidates.length === 0) return { manager: null, reason: "not-found" };
  if (candidates.length === 1) return { manager: candidates[0], reason: "position-hierarchy" };
  // Multiple occupants — §6 fail clearly.
  return { manager: null, reason: "ambiguous", candidates };
}

async function lookupProfile(profileId: string): Promise<ManagerRef | null> {
  const p = await prisma.userClubProfile.findUnique({
    where: { id: profileId },
    select: {
      id: true,
      displayTitle: true,
      user: { select: { name: true } },
      position: { select: { name: true } },
    },
  });
  if (!p) return null;
  return {
    kind: "profile",
    id: p.id,
    displayName: p.user.name,
    positionName: p.position?.name ?? p.displayTitle ?? null,
  };
}

async function lookupEmployee(employeeId: string): Promise<ManagerRef | null> {
  const e = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      preferredName: true,
      orgPosition: { select: { name: true } },
      position: { select: { name: true } }, // legacy
    },
  });
  if (!e) return null;
  return {
    kind: "employee",
    id: e.id,
    displayName: `${e.preferredName?.trim() || e.firstName} ${e.lastName}`.trim(),
    positionName: e.orgPosition?.name ?? e.position?.name ?? null,
  };
}

/**
 * Available manager options for the Add/Edit Employee form.
 * Returns the union of Employees + UserClubProfiles at this Club,
 * deduplicated where UserClubProfile.employeeId links the two.
 * When positionId is provided, the resolver returns the recommended
 * manager (single occupant of the parent Position) at the top.
 */
export interface ManagerOption extends ManagerRef {
  recommended?: boolean;
}

export async function listManagerOptions(
  clubId: string,
  opts: { positionId?: string | null } = {},
): Promise<{ recommended: ManagerOption | null; ambiguousRecommendations: ManagerOption[]; options: ManagerOption[] }> {
  const [profiles, employees, linkedProfiles] = await Promise.all([
    prisma.userClubProfile.findMany({
      where: { clubId, status: "ACTIVE" },
      select: {
        id: true, displayTitle: true, employeeId: true,
        user: { select: { name: true } },
        position: { select: { name: true } },
      },
    }),
    prisma.employee.findMany({
      where: { clubId, employeeLifecycle: { in: ["ACTIVE", "PRE_HIRE"] } },
      select: {
        id: true, firstName: true, lastName: true, preferredName: true,
        orgPosition: { select: { name: true } },
        position: { select: { name: true } },
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    }),
    prisma.userClubProfile.findMany({
      where: { clubId, NOT: { employeeId: null } },
      select: { employeeId: true, id: true },
    }),
  ]);
  const linkedEmpIds = new Set(
    linkedProfiles.map((p) => p.employeeId).filter((x): x is string => !!x),
  );

  const options: ManagerOption[] = [
    ...profiles.map<ManagerOption>((p) => ({
      kind: "profile",
      id: p.id,
      displayName: p.user.name,
      positionName: p.position?.name ?? p.displayTitle ?? null,
    })),
    ...employees
      // Dedupe: skip Employees whose profile is also in the profile list.
      .filter((e) => !linkedEmpIds.has(e.id))
      .map<ManagerOption>((e) => ({
        kind: "employee",
        id: e.id,
        displayName: `${e.preferredName?.trim() || e.firstName} ${e.lastName}`.trim(),
        positionName: e.orgPosition?.name ?? e.position?.name ?? null,
      })),
  ];

  let recommended: ManagerOption | null = null;
  let ambiguousRecommendations: ManagerOption[] = [];
  if (opts.positionId) {
    const pos = await prisma.organizationalPosition.findUnique({
      where: { id: opts.positionId },
      select: { reportsToPositionId: true, clubId: true },
    });
    if (pos?.clubId === clubId && pos.reportsToPositionId) {
      const parentOccupants = options.filter((o) => {
        // Reverse lookup — we need to know each option's positionId to
        // determine occupancy of the parent. This is expensive if done
        // per option, so re-query occupants of the parent position
        // instead.
        return false;
      });
      // Instead, fetch parent occupants directly.
      const parentId = pos.reportsToPositionId;
      const [pfOccupants, emOccupants] = await Promise.all([
        prisma.userClubProfile.findMany({
          where: { clubId, positionId: parentId, status: "ACTIVE" },
          select: { id: true },
        }),
        prisma.employee.findMany({
          where: {
            clubId, orgPositionId: parentId,
            employeeLifecycle: { in: ["ACTIVE", "PRE_HIRE"] },
          },
          select: { id: true },
        }),
      ]);
      const parentIds = new Set<string>([
        ...pfOccupants.map((p) => `profile:${p.id}`),
        ...emOccupants.filter((e) => !linkedEmpIds.has(e.id)).map((e) => `employee:${e.id}`),
      ]);
      const parentOccupantOptions = options.filter((o) => parentIds.has(`${o.kind}:${o.id}`));
      if (parentOccupantOptions.length === 1) {
        recommended = { ...parentOccupantOptions[0], recommended: true };
      } else if (parentOccupantOptions.length > 1) {
        ambiguousRecommendations = parentOccupantOptions.map((o) => ({ ...o, recommended: true }));
      }
    }
  }

  return { recommended, ambiguousRecommendations, options };
}
