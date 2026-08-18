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
  acknowledgeSelfEmployment,
  CLUB_AUTHORITATIVE_EMPLOYMENT_FIELDS,
  flagEmploymentFieldForCorrection,
  transitionSelfSessionToInProgress,
  updateSelfIdentity,
  uploadSelfPhoto,
  type ClubAuthoritativeField,
  type SelfIdentityPatch,
} from "@/lib/hr/employee-self-service";
import { prisma } from "@/lib/prisma";
import { isAppError } from "@/lib/errors";


// HR-2B.3.1 (2026-08-18) — cookie-based stashError removed; errors now flow via `?err=<safe>` search param.
function withErr(path: string, safeMessage: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}err=${encodeURIComponent(safeMessage)}`;
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
      redirect(withErr("/hr/onboarding/about-you/name", first ?? err.safeMessage));
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
      redirect(withErr("/hr/onboarding/about-you/contact", first ?? err.safeMessage));
    }
    throw err;
  }
  revalidatePath("/hr/onboarding/about-you");
  redirect("/hr/onboarding/about-you/employment");
}

// ---------------------------------------------------------------------------
// Employment confirmation step.
//
// Two outcomes:
//   • "correct"          → persists an EmployeeOnboardingAcknowledgement
//                          row (kind=employment_confirmation). Idempotent.
//   • "needs_correction" → for each field the employee ticked
//                          (correction:<field>:enabled=1) with a non-empty
//                          `correction:<field>:value`, writes ONE
//                          EmployeeOnboardingCorrection row carrying the
//                          canonical field identifier + stated value.
//                          Also removes any stale correction rows for
//                          fields the employee UN-ticked. NO acknowledgement
//                          row is written when corrections are outstanding.
// ---------------------------------------------------------------------------
export async function confirmEmploymentAction(formData: FormData) {
  const actor = await beginActionOrRedirect();
  const outcome = formData.get("outcome") as string | null;

  if (outcome === "correct") {
    try {
      // Clear any prior corrections (employee changed their mind).
      await prisma.employeeOnboardingCorrection.deleteMany({
        where: {
          sessionId: actor.sessionId,
          clubId: actor.clubId,
          field: { in: [...CLUB_AUTHORITATIVE_EMPLOYMENT_FIELDS] },
        },
      });
      await acknowledgeSelfEmployment(actor);
      await markInProgress(actor);
    } catch (err) {
      if (isAppError(err)) {
        redirect(withErr("/hr/onboarding/about-you/employment", err.safeMessage));
      }
      throw err;
    }
  } else if (outcome === "needs_correction") {
    // Gather per-field entries.
    const entries: Array<{ field: ClubAuthoritativeField; stated: string }> = [];
    for (const field of CLUB_AUTHORITATIVE_EMPLOYMENT_FIELDS) {
      const enabled = (formData.get(`correction:${field}:enabled`) as string | null) === "1";
      if (!enabled) continue;
      const stated = ((formData.get(`correction:${field}:value`) as string | null) ?? "").trim();
      if (!stated) continue;
      entries.push({ field, stated });
    }
    if (entries.length === 0) {
      redirect(withErr("/hr/onboarding/about-you/employment", "Please check the item(s) that need correcting and tell us what they should be."));
    }
    try {
      // Idempotent — drop any prior corrections for the same canonical
      // fields (employee is re-submitting) and any acknowledgement
      // (they've changed their mind — no longer "correct").
      await prisma.$transaction([
        prisma.employeeOnboardingCorrection.deleteMany({
          where: {
            sessionId: actor.sessionId,
            clubId: actor.clubId,
            field: { in: [...CLUB_AUTHORITATIVE_EMPLOYMENT_FIELDS] },
          },
        }),
        prisma.employeeOnboardingAcknowledgement.deleteMany({
          where: {
            sessionId: actor.sessionId,
            clubId: actor.clubId,
            kind: "employment_confirmation",
          },
        }),
      ]);
      for (const e of entries) {
        await flagEmploymentFieldForCorrection(actor, {
          field: e.field,
          employeeStatedValue: e.stated,
          note: null,
        });
      }
      await markInProgress(actor);
    } catch (err) {
      if (isAppError(err)) {
        redirect(withErr("/hr/onboarding/about-you/employment", err.safeMessage));
      }
      throw err;
    }
  } else {
    redirect(withErr("/hr/onboarding/about-you/employment", "Please choose an option."));
  }
  revalidatePath("/hr/onboarding/about-you");
  redirect("/hr/onboarding/about-you/photo");
}

// ---------------------------------------------------------------------------
// Photo step.
// ---------------------------------------------------------------------------
export async function uploadPhotoAction(formData: FormData) {
  const actor = await beginActionOrRedirect();
  // HR-2B.3.1 (2026-08-18) §3 — the photo step renders TWO
  // `name="photo"` inputs (selfie + choose) so the two client buttons
  // each activate their own native input. Whichever the employee
  // picked holds the real file; the other submits an empty File.
  // Walk every `photo` entry and pick the first non-empty one so the
  // server contract is unchanged.
  const entries = formData.getAll("photo");
  let file: File | null = null;
  for (const e of entries) {
    if (e instanceof File && e.size > 0) {
      file = e;
      break;
    }
  }
  if (!file) {
    redirect(withErr("/hr/onboarding/about-you/photo", "Please choose a photo to upload."));
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
      redirect(withErr("/hr/onboarding/about-you/photo", first ?? err.safeMessage));
    }
    throw err;
  }
  revalidatePath("/hr/onboarding/about-you");
  redirect("/hr/onboarding/about-you/complete");
}
