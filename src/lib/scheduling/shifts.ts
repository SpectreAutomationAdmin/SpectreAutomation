// Scheduling Foundation (2026-09-07) — read-side helpers for Shift +
// ShiftAssignment. Write paths for shift PUBLICATION live behind a
// future scheduler (out of scope for this phase per §26). This file
// only READS shifts + assignments; the give-up / pick-up write paths
// live in shift-opportunities.ts and shift-pickup.ts.

import { prisma } from "../prisma";

export interface EmployeeShiftRow {
  assignmentId: string;
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
  state: "ASSIGNED" | "REPLACED" | "CANCELLED";
  hasOpenOpportunity: boolean;
}

/**
 * List all ASSIGNED shifts for an employee in a date window.
 * Includes the "Shift Offered" derived flag — true when the shift
 * has an OPEN ShiftOpportunity referencing this assignment.
 *
 * `startAtGte` / `startAtLt` bound the window on the concrete instant,
 * NOT the civil `shiftDate`, so a Saturday-late-night shift that
 * crosses midnight into Sunday still lands in the Saturday window.
 */
export async function listEmployeeShifts(
  clubId: string, employeeId: string,
  windowStart: Date, windowEnd: Date,
): Promise<EmployeeShiftRow[]> {
  const rows = await prisma.shiftAssignment.findMany({
    where: {
      clubId, employeeId,
      state: "ASSIGNED",
      shift: {
        clubId,
        startAt: { gte: windowStart, lt: windowEnd },
        state: "PUBLISHED",
      },
    },
    orderBy: { shift: { startAt: "asc" } },
    include: {
      shift: {
        include: {
          department: { select: { id: true, code: true, name: true } },
          shiftTemplate: { select: { code: true, name: true } },
          position: { select: { id: true, name: true } },
          opportunities: {
            where: { state: "OPEN" },
            select: { id: true, offeredByAssignmentId: true },
          },
        },
      },
    },
  });
  return rows.map((a) => ({
    assignmentId: a.id,
    shiftId: a.shiftId,
    shiftDate: a.shift.shiftDate,
    startAt: a.shift.startAt,
    endAt: a.shift.endAt,
    departmentId: a.shift.department.id,
    departmentCode: a.shift.department.code,
    departmentName: a.shift.department.name,
    templateCode: a.shift.shiftTemplate.code,
    templateName: a.shift.shiftTemplate.name,
    positionId: a.shift.position?.id ?? null,
    positionName: a.shift.position?.name ?? null,
    state: a.state as EmployeeShiftRow["state"],
    hasOpenOpportunity: a.shift.opportunities.some(
      (o) => o.offeredByAssignmentId === a.id,
    ),
  }));
}

/** Sum of scheduled seconds in the window (state=ASSIGNED). */
export async function sumEmployeeScheduledSeconds(
  clubId: string, employeeId: string,
  windowStart: Date, windowEnd: Date,
): Promise<number> {
  const rows = await prisma.shiftAssignment.findMany({
    where: {
      clubId, employeeId, state: "ASSIGNED",
      shift: {
        clubId,
        startAt: { gte: windowStart, lt: windowEnd },
        state: "PUBLISHED",
      },
    },
    select: { shift: { select: { startAt: true, endAt: true } } },
  });
  return rows.reduce(
    (total, a) => total + Math.max(0, Math.floor((a.shift.endAt.getTime() - a.shift.startAt.getTime()) / 1000)),
    0,
  );
}
