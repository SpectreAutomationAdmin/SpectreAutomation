// HR-1 (2026-08-16) — EmployeeSensitiveIdentity service (SIN storage
// + reveal).
//
// Contract:
//   - `upsertSin`  : requires `hr:sin:write`   + sensitive-action guard.
//                    Encrypts plaintext under KMS scope="HR". Persists
//                    ciphertext blob + sinLastThree ONLY. Audit payload
//                    carries the masked helper, never plaintext.
//   - `getSinMasked`: requires `hr:sin:read`. Returns the masked helper
//                    ("XXX XXX 123") or null when no row exists. Reads
//                    are NOT audited (see HR pin
//                    `hr-mutation-action-strings.test.ts` — read-only
//                    helpers must not audit under this domain).
//   - `revealSin`  : requires `hr:sin:reveal` + sensitive-action guard.
//                    Decrypts and returns plaintext to the caller.
//                    Audit payload carries the masked helper only.
//   - `clearSin`   : requires `hr:sin:write`  + sensitive-action guard.
//                    Deletes the row. Audit carries the masked helper
//                    of the pre-delete value.
//
// Every path goes through `requirePermission` (permission key checks
// only — no role-based branching; enforced by
// `tests/hr/hr-services-no-role-checks.test.ts`).
//
// Every mutation calls `assertSensitiveActionAllowed` (NEVER
// `assertPostingAllowed`); SIN reveal is not a financial posting.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { AppError, NotFoundError, ValidationError } from "../errors";
import { assertSensitiveActionAllowed } from "../posting-guard";
import { encryptSecret, decryptSecret } from "../kms";
import { sinFingerprint as computeSinFingerprint } from "../kms/keyed-fingerprint";
import { maskSin } from "../masking";

const SIN_ENTITY = "EmployeeSensitiveIdentity";

// Canadian SIN is exactly 9 digits. We accept an input that may carry
// separators (spaces / dashes) and strip them before validating +
// storing.
function normaliseSin(input: string): string {
  if (typeof input !== "string") {
    throw new ValidationError([{ path: "sin", message: "SIN must be a string" }]);
  }
  const stripped = input.replace(/[\s\-]/g, "");
  if (!/^\d{9}$/.test(stripped)) {
    throw new ValidationError([{ path: "sin", message: "SIN must be exactly 9 digits" }]);
  }
  return stripped;
}

function sinRef(employeeId: string): string {
  return `sin:${employeeId}`;
}

async function loadEmployee(principal: Principal, employeeId: string) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) throw new NotFoundError("Employee", employeeId);
  assertTenantOwned(employee, principal);
  return employee;
}

/**
 * Create or update the SIN on file for an employee. Returns only the
 * masked helper suffix (last-three); the plaintext leaves the function
 * scope encrypted.
 */
