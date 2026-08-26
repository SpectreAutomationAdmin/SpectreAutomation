// HR mobile-hotfix (2026-08-30) §3 — Canonical HR-change notification.
//
// One entry point for the "a sensitive HR field changed" event that
// fires from:
//   * onboarding writes (updateOnboardingHomeAddress, submitSelfSin,
//     submitSelfBankAccount) — actorSource "EMPLOYEE"
//   * portal profile writes (updateSelfHomeAddress on
//     EmployeePortalPrincipal, submitSelfSin/Bank on
//     EmployeePortalPrincipal) — actorSource "EMPLOYEE"
//   * admin writes (upsertSin, upsertBankAccount, updateEmployee with
//     address fields) — actorSource "STAFF"
//
// Founder invariants:
//   1. Neutral copy — no plaintext SIN, no bank digits, no
//      fingerprints, no institution/transit coordinates.
//   2. Recipient resolution by capability (permission grant), never
//      by role name. See resolveRecipientsByPermission in rbac.ts.
//   3. Deliver via existing notify() adapter — this module is a
//      composition, not a new adapter.
//   4. Failure to notify does NOT block the underlying write.
//      A best-effort try/catch here so the write path is never
//      hostage to an outbound email issue.
//   5. HR mobile-hotfix continuation (2026-08-30): the EMPLOYEE
//      themselves also receives a confirmation notification. Two
//      audiences (employee-confirmation + admin-informational) with
//      distinct copy — see `copyForEmployee` vs `copyForAdmin`.
//      Employee delivery uses the linked User row's IN_APP inbox
//      when available; falls back to their `personalEmail` via the
//      canonical EMAIL adapter. Neither audience receives sensitive
//      values.

import { prisma } from "../prisma";
import { notify } from "../enterprise/notifications";
import { resolveRecipientsByPermission } from "../rbac";

export type HrChangeKind =
  | "home_address_updated"
  | "sin_updated"
  | "banking_updated";

export type HrChangeActorSource = "EMPLOYEE" | "STAFF" | "SYSTEM";

export interface NotifyHrChangeInput {
  clubId: string;
  employeeId: string;
  employeeDisplayName: string;
  kind: HrChangeKind;
  actorSource: HrChangeActorSource;
  /** Employee number is safe to expose — it is public inside the Club. */
  employeeNumber?: string | null;
}

/**
 * Map each change kind to the READ permission that a would-be
 * reviewer of the sensitive field holds. Recipients are the union of
 * all users holding that permission at the target Club.
 */
const RECIPIENT_PERMISSION: Record<HrChangeKind, "hr:sin:read" | "hr:banking:read" | "hr:employee:read"> = {
  sin_updated:          "hr:sin:read",
  banking_updated:      "hr:banking:read",
  home_address_updated: "hr:employee:read",
};

/**
 * Admin-facing copy. Third-person; identifies the employee by name +
 * routes reviewer to the profile surface. Never contains sensitive
 * values.
 */
function copyForAdmin(kind: HrChangeKind, employeeDisplayName: string, actorSource: HrChangeActorSource): { subject: string; body: string } {
  const who = actorSource === "STAFF"
    ? "the Club office"
    : actorSource === "EMPLOYEE"
      ? "the employee"
      : "the system";
  switch (kind) {
    case "sin_updated":
      return {
        subject: `SIN updated for ${employeeDisplayName}`,
        body: `${employeeDisplayName}'s Social Insurance Number information was changed by ${who}. Please review the record in Employee Profile → Payroll.`,
      };
    case "banking_updated":
      return {
        subject: `Direct deposit updated for ${employeeDisplayName}`,
        body: `${employeeDisplayName} submitted new direct deposit information (updated by ${who}). Please review the record in Employee Profile → Payroll.`,
      };
    case "home_address_updated":
      return {
        subject: `Home address updated for ${employeeDisplayName}`,
        body: `${employeeDisplayName} updated her/his address (updated by ${who}). The new address is visible in Employee Profile → Overview.`,
      };
  }
}

/**
 * Employee-facing confirmation copy. Second-person; confirms the
 * change without exposing sensitive detail. This is the audit trail
 * the employee sees so an unauthorized change would be visible to
 * them immediately.
 */
function copyForEmployee(kind: HrChangeKind): { subject: string; body: string } {
  switch (kind) {
    case "sin_updated":
      return {
        subject: `Your Social Insurance Number information was updated`,
        body: `Your Social Insurance Number information was updated. If you did not make this change, please contact your Club office immediately.`,
      };
    case "banking_updated":
      return {
        subject: `Your direct deposit information was updated`,
        body: `Your direct deposit information was updated and is pending verification. If you did not make this change, please contact your Club office immediately.`,
      };
    case "home_address_updated":
      return {
        subject: `Your address was updated`,
        body: `Your address on file was updated. If you did not make this change, please contact your Club office.`,
      };
  }
}

/**
 * Look up the employee's most likely notification targets:
 *   - linked User id (for IN_APP inbox on the admin surface or portal)
 *   - personalEmail (for EMAIL fallback)
 * Both may be null; caller MUST guard.
 */
