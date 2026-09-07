// Scheduling Foundation (2026-09-07) — atomic shift-pickup CAS.
//
// Founder amendment §7: no manager approval by default. If the
// receiving employee is eligible (same tenant + appropriate
// department + role + active + training complete + no overlap), the
// pickup completes atomically. A manager Work Intake notification
// is emitted AFTER a successful reassignment — see
// shift-reassignment-notification.ts.
//
// Concurrency contract (two safety nets — one is enough, we keep both
// for defence in depth):
//
//   1. ShiftOpportunity CAS
//      UPDATE ShiftOpportunity SET state='CLAIMED', claimedBy...
//      WHERE id = X AND state = 'OPEN'
//      If updateMany returns count=0, another claimant won the race
//      → throw ConflictError → tx rolls back.
//
//   2. ShiftAssignment partial-unique
//      UNIQUE (clubId, shiftId) WHERE state='ASSIGNED'
//      Prevents inserting a second ASSIGNED row for the same shift
//      even if step 1 somehow admitted two winners. On P2002 →
//      ConflictError → tx rolls back.
//
// The transaction body:
//   1. Read the opportunity + its original assignment inside the tx.
//   2. Validate claimant eligibility (defensive — the FORE! filter
//      already excluded them, but a manual pickup by id must still
//      be safe).
//   3. CAS the opportunity (updateMany count=1 or throw).
//   4. CAS the original ShiftAssignment ASSIGNED → REPLACED
//      (updateMany count=1 or throw — indicates another mutator
//      already released the assignment).
//   5. INSERT the claimant's new ShiftAssignment (state='ASSIGNED');
//      P2002 on the partial-unique = another concurrent claim inserted
//      an ASSIGNED row → throw ConflictError.
//   6. Link the replaced row's replacedByAssignmentId → new row.

import { prisma } from "../prisma";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { isSchedulingEligible } from "../hr/scheduling-eligibility";

export interface PickUpShiftInput {
  clubId: string;
  employeeId: string;    // claimant
  opportunityId: string;
}

export interface PickUpShiftResult {
  opportunityId: string;
  newAssignmentId: string;
  replacedAssignmentId: string;
  shiftId: string;
  departmentId: string;
  originalEmployeeId: string;
}

export async function pickUpShift(input: PickUpShiftInput): Promise<PickUpShiftResult> {
  // Read-side eligibility pre-check — cheap, fails fast without
  // opening a transaction. Re-checked inside the tx too.
  const eligible = await isSchedulingEligible(input.employeeId);
  if (!eligible) {
    throw new ForbiddenError("You are not currently eligible to pick up shifts (training incomplete).");
  }

  return prisma.$transaction(async (tx) => {
    const opp = await tx.shiftOpportunity.findUnique({
      where: { id: input.opportunityId },
      include: {
        shift: {
          select: {
            id: true, clubId: true, departmentId: true, startAt: true, endAt: true, state: true,
          },
        },
        offeredByAssignment: {
          select: { id: true, employeeId: true, state: true, employmentAssignmentId: true },
        },
      },
    });
    if (!opp || opp.clubId !== input.clubId) {
      throw new NotFoundError("ShiftOpportunity", input.opportunityId);
    }
    if (opp.state !== "OPEN") {
      throw new ConflictError("This shift is no longer available.");
    }
    if (opp.shift.state !== "PUBLISHED") {
      throw new ConflictError("The parent shift is no longer published.");
    }
    if (opp.shift.startAt.getTime() <= Date.now()) {
      throw new ValidationError([{
        path: "shift",
        message: "This shift has already started or ended.",
      }]);
    }
    if (opp.offeredByEmployeeId === input.employeeId) {
      throw new ForbiddenError("You cannot claim your own offered shift.");
    }

    // Claimant must have an ACTIVE employment assignment in the
    // shift's department to preserve role provenance on the new
    // ShiftAssignment row.
    const now = new Date();
    const claimantAssignment = await tx.employeeEmploymentAssignment.findFirst({
      where: {
        clubId: input.clubId,
        employeeId: input.employeeId,
        departmentId: opp.shift.departmentId,
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      orderBy: { effectiveFrom: "desc" },
      select: { id: true },
    });
    if (!claimantAssignment) {
      throw new ForbiddenError("You do not have an active assignment in this department.");
    }

    // 1. CAS the opportunity OPEN → CLAIMED.
    const claimUpdate = await tx.shiftOpportunity.updateMany({
      where: { id: opp.id, state: "OPEN" },
      data: {
        state: "CLAIMED",
        claimedByEmployeeId: input.employeeId,
        claimedByAssignmentId: null, // filled after new-assignment insert
        claimedAt: now,
      },
    });
    if (claimUpdate.count !== 1) {
      throw new ConflictError("This shift was claimed by another coworker moments ago.");
    }

    // 2. CAS the original ShiftAssignment ASSIGNED → REPLACED.
    const originalAsn = opp.offeredByAssignment;
    if (!originalAsn) {
      throw new ConflictError("The original shift assignment is missing.");
    }
    const releaseUpdate = await tx.shiftAssignment.updateMany({
      where: {
        id: originalAsn.id,
        state: "ASSIGNED",
        clubId: input.clubId,
      },
      data: { state: "REPLACED" },
    });
    if (releaseUpdate.count !== 1) {
      throw new ConflictError("The original assignment state changed under us.");
    }

    // 3. INSERT the claimant's new ASSIGNED row. The partial-unique
    //    index on (clubId, shiftId) WHERE state='ASSIGNED' is the
    //    hard backstop against a double-claim slipping through both
    //    of the CAS gates above.
    let newAsnId: string;
    try {
      const newAsn = await tx.shiftAssignment.create({
        data: {
          clubId: input.clubId,
          shiftId: opp.shift.id,
          employeeId: input.employeeId,
          employmentAssignmentId: claimantAssignment.id,
          state: "ASSIGNED",
        },
        select: { id: true },
      });
      newAsnId = newAsn.id;
    } catch (e: unknown) {
      const err = e as { code?: string };
      if (err.code === "P2002") {
        throw new ConflictError("Another claimant is already assigned to this shift.");
      }
      throw e;
    }

    // 4. Backlink original → new; and set opportunity.claimedByAssignmentId.
    await tx.shiftAssignment.update({
      where: { id: originalAsn.id },
      data: { replacedByAssignmentId: newAsnId },
    });
    await tx.shiftOpportunity.update({
      where: { id: opp.id },
      data: { claimedByAssignmentId: newAsnId },
    });

    return {
      opportunityId: opp.id,
      newAssignmentId: newAsnId,
      replacedAssignmentId: originalAsn.id,
      shiftId: opp.shift.id,
      departmentId: opp.shift.departmentId,
      originalEmployeeId: originalAsn.employeeId,
    };
  });
}