export async function upsertSin(
  principal: Principal,
  employeeId: string,
  plaintextSin: string,
): Promise<{ sinLastThree: string }> {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:sin:write");
  await assertSensitiveActionAllowed(
    principal,
    employee.clubId,
    "hr.sin.write.update",
    SIN_ENTITY,
    employeeId,
  );

  const normalised = normaliseSin(plaintextSin);
  const sinLastThree = normalised.slice(-3);
  // HR mobile-hotfix (2026-08-30) — deterministic keyed fingerprint
  // for duplicate detection. See src/lib/kms/keyed-fingerprint.ts.
  const fp = computeSinFingerprint(normalised);

  // Duplicate check: refuse if ANOTHER employee in the same Club
  // already owns this SIN fingerprint. Same-employee update is
  // fine (the DB unique key catches truly-conflicting writes as a
  // second line of defence). Neutral error message on the wire —
  // no PII, no linking to the other employee (§13).
  const collision = await prisma.employeeSensitiveIdentity.findFirst({
    where: {
      clubId: employee.clubId,
      sinFingerprint: fp,
      NOT: { employeeId },
    },
    select: { id: true },
  });
  if (collision) {
    throw new AppError(
      "HR_SIN_DUPLICATE",
      "Duplicate SIN detected within the club",
      409,
      "We couldn't save this SIN. Please check the number or contact the Club office.",
    );
  }

  const ciphertext = await encryptSecret({
    scope: "HR",
    secretReference: sinRef(employeeId),
    plaintext: normalised,
    clubId: employee.clubId,
    actorUserId: principal.id,
  });

  const before = await prisma.employeeSensitiveIdentity.findUnique({
    where: { employeeId },
    select: { sinLastThree: true },
  });

  const updated = await prisma.employeeSensitiveIdentity.upsert({
    where: { employeeId },
    update: { sinSecretRef: ciphertext, sinLastThree, sinFingerprint: fp },
    create: {
      clubId: employee.clubId,
      employeeId,
      sinSecretRef: ciphertext,
      sinLastThree,
      sinFingerprint: fp,
    },
  });

  await audit(principal, {
    action: "hr.sin.write.update",
    entityType: SIN_ENTITY,
    entityId: updated.id,
    clubId: employee.clubId,
    before: before ? { sinLastThree: before.sinLastThree } : null,
    after: { sinLastThree: updated.sinLastThree },
  });

  // HR mobile-hotfix (2026-08-30) §3 — notify HR admins with sin:read
  // that this record changed. Copy is neutral (no digits / fingerprint).
  const { notifyHrChangeByEmployeeId } = await import("./notify-hr-change");
  await notifyHrChangeByEmployeeId(employee.clubId, employeeId, "sin_updated", "STAFF");

  return { sinLastThree };
}

/**
 * Return the masked SIN ("XXX XXX 123") if a row exists. Read-only —
 * NOT audited. Requires `hr:sin:read`.
 */
export async function getSinMasked(
  principal: Principal,
  employeeId: string,
): Promise<string | null> {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:sin:read");
  const row = await prisma.employeeSensitiveIdentity.findUnique({
    where: { employeeId },
    select: { sinLastThree: true },
  });
  if (!row || !row.sinLastThree) return null;
  return maskSin(row.sinLastThree);
}

/**
 * Reveal the plaintext SIN. Audited with masked payload only —
 * plaintext MUST NOT appear in any audit column. Requires
 * `hr:sin:reveal` and passes through the sensitive-action gate.
 */
export async function revealSin(
  principal: Principal,
  employeeId: string,
): Promise<string> {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:sin:reveal");
  await assertSensitiveActionAllowed(
    principal,
    employee.clubId,
    "hr.sin.reveal.issue",
    SIN_ENTITY,
    employeeId,
  );

  const row = await prisma.employeeSensitiveIdentity.findUnique({ where: { employeeId } });
  if (!row) throw new NotFoundError(SIN_ENTITY, employeeId);
  assertTenantOwned(row, principal);

  const plaintext = await decryptSecret({
    scope: "HR",
    secretReference: sinRef(employeeId),
    ciphertext: row.sinSecretRef,
    clubId: row.clubId,
    actorUserId: principal.id,
  });

  await audit(principal, {
    action: "hr.sin.reveal.issue",
    entityType: SIN_ENTITY,
    entityId: row.id,
    clubId: row.clubId,
    // Ciphertext + masked helper only. No plaintext, no `sin` key
    // (audit's SENSITIVE_KEYS redacts `sin` but we do not rely on it).
    meta: { sinLastThree: row.sinLastThree ?? null },
  });

  return plaintext;
}

/**
 * Remove the SIN on file. Audit carries the last-three of the pre-
 * delete value only.
 */
export async function clearSin(
  principal: Principal,
  employeeId: string,
): Promise<void> {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:sin:write");
  await assertSensitiveActionAllowed(
    principal,
    employee.clubId,
    "hr.sin.write.delete",
    SIN_ENTITY,
    employeeId,
  );

  const existing = await prisma.employeeSensitiveIdentity.findUnique({
    where: { employeeId },
  });
  if (!existing) return;
  assertTenantOwned(existing, principal);

  await prisma.employeeSensitiveIdentity.delete({ where: { employeeId } });
  await audit(principal, {
    action: "hr.sin.write.delete",
    entityType: SIN_ENTITY,
    entityId: existing.id,
    clubId: existing.clubId,
    before: { sinLastThree: existing.sinLastThree },
    after: null,
  });
}
