// HR-2B.4 (2026-08-19) — Server actions for the Emergency + Documents
// & Credentials post-payroll stages.
//
// Every action gates on `requireEmployeeOnboardingActor()` and hands
// through to the canonical self-service adapters in
// `src/lib/hr/employee-self-service.ts` + `src/lib/hr/onboarding-requirements.ts`.
// The canonical continuation resolver decides the redirect target after
// each save so a completed section flows to the next.

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import {
  submitSelfEmergencyContact,
  submitSelfCredentialDetails,
  confirmSelfRequirement,
} from "@/lib/hr/employee-self-service";
import { resolveOnboardingContinuation } from "@/lib/hr/onboarding-continuation";
import { isAppError } from "@/lib/errors";

function withErr(path: string, safeMessage: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}err=${encodeURIComponent(safeMessage)}`;
}

function firstIssueMessage(err: unknown): string | null {
  if (isAppError(err) && "issues" in err) {
    const issues = (err as unknown as { issues: Array<{ message: string }> }).issues;
    if (Array.isArray(issues) && issues.length > 0) return issues[0]?.message ?? null;
  }
  return null;
}

async function actorOrRedirect() {
  try {
    return await requireEmployeeOnboardingActor();
  } catch {
    redirect("/hr/onboarding/expired");
  }
}

// ---------------------------------------------------------------------------
// Emergency contact.
// ---------------------------------------------------------------------------

export async function saveEmergencyContactAction(formData: FormData) {
  const actor = await actorOrRedirect();
  try {
    await submitSelfEmergencyContact(actor, {
      name: (formData.get("name") as string | null) ?? "",
      relation: (formData.get("relation") as string | null) ?? "",
      phone: (formData.get("phone") as string | null) ?? "",
      email: ((formData.get("email") as string | null) ?? "") || null,
    });
  } catch (err) {
    if (isAppError(err)) {
      redirect(withErr("/hr/onboarding/emergency", firstIssueMessage(err) ?? err.safeMessage));
    }
    throw err;
  }
  revalidatePath("/hr/onboarding/emergency");
  // Continuation drives us to the next incomplete section — Documents
  // if any required requirement is unsatisfied, or the ready-for-review
  // boundary if everything is done.
  const target = await resolveOnboardingContinuation({
    sessionId: actor.sessionId,
    employeeId: actor.employeeId,
    clubId: actor.clubId,
  });
  redirect(target);
}

// ---------------------------------------------------------------------------
// Credential details (CREDENTIAL_WITH_EXPIRY).
// ---------------------------------------------------------------------------

export async function saveCredentialDetailsAction(formData: FormData) {
  const actor = await actorOrRedirect();
  const requirementId = ((formData.get("requirementId") as string | null) ?? "").trim();
  if (!requirementId) {
    redirect(withErr("/hr/onboarding/documents", "Missing requirement reference — please try again."));
  }
  try {
    await submitSelfCredentialDetails(actor, {
      requirementId,
      reference: ((formData.get("reference") as string | null) ?? "").trim() || null,
      issuedAt: ((formData.get("issuedAt") as string | null) ?? "").trim() || null,
      expiresAt: ((formData.get("expiresAt") as string | null) ?? "").trim() || null,
      documentId: ((formData.get("documentId") as string | null) ?? "").trim() || null,
    });
  } catch (err) {
    if (isAppError(err)) {
      redirect(withErr("/hr/onboarding/documents", firstIssueMessage(err) ?? err.safeMessage));
    }
    throw err;
  }
  revalidatePath("/hr/onboarding/documents");
  redirect("/hr/onboarding/documents");
}

// ---------------------------------------------------------------------------
// Confirmation-only requirement.
// ---------------------------------------------------------------------------

export async function confirmRequirementAction(formData: FormData) {
  const actor = await actorOrRedirect();
  const requirementId = ((formData.get("requirementId") as string | null) ?? "").trim();
  if (!requirementId) {
    redirect(withErr("/hr/onboarding/documents", "Missing requirement reference — please try again."));
  }
  try {
    await confirmSelfRequirement(actor, requirementId);
  } catch (err) {
    if (isAppError(err)) {
      redirect(withErr("/hr/onboarding/documents", firstIssueMessage(err) ?? err.safeMessage));
    }
    throw err;
  }
  revalidatePath("/hr/onboarding/documents");
  redirect("/hr/onboarding/documents");
}

/**
 * Fired from the Documents-complete "Continue" affordance — routes to
 * the canonical next step (ready-for-review while HR-2B.5 is unbuilt).
 */
export async function continueFromDocumentsAction() {
  const actor = await actorOrRedirect();
  const target = await resolveOnboardingContinuation({
    sessionId: actor.sessionId,
    employeeId: actor.employeeId,
    clubId: actor.clubId,
  });
  redirect(target);
}
