// Governance — Board & Committees roster service.
//
// CRUD + date-aware status resolution for `BoardRole` rows. Board
// roles are PERSON-specific, TERM-specific governance records —
// distinct from Club Settings (club-wide config) and from
// UserClubRole (permission grants). One Member can accumulate
// multiple BoardRole rows over their career.
//
// Live "is this user on the board today?" checks consult the
// date-aware `effectiveBoardStatus` so the access surface tracks
// term-start / term-end without operator intervention. The stored
// `status` field is honored only to let the controller revoke
// access early (set EXPIRED before termEndDate).
//
// AGM compatibility: the `source` field tags how a row was
// created (MANUAL | AGM_ELECTION). A future AGM module writes
// AGM_ELECTION rows for successful candidates with status=UPCOMING
// and termStartDate = AGM_DATE + 1 day; this service treats them
// identically to manual entries.

import { audit } from "../audit";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../errors";
import { prisma } from "../prisma";
import {
  isSuperAdmin,
  requirePermission,
  type Principal,
} from "../rbac";

// ---------------------------------------------------------------------------
// Status + permission gate
// ---------------------------------------------------------------------------
//
// Pure constants + types live in `./board-roles-data` so client
// components can import them without dragging the server-only
// audit + request-context graph through their bundle. The service
// module re-exports for back-compat.

import {
  BOARD_ROLE_SOURCES,
  BOARD_ROLE_STATUSES,
  type BoardRoleSource,
  type BoardRoleStatus,
} from "./board-roles-data";

export {
  BOARD_ROLE_STATUSES,
  BOARD_ROLE_SOURCES,
  BOARD_ROLE_TITLES,
  type BoardRoleStatus,
  type BoardRoleSource,
} from "./board-roles-data";

// Board roster management uses `packages:write` — the same perm
// the rest of the governance write-surface uses. BOARD_READ_ONLY
// doesn't have it, which keeps board members from editing the
// roster they're on.
function ensureBoardWrite(principal: Principal, clubId: string): void {
  if (isSuperAdmin(principal)) return;
  requirePermission(principal, clubId, "packages:write");
}

function ensureBoardRead(principal: Principal, clubId: string): void {
  if (isSuperAdmin(principal)) return;
  requirePermission(principal, clubId, "packages:read");
}

// ---------------------------------------------------------------------------
// Date-aware effective status
// ---------------------------------------------------------------------------

export type EffectiveBoardStatusInput = {
  status: string;
  termStartDate: Date;
  termEndDate: Date;
};

/**
 * Resolve a BoardRole's effective status against the current date.
 *
 *   1. EXPIRED stored → EXPIRED (controller manually revoked).
 *   2. termStartDate > now → UPCOMING (AGM-elected member waiting
 *      for term start).
 *   3. termEndDate   < now → EXPIRED (term lapsed naturally).
 *   4. otherwise           → ACTIVE.
 *
 * `now` defaults to `new Date()` but is overridable so the date-
 * machine tests can pin the clock.
 */
