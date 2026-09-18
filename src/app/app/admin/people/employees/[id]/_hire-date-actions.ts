"use server";
// Slice A closeout (2026-09-18) — Original Hire Date correction.
//
// Routes through the DEDICATED `updateEmployeeHireDate` service which
// enforces the narrow `hr:service-date:write` permission. This action
// does NOT accept any field other than `hireDate`; the service refuses
// to write anything else.
//
// The generic `updateEmployee` service still supports hireDate for the
// HR-tier callers who hold `hr:employee:write`; this dedicated path is
// the finance-tier (Controller / Payroll Admin) entry point.

import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { updateEmployeeHireDate } from "@/lib/hr/service-date";
import { isAppError } from "@/lib/errors";

export interface UpdateHireDateInput {
  hireDate: string | null; // ISO string, YYYY-MM-DD, or null
}

export async function updateOriginalHireDateAction(
  employeeId: string,
  input: UpdateHireDateInput,
): Promise<{ ok: boolean; error?: string; hireDate?: string | null }> {
  const principal = await getCurrentPrincipal();
  if (!principal) return { ok: false, error: "Authentication required" };
  try {
    const result = await updateEmployeeHireDate(principal, employeeId, {
      hireDate: input.hireDate,
    });
    revalidatePath(`/app/admin/people/employees/${employeeId}`);
    return {
      ok: true,
      hireDate: result.hireDate ? result.hireDate.toISOString() : null,
    };
  } catch (err) {
    if (isAppError(err)) return { ok: false, error: err.message };
    return { ok: false, error: "Failed to update Original Hire Date." };
  }
}
