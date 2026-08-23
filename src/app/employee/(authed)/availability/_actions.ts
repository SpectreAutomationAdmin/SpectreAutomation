// HR-2C B4 (2026-08-23) — Availability server action.
//
// Thin wrapper over `saveAvailabilityWeek`. Every field is coerced
// server-side; a doctored payload cannot slip through with extra
// keys. The canonical `assertSchedulingEligibility` runs INSIDE
// `saveAvailabilityWeek` so a UI-bypassed action call is refused
// identically to a form submit.

"use server";

import { revalidatePath } from "next/cache";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import {
  saveAvailabilityWeek,
  WEEKDAYS,
  normaliseWeekStart,
} from "@/lib/hr/availability";
import { SchedulingIneligibleError } from "@/lib/hr/scheduling-eligibility";
import { isAppError, ValidationError } from "@/lib/errors";

interface Ok { ok: true; savedWeek: string }
interface Refused { ok: false; error: string; ineligible?: boolean; outstandingCount?: number }

export async function saveAvailabilityAction(
  formData: FormData,
): Promise<Ok | Refused> {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) return { ok: false, error: "Your session has expired. Please sign in again." };

  const raw = formData.get("weekStart");
  if (typeof raw !== "string" || !raw) {
    return { ok: false, error: "Missing week." };
  }
  const week = new Date(raw);
  if (Number.isNaN(week.getTime())) {
    return { ok: false, error: "Invalid week." };
  }
  const normalisedWeek = normaliseWeekStart(week);
  const notes = ((formData.get("notes") as string | null) ?? "").trim();

  const days = Object.fromEntries(
    WEEKDAYS.map((d) => [d, formData.get(d) === "on"] as const),
  ) as Record<(typeof WEEKDAYS)[number], boolean>;

  try {
    const row = await saveAvailabilityWeek(principal, {
      weekStart: normalisedWeek,
      notes: notes || null,
      ...days,
    });
    revalidatePath("/employee/availability");
    revalidatePath("/employee");
    revalidatePath("/employee/schedule");
    return { ok: true, savedWeek: row.weekStart.toISOString() };
  } catch (e) {
    if (e instanceof SchedulingIneligibleError) {
      return {
        ok: false,
        error: e.safeMessage,
        ineligible: true,
        outstandingCount: e.outstandingCount,
      };
    }
    if (e instanceof ValidationError) {
      return { ok: false, error: e.issues[0]?.message ?? e.safeMessage };
    }
    if (isAppError(e)) return { ok: false, error: e.safeMessage };
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}
