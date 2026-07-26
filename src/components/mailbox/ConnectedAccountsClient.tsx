"use client";

// Sprint 2 B3 (2026-07-19) — Connected Accounts client component.
//
// Renders the current user's personal Outlook connection using the
// canonical presentation mapper. Connect / Reconnect / Disconnect
// flows post directly to the B2 API routes. Replacement is triggered
// server-side via the `active_personal_mailbox_replacement_required`
// error code (§7); this UI surfaces the confirmation dialog.

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  presentConnection,
  callbackBanner,
  notConnectedPresentation,
  CONNECTION_ACTION,
  type ConnectionPresentation,
  type ConnectionActionSpec,
} from "@/lib/mailbox/presentation";

interface SerializedConnection {
  id: string;
  connectedEmail: string;
  status: string;
  mailboxType: string;
  createdAt: string;
  disconnectedAt: string | null;
  lastSuccessfulSyncAt: string | null;
  lastAttemptedSyncAt: string | null;
  lastSyncError: string | null;
  tenantDisplayHint: string;
}

interface SerializedActivity {
  action: string;
  createdAt: string;
}

export interface ConnectedAccountsClientProps {
  snapshot: {
    connection: SerializedConnection | null;
    recentActivity: SerializedActivity[];
  };
  canConnect: boolean;
  callbackResult: { mailbox: string | null; error: string | null };
}

type ModalState =
  | { kind: "none" }
  | { kind: "disconnect" }
  | { kind: "replace"; existingEmail: string };

