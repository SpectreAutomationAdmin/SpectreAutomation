// Sprint 3 · Checkpoint 15R (2026-07-29) — canonical mailbox health
// model.
//
// Founder rule (integration recovery checkpoint):
//   "Both surfaces must derive their display from the same canonical
//    state rather than separate booleans or stale projections."
//
// Root cause of the founder-observed disagreement:
//   Mission Control (`feed-synced-status.ts`) derived "RECONNECT
//   REQUIRED" from `conn.status !== "CONNECTED"` OR
//   `accessTokenExpiresAt < now`. Both are wrong:
//     • CONNECTED_PENDING_SYNC is a healthy transient status the
//       state machine legitimately produces after OAuth completion
//       and after every reconnect (see status.ts:36-44).
//     • Access tokens expire hourly and are transparently refreshed
//       by getFreshDelegatedAccessToken (connect.ts). Expiry is not
//       a reauth signal — only refresh-token failure is.
//
//   Connected Accounts (`presentation.ts`) already derives correctly
//   from the full state machine via presentConnection().
//
// This module is the single authoritative reduction from a raw
// MailboxConnection row (or absence thereof) to the two-axis health
// tuple both UIs render from. Any UI that shows a mailbox pill /
// badge / recommendation MUST call `deriveMailboxHealth` and map
// its own display from the returned `{ credentials, sync }` tuple.

import { MAILBOX_STATUS, isTerminalStatus, type MailboxStatus } from "./status";

// ---------------------------------------------------------------------------
// Axes
// ---------------------------------------------------------------------------

/**
 * Credentials axis — whether Spectre CAN talk to Microsoft Graph.
 * Independent of whether it HAS yet.
 *
 *   NONE               No mailbox connected for this user.
 *   CONNECTED          OAuth completed; refresh token available;
 *                      credentials expected to work. Includes both
 *                      CONNECTED and CONNECTED_PENDING_SYNC in the
 *                      backend enum — both are healthy from the
 *                      "credentials" perspective; the difference is
 *                      only whether initial sync has completed.
 *   REAUTH_REQUIRED    OAuth token has been rejected AND cannot be
 *                      auto-refreshed. Founder action required.
 *   DISCONNECTED       Explicitly disconnected by founder.
 */
export type CredentialsHealth =
  | "NONE"
  | "CONNECTED"
  | "REAUTH_REQUIRED"
  | "DISCONNECTED";

/**
 * Sync axis — whether the mailbox is actually keeping up.
 * Only meaningful when credentials === "CONNECTED".
 *
 *   NEVER      No successful sync yet (initial sync pending).
 *   FRESH      Last successful sync within the freshness window
 *              (default 30 minutes).
 *   STALE      Last successful sync exists but is older than the
 *              freshness window — worker may be behind or
 *              temporarily throttled.
 *   FAILING    A sync attempt has occurred AFTER the last success
 *              AND recorded an error (attemptedAt > successAt AND
 *              lastSyncError != null). Distinct from STALE — this
 *              signals an active problem rather than mere delay.
 */
export type SyncHealth =
  | "NEVER"
  | "FRESH"
  | "STALE"
  | "FAILING";

export interface MailboxHealth {
  credentials: CredentialsHealth;
  sync: SyncHealth;
  /**
   * The connection's raw backend status when credentials !== NONE.
   * Included so UI can render fine-grained detail (e.g. distinguish
   * CONNECTED_PENDING_SYNC from CONNECTED for the "still setting up"
   * copy) WITHOUT re-branching on raw status strings anywhere else.
   */
  rawStatus: MailboxStatus | null;
  /**
   * The last successful sync timestamp — passthrough for UI display.
   */
  lastSuccessfulSyncAt: Date | null;
  /**
   * The last attempted sync timestamp — passthrough for UI display.
   */
  lastAttemptedSyncAt: Date | null;
  /**
   * The last sync error message, if any. Truncate at the caller side.
   */
  lastSyncError: string | null;
  /**
   * The mailbox email address, if known. UI uses this to render
   * "Reconnect <email>" copy. Null when credentials === NONE.
   */
  connectedEmail: string | null;
}

