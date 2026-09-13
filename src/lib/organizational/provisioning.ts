// Organizational Foundation (2026-09-13) — canonical Position provisioning.
//
// Idempotent seeding of the default private-club Position catalogue +
// hierarchy for a Club. Callable from:
//   - future new-club onboarding
//   - staging/production backfills
//   - tests
//
// Deliberately in production/domain code (§30): not in prisma/seed.ts.
//
// Founder decisions honored:
//   §10-12  compensation (defaultPayRate, isExempt) NOT on canonical Position.
//   §13     stable code column (kebab-uppercase).
//   §14-15  starter catalogue matches founder's list; extra existing
//           legitimate Positions are preserved.
//   §16     starter hierarchy per founder's tree.
//   §17     Coulee-specific override: Clubhouse Manager → Controller
//           (applied by callers via a subsequent update; not baked in
//           here to keep the default template generic).
//   §21     Positions can exist with zero occupants (this file never
//           creates User/Employee rows).

import { prisma } from "@/lib/prisma";

/**
 * Starter Position catalogue. Each entry:
 *   code:             stable tenant-scoped identifier (never used as a permission grant).
 *   name:             human-readable label.
 *   departmentCode:   optional link into the club's Department catalogue by Department.code.
 *   sortOrder:        display order within department (10-unit gaps for insertion).
 *   description:      optional summary.
 *   reportsToCode:    parent Position code (must appear earlier in the array
 *                     OR be resolved in a second pass — the seeder does both).
 */
export interface StarterPositionSpec {
  code: string;
  name: string;
  departmentCode: string | null;
  sortOrder: number;
  reportsToCode: string | null;
  description?: string;
}

// §15 starter catalogue + §16 hierarchy. Order chosen so parents
// appear before children where practical, and the seeder does a
// second-pass wire-up for any remaining links.
export const STARTER_POSITIONS: StarterPositionSpec[] = [
  // Executive / Administration
  { code: "GENERAL_MANAGER",         name: "General Manager",                        departmentCode: "ADMIN",  sortOrder: 10, reportsToCode: null,                 description: "Club leadership; broad operating responsibility." },
  { code: "CONTROLLER",              name: "Controller / CFO",                       departmentCode: "ADMIN",  sortOrder: 20, reportsToCode: "GENERAL_MANAGER" },
  { code: "ASSISTANT_CONTROLLER",    name: "Assistant Controller",                   departmentCode: "ADMIN",  sortOrder: 30, reportsToCode: "CONTROLLER" },
  { code: "PAYROLL_ADMINISTRATOR",   name: "Payroll Administrator",                  departmentCode: "ADMIN",  sortOrder: 40, reportsToCode: "CONTROLLER" },
  { code: "ADMIN_ASSISTANT",         name: "Administrative Assistant",               departmentCode: "ADMIN",  sortOrder: 50, reportsToCode: "CONTROLLER" },
  { code: "CLUBHOUSE_MANAGER",       name: "Clubhouse Manager",                      departmentCode: "ADMIN",  sortOrder: 60, reportsToCode: "GENERAL_MANAGER" },

  // Golf Operations
  { code: "HEAD_GOLF_PROFESSIONAL",  name: "Head Golf Professional / Director of Golf", departmentCode: "GOLF", sortOrder: 10, reportsToCode: "GENERAL_MANAGER" },
  { code: "ASSOCIATE_GOLF_PRO",      name: "Associate Golf Professional",            departmentCode: "GOLF",   sortOrder: 20, reportsToCode: "HEAD_GOLF_PROFESSIONAL" },
  { code: "ASSISTANT_GOLF_PRO",      name: "Assistant Golf Professional",            departmentCode: "GOLF",   sortOrder: 30, reportsToCode: "HEAD_GOLF_PROFESSIONAL" },
  { code: "PRO_SHOP_STAFF",          name: "Pro Shop Staff",                         departmentCode: "GOLF",   sortOrder: 40, reportsToCode: "HEAD_GOLF_PROFESSIONAL" },

  // Food & Beverage
  { code: "FAB_MANAGER",             name: "Food & Beverage Manager",                departmentCode: "FAB",    sortOrder: 10, reportsToCode: "GENERAL_MANAGER" },
  { code: "EXECUTIVE_CHEF",          name: "Executive Chef / Head Chef",             departmentCode: "CULINARY", sortOrder: 10, reportsToCode: "FAB_MANAGER" },
  { code: "SOUS_CHEF",               name: "Sous Chef",                              departmentCode: "CULINARY", sortOrder: 20, reportsToCode: "EXECUTIVE_CHEF" },
  { code: "FOH_MANAGER",             name: "Front of House Manager",                 departmentCode: "FAB",    sortOrder: 20, reportsToCode: "FAB_MANAGER" },
  { code: "BANQUETS_MANAGER",        name: "Banquets & Events Manager",              departmentCode: "FAB",    sortOrder: 30, reportsToCode: "FAB_MANAGER" },
  { code: "BARTENDER",               name: "Bartender",                              departmentCode: "FAB",    sortOrder: 40, reportsToCode: "FOH_MANAGER" },
  { code: "SERVER",                  name: "Server",                                 departmentCode: "FAB",    sortOrder: 50, reportsToCode: "FOH_MANAGER" },
  { code: "CULINARY_STAFF",          name: "Culinary Staff",                         departmentCode: "CULINARY", sortOrder: 30, reportsToCode: "EXECUTIVE_CHEF" },
  { code: "SERVICE_STAFF",           name: "Service Staff",                          departmentCode: "FAB",    sortOrder: 60, reportsToCode: "FOH_MANAGER" },

  // Grounds
  { code: "SUPERINTENDENT",          name: "Golf Course Superintendent",             departmentCode: "GROUNDS", sortOrder: 10, reportsToCode: "GENERAL_MANAGER" },
  { code: "ASSISTANT_SUPERINTENDENT", name: "Assistant Superintendent",              departmentCode: "GROUNDS", sortOrder: 20, reportsToCode: "SUPERINTENDENT" },
  { code: "GREENSKEEPER",            name: "Greenskeeper",                           departmentCode: "GROUNDS", sortOrder: 30, reportsToCode: "SUPERINTENDENT" },
  { code: "GROUNDS_STAFF",           name: "Grounds Staff",                          departmentCode: "GROUNDS", sortOrder: 40, reportsToCode: "SUPERINTENDENT" },

  // Membership / Communications
  { code: "MEMBERSHIP_MANAGER",      name: "Membership Manager",                     departmentCode: "MEMBER", sortOrder: 10, reportsToCode: "GENERAL_MANAGER" },
  { code: "COMMS_MANAGER",           name: "Communications / Marketing Manager",     departmentCode: "MEMBER", sortOrder: 20, reportsToCode: "GENERAL_MANAGER" },

  // Facilities
  { code: "FACILITIES_MANAGER",      name: "Facilities / Maintenance Manager",       departmentCode: "FACILITY", sortOrder: 10, reportsToCode: "GENERAL_MANAGER" },
  { code: "FACILITIES_STAFF",        name: "Facilities Staff",                       departmentCode: "FACILITY", sortOrder: 20, reportsToCode: "FACILITIES_MANAGER" },
];