export default function ConnectedAccountsClient(props: ConnectedAccountsClientProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [modal, setModal] = useState<ModalState>({ kind: "none" });
  const [inlineError, setInlineError] = useState<string | null>(null);
  const connectButtonRef = useRef<HTMLButtonElement | null>(null);
  const bannerRef = useRef<HTMLDivElement | null>(null);

  // Callback banner — surface success/error inline and then strip the
  // one-time query params so refresh doesn't repeat the banner.
  const banner = useMemo(() => {
    if (!props.callbackResult.mailbox && !props.callbackResult.error) return null;
    const p = new URLSearchParams();
    if (props.callbackResult.mailbox) p.set("mailbox", props.callbackResult.mailbox);
    if (props.callbackResult.error) p.set("error", props.callbackResult.error);
    return callbackBanner(p);
  }, [props.callbackResult]);

  useEffect(() => {
    if (!banner) return;
    // Strip mailbox + error + cx from the URL without a full nav so a
    // refresh doesn't repeat the banner.
    const url = new URL(window.location.href);
    url.searchParams.delete("mailbox");
    url.searchParams.delete("error");
    url.searchParams.delete("cx");
    window.history.replaceState({}, "", url.pathname + (url.search || ""));
    bannerRef.current?.focus?.();
  }, [banner]);

  const presentation: ConnectionPresentation = props.snapshot.connection
    ? presentConnection(props.snapshot.connection.status)
    : notConnectedPresentation();

  const initiateConnect = useCallback(
    (options?: { intent?: "reconnect" | "replace" }) => {
      void options;
      setInlineError(null);
      startTransition(async () => {
        try {
          const res = await fetch("/api/integrations/microsoft/connect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ returnPath: "/app/user/settings/connected-accounts" }),
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            setInlineError(banner_error_to_message(body.error ?? "internal_error"));
            return;
          }
          const body = (await res.json()) as { authorizationUrl?: string };
          if (body.authorizationUrl) {
            window.location.assign(body.authorizationUrl);
            return;
          }
          setInlineError(banner_error_to_message("internal_error"));
        } catch {
          setInlineError(banner_error_to_message("internal_error"));
        }
      });
    },
    [],
  );

  const disconnect = useCallback(() => {
    if (!props.snapshot.connection) return;
    const connectionId = props.snapshot.connection.id;
    startTransition(async () => {
      try {
        const res = await fetch("/api/integrations/microsoft/disconnect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mailboxConnectionId: connectionId }),
        });
        setModal({ kind: "none" });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setInlineError(banner_error_to_message(body.error ?? "internal_error"));
          return;
        }
        router.refresh();
      } catch {
        setInlineError(banner_error_to_message("internal_error"));
        setModal({ kind: "none" });
      }
    });
  }, [props.snapshot.connection, router]);

  const [syncStatus, setSyncStatus] = useState<{
    runStatus: string | null;
    counts: {
      examined: number;
      imported: number;
      updated: number;
      actionable: number;
      informational: number;
      suppressed: number;
      failed: number;
    } | null;
    lastSuccessfulSyncAt: string | null;
    isTerminal: boolean;
  } | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollBackoffRef = useRef<number>(1500);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
    pollBackoffRef.current = 1500;
  }, []);

  // Sprint 2 B4.1 (2026-07-19) — poll /sync-status. Backs off from
  // 1.5s to 8s; stops on terminal outcomes; stops on unmount; stops
  // when the connection reports terminal status.
  const startPolling = useCallback(
    (connectionId: string) => {
      const tick = async () => {
        try {
          const res = await fetch(`/api/integrations/microsoft/sync-status?mailboxConnectionId=${encodeURIComponent(connectionId)}`);
          if (!res.ok) {
            stopPolling();
            return;
          }
          const body = (await res.json()) as {
            connection: { status: string; lastSuccessfulSyncAt: string | null; isTerminal: boolean };
            latestRun?: {
              status: string;
              messagesExamined: number;
              messagesImported: number;
              messagesUpdated: number;
              intakeCreatedActionable: number;
              intakeCreatedInformational: number;
              messagesSuppressed: number;
              messagesFailed: number;
            } | null;
          };
          setSyncStatus({
            runStatus: body.latestRun?.status ?? null,
            counts: body.latestRun
              ? {
                  examined: body.latestRun.messagesExamined,
                  imported: body.latestRun.messagesImported,
                  updated: body.latestRun.messagesUpdated,
                  actionable: body.latestRun.intakeCreatedActionable,
                  informational: body.latestRun.intakeCreatedInformational,
                  suppressed: body.latestRun.messagesSuppressed,
                  failed: body.latestRun.messagesFailed,
                }
              : null,
            lastSuccessfulSyncAt: body.connection.lastSuccessfulSyncAt,
            isTerminal: body.connection.isTerminal,
          });
          if (
            body.connection.isTerminal ||
            (body.latestRun && ["COMPLETED", "PARTIAL", "DELAYED", "TERMINAL", "SKIPPED"].includes(body.latestRun.status))
          ) {
            router.refresh();
            stopPolling();
            return;
          }
          // Back-off: 1.5s → 3s → 6s → 8s.
          pollBackoffRef.current = Math.min(8000, Math.floor(pollBackoffRef.current * 1.8));
          pollTimerRef.current = setTimeout(tick, pollBackoffRef.current);
        } catch {
          stopPolling();
        }
      };
      pollTimerRef.current = setTimeout(tick, pollBackoffRef.current);
    },
    [router, stopPolling],
  );

  useEffect(() => () => stopPolling(), [stopPolling]);

  const syncNow = useCallback(() => {
    if (!props.snapshot.connection) return;
    if (pending) return;
    const connectionId = props.snapshot.connection.id;
    setInlineError(null);
    setSyncStatus({ runStatus: "QUEUED", counts: null, lastSuccessfulSyncAt: props.snapshot.connection.lastSuccessfulSyncAt, isTerminal: false });
    startTransition(async () => {
      try {
        const res = await fetch("/api/integrations/microsoft/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mailboxConnectionId: connectionId }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setInlineError(banner_error_to_message(body.error ?? "internal_error"));
          stopPolling();
          return;
        }
        pollBackoffRef.current = 1500;
        startPolling(connectionId);
      } catch {
        setInlineError(banner_error_to_message("internal_error"));
        stopPolling();
      }
    });
  }, [props.snapshot.connection, pending, startPolling, stopPolling]);

  const onAction = (action: ConnectionActionSpec) => {
    if (action.disabledReason) return;
    switch (action.key) {
      case CONNECTION_ACTION.CONNECT:
      case CONNECTION_ACTION.RECONNECT:
        initiateConnect({ intent: action.key === CONNECTION_ACTION.RECONNECT ? "reconnect" : undefined });
        break;
      case CONNECTION_ACTION.DISCONNECT:
        setModal({ kind: "disconnect" });
        break;
      case CONNECTION_ACTION.SYNC_NOW:
        syncNow();
        break;
      case CONNECTION_ACTION.REPLACE:
        if (props.snapshot.connection) {
          setModal({ kind: "replace", existingEmail: props.snapshot.connection.connectedEmail });
        }
        break;
      default:
        break;
    }
  };

  const isFlagOff = false; // If the page renders, the flag is on (server enforced 404).

  return (
    <div className="mx-auto max-w-3xl px-6 py-8" data-testid="connected-accounts-page">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-wider text-stone-500 font-semibold mb-1">Settings</p>
        <h1 className="text-2xl font-semibold text-stone-900">Connected accounts</h1>
        <p className="mt-2 text-sm text-stone-600 max-w-2xl">
          Connect external accounts so Spectre can bring their relevant activity into your Work Intake. Personal
          mailbox contents are visible only to you.
        </p>
      </header>

      {banner && (
        <div
          ref={bannerRef}
          role={banner.tone === "error" ? "alert" : "status"}
          tabIndex={-1}
          data-testid="callback-banner"
          data-tone={banner.tone}
          className={`mb-6 rounded-lg border p-3 text-sm ${bannerColorClasses(banner.tone)}`}
        >
          {banner.message}
        </div>
      )}

      {inlineError && (
        <div
          role="alert"
          data-testid="inline-error"
          className="mb-6 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"
        >
          {inlineError}
        </div>
      )}

      {isFlagOff && (
        <div className="rounded-lg border border-stone-200 bg-stone-50 p-6 text-sm text-stone-700">
          Outlook integration is not enabled in this environment.
        </div>
      )}

      <section
        className="card overflow-hidden"
        data-testid="connection-card"
        data-status={props.snapshot.connection?.status ?? "not_connected"}
      >
        <div className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-4">
              <OutlookIcon />
              <div>
                <h2 className="text-lg font-semibold text-stone-900">Microsoft Outlook</h2>
                <p className="mt-1 text-sm text-stone-600 max-w-xl">{presentation.explanation}</p>
              </div>
            </div>
            <StatusBadge presentation={presentation} />
          </div>

          {syncStatus?.runStatus && (
            <div
              className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-4 text-sm"
              data-testid="sync-live-panel"
              data-run-status={syncStatus.runStatus}
              role="status"
              aria-live="polite"
            >
              <p className="text-xs uppercase tracking-wider text-stone-500 font-semibold mb-2">
                Sync {friendlyRunStatus(syncStatus.runStatus)}
              </p>
              {syncStatus.counts && (
                <div className="grid grid-cols-3 gap-3 text-xs text-stone-700">
                  <SyncCount label="Examined"       n={syncStatus.counts.examined} />
                  <SyncCount label="Imported"       n={syncStatus.counts.imported} />
                  <SyncCount label="Updated"        n={syncStatus.counts.updated} />
                  <SyncCount label="Actionable"     n={syncStatus.counts.actionable} />
                  <SyncCount label="Informational"  n={syncStatus.counts.informational} />
                  <SyncCount label="Suppressed"     n={syncStatus.counts.suppressed} />
                  <SyncCount label="Failed"         n={syncStatus.counts.failed} />
                </div>
              )}
              {syncStatus.runStatus === "PARTIAL" && (
                <p className="mt-2 text-xs text-amber-800">Some messages failed to ingest. They will be retried on the next sync.</p>
              )}
            </div>
          )}

          {presentation.showIdentity && props.snapshot.connection && (
            <dl className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-xs uppercase tracking-wider text-stone-500 font-semibold mb-1">Connected as</dt>
                <dd data-testid="connected-email" className="text-stone-900 font-medium">{props.snapshot.connection.connectedEmail}</dd>
                <dd className="text-xs text-stone-500 mt-0.5">Microsoft 365 · directory …{props.snapshot.connection.tenantDisplayHint}</dd>
              </div>
              {presentation.showVisibility && (
                <div>
                  <dt className="text-xs uppercase tracking-wider text-stone-500 font-semibold mb-1">Visibility</dt>
                  <dd data-testid="visibility-line" className="text-stone-900 font-medium">Only you</dd>
                  <dd className="text-xs text-stone-500 mt-0.5">Club Admin status does not grant access to your mailbox contents.</dd>
                </div>
              )}
              {presentation.showLastSync && (
                <div>
                  <dt className="text-xs uppercase tracking-wider text-stone-500 font-semibold mb-1">Last synced</dt>
                  <dd className="text-stone-900 font-medium">
                    {props.snapshot.connection.lastSuccessfulSyncAt
                      ? relativeTime(props.snapshot.connection.lastSuccessfulSyncAt)
                      : "Not yet"}
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-xs uppercase tracking-wider text-stone-500 font-semibold mb-1">Connected on</dt>
                <dd className="text-stone-900 font-medium">
                  {formatDate(props.snapshot.connection.createdAt)}
                </dd>
              </div>
            </dl>
          )}

          <ScopeDisclosure />

          {(presentation.primaryAction || presentation.secondaryAction) && (
            <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-stone-200 pt-6">
              {presentation.primaryAction && (
                <ActionButton
                  ref={presentation.primaryAction.key === CONNECTION_ACTION.CONNECT ? connectButtonRef : undefined}
                  action={presentation.primaryAction}
                  disabled={!props.canConnect || pending}
                  onClick={onAction}
                  testId="primary-action"
                />
              )}
              {presentation.secondaryAction && (
                <ActionButton
                  action={presentation.secondaryAction}
                  disabled={pending}
                  onClick={onAction}
                  testId="secondary-action"
                />
              )}
              {!props.canConnect && !props.snapshot.connection && (
                <p className="text-xs text-stone-500">Your role does not have permission to connect a mailbox.</p>
              )}
            </div>
          )}
        </div>

        {props.snapshot.recentActivity.length > 0 && (
          <div className="border-t border-stone-200 bg-stone-50 px-6 py-4" data-testid="activity-strip">
            <p className="text-xs uppercase tracking-wider text-stone-500 font-semibold mb-2">Recent activity</p>
            <ul className="space-y-1 text-sm text-stone-700">
              {props.snapshot.recentActivity.slice(0, 5).map((a, i) => (
                <li key={i}>
                  {friendlyActivity(a.action)} on {formatDate(a.createdAt)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {modal.kind === "disconnect" && (
        <ConfirmationModal
          title="Disconnect Microsoft Outlook?"
          testId="disconnect-modal"
          onCancel={() => setModal({ kind: "none" })}
        >
          <p>
            Spectre will stop reading from this mailbox immediately. Your Microsoft mailbox itself is not changed —
            no messages are deleted or moved, nothing is marked read. You can reconnect later.
          </p>
          <p className="mt-3 text-stone-600 text-sm">
            Previously imported email will remain stored in Spectre when message import is available in the next
            phase. You can delete it separately then.
          </p>
          <div className="mt-6 flex justify-end gap-3">
            <button
              type="button"
              className="btn-secondary rounded-md px-4 py-2 text-sm font-semibold"
              onClick={() => setModal({ kind: "none" })}
              data-testid="disconnect-cancel"
              disabled={pending}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
              onClick={disconnect}
              data-testid="disconnect-confirm"
              disabled={pending}
              aria-busy={pending}
            >
              {pending ? "Disconnecting…" : "Disconnect Outlook"}
            </button>
          </div>
        </ConfirmationModal>
      )}

      {modal.kind === "replace" && (
        <ConfirmationModal
          title="Replace the existing mailbox?"
          testId="replace-modal"
          onCancel={() => setModal({ kind: "none" })}
        >
          <p>
            You already have <span className="font-semibold">{modal.existingEmail}</span> connected. Phase B supports one active personal
            Outlook mailbox per Spectre user per club.
          </p>
          <ul className="mt-4 list-disc pl-5 text-sm text-stone-700 space-y-1">
            <li>The current mailbox will stop syncing.</li>
            <li>Email already imported from the current mailbox stays in Spectre.</li>
            <li>Work Intake ownership and history are preserved.</li>
            <li>The new mailbox requires an initial sync.</li>
          </ul>
          <div className="mt-6 flex justify-end gap-3">
            <button
              type="button"
              className="btn-secondary rounded-md px-4 py-2 text-sm font-semibold"
              onClick={() => setModal({ kind: "none" })}
              data-testid="replace-cancel"
              disabled={pending}
            >
              Keep current mailbox
            </button>
            <button
              type="button"
              className="rounded-md bg-club-green-700 px-4 py-2 text-sm font-semibold text-white hover:bg-club-green-800 disabled:opacity-60"
              onClick={() => {
                // Replacement flow (Phase B minimum): disconnect the
                // existing one and immediately kick off a new connect.
                if (!props.snapshot.connection) return;
                const connectionId = props.snapshot.connection.id;
                startTransition(async () => {
                  const disc = await fetch("/api/integrations/microsoft/disconnect", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ mailboxConnectionId: connectionId }),
                  });
                  if (!disc.ok) {
                    const body = (await disc.json().catch(() => ({}))) as { error?: string };
                    setInlineError(banner_error_to_message(body.error ?? "internal_error"));
                    setModal({ kind: "none" });
                    return;
                  }
                  // Fetch a new authorization URL and redirect.
                  const conn = await fetch("/api/integrations/microsoft/connect", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ returnPath: "/app/user/settings/connected-accounts" }),
                  });
                  if (!conn.ok) {
                    const body = (await conn.json().catch(() => ({}))) as { error?: string };
                    setInlineError(banner_error_to_message(body.error ?? "internal_error"));
                    setModal({ kind: "none" });
                    return;
                  }
                  const body = (await conn.json()) as { authorizationUrl?: string };
                  if (body.authorizationUrl) {
                    window.location.assign(body.authorizationUrl);
                  }
                });
              }}
              data-testid="replace-confirm"
              disabled={pending}
              aria-busy={pending}
            >
              {pending ? "Working…" : "Replace with new mailbox"}
            </button>
          </div>
        </ConfirmationModal>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Subcomponents
// -----------------------------------------------------------------------------

function StatusBadge({ presentation }: { presentation: ConnectionPresentation }) {
  return (
    <span
      className={`spectre-badge spectre-badge--${badgeToneKey(presentation.badgeTone)}`}
      data-testid="status-badge"
      data-tone={presentation.badgeTone}
    >
      {presentation.badgeLabel}
    </span>
  );
}

const ActionButton = ({
  action,
  disabled,
  onClick,
  testId,
  ref,
}: {
  action: ConnectionActionSpec;
  disabled: boolean;
  onClick: (action: ConnectionActionSpec) => void;
  testId: string;
  ref?: React.MutableRefObject<HTMLButtonElement | null>;
}) => {
  const effectiveDisabled = disabled || !!action.disabledReason;
  const classes =
    action.kind === "primary"
      ? "rounded-md bg-club-green-700 px-4 py-2 text-sm font-semibold text-white hover:bg-club-green-800"
      : action.kind === "destructive"
        ? "rounded-md border border-red-200 bg-white px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50"
        : "rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-50";
  return (
    <button
      ref={ref}
      type="button"
      className={`${classes} disabled:opacity-60 disabled:cursor-not-allowed`}
      disabled={effectiveDisabled}
      title={action.disabledReason}
      onClick={() => onClick(action)}
      data-testid={`${testId}-${action.key}`}
      data-action={action.key}
    >
      {action.label}
    </button>
  );
};

function ScopeDisclosure() {
  return (
    <div className="mt-6 rounded-lg bg-stone-50 border border-stone-200 p-4 text-sm">
      <p className="font-semibold text-stone-900 mb-2">What Spectre can and cannot do</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-stone-500 font-semibold mb-1">Spectre can</p>
          <ul className="list-disc pl-5 text-stone-700 space-y-0.5">
            <li>Read recent messages from your Inbox</li>
            <li>Read sender, subject, preview, and message content</li>
            <li>Read attachment names and metadata</li>
            <li>Use those messages to create Work Intake items</li>
          </ul>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wider text-stone-500 font-semibold mb-1">Spectre cannot in this phase</p>
          <ul className="list-disc pl-5 text-stone-700 space-y-0.5">
            <li>Send email or reply on your behalf</li>
            <li>Delete or move messages</li>
            <li>Mark messages read or unread</li>
            <li>Access another mailbox without separate consent</li>
          </ul>
        </div>
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-stone-500 hover:text-stone-700">Technical permissions</summary>
        <p className="mt-2 text-xs text-stone-500">
          Delegated Microsoft Graph scopes: <code className="font-mono">User.Read</code>, <code className="font-mono">Mail.Read</code>,{" "}
          <code className="font-mono">offline_access</code>. No write scopes are requested.
        </p>
      </details>
    </div>
  );
}

function ConfirmationModal({
  title,
  testId,
  onCancel,
  children,
}: {
  title: string;
  testId: string;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => dialogRef.current?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          "button, [href], input, [tabindex]:not([tabindex='-1'])",
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      data-testid={`${testId}-backdrop`}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${testId}-title`}
        tabIndex={-1}
        className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
        data-testid={testId}
      >
        <h3 id={`${testId}-title`} className="text-lg font-semibold text-stone-900">
          {title}
        </h3>
        <div className="mt-3 text-sm text-stone-700">{children}</div>
      </div>
    </div>
  );
}

function OutlookIcon() {
  return (
    <div className="flex-shrink-0 flex items-center justify-center w-11 h-11 rounded-lg bg-blue-100 text-blue-700">
      <svg viewBox="0 0 24 24" width={22} height={22} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M3 7l9 6 9-6" />
      </svg>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Formatting helpers
// -----------------------------------------------------------------------------

function badgeToneKey(tone: ConnectionPresentation["badgeTone"]): string {
  switch (tone) {
    case "success": return "success";
    case "warning": return "warning";
    case "error":   return "error";
    case "info":    return "info";
    default:        return "accent";
  }
}

function bannerColorClasses(tone: string): string {
  switch (tone) {
    case "success": return "border-green-200 bg-green-50 text-green-900";
    case "error":   return "border-red-200 bg-red-50 text-red-900";
    case "warning": return "border-amber-200 bg-amber-50 text-amber-900";
    default:        return "border-stone-200 bg-stone-50 text-stone-900";
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function relativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const secs = Math.max(1, Math.floor((now - then) / 1000));
  if (secs < 60) return "moments ago";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function friendlyActivity(action: string): string {
  switch (action) {
    case "mailbox.connect.completed":   return "Connected";
    case "mailbox.connect.reconnected": return "Reconnected";
    case "mailbox.disconnected":        return "Disconnected";
    case "mailbox.reauth.required":     return "Reconnect required";
    default: return action;
  }
}

function banner_error_to_message(code: string): string {
  const p = new URLSearchParams({ mailbox: "error", error: code });
  return callbackBanner(p)?.message ?? "Something went wrong. Try again.";
}

function friendlyRunStatus(s: string): string {
  switch (s) {
    case "QUEUED":    return "queued";
    case "RUNNING":   return "in progress";
    case "COMPLETED": return "complete";
    case "PARTIAL":   return "complete with partial results";
    case "DELAYED":   return "delayed";
    case "TERMINAL":  return "requires reconnect";
    case "SKIPPED":   return "skipped";
    default:          return s.toLowerCase();
  }
}

function SyncCount({ label, n }: { label: string; n: number }) {
  return (
    <div>
      <p className="text-stone-500">{label}</p>
      <p className="font-semibold text-stone-900 font-mono">{n}</p>
    </div>
  );
}
