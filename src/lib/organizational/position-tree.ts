// Organizational Foundation closeout (2026-09-13) — canonical Position
// tree for the Organization tab. Driven by
// OrganizationalPosition.reportsToPositionId with active occupants
// (UserClubProfiles + Employees) joined onto each node.
//
// Represents vacant Positions (occupants[] empty) — this is the whole
// reason the tree is Position-first, not Profile-first.

import { prisma } from "@/lib/prisma";

export interface PositionOccupant {
  kind: "profile" | "employee";
  id: string;
  displayName: string;
}

export interface PositionNode {
  id: string;
  name: string;
  code: string | null;
  departmentId: string | null;
  departmentName: string | null;
  isActive: boolean;
  reportsToPositionId: string | null;
  sortOrder: number;
  occupants: PositionOccupant[];
  children: PositionNode[];
}

export interface PositionTreeResult {
  roots: PositionNode[];
  /** Positions whose reports-to references a Position outside the
   *  active tree (e.g. reports to a deactivated parent). Rendered as
   *  additional roots so nothing is silently hidden. */
  orphans: PositionNode[];
  /** Flat map for quick client-side lookups. */
  byId: Record<string, PositionNode>;
}

export async function loadCanonicalPositionTree(
  clubId: string,
  opts: { includeInactive?: boolean } = {},
): Promise<PositionTreeResult> {
  const [positions, profiles, employees, departments] = await Promise.all([
    prisma.organizationalPosition.findMany({
      where: { clubId, ...(opts.includeInactive ? {} : { isActive: true }) },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: {
        id: true, name: true, code: true, departmentId: true, isActive: true,
        reportsToPositionId: true, sortOrder: true,
      },
    }),
    prisma.userClubProfile.findMany({
      where: { clubId, status: "ACTIVE", NOT: { positionId: null } },
      select: {
        id: true, positionId: true,
        user: { select: { name: true } },
      },
    }),
    prisma.employee.findMany({
      where: {
        clubId,
        employeeLifecycle: { in: ["ACTIVE", "PRE_HIRE"] },
        NOT: { orgPositionId: null },
      },
      select: {
        id: true, orgPositionId: true,
        firstName: true, lastName: true, preferredName: true,
      },
    }),
    prisma.department.findMany({
      where: { clubId },
      select: { id: true, name: true },
    }),
  ]);
  const deptById = new Map(departments.map((d) => [d.id, d.name]));

  const byId: Record<string, PositionNode> = {};
  for (const p of positions) {
    byId[p.id] = {
      id: p.id,
      name: p.name,
      code: p.code,
      departmentId: p.departmentId,
      departmentName: p.departmentId ? deptById.get(p.departmentId) ?? null : null,
      isActive: p.isActive,
      reportsToPositionId: p.reportsToPositionId,
      sortOrder: p.sortOrder,
      occupants: [],
      children: [],
    };
  }
  for (const pf of profiles) {
    if (!pf.positionId) continue;
    const node = byId[pf.positionId];
    if (node) node.occupants.push({ kind: "profile", id: pf.id, displayName: pf.user.name });
  }
  for (const e of employees) {
    if (!e.orgPositionId) continue;
    const node = byId[e.orgPositionId];
    if (node) node.occupants.push({
      kind: "employee",
      id: e.id,
      displayName: `${e.preferredName?.trim() || e.firstName} ${e.lastName}`.trim(),
    });
  }

  // Build hierarchy.
  const roots: PositionNode[] = [];
  const orphans: PositionNode[] = [];
  for (const node of Object.values(byId)) {
    if (node.reportsToPositionId === null) {
      roots.push(node);
    } else if (!byId[node.reportsToPositionId]) {
      // Parent exists but is filtered out (inactive when includeInactive=false).
      orphans.push(node);
    } else {
      byId[node.reportsToPositionId].children.push(node);
    }
  }
  const sortNodes = (nodes: PositionNode[]) => {
    nodes.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    nodes.forEach((n) => sortNodes(n.children));
  };
  sortNodes(roots);
  sortNodes(orphans);
  return { roots, orphans, byId };
}