/**
 * Alias normalization: canonical Position name(s) that historic
 * EmployeePosition rows may match under a different label. Keys are
 * lower-cased. When a legitimate legacy EmployeePosition exists whose
 * name (case-insensitive) matches a starter's `name` OR any alias
 * below, it is treated as the same semantic Position rather than a
 * duplicate.
 */
export const POSITION_ALIASES: Record<string, string> = {
  "head chef": "EXECUTIVE_CHEF",
  "executive chef": "EXECUTIVE_CHEF",
  "director of golf": "HEAD_GOLF_PROFESSIONAL",
  "head golf professional": "HEAD_GOLF_PROFESSIONAL",
  "cfo": "CONTROLLER",
  "controller": "CONTROLLER",
  "f&b manager": "FAB_MANAGER",
  "food & beverage manager": "FAB_MANAGER",
  "assistant golf pro": "ASSISTANT_GOLF_PRO",
  "assistant golf professional": "ASSISTANT_GOLF_PRO",
};

export interface ProvisionResult {
  clubId: string;
  positionsCreated: number;
  positionsUpdated: number;
  positionsSkipped: number;
  hierarchyLinksSet: number;
}

/**
 * Idempotent: seeds the default private-club Position catalogue for a
 * Club. Positions already present (matched by clubId × code OR
 * clubId × name) are LEFT ALONE — no destructive rewrites of tenant
 * customization. New positions are inserted; hierarchy links are
 * wired on a second pass so seeding is order-independent.
 */
