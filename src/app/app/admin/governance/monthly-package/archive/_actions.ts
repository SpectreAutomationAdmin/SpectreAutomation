"use server";

// Server actions for the Monthly Package archive page.
//
// Two row-level actions: delete (DRAFT only) + resend (PUBLISHED or
// SENT only). Both wrap the library functions, which carry the
// tenant + permission gates.
//
// Flash messaging is done via redirect-to-self with `?notice=` or
// `?error=` query params (NOT cookies). Reading + clearing cookies
// in a Server Component page render is forbidden by Next.js — the
// page would throw "Cookies can only be modified in a Server Action
// or Route Handler" on every action completion. The query-string
// pattern sidesteps that entirely and is also more debuggable
// (the message is visible in the URL bar).

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { isAppError } from "@/lib/errors";
import {
  deleteDraftMonthlyPackage,
  resendMonthlyPackage,
} from "@/lib/reporting/monthly-package-archive";
import { getCurrentPrincipal } from "@/lib/services/principal";

const ARCHIVE_PATH = "/app/admin/governance/monthly-package/archive";

/**
 * Redirect to the archive page with a single-shot `?notice=` or
 * `?error=` query string. The page component reads the param,
 * renders the banner, and Next's router handles "fresh load loses
 * the param" naturally — no cookie cleanup required.
 */
function redirectWithFlash(
  kind: "notice" | "error",
  message: string,
): never {
  // revalidate before the redirect so the destination page renders
  // with fresh data (the underlying row was just deleted /
  // resent).
  revalidatePath(ARCHIVE_PATH);
  redirect(`${ARCHIVE_PATH}?${kind}=${encodeURIComponent(message)}`);
}

export async function deleteDraftMonthlyPackageAction(
  packageId: string,
): Promise<void> {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  try {
    await deleteDraftMonthlyPackage(principal, packageId);
  } catch (err) {
    if (isAppError(err)) {
      redirectWithFlash("error", err.safeMessage);
    }
    throw err;
  }
  redirectWithFlash("notice", "Draft monthly package deleted.");
}

export async function resendMonthlyPackageAction(
  packageId: string,
): Promise<void> {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  let sentAtIso: string;
  try {
    const result = await resendMonthlyPackage(principal, packageId);
    sentAtIso =
      result.sentAt?.toISOString().replace("T", " ").slice(0, 19) ?? "now";
  } catch (err) {
    if (isAppError(err)) {
      redirectWithFlash("error", err.safeMessage);
    }
    throw err;
  }
  redirectWithFlash("notice", `Resend queued at ${sentAtIso}.`);
}
