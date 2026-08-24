// HR-2C Portal Refinement (2026-08-24) — Employee Portal Profile
// self-service server actions.

"use server";

import { revalidatePath } from "next/cache";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import {
  updateSelfPersonalContact,
  upsertSelfPrimaryEmergencyContact,
} from "@/lib/hr/portal-self-service-profile";
import { isAppError, ValidationError } from "@/lib/errors";

interface Ok { ok: true }
interface Err { ok: false; error: string }

function toErr(e: unknown): Err {
  if (e instanceof ValidationError) return { ok: false, error: e.issues[0]?.message ?? e.safeMessage };
  if (isAppError(e)) return { ok: false, error: e.safeMessage };
  return { ok: false, error: "Something went wrong. Please try again." };
}

async function requirePortal() {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) throw new Error("PORTAL_REQUIRED");
  return principal;
}

// ---------------------------------------------------------------------------
// Personal contact — email + mobile phone
// ---------------------------------------------------------------------------

export async function updatePersonalContactAction(
  input: { personalEmail?: string | null; mobilePhone?: string | null },
): Promise<Ok | Err> {
  try {
    const principal = await requirePortal();
    await updateSelfPersonalContact(principal, {
      personalEmail: input.personalEmail ?? undefined,
      mobilePhone: input.mobilePhone ?? undefined,
    });
    revalidatePath("/employee/profile");
    return { ok: true };
  } catch (e) { return toErr(e); }
}

// ---------------------------------------------------------------------------
// Emergency contact — primary
// ---------------------------------------------------------------------------

export async function upsertPrimaryEmergencyContactAction(
  input: { name: string; relation: string; phone: string; email?: string | null },
): Promise<Ok | Err> {
  try {
    const principal = await requirePortal();
    await upsertSelfPrimaryEmergencyContact(principal, {
      name: input.name,
      relation: input.relation,
      phone: input.phone,
      email: input.email ?? null,
    });
    revalidatePath("/employee/profile");
    return { ok: true };
  } catch (e) { return toErr(e); }
}
