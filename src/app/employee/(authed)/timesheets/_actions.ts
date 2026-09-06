"use server";

// Payroll-3D-2 — Employee Portal Timesheet server actions.
// Same auth pattern as /employee/time: portal cookie → principal.

import { revalidatePath } from "next/cache";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import {
  submitCorrectionRequest, cancelCorrectionRequest,
  type CorrectionRequestType,
} from "@/lib/timesheets/correction-service";

type ActionResult =
  | { ok: true; requestId?: string; idempotent?: boolean }
  | { ok: false; error: string };

export async function submitCorrectionAction(
  input: {
    requestType: string;
    originalClockEventId?: string | null;
    requestedLocalIso?: string | null;
    reason: string;
    employmentAssignmentId?: string | null;
  },
): Promise<ActionResult> {
  const p = await getEmployeePortalPrincipal();
  if (!p) return { ok: false, error: "Not signed in." };
  try {
    const r = await submitCorrectionRequest(p, {
      requestType: input.requestType as CorrectionRequestType,
      originalClockEventId: input.originalClockEventId ?? null,
      requestedLocalIso: input.requestedLocalIso ?? null,
      reason: input.reason,
      employmentAssignmentId: input.employmentAssignmentId ?? null,
    });
    revalidatePath("/employee/timesheets");
    return { ok: true, requestId: r.request.id, idempotent: r.idempotent };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "Submit failed." };
  }
}

export async function cancelCorrectionAction(requestId: string): Promise<ActionResult> {
  const p = await getEmployeePortalPrincipal();
  if (!p) return { ok: false, error: "Not signed in." };
  try {
    await cancelCorrectionRequest(p, requestId);
    revalidatePath("/employee/timesheets");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "Cancel failed." };
  }
}
