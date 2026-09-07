// Scheduling Foundation (2026-09-07) — give-up-shift offer lifecycle.
//
// Founder amendment §8: the offering employee's ShiftAssignment
// remains in state ASSIGNED while an opportunity is OPEN. Only a
// successful pickup atomically transitions original ASSIGNED →
// REPLACED and creates the claimant's new ASSIGNED — that flow lives
// in shift-pickup.ts.
//
// Founder amendment §12: FORE! surfaces the OPEN opportunities to
// ELIGIBLE coworkers only. Eligibility is a defence-in-depth server
// check — never rely on hidden UI (§20).

import { prisma } from "../prisma";
import { ValidationError, NotFoundError, ForbiddenError, ConflictError } from "../errors";
import { isSchedulingEligible } from "../hr/scheduling-eligibility";

export interface OfferShiftInput {
  clubId: string;
  employeeId: string;              // must own the ShiftAssignment
  shiftAssignmentId: string;
  reason?: string | null;
  note?: string | null;
  /** Optional expiry — otherwise stays OPEN until claimed / withdrawn / shift starts. */
  expiresAt?: Date | null;
}

export interface OfferShiftResult {
  opportunityId: string;
  shiftId: string;
  state: "OPEN";
}

/**
 * Offer an ASSIGNED future shift up to eligible coworkers. Creates
 * a ShiftOpportunity in state OPEN. The employee's assignment stays
 * ASSIGNED (they remain responsible for the shift until a successful
 * pickup completes — see shift-pickup.ts).
 *
 * Concurrency: the DB partial-unique index
 *   UNIQUE (clubId, shiftId) WHERE state='OPEN'
 * prevents double-offer. A second call while an OPEN opportunity
 * exists throws ConflictError.
 */
export async function offerShift(input: OfferShiftInput): Promise<OfferShiftResult> {
  const assignment = await prisma.shiftAssignment.findUnique({
    where: { id: input.shiftAssignmentId },
    include: {
      shift: {
        select: { id: true, clubId: true, startAt: true, state: true },
      },
    },
  });
  if (!assignment) throw new NotFoundError("ShiftAssignment", input.shiftAssignmentId);
  if (assignment.clubId !== input.clubId) {
    throw new NotFoundError("ShiftAssignment", input.shiftAssignmentId);
  }
  if (assignment.employeeId !== input.employeeId) {
    throw new ForbiddenError("You may only offer up shifts you are personally assigned to.");
  }
  if (assignment.state !== "ASSIGNED") {
    throw new ValidationError([{
      path: "shiftAssignmentId",
      message: `Assignment is not ASSIGNED (current state: ${assignment.state}).`,
    }]);
  }
  if (assignment.shift.state !== "PUBLISHED") {
    throw new ValidationError([{
      path: "shift",
      message: "The parent shift is not published.",
    }]);
  }
  const now = new Date();
  if (assignment.shift.startAt.getTime() <= now.getTime()) {
    throw new ValidationError([{
      path: "shift",
      message: "Past shifts cannot be offered up.",
    }]);
  }

  try {
    const created = await prisma.shiftOpportunity.create({
      data: {
        clubId: input.clubId,
        shiftId: assignment.shift.id,
        offeredByEmployeeId: input.employeeId,
        offeredByAssignmentId: assignment.id,
        state: "OPEN",
        reason: (input.reason ?? "").trim() || null,
        note: (input.note ?? "").trim() || null,
        expiresAt: input.expiresAt ?? null,
        offeredAt: now,
      },
      select: { id: true, shiftId: true },
    });
    return { opportunityId: created.id, shiftId: created.shiftId, state: "OPEN" };
  } catch (e: unknown) {
    const err = e as { code?: string };
    if (err.code === "P2002") {
      throw new ConflictError("This shift already has an OPEN opportunity — withdraw the existing one first.");
    }
    throw e;
  }
}

/**
 * Withdraw an OPEN opportunity — flips state to WITHDRAWN. Only the
 * offering employee (or a caller passing withdrawnByUserId
 * separately) may withdraw. The associated ShiftAssignment is never
 * touched (it was never disturbed by the offer).
 */
