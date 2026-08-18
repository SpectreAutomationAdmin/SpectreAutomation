// Phase 20 (Member Database, 2026-08-15) — member group assignment
// service.
//
// Groups are a per-club many-to-many segmentation vocabulary used
// on the Member Profile (Sailing Approved, Tennis, Wednesday Night
// Racing, etc.). This module owns the safe write paths — every
// mutation is club-scoped + audited + permission-gated. Reads live
// on the profile page loader itself (Prisma includes).

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { hasPermission, type Principal } from "../rbac";
import { assertTenantOwned } from "./tenant";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";

function requireAdmin(principal: Principal, clubId: string) {
  if (!hasPermission(principal, clubId, "members:write")) {
    throw new ForbiddenError("Not permitted to modify member groups");
  }
}

const groupNameSchema = z.string().trim().min(1).max(64);

/** List every group defined for the active club (all clubs the caller
 *  can read); ordered by sortOrder then name. Read-only. */
export async function listMemberGroups(clubId: string) {
  return prisma.memberGroup.findMany({
    where: { clubId },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}

/** Get the current group assignments for one member, joined with the
 *  group row so the UI can render name + display order. */
export async function listAssignmentsForMember(memberId: string) {
  return prisma.memberGroupAssignment.findMany({
    where: { memberId },
    include: { group: true },
    orderBy: [{ group: { sortOrder: "asc" } }, { group: { name: "asc" } }],
  });
}

/** Idempotently ensure a MemberGroup exists in the given club by name,
 *  returning the row. Used by both `assignGroupByName` (add-new UX
 *  path) and by seeds. */
async function upsertGroupByName(clubId: string, name: string) {
  const trimmed = groupNameSchema.parse(name);
  return prisma.memberGroup.upsert({
    where: { clubId_name: { clubId, name: trimmed } },
    create: { clubId, name: trimmed },
    update: {},
  });
}

/** Assign a member to a group by name — the group is created lazily
 *  if it does not yet exist in the club. Duplicate assignments are
 *  a no-op (returns the existing row). */
export async function assignGroupByName(
  principal: Principal,
  memberId: string,
  rawName: string,
) {
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  assertTenantOwned(member, principal);
  requireAdmin(principal, member.clubId);
  const name = groupNameSchema.safeParse(rawName);
  if (!name.success) {
    throw new ValidationError(name.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const group = await upsertGroupByName(member.clubId, name.data);
  const existing = await prisma.memberGroupAssignment.findUnique({
    where: { memberId_groupId: { memberId, groupId: group.id } },
  });
  if (existing) return existing;
  const assignment = await prisma.memberGroupAssignment.create({
    data: {
      clubId: member.clubId,
      memberId,
      groupId: group.id,
      assignedByUserId: principal.id,
    },
  });
  await audit(principal, {
    action: "member.group.assign",
    entityType: "MemberGroupAssignment",
    entityId: assignment.id,
    clubId: member.clubId,
    after: { memberId, groupId: group.id, name: group.name },
  });
  return assignment;
}

/** Remove a member's assignment to a group. Idempotent: removing a
 *  group the member is not in returns null. */
export async function removeGroupAssignment(
  principal: Principal,
  memberId: string,
  groupId: string,
) {
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  assertTenantOwned(member, principal);
  requireAdmin(principal, member.clubId);
  const assignment = await prisma.memberGroupAssignment.findUnique({
    where: { memberId_groupId: { memberId, groupId } },
    include: { group: true },
  });
  if (!assignment) return null;
  if (assignment.clubId !== member.clubId) {
    // Should be impossible via the compound unique, but guard the tenant
    // boundary defensively.
    throw new NotFoundError("MemberGroupAssignment", assignment.id);
  }
  await prisma.memberGroupAssignment.delete({ where: { id: assignment.id } });
  await audit(principal, {
    action: "member.group.remove",
    entityType: "MemberGroupAssignment",
    entityId: assignment.id,
    clubId: member.clubId,
    before: { memberId, groupId, name: assignment.group.name },
  });
  return assignment;
}
