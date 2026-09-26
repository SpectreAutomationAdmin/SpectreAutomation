// AUTH-3C (2026-09-26) — admin "Sign out on all devices" action for an
// Employee Profile page. Thin server-action wrapper around the
// canonical AUTH-3B `signOutEmployeeEverywhere` — authorization,
// tenant isolation, and audit all happen in the service. This
// wrapper's only job is to surface the current admin principal and
// convert AppError → user-safe `{ ok:false, error }` shape.

"use server";

import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { signOutEmployeeEverywhere } from "@/lib/hr/employee-session-revocation";
import { isAppError, ValidationError } from "@/lib/errors";

interface Ok { ok: true }
interface Err { ok: false; error: string }

function toErr(e: unknown): Err {
  if (e instanceof ValidationError) return { ok: false, error: e.issues[0]?.message ?? e.safeMessage };
  if (isAppError(e)) return { ok: false, error: e.safeMessage };
  return { ok: false, error: "Something went wrong. Please try again." };
}

export async function signOutEmployeeEverywhereAction(
  employeeId: string,
): Promise<Ok | Err> {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) throw new Error("UNAUTHENTICATED");
    await signOutEmployeeEverywhere(principal, employeeId);
    // Refresh the profile so any active-session-derived UI (currently
    // none, but reserved) reflects the change on next render.
    revalidatePath(`/app/admin/people/employees/${employeeId}`);
    return { ok: true };
  } catch (e) {
    return toErr(e);
  }
}
