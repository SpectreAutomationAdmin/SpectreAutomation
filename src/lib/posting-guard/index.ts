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
import { assertAccessTierForPosting } from "../billing/access-tier";

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
  // SIGNUP-2 Phase 2B (2026-10-25) -- subscription access-tier gate.
  // Legacy ClubSubscription rows have accessTier=null, which the
  // gate treats as grandfathered PASS; existing tenants are
  // unaffected.  New SIGNUP-2 tenants in STAGED tier (Phase 2G+)
  // will be refused here with ForbiddenError, preventing posting
  // on any Phase-2B+ Club that has not reached FULL (or operator-
  // elected MANUAL_INVOICE).  See docs/signup-2-phase-2b-capability-matrix.md.
  await assertAccessTierForPosting(clubId);
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
  // SIGNUP-2 Phase 2B (2026-10-25) -- subscription access-tier gate.
  // Mirror of the gate in assertPostingAllowed above.  Legacy
  // ClubSubscription rows have accessTier=null -> grandfathered.
  await assertAccessTierForPosting(clubId);
}

// Re-export for ergonomic imports at boundaries.
export { TrainingModeBlockedError } from "../training";
export { SupportReadOnlyError } from "../support-access";
