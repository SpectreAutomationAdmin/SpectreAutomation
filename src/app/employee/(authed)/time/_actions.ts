"use server";

// Payroll-3D-1 (2026-09-05) — Employee Portal server actions for
// Clock In / Out / Break Start / End. Authentication is resolved
// from the portal cookie; NEVER trust an employeeId sent from the
// client (§30, §55). No CSRF token needed — Next.js server actions +
// cookie-scoped principal is Spectre's canonical portal auth pattern
// (see other _actions.ts files under /employee/(authed)).

import { revalidatePath } from "next/cache";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import {
  clockIn, clockOut, breakStart, breakEnd,
} from "@/lib/timeclock/service";

type ActionResult =
  | { ok: true; state: unknown }
  | { ok: false; error: string };

async function withPrincipal<T>(
  fn: (p: NonNullable<Awaited<ReturnType<typeof getEmployeePortalPrincipal>>>) => Promise<T>,
): Promise<T | { ok: false; error: string }> {
  const p = await getEmployeePortalPrincipal();
  if (!p) return { ok: false, error: "Not signed in." };
  try {
    return await fn(p);
  } catch (err) {
    return { ok: false, error: (err as Error).message || "Unexpected error." };
  }
}

export async function clockInAction(
  input?: { employmentAssignmentId?: string | null },
): Promise<ActionResult> {
  const r = await withPrincipal(async (p) => {
    // Payroll-3D-3A — accept an optional assignment id from the client
    // picker. Server re-validates (belongs to employee + club, active
    // at now) inside clockIn(); the client's value is never trusted.
    const out = await clockIn(p, input?.employmentAssignmentId
      ? { employmentAssignmentId: input.employmentAssignmentId }
      : {});
    revalidatePath("/employee/time");
    revalidatePath("/employee");
    return { ok: true as const, state: out.state };
  });
  return r as ActionResult;
}
export async function clockOutAction(): Promise<ActionResult> {
  const r = await withPrincipal(async (p) => {
    const out = await clockOut(p);
    revalidatePath("/employee/time");
    revalidatePath("/employee");
    return { ok: true as const, state: out.state };
  });
  return r as ActionResult;
}
export async function breakStartAction(): Promise<ActionResult> {
  const r = await withPrincipal(async (p) => {
    const out = await breakStart(p);
    revalidatePath("/employee/time");
    revalidatePath("/employee");
    return { ok: true as const, state: out.state };
  });
  return r as ActionResult;
}
export async function breakEndAction(): Promise<ActionResult> {
  const r = await withPrincipal(async (p) => {
    const out = await breakEnd(p);
    revalidatePath("/employee/time");
    revalidatePath("/employee");
    return { ok: true as const, state: out.state };
  });
  return r as ActionResult;
}
