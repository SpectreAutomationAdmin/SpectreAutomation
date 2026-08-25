// HR mobile-hotfix (2026-08-30) — Admin Approve & Activate action (§4).
//
// Thin server-action wrapper over the canonical approveAndActivateEmployee
// service, which enforces BOTH `hr:onboarding:approve` and
// `hr:employee:write` inside the service layer. The button never
// becomes an authority; permission gating is server-side.

"use server";

import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { approveAndActivateEmployee } from "@/lib/hr/onboarding-approve-activate";
import { isAppError, ValidationError } from "@/lib/errors";

interface Ok { ok: true }
interface Err { ok: false; error: string }

function toErr(e: unknown): Err {
  if (e instanceof ValidationError) return { ok: false, error: e.issues[0]?.message ?? e.safeMessage };
  if (isAppError(e)) return { ok: false, error: e.safeMessage };
  return { ok: false, error: "Something went wrong. Please try again." };
}

export async function approveAndActivateAction(employeeId: string): Promise<Ok | Err> {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) throw new Error("UNAUTHENTICATED");
    await approveAndActivateEmployee(principal, employeeId);
    revalidatePath(`/app/admin/people/employees/${employeeId}`);
    revalidatePath("/app/admin/people/employees");
    return { ok: true };
  } catch (e) { return toErr(e); }
}