export function effectiveBoardStatus(
  row: EffectiveBoardStatusInput,
  now: Date = new Date(),
): BoardRoleStatus {
  if (row.status === "EXPIRED") return "EXPIRED";
  const nowMs = now.getTime();
  if (row.termStartDate.getTime() > nowMs) return "UPCOMING";
  if (row.termEndDate.getTime() < nowMs) return "EXPIRED";
  return "ACTIVE";
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateAssignInput(args: {
  memberId: string;
  roleTitle: string;
  termStartDate: Date;
  termEndDate: Date;
  status?: string;
  source?: string;
}): void {
  const issues: Array<{ path: string; message: string }> = [];
  if (!args.memberId) issues.push({ path: "memberId", message: "memberId is required" });
  if (!args.roleTitle || args.roleTitle.trim().length === 0) {
    issues.push({ path: "roleTitle", message: "roleTitle is required" });
  }
  if (!(args.termStartDate instanceof Date) || Number.isNaN(args.termStartDate.getTime())) {
    issues.push({ path: "termStartDate", message: "termStartDate must be a valid Date" });
  }
  if (!(args.termEndDate instanceof Date) || Number.isNaN(args.termEndDate.getTime())) {
    issues.push({ path: "termEndDate", message: "termEndDate must be a valid Date" });
  }
  if (
    args.termStartDate instanceof Date &&
    args.termEndDate instanceof Date &&
    args.termStartDate.getTime() > args.termEndDate.getTime()
  ) {
    issues.push({
      path: "termEndDate",
      message: "termEndDate must be on or after termStartDate",
    });
  }
  if (args.status && !BOARD_ROLE_STATUSES.includes(args.status as BoardRoleStatus)) {
    issues.push({ path: "status", message: `status must be one of ${BOARD_ROLE_STATUSES.join(", ")}` });
  }
  if (args.source && !BOARD_ROLE_SOURCES.includes(args.source as BoardRoleSource)) {
    issues.push({ path: "source", message: `source must be one of ${BOARD_ROLE_SOURCES.join(", ")}` });
  }
  if (issues.length > 0) throw new ValidationError(issues);
}

async function assertMemberOwnedByClub(memberId: string, clubId: string): Promise<void> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { clubId: true },
  });
  if (!member) throw new NotFoundError("Member", memberId);
  if (member.clubId !== clubId) {
    throw new ConflictError("Member does not belong to this club.");
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export type AssignBoardRoleArgs = {
  clubId: string;
  memberId: string;
  roleTitle: string;
  committeeName?: string | null;
  termStartDate: Date;
  termEndDate: Date;
  /** Defaults to UPCOMING; the date-aware resolver flips it to
   *  ACTIVE once termStartDate <= now. */
  status?: BoardRoleStatus;
  /** Defaults to MANUAL. AGM module passes AGM_ELECTION. */
  source?: BoardRoleSource;
};

export async function assignBoardRole(
  principal: Principal,
  args: AssignBoardRoleArgs,
) {
  ensureBoardWrite(principal, args.clubId);
  validateAssignInput(args);
  await assertMemberOwnedByClub(args.memberId, args.clubId);

  const row = await prisma.boardRole.create({
    data: {
      clubId: args.clubId,
      memberId: args.memberId,
      roleTitle: args.roleTitle.trim(),
      committeeName: args.committeeName?.trim() || null,
      termStartDate: args.termStartDate,
      termEndDate: args.termEndDate,
      status: args.status ?? "UPCOMING",
      source: args.source ?? "MANUAL",
    },
  });
  await audit(principal, {
    action: "governance.board-role.assign",
    entityType: "BoardRole",
    entityId: row.id,
    clubId: args.clubId,
    after: {
      memberId: row.memberId,
      roleTitle: row.roleTitle,
      committeeName: row.committeeName,
      termStartDate: row.termStartDate.toISOString().slice(0, 10),
      termEndDate: row.termEndDate.toISOString().slice(0, 10),
      status: row.status,
      source: row.source,
    },
  });
  return row;
}

export type UpdateBoardRoleArgs = Partial<{
  roleTitle: string;
  committeeName: string | null;
  termStartDate: Date;
  termEndDate: Date;
  status: BoardRoleStatus;
}>;

export async function updateBoardRole(
  principal: Principal,
  roleId: string,
  patch: UpdateBoardRoleArgs,
) {
  const existing = await prisma.boardRole.findUnique({
    where: { id: roleId },
    select: { id: true, clubId: true, memberId: true, termStartDate: true, termEndDate: true },
  });
  if (!existing) throw new NotFoundError("BoardRole", roleId);
  ensureBoardWrite(principal, existing.clubId);

  // Re-validate the resulting term window if either bound moved.
  const start = patch.termStartDate ?? existing.termStartDate;
  const end = patch.termEndDate ?? existing.termEndDate;
  if (start.getTime() > end.getTime()) {
    throw new ValidationError([
      { path: "termEndDate", message: "termEndDate must be on or after termStartDate" },
    ]);
  }
  if (patch.status && !BOARD_ROLE_STATUSES.includes(patch.status)) {
    throw new ValidationError([{ path: "status", message: "invalid status" }]);
  }
  if (patch.roleTitle !== undefined && patch.roleTitle.trim().length === 0) {
    throw new ValidationError([{ path: "roleTitle", message: "roleTitle cannot be empty" }]);
  }

  const updated = await prisma.boardRole.update({
    where: { id: roleId },
    data: {
      ...(patch.roleTitle !== undefined ? { roleTitle: patch.roleTitle.trim() } : {}),
      ...(patch.committeeName !== undefined ? { committeeName: patch.committeeName?.trim() || null } : {}),
      ...(patch.termStartDate !== undefined ? { termStartDate: patch.termStartDate } : {}),
      ...(patch.termEndDate !== undefined ? { termEndDate: patch.termEndDate } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    },
  });
  await audit(principal, {
    action: "governance.board-role.update",
    entityType: "BoardRole",
    entityId: updated.id,
    clubId: updated.clubId,
    after: {
      roleTitle: updated.roleTitle,
      committeeName: updated.committeeName,
      termStartDate: updated.termStartDate.toISOString().slice(0, 10),
      termEndDate: updated.termEndDate.toISOString().slice(0, 10),
      status: updated.status,
    },
  });
  return updated;
}

export async function deleteBoardRole(
  principal: Principal,
  roleId: string,
): Promise<{ deleted: true; roleId: string }> {
  const existing = await prisma.boardRole.findUnique({
    where: { id: roleId },
    select: { id: true, clubId: true, memberId: true, roleTitle: true, status: true },
  });
  if (!existing) throw new NotFoundError("BoardRole", roleId);
  ensureBoardWrite(principal, existing.clubId);

  await prisma.boardRole.delete({ where: { id: roleId } });
  await audit(principal, {
    action: "governance.board-role.delete",
    entityType: "BoardRole",
    entityId: roleId,
    clubId: existing.clubId,
    before: {
      memberId: existing.memberId,
      roleTitle: existing.roleTitle,
      status: existing.status,
    },
  });
  return { deleted: true, roleId };
}

// ---------------------------------------------------------------------------
// Read surface — admin list
// ---------------------------------------------------------------------------

export type BoardRosterRow = {
  id: string;
  memberId: string;
  memberName: string;
  memberNumber: string;
  email: string;
  roleTitle: string;
  committeeName: string | null;
  termStartDate: Date;
  termEndDate: Date;
  /** Stored status (raw). */
  status: BoardRoleStatus;
  /** Date-aware status — what the runtime gates use. */
  effectiveStatus: BoardRoleStatus;
  source: BoardRoleSource;
  createdAt: Date;
};

export async function listBoardRoster(
  principal: Principal,
  clubId: string,
  opts?: { now?: Date },
): Promise<BoardRosterRow[]> {
  ensureBoardRead(principal, clubId);
  const rows = await prisma.boardRole.findMany({
    where: { clubId },
    orderBy: [{ termStartDate: "desc" }, { createdAt: "desc" }],
    include: {
      member: {
        select: { id: true, firstName: true, lastName: true, memberNumber: true, email: true },
      },
    },
  });
  const now = opts?.now ?? new Date();
  return rows.map((r) => ({
    id: r.id,
    memberId: r.memberId,
    memberName: `${r.member.firstName} ${r.member.lastName}`.trim(),
    memberNumber: r.member.memberNumber,
    email: r.member.email,
    roleTitle: r.roleTitle,
    committeeName: r.committeeName,
    termStartDate: r.termStartDate,
    termEndDate: r.termEndDate,
    status: r.status as BoardRoleStatus,
    effectiveStatus: effectiveBoardStatus(
      { status: r.status, termStartDate: r.termStartDate, termEndDate: r.termEndDate },
      now,
    ),
    source: r.source as BoardRoleSource,
    createdAt: r.createdAt,
  }));
}

// ---------------------------------------------------------------------------
// Access integration — used by board-only surfaces
// ---------------------------------------------------------------------------

/**
 * True when the given user holds an effectively-ACTIVE BoardRole at
 * the club today (i.e. termStartDate <= now <= termEndDate AND
 * stored status !== EXPIRED). The check resolves the user's member
 * record first; users without a linked member can never qualify.
 *
 * Consumed by the Monthly Reporting Package board surfaces:
 *   • dashboard tile visibility
 *   • board view authorisation
 * to grant access to members who are board members today, in
 * addition to anyone holding the BOARD_READ_ONLY role.
 *
 * Returns false (never throws) when the user has no member link or
 * no active BoardRole — that's the expected case for non-board
 * users.
 */
export async function isActiveBoardMember(
  principal: Principal,
  clubId: string,
  opts?: { now?: Date },
): Promise<boolean> {
  // Resolve principal → user.memberId. The principal carries the
  // user id directly.
  const user = await prisma.user.findUnique({
    where: { id: principal.id },
    select: { memberId: true },
  });
  if (!user?.memberId) return false;

  const now = opts?.now ?? new Date();
  // Cheap query: find any non-EXPIRED row covering today.
  const row = await prisma.boardRole.findFirst({
    where: {
      clubId,
      memberId: user.memberId,
      status: { not: "EXPIRED" },
      termStartDate: { lte: now },
      termEndDate: { gte: now },
    },
    select: { id: true },
  });
  return row !== null;
}
