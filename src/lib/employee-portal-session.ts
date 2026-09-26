// AUTH-2 (2026-09-26) — server-side session authority for the Employee
// Portal.
//
// Cookie payload changes from AUTH-1 `{ principal: { employeeId, clubId,
// generation:1, establishedAt } }` (self-contained portable credential)
// to `{ v: 2, sid }` (opaque bearer reference). The authoritative
// record lives in the Session table (surface = "EMPLOYEE").
//
// AUTH-1 gap fixed here: `getEmployeePortalPrincipal()` previously only
// decrypted the cookie and returned the payload — no DB check. AUTH-2's
// helper validates:
//   1. Session row (unrevoked, unexpired, EMPLOYEE surface)
//   2. Employee row (exists, matches session.employeeId + session.clubId)
//   3. Employee access matrix (see EMPLOYEE_PORTAL_ACCESS_MATRIX below)
//
// Legacy AUTH-1 cookies (containing `principal` but no `sid`) are
// rejected — they cannot be auto-upgraded into new server-side
// sessions, otherwise the exact portability problem AUTH-2 solves
// would persist. Existing staging portal users are signed out once.
//
// HR-2B.5 semantics remain intact:
//   §7 white-label brand shielding — this file does not surface
//       "Spectre" identity; that is the login page's concern.
//   §8 club-scoped auth — the session carries authoritative clubId.
//   §9 rate-limit + AccountLock — enforced in the login action, not
//       here. Session revocation is the AUTH-2 addition on top.

import { cookies } from "next/headers";
import { getIronSession } from "iron-session";
import { env } from "./env";
import { prisma } from "./prisma";
import {
  createSession as storeCreateSession,
  findValidSession,
  revokeSession as storeRevokeSession,
  touchSession,
  SURFACE_EMPLOYEE,
} from "./services/session-store";

const COOKIE_NAME = "spectre_employee_session";
const SEVEN_DAYS_SECONDS = 60 * 60 * 24 * 7;

/** Public principal shape — unchanged from AUTH-1 for downstream
 *  callers. Fields are now populated from the authoritative Session
 *  record and re-verified Employee row per request. */
export interface EmployeePortalPrincipal {
  employeeId: string;
  clubId: string;
  /** AUTH-1 cosmetic counter, preserved for API compatibility. AUTH-2
   *  uses Session.revokedAt as the real revocation vector. */
  generation: number;
  /** Session creation moment; used only for telemetry. */
  establishedAt: string;
  /** AUTH-2 internal — the Session DB id, so the logout route can
   *  revoke the specific row. NOT for feature code. */
  __sessionId?: string;
}

/** Cookie payload after AUTH-2. */
interface EmployeeCookieV2 {
  v: 2;
  sid: string;
}

/** Iron-session cookie may contain both AUTH-2 and legacy AUTH-1 keys.
 *  AUTH-1 payload is read only for detection; never trusted. */
interface EmployeeCookieShape {
  v?: number;
  sid?: string;
  // AUTH-1 legacy
  principal?: {
    employeeId?: string;
    clubId?: string;
    generation?: number;
    establishedAt?: string;
  };
}

const SESSION_OPTIONS = {
  cookieName: COOKIE_NAME,
  password: env.SPECTRE_SESSION_SECRET,
  cookieOptions: {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    // AUTH-2B.2 (2026-09-26): cookie path restored to "/" from the
    // AUTH-2 experimental "/employee" narrowing. The narrower path
    // stopped the browser from sending the cookie on legitimate
    // cross-path fetches the Employee Portal depends on — the hero
    // image (/api/clubs/[id]/employee-portal-hero), quick-link file
    // downloads, profile-photo, tour-completed, training video, pay-
    // statement PDF, all under /api/*. AUTH-2's real security
    // boundary is the DB-authoritative Session with surface check +
    // sha256 tokenHash + fail-closed lookup + revocability
    // (session-store.findValidSession) — that primary boundary is
    // unchanged and the surface check refuses an employee cookie on
    // any admin surface (and vice versa). The httpOnly + sameSite=lax
    // + secure attributes remain intact so the cookie is not readable
    // by JS and is not sent on cross-site requests.
    path: "/",
    maxAge: SEVEN_DAYS_SECONDS,
  },
};

