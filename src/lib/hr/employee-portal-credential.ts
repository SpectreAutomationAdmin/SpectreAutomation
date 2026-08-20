// HR-2B.5 (2026-08-19) — Employee Portal credential service.
//
// The employee's PERMANENT authentication credential is set during
// the "portal-password" onboarding step (§4-5) and used for every
// future Employee Portal login (§7-9).
//
// Design invariants:
//
// - Passwords are hashed with `hashPassword()` (bcrypt cost 12) from
//   the canonical `src/lib/services/auth.ts`. This service does NOT
//   invent its own crypto; it composes.
// - The plaintext password is NEVER stored, logged, audited, embedded
//   in URLs / cookies / storage / analytics, or returned in any
//   response. `establishPortalPassword` accepts it, hashes it, and
//   drops the reference before the function returns.
// - The audit trail records the credential establishment / rotation
//   as a state change (`hr.portal_credential.set`) without any
//   password-related payload.
// - The employee is NOT a User; setting a credential here does not
//   grant admin surface access. The layout guard at
//   `src/app/app/admin/layout.tsx` gates on User + ADMIN_ROLES.
//
// Fail-secure discipline:
//
// - `verifyPortalPassword` never distinguishes "unknown employee"
//   from "wrong password" via error signature; both return `null`.
//   Callers use a constant-time bcrypt compare against a stable
//   dummy hash on the unknown-employee branch to keep response time
//   uniform (§9).
// - AccountLock escalates identically to the admin login flow:
//   `failedAttemptCount` climbs on each failure; `lockedUntil` is
//   set at 5 (15 min) and 10 (60 min) attempts. See admin login for
//   the reference flow.

import bcrypt from "bcryptjs";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { assertTenantOwned } from "../services/tenant";
import { hashPassword } from "../services/auth";
import { NotFoundError, ValidationError } from "../errors";
import type { Principal } from "../rbac";
import type { EmployeeOnboardingActor } from "./employee-actor";

const PORTAL_ENTITY = "EmployeePortalCredential";

// Match the canonical policy in services/auth.ts. Slightly more
// generous minimum + explicit password-manager-friendly ceiling.
export const PORTAL_PASSWORD_MIN = 10;
export const PORTAL_PASSWORD_MAX = 256;

// Stable dummy hash used on the unknown-employee branch of
// verifyPortalPassword so response time doesn't leak enumeration
// signal. Generated once at module load; a wrong-password compare
// against it always fails but takes ~identical wall-time to a real
// bcrypt.compare.
const DUMMY_HASH = bcrypt.hashSync("________________unused-dummy-for-timing", 12);

function normalisePassword(input: string): string {
  if (typeof input !== "string") {
    throw new ValidationError([{ path: "password", message: "Password is required" }]);
  }
  if (input.length < PORTAL_PASSWORD_MIN) {
    throw new ValidationError([
      { path: "password", message: `Password must be at least ${PORTAL_PASSWORD_MIN} characters` },
    ]);
  }
  if (input.length > PORTAL_PASSWORD_MAX) {
    throw new ValidationError([
      { path: "password", message: `Password must be at most ${PORTAL_PASSWORD_MAX} characters` },
    ]);
  }
  // Do NOT trim or otherwise mutate — passphrases with leading /
  // trailing spaces are legitimate; password managers may paste them.
  return input;
}

// ---------------------------------------------------------------------------
// Employee-side (during onboarding) — establish or rotate the credential.
// ---------------------------------------------------------------------------

export interface EstablishPortalPasswordInput {
  password: string;
  confirmPassword: string;
}

/**
 * Called from the "portal-password" onboarding step (§4). The employee is
 * authenticated via their temporary onboarding session (EmployeeOnboardingActor).
 *
 * - Upserts the credential row (rotation-safe: employees who resume
 *   the step re-set their password rather than blocking).
 * - Never stores or logs the plaintext. Audit payload contains
 *   provenance only — actor, timestamp, whether it was create vs
 *   rotate — never any password-derived value.
 */
