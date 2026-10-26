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
import { prisma } from "../prisma";

/** M1 (2026-10-26) -- `tx` passes a Prisma transaction client into
 *  the access-tier check so the ClubSubscription row is row-locked
 *  with `SELECT ... FOR UPDATE` for the duration of the caller's
 *  transaction.  Suspension (Phase 2H) takes the same lock, so the
 *  race between a protected write and a suspension flip is closed.
 *  Legacy call-sites that don't yet pass `tx` keep the pre-M1
 *  Phase 2B semantics (no lock); migration to withPostingGuard() is
 *  tracked per the M1 acceptance doc. */
type MinimalTxClient = {
  $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown[]>;
};

export async function assertPostingAllowed(
  principal: Principal,
  clubId: string,
  action: string,
  entityType?: string,
  entityId?: string,
  opts?: { tx?: MinimalTxClient },
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
  // M1 (2026-10-26): when a tx is provided, the gate takes
  // SELECT ... FOR UPDATE on the ClubSubscription row for the
  // duration of the caller's transaction.  Phase 2H suspendTenant +
  // reinstateTenant take the same lock, closing the posting-vs-
  // suspension race.  Legacy tenants (null subscriptionStatus)
  // remain grandfathered.
  await assertAccessTierForPosting(clubId, { tx: opts?.tx });
}

/** M1 (2026-10-26) -- the preferred posting-guard surface.
 *
 *  Opens a Prisma transaction, runs the posting-guard IN-TRANSACTION
 *  with the row-lock on ClubSubscription, then runs the caller's
 *  work with the same transaction client.  Suspension cannot
 *  interleave with the protected write: either the suspension
 *  commits first (and the guard refuses) or the write commits first
 *  (and the suspension waits).
 *
 *  Usage:
 *    return withPostingGuard(principal, clubId, "ar.charge.post", async (tx) => {
 *      await tx.charge.create({ ... });
 *      await tx.ledgerEntry.createMany({ ... });
 *      return result;
 *    }, { entityType: "Charge", entityId: chargeId });
 *
 *  The function MUST return the tx callback's result; it propagates
 *  through unchanged.
 */
export async function withPostingGuard<T>(
  principal: Principal,
  clubId: string,
  action: string,
  work: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>,
  opts?: { entityType?: string; entityId?: string },
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await assertPostingAllowed(principal, clubId, action, opts?.entityType, opts?.entityId, {
      // The $queryRawUnsafe method exists on the Prisma TransactionClient; cast
      // through the structural type our evaluateAccessTierGate expects.
      tx: tx as unknown as MinimalTxClient,
    });
    return work(tx);
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
  // SIGNUP-2 Phase 2B (2026-10-25) -- subscription access-tier gate.
  // Mirror of the gate in assertPostingAllowed above.  Legacy
  // ClubSubscription rows have accessTier=null -> grandfathered.
  await assertAccessTierForPosting(clubId);
}

// Re-export for ergonomic imports at boundaries.
export { TrainingModeBlockedError } from "../training";
export { SupportReadOnlyError } from "../support-access";
