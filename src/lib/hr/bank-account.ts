// HR-1 (2026-08-16) — EmployeeBankAccount service (direct-deposit
// banking storage + reveal + activation).
//
// Contract:
//   - Three ciphertext blobs per row (institution / transit / account),
//     all under KMS scope="HR". `accountLastFour` + `holderName` are
//     the only render-safe columns.
//   - `upsertBankAccount`: `hr:banking:write` + sensitive-action guard.
//     Encrypts all three fields. Resets `status` to
//     `PENDING_PENNY_TEST` on any update — activation is a distinct
//     approval step.
//   - `getBankAccountMasked`: `hr:banking:read`. Returns masked helper
//     ("•••• 4567") + holderName + status. Not audited.
//   - `revealBankAccount`: `hr:banking:reveal` + sensitive-action
//     guard. Returns plaintext {institution, transit, account}. Audit
//     payload carries only the masked helper + accountLastFour.
//   - `activateBankAccount`: `hr:banking:approve` + sensitive-action
//     guard on action `hr.bank.approve.post`. Sets status=VERIFIED,
//     activatedAt=now. Refuses activation on rows already VERIFIED or
//     REJECTED.
//   - `rejectBankAccount`: `hr:banking:approve` + sensitive-action
//     guard. Sets status=REJECTED. Same guardrails.
//   - `deactivateBankAccount`: `hr:banking:approve` + sensitive-action
//     guard. Sets status=INACTIVE. Used when the employee changes
//     accounts or terminates.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../errors";
import { assertSensitiveActionAllowed } from "../posting-guard";
import { encryptSecret, decryptSecret } from "../kms";
import { bankFingerprint as computeBankFingerprint } from "../kms/keyed-fingerprint";
import { maskBankAccount } from "../masking";

const BANK_ENTITY = "EmployeeBankAccount";

// Canadian direct-deposit numbers:
//   - institution: 3 digits
//   - transit    : 5 digits
//   - account    : 7-12 digits (bank-specific)
function normaliseDigits(input: string, expectedLen: number | { min: number; max: number }, field: string): string {
  if (typeof input !== "string") {
    throw new ValidationError([{ path: field, message: `${field} must be a string` }]);
  }
  const stripped = input.replace(/[\s\-]/g, "");
  if (!/^\d+$/.test(stripped)) {
    throw new ValidationError([{ path: field, message: `${field} must be digits only` }]);
  }
  if (typeof expectedLen === "number") {
    if (stripped.length !== expectedLen) {
      throw new ValidationError([{ path: field, message: `${field} must be exactly ${expectedLen} digits` }]);
    }
  } else {
    if (stripped.length < expectedLen.min || stripped.length > expectedLen.max) {
      throw new ValidationError([{ path: field, message: `${field} must be ${expectedLen.min}-${expectedLen.max} digits` }]);
    }
  }
  return stripped;
}

// KMS secret references are keyed off employeeId. Historical rows are
// retained (INACTIVE / REJECTED); the "current" row is the sole row
// in a non-terminal status (PENDING_PENNY_TEST or VERIFIED). HR-1H
// (2026-08-16) adds a Postgres+SQLite partial unique index enforcing
// at most one VERIFIED row per employee at the DB level — see
// prisma-postgres/migrations/20260817_hr1h_banking_verified_partial_unique.
function institutionRef(employeeId: string) { return `bank:${employeeId}:institution`; }
function transitRef(employeeId: string) { return `bank:${employeeId}:transit`; }
function accountRef(employeeId: string) { return `bank:${employeeId}:account`; }

const NON_TERMINAL_STATUSES = ["PENDING_PENNY_TEST", "VERIFIED"] as const;

async function findCurrentBank(employeeId: string) {
  return prisma.employeeBankAccount.findFirst({
    where: { employeeId, status: { in: [...NON_TERMINAL_STATUSES] } },
    orderBy: { updatedAt: "desc" },
  });
}

