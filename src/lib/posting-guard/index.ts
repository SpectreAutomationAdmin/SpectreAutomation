// Phase 14 — central posting guard.
//
// Single entry point that callers invoke at the boundary of every financial
// posting / sensitive mutation. Composes the two Phase 13 gates so service
// authors only have to remember one line:
//
//   await assertPostingAllowed(principal, clubId, "ar.charge.post", "Charge", chargeId);
//
// Gates applied:
//   1. assertNotTraining(clubId, action) — refuses if the club is in training
//      mode. Throws TrainingModeBlockedError.
//   2. assertAllowedAction({supportUserId, clubId, action, …}) — refuses
//      writes during a READ_ONLY support session. Throws SupportReadOnlyError.
//
// Both gates short-circuit cleanly when their feature is inactive, so the
// helper is safe to insert in front of every existing write without
// behavioural change for normal users.

import type { Principal } from "../rbac";
import { assertNotTraining } from "../training";
import { assertAllowedAction } from "../support-access";

export async function assertPostingAllowed(
  principal: Principal,
  clubId: string,
  action: string,
  entityType?: string,
  entityId?: string,
) {
  // Training-mode gate (per-club).
  await assertNotTraining(clubId, action);
  // Support-session gate (per support user × club). Returns silently when no
  // active session exists; otherwise records a SupportActionLog and may throw
  // SupportReadOnlyError.
  await assertAllowedAction({
    supportUserId: principal.id,
    clubId,
    action,
    entityType,
    entityId,
  });
}

// Sensitive (non-financial) actions where we want support-readonly to block
// even when there is no club-scope training mode concern. This wraps just
// the support gate so secret rotation / RBAC changes / billing edits remain
// auditable through the same path.
export async function assertSensitiveActionAllowed(
  principal: Principal,
  clubId: string,
  action: string,
  entityType?: string,
  entityId?: string,
) {
  await assertAllowedAction({
    supportUserId: principal.id,
    clubId,
    action,
    entityType,
    entityId,
  });
}

// Re-export for ergonomic imports at boundaries.
export { TrainingModeBlockedError } from "../training";
export { SupportReadOnlyError } from "../support-access";
