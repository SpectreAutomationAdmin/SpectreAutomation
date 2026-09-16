// Phase 4 (2026-09-16) — Employee Profile · Recurring Payroll
// Components server actions.
//
// Thin server-action wrappers over the canonical Payroll-3C-1
// EmployeeRecurringPayrollComponent service. Every action loads the
// current admin Principal, delegates to the service (which enforces
// `payroll:write` + tenant scope + audit), and returns a compact
// result the client component can render.

"use server";

import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import {
  createRecurringComponentAssignment,
  endRecurringComponentAssignment,
  changeRecurringComponentAssignment,
} from "@/lib/payroll/components-catalogue";
import { isAppError, ValidationError } from "@/lib/errors";

interface Ok { ok: true; id?: string }
interface Err { ok: false; error: string }

function toErr(e: unknown): Err {
  if (e instanceof ValidationError) return { ok: false, error: e.issues[0]?.message ?? e.safeMessage };
  if (isAppError(e)) return { ok: false, error: e.safeMessage };
  return { ok: false, error: "Something went wrong. Please try again." };
}

async function requireAdmin() {
  const p = await getCurrentPrincipal();
  if (!p) throw new Error("UNAUTHENTICATED");
  return p;
}

function revalidateProfile(employeeId: string) {
  revalidatePath(`/app/admin/people/employees/${employeeId}`);
}

export async function addRecurringPayrollComponentAction(
  employeeId: string,
  clubId: string,
  input: {
    componentId: string;
    amount: string | null;
    percentBps: number | null;
    effectiveFrom: string; // YYYY-MM-DD
    notes?: string | null;
  },
): Promise<Ok | Err> {
  try {
    const p = await requireAdmin();
    const eff = new Date(input.effectiveFrom + "T00:00:00.000Z");
    if (Number.isNaN(eff.getTime())) return { ok: false, error: "Effective date is invalid." };
    const created = await createRecurringComponentAssignment(p, clubId, {
      employeeId,
      componentId: input.componentId,
      amount: input.amount != null ? input.amount : null,
      percentBps: input.percentBps ?? null,
      effectiveFrom: eff,
      notes: input.notes ?? null,
    });
    revalidateProfile(employeeId);
    return { ok: true, id: created.id };
  } catch (e) {
    return toErr(e);
  }
}

export async function changeRecurringPayrollComponentAction(
  employeeId: string,
  clubId: string,
  predecessorId: string,
  input: {
    amount: string | null;
    percentBps: number | null;
    effectiveFrom: string;
    notes?: string | null;
  },
): Promise<Ok | Err> {
  try {
    const p = await requireAdmin();
    const eff = new Date(input.effectiveFrom + "T00:00:00.000Z");
    if (Number.isNaN(eff.getTime())) return { ok: false, error: "Effective date is invalid." };
    const r = await changeRecurringComponentAssignment(p, clubId, predecessorId, {
      amount: input.amount ?? null,
      percentBps: input.percentBps ?? null,
      effectiveFrom: eff,
      notes: input.notes ?? null,
    });
    revalidateProfile(employeeId);
    return { ok: true, id: r.successorId };
  } catch (e) {
    return toErr(e);
  }
}

export async function endRecurringPayrollComponentAction(
  employeeId: string,
  clubId: string,
  assignmentId: string,
  effectiveTo: string, // YYYY-MM-DD
): Promise<Ok | Err> {
  try {
    const p = await requireAdmin();
    const to = new Date(effectiveTo + "T00:00:00.000Z");
    if (Number.isNaN(to.getTime())) return { ok: false, error: "End date is invalid." };
    await endRecurringComponentAssignment(p, clubId, assignmentId, to);
    revalidateProfile(employeeId);
    return { ok: true };
  } catch (e) {
    return toErr(e);
  }
}
