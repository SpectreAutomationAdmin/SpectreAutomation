// HR-2B.5 §7-8, §41 (2026-08-19) — Employee Portal permanent session cookie.
//
// Third principal kind in the app:
//   1. Admin User        — `spectre_session` cookie, Principal, admin surfaces
//   2. Onboarding actor  — `spectre_hr_onboarding` cookie, temporary
//   3. Employee Portal   — `spectre_employee_session` cookie (this file),
//                          permanent, gates `/employee/**`
//
// Follows the same iron-session scaffolding as sessions.ts +
// employee-onboarding-session.ts. Distinct cookie name so the admin
// layout guard cannot accidentally admit an employee (§6) and the
// onboarding session cannot mutate into a permanent portal login.
//
// Payload is minimal: only the two identifiers needed to authorise a
// portal read. Every DB access still tenants on clubId, and every
// employee-owned row is checked against employeeId.

import { cookies } from "next/headers";
import { getIronSession } from "iron-session";
import { env } from "./env";

const COOKIE_NAME = "spectre_employee_session";
const SEVEN_DAYS_SECONDS = 60 * 60 * 24 * 7;

export interface EmployeePortalPrincipal {
  employeeId: string;
  clubId: string;
  /** Rotated on every explicit logout so a leaked cookie can be
   *  invalidated by bumping this counter. Stored on the credential
   *  row when we start tracking rotations; for HR-2B.5 landing we
   *  keep a stub value for future forward-compat. */
  generation: number;
  /** When the employee established this session. Used only for
   *  telemetry / debugging; auth decisions read the credential row. */
  establishedAt: string;
}

export interface EmployeePortalSessionData {
  principal?: EmployeePortalPrincipal;
}

const SESSION_OPTIONS = {
  cookieName: COOKIE_NAME,
  password: env.SPECTRE_SESSION_SECRET,
  cookieOptions: {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SEVEN_DAYS_SECONDS,
  },
};

/** Fetch the current Employee Portal principal, or null. Never
 *  throws — an absent cookie is a routine unauthenticated state. */
export async function getEmployeePortalPrincipal(): Promise<EmployeePortalPrincipal | null> {
  const store = await cookies();
  const session = await getIronSession<EmployeePortalSessionData>(store, SESSION_OPTIONS);
  return session.principal ?? null;
}

/** Establish the cookie. Called by the login route + the
 *  post-onboarding-submission handoff (§31). */
export async function establishEmployeePortalSession(input: {
  employeeId: string;
  clubId: string;
}): Promise<void> {
  const store = await cookies();
  const session = await getIronSession<EmployeePortalSessionData>(store, SESSION_OPTIONS);
  session.principal = {
    employeeId: input.employeeId,
    clubId: input.clubId,
    generation: 1,
    establishedAt: new Date().toISOString(),
  };
  await session.save();
}

/** Clear the cookie. Called by the portal Sign Out action. */
export async function destroyEmployeePortalSession(): Promise<void> {
  const store = await cookies();
  const session = await getIronSession<EmployeePortalSessionData>(store, SESSION_OPTIONS);
  session.destroy();
}
