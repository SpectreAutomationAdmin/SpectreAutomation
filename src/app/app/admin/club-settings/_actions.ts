"use server";

// Server actions for the Admin → Club Settings page.
//
// Tenant isolation is enforced inside upsertClubProfile (RBAC +
// cross-club account check). The action layer's job is to:
//   1. derive the active clubId from the authenticated session
//      (NEVER trust an id from the client),
//   2. translate FormData into the typed input object,
//   3. surface validation results as a structured response the
//      client can render.

import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { upsertClubProfile, type ClubProfileInput } from "@/lib/clubs/profile";
import { ValidationError, ForbiddenError } from "@/lib/errors";

type ActionState = {
  status: "idle" | "ok" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
};

/**
 * Form-action signature for React's useFormState. Returns the next
 * state object given the previous state + the submitted FormData.
 *
 * The clubId is derived from the principal — there is no clubId field
 * on the form. A bad actor cannot smuggle a foreign club id through
 * this action: the field is read from the authenticated session via
 * getActiveClubId() (which itself enforces "user must have access to
 * this club").
 */
export async function saveClubProfileAction(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const principal = await getCurrentPrincipal();
  if (!principal) {
    return { status: "error", message: "Sign in required." };
  }
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
  });

  const input = formDataToInput(formData);

  try {
    await upsertClubProfile(principal, clubId, input);
    revalidatePath("/app/admin/club-settings");
    // Reporting surfaces consume fiscal-year settings — bust their cache
    // too so the next render picks up the new period numbers.
    revalidatePath("/app/admin/reporting/monthly");
    return { status: "ok", message: "Club settings saved." };
  } catch (err) {
    if (err instanceof ValidationError) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of err.issues) {
        fieldErrors[issue.path] = issue.message;
      }
      return {
        status: "error",
        message: "Please fix the highlighted fields and save again.",
        fieldErrors,
      };
    }
    if (err instanceof ForbiddenError) {
      return { status: "error", message: "You do not have permission to edit club settings." };
    }
    // Unexpected — surface a generic message; logged server-side via Next.
    console.error("[club-settings] saveClubProfileAction unexpected error:", err);
    return { status: "error", message: "Could not save. Please try again." };
  }
}

// ---- FormData → typed input ----------------------------------------

function formDataToInput(fd: FormData): Partial<ClubProfileInput> {
  // String fields (Zod's preprocess will collapse "" → undefined).
  const stringFields = [
    "legalName", "operatingName", "businessNumber", "gstNumber",
    "mailingAddress", "physicalAddress", "city", "provinceState",
    "mainPhone", "generalEmail",
    "websiteUrl", "primaryContactName", "primaryContactTitle",
    "primaryContactEmail", "primaryContactPhone",
    "gstStatus", "gstFilingFrequency", "defaultGstRatePct",
    "defaultCurrency",
    "defaultArAccountId", "defaultApAccountId",
    "defaultRetainedEarningsAccountId", "defaultCurrentYearEarningsAccountId",
    "defaultOperatingBankAccountId", "defaultReserveBankAccountId",
    "defaultMemberReceivablesAccountId", "defaultSalesTaxPayableAccountId",
  ] as const;
  const numericFields = [
    "yearFounded", "fiscalYearEndMonth", "fiscalYearEndDay",
  ] as const;

  const out: Record<string, unknown> = {};
  for (const k of stringFields) {
    const v = fd.get(k);
    if (typeof v === "string") out[k] = v;
  }
  for (const k of numericFields) {
    const v = fd.get(k);
    if (typeof v === "string") out[k] = v; // Zod preprocess coerces.
  }
  return out as Partial<ClubProfileInput>;
}
