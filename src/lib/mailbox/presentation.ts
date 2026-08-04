// Sprint 2 B3 (2026-07-19) — Connection presentation mapper.
//
// The one authoritative translator from backend `MAILBOX_STATUS` to
// user-facing label, tone, explanation, primary action, and optional
// secondary action. Every UI surface that displays connection health
// MUST derive its labels from `presentConnection()` — NEVER from raw
// status strings or ad-hoc switch statements in components.
//
// Unknown statuses fail closed to an ERROR presentation with a
// generic explanation, per §11 of the B3 directive.

import { MAILBOX_STATUS, type MailboxStatus } from "./status";

export type PresentationTone = "info" | "success" | "warning" | "error" | "neutral";

export interface ConnectionActionSpec {
  key: string;
  label: string;
  kind: "primary" | "secondary" | "destructive";
  /** When true, the UI renders the control disabled with a tooltip
   *  explaining the reason. Used for buttons that will exist in a
   *  later phase (e.g. Sync now, before B4). */
  disabledReason?: string;
}

export interface ConnectionPresentation {
  badgeLabel: string;   // e.g. "Connected"
  badgeTone: PresentationTone;
  headline: string;     // e.g. "Connected — awaiting first sync"
  explanation: string;  // one paragraph, plain language
  primaryAction?: ConnectionActionSpec;
  secondaryAction?: ConnectionActionSpec;
  /** Sprint 3 · Checkpoint 16H (2026-08-04) — an additional
   *  "Update Microsoft permissions" affordance rendered on the
   *  CONNECTED state so the user can re-consent to the expanded
   *  scope set (Calendars.Read + Mail.ReadWrite + Mail.Send) via
   *  ONE consent event, without having to disconnect first. */
  tertiaryAction?: ConnectionActionSpec;
  /** Whether the surface should render a small "Connected as
   *  <email>" identity strip. False for Not-connected + Error
   *  states with no prior identity. */
  showIdentity: boolean;
  /** Whether the "Only you" visibility strip should render. False
   *  when there is no mailbox to have visibility over. */
  showVisibility: boolean;
  /** Whether we should display the last-sync line even though no
   *  sync feature exists in B3. Reserved for B4. */
  showLastSync: boolean;
}

// The action key strings ARE the source of truth for what the client
// component wires up. Keep in sync with mailbox-client.tsx switch.
export const CONNECTION_ACTION = {
  CONNECT: "connect",
  RECONNECT: "reconnect",
  DISCONNECT: "disconnect",
  SYNC_NOW: "sync_now",
  REPLACE: "replace",
} as const;

// Sprint 2 B4 (2026-07-19) — sync-now is enabled. The reason string
// stays in the file so a future phase can trivially re-disable the
// button (e.g. during a Graph outage) without a component-level edit.
const SYNC_NOW_DISABLED_REASON: string | undefined = undefined;

