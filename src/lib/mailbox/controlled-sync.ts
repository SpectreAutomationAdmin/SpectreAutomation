// Sprint 2 Step 13A (2026-07-21) — Controlled sync mode consumers.
//
// The master switch env.MAILBOX_CONTROLLED_SYNC_MODE and its boot-time
// validation live in src/lib/env.ts. This module provides the three
// derived controls the initial-sync handler consumes at runtime. Each
// helper is safe to call regardless of the master switch state — when
// the master is OFF, the subordinate values are ignored (boot has
// already refused to start if a subordinate was set alone).
//
// Design:
//   - effectiveInitialSyncMessageCap()   — Math.min(override, SYNC_SCOPE.messageCap)
//   - shouldSkipAttachmentMetadata()     — true iff master ON AND skip flag set
//   - shouldSkipMaterialization()        — true iff master ON AND skip flag set
//
// Never returns a value that could lower behavior below production
// safety (e.g. cap can never exceed SYNC_SCOPE.messageCap). Never
// returns "skip" flags when the master is OFF, so production is never
// altered by a stray subordinate variable slipping past boot.

import { env, isControlledSyncModeActive } from "@/lib/env";
import { SYNC_SCOPE } from "./sync-scope";

/**
 * The effective per-run message cap. Always ≤ SYNC_SCOPE.messageCap.
 * When the controlled-sync master switch is OFF, or the override is
 * unset, returns SYNC_SCOPE.messageCap unchanged.
 */
export function effectiveInitialSyncMessageCap(): number {
  const override = env.MAILBOX_SYNC_MAX_MESSAGES_OVERRIDE;
  if (isControlledSyncModeActive() && typeof override === "number" && override > 0) {
    return Math.min(override, SYNC_SCOPE.messageCap);
  }
  return SYNC_SCOPE.messageCap;
}

/**
 * When true, the initial-sync handler must NOT call the Graph
 * /me/messages/{id}/attachments endpoint even if
 * message.hasAttachments === true, and must NOT create any
 * EmailAttachment rows or attachment-fetch follow-on jobs.
 * hasAttachments (already in the /messages response) may still be
 * stored on the EmailMessage row.
 */
export function shouldSkipAttachmentMetadata(): boolean {
  return isControlledSyncModeActive() && env.MAILBOX_SYNC_SKIP_ATTACHMENT_METADATA === "true";
}

/**
 * When true, the initial-sync handler must NOT call classifyEmail(),
 * must NOT call upsertEmailIntake(), and must NOT create any
 * WorkIntakeItem or classification rows or enqueue any downstream
 * classification/intake jobs. Normalized EmailMessage persistence
 * still happens so the ingestion path is proven end-to-end.
 */
export function shouldSkipMaterialization(): boolean {
  return isControlledSyncModeActive() && env.MAILBOX_SYNC_SKIP_MATERIALIZATION === "true";
}

/**
 * Sprint 2 Checkpoint 13C — when true, the initial-sync handler must
 * exercise the token-refresh path and RETURN IMMEDIATELY. No page
 * fetches, no Graph mail-endpoint calls, no message persistence. The
 * refresh call itself (getFreshDelegatedAccessToken) still writes any
 * rotated tokens to the DB — that's the intended side effect since a
 * successful refresh leaves the connection in a healthy state.
 */
export function shouldRunDiagnosticOnly(): boolean {
  return isControlledSyncModeActive() && env.MAILBOX_SYNC_DIAGNOSTIC_ONLY === "true";
}

/**
 * Sprint 2 Checkpoint 13G — delta-sync equivalent of
 * effectiveInitialSyncMessageCap(). Reuses the SAME numeric constant
 * (SYNC_SCOPE.messageCap) as the initial-sync cap so the two paths
 * cannot drift. The founder rejected a delta-specific override env;
 * controlled-mode reuses MAILBOX_SYNC_MAX_MESSAGES_OVERRIDE.
 *
 * Behaviour:
 *   - controlled mode OFF          → SYNC_SCOPE.messageCap (production cap)
 *   - controlled mode ON, override → Math.min(override, SYNC_SCOPE.messageCap)
 *   - controlled mode ON, no over  → SYNC_SCOPE.messageCap
 *
 * The cap must limit BOTH messagesExamined AND (messagesImported +
 * messagesUpdated). Enforcement lives in runDeltaSyncForConnection.
 */
export function effectiveDeltaSyncMessageCap(): number {
  const override = env.MAILBOX_SYNC_MAX_MESSAGES_OVERRIDE;
  if (isControlledSyncModeActive() && typeof override === "number" && override > 0) {
    return Math.min(override, SYNC_SCOPE.messageCap);
  }
  return SYNC_SCOPE.messageCap;
}