async function loadEmployee(principal: Principal, employeeId: string) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) throw new NotFoundError("Employee", employeeId);
  assertTenantOwned(employee, principal);
  return employee;
}

export interface BankAccountInput {
  institutionNumber: string;
  transitNumber: string;
  accountNumber: string;
  holderName: string;
}

/**
 * Create or update the direct-deposit banking record for an employee.
 * The row is (re-)created in PENDING_PENNY_TEST status — an explicit
 * `activateBankAccount` call is required before payroll may run
 * against it.
 */
export async function upsertBankAccount(
  principal: Principal,
  employeeId: string,
  input: BankAccountInput,
): Promise<{ id: string; accountLastFour: string; status: string }> {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:banking:write");
  await assertSensitiveActionAllowed(
    principal,
    employee.clubId,
    "hr.bank.write.update",
    BANK_ENTITY,
    employeeId,
  );

  const institution = normaliseDigits(input.institutionNumber, 3, "institutionNumber");
  const transit = normaliseDigits(input.transitNumber, 5, "transitNumber");
  const account = normaliseDigits(input.accountNumber, { min: 7, max: 12 }, "accountNumber");
  const holderName = (input.holderName ?? "").trim();
  if (!holderName || holderName.length < 2) {
    throw new ValidationError([{ path: "holderName", message: "holderName must be at least 2 characters" }]);
  }
  const accountLastFour = account.slice(-4);
  // HR mobile-hotfix (2026-08-30) — keyed fingerprint for duplicate
  // detection. See src/lib/kms/keyed-fingerprint.ts.
  const fp = computeBankFingerprint({ institution, transit, account });

  // Duplicate check: refuse if ANOTHER employee in the same Club
  // already has an ACTIVE (PENDING or VERIFIED) row with the same
  // fingerprint. Same-employee history is allowed (an employee may
  // legitimately re-enter their old account). Neutral error copy
  // (§16). DB partial-unique index defends against races.
  const activeCollision = await prisma.employeeBankAccount.findFirst({
    where: {
      clubId: employee.clubId,
      bankFingerprint: fp,
      status: { in: ["PENDING_PENNY_TEST", "VERIFIED"] },
      NOT: { employeeId },
    },
    select: { id: true },
  });
  if (activeCollision) {
    throw new AppError(
      "HR_BANK_DUPLICATE",
      "Duplicate active payroll bank account detected within the club",
      409,
      "We couldn't save these banking details. Please check the information or contact the Club office.",
    );
  }

  const before = await findCurrentBank(employeeId);

  const institutionCipher = await encryptSecret({
    scope: "HR",
    secretReference: institutionRef(employeeId),
    plaintext: institution,
    clubId: employee.clubId,
    actorUserId: principal.id,
  });
  const transitCipher = await encryptSecret({
    scope: "HR",
    secretReference: transitRef(employeeId),
    plaintext: transit,
    clubId: employee.clubId,
    actorUserId: principal.id,
  });
  const accountCipher = await encryptSecret({
    scope: "HR",
    secretReference: accountRef(employeeId),
    plaintext: account,
    clubId: employee.clubId,
    actorUserId: principal.id,
  });

  // HR-1H history preservation:
  //   - No current row → create a fresh PENDING_PENNY_TEST.
  //   - Current row is PENDING_PENNY_TEST → update in place (typo /
  //     re-entry workflow; nothing was ever a payroll destination).
  //   - Current row is VERIFIED → move it to INACTIVE and create a
  //     new PENDING_PENNY_TEST row in one $transaction. The old row's
  //     activatedAt is preserved as historical activation timestamp.
  const updated = await (async () => {
    if (!before) {
      return prisma.employeeBankAccount.create({
        data: {
          clubId: employee.clubId,
          employeeId,
          institutionSecretRef: institutionCipher,
          transitSecretRef: transitCipher,
          accountSecretRef: accountCipher,
          accountLastFour,
          holderName,
          bankFingerprint: fp,
          status: "PENDING_PENNY_TEST",
        },
      });
    }
    if (before.status === "PENDING_PENNY_TEST") {
      return prisma.employeeBankAccount.update({
        where: { id: before.id },
        data: {
          institutionSecretRef: institutionCipher,
          transitSecretRef: transitCipher,
          accountSecretRef: accountCipher,
          accountLastFour,
          holderName,
          bankFingerprint: fp,
        },
      });
    }
    // before.status === "VERIFIED" — preserve history.
    return prisma.$transaction(async (tx) => {
      await tx.employeeBankAccount.update({
        where: { id: before.id },
        data: { status: "INACTIVE" },
      });
      return tx.employeeBankAccount.create({
        data: {
          clubId: employee.clubId,
          employeeId,
          institutionSecretRef: institutionCipher,
          transitSecretRef: transitCipher,
          accountSecretRef: accountCipher,
          accountLastFour,
          holderName,
          bankFingerprint: fp,
          status: "PENDING_PENNY_TEST",
        },
      });
    });
  })();

  await audit(principal, {
    action: "hr.bank.write.update",
    entityType: BANK_ENTITY,
    entityId: updated.id,
    clubId: employee.clubId,
    before: before
      ? {
          accountLastFour: before.accountLastFour,
          holderName: before.holderName,
          status: before.status,
          replacedRowId: before.id !== updated.id ? before.id : null,
        }
      : null,
    after: {
      accountLastFour: updated.accountLastFour,
      holderName: updated.holderName,
      status: updated.status,
    },
  });

  // HR mobile-hotfix (2026-08-30) §3 — notify HR admins with
  // banking:read that this record changed. Neutral copy (no digits /
  // no fingerprint / no coordinates).
  const { notifyHrChangeByEmployeeId } = await import("./notify-hr-change");
  await notifyHrChangeByEmployeeId(employee.clubId, employeeId, "banking_updated", "STAFF");

  return {
    id: updated.id,
    accountLastFour: updated.accountLastFour ?? accountLastFour,
    status: updated.status,
  };
}

