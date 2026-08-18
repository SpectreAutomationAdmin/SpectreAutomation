// HR-2B.2 (2026-08-18) — About You server actions.
//
// Every action here gates on `EmployeeOnboardingActor` (never
// `Principal`), targets `actor.employeeId` exclusively, and audits
// with actorSource=EMPLOYEE.
//
// The first successful mutation implicitly transitions the session
// from INVITED to IN_PROGRESS, stamped with EMPLOYEE provenance.

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  requireEmployeeOnboardingActor,
} from "@/lib/hr/employee-actor";
import {
  flagEmploymentFieldForCorrection,
  transitionSelfSessionToInProgress,
  updateSelfIdentity,
  uploadSelfPhoto,
  type SelfIdentityPatch,
} from "@/lib/hr/employee-self-service";
import { isAppError } from "@/lib/errors";
import { cookies } from "next/headers";

const ERROR_COOKIE = "spectre_hr_onboarding_error";

function stashError(safeMessage: string) {
  cookies().set(ERROR_COOKIE, safeMessage, {
    httpOnly: true,
    sameSite: "strict",
    maxAge: 30,
    path: "/hr",
  });
}

async function beginActionOrRedirect() {
  try {
    return await requireEmployeeOnboardingActor();
  } catch {
    redirect("/hr/onboarding/expired");
  }
}

/** Advance the session to IN_PROGRESS on first real employee action.
 *  Idempotent — safe to call from every action. */
async function markInProgress(actor: Awaited<ReturnType<typeof requireEmployeeOnboardingActor>>) {
  try {
    if (actor.sessionState === "INVITED") {
      await transitionSelfSessionToInProgress(actor);
    }
  } catch (err) {
    // Non-fatal — the first-answer transition is a metadata flip;
    // failing here should not prevent the actual identity/photo/
    // response write from returning success to the employee. The
    // transition will retry on the NEXT action.
    // eslint-disable-next-line no-console
    console.warn("[hr-2b.2] failed to transition to IN_PROGRESS", err);
  }
}

// ---------------------------------------------------------------------------
// Name step.
// ---------------------------------------------------------------------------
export async function saveNameAction(formData: FormData) {
  const actor = await beginActionOrRedirect();
  const patch: SelfIdentityPatch = {
    firstName: (formData.get("firstName") as string | null) ?? undefined,
    middleName: (formData.get("middleName") as string | null) ?? undefined,
    lastName: (formData.get("lastName") as string | null) ?? undefined,
    preferredName: (formData.get("preferredName") as string | null) ?? undefined,
  };
  // Drop undefined keys — the allowlist check would refuse them, but
  // undefined shouldn't drive an audit event either.
  for (const k of Object.keys(patch) as (keyof SelfIdentityPatch)[]) {
    if (patch[k] === undefined) delete patch[k];
  }
  try {
    await updateSelfIdentity(actor, patch);
    await markInProgress(actor);
  } catch (err) {
    if (isAppError(err)) {
      const first = ("issues" in err && Array.isArray((err as unknown as { issues: Array<{ message: string }> }).issues))
        ? (err as unknown as { issues: Array<{ message: string }> }).issues[0]?.message
        : null;
      stashError(first ?? err.safeMessage);
      redirect("/hr/onboarding/about-you/name");
    }
    throw err;
  }
  revalidatePath("/hr/onboarding/about-you");
  redirect("/hr/onboarding/about-you/contact");
}

// ---------------------------------------------------------------------------
// Contact step.
// ---------------------------------------------------------------------------
export async function saveContactAction(formData: FormData) {
  const actor = await beginActionOrRedirect();
  const patch: SelfIdentityPatch = {
    personalEmail: (formData.get("personalEmail") as string | null) ?? undefined,
    mobilePhone: (formData.get("mobilePhone") as string | null) ?? undefined,
  };
  for (const k of Object.keys(patch) as (keyof SelfIdentityPatch)[]) {
    if (patch[k] === undefined) delete patch[k];
  }
  try {
    await updateSelfIdentity(actor, patch);
    await markInProgress(actor);
  } catch (err) {
    if (isAppError(err)) {
      const first = ("issues" in err && Array.isArray((err as unknown as { issues: Array<{ message: string }> }).issues))
        ? (err as unknown as { issues: Array<{ message: string }> }).issues[0]?.message
        : null;
      stashError(first ?? err.safeMessage);
      redirect("/hr/onboarding/about-you/contact");
    }
    throw err;
  }
  revalidatePath("/hr/onboarding/about-you");
  redirect("/hr/onboarding/about-you/employment");
}

// ---------------------------------------------------------------------------
// Employment confirmation step.
// ---------------------------------------------------------------------------
export async function confirmEmploymentAction(formData: FormData) {
  const actor = await beginActionOrRedirect();
  const outcome = formData.get("outcome") as string | null;
  const correctionNote = ((formData.get("correctionNote") as string | null) ?? "").trim();
  if (outcome === "correct") {
    // Nothing to write — the employee confirmed the Club's authoritative
    // values are right. We still advance the flow, and mark IN_PROGRESS.
    await markInProgress(actor);
  } else if (outcome === "needs_correction") {
    if (!correctionNote) {
      stashError("Please tell us what needs correcting.");
      redirect("/hr/onboarding/about-you/employment");
    }
    try {
      // We don't know which specific field the employee is flagging —
      // record it against the "employmentType" bucket as a general
      // discrepancy, with the note carrying the detail. HR-2B.5's
      // review UI shows the raw stated value + note.
      await flagEmploymentFieldForCorrection(actor, {
        field: "employmentType",
        employeeStatedValue: correctionNote,
        note: null,
      });
      await markInProgress(actor);
    } catch (err) {
      if (isAppError(err)) {
        stashError(err.safeMessage);
        redirect("/hr/onboarding/about-you/employment");
      }
      throw err;
    }
  } else {
    stashError("Please choose an option.");
    redirect("/hr/onboarding/about-you/employment");
  }
  revalidatePath("/hr/onboarding/about-you");
  redirect("/hr/onboarding/about-you/photo");
}

// ---------------------------------------------------------------------------
// Photo step.
// ---------------------------------------------------------------------------
export async function uploadPhotoAction(formData: FormData) {
  const actor = await beginActionOrRedirect();
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) {
    stashError("Please choose a photo to upload.");
    redirect("/hr/onboarding/about-you/photo");
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  try {
    await uploadSelfPhoto(actor, {
      bytes,
      mimeType: file.type,
      displayName: file.name || null,
    });
    await markInProgress(actor);
  } catch (err) {
    if (isAppError(err)) {
      const first = ("issues" in err && Array.isArray((err as unknown as { issues: Array<{ message: string }> }).issues))
        ? (err as unknown as { issues: Array<{ message: string }> }).issues[0]?.message
        : null;
      stashError(first ?? err.safeMessage);
      redirect("/hr/onboarding/about-you/photo");
    }
    throw err;
  }
  revalidatePath("/hr/onboarding/about-you");
  redirect("/hr/onboarding/about-you/complete");
}
