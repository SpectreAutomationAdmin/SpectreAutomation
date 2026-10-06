// COA-MAP-1 (2026-10-06) — tenant-created Financial Statement Group
// CRUD service.
//
// Create / edit / reorder tenant groups. Default (seeded) groups
// cannot be deleted and cannot have `isTenantCreated` flipped. The
// Controller specifies name + statement + role; the service picks a
// stable `key` automatically (never surfaced in the UI).

import { prisma } from "@/lib/prisma";
import {
  isReportingRole,
  statementForReportingRole,
  type ReportingRole,
} from "./reporting-role";
import { validateGroupDeletion } from "./validation";

export class GroupServiceError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export type CreateGroupInput = {
  clubId: string;
  name: string;
  statement: "INCOME_STATEMENT" | "BALANCE_SHEET" | "CASH_FLOW";
  parentGroupId?: string | null;
  reportingRole?: ReportingRole | null;
  sortOrder?: number;
  actorUserId: string | null;
  actorEmail: string | null;
};

/**
 * Create a tenant-owned Financial Statement Group. The internal
 * `key` is generated deterministically from the name — the
 * Controller never sees it. Collisions are resolved by appending
 * a numeric suffix.
 */
export async function createTenantGroup(input: CreateGroupInput) {
  const name = input.name.trim();
  if (!name) throw new GroupServiceError("NAME_REQUIRED", "Group name is required.");

  if (input.reportingRole && !isReportingRole(input.reportingRole)) {
    throw new GroupServiceError("INVALID_ROLE", `Unknown reporting role: ${input.reportingRole}.`);
  }
  if (input.reportingRole) {
    const roleStatement = statementForReportingRole(input.reportingRole);
    if (
      roleStatement === "INCOME_STATEMENT" && input.statement !== "INCOME_STATEMENT" ||
      roleStatement === "BALANCE_SHEET" && input.statement !== "BALANCE_SHEET"
    ) {
      throw new GroupServiceError(
        "ROLE_STATEMENT_MISMATCH",
        `Reporting role ${input.reportingRole} does not belong on ${input.statement}.`,
      );
    }
  }
  if (input.parentGroupId) {
    const parent = await prisma.financialStatementGroup.findUnique({
      where: { id: input.parentGroupId },
      select: { id: true, clubId: true, statement: true },
    });
    if (!parent) throw new GroupServiceError("PARENT_NOT_FOUND", "Parent group not found.");
    if (parent.clubId !== input.clubId) throw new GroupServiceError("CROSS_TENANT", "Parent group belongs to another club.");
    if (parent.statement !== input.statement) {
      throw new GroupServiceError(
        "PARENT_STATEMENT_MISMATCH",
        `New group's statement (${input.statement}) does not match parent (${parent.statement}).`,
      );
    }
  }

  const key = await pickUniqueKey(input.clubId, name);
  const sortOrder = input.sortOrder ?? (await nextSortOrder(input.clubId, input.statement, input.parentGroupId ?? null));

  const result = await prisma.$transaction(async (tx) => {
    const created = await tx.financialStatementGroup.create({
      data: {
        clubId: input.clubId,
        key,
        name,
        statement: input.statement,
        parentGroupId: input.parentGroupId ?? null,
        reportingRole: input.reportingRole ?? null,
        sortOrder,
        isTenantCreated: true,
      },
    });
    const audit = await tx.mappingChangeAudit.create({
      data: {
        clubId: input.clubId,
        action: "GROUP_CREATE",
        entityType: "FinancialStatementGroup",
        entityId: created.id,
        payloadJson: JSON.stringify({
          key: created.key,
          name: created.name,
          statement: created.statement,
          parentGroupId: created.parentGroupId,
          reportingRole: created.reportingRole,
          sortOrder: created.sortOrder,
        }),
        actorUserId: input.actorUserId,
        actorEmail: input.actorEmail,
      },
      select: { id: true },
    });
    return { group: created, auditId: audit.id };
  });

  return result;
}

export type EditGroupInput = {
  clubId: string;
  groupId: string;
  name?: string;
  reportingRole?: ReportingRole | null;
  parentGroupId?: string | null;
  sortOrder?: number;
  actorUserId: string | null;
  actorEmail: string | null;
};