/**
 * Return the masked banking helper. Read-only, NOT audited.
 */
export async function getBankAccountMasked(
  principal: Principal,
  employeeId: string,
): Promise<
  | {
      id: string;
      accountMasked: string;
      holderName: string;
      status: string;
      activatedAt: Date | null;
    }
  | null
> {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:banking:read");
  const row = await findCurrentBank(employeeId);
  if (!row || !row.accountLastFour) return null;
  return {
    id: row.id,
    accountMasked: maskBankAccount(row.accountLastFour),
    holderName: row.holderName,
    status: row.status,
    activatedAt: row.activatedAt,
  };
}

/**
 * Reveal plaintext banking numbers. Audit payload carries only the
 * masked helper — never institution/transit/account plaintext.
 */
export async function revealBankAccount(
  principal: Principal,
  employeeId: string,
): Promise<{
  institutionNumber: string;
  transitNumber: string;
  accountNumber: string;
  holderName: string;
}> {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:banking:reveal");
  await assertSensitiveActionAllowed(
    principal,
    employee.clubId,
    "hr.bank.reveal.issue",
    BANK_ENTITY,
    employeeId,
  );

  const row = await findCurrentBank(employeeId);
  if (!row) throw new NotFoundError(BANK_ENTITY, employeeId);
  assertTenantOwned(row, principal);

  const [institutionNumber, transitNumber, accountNumber] = await Promise.all([
    decryptSecret({
      scope: "HR",
      secretReference: institutionRef(employeeId),
      ciphertext: row.institutionSecretRef,
      clubId: row.clubId,
      actorUserId: principal.id,
    }),
    decryptSecret({
      scope: "HR",
      secretReference: transitRef(employeeId),
      ciphertext: row.transitSecretRef,
      clubId: row.clubId,
      actorUserId: principal.id,
    }),
    decryptSecret({
      scope: "HR",
      secretReference: accountRef(employeeId),
      ciphertext: row.accountSecretRef,
      clubId: row.clubId,
      actorUserId: principal.id,
    }),
  ]);

  await audit(principal, {
    action: "hr.bank.reveal.issue",
    entityType: BANK_ENTITY,
    entityId: row.id,
    clubId: row.clubId,
    meta: {
      accountLastFour: row.accountLastFour ?? null,
      holderName: row.holderName,
    },
  });

  return {
    institutionNumber,
    transitNumber,
    accountNumber,
    holderName: row.holderName,
  };
}

