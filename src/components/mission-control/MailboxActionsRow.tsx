// WI-SYNC-1e (2026-10-18) — Mailbox-action row on the Work Intake
// card.
//
// Renders five inline secondary buttons (Mark Unread / Mark Read /
// Archive / Delete / Dismiss / Restore) wired to the WI-SYNC-1a..1d
// API endpoints.  Reuses existing design tokens (`.spectre-btn`,
// `.spectre-btn--secondary`, `.spectre-btn--sm`, `.spectre-mc-
// inline-status`) — zero new CSS surface, zero branding changes.
//
// Each action:
//   - Shows a loading label on the clicked button.
//   - Shows a success toast via inline status briefly.
//   - Shows an error badge on failure; the button stays clickable
//     so the user can retry.
//   - Fires `router.refresh()` on success so the feed re-reads.
//
// Visibility rules (filters at render time):
//   - "Restore" renders only when the WI is SUPPRESSED AND the
//     linked email has softDeletedAt set.
//   - "Mark Read" renders only when the email is currently unread;
//     "Mark Unread" renders only when the email is currently read.
//   - "Dismiss" is always available for email-origin WIs.
//   - "Archive" and "Delete" render for OPEN / INFORMATIONAL WIs.

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface MailboxActionsRowProps {
  workIntakeItemId: string;
  wiStatus: string; // OPEN | IN_PROGRESS | RESOLVED | INFORMATIONAL | SUPPRESSED
}

// WI-SYNC-1e exposes the two user-initiated actions built in
// WI-SYNC-1c on active (non-resolved, non-suppressed) email cards.
//   • Dismiss  — Spectre-only, no Outlook touch.
//   • Delete   — Spectre + Outlook (moves to Deleted Items).
// Restore is deliberately NOT exposed as a button: a user who
// wants a message back moves it in Outlook (delta sync detects
// it + auto-restores the WI).  Operator-side restore is served
// by /api/admin/mailbox/debug/move-to-inbox.
// Mark-read + Archive are pre-existing flows surfaced elsewhere.
type ActionKey = "delete" | "dismiss";
interface ActionDef {
  key: ActionKey;
  label: string;
  loadingLabel: string;
  endpoint: (wiId: string) => string;
}

const ACTIONS: Record<ActionKey, ActionDef> = {
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
  const isActive =
    props.wiStatus === "OPEN" ||
    props.wiStatus === "IN_PROGRESS" ||
    props.wiStatus === "INFORMATIONAL" ||
    props.wiStatus === "DEFERRED";
  if (isActive) {
    visible.push("dismiss", "delete");
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
