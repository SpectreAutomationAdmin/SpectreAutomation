"use server";
// Slice A (2026-09-18) — Server action for editing an employee's
// Original Hire Date. Routes through the canonical `updateEmployee`
// service (audit + tenant guards + permission checks live there).
// Never edits `activatedAt` (Spectre system record).

import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { updateEmployee } from "@/lib/hr/employees";
import { isAppError } from "@/lib/errors";

export interface UpdateHireDateInput {
  hireDate: string | null; // ISO string or null
}

export async function updateOriginalHireDateAction(
  employeeId: string,
  input: UpdateHireDateInput,
): Promise<{ ok: boolean; error?: string; hireDate?: string | null }> {
  const principal = await getCurrentPrincipal();
  if (!principal) return { ok: false, error: "Authentication required" };
  try {
    const updated = await updateEmployee(principal, employeeId, {
      hireDate: input.hireDate,
    } as never);
    revalidatePath(`/app/admin/people/employees/${employeeId}`);
    return {
      ok: true,
      hireDate: updated.hireDate instanceof Date
        ? updated.hireDate.toISOString()
        : (updated.hireDate as string | null | undefined) ?? null,
    };
  } catch (err) {
    if (isAppError(err)) return { ok: false, error: err.message };
    return { ok: false, error: "Failed to update Original Hire Date." };
  }
}
