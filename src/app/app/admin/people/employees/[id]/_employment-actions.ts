// HR-2C Employment (2026-08-24) — Employee Profile Employment tab actions.
//
// Thin server-action wrappers over the canonical HR services. Every
// action loads the current admin Principal, delegates to the service
// (which enforces permission + tenant + posting-guard + audit), and
// returns a compact result the client component can render.

"use server";

import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { addAssignment, endAssignment } from "@/lib/hr/employment-assignments";
import { changeCompensation } from "@/lib/hr/compensation";
import { addAllowance, endAllowance } from "@/lib/hr/allowances";
import { createEmployeePosition } from "@/lib/hr/employee-positions";
import { isAppError, ValidationError } from "@/lib/errors";

interface Ok { ok: true }
interface OkWithId extends Ok { id: string }
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

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

export async function addAssignmentAction(
  employeeId: string,
  input: {
    role: "PRIMARY" | "ADDITIONAL";
    departmentId?: string | null;
    positionId?: string | null;
    managerEmployeeId?: string | null;
    employmentType: string;
    effectiveFrom: string;
    notes?: string | null;
  },
): Promise<OkWithId | Err> {
  try {
    const principal = await requireAdmin();
    const result = await addAssignment(principal, employeeId, {
      role: input.role,
      departmentId: input.departmentId ?? null,
      positionId: input.positionId ?? null,
      managerEmployeeId: input.managerEmployeeId ?? null,
      employmentType: input.employmentType,
      effectiveFrom: input.effectiveFrom,
      notes: input.notes ?? null,
    });
    revalidateProfile(employeeId);
    return { ok: true, id: result.id };
  } catch (e) { return toErr(e); }
}

export async function endAssignmentAction(
  employeeId: string,
  assignmentId: string,
  input: { effectiveTo: string; notes?: string | null },
): Promise<Ok | Err> {
  try {
    const principal = await requireAdmin();
    await endAssignment(principal, assignmentId, {
      effectiveTo: input.effectiveTo,
      notes: input.notes ?? null,
    });
    revalidateProfile(employeeId);
    return { ok: true };
  } catch (e) { return toErr(e); }
}

// ---------------------------------------------------------------------------
// Compensation
// ---------------------------------------------------------------------------

export async function changeCompensationAction(
  employeeId: string,
  input: {
    cadence: string; // HOURLY | SALARY | COMMISSION | PIECE_RATE
    amount: string;
    effectiveFrom: string;
    currency?: string | null;
    notes?: string | null;
    assignmentId?: string | null;
  },
): Promise<Ok | Err> {
  try {
    const principal = await requireAdmin();
    await changeCompensation(principal, employeeId, {
      cadence: input.cadence,
      amount: input.amount,
      effectiveFrom: input.effectiveFrom,
      currency: input.currency ?? null,
      notes: input.notes ?? null,
      assignmentId: input.assignmentId ?? null,
    });
    revalidateProfile(employeeId);
    return { ok: true };
  } catch (e) { return toErr(e); }
}

// ---------------------------------------------------------------------------
// Allowances
// ---------------------------------------------------------------------------

export async function addAllowanceAction(
  employeeId: string,
  input: {
    allowanceType: string;
    description?: string | null;
    amount: string;
    currency?: string | null;
    frequency: string; // PER_PAY_PERIOD | MONTHLY | ANNUAL
    taxable: boolean;
    effectiveFrom: string;
    assignmentId?: string | null;
    notes?: string | null;
  },
): Promise<OkWithId | Err> {
  try {
    const principal = await requireAdmin();
    const result = await addAllowance(principal, employeeId, {
      allowanceType: input.allowanceType,
      description: input.description ?? null,
      amount: input.amount,
      currency: input.currency ?? null,
      frequency: input.frequency,
      taxable: input.taxable,
      effectiveFrom: input.effectiveFrom,
      assignmentId: input.assignmentId ?? null,
      notes: input.notes ?? null,
    });
    revalidateProfile(employeeId);
    return { ok: true, id: result.id };
  } catch (e) { return toErr(e); }
}

export async function endAllowanceAction(
  employeeId: string,
  allowanceId: string,
  input: { effectiveTo: string; notes?: string | null },
): Promise<Ok | Err> {
  try {
    const principal = await requireAdmin();
    await endAllowance(principal, allowanceId, {
      effectiveTo: input.effectiveTo,
      notes: input.notes ?? null,
    });
    revalidateProfile(employeeId);
    return { ok: true };
  } catch (e) { return toErr(e); }
}

// ---------------------------------------------------------------------------
// Add Position (inline from role editors)
// ---------------------------------------------------------------------------
// HR-2C Employment Corrections (2026-08-24) — Founder-required inline
// Position creation. Admin picks a Department in the role editor,
// discovers the desired Position doesn't exist, taps "+ Add position",
// and creates it without leaving the tab. Reuses the canonical
// createEmployeePosition service (already gated on hr:employee:write +
// same-Club enforcement).
export async function createEmployeePositionInlineAction(
  employeeId: string,
  clubId: string,
  input: { name: string; departmentId: string },
): Promise<{ ok: true; id: string; name: string; code: string; departmentId: string } | Err> {
  try {
    const principal = await requireAdmin();
    const created = await createEmployeePosition(principal, clubId, {
      name: input.name,
      departmentId: input.departmentId,
    });
    revalidateProfile(employeeId);
    return {
      ok: true,
      id: created.id,
      name: created.name,
      code: created.code,
      departmentId: created.departmentId ?? input.departmentId,
    };
  } catch (e) { return toErr(e); }
}