export async function establishPortalPassword(
  actor: EmployeeOnboardingActor,
  input: EstablishPortalPasswordInput,
): Promise<{ established: boolean; rotated: boolean }> {
  if (input.password !== input.confirmPassword) {
    throw new ValidationError([
      { path: "confirmPassword", message: "Passwords do not match" },
    ]);
  }
  const password = normalisePassword(input.password);
  const employee = await prisma.employee.findFirst({
    where: { id: actor.employeeId, clubId: actor.clubId },
    select: { id: true, clubId: true },
  });
  if (!employee) throw new NotFoundError("Employee", actor.employeeId);

  const hash = await hashPassword(password);

  const existing = await prisma.employeePortalCredential.findUnique({
    where: { employeeId: employee.id },
  });

  const now = new Date();
  await prisma.employeePortalCredential.upsert({
    where: { employeeId: employee.id },
    create: {
      clubId: employee.clubId,
      employeeId: employee.id,
      passwordHash: hash,
      passwordUpdatedAt: now,
    },
    update: {
      passwordHash: hash,
      passwordUpdatedAt: now,
      // Rotating a password clears any active lockout — the employee
      // proved they can pick a new one; there's no point keeping the
      // lock alive.
      failedAttemptCount: 0,
      lockedUntil: null,
    },
  });

  await audit(null, {
    action: existing ? "hr.portal_credential.rotate" : "hr.portal_credential.set",
    entityType: PORTAL_ENTITY,
    entityId: employee.id,
    clubId: employee.clubId,
    meta: { actorSource: "EMPLOYEE", employeeId: employee.id },
  });

  return { established: !existing, rotated: Boolean(existing) };
}

// ---------------------------------------------------------------------------
// Admin-side — has this employee established a portal credential yet?
// Used by Review + the profile shell so admins can see completion state.
// ---------------------------------------------------------------------------

export async function hasPortalCredential(
  principal: Principal,
  employeeId: string,
): Promise<boolean> {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, clubId: true },
  });
  if (!employee) return false;
  assertTenantOwned(employee, principal);
  const row = await prisma.employeePortalCredential.findUnique({
    where: { employeeId },
    select: { id: true },
  });
  return row !== null;
}

// ---------------------------------------------------------------------------
// Employee-actor self-check — is my credential set?
// Used by the onboarding continuation resolver.
// ---------------------------------------------------------------------------

export async function selfHasPortalCredential(
  actor: EmployeeOnboardingActor,
): Promise<boolean> {
  const row = await prisma.employeePortalCredential.findFirst({
    where: { employeeId: actor.employeeId, clubId: actor.clubId },
    select: { id: true },
  });
  return row !== null;
}

// ---------------------------------------------------------------------------
// Portal-login-time — verify a supplied password.
// ---------------------------------------------------------------------------

export interface VerifyPortalPasswordInput {
  clubId: string;
  employeeNumber: string;
  password: string;
}

export interface VerifyPortalPasswordSuccess {
  employeeId: string;
  clubId: string;
}

/**
 * Verify a login attempt. Returns the employee id + club id on
 * success or null on any failure (unknown employee, missing
 * credential, wrong password, currently locked). Callers layer
 * rate-limiting + AccountLock updates around this — see the portal
 * login route.
 *
 * Constant-time discipline: the dummy-hash compare on the
 * unknown-employee branch means wrong-employee attempts take
 * ~identical wall-time to wrong-password attempts, resisting
 * enumeration.
 */
export async function verifyPortalPassword(
  input: VerifyPortalPasswordInput,
): Promise<VerifyPortalPasswordSuccess | null> {
  const number = input.employeeNumber.trim().toUpperCase();
  if (!input.clubId || !number || !input.password) return null;

  const employee = await prisma.employee.findFirst({
    where: { clubId: input.clubId, employeeNumber: number },
    select: {
      id: true,
      clubId: true,
      portalCredential: {
        select: {
          id: true,
          passwordHash: true,
          lockedUntil: true,
          failedAttemptCount: true,
        },
      },
    },
  });

  const credential = employee?.portalCredential ?? null;
  const now = new Date();

  if (!credential) {
    // No such employee or no credential set. Burn a constant-time
    // compare against the dummy hash to keep response time uniform.
    await bcrypt.compare(input.password, DUMMY_HASH);
    return null;
  }

  if (credential.lockedUntil && credential.lockedUntil > now) {
    // Locked. Same uniform-response discipline: we already did the
    // DB read; skip the compare (would leak that we FOUND a
    // credential vs unknown). Instead do the dummy compare.
    await bcrypt.compare(input.password, DUMMY_HASH);
    return null;
  }

  const ok = await bcrypt.compare(input.password, credential.passwordHash);
  if (!ok) {
    // Increment failure counter + escalate lockout at 5 / 10.
    const next = credential.failedAttemptCount + 1;
    let lockedUntil: Date | null = null;
    if (next >= 10) lockedUntil = new Date(now.getTime() + 60 * 60 * 1000); // 60 min
    else if (next >= 5) lockedUntil = new Date(now.getTime() + 15 * 60 * 1000); // 15 min
    await prisma.employeePortalCredential.update({
      where: { employeeId: employee!.id },
      data: { failedAttemptCount: next, lockedUntil },
    });
    return null;
  }

  // Success — reset counters + mark login.
  await prisma.employeePortalCredential.update({
    where: { employeeId: employee!.id },
    data: { failedAttemptCount: 0, lockedUntil: null, lastLoginAt: now },
  });
  return { employeeId: employee!.id, clubId: employee!.clubId };
}
