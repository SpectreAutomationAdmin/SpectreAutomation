// HR mobile-hotfix (2026-08-26) — admin-initiated Employee Portal
// password-reset action. Wraps the canonical
// adminSendPortalPasswordReset service which enforces hr:employee:write
// at the service layer.

"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { adminSendPortalPasswordReset } from "@/lib/hr/password-reset";
import { isAppError, ValidationError } from "@/lib/errors";

interface Ok { ok: true }
interface Err { ok: false; error: string }

function toErr(e: unknown): Err {
  if (e instanceof ValidationError) return { ok: false, error: e.issues[0]?.message ?? e.safeMessage };
  if (isAppError(e)) return { ok: false, error: e.safeMessage };
  return { ok: false, error: "Something went wrong. Please try again." };
}

async function resolvePublicOrigin(): Promise<string> {
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  return `${proto}://${host}`;
}

export async function sendPortalPasswordResetAction(employeeId: string): Promise<Ok | Err> {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) throw new Error("UNAUTHENTICATED");
    const publicOrigin = await resolvePublicOrigin();
    await adminSendPortalPasswordReset(principal, employeeId, { publicOrigin });
    revalidatePath(`/app/admin/people/employees/${employeeId}`);
    return { ok: true };
  } catch (e) { return toErr(e); }
}
