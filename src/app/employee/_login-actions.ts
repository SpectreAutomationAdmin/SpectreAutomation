// HR-2B.5 §7-9, §31 (2026-08-19) — Employee Portal login actions.
//
// HR mobile-hotfix (2026-08-25) — the founder-accepted username has
// changed from `employeeNumber` to canonical `personalEmail`. Login
// action is now email-driven; existing bcrypt passwords are preserved
// (`verifyPortalPasswordByEmail` reuses the same credential row).
//
// Two server actions:
//   - employeePortalLoginAction: form-driven sign-in from /employee/login.
//   - handoffFromOnboardingAction: consumed by /employee/login/handoff-from-onboarding
//     to stamp the permanent employee cookie right after the employee's
//     Submit on the onboarding Review page (§31).
//
// Club resolution: the host is inspected first (via getActiveBranding
// → resolveClubByHost). When the host maps to a specific Club, the
// login lookup is Club-scoped. When the host is the shared PLATFORM
// host (staging.spectreautomation.com, or any host serving multiple
// Clubs), the lookup spans all Clubs — the normalised email itself
// identifies the employee. A same-email match spanning multiple Clubs
// is refused NEUTRALLY (kind=ambiguous_across_clubs); the service
// never silently picks a winner.

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { hashEmail } from "@/lib/security/auth-guard";
import { consumeRate } from "@/lib/security/rate-limit";
import { RateLimitError } from "@/lib/errors";
import { getRequestContext } from "@/lib/request-context";
import {
  verifyPortalPasswordByEmail,
  normaliseLoginEmail,
} from "@/lib/hr/employee-portal-credential";
import {
  establishEmployeePortalSession,
  destroyEmployeePortalSession,
} from "@/lib/employee-portal-session";
import { prisma } from "@/lib/prisma";
import { getEmployeeOnboardingSession } from "@/lib/hr/employee-onboarding-session";
import { getActiveBranding } from "@/lib/branding";