/**
 * Activate direct-deposit for payroll. This is the "financial" write
 * inside the HR slice — sensitive-action guard on
 * `hr.bank.approve.post`. Only PENDING_PENNY_TEST rows may be
 * activated.
 */
export async function activateBankAccount(
  principal: Principal,
  employeeId: string,
): Promise<{ id: string; status: string; activatedAt: Date }> {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:banking:approve");
  await assertSensitiveActionAllowed(
    principal,
    employee.clubId,
    "hr.bank.approve.post",
    BANK_ENTITY,
    employeeId,
  );

  const row = await findCurrentBank(employeeId);
  if (!row) throw new NotFoundError(BANK_ENTITY, employeeId);
  assertTenantOwned(row, principal);
  if (row.status !== "PENDING_PENNY_TEST") {
    throw new ConflictError(`Cannot activate banking in status ${row.status}`);
  }

  const activatedAt = new Date();
  const updated = await prisma.employeeBankAccount.update({
    where: { id: row.id },
    data: { status: "VERIFIED", activatedAt },
  });

  await audit(principal, {
    action: "hr.bank.approve.post",
    entityType: BANK_ENTITY,
    entityId: row.id,
    clubId: row.clubId,
    before: { status: row.status, activatedAt: row.activatedAt },
    after: { status: updated.status, activatedAt: updated.activatedAt },
    meta: { accountLastFour: row.accountLastFour ?? null },
  });

  return { id: updated.id, status: updated.status, activatedAt: updated.activatedAt! };
}

/**
 * Reject a pending banking row (penny-test failed etc.). Sets
 * status=REJECTED.
 */
export async function rejectBankAccount(
  principal: Principal,
  employeeId: string,
  reason?: string,
): Promise<void> {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:banking:approve");
  await assertSensitiveActionAllowed(
    principal,
    employee.clubId,
    "hr.bank.approve.reject",
    BANK_ENTITY,
    employeeId,
  );

  const row = await findCurrentBank(employeeId);
  if (!row) throw new NotFoundError(BANK_ENTITY, employeeId);
  assertTenantOwned(row, principal);
  if (row.status === "REJECTED") return;

  const updated = await prisma.employeeBankAccount.update({
    where: { id: row.id },
    data: { status: "REJECTED", activatedAt: null },
  });

  await audit(principal, {
    action: "hr.bank.approve.reject",
    entityType: BANK_ENTITY,
    entityId: row.id,
    clubId: row.clubId,
    before: { status: row.status },
    after: { status: updated.status },
    meta: { reason: reason ?? null, accountLastFour: row.accountLastFour ?? null },
  });
}

/**
 * Deactivate direct-deposit (employee change / termination).
 */
export async function deactivateBankAccount(
  principal: Principal,
  employeeId: string,
): Promise<void> {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:banking:approve");
  await assertSensitiveActionAllowed(
    principal,
    employee.clubId,
    "hr.bank.approve.update",
    BANK_ENTITY,
    employeeId,
  );

  const row = await findCurrentBank(employeeId);
  if (!row) throw new NotFoundError(BANK_ENTITY, employeeId);
  assertTenantOwned(row, principal);
  if (row.status === "INACTIVE") return;

  const updated = await prisma.employeeBankAccount.update({
    where: { id: row.id },
    data: { status: "INACTIVE", activatedAt: null },
  });

  await audit(principal, {
    action: "hr.bank.approve.update",
    entityType: BANK_ENTITY,
    entityId: row.id,
    clubId: row.clubId,
    before: { status: row.status },
    after: { status: updated.status },
    meta: { accountLastFour: row.accountLastFour ?? null },
  });
}

