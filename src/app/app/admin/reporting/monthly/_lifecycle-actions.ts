"use server";

// Monthly Reporting Package — lifecycle server actions.
//
// Three entries:
//   • generateDraftMonthlyPackageAction — called by the launcher's
//     "Generate Monthly Package" button. Creates (or finds) the
//     DRAFT row for the (year, month) the operator picked, then
//     redirects to the report page so the operator can review
//     before publishing.
//   • publishMonthlyPackageAction — captures the snapshot, flips
//     status to PUBLISHED. Surfaced on the report page when a DRAFT
//     exists for the current period.
//   • sendMonthlyPackageAction — auto-publishes (if still DRAFT),
//     populates recipients from the BOARD_READ_ONLY roster, flips
//     status to SENT. Surfaced on the report page once the package
//     is PUBLISHED (or in the same bar — "Publish and send").
//
// All three thin-wrap the lifecycle library functions, which carry
// tenant + permission gating. Success / error feedback uses the
// cookie banner pattern already in place on the archive page.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import { getActiveClubId } from "@/lib/active-club";
import { isAppError } from "@/lib/errors";
import {
  generateDraftMonthlyPackage,
  publishMonthlyPackage,
  sendMonthlyPackage,
} from "@/lib/reporting/monthly-package-lifecycle";
import { getCurrentPrincipal } from "@/lib/services/principal";

const NOTICE_COOKIE = "spectre_archive_notice";
const ERROR_COOKIE = "spectre_archive_error";

function setNotice(message: string, paths: string[]) {
  cookies().set(NOTICE_COOKIE, message, {
    httpOnly: true,
    sameSite: "strict",
    maxAge: 30,
  });
  for (const p of paths) revalidatePath(p);
}

function setError(message: string, paths: string[]) {
  cookies().set(ERROR_COOKIE, message, {
    httpOnly: true,
    sameSite: "strict",
    maxAge: 30,
  });
  for (const p of paths) revalidatePath(p);
}

// ---------------------------------------------------------------------------
// generate (launcher → report)
// ---------------------------------------------------------------------------

export async function generateDraftMonthlyPackageAction(
  formData: FormData,
): Promise<void> {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
  });

  const year = Number(formData.get("year"));
  const month = Number(formData.get("month"));
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    setError("Pick a valid month and year before generating the package.", [
      "/app/admin/governance/monthly-package",
    ]);
    return;
  }

  try {
    await generateDraftMonthlyPackage(principal, clubId, {
      reportingYear: year,
      reportingMonth: month,
    });
  } catch (err) {
    if (isAppError(err)) {
      setError(err.safeMessage, ["/app/admin/governance/monthly-package"]);
      return;
    }
    throw err;
  }

  // Redirect on success — Next.js server actions throw a special
  // signal to perform the redirect, so this MUST be outside the
  // try/catch above.
  const period = `${year}-${String(month).padStart(2, "0")}`;
  redirect(`/app/admin/reporting/monthly?period=${period}`);
}

// ---------------------------------------------------------------------------
// publish (report page → archive)
// ---------------------------------------------------------------------------

export async function publishMonthlyPackageAction(
  packageId: string,
  period: string,
): Promise<void> {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  try {
    await publishMonthlyPackage(principal, packageId);
    setNotice("Package published. Snapshot captured.", [
      `/app/admin/reporting/monthly`,
      `/app/admin/governance/monthly-package/archive`,
    ]);
  } catch (err) {
    if (isAppError(err)) {
      setError(err.safeMessage, [
        `/app/admin/reporting/monthly`,
        `/app/admin/governance/monthly-package/archive`,
      ]);
      return;
    }
    throw err;
  }
  // After publish, send the operator back to the same period view
  // so they see the captured-snapshot state.
  redirect(`/app/admin/reporting/monthly?period=${period}`);
}

// ---------------------------------------------------------------------------
// send (report page → board)
// ---------------------------------------------------------------------------

export async function sendMonthlyPackageAction(
  packageId: string,
  period: string,
): Promise<void> {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  try {
    const result = await sendMonthlyPackage(principal, packageId);
    setNotice(
      `Package sent to ${result.recipientCount} board ${result.recipientCount === 1 ? "member" : "members"}.`,
      [
        `/app/admin/reporting/monthly`,
        `/app/admin/governance/monthly-package/archive`,
      ],
    );
  } catch (err) {
    if (isAppError(err)) {
      setError(err.safeMessage, [
        `/app/admin/reporting/monthly`,
        `/app/admin/governance/monthly-package/archive`,
      ]);
      return;
    }
    throw err;
  }
  redirect(`/app/admin/reporting/monthly?period=${period}`);
}
