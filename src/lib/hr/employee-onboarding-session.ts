// HR-2B.1 (2026-08-18) — Employee-onboarding session cookie.
//
// An invited employee is NOT a Spectre administrative User. They redeem
// a single-use invitation, then get a scoped iron-session cookie that
// authenticates them ONLY against their own onboarding session, ONLY
// for HR-2B onboarding flows. Distinct cookie from the admin session
// (different cookie name, different data shape). Same iron-session
// library, same encryption key — Spectre operates one signing secret.
//
// The cookie carries the MINIMUM identity needed to recover context:
//   - invitationId  → EmployeeOnboardingInvitation.id
//   - sessionId     → EmployeeOnboardingSession.id
//   - employeeId    → Employee.id
//   - clubId        → Club.id (tenant boundary — verified on every read)
//   - redeemedAt    → when the invitation was redeemed (for auditing)
//
// Everything else is re-read from Prisma per request so the tenant
// invariant and revocation take effect immediately. If the underlying
// session has transitioned to REVOKED / APPROVED / REJECTED, the cookie
// is stale and access should be denied at the service layer.

import { cookies } from "next/headers";
import { getIronSession, type SessionOptions } from "iron-session";
import { env } from "../env";

export const EMPLOYEE_ONBOARDING_COOKIE = "spectre_hr_onboarding";

export type EmployeeOnboardingSessionData = {
  invitationId?: string;
  sessionId?: string;
  employeeId?: string;
  clubId?: string;
  redeemedAt?: string; // ISO
  generation?: number;
};

export const EMPLOYEE_ONBOARDING_SESSION_OPTIONS: SessionOptions = {
  cookieName: EMPLOYEE_ONBOARDING_COOKIE,
  password: env.SPECTRE_SESSION_SECRET,
  cookieOptions: {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    // HR-2B.3.4 (2026-08-18) — path=`/` rather than `/hr`.
    //
    // Root cause of the founder's void-cheque upload failure: the
    // employee-facing self-service API endpoints live under
    // `/api/hr/onboarding/self/…`. A cookie scoped to `path: "/hr"`
    // is NEVER sent by the browser to `/api/…` requests, so
    // `resolveEmployeeOnboardingActor()` saw no cookie and refused
    // the upload with "Your onboarding session is no longer active".
    // The classic "Server Actions on /hr/* work, fetch to /api/hr/*
    // does not" divergence.
    //
    // Security invariants preserved:
    //   • httpOnly + Secure + SameSite=Lax + iron-session-encrypted
    //     with SPECTRE_SESSION_SECRET.
    //   • `path: "/hr"` was cosmetic defense-in-depth — it never
    //     prevented an admin route from EXAMINING the cookie
    //     (same-origin, same JS environment), it only limited which
    //     paths the browser SENT it to.
    //   • The actual security boundary is `resolveEmployeeOnboardingActor()`
    //     which re-validates the {clubId, employeeId, sessionId,
    //     invitationId} triangle against Prisma on every request.
    //   • The employee-onboarding resolver is imported ONLY under
    //     HR onboarding code — no admin path ever accidentally
    //     consumes this session.
    path: "/",
    // Match the default invitation TTL. Save-and-return works within
    // this window; after expiry, the employee needs a new invitation.
    maxAge: 60 * 60 * 24 * 7, // 7 days
  },
};

export async function getEmployeeOnboardingSession() {
  return getIronSession<EmployeeOnboardingSessionData>(
    cookies(),
    EMPLOYEE_ONBOARDING_SESSION_OPTIONS,
  );
}

/** Stamp the cookie after a successful invitation redemption. */
export async function establishEmployeeOnboardingSession(args: {
  invitationId: string;
  sessionId: string;
  employeeId: string;
  clubId: string;
}) {
  const session = await getEmployeeOnboardingSession();
  session.invitationId = args.invitationId;
  session.sessionId = args.sessionId;
  session.employeeId = args.employeeId;
  session.clubId = args.clubId;
  session.redeemedAt = new Date().toISOString();
  session.generation = (session.generation ?? 0) + 1;
  await session.save();
}

/** Clear the cookie (used on submission or abandonment). */
export async function clearEmployeeOnboardingSession() {
  const session = await getEmployeeOnboardingSession();
  session.destroy();
}
