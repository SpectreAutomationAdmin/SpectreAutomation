// HR-2C B4 (2026-08-23) — Employee weekly availability service.
//
// Real persistence for the Availability surface so the canonical
// scheduling-eligibility guard has an actual write path to protect.
// Every mutation calls `assertSchedulingEligibility(employeeId)`
// immediately before persisting; a stale UI or crafted POST cannot
// bypass the training gate because eligibility is re-derived at
// write time.
//
// Read discipline
//   - `listAvailabilityWeeks(actor, opts?)` is allowed even when the
//     employee is scheduling-ineligible (§2 — "may VIEW existing
//     Availability"). Tenant-scoped to the actor's club + own
//     employeeId.
//
// Write discipline
//   - `saveAvailabilityWeek(actor, input)` calls the guard first,
//     validates the payload, then upserts a single row per
//     (employeeId, weekStart) tuple.
//   - The write is audited (action `hr.availability.upsert`). The
//     eligibility read itself is never audited (§13 — "do not audit
//     every call to resolveEmployeeSchedulingEligibility()").
//
// Week normalisation
//   - `normaliseWeekStart(date)` returns the Monday 00:00 UTC of the
//     ISO week containing the given date. Storing normalised weeks
//     lets `(employeeId, weekStart)` be a natural unique key.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { ValidationError } from "../errors";
import { assertSchedulingEligibility } from "./scheduling-eligibility";
import type { EmployeePortalPrincipal } from "../employee-portal-session";
import { WEEKDAYS, type Weekday, type AvailabilityWeekView } from "./availability-types";

export { WEEKDAYS };
export type { Weekday, AvailabilityWeekView };

const ENTITY = "EmployeeAvailabilityWeek";

/** Normalise any date to the Monday 00:00 UTC of the ISO week that
 *  contains it. ISO week Monday = getUTCDay() === 1. */
export function normaliseWeekStart(input: Date): Date {
  const d = new Date(Date.UTC(
    input.getUTCFullYear(),
    input.getUTCMonth(),
    input.getUTCDate(),
    0, 0, 0, 0,
  ));
  const day = d.getUTCDay(); // 0 (Sun) .. 6 (Sat)
  // Days back to Monday: Sun=6, Mon=0, Tue=1, …
  const back = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d;
}

/** Get the Monday of the current week in UTC. Public helper for the
 *  Availability page so it can default the "current week" tile
 *  without re-implementing the Monday math. */
export function currentWeekStart(): Date {
  return normaliseWeekStart(new Date());
}

/** List an employee's availability weeks. Never guarded by training
 *  eligibility — read access is preserved even for ineligible
 *  employees so they can see their existing submissions (§7). */
export async function listAvailabilityWeeks(
  actor: EmployeePortalPrincipal,
  opts?: { fromWeek?: Date; toWeek?: Date; limit?: number },
): Promise<AvailabilityWeekView[]> {
  const weekStart: { gte?: Date; lte?: Date } = {};
  if (opts?.fromWeek) weekStart.gte = normaliseWeekStart(opts.fromWeek);
  if (opts?.toWeek) weekStart.lte = normaliseWeekStart(opts.toWeek);
  const rows = await prisma.employeeAvailabilityWeek.findMany({
    where: {
      employeeId: actor.employeeId,
      clubId: actor.clubId,
      ...(weekStart.gte || weekStart.lte ? { weekStart } : {}),
    },
    orderBy: { weekStart: "asc" },
    take: opts?.limit ?? 26,
  });
  return rows.map((r) => ({
    id: r.id,
    weekStart: r.weekStart,
    monday: r.monday,
    tuesday: r.tuesday,
    wednesday: r.wednesday,
    thursday: r.thursday,
    friday: r.friday,
    saturday: r.saturday,
    sunday: r.sunday,
    notes: r.notes,
    updatedAt: r.updatedAt,
  }));
}

export interface SaveAvailabilityWeekInput {
  weekStart: Date | string;
  monday?: boolean;
  tuesday?: boolean;
  wednesday?: boolean;
  thursday?: boolean;
  friday?: boolean;
  saturday?: boolean;
  sunday?: boolean;
  notes?: string | null;
}

/** Upsert a single week of availability for the calling employee.
 *  Guarded by `assertSchedulingEligibility` — throws
 *  `SchedulingIneligibleError` if the employee has any outstanding
 *  required training. No partial mutation occurs on refuse. */
export async function saveAvailabilityWeek(
  actor: EmployeePortalPrincipal,
  input: SaveAvailabilityWeekInput,
): Promise<AvailabilityWeekView> {
  // Guard FIRST — no partial writes on refuse (§4).
  await assertSchedulingEligibility(actor.employeeId);

  const weekStart = normaliseWeekStart(
    typeof input.weekStart === "string" ? new Date(input.weekStart) : input.weekStart,
  );
  if (Number.isNaN(weekStart.getTime())) {
    throw new ValidationError([{ path: "weekStart", message: "A valid week start is required." }]);
  }

  const notes = input.notes?.trim() ?? null;
  if (notes && notes.length > 500) {
    throw new ValidationError([{ path: "notes", message: "Notes must be at most 500 characters." }]);
  }

  const data = {
    clubId: actor.clubId,
    employeeId: actor.employeeId,
    weekStart,
    monday: !!input.monday,
    tuesday: !!input.tuesday,
    wednesday: !!input.wednesday,
    thursday: !!input.thursday,
    friday: !!input.friday,
    saturday: !!input.saturday,
    sunday: !!input.sunday,
    notes,
  };

  const row = await prisma.employeeAvailabilityWeek.upsert({
    where: {
      employeeId_weekStart: {
        employeeId: actor.employeeId,
        weekStart,
      },
    },
    create: data,
    update: {
      monday: data.monday,
      tuesday: data.tuesday,
      wednesday: data.wednesday,
      thursday: data.thursday,
      friday: data.friday,
      saturday: data.saturday,
      sunday: data.sunday,
      notes: data.notes,
    },
  });

  await audit(null, {
    action: "hr.availability.upsert",
    entityType: ENTITY,
    entityId: row.id,
    clubId: actor.clubId,
    after: {
      weekStart: row.weekStart.toISOString(),
      // Booleans are safe to record; no PII beyond identity tail.
      days: {
        mon: row.monday, tue: row.tuesday, wed: row.wednesday,
        thu: row.thursday, fri: row.friday, sat: row.saturday, sun: row.sunday,
      },
      hasNotes: row.notes !== null,
      actorSource: "EMPLOYEE",
      employeeIdTail: actor.employeeId.slice(-8),
    },
  });

  return {
    id: row.id,
    weekStart: row.weekStart,
    monday: row.monday,
    tuesday: row.tuesday,
    wednesday: row.wednesday,
    thursday: row.thursday,
    friday: row.friday,
    saturday: row.saturday,
    sunday: row.sunday,
    notes: row.notes,
    updatedAt: row.updatedAt,
  };
}