async function loadEmployeeContactRoutes(
  clubId: string,
  employeeId: string,
): Promise<{ userId: string | null; personalEmail: string | null }> {
  const row = await prisma.employee.findFirst({
    where: { id: employeeId, clubId },
    select: { userId: true, personalEmail: true },
  });
  return {
    userId: row?.userId ?? null,
    personalEmail: row?.personalEmail ?? null,
  };
}

/**
 * Fire an HR-change notification. Best-effort — never rejects.
 *
 * Fans out to TWO audiences:
 *   * Admin recipients — resolved by permission (RECIPIENT_PERMISSION).
 *     Delivered IN_APP to each admin's User.notifications inbox.
 *   * Employee themselves — delivered IN_APP to their linked User
 *     (when present) and/or EMAIL to their personalEmail. Distinct
 *     copy that confirms the change without naming the field's value.
 *
 * Staging-only sanitization escape hatch: when the process env has
 * SPECTRE_SUPPRESS_HR_NOTIFICATIONS=1 the notifier short-circuits
 * before any delivery. This is used by the one-shot Chris/Lise
 * sanitization script so replacing test data with synthetic values
 * does not spam the founder with a stream of "your SIN was updated"
 * / "your direct deposit was updated" emails. The env var is NOT set
 * in production Fly secrets; it must be provided explicitly at
 * process launch, making it impossible to accidentally invoke.
 */
export async function notifyHrChange(input: NotifyHrChangeInput): Promise<void> {
  if (process.env.SPECTRE_SUPPRESS_HR_NOTIFICATIONS === "1") {
    return;
  }
  try {
    const [adminRecipients, employeeRoutes] = await Promise.all([
      resolveRecipientsByPermission(input.clubId, RECIPIENT_PERMISSION[input.kind]),
      loadEmployeeContactRoutes(input.clubId, input.employeeId),
    ]);

    const adminCopy = copyForAdmin(input.kind, input.employeeDisplayName, input.actorSource);
    const employeeCopy = copyForEmployee(input.kind);

    const commonMeta = {
      kind: input.kind,
      actorSource: input.actorSource,
      employeeIdTail: input.employeeId.slice(-8),
      employeeNumber: input.employeeNumber ?? null,
    } as const;

    // Admin fan-out. Skip the employee's linked User id if they happen
    // to hold the read permission themselves — the employee gets a
    // dedicated employee-facing message just below.
    for (const r of adminRecipients) {
      if (employeeRoutes.userId && r.id === employeeRoutes.userId) continue;
      await notify(null, input.clubId, {
        channel: "IN_APP",
        toUserId: r.id,
        subject: adminCopy.subject,
        body: adminCopy.body,
        priority: "NORMAL",
        topic: `hr.change.${input.kind}.admin`,
        triggeredEntityType: "Employee",
        triggeredEntityId: input.employeeId,
        meta: { ...commonMeta, audience: "ADMIN" },
      });
    }

    // Employee confirmation. Deliver via IN_APP to their linked User
    // if one exists (Employee.userId is populated when the employee
    // holds a Club-scoped account); ALSO fire an EMAIL to their
    // personalEmail so the confirmation reaches them even without
    // a User row.
    if (employeeRoutes.userId) {
      await notify(null, input.clubId, {
        channel: "IN_APP",
        toUserId: employeeRoutes.userId,
        subject: employeeCopy.subject,
        body: employeeCopy.body,
        priority: "NORMAL",
        topic: `hr.change.${input.kind}.employee`,
        triggeredEntityType: "Employee",
        triggeredEntityId: input.employeeId,
        meta: { ...commonMeta, audience: "EMPLOYEE" },
      });
    }
    if (employeeRoutes.personalEmail) {
      await notify(null, input.clubId, {
        channel: "EMAIL",
        toEmail: employeeRoutes.personalEmail,
        subject: employeeCopy.subject,
        body: employeeCopy.body,
        priority: "NORMAL",
        topic: `hr.change.${input.kind}.employee`,
        triggeredEntityType: "Employee",
        triggeredEntityId: input.employeeId,
        meta: { ...commonMeta, audience: "EMPLOYEE" },
      });
    }
  } catch (err) {
    // Best-effort — never block the underlying write.
    // eslint-disable-next-line no-console
    console.warn("[hr] notifyHrChange failed (non-fatal)", { kind: input.kind, err });
  }
}

/**
 * Convenience wrapper for services that already loaded the employee
 * row — computes the display name inline (preferredName ?? firstName).
 */
export async function notifyHrChangeByEmployeeId(
  clubId: string,
  employeeId: string,
  kind: HrChangeKind,
  actorSource: HrChangeActorSource,
): Promise<void> {
  const row = await prisma.employee.findFirst({
    where: { id: employeeId, clubId },
    select: {
      firstName: true, lastName: true, preferredName: true,
      employeeNumber: true,
    },
  });
  if (!row) return;
  const displayName = row.preferredName?.trim()
    ? `${row.preferredName} ${row.lastName}`
    : `${row.firstName} ${row.lastName}`;
  await notifyHrChange({
    clubId,
    employeeId,
    employeeDisplayName: displayName,
    employeeNumber: row.employeeNumber,
    kind,
    actorSource,
  });
}
