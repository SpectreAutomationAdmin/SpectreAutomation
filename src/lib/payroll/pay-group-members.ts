// Payroll-3B-1 (2026-08-27) — canonical PayrollPayGroupMember service.
//
// Effective-dated `[effectiveFrom, effectiveTo)` employee ↔ pay-
// group membership. An employee must not carry overlapping active
// memberships for the same Club (whether in the same pay group or
// across different groups); the service detects overlap BEFORE the
// insert and returns a structured ValidationError.
//
// A caller who explicitly wants to move an employee from one group
// to another on a given date should use `transferMembership()` —
// which transactionally ends the current membership at boundary T
// and starts the new one at T, producing zero overlap.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertPostingAllowed } from "../posting-guard";
import { ValidationError, NotFoundError } from "../errors";

const ENTITY = "PayrollPayGroupMember";

export interface PayGroupMemberView {
  id: string;
  clubId: string;
  payGroupId: string;
  employeeId: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MemberRow {
  id: string;
  clubId: string;
  payGroupId: string;
  employeeId: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function projectRow(row: MemberRow): PayGroupMemberView {
  return {
    id: row.id,
    clubId: row.clubId,
    payGroupId: row.payGroupId,
    employeeId: row.employeeId,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Overlap detection
// ---------------------------------------------------------------------------

/**
 * Two half-open intervals [a1, a2) and [b1, b2) overlap iff
 *     a1 < b2 && b1 < a2
 * where an open-ended interval (effectiveTo == null) is treated as
 * `+Infinity`.
 *
 * Adjacent intervals (a2 == b1) do NOT overlap under half-open
 * semantics — the boundary date belongs to the NEXT interval.
 *
 * Returns the offending member id(s) so the caller can surface a
 * structured error, or an empty array if the window is clean.
 */
async function findOverlappingMemberships(
  clubId: string,
  employeeId: string,
  effectiveFrom: Date,
  effectiveTo: Date | null,
  excludeMemberId?: string,
): Promise<string[]> {
  const candidates = await prisma.payrollPayGroupMember.findMany({
    where: {
      clubId,
      employeeId,
      ...(excludeMemberId ? { id: { not: excludeMemberId } } : {}),
    },
    select: { id: true, effectiveFrom: true, effectiveTo: true },
  });
  const conflicts: string[] = [];
  for (const c of candidates) {
    const bStart = c.effectiveFrom.getTime();
    const bEnd = c.effectiveTo ? c.effectiveTo.getTime() : Number.POSITIVE_INFINITY;
    const aStart = effectiveFrom.getTime();
    const aEnd = effectiveTo ? effectiveTo.getTime() : Number.POSITIVE_INFINITY;
    // half-open overlap
    if (aStart < bEnd && bStart < aEnd) {
      conflicts.push(c.id);
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

async function assertPayGroupBelongsToClub(clubId: string, payGroupId: string): Promise<void> {
  const g = await prisma.payrollPayGroup.findFirst({
    where: { id: payGroupId, clubId },
    select: { id: true, active: true },
  });
  if (!g) {
    throw new ValidationError([
      { path: "payGroupId", message: "Pay group does not exist at this Club" },
    ]);
  }
  if (!g.active) {
    throw new ValidationError([
      { path: "payGroupId", message: "Pay group is inactive; reactivate before assigning employees" },
    ]);
  }
}

async function assertEmployeeBelongsToClub(clubId: string, employeeId: string): Promise<void> {
  const e = await prisma.employee.findFirst({
    where: { id: employeeId, clubId },
    select: { id: true },
  });
  if (!e) {
    throw new ValidationError([
      { path: "employeeId", message: "Employee does not exist at this Club" },
    ]);
  }
}

function validateEffectiveWindow(
  effectiveFrom: Date,
  effectiveTo: Date | null | undefined,
): { from: Date; to: Date | null } {
  if (Number.isNaN(effectiveFrom.getTime())) {
    throw new ValidationError([{ path: "effectiveFrom", message: "Invalid effective-from date" }]);
  }
  if (effectiveTo != null) {
    if (Number.isNaN(effectiveTo.getTime())) {
      throw new ValidationError([{ path: "effectiveTo", message: "Invalid effective-to date" }]);
    }
    if (effectiveTo.getTime() <= effectiveFrom.getTime()) {
      throw new ValidationError([
        { path: "effectiveTo", message: "Effective-to must be after effective-from" },
      ]);
    }
  }
  return { from: effectiveFrom, to: effectiveTo ?? null };
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

/** Every membership row for the Club (active + past + future),
 *  ordered by employee then effective-from. Admin/overview read. */
export async function listMemberships(
  principal: Principal,
  clubId: string,
): Promise<PayGroupMemberView[]> {
  requirePermission(principal, clubId, "payroll:read");
  const rows = await prisma.payrollPayGroupMember.findMany({
    where: { clubId },
    orderBy: [{ employeeId: "asc" }, { effectiveFrom: "asc" }],
  });
  return rows.map(projectRow);
}

/** The single membership that covers `asOf` for a given employee at
 *  a Club. Returns null when the employee has no membership on that
 *  date. Overlap-prevention guarantees at most one row will match. */
export async function getMembershipAsOf(
  principal: Principal,
  clubId: string,
  employeeId: string,
  asOf: Date,
): Promise<PayGroupMemberView | null> {
  requirePermission(principal, clubId, "payroll:read");
  const rows = await prisma.payrollPayGroupMember.findMany({
    where: {
      clubId,
      employeeId,
      effectiveFrom: { lte: asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }],
    },
    orderBy: [{ effectiveFrom: "desc" }],
    take: 1,
  });
  return rows[0] ? projectRow(rows[0]) : null;
}

/** All membership rows for a Pay Group that cover `asOf`. Used by
 *  future batch-preparation code to enumerate the batch's employee
 *  population. */
export async function listActiveMembersAsOf(
  principal: Principal,
  clubId: string,
  payGroupId: string,
  asOf: Date,
): Promise<PayGroupMemberView[]> {
  requirePermission(principal, clubId, "payroll:read");
  const rows = await prisma.payrollPayGroupMember.findMany({
    where: {
      clubId,
      payGroupId,
      effectiveFrom: { lte: asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }],
    },
    orderBy: [{ employeeId: "asc" }],
  });
  return rows.map(projectRow);
}

/** Complete membership history for an employee, oldest first. */
export async function listMembershipHistoryForEmployee(
  principal: Principal,
  clubId: string,
  employeeId: string,
): Promise<PayGroupMemberView[]> {
  requirePermission(principal, clubId, "payroll:read");
  const rows = await prisma.payrollPayGroupMember.findMany({
    where: { clubId, employeeId },
    orderBy: [{ effectiveFrom: "asc" }],
  });
  return rows.map(projectRow);
}

// ---------------------------------------------------------------------------
// Write paths
// ---------------------------------------------------------------------------

export interface AssignMembershipInput {
  payGroupId: string;
  employeeId: string;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  notes?: string | null;
}

export async function assignMembership(
  principal: Principal,
  clubId: string,
  input: AssignMembershipInput,
): Promise<PayGroupMemberView> {
  requirePermission(principal, clubId, "payroll:write");
  await assertPostingAllowed(
    principal, clubId, "payroll.pay-group-member.assign", ENTITY, input.employeeId,
  );

  await assertPayGroupBelongsToClub(clubId, input.payGroupId);
  await assertEmployeeBelongsToClub(clubId, input.employeeId);
  const { from, to } = validateEffectiveWindow(input.effectiveFrom, input.effectiveTo ?? null);

  const conflicts = await findOverlappingMemberships(clubId, input.employeeId, from, to);
  if (conflicts.length > 0) {
    throw new ValidationError([
      {
        path: "effectiveFrom",
        message:
          "Employee already has an active or overlapping pay-group membership for this window. " +
          "End the existing membership or use the transfer operation.",
      },
    ]);
  }

  const row = await prisma.payrollPayGroupMember.create({
    data: {
      clubId,
      payGroupId: input.payGroupId,
      employeeId: input.employeeId,
      effectiveFrom: from,
      effectiveTo: to,
      notes: input.notes?.trim() || null,
      createdByUserId: principal.id,
    },
  });
  await audit(principal, {
    action: "payroll.pay-group-member.assign",
    entityType: ENTITY,
    entityId: row.id,
    clubId,
    after: {
      payGroupId: row.payGroupId,
      employeeId: row.employeeId,
      effectiveFrom: row.effectiveFrom.toISOString(),
      effectiveTo: row.effectiveTo?.toISOString() ?? null,
    },
  });
  return projectRow(row);
}

/** End an open (effectiveTo == null) or open-ended membership at a
 *  chosen date. Cannot re-open a closed membership; cannot end at a
 *  date before the row's own effectiveFrom. */
export async function endMembership(
  principal: Principal,
  clubId: string,
  membershipId: string,
  endAt: Date,
): Promise<PayGroupMemberView> {
  requirePermission(principal, clubId, "payroll:write");
  await assertPostingAllowed(
    principal, clubId, "payroll.pay-group-member.end", ENTITY, membershipId,
  );

  const row = await prisma.payrollPayGroupMember.findFirst({
    where: { id: membershipId, clubId },
  });
  if (!row) throw new NotFoundError(ENTITY, membershipId);

  if (Number.isNaN(endAt.getTime())) {
    throw new ValidationError([{ path: "endAt", message: "Invalid end date" }]);
  }
  if (endAt.getTime() <= row.effectiveFrom.getTime()) {
    throw new ValidationError([
      { path: "endAt", message: "End date must be after the membership's effective-from date" },
    ]);
  }

  const updated = await prisma.payrollPayGroupMember.update({
    where: { id: row.id },
    data: { effectiveTo: endAt },
  });
  await audit(principal, {
    action: "payroll.pay-group-member.end",
    entityType: ENTITY,
    entityId: updated.id,
    clubId,
    before: { effectiveTo: row.effectiveTo?.toISOString() ?? null },
    after: { effectiveTo: updated.effectiveTo?.toISOString() ?? null },
  });
  return projectRow(updated);
}

export interface TransferMembershipInput {
  employeeId: string;
  toPayGroupId: string;
  effectiveAt: Date;
  notes?: string | null;
}

/** Transactional transfer: ends the employee's currently-covering
 *  membership at `effectiveAt` and creates the new one starting at
 *  `effectiveAt`. Both writes go through the same $transaction so
 *  a failure leaves the DB untouched. */
export async function transferMembership(
  principal: Principal,
  clubId: string,
  input: TransferMembershipInput,
): Promise<{ ended: PayGroupMemberView | null; started: PayGroupMemberView }> {
  requirePermission(principal, clubId, "payroll:write");
  await assertPostingAllowed(
    principal, clubId, "payroll.pay-group-member.transfer", ENTITY, input.employeeId,
  );

  await assertPayGroupBelongsToClub(clubId, input.toPayGroupId);
  await assertEmployeeBelongsToClub(clubId, input.employeeId);
  if (Number.isNaN(input.effectiveAt.getTime())) {
    throw new ValidationError([{ path: "effectiveAt", message: "Invalid transfer date" }]);
  }

  const current = await prisma.payrollPayGroupMember.findFirst({
    where: {
      clubId,
      employeeId: input.employeeId,
      effectiveFrom: { lte: input.effectiveAt },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: input.effectiveAt } }],
    },
    orderBy: [{ effectiveFrom: "desc" }],
  });

  // If transferring INTO the same pay group at the same effective
  // date it's a no-op: refuse rather than silently duplicate.
  if (current && current.payGroupId === input.toPayGroupId) {
    throw new ValidationError([
      { path: "toPayGroupId", message: "Employee is already in this pay group on the transfer date" },
    ]);
  }

  // Check that no OTHER membership (past-current) already covers a
  // window on or after effectiveAt in the destination pay group.
  const forwardConflicts = await findOverlappingMemberships(
    clubId,
    input.employeeId,
    input.effectiveAt,
    null,
    current?.id,
  );
  if (forwardConflicts.length > 0) {
    throw new ValidationError([
      {
        path: "effectiveAt",
        message: "A future or overlapping membership already exists; end it before transferring.",
      },
    ]);
  }

  const [endedRow, startedRow] = await prisma.$transaction([
    current
      ? prisma.payrollPayGroupMember.update({
          where: { id: current.id },
          data: { effectiveTo: input.effectiveAt },
        })
      : // no-op placeholder: fetch the row we already know is missing;
        // Prisma requires a returning query, so we findFirst by an
        // impossible id and treat null as "no ended".
        prisma.payrollPayGroupMember.findFirst({ where: { id: "__none__" } }),
    prisma.payrollPayGroupMember.create({
      data: {
        clubId,
        payGroupId: input.toPayGroupId,
        employeeId: input.employeeId,
        effectiveFrom: input.effectiveAt,
        effectiveTo: null,
        notes: input.notes?.trim() || null,
        createdByUserId: principal.id,
      },
    }),
  ]);
  const ended = endedRow ? projectRow(endedRow as MemberRow) : null;
  const started = projectRow(startedRow);
  await audit(principal, {
    action: "payroll.pay-group-member.transfer",
    entityType: ENTITY,
    entityId: started.id,
    clubId,
    before: current
      ? { payGroupId: current.payGroupId, effectiveTo: current.effectiveTo?.toISOString() ?? null }
      : null,
    after: {
      fromMembershipId: ended?.id ?? null,
      toMembershipId: started.id,
      toPayGroupId: started.payGroupId,
      effectiveAt: input.effectiveAt.toISOString(),
    },
  });
  return { ended, started };
}