function withErr(path: string, safeMessage: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}err=${encodeURIComponent(safeMessage)}`;
}

/** Returns the host-resolved Club id, or null when the current host
 *  is the shared platform host (a valid multi-Club login origin). */
async function resolveClubForRequest(): Promise<string | null> {
  const branding = await getActiveBranding();
  return branding.clubId ?? null;
}

// Neutral message used for BOTH "unknown email/password" and
// "ambiguous across Clubs". Same string keeps the failure branches
// indistinguishable to the caller.
const NEUTRAL_LOGIN_FAILURE =
  "That email and password combination isn't recognised.";

// ---------------------------------------------------------------------------
// Primary login (email + password)
// ---------------------------------------------------------------------------

export async function employeePortalLoginAction(formData: FormData): Promise<void> {
  const emailRaw = (formData.get("email") as string | null) ?? "";
  const password = (formData.get("password") as string | null) ?? "";
  const email = normaliseLoginEmail(emailRaw);

  // Club scope from host (null when the platform host is the origin).
  const hostClubId = await resolveClubForRequest();

  if (!email || !password) {
    redirect(withErr("/employee/login", "Please enter your email address and password."));
  }

  // Rate-limit per (host-Club-or-platform + normalised email). Hashed
  // so log dumps don't leak the raw pair.
  const rateKey = hashEmail(`${hostClubId ?? "platform"}:${email}`);
  try {
    await consumeRate("login", rateKey);
  } catch (err) {
    if (err instanceof RateLimitError) {
      redirect(withErr("/employee/login", "Too many attempts. Please try again shortly."));
    }
    throw err;
  }

  const result = await verifyPortalPasswordByEmail({
    clubId: hostClubId,
    email,
    password,
  });
  const ctx = await getRequestContext();

  if (result.kind === "not_recognised" || result.kind === "ambiguous_across_clubs") {
    // Same audit shape + neutral message for BOTH failure modes so
    // no enumeration signal leaks between "no such email" vs
    // "email matched more than one Club" vs "wrong password". The
    // audit entry uses a hash of the email so a compromised log
    // stream cannot enumerate valid emails.
    await audit(null, {
      action: "employee_portal.login.failure",
      entityType: "EmployeePortalCredential",
      // Entity-id carries only the emailHash — no raw email + no
      // discrimination between the two failure modes.
      entityId: `hash:${hashEmail(email)}`,
      clubId: hostClubId ?? "platform",
      meta: {
        ip: ctx?.ip, userAgent: ctx?.userAgent,
        // The failure kind IS logged so operators debugging genuine
        // Club-ambiguity can see it in the audit stream, but never
        // reaches the browser response.
        failureKind: result.kind,
      },
    });
    redirect(withErr("/employee/login", NEUTRAL_LOGIN_FAILURE));
  }

  await establishEmployeePortalSession({
    employeeId: result.employeeId,
    clubId: result.clubId,
  });
  await audit(null, {
    action: "employee_portal.login.success",
    entityType: "EmployeePortalCredential",
    entityId: result.employeeId,
    clubId: result.clubId,
    meta: { ip: ctx?.ip, userAgent: ctx?.userAgent },
  });
  revalidatePath("/employee");
  redirect("/employee");
}

// ---------------------------------------------------------------------------
// Post-onboarding handoff (§31)
// ---------------------------------------------------------------------------
//
// The employee just submitted onboarding. Their onboarding session
// cookie already proves they own this employeeId; we stamp the
// permanent portal cookie from that identity WITHOUT asking them to
// re-enter their password. The onboarding session cookie itself is
// left alone — its lifecycle is unaffected — but the permanent
// portal cookie is now authoritative for /employee/**.
//
// Preconditions:
//   - onboarding actor exists (else 302 to /hr/onboarding/expired)
//   - the session must be in a terminal state (SUBMITTED/APPROVED/REJECTED)
//     — we DO NOT hand off a still-active onboarding to the portal.
//   - the employee must have set a portal credential (else redirect
//     back to portal-password step).

export async function handoffFromOnboardingAction(): Promise<void> {
  // HR-2B.5 §31 — Handoff runs AFTER Submit, so the onboarding session
  // is in a terminal state. `resolveEmployeeOnboardingActor()` rejects
  // non-resumable states (correct security invariant for mutation
  // surfaces §46) so we read the cookie directly and validate the
  // tenant triangle + terminal state inline.
  const cookie = await getEmployeeOnboardingSession();
  if (!cookie.sessionId || !cookie.employeeId || !cookie.clubId) {
    redirect("/hr/onboarding/expired");
  }
  const employeeId = cookie.employeeId!;
  const clubId = cookie.clubId!;
  const sessionId = cookie.sessionId!;

  const [session, credential, employee] = await Promise.all([
    prisma.employeeOnboardingSession.findFirst({
      where: { id: sessionId, employeeId, clubId },
      select: { state: true },
    }),
    prisma.employeePortalCredential.findFirst({
      where: { employeeId, clubId },
      select: { id: true },
    }),
    prisma.employee.findFirst({
      where: { id: employeeId, clubId },
      select: { id: true, clubId: true },
    }),
  ]);
  // Tenant-triangle check.
  if (!session || !employee || employee.clubId !== clubId) {
    redirect("/hr/onboarding/expired");
  }
  if (!credential) redirect("/hr/onboarding/portal-password");
  const terminal = session.state === "SUBMITTED" || session.state === "APPROVED" || session.state === "REJECTED";
  if (!terminal) redirect("/hr/onboarding/session");

  await establishEmployeePortalSession({ employeeId, clubId });
  await audit(null, {
    action: "employee_portal.handoff_from_onboarding",
    entityType: "EmployeePortalCredential",
    entityId: employeeId,
    clubId,
  });
  redirect("/employee");
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

export async function employeePortalLogoutAction(): Promise<void> {
  await destroyEmployeePortalSession();
  redirect("/employee/login");
}
