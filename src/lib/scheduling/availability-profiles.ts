// Scheduling Foundation (2026-09-07) — versioned availability profiles.
//
// One EmployeeAvailabilityProfile represents ONE complete version of
// an employee's recurring weekly availability. A profile's applicability
// window is [effectiveFrom, next_profile.effectiveFrom) — no explicit
// end date is stored; the next profile's start closes the window.
//
// Founder amendment §2 (Slice 8A Phase A review):
//   Editing availability MUST be allowed regardless of training status.
//   Training gates the READY-TO-BE-SCHEDULED state, not the ability
//   to communicate availability. This service INTENTIONALLY does NOT
//   call assertSchedulingEligibility. Callers that want to gate on
//   training eligibility for their own reasons must do it themselves.
//
// Founder amendment §6:
//   Availability changes affect FUTURE scheduling decisions only.
//   Already-published shifts remain unchanged. If a future shift is
//   ASSIGNED and a new profile marks that (weekday × template) as
//   unavailable, the existing shift stays the employee's
//   responsibility — the UI directs them toward Give Up Shift or
//   Time Off. This service does not modify any Shift or
//   ShiftAssignment row; it only writes profile + rule rows.

import { prisma } from "../prisma";
import { ValidationError } from "../errors";

const WEEKDAY_MIN = 0;
const WEEKDAY_MAX = 6;

export interface AvailabilityRuleInput {
  weekday: number; // 0=Sunday…6=Saturday
  shiftTemplateId: string;
  available: boolean;
  availableFrom?: Date | null;
  availableUntil?: Date | null;
}

export interface SaveAvailabilityProfileInput {
  clubId: string;
  employeeId: string;
  effectiveFrom: Date;
  preferredHoursPerWeek?: number | null;
  maximumHoursPerWeek?: number | null;
  notes?: string | null;
  rules: AvailabilityRuleInput[];
  createdByUserId?: string | null;
}

export interface AvailabilityProfileRow {
  id: string;
  clubId: string;
  employeeId: string;
  effectiveFrom: Date;
  preferredHoursPerWeek: number | null;
  maximumHoursPerWeek: number | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  rules: {
    id: string;
    weekday: number;
    shiftTemplateId: string;
    available: boolean;
    availableFrom: Date | null;
    availableUntil: Date | null;
  }[];
}

function validateRules(rules: AvailabilityRuleInput[]) {
  const seen = new Set<string>();
  for (const r of rules) {
    if (!Number.isInteger(r.weekday) || r.weekday < WEEKDAY_MIN || r.weekday > WEEKDAY_MAX) {
      throw new ValidationError([{
        path: "rules.weekday",
        message: `weekday must be an integer 0-6 (0=Sun); got ${r.weekday}`,
      }]);
    }
    if (!r.shiftTemplateId) {
      throw new ValidationError([{ path: "rules.shiftTemplateId", message: "shiftTemplateId is required" }]);
    }
    const key = `${r.weekday}::${r.shiftTemplateId}`;
    if (seen.has(key)) {
      throw new ValidationError([{
        path: "rules",
        message: `duplicate (weekday, shiftTemplateId) rule: (${r.weekday}, ${r.shiftTemplateId})`,
      }]);
    }
    seen.add(key);
  }
}

/**
 * Create a new availability profile (or replace an existing one that
 * shares the same (employeeId, effectiveFrom)). Writes profile +
 * rules in a single transaction.
 *
 * If a profile for the same (employeeId, effectiveFrom) already
 * exists, its rules are wiped and re-inserted from `input.rules` —
 * this is the "edit today's availability" flow. Prior profiles at
 * older effectiveFrom values are NEVER touched.
 */
