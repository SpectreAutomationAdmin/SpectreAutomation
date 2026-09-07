// Scheduling Foundation · Phase C (2026-09-07) — server actions for
// the hourly-only onboarding "Your Availability" step.
//
// Persists via saveAvailabilityProfile (versioned model). Does NOT
// gate on training completion per amendment §2 — the employee may
// provide availability regardless of training progress.

"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { prisma } from "@/lib/prisma";
import {
  saveAvailabilityProfile,
  type AvailabilityRuleInput,
} from "@/lib/scheduling/availability-profiles";
import { resolveOnboardingContinuation } from "@/lib/hr/onboarding-continuation";
import { AppError } from "@/lib/errors";

// Weekday × shift-template cell: "1::templateId" = available true.
const RULE_KEY_PATTERN = /^(\d)::([A-Za-z0-9_-]+)$/;

const InputSchema = z.object({
  preferredHoursPerWeek: z.coerce.number().int().min(0).max(168).optional(),
  maximumHoursPerWeek: z.coerce.number().int().min(0).max(168).optional(),
  notes: z.string().max(1000).optional(),
  effectiveFromMode: z.enum(["IMMEDIATELY", "SPECIFIC"]).default("IMMEDIATELY"),
  effectiveFromDate: z.string().optional(),
  // Availability cells posted as `avail_<weekday>_<templateId>` = "1".
  // Absent cells are treated as unavailable.
  cellKeys: z.array(z.string()).default([]),
});

function todayUtcMidnight(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function saveOnboardingAvailabilityAction(formData: FormData): Promise<void> {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");

  // Parse `avail_<weekday>_<templateId>` = "1" entries.
  const cellKeys: string[] = [];
  for (const [key, value] of formData.entries()) {
    if (typeof value !== "string" || value !== "1") continue;
    if (!key.startsWith("avail_")) continue;
    const stripped = key.replace(/^avail_/, "");
    // Convert to canonical "weekday::templateId" form.
    const m = stripped.match(/^(\d)_(.+)$/);
    if (!m) continue;
    cellKeys.push(`${m[1]}::${m[2]}`);
  }

  const parsed = InputSchema.safeParse({
    preferredHoursPerWeek: formData.get("preferredHoursPerWeek") ?? undefined,
    maximumHoursPerWeek: formData.get("maximumHoursPerWeek") ?? undefined,
    notes: formData.get("notes") ?? undefined,
    effectiveFromMode: formData.get("effectiveFromMode") ?? undefined,
    effectiveFromDate: formData.get("effectiveFromDate") ?? undefined,
    cellKeys,
  });
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Please review your availability details.";
    redirect(`/hr/onboarding/availability?err=${encodeURIComponent(message)}`);
  }
  const input = parsed.data;

  // Validate the preferred / maximum relationship.
  if (
    input.preferredHoursPerWeek != null
    && input.maximumHoursPerWeek != null
    && input.preferredHoursPerWeek > input.maximumHoursPerWeek
  ) {
    redirect(`/hr/onboarding/availability?err=${encodeURIComponent("Preferred hours cannot exceed maximum hours.")}`);
  }

  // Effective-date resolution.
  let effectiveFrom: Date;
  if (input.effectiveFromMode === "SPECIFIC") {
    if (!input.effectiveFromDate) {
      redirect(`/hr/onboarding/availability?err=${encodeURIComponent("Choose a date this availability starts.")}`);
    }
    const parsedDate = new Date(`${input.effectiveFromDate}T00:00:00.000Z`);
    if (Number.isNaN(parsedDate.getTime())) {
      redirect(`/hr/onboarding/availability?err=${encodeURIComponent("The effective date could not be understood.")}`);
    }
    effectiveFrom = parsedDate;
  } else {
    effectiveFrom = todayUtcMidnight();
  }

  // Resolve the employee's active-department shift templates so we
  // (a) enumerate every cell (not just the available ones) and
  // (b) never persist a template that doesn't belong to this club
  //     (defence-in-depth on top of saveAvailabilityProfile's own check).
  const { listShiftTemplatesForEmployee } = await import("@/lib/scheduling/shift-templates");
  const templates = await listShiftTemplatesForEmployee(actor.clubId, actor.employeeId);

  const availableSet = new Set(input.cellKeys);
  const rules: AvailabilityRuleInput[] = [];
  for (const t of templates) {
    for (let weekday = 0; weekday < 7; weekday++) {
      const key = `${weekday}::${t.id}`;
      rules.push({
        weekday,
        shiftTemplateId: t.id,
        available: availableSet.has(key),
      });
    }
  }

  // Reject an obviously-unusable zero-availability profile per §8
  // "at least one available shift should be required for an hourly
  // worker". If truly unavailable, the employee should exit onboarding
  // and speak with their manager — do not silently persist a schedule
  // profile that would trap the scheduler.
  const hasAny = rules.some((r) => r.available);
  if (!hasAny && templates.length > 0) {
    redirect(`/hr/onboarding/availability?err=${encodeURIComponent("Select at least one available shift so the Club can build your schedule.")}`);
  }

  try {
    await saveAvailabilityProfile({
      clubId: actor.clubId,
      employeeId: actor.employeeId,
      effectiveFrom,
      preferredHoursPerWeek: input.preferredHoursPerWeek ?? null,
      maximumHoursPerWeek: input.maximumHoursPerWeek ?? null,
      notes: input.notes?.trim() || null,
      rules,
      createdByUserId: null, // written on the employee-actor side; no admin user
    });
  } catch (e) {
    if (e instanceof AppError) {
      redirect(`/hr/onboarding/availability?err=${encodeURIComponent(e.safeMessage)}`);
    }
    throw e;
  }

  const next = await resolveOnboardingContinuation({
    sessionId: actor.sessionId,
    employeeId: actor.employeeId,
    clubId: actor.clubId,
  });
  redirect(next);
}

/** Navigate BACK to the previous step (photo). */
export async function returnToPhotoAction(): Promise<void> {
  redirect("/hr/onboarding/about-you/photo");
}