export async function withdrawOpportunity(input: {
  clubId: string;
  employeeId: string;
  opportunityId: string;
  withdrawnByUserId?: string | null;
}): Promise<void> {
  const opp = await prisma.shiftOpportunity.findUnique({
    where: { id: input.opportunityId },
    select: {
      id: true, clubId: true, offeredByEmployeeId: true, state: true,
    },
  });
  if (!opp || opp.clubId !== input.clubId) {
    throw new NotFoundError("ShiftOpportunity", input.opportunityId);
  }
  if (opp.offeredByEmployeeId !== input.employeeId) {
    throw new ForbiddenError("You may only withdraw opportunities you offered.");
  }
  if (opp.state !== "OPEN") {
    // Already handled by another path — idempotent no-op.
    return;
  }
  // CAS transition: if a race lost this to CLAIMED between our read
  // and write, count=0 → no-op (informational; caller retries).
  await prisma.shiftOpportunity.updateMany({
    where: { id: opp.id, state: "OPEN" },
    data: {
      state: "WITHDRAWN",
      withdrawnAt: new Date(),
      withdrawnByUserId: input.withdrawnByUserId ?? null,
    },
  });
}

export interface EligibleOpportunityRow {
  id: string;
  shiftId: string;
  shiftDate: Date;
  startAt: Date;
  endAt: Date;
  departmentId: string;
  departmentCode: string;
  departmentName: string;
  templateCode: string;
  templateName: string;
  positionId: string | null;
  positionName: string | null;
  offeredAt: Date;
  reason: string | null;
  note: string | null;
  expiresAt: Date | null;
}

/**
 * List the OPEN opportunities the given employee is eligible to
 * claim. Server-side check (§20 tenant isolation): filters by
 * (1) same club (2) OPEN state (3) shift's future start (4) offering
 * employee != this employee (5) an ACTIVE EmployeeEmploymentAssignment
 * exists for this employee in the shift's department (6) employee is
 * scheduling-eligible (training complete).
 *
 * NOTE: does not currently filter by conflicting overlapping shifts.
 * The pickup transaction re-checks the ASSIGNED partial-unique at
 * commit time; if the claimant already had an overlapping ASSIGNED
 * shift the pickup completes but the operator should surface the
 * overlap in the UI. A future enhancement narrows this list further.
 */
export async function listEligibleOpportunitiesForEmployee(
  clubId: string, employeeId: string,
): Promise<EligibleOpportunityRow[]> {
  const eligible = await isSchedulingEligible(employeeId);
  if (!eligible) return [];

  const now = new Date();
  const activeAssignments = await prisma.employeeEmploymentAssignment.findMany({
    where: {
      clubId, employeeId,
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      departmentId: { not: null },
    },
    select: { departmentId: true },
  });
  const departmentIds = Array.from(new Set(
    activeAssignments.map((a) => a.departmentId).filter((d): d is string => !!d),
  ));
  if (!departmentIds.length) return [];

  const rows = await prisma.shiftOpportunity.findMany({
    where: {
      clubId, state: "OPEN",
      offeredByEmployeeId: { not: employeeId },
      shift: {
        state: "PUBLISHED",
        startAt: { gt: now },
        departmentId: { in: departmentIds },
      },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { shift: { startAt: "asc" } },
    include: {
      shift: {
        include: {
          department: { select: { id: true, code: true, name: true } },
          shiftTemplate: { select: { code: true, name: true } },
          position: { select: { id: true, name: true } },
        },
      },
    },
  });
  return rows.map((o) => ({
    id: o.id,
    shiftId: o.shiftId,
    shiftDate: o.shift.shiftDate,
    startAt: o.shift.startAt,
    endAt: o.shift.endAt,
    departmentId: o.shift.department.id,
    departmentCode: o.shift.department.code,
    departmentName: o.shift.department.name,
    templateCode: o.shift.shiftTemplate.code,
    templateName: o.shift.shiftTemplate.name,
    positionId: o.shift.position?.id ?? null,
    positionName: o.shift.position?.name ?? null,
    offeredAt: o.offeredAt,
    reason: o.reason,
    note: o.note,
    expiresAt: o.expiresAt,
  }));
}

/** Count of OPEN opportunities visible to this employee — used for
 *  the restrained homepage FORE! card indicator (§5 amendment). */
export async function countEligibleOpportunitiesForEmployee(
  clubId: string, employeeId: string,
): Promise<number> {
  const rows = await listEligibleOpportunitiesForEmployee(clubId, employeeId);
  return rows.length;
}
