// Sprint 2 B2 (2026-07-19) — Connection status model + transition
// map for MailboxConnection.
//
// Every write to MailboxConnection.status MUST go through
// `transitionStatus()`. Ad-hoc string writes are forbidden — the
// transition map is the ONE source of truth for what states can
// follow what.
//
// Status meanings:
//
//   CONNECTING              — outbound OAuth in flight; transient.
//                             The row exists only if we tolerate a
//                             partial commit (currently we do not —
//                             the callback creates the row in the
//                             CONNECTED_PENDING_SYNC state on
//                             success). Reserved for future use.
//   CONNECTED_PENDING_SYNC  — OAuth succeeded; initial sync has not
//                             yet run (B4 will materialise messages).
//   CONNECTED               — fully operational, initial sync done,
//                             delta cursor is fresh.
//   DELAYED                 — last successful sync is stale beyond
//                             the reconciliation heartbeat threshold
//                             but no terminal error has fired. Set
//                             by the C1 heartbeat.
//   REAUTH_REQUIRED         — Microsoft returned invalid_grant or
//                             consent_required; the user must
//                             reconnect. Refreshes are refused.
//   DISCONNECTED            — user disconnected; tokens retired.
//                             No further Graph calls.
//   ERROR                   — unexpected non-terminal error;
//                             manual review. Refresh is allowed.
//
// See docs/adr/0002-mailbox-connection-status-transitions.md for
// the transition diagram.

export const MAILBOX_STATUS = {
  CONNECTING: "CONNECTING",
  CONNECTED_PENDING_SYNC: "CONNECTED_PENDING_SYNC",
  CONNECTED: "CONNECTED",
  DELAYED: "DELAYED",
  REAUTH_REQUIRED: "REAUTH_REQUIRED",
  DISCONNECTED: "DISCONNECTED",
  ERROR: "ERROR",
} as const;

export type MailboxStatus = (typeof MAILBOX_STATUS)[keyof typeof MAILBOX_STATUS];

// Every possible transition. Keys are the source status; values are
// the set of destinations allowed from that source. Any transition
// not listed is a bug and throws.
export const MAILBOX_STATUS_TRANSITIONS: Record<MailboxStatus, ReadonlyArray<MailboxStatus>> = {
  CONNECTING: [
    "CONNECTED_PENDING_SYNC",
    "REAUTH_REQUIRED",
    "ERROR",
    "DISCONNECTED",
  ],
  CONNECTED_PENDING_SYNC: [
    "CONNECTED",
    "REAUTH_REQUIRED",
    "ERROR",
    "DISCONNECTED",
    // Reconnect flow may briefly re-land here from another state.
    "CONNECTED_PENDING_SYNC",
  ],
  CONNECTED: [
    "CONNECTED",           // idempotent refresh success
    "DELAYED",
    "REAUTH_REQUIRED",
    "ERROR",
    "DISCONNECTED",
    "CONNECTED_PENDING_SYNC", // reconnect scenario
  ],
  DELAYED: [
    "CONNECTED",
    "REAUTH_REQUIRED",
    "ERROR",
    "DISCONNECTED",
    "CONNECTED_PENDING_SYNC",
  ],
  REAUTH_REQUIRED: [
    // Only a fresh OAuth completes; a refresh cannot recover.
    "CONNECTED_PENDING_SYNC",
    "DISCONNECTED",
  ],
  DISCONNECTED: [
    // Reconnect after disconnect is allowed; audit records the arc.
    "CONNECTED_PENDING_SYNC",
  ],
  ERROR: [
    "CONNECTED",
    "REAUTH_REQUIRED",
    "DISCONNECTED",
    "CONNECTED_PENDING_SYNC",
  ],
};

export class InvalidMailboxStatusTransition extends Error {
  readonly from: string;
  readonly to: string;
  constructor(from: string, to: string) {
    super(`Invalid mailbox status transition: ${from} → ${to}`);
    this.from = from;
    this.to = to;
    this.name = "InvalidMailboxStatusTransition";
  }
}

// Assert the transition is defined by the map above. Callers pass in
// current + desired; if the transition is not allowed we throw. This
// stops "different services writing arbitrary status strings" per
// §9 of the B2 directive.
export function assertMailboxStatusTransition(from: string, to: string): void {
  const allowed = MAILBOX_STATUS_TRANSITIONS[from as MailboxStatus];
  if (!allowed) throw new InvalidMailboxStatusTransition(from, to);
  if (!allowed.includes(to as MailboxStatus)) {
    throw new InvalidMailboxStatusTransition(from, to);
  }
}

// Guard: is this a terminal status where the connection cannot be
// used for Graph calls until the user reconnects?
export function isTerminalStatus(status: string): boolean {
  return status === MAILBOX_STATUS.REAUTH_REQUIRED || status === MAILBOX_STATUS.DISCONNECTED;
}