// ---------------------------------------------------------------------------
// Input shape — minimal subset of MailboxConnection needed to derive.
// Every field is nullable so callers can pass either a Prisma row or
// a null (no-connection) case.
// ---------------------------------------------------------------------------
export interface MailboxHealthInput {
  status: string;
  lastSuccessfulSyncAt: Date | null;
  lastAttemptedSyncAt: Date | null;
  lastSyncError: string | null;
  connectedEmail: string | null;
  /**
   * True when the refresh-token ciphertext is populated. Callers
   * derive this from `refreshTokenSecretRef != null`. Included as an
   * explicit input (rather than a raw field) because the ciphertext
   * itself is a KMS envelope that must never be logged.
   */
  hasRefreshToken: boolean;
}

const DEFAULT_FRESHNESS_MS = 30 * 60 * 1000; // 30 minutes

/**
 * The single authoritative reduction. Both `presentation.ts` and
 * `feed-synced-status.ts` must call this helper. Any UI surface that
 * needs to render a mailbox pill / badge derives from the returned
 * object — never from raw MailboxConnection.status.
 */
export function deriveMailboxHealth(
  conn: MailboxHealthInput | null,
  opts?: { now?: Date; freshnessMs?: number },
): MailboxHealth {
  if (!conn) {
    return {
      credentials: "NONE",
      sync: "NEVER",
      rawStatus: null,
      lastSuccessfulSyncAt: null,
      lastAttemptedSyncAt: null,
      lastSyncError: null,
      connectedEmail: null,
    };
  }

  const now = opts?.now ?? new Date();
  const freshnessMs = opts?.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  const status = conn.status as MailboxStatus;

  // Credentials axis.
  let credentials: CredentialsHealth;
  if (status === MAILBOX_STATUS.DISCONNECTED) {
    credentials = "DISCONNECTED";
  } else if (isTerminalStatus(status) || !conn.hasRefreshToken) {
    // REAUTH_REQUIRED is the canonical terminal-refresh signal.
    // A missing refresh token on a non-DISCONNECTED connection ALSO
    // means we cannot recover without founder action — treat as
    // REAUTH_REQUIRED. This defends against a hypothetical row
    // where the ciphertext was cleared without status being updated.
    credentials = "REAUTH_REQUIRED";
  } else {
    // Every remaining state (CONNECTING / CONNECTED_PENDING_SYNC /
    // CONNECTED / DELAYED / ERROR) is credentials-CONNECTED — Graph
    // calls will succeed as long as refresh works. The status
    // machine handles the specific sub-state via `sync` + `rawStatus`.
    credentials = "CONNECTED";
  }

  // Sync axis — only meaningful when credentials === CONNECTED.
  let sync: SyncHealth;
  if (credentials !== "CONNECTED") {
    sync = "NEVER";
  } else if (!conn.lastSuccessfulSyncAt) {
    sync = "NEVER";
  } else {
    const successMs = conn.lastSuccessfulSyncAt.getTime();
    const attemptedMs = conn.lastAttemptedSyncAt?.getTime() ?? 0;
    const attemptedAfterSuccess = attemptedMs > successMs && conn.lastSyncError != null;
    const age = now.getTime() - successMs;
    if (attemptedAfterSuccess) {
      sync = "FAILING";
    } else if (age > freshnessMs) {
      sync = "STALE";
    } else {
      sync = "FRESH";
    }
  }

  return {
    credentials,
    sync,
    rawStatus: conn ? (conn.status as MailboxStatus) : null,
    lastSuccessfulSyncAt: conn.lastSuccessfulSyncAt,
    lastAttemptedSyncAt: conn.lastAttemptedSyncAt,
    lastSyncError: conn.lastSyncError,
    connectedEmail: conn.connectedEmail,
  };
}
