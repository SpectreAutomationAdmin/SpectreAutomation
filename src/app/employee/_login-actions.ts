// HR-2B.5 §7-9, §31 (2026-08-19) — Employee Portal login actions.
//
// Two server actions:
//   - employeePortalLoginAction: form-driven sign-in from /employee/login.
//   - handoffFromOnboardingAction: consumed by /employee/login/handoff-from-onboarding
//     to stamp the permanent employee cookie right after the employee's
//     Submit on the onboarding Review page (§31).
//
// Club is resolved from the current request host (`getActiveBranding()`
// →  `resolveClubByHost`) so cross-club logins with the same employee
// number can't succeed (§8). The verifyPortalPassword service is the
// second defence — it always tenants by clubId + employeeNumber.

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { hashEmail } from "@/lib/security/auth-guard";
import { consumeRate } from "@/lib/security/rate-limit";
import { RateLimitError } from "@/lib/errors";
import { getRequestContext } from "@/lib/request-context";
import { verifyPortalPassword } from "@/lib/hr/employee-portal-credential";
import {
  establishEmployeePortalSession,
  destroyEmployeePortalSession,
} from "@/lib/employee-portal-session";
import { getEmployeeOnboardingSession } from "@/lib/hr/employee-onboarding-session";
import { getActiveBranding } from "@/lib/branding";

function withErr(path: string, safeMessage: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}err=${encodeURIComponent(safeMessage)}`;
}

async function resolveClubForRequest(): Promise<string | null> {
  const branding = await getActiveBranding();
  return branding.clubId ?? null;
}

// ---------------------------------------------------------------------------
// Primary login
// ---------------------------------------------------------------------------

export async function employeePortalLoginAction(formData: FormData): Promise<void> {
  const employeeNumberRaw = (formData.get("employeeNumber") as string | null) ?? "";
  const password = (formData.get("password") as string | null) ?? "";
  const employeeNumber = employeeNumberRaw.trim().toUpperCase();

  const clubId = await resolveClubForRequest();
  if (!clubId) {
    // Host doesn't map to a club — refuse without revealing whether
    // any club exists here.
    redirect(withErr("/employee/login", "Sign in is not available at this address."));
  }

  if (!employeeNumber || !password) {
    redirect(withErr("/employee/login", "Please enter your employee number and password."));
  }

  // Rate-limit per (clubId + employeeNumber) — one composite key,
  // hashed so log dumps don't leak the raw pair.
  const key = hashEmail(`${clubId}:${employeeNumber}`);
  try {
    await consumeRate("login", key);
  } catch (err) {
    if (err instanceof RateLimitError) {
      redirect(withErr("/employee/login", "Too many attempts. Please try again shortly."));
    }
    throw err;
  }

  const result = await verifyPortalPassword({ clubId: clubId!, employeeNumber, password });
  const ctx = await getRequestContext();

  if (!result) {
    // Neutral message — no enumeration signal (§9).
    await audit(null, {
      action: "employee_portal.login.failure",
      entityType: "EmployeePortalCredential",
      entityId: `${clubId}:${employeeNumber}`,
      clubId: clubId!,
      meta: { ip: ctx?.ip, userAgent: ctx?.userAgent },
    });
    redirect(withErr("/employee/login", "That employee number and password combination isn't recognised."));
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