export async function editTenantGroup(input: EditGroupInput) {
  const existing = await prisma.financialStatementGroup.findUnique({
    where: { id: input.groupId },
    select: {
      id: true, clubId: true, key: true, name: true, statement: true,
      parentGroupId: true, reportingRole: true, sortOrder: true, isTenantCreated: true,
    },
  });
  if (!existing) throw new GroupServiceError("GROUP_NOT_FOUND", "Group not found.");
  if (existing.clubId !== input.clubId) throw new GroupServiceError("CROSS_TENANT", "Group belongs to another club.");
  // Default groups: only `sortOrder` + `reportingRole` can be edited
  // via this path (never the display name).
  if (!existing.isTenantCreated) {
    if (input.name !== undefined && input.name.trim() !== existing.name) {
      throw new GroupServiceError(
        "DEFAULT_GROUP_RENAME_FORBIDDEN",
        "Spectre default groups cannot be renamed from the Mapping Studio.",
      );
    }
    if (input.parentGroupId !== undefined && input.parentGroupId !== existing.parentGroupId) {
      throw new GroupServiceError(
        "DEFAULT_GROUP_REPARENT_FORBIDDEN",
        "Spectre default groups cannot be reparented from the Mapping Studio.",
      );
    }
  }
  if (input.reportingRole !== undefined && input.reportingRole !== null && !isReportingRole(input.reportingRole)) {
    throw new GroupServiceError("INVALID_ROLE", `Unknown reporting role: ${input.reportingRole}.`);
  }

  const name = input.name?.trim() ?? existing.name;
  const parentGroupId =
    input.parentGroupId === undefined ? existing.parentGroupId : input.parentGroupId;
  const reportingRole =
    input.reportingRole === undefined ? existing.reportingRole : input.reportingRole;
  const sortOrder = input.sortOrder ?? existing.sortOrder;

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.financialStatementGroup.update({
      where: { id: input.groupId },
      data: { name, parentGroupId, reportingRole, sortOrder },
    });
    const audit = await tx.mappingChangeAudit.create({
      data: {
        clubId: input.clubId,
        action: "GROUP_EDIT",
        entityType: "FinancialStatementGroup",
        entityId: input.groupId,
        payloadJson: JSON.stringify({
          before: existing,
          after: {
            name: updated.name,
            parentGroupId: updated.parentGroupId,
            reportingRole: updated.reportingRole,
            sortOrder: updated.sortOrder,
          },
        }),
        actorUserId: input.actorUserId,
        actorEmail: input.actorEmail,
      },
      select: { id: true },
    });
    return { group: updated, auditId: audit.id };
  });
  return result;
}

export type DeleteGroupInput = {
  clubId: string;
  groupId: string;
  actorUserId: string | null;
  actorEmail: string | null;
};

export async function deleteTenantGroup(input: DeleteGroupInput) {
  const existing = await prisma.financialStatementGroup.findUnique({
    where: { id: input.groupId },
    select: {
      id: true, clubId: true, key: true, name: true, statement: true, reportingRole: true,
      isTenantCreated: true,
      _count: {
        select: { accounts: true, assignments: true },
      },
    },
  });
  if (!existing) throw new GroupServiceError("GROUP_NOT_FOUND", "Group not found.");
  if (existing.clubId !== input.clubId) throw new GroupServiceError("CROSS_TENANT", "Group belongs to another club.");

  const assignmentCount = existing._count.accounts + existing._count.assignments;
  const validation = validateGroupDeletion({
    group: {
      id: existing.id, key: existing.key, name: existing.name,
      statement: existing.statement, reportingRole: existing.reportingRole,
    },
    assignmentCount,
    isTenantCreated: existing.isTenantCreated,
  });
  if (validation.outcome === "BLOCKED") {
    throw new GroupServiceError(validation.reasons[0].code, validation.reasons[0].message);
  }

  await prisma.$transaction(async (tx) => {
    await tx.financialStatementGroup.delete({ where: { id: input.groupId } });
    await tx.mappingChangeAudit.create({
      data: {
        clubId: input.clubId,
        action: "GROUP_DELETE",
        entityType: "FinancialStatementGroup",
        entityId: input.groupId,
        payloadJson: JSON.stringify({ deletedGroup: existing }),
        actorUserId: input.actorUserId,
        actorEmail: input.actorEmail,
      },
    });
  });
}

/**
 * Pick a stable, deterministic key for a tenant-created group.
 * Format: TENANT_<SLUG>_<N> where <SLUG> is the uppercased + underscored
 * name and <N> is appended only when there's a collision.
 */
async function pickUniqueKey(clubId: string, name: string): Promise<string> {
  const slug = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40) || "GROUP";
  const base = `TENANT_${slug}`;
  // Check for existing collisions in this club.
  const existing = await prisma.financialStatementGroup.findMany({
    where: { clubId, key: { startsWith: base } },
    select: { key: true },
  });
  if (!existing.some((e) => e.key === base)) return base;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base}_${i}`;
    if (!existing.some((e) => e.key === candidate)) return candidate;
  }
  throw new GroupServiceError("KEY_COLLISION", "Could not generate a unique group key.");
}

async function nextSortOrder(
  clubId: string,
  statement: string,
  parentGroupId: string | null,
): Promise<number> {
  const max = await prisma.financialStatementGroup.aggregate({
    where: { clubId, statement, parentGroupId },
    _max: { sortOrder: true },
  });
  return (max._max.sortOrder ?? 0) + 10;
}
