// AUTH-3C (2026-09-26) — admin "Sign out on all devices" action for the
// Tenant Users management surface. Thin server-action wrapper around
// the canonical AUTH-3B `signOutUserEverywhere`. Authorization,
// tenant isolation, self-revocation semantics, and audit all live in
// the service.

"use server";

import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { signOutUserEverywhere } from "@/lib/tenant-admin/user-session-revocation";
import { isAppError, ValidationError } from "@/lib/errors";

interface Ok { ok: true; selfRevocation: boolean }
interface Err { ok: false; error: string }

function toErr(e: unknown): Err {
  if (e instanceof ValidationError) return { ok: false, error: e.issues[0]?.message ?? e.safeMessage };
  if (isAppError(e)) return { ok: false, error: e.safeMessage };
  return { ok: false, error: "Something went wrong. Please try again." };
}

export async function signOutUserEverywhereAction(
  targetUserId: string,
): Promise<Ok | Err> {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) throw new Error("UNAUTHENTICATED");
    const res = await signOutUserEverywhere(principal, targetUserId);
    // Refresh the list so any lastLoginAt / status derivation stays
    // current on next render. When the caller signed themselves out,
    // the browser will be redirected to /login before this revalidate
    // matters — the client handles the redirect.
    revalidatePath("/app/admin/settings/users");
    return { ok: true, selfRevocation: res.selfRevocation };
  } catch (e) {
    return toErr(e);
  }
}
