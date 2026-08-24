// HR-2C Home refinement (2026-08-24) — Employee Portal Home
// notification bars.
//
// The Home page reads notifications from here rather than deriving
// them ad-hoc. Notifications are DERIVED from canonical resolvers
// (§12 — dismissal must never become a source of truth for
// eligibility). The dismissal table only records "the employee tapped
// × on THIS specific obligation snapshot"; it never changes the
// canonical eligibility answer.
//
// Design invariants
//   - `buildHomeNotifications(employeeId)` returns display-safe
//     bars: kind, tone, message, action label + href, dismissal
//     key. It never emits course codes, version ids, or internal
//     enums; the training bar carries the outstanding COUNT only.
//   - `notificationKey` encodes the underlying obligation state.
//     For training the key is a sha256 of the sorted outstanding
//     required courseVersionIds. When admin publishes a new required
//     course the versionId set changes → the key changes → any prior
//     dismissal no longer suppresses the bar. If the same underlying
//     obligations persist, the same key suppresses it forever until
//     it's completed.
//   - `dismissHomeNotification(actor, key)` upserts a dismissal row.
//     Idempotent. Emits a lightweight audit row per §13.
//   - This module NEVER writes to Employee, TrainingCompletion,
//     TrainingProgress, or EmployeeAvailabilityWeek.

import { createHash } from "node:crypto";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { resolveEmployeeSchedulingEligibility } from "./training/applicability";
import type { EmployeePortalPrincipal } from "../employee-portal-session";

export type NotificationKind = "training_outstanding";
export type NotificationTone = "warning" | "info" | "success";

export interface HomeNotification {
  kind: NotificationKind;
  tone: NotificationTone;
  key: string;              // dismissal identity (state-versioned)
  message: string;          // display-safe copy
  actionLabel: string | null;
  actionHref: string | null;
  /** Whether this notification is currently dismissed for the
   *  employee (present in DB). The Home page uses this to hide the
   *  bar but the row remains in the returned list so audit / debug
   *  surfaces can see what was suppressed. */
  dismissed: boolean;
}

/** Produce the `notificationKey` for the training-outstanding bar.
 *  Hashes the sorted set of outstanding required courseVersionIds so
 *  the identity changes iff the underlying obligation changes. */
export function trainingOutstandingKey(courseVersionIds: string[]): string {
  const sorted = [...courseVersionIds].sort();
  const h = createHash("sha256").update(sorted.join(",")).digest("hex");
  return `training-outstanding:v1:${h.slice(0, 16)}`;
}

export async function buildHomeNotifications(
  actor: EmployeePortalPrincipal,
): Promise<HomeNotification[]> {
  const eligibility = await resolveEmployeeSchedulingEligibility(actor.employeeId);
  const notifications: HomeNotification[] = [];

  if (eligibility.outstandingTraining.length > 0) {
    const key = trainingOutstandingKey(
      eligibility.outstandingTraining.map((o) => o.courseVersionId),
    );
    const n = eligibility.outstandingTraining.length;
    notifications.push({
      kind: "training_outstanding",
      tone: "warning",
      key,
      message:
        n === 1
          ? "1 required training course must be completed before you can submit availability or be scheduled."
          : `${n} required training courses must be completed before you can submit availability or be scheduled.`,
      actionLabel: "Go to Training",
      actionHref: "/employee/safety-training",
      dismissed: false,
    });
  }

  if (notifications.length === 0) return notifications;
  const keys = notifications.map((n) => n.key);
  const dismissals = await prisma.employeeHomeNotificationDismissal.findMany({
    where: {
      employeeId: actor.employeeId,
      clubId: actor.clubId,
      notificationKey: { in: keys },
    },
    select: { notificationKey: true },
  });
  const dismissedSet = new Set(dismissals.map((d) => d.notificationKey));
  return notifications.map((n) =>
    dismissedSet.has(n.key) ? { ...n, dismissed: true } : n,
  );
}

/** Upsert-idempotent dismissal. Never touches training / availability
 *  / eligibility state. */
export async function dismissHomeNotification(
  actor: EmployeePortalPrincipal,
  key: string,
): Promise<void> {
  if (typeof key !== "string" || key.length === 0 || key.length > 200) return;
  const row = await prisma.employeeHomeNotificationDismissal.upsert({
    where: {
      employeeId_notificationKey: {
        employeeId: actor.employeeId,
        notificationKey: key,
      },
    },
    create: {
      clubId: actor.clubId,
      employeeId: actor.employeeId,
      notificationKey: key,
    },
    update: {},
  });
  await audit(null, {
    action: "hr.home_notification.dismiss",
    entityType: "EmployeeHomeNotificationDismissal",
    entityId: row.id,
    clubId: actor.clubId,
    after: {
      key,
      actorSource: "EMPLOYEE",
      employeeIdTail: actor.employeeId.slice(-8),
    },
  });
}