export async function saveAvailabilityProfile(
  input: SaveAvailabilityProfileInput,
): Promise<AvailabilityProfileRow> {
  validateRules(input.rules);
  if (input.preferredHoursPerWeek != null && input.preferredHoursPerWeek < 0) {
    throw new ValidationError([{ path: "preferredHoursPerWeek", message: "must be >= 0" }]);
  }
  if (input.maximumHoursPerWeek != null && input.maximumHoursPerWeek < 0) {
    throw new ValidationError([{ path: "maximumHoursPerWeek", message: "must be >= 0" }]);
  }
  if (
    input.preferredHoursPerWeek != null
    && input.maximumHoursPerWeek != null
    && input.preferredHoursPerWeek > input.maximumHoursPerWeek
  ) {
    throw new ValidationError([{
      path: "preferredHoursPerWeek",
      message: "preferredHoursPerWeek must be <= maximumHoursPerWeek",
    }]);
  }

  // Every rule's shiftTemplateId must belong to the same club — enforce
  // via a scoped count check so a cross-tenant id can't slip in.
  const templateIds = Array.from(new Set(input.rules.map((r) => r.shiftTemplateId)));
  if (templateIds.length) {
    const templates = await prisma.shiftTemplate.findMany({
      where: { id: { in: templateIds }, clubId: input.clubId },
      select: { id: true },
    });
    if (templates.length !== templateIds.length) {
      throw new ValidationError([{
        path: "rules.shiftTemplateId",
        message: "one or more shiftTemplateId values do not belong to this club",
      }]);
    }
  }

  return prisma.$transaction(async (tx) => {
    const existing = await tx.employeeAvailabilityProfile.findUnique({
      where: {
        employeeId_effectiveFrom: {
          employeeId: input.employeeId,
          effectiveFrom: input.effectiveFrom,
        },
      },
    });
    let profileId: string;
    if (existing) {
      // Wipe prior rules; keep the profile row so its createdAt is
      // preserved. Update header fields.
      await tx.employeeAvailabilityRule.deleteMany({
        where: { availabilityProfileId: existing.id },
      });
      await tx.employeeAvailabilityProfile.update({
        where: { id: existing.id },
        data: {
          preferredHoursPerWeek: input.preferredHoursPerWeek ?? null,
          maximumHoursPerWeek: input.maximumHoursPerWeek ?? null,
          notes: input.notes ?? null,
        },
      });
      profileId = existing.id;
    } else {
      const created = await tx.employeeAvailabilityProfile.create({
        data: {
          clubId: input.clubId,
          employeeId: input.employeeId,
          effectiveFrom: input.effectiveFrom,
          preferredHoursPerWeek: input.preferredHoursPerWeek ?? null,
          maximumHoursPerWeek: input.maximumHoursPerWeek ?? null,
          notes: input.notes ?? null,
          createdByUserId: input.createdByUserId ?? null,
        },
        select: { id: true },
      });
      profileId = created.id;
    }

    if (input.rules.length) {
      await tx.employeeAvailabilityRule.createMany({
        data: input.rules.map((r) => ({
          availabilityProfileId: profileId,
          shiftTemplateId: r.shiftTemplateId,
          weekday: r.weekday,
          available: r.available,
          availableFrom: r.availableFrom ?? null,
          availableUntil: r.availableUntil ?? null,
        })),
      });
    }

    return tx.employeeAvailabilityProfile.findUniqueOrThrow({
      where: { id: profileId },
      include: {
        rules: {
          select: {
            id: true, weekday: true, shiftTemplateId: true, available: true,
            availableFrom: true, availableUntil: true,
          },
        },
      },
    });
  });
}

/**
 * Resolve the availability profile applicable at a specific date:
 * the row with the LARGEST effectiveFrom <= atDate for this employee.
 * Returns null if no profile is in effect yet at that date.
 */
export async function resolveApplicableAvailabilityProfile(
  employeeId: string,
  atDate: Date,
): Promise<AvailabilityProfileRow | null> {
  const row = await prisma.employeeAvailabilityProfile.findFirst({
    where: {
      employeeId,
      effectiveFrom: { lte: atDate },
    },
    orderBy: { effectiveFrom: "desc" },
    include: {
      rules: {
        select: {
          id: true, weekday: true, shiftTemplateId: true, available: true,
          availableFrom: true, availableUntil: true,
        },
      },
    },
  });
  return row;
}

/**
 * List all profiles for the employee, newest effectiveFrom first.
 * Used for the "your availability history" view.
 */
export async function listAvailabilityProfiles(
  employeeId: string,
): Promise<AvailabilityProfileRow[]> {
  return prisma.employeeAvailabilityProfile.findMany({
    where: { employeeId },
    orderBy: { effectiveFrom: "desc" },
    include: {
      rules: {
        select: {
          id: true, weekday: true, shiftTemplateId: true, available: true,
          availableFrom: true, availableUntil: true,
        },
      },
    },
  });
}
