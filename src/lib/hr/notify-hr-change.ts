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
//
// Notifications are recorded as IN_APP entries so any admin can see
// them in the notifications list; the enterprise adapter forwards
// EMAIL separately when the club's email adapter is wired.

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
 * Human-readable subject/body pairs. Deliberately terse — no
 * plaintext digits, no fingerprint hex, no coordinates.
 */
function copyFor(kind: HrChangeKind, employeeDisplayName: string, actorSource: HrChangeActorSource): { subject: string; body: string } {
  const who = actorSource === "STAFF"
    ? "the Club office"
    : actorSource === "EMPLOYEE"
      ? "the employee"
      : "the system";
  switch (kind) {
    case "sin_updated":
      return {
        subject: `SIN updated for ${employeeDisplayName}`,
        body: `${employeeDisplayName}'s SIN was updated by ${who}. Please review the record in Employee Profile → Payroll.`,
      };
    case "banking_updated":
      return {
        subject: `Direct deposit updated for ${employeeDisplayName}`,
        body: `${employeeDisplayName}'s direct-deposit banking was updated by ${who}. Please review the record in Employee Profile → Payroll.`,
      };
    case "home_address_updated":
      return {
        subject: `Home address updated for ${employeeDisplayName}`,
        body: `${employeeDisplayName}'s home address was updated by ${who}. The new address is visible in Employee Profile → Overview.`,
      };
  }
}

/**
 * Fire an HR-change notification. Best-effort — never rejects.
 */
export async function notifyHrChange(input: NotifyHrChangeInput): Promise<void> {
  try {
    const recipients = await resolveRecipientsByPermission(
      input.clubId, RECIPIENT_PERMISSION[input.kind],
    );
    if (recipients.length === 0) return;

    const { subject, body } = copyFor(input.kind, input.employeeDisplayName, input.actorSource);

    // Fan out one IN_APP notification per recipient user. `notify` is
    // called as a system event (principal=null) so it bypasses the
    // notifications:send permission check — this is service-authored,
    // not user-authored.
    for (const r of recipients) {
      await notify(null, input.clubId, {
        channel: "IN_APP",
        toUserId: r.id,
        subject,
        body,
        priority: "NORMAL",
        topic: `hr.change.${input.kind}`,
        triggeredEntityType: "Employee",
        triggeredEntityId: input.employeeId,
        meta: {
          kind: input.kind,
          actorSource: input.actorSource,
          employeeIdTail: input.employeeId.slice(-8),
          // Employee number is safe (it is not a secret); helpful for
          // an admin scanning their notifications list.
          employeeNumber: input.employeeNumber ?? null,
        },
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
