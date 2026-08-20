// HR-2B.5 (2026-08-19) — Server actions for the portal-password and
// final Review + Submit stages.
//
// Every action gates on `requireEmployeeOnboardingActor()`. Password
// plaintext never leaves this file — it is normalised, passed to
// `establishPortalPassword` (which hashes it inside a service), and
// then the local reference drops out of scope. The URL-safe error
// channel matches the `withErr` pattern used by `_hr2b4-actions.ts`
// — no password value ever enters the URL.

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import {
  establishPortalPassword,
} from "@/lib/hr/employee-portal-credential";
import {
  acknowledgeSelfPortalPassword,
  acknowledgeSelfFinalSubmission,
  transitionSelfSessionToSubmitted,
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
// Portal password — establish or rotate the Employee Portal credential.
// ---------------------------------------------------------------------------

export async function establishPortalPasswordAction(formData: FormData) {
  const actor = await actorOrRedirect();
  const password = (formData.get("password") as string | null) ?? "";
  const confirmPassword = (formData.get("confirmPassword") as string | null) ?? "";
  try {
    await establishPortalPassword(actor, { password, confirmPassword });
    // Ack row keeps the continuation resolver pattern uniform (see
    // acknowledgeSelfPortalPassword docstring); the credential row is
    // still the auth source of truth.
    await acknowledgeSelfPortalPassword(actor);
  } catch (err) {
    if (isAppError(err)) {
      redirect(withErr("/hr/onboarding/portal-password", firstIssueMessage(err) ?? err.safeMessage));
    }
    throw err;
  }
  revalidatePath("/hr/onboarding/portal-password");
  const target = await resolveOnboardingContinuation({
    sessionId: actor.sessionId,
    employeeId: actor.employeeId,
    clubId: actor.clubId,
  });
  redirect(target);
}

// ---------------------------------------------------------------------------
// Final Submit — HR-2B.5 §28-31. Wired up here in slice 3 so the
// continuation flow is complete; slice 4 builds the real Review page
// that renders the form pointing at it.
// ---------------------------------------------------------------------------

export async function submitOnboardingAction(formData: FormData) {
  const actor = await actorOrRedirect();
  const attested = (formData.get("attested") as string | null) === "1";
  if (!attested) {
    redirect(withErr("/hr/onboarding/review", "Please confirm your acknowledgement before submitting."));
  }
  try {
    // Ack the attestation FIRST so the transition's readiness check
    // (which reads the ack) succeeds.
    await acknowledgeSelfFinalSubmission(actor);
    await transitionSelfSessionToSubmitted(actor);
  } catch (err) {
    if (isAppError(err)) {
      redirect(withErr("/hr/onboarding/review", firstIssueMessage(err) ?? err.safeMessage));
    }
    throw err;
  }
  // After successful submission, the continuation resolver will route
  // to the terminal completion page (session is now SUBMITTED, so
  // step 1's terminal-state gate fires).
  const target = await resolveOnboardingContinuation({
    sessionId: actor.sessionId,
    employeeId: actor.employeeId,
    clubId: actor.clubId,
  });
  redirect(target);
}