// ============================================================================
// ACCESS MATRIX
// ============================================================================
//
// Which (Employee.status, Employee.employeeLifecycle) combinations may
// authenticate to the Employee Portal?
//
// Status values (validated in src/lib/hr/employees.ts):
//   ACTIVE     — normal
//   INACTIVE   — administrative pause
//   LEAVE      — legacy string; new code uses employeeLifecycle for this
//   TERMINATED — permanent end of employment
//
// Lifecycle values (validated in src/lib/hr/employees.ts):
//   PRE_HIRE   — invited / onboarding, not yet activated by admin
//   ACTIVE     — activated employee
//   LEAVE      — parental / medical / statutory leave
//   TERMINATED — permanent end of employment
//
// Rules:
//   ACTIVE + ACTIVE → portal allowed (baseline case)
//   ACTIVE + LEAVE  → portal allowed (must access pay statements,
//                     benefits, T4/T4A, HR documents while on leave)
//   ACTIVE + PRE_HIRE → DENIED. Pre-hire actors use the separate
//                       onboarding session (spectre_hr_onboarding),
//                       not the portal session.
//   * + TERMINATED    → DENIED.
//   TERMINATED + *    → DENIED.
//   INACTIVE + *      → DENIED. Administratively inactivated.
//
// This matrix is stricter than the AUTH-1 layout guard, which rejected
// only TERMINATED. That gap is exactly the AUTH-1 finding this method
// closes.
// ============================================================================

const ALLOWED_STATUS = new Set(["ACTIVE"]);
const ALLOWED_LIFECYCLE = new Set(["ACTIVE", "LEAVE"]);

export function isPortalEligible(status: string, lifecycle: string): boolean {
  return ALLOWED_STATUS.has(status) && ALLOWED_LIFECYCLE.has(lifecycle);
}

// ============================================================================
// PUBLIC API
// ============================================================================

async function getCookie() {
  const store = await cookies();
  return getIronSession<EmployeeCookieShape>(store, SESSION_OPTIONS);
}

/** Fetch the current Employee Portal principal, or null. Fully
 *  DB-validated — no cookie payload is trusted. */
export async function getEmployeePortalPrincipal(): Promise<EmployeePortalPrincipal | null> {
  const cookie = await getCookie();
  const bearer = cookie.v === 2 && typeof cookie.sid === "string" ? cookie.sid : undefined;
  if (!bearer) return null;
  const session = await findValidSession(bearer, SURFACE_EMPLOYEE);
  if (!session || !session.employeeId) return null;
  // Employee sessions MUST have a non-null clubId (enforced at
  // createSession()). If somehow one landed with a null clubId,
  // reject fail-closed.
  if (!session.clubId) return null;
  // Re-validate the employee record against the session's identity
  // AND tenant. Two independent claims must both match.
  const employee = await prisma.employee.findFirst({
    where: { id: session.employeeId, clubId: session.clubId },
    select: { id: true, clubId: true, status: true, employeeLifecycle: true },
  });
  if (!employee) return null;
  if (!isPortalEligible(employee.status, employee.employeeLifecycle)) return null;
  // Best-effort throttled last-seen update.
  void touchSession(session.id);
  return {
    employeeId: employee.id,
    clubId: employee.clubId,
    generation: 1,
    establishedAt: session.createdAt.toISOString(),
    __sessionId: session.id,
  };
}

/** Establish the cookie. Called by the login route + the post-onboarding
 *  submission handoff. Creates a fresh Session row (session-fixation
 *  safe) and writes the bearer to the cookie. */
export async function establishEmployeePortalSession(input: {
  employeeId: string;
  clubId: string;
  uaAtCreate?: string;
  ipAtCreate?: string;
}): Promise<void> {
  const cookie = await getCookie();
  // Session fixation: revoke any pre-existing bearer this cookie held.
  if (cookie.v === 2 && typeof cookie.sid === "string") {
    const prior = await findValidSession(cookie.sid, SURFACE_EMPLOYEE);
    if (prior) {
      await storeRevokeSession(prior.id, {
        revokedBy: input.employeeId,
        reason: "reauth",
      });
    }
  }
  const { bearer } = await storeCreateSession({
    surface: SURFACE_EMPLOYEE,
    employeeId: input.employeeId,
    clubId: input.clubId,
    uaAtCreate: input.uaAtCreate,
    ipAtCreate: input.ipAtCreate,
  });
  cookie.v = 2;
  cookie.sid = bearer;
  delete cookie.principal;
  await cookie.save();
}

/** Clear the cookie AND revoke the server-side Session. Called by the
 *  portal Sign Out action. */
export async function destroyEmployeePortalSession(): Promise<void> {
  const cookie = await getCookie();
  if (cookie.v === 2 && typeof cookie.sid === "string") {
    const session = await findValidSession(cookie.sid, SURFACE_EMPLOYEE);
    if (session) {
      await storeRevokeSession(session.id, { revokedBy: "self", reason: "logout" });
    }
  }
  cookie.destroy();
}