export async function provisionDefaultOrganization(clubId: string): Promise<ProvisionResult> {
  const result: ProvisionResult = {
    clubId,
    positionsCreated: 0,
    positionsUpdated: 0,
    positionsSkipped: 0,
    hierarchyLinksSet: 0,
  };

  // Resolve Department mapping (starter code → real Department id).
  // A Club's Departments are tenant-owned and may not match starter
  // codes 1:1; fall back to nearest-name match, else leave null.
  const depts = await prisma.department.findMany({
    where: { clubId },
    select: { id: true, code: true, name: true },
  });
  const deptByCode = new Map(depts.map((d) => [d.code.toUpperCase(), d]));
  const deptByNameLower = new Map(depts.map((d) => [d.name.toLowerCase(), d]));
  const STARTER_DEPT_NAME_HINTS: Record<string, string[]> = {
    ADMIN: ["administration"],
    GOLF: ["golf operations", "golf ops", "golf"],
    FAB: ["food & beverage", "food and beverage", "f&b"],
    CULINARY: ["culinary"],
    GROUNDS: ["grounds"],
    MEMBER: ["membership"],
    FACILITY: ["facilities", "maintenance"],
  };
  const resolveDepartment = (starterCode: string | null): string | null => {
    if (!starterCode) return null;
    const direct = deptByCode.get(starterCode);
    if (direct) return direct.id;
    for (const hint of STARTER_DEPT_NAME_HINTS[starterCode] ?? []) {
      const byName = deptByNameLower.get(hint);
      if (byName) return byName.id;
    }
    return null;
  };

  // Pre-load every existing Position for the Club so we can dedupe.
  const existing = await prisma.organizationalPosition.findMany({
    where: { clubId },
    select: { id: true, name: true, code: true },
  });
  const existingByCode = new Map(
    existing.filter((p) => p.code).map((p) => [p.code as string, p.id]),
  );
  const existingByName = new Map(existing.map((p) => [p.name.toLowerCase(), p.id]));

  // Pass 1: upsert each starter Position (create-if-missing; do not
  // mutate an existing row's name/hierarchy without founder action).
  const codeToPositionId = new Map<string, string>();
  for (const spec of STARTER_POSITIONS) {
    let posId = existingByCode.get(spec.code)
      ?? existingByName.get(spec.name.toLowerCase())
      ?? null;
    if (!posId) {
      // Check alias table for legacy labels
      for (const [alias, canonicalCode] of Object.entries(POSITION_ALIASES)) {
        if (canonicalCode !== spec.code) continue;
        const hit = existingByName.get(alias);
        if (hit) { posId = hit; break; }
      }
    }
    if (posId) {
      // If we found a matching legacy row with a NULL code, set the
      // canonical code so future lookups are exact.
      const before = existing.find((p) => p.id === posId);
      if (before && !before.code) {
        await prisma.organizationalPosition.update({
          where: { id: posId },
          data: { code: spec.code },
        });
        result.positionsUpdated++;
      } else {
        result.positionsSkipped++;
      }
      codeToPositionId.set(spec.code, posId);
      continue;
    }
    const created = await prisma.organizationalPosition.create({
      data: {
        clubId,
        name: spec.name,
        code: spec.code,
        departmentId: resolveDepartment(spec.departmentCode),
        description: spec.description,
        sortOrder: spec.sortOrder,
        isActive: true,
      },
      select: { id: true },
    });
    codeToPositionId.set(spec.code, created.id);
    result.positionsCreated++;
  }

  // Pass 2: wire hierarchy. Only set reportsToPositionId when it is
  // currently null AND both endpoints exist. Never overwrite an
  // existing link (tenant customization).
  for (const spec of STARTER_POSITIONS) {
    if (!spec.reportsToCode) continue;
    const childId = codeToPositionId.get(spec.code);
    const parentId = codeToPositionId.get(spec.reportsToCode);
    if (!childId || !parentId) continue;
    if (childId === parentId) continue; // cannot self-parent

    const currentChild = await prisma.organizationalPosition.findUnique({
      where: { id: childId },
      select: { reportsToPositionId: true },
    });
    if (currentChild?.reportsToPositionId) continue;
    await prisma.organizationalPosition.update({
      where: { id: childId },
      data: { reportsToPositionId: parentId },
    });
    result.hierarchyLinksSet++;
  }

  return result;
}

/**
 * Sets a Position's reports-to link. Enforces:
 *   - same-club invariant
 *   - no self-report
 *   - no cycle in the resulting graph
 * Callable by tenant admins editing hierarchy.
 */
export async function setPositionReportsTo(
  clubId: string,
  positionId: string,
  reportsToPositionId: string | null,
): Promise<void> {
  const pos = await prisma.organizationalPosition.findUnique({
    where: { id: positionId },
    select: { clubId: true },
  });
  if (!pos || pos.clubId !== clubId) throw new Error("Position not found in this Club.");

  if (reportsToPositionId === null) {
    await prisma.organizationalPosition.update({
      where: { id: positionId },
      data: { reportsToPositionId: null },
    });
    return;
  }
  if (positionId === reportsToPositionId) {
    throw new Error("A Position cannot report to itself.");
  }
  const parent = await prisma.organizationalPosition.findUnique({
    where: { id: reportsToPositionId },
    select: { clubId: true },
  });
  if (!parent || parent.clubId !== clubId) {
    throw new Error("Parent Position not found in this Club.");
  }

  // Cycle detection: walk up from the proposed parent; if we hit
  // positionId, the assignment would create a cycle.
  let cursor: string | null = reportsToPositionId;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === positionId) {
      throw new Error("Cycle detected: this assignment would make the Position report to a descendant.");
    }
    if (seen.has(cursor)) break; // paranoia
    seen.add(cursor);
    const nextRow: { reportsToPositionId: string | null } | null = await prisma.organizationalPosition.findUnique({
      where: { id: cursor },
      select: { reportsToPositionId: true },
    });
    cursor = nextRow?.reportsToPositionId ?? null;
  }

  await prisma.organizationalPosition.update({
    where: { id: positionId },
    data: { reportsToPositionId },
  });
}
