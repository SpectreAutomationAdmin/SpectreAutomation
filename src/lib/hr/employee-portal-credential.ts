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
//
// HR mobile-hotfix (2026-08-25): the founder-accepted username has
// changed from `employeeNumber` to the employee's canonical
// `personalEmail`. This module preserves the existing bcrypt hash +
// AccountLock architecture and swaps ONLY the identifier lookup.
//
// Case + whitespace: emails compare with `.trim().toLowerCase()`. On
// Postgres we use Prisma's `mode: "insensitive"` for a proper case-
// insensitive DB lookup. On SQLite (dev + tests) `mode: "insensitive"`
// silently degrades to case-sensitive — tests feed exact-case input
// and existing dev fixtures use lowercase emails.
//
// Cross-Club ambiguity: two employees at different Clubs may
// legitimately share the same personalEmail. Callers decide the
// resolution policy — see verifyPortalPasswordByEmail below.
// ---------------------------------------------------------------------------

/** Whitespace-trim + lowercase — the ONE canonical form used for
 *  every email comparison in the portal-login path. Never used to
 *  mutate what the employee typed as their profile email. */
export function normaliseLoginEmail(input: string | null | undefined): string {
  return (input ?? "").trim().toLowerCase();
}

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
 * @deprecated HR mobile-hotfix (2026-08-25) — Employee Portal login
 * now identifies employees by canonical email rather than employee
 * number. This function is retained ONLY so any historical caller
 * that referenced it fails loudly rather than silently. New callers
 * MUST use `verifyPortalPasswordByEmail`.
 *
 * Kept for backward-compat during transition — behaves identically
 * to the pre-hotfix implementation. Removed in a follow-up slice
 * once every caller has migrated.
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
    await bcrypt.compare(input.password, DUMMY_HASH);
    return null;
  }

  if (credential.lockedUntil && credential.lockedUntil > now) {
    await bcrypt.compare(input.password, DUMMY_HASH);
    return null;
  }

  const ok = await bcrypt.compare(input.password, credential.passwordHash);
  if (!ok) {
    const next = credential.failedAttemptCount + 1;
    let lockedUntil: Date | null = null;
    if (next >= 10) lockedUntil = new Date(now.getTime() + 60 * 60 * 1000);
    else if (next >= 5) lockedUntil = new Date(now.getTime() + 15 * 60 * 1000);
    await prisma.employeePortalCredential.update({
      where: { employeeId: employee!.id },
      data: { failedAttemptCount: next, lockedUntil },
    });
    return null;
  }

  await prisma.employeePortalCredential.update({
    where: { employeeId: employee!.id },
    data: { failedAttemptCount: 0, lockedUntil: null, lastLoginAt: now },
  });
  return { employeeId: employee!.id, clubId: employee!.clubId };
}

// ---------------------------------------------------------------------------
// New email-based verifier (2026-08-25).
// ---------------------------------------------------------------------------

export interface VerifyPortalPasswordByEmailInput {
  /** Normalised at the boundary — the caller SHOULD pass the raw
   *  form entry; this function normalises. */
  email: string;
  /** Optional Club scope. When provided (host-resolved to a Club),
   *  the lookup is restricted to that Club and cross-Club matches
   *  are impossible. When null (the shared platform host case that
   *  serves multiple Clubs), the lookup spans all Clubs and
   *  ambiguity is resolved neutrally. */
  clubId: string | null;
  password: string;
}

export type VerifyPortalPasswordByEmailResult =
  | { kind: "success"; employeeId: string; clubId: string }
  /** No employee found, wrong password, currently locked, missing
   *  credential — every failure returns the same neutral shape so
   *  the caller cannot distinguish. */
  | { kind: "not_recognised" }
  /** The normalised email matched candidates in more than one Club
   *  when no clubId scope was supplied. The caller decides whether
   *  to prompt for a Club chooser or refuse — this service does NOT
   *  silently pick a winner. */
  | { kind: "ambiguous_across_clubs"; clubIds: string[] };

/**
 * Verify a portal login attempt by canonical email. Preserves the
 * bcrypt / AccountLock / dummy-hash timing discipline of the
 * employee-number verifier.
 *
 * Resolution:
 *   1. Normalise email (trim + lowercase).
 *   2. Find all employees whose personalEmail case-insensitively
 *      equals the normalised value AND (if clubId is set) belong
 *      to that Club.
 *   3. Filter to employees who actually have a portalCredential
 *      (unset credential = same shape as unknown employee).
 *   4. If 0 candidates → dummy compare + not_recognised.
 *   5. If >1 candidates AND clubId is null → dummy compare +
 *      ambiguous_across_clubs. Caller decides.
 *   6. If 1 candidate → normal lockout + bcrypt + counter path.
 */
export async function verifyPortalPasswordByEmail(
  input: VerifyPortalPasswordByEmailInput,
): Promise<VerifyPortalPasswordByEmailResult> {
  const email = normaliseLoginEmail(input.email);
  if (!email || !input.password) {
    await bcrypt.compare(input.password ?? "", DUMMY_HASH);
    return { kind: "not_recognised" };
  }

  // Step 1-2: fetch candidates. `mode: insensitive` is Postgres-only
  // and hard-errors on SQLite (dev + test), so we take a portable
  // path instead: canonical form is enforced at write time
  // (normaliseLoginEmail-lowercase, whitespace-trimmed), and the
  // login lookup does a case-sensitive equals on the same normalised
  // form. This works on both engines with a single indexed column.
  //
  // Historical rows written before this hotfix may still carry
  // mixed-case emails; the staging preflight script normalises them
  // once. New employees + email edits are normalised through the
  // canonical write paths.
  const candidates = await prisma.employee.findMany({
    where: {
      personalEmail: email,
      ...(input.clubId ? { clubId: input.clubId } : {}),
    },
    select: {
      id: true, clubId: true,
      portalCredential: {
        select: {
          id: true, passwordHash: true, lockedUntil: true, failedAttemptCount: true,
        },
      },
    },
  });

  const withCred = candidates.filter((c) => c.portalCredential !== null);

  if (withCred.length === 0) {
    await bcrypt.compare(input.password, DUMMY_HASH);
    return { kind: "not_recognised" };
  }

  if (withCred.length > 1) {
    // Same-shape timing: burn a dummy compare so the caller-visible
    // response time doesn't reveal that multiple accounts matched.
    await bcrypt.compare(input.password, DUMMY_HASH);
    return {
      kind: "ambiguous_across_clubs",
      clubIds: withCred.map((c) => c.clubId),
    };
  }

  const employee = withCred[0]!;
  const credential = employee.portalCredential!;
  const now = new Date();

  if (credential.lockedUntil && credential.lockedUntil > now) {
    await bcrypt.compare(input.password, DUMMY_HASH);
    return { kind: "not_recognised" };
  }

  const ok = await bcrypt.compare(input.password, credential.passwordHash);
  if (!ok) {
    const next = credential.failedAttemptCount + 1;
    let lockedUntil: Date | null = null;
    if (next >= 10) lockedUntil = new Date(now.getTime() + 60 * 60 * 1000);
    else if (next >= 5) lockedUntil = new Date(now.getTime() + 15 * 60 * 1000);
    await prisma.employeePortalCredential.update({
      where: { employeeId: employee.id },
      data: { failedAttemptCount: next, lockedUntil },
    });
    return { kind: "not_recognised" };
  }

  await prisma.employeePortalCredential.update({
    where: { employeeId: employee.id },
    data: { failedAttemptCount: 0, lockedUntil: null, lastLoginAt: now },
  });
  return { kind: "success", employeeId: employee.id, clubId: employee.clubId };
}
