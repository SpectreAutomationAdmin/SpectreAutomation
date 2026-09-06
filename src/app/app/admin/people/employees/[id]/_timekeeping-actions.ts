"use server";

// Payroll-3D-1A (2026-09-05) — Timekeeping method admin server action.
//
// Called from the Employee detail page's Timekeeping panel. Delegates
// to the canonical `updateEmployee` (src/lib/hr/employees.ts) which
// runs:
//   • hr:employee:write permission
//   • assertSensitiveActionAllowed
//   • same-tenant enforcement (loadEmployee is club-scoped)
//   • server-side validation against the TIMEKEEPING_METHODS enum
//   • hr.employee.write.update audit with before/after timekeepingMethod
//
// This action is a thin transport — the UI is NOT the validation layer.

import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { updateEmployee } from "@/lib/hr/employees";

export async function updateTimekeepingMethodAction(
  employeeId: string,
  method: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const principal = await getCurrentPrincipal();
  if (!principal) return { ok: false, error: "Not signed in." };
  try {
    await updateEmployee(principal, employeeId, { timekeepingMethod: method });
    revalidatePath(`/app/admin/people/employees/${employeeId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "Update failed." };
  }
}
