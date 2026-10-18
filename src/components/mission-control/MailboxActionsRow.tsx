// WI-SYNC-1e-close §1 (2026-10-18) — full mailbox-action row on
// the Work Intake card.
//
// Renders the five user-initiated mailbox actions built across
// WI-SYNC-1a..1d-1e as inline secondary buttons.  Reuses existing
// design tokens (`.spectre-btn`, `.spectre-btn--secondary`,
// `.spectre-btn--sm`, `.spectre-mc-inline-status--error`) — zero
// new branding or layout tokens.
//
// Contextual visibility:
//   isSoftDeleted = true  → Restore
//   isSoftDeleted = false → Mark Read / Mark Unread  (toggle by
//                           isRead), Archive, Delete, Dismiss
//
// Accessibility:
//   • role="group" with aria-label on the row.
//   • Explicit aria-label per button (independent of visible text).
//   • Loading / success / error states announced via role="alert"
//     and the loading label change.
//   • Keyboard focus delegated to the native button element.
//
// Mutation safety:
//   • While one action is pending, ALL buttons are disabled.
//   • stopPropagation() prevents clicks from toggling the parent
//     card.
//   • `router.refresh()` after success so the feed re-reads from
//     the server (new WI state immediately visible).

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface MailboxActionsRowProps {
  workIntakeItemId: string;
  wiStatus: string; // OPEN | IN_PROGRESS | RESOLVED | INFORMATIONAL | SUPPRESSED
  isRead: boolean;
  isSoftDeleted: boolean;
}

type ActionKey =
  | "mark_read"
  | "mark_unread"
  | "archive"
  | "delete"
  | "dismiss"
  | "restore";

interface ActionDef {
  key: ActionKey;
  label: string;
  loadingLabel: string;
  endpoint: (wiId: string) => string;
}

const ACTIONS: Record<ActionKey, ActionDef> = {
  mark_read: {
    key: "mark_read",
    label: "Mark read",
    loadingLabel: "Marking…",
    endpoint: (wiId) => `/api/work-intake/${encodeURIComponent(wiId)}/mark-read-email`,
  },
  mark_unread: {
    key: "mark_unread",
    label: "Mark unread",
    loadingLabel: "Marking…",
    endpoint: (wiId) => `/api/work-intake/${encodeURIComponent(wiId)}/mark-unread-email`,
  },
  archive: {
    key: "archive",
    label: "Archive in Outlook",
    loadingLabel: "Archiving…",
    endpoint: (wiId) => `/api/work-intake/${encodeURIComponent(wiId)}/archive-email`,
  },
  delete: {
    key: "delete",
    label: "Delete from Outlook",
    loadingLabel: "Deleting…",
    endpoint: (wiId) => `/api/work-intake/${encodeURIComponent(wiId)}/delete-email`,
  },
  dismiss: {
    key: "dismiss",
    label: "Dismiss",
    loadingLabel: "Dismissing…",
    endpoint: (wiId) => `/api/work-intake/${encodeURIComponent(wiId)}/dismiss`,
  },
  restore: {
    key: "restore",
    label: "Restore email",
    loadingLabel: "Restoring…",
    endpoint: (wiId) => `/api/work-intake/${encodeURIComponent(wiId)}/restore-email`,
  },
};

export default function MailboxActionsRow(props: MailboxActionsRowProps) {
  const router = useRouter();
  const [pending, setPending] = useState<ActionKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successFlash, setSuccessFlash] = useState<ActionKey | null>(null);

  async function run(key: ActionKey) {
    const def = ACTIONS[key];
    setPending(key);
    setError(null);
    setSuccessFlash(null);
    try {
      const res = await fetch(def.endpoint(props.workIntakeItemId), {
        method: "POST",
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        setError(text || `HTTP ${res.status}`);
        setPending(null);
        return;
      }
      setSuccessFlash(key);
      setPending(null);
      router.refresh();
      setTimeout(() => setSuccessFlash(null), 2_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "network_error");
      setPending(null);
    }
  }

  const visible: ActionKey[] = [];
  const isSuppressedByDelete =
    props.wiStatus === "SUPPRESSED" && props.isSoftDeleted;
  const isActiveEmailBacked =
    (props.wiStatus === "OPEN" ||
      props.wiStatus === "IN_PROGRESS" ||
      props.wiStatus === "INFORMATIONAL" ||
      props.wiStatus === "DEFERRED") &&
    !props.isSoftDeleted;

  if (isSuppressedByDelete) {
    visible.push("restore");
  } else if (isActiveEmailBacked) {
    visible.push(props.isRead ? "mark_unread" : "mark_read");
    visible.push("archive", "delete", "dismiss");
  }
  if (visible.length === 0) return null;

  return (
    <div
      className="spectre-mc-mailbox-actions"
      role="group"
      aria-label="Mailbox actions"
      data-testid="mailbox-actions-row"
    >
      {visible.map((key) => {
        const def = ACTIONS[key];
        const isPending = pending === key;
        const flashed = successFlash === key;
        return (
          <button
            key={key}
            type="button"
            className="spectre-btn spectre-btn--secondary spectre-btn--sm"
            onClick={(e) => {
              e.stopPropagation();
              if (pending) return;
              void run(key);
            }}
            disabled={pending !== null}
            data-testid={`mailbox-action-${key}`}
            data-flashed={flashed ? "true" : undefined}
            aria-label={def.label}
          >
            {isPending ? def.loadingLabel : flashed ? "Done ✓" : def.label}
          </button>
        );
      })}
      {error ? (
        <span
          className="spectre-mc-inline-status spectre-mc-inline-status--error"
          role="alert"
          data-testid="mailbox-actions-error"
        >
          Could not complete — please retry.
        </span>
      ) : null}
    </div>
  );
}
