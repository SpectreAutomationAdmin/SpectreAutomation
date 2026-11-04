// EP-TRAIN-6D-4B — transactional audit mechanism.
//
// Per directive §7, consequential state transitions MUST write the
// state mutation AND the governance event in the SAME database
// transaction. If the audit insert fails the mutation must also fail.
//
// The existing `src/lib/audit.ts :: audit()` helper NEVER throws by
// contract — a design choice that is correct for non-critical paths
// but WRONG for the authoritative lifecycle record. So:
//
//   Authoritative per-lifecycle record → TrainingQuestionAiStateTransition
//                                          (written in-transaction here).
//   Supplementary human-visible audit  → still call audit() AFTER the
//                                          transaction commits.
//
// The transaction-aware helpers below are intentionally free of
// `audit()` calls. Callers invoke `audit()` from outside the
// transaction, matching the pattern CLAUDE.md lays out: audit failures
// never block legitimate work, but legitimate lifecycle changes always
// have an in-transaction durable record.

import type { Prisma, PrismaClient } from "@prisma/client";
import type { Principal } from "@/lib/rbac";
import {
  evaluateTransition,
  type LifecycleReason,
  type LifecycleState,
} from "./lifecycle";

export type TxClient = Prisma.TransactionClient | PrismaClient;

export interface WriteStateTransitionArgs {
  readonly tx: TxClient;
  readonly draftId: string;
  readonly clubId: string;
  readonly fromState: LifecycleState;
  readonly toState: LifecycleState;
  readonly reasonCode: LifecycleReason;
  readonly reasonDetail?: string | null;
  readonly actor: Principal | { id: string } | null;
  readonly actorPermissions: ReadonlySet<string>;
  readonly expectedRecordVersion: number;
  /** When provided, the transition row cross-references the matching
   *  TrainingQuestionAiReview row. Null for system transitions. */
  readonly reviewId?: string | null;
  /** When provided, the transition row cross-references the matching
   *  TrainingQuestionAiValidation row. Null for reviewer actions. */
  readonly validationId?: string | null;
  /** Supplementary context. Must NOT contain credentials or raw
   *  transcript bodies. */
  readonly meta?: Record<string, unknown> | null;
}

export class TransitionBlockedError extends Error {
  readonly code: string;
  readonly detail: Record<string, unknown>;
  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "TransitionBlockedError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Writes:
 *   1. The TrainingQuestionAiStateTransition row.
 *   2. The TrainingQuestionAiDraft update (state + recordVersion +
 *      stateChangedAt + stateChangedByUserId).
 * Both in the same `tx`. If either fails the transaction rolls back.
 *
 * Also:
 *   - Re-evaluates the transition against the lifecycle table as
 *     defence-in-depth (the API handler should have evaluated already,
 *     but a race condition between evaluate and write is impossible
 *     if we re-check inside the transaction).
 *   - Uses optimistic concurrency: refuses when the row's current
 *     `recordVersion` differs from `expectedRecordVersion`.
 */
export async function writeStateTransition(args: WriteStateTransitionArgs): Promise<{
  readonly transitionId: string;
  readonly recordVersionAfter: number;
}> {
  const decision = evaluateTransition({
    from: args.fromState,
    to: args.toState,
    reasonCode: args.reasonCode,
    actorPermissions: args.actorPermissions,
  });
  if (!decision.allowed) {
    throw new TransitionBlockedError(
      decision.reason ?? "TRANSITION_NOT_ALLOWED",
      decision.message,
      { fromState: args.fromState, toState: args.toState, reasonCode: args.reasonCode },
    );
  }

  const recordVersionAfter = args.expectedRecordVersion + 1;
  const actorId = args.actor?.id ?? null;

  // 1. Optimistic-concurrency update. updateMany returns a count of
  //    rows affected; count=0 means the record was modified by another
  //    writer since we loaded it.
  const updateResult = await (args.tx as PrismaClient).trainingQuestionAiDraft.updateMany({
    where: {
      id: args.draftId,
      clubId: args.clubId,                        // defence-in-depth tenant filter
      recordVersion: args.expectedRecordVersion,
      state: args.fromState,
    },
    data: {
      state: args.toState,
      stateChangedAt: new Date(),
      stateChangedByUserId: actorId,
      recordVersion: recordVersionAfter,
    },
  });
  if (updateResult.count === 0) {
    throw new TransitionBlockedError(
      "CONCURRENT_MODIFICATION",
      "Draft was modified concurrently or has changed state. Refresh and retry.",
      {
        draftId: args.draftId,
        expectedRecordVersion: args.expectedRecordVersion,
        fromState: args.fromState,
      },
    );
  }

  // 2. Append the authoritative state-history row. If this fails the
  //    enclosing transaction rolls back and the state update from
  //    step 1 is reverted.
  const transition = await (args.tx as PrismaClient).trainingQuestionAiStateTransition.create({
    data: {
      clubId: args.clubId,
      draftId: args.draftId,
      fromState: args.fromState,
      toState: args.toState,
      reasonCode: args.reasonCode,
      reasonDetail: args.reasonDetail ?? null,
      byUserId: actorId,
      recordVersionBefore: args.expectedRecordVersion,
      recordVersionAfter: recordVersionAfter,
      reviewId: args.reviewId ?? null,
      validationId: args.validationId ?? null,
      metaJson: args.meta ? sanitiseMetaJson(args.meta) : null,
    },
    select: { id: true },
  });

  return { transitionId: transition.id, recordVersionAfter };
}

/**
 * Removes well-known credential-shaped keys from the meta object
 * before persisting. Defence-in-depth against a caller accidentally
 * forwarding HMAC material. Does NOT attempt to strip arbitrary
 * credential-shaped values — the authoritative rule is "callers must
 * not pass credentials in the first place" (directive §7).
 */
const CREDENTIAL_KEY_PATTERNS = [
  /hmac/i,
  /secret/i,
  /credential/i,
  /password/i,
  /token/i,
  /bearer/i,
  /apikey/i,
  /api_key/i,
  /signing/i,
  /r2_?key/i,
  /modal_?key/i,
];

export function sanitiseMetaJson(meta: Record<string, unknown>): string {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (CREDENTIAL_KEY_PATTERNS.some((re) => re.test(k))) {
      safe[k] = "[REDACTED_BY_SANITISER]";
    } else {
      safe[k] = v;
    }
  }
  return JSON.stringify(safe);
}