// The mapper. Explicit switch — do not consolidate into a lookup
// object; the founder's directive requires "fail closed" for
// unknown statuses, which a plain lookup would mishandle.
export function presentConnection(status: MailboxStatus | string | null): ConnectionPresentation {
  switch (status) {
    case null:
    case undefined:
      return notConnectedPresentation();
    case MAILBOX_STATUS.CONNECTING:
      return {
        badgeLabel: "Connecting",
        badgeTone: "info",
        headline: "Connecting to Microsoft",
        explanation:
          "We're redirecting you to Microsoft to confirm your consent. If this screen does not update within a few seconds, return to Connected accounts and try again.",
        showIdentity: false,
        showVisibility: false,
        showLastSync: false,
      };
    case MAILBOX_STATUS.CONNECTED_PENDING_SYNC:
      return {
        badgeLabel: "Connected — awaiting sync",
        badgeTone: "info",
        headline: "Connected — awaiting first sync",
        explanation:
          "Your mailbox is connected. Message import will begin when Outlook synchronization ships in the next phase. Nothing has been read from your Inbox yet.",
        secondaryAction: {
          key: CONNECTION_ACTION.DISCONNECT,
          label: "Disconnect Outlook",
          kind: "destructive",
        },
        showIdentity: true,
        showVisibility: true,
        showLastSync: false,
      };
    case MAILBOX_STATUS.CONNECTED:
      return {
        badgeLabel: "Connected",
        badgeTone: "success",
        headline: "Connected",
        explanation:
          "Spectre is reading email metadata from your Inbox and turning it into Work Intake items.",
        primaryAction: {
          key: CONNECTION_ACTION.SYNC_NOW,
          label: "Sync now",
          kind: "secondary",
          disabledReason: SYNC_NOW_DISABLED_REASON,
        },
        secondaryAction: {
          key: CONNECTION_ACTION.DISCONNECT,
          label: "Disconnect Outlook",
          kind: "destructive",
        },
        // Sprint 3 · Checkpoint 16H — one-click permission update.
        // Triggers the same OAuth flow as RECONNECT, but the button
        // label makes clear this is about adding/updating scopes
        // (Calendars.Read, Mail.ReadWrite, Mail.Send) rather than
        // fixing a broken connection. Preserves the existing
        // mailbox row + delta cursor on success.
        tertiaryAction: {
          key: CONNECTION_ACTION.RECONNECT,
          label: "Update Microsoft permissions",
          kind: "secondary",
        },
        showIdentity: true,
        showVisibility: true,
        showLastSync: true,
      };
    case MAILBOX_STATUS.DELAYED:
      return {
        badgeLabel: "Sync delayed",
        badgeTone: "warning",
        headline: "Sync delayed",
        explanation:
          "Spectre hasn't synced this mailbox recently. This is usually a transient Microsoft service issue and clears on its own; if it persists, disconnect and reconnect.",
        primaryAction: {
          key: CONNECTION_ACTION.SYNC_NOW,
          label: "Retry sync",
          kind: "secondary",
          disabledReason: SYNC_NOW_DISABLED_REASON,
        },
        secondaryAction: {
          key: CONNECTION_ACTION.DISCONNECT,
          label: "Disconnect Outlook",
          kind: "destructive",
        },
        showIdentity: true,
        showVisibility: true,
        showLastSync: true,
      };
    case MAILBOX_STATUS.REAUTH_REQUIRED:
      return {
        badgeLabel: "Reconnect required",
        badgeTone: "warning",
        headline: "Reconnect required",
        explanation:
          "Microsoft asked us to re-confirm your consent. This can happen after a password change, an admin policy change, or a long period of inactivity. Reconnect to resume access.",
        primaryAction: {
          key: CONNECTION_ACTION.RECONNECT,
          label: "Reconnect Outlook",
          kind: "primary",
        },
        secondaryAction: {
          key: CONNECTION_ACTION.DISCONNECT,
          label: "Disconnect Outlook",
          kind: "destructive",
        },
        showIdentity: true,
        showVisibility: true,
        showLastSync: false,
      };
    case MAILBOX_STATUS.DISCONNECTED:
      return {
        badgeLabel: "Disconnected",
        badgeTone: "neutral",
        headline: "Disconnected",
        explanation:
          "This mailbox is disconnected. Spectre is not reading from it. Any email previously imported into Work Intake remains stored until you delete it.",
        primaryAction: {
          key: CONNECTION_ACTION.RECONNECT,
          label: "Reconnect Outlook",
          kind: "primary",
        },
        showIdentity: true,
        showVisibility: false,
        showLastSync: false,
      };
    case MAILBOX_STATUS.ERROR:
      return {
        badgeLabel: "Connection problem",
        badgeTone: "error",
        headline: "Connection problem",
        explanation:
          "Something went wrong with this connection. If it persists, disconnect and reconnect. Contact support if the problem continues after a fresh connect.",
        primaryAction: {
          key: CONNECTION_ACTION.RECONNECT,
          label: "Reconnect Outlook",
          kind: "primary",
        },
        secondaryAction: {
          key: CONNECTION_ACTION.DISCONNECT,
          label: "Disconnect Outlook",
          kind: "destructive",
        },
        showIdentity: true,
        showVisibility: false,
        showLastSync: false,
      };
    default:
      // Fail closed — unknown backend status renders as ERROR with a
      // generic explanation. Never leak the raw string.
      return {
        badgeLabel: "Connection problem",
        badgeTone: "error",
        headline: "Connection problem",
        explanation:
          "This connection is in an unexpected state. Refresh the page; if the problem persists, disconnect and reconnect.",
        primaryAction: {
          key: CONNECTION_ACTION.RECONNECT,
          label: "Reconnect Outlook",
          kind: "primary",
        },
        showIdentity: false,
        showVisibility: false,
        showLastSync: false,
      };
  }
}

// Presentation used when the current user has NO connected mailbox in
// the active club. Not derived from a status because no row exists.
export function notConnectedPresentation(): ConnectionPresentation {
  return {
    badgeLabel: "Not connected",
    badgeTone: "neutral",
    headline: "Connect your Microsoft 365 Outlook mailbox",
    explanation:
      "Connect your Microsoft 365 Outlook account so Spectre can bring relevant email into Work Intake. Spectre will read email and attachment details from your Inbox. During this phase Spectre will not send email, mark messages as read, move messages, or modify your mailbox.",
    primaryAction: {
      key: CONNECTION_ACTION.CONNECT,
      label: "Connect Outlook",
      kind: "primary",
    },
    showIdentity: false,
    showVisibility: false,
    showLastSync: false,
  };
}

// One-time result banner content driven by the ?mailbox=... query
// param the callback sets. Returns null when the query does not
// carry a known outcome.
export function callbackBanner(params: URLSearchParams): { tone: PresentationTone; message: string } | null {
  const mailbox = params.get("mailbox");
  const error = params.get("error");
  if (mailbox === "connected") {
    return { tone: "success", message: "Your Microsoft 365 mailbox is connected. Spectre will begin syncing when that capability ships in the next phase." };
  }
  if (mailbox === "error" && error) {
    return { tone: "error", message: humanReadableCallbackError(error) };
  }
  return null;
}

function humanReadableCallbackError(code: string): string {
  switch (code) {
    case "oauth_denied_by_user":
      return "You declined the Microsoft consent screen. Connect again when you're ready.";
    case "oauth_admin_consent_required":
      return "Your Microsoft 365 administrator needs to approve Spectre before you can connect. Contact your IT team.";
    case "oauth_personal_account_rejected":
      return "Spectre supports Microsoft 365 work and school mailboxes only. Personal Outlook.com accounts cannot be connected.";
    case "active_personal_mailbox_replacement_required":
      return "You already have a Microsoft mailbox connected in this club. Disconnect it first, then reconnect with the new one.";
    case "duplicate_mailbox_different_user":
      return "Another user in this club is already connected to that Microsoft mailbox. Only one Spectre user per club can own a given personal mailbox.";
    case "cross_club_mailbox_denied":
      return "This Microsoft mailbox is already connected to another Spectre club.";
    case "oauth_state_expired":
    case "oauth_state_replay":
    case "oauth_state_unknown":
      return "The connection request timed out or was reused. Start again from Connected accounts.";
    default:
      return "We couldn't finish the connection. Try again from Connected accounts.";
  }
}
