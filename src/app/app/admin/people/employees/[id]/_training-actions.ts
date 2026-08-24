// HR-2C B5 (2026-08-28) — Employee-profile-scoped Training server
// actions. Thin wrappers around the canonical
// `assignCourseToEmployee` writer. The writer itself enforces:
//   - `hr:training:assign` permission (no client-side branching);
//   - cross-Club refused with same-shape 404;
//   - idempotent (returns `alreadyAssigned: true` for duplicates);
//   - audits `hr.training.assignment.create`.
// We never re-implement any of that here — we just call the writer.

"use server";

import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { assignCourseToEmployee } from "@/lib/hr/training/assignments";
import { isAppError, ValidationError } from "@/lib/errors";

interface Ok { ok: true; alreadyAssigned: boolean }
interface Err { ok: false; error: string }

function toErr(e: unknown): Err {
  if (e instanceof ValidationError) return { ok: false, error: e.issues[0]?.message ?? e.safeMessage };
  if (isAppError(e)) return { ok: false, error: e.safeMessage };
  return { ok: false, error: "Something went wrong. Please try again." };
}

export async function assignTrainingCourseAction(
  employeeId: string,
  input: { courseId: string; note?: string | null },
): Promise<Ok | Err> {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) return { ok: false, error: "Sign in required." };
    const { alreadyAssigned } = await assignCourseToEmployee(principal, {
      employeeId,
      courseId: input.courseId,
      note: input.note ?? null,
    });
    revalidatePath(`/app/admin/people/employees/${employeeId}`);
    revalidatePath("/app/admin/people/safety-training/compliance");
    return { ok: true, alreadyAssigned };
  } catch (e) { return toErr(e); }
}
