"use server";

// Payroll-3D-3B Slice 4 (2026-09-06) — `"use server"` wrapper around
// the pure work-intake action dispatcher. This file is intentionally
// thin: authentication + revalidation ONLY. Every semantic decision
// (whitelist, WI binding, principal resolution against target,
// canonical-service invocation, error mapping) lives in the pure
// dispatcher (src/lib/work-intake/action-dispatcher.ts) so it is
// testable without the Next.js server-action harness.
//
// Slice 6 will render the Mission Control buttons that call this
// action. Slice 4 ships only the boundary.

import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { getCurrentUser } from "@/lib/session";
import {
  invokeWorkIntakeAction,
  type WorkIntakeActionRequest,
  type WorkIntakeActionResult,
} from "@/lib/work-intake/action-dispatcher";

async function requireContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not authenticated");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal) throw new Error("Not authenticated");
  if (!clubId) throw new Error("No active club");
  return { principal, clubId };
}

export async function invokeMissionControlWorkIntakeAction(
  request: WorkIntakeActionRequest,
): Promise<WorkIntakeActionResult> {
  const { principal, clubId } = await requireContext();
  const result = await invokeWorkIntakeAction(principal, clubId, request);
  if (result.ok) {
    // §21 — revalidate Mission Control so the card list re-renders
    // with the new state. Payroll Time is also revalidated so a
    // manager who deep-linked stays in sync.
    revalidatePath("/app/admin");
    revalidatePath("/app/admin/payroll/time");
  }
  return result;
}
