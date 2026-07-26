"use client";

// Sprint 2 B4.1 (2026-07-19) — Work Intake detail client.
//
// Renders the sanitised email evidence + five orchestration actions.
// Actions POST to /api/work-intake/action; server-side gates enforce
// tenant + owner scoping. The UI never trusts a client-only hide.

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { WorkIntakeDetail } from "@/lib/work-intake/detail-reader";

interface Props {
  detail: WorkIntakeDetail;
  currentUserId: string;
}

type ModalKind = "none" | "resolve" | "defer" | "reopen";

export default function WorkIntakeDetailClient({ detail, currentUserId }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [modal, setModal] = useState<ModalKind>("none");
  const [banner, setBanner] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [inFlight, setInFlight] = useState<string | null>(null);
  const bannerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (banner) bannerRef.current?.focus?.();
  }, [banner]);

  const runAction = useCallback(
    (action: string, extra: Record<string, unknown> = {}) => {
      if (inFlight) return;
      setInFlight(action);
      setBanner(null);
      startTransition(async () => {
        try {
          const res = await fetch("/api/work-intake/action", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              workIntakeItemId: detail.id,
              action,
              ...extra,
            }),
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            setBanner({ tone: "error", message: errorLabel(body.error ?? "internal_error") });
            setInFlight(null);
            return;
          }
          setBanner({ tone: "success", message: successLabel(action) });
          setInFlight(null);
          setModal("none");
          router.refresh();
        } catch {
          setBanner({ tone: "error", message: "Something went wrong. Try again." });
          setInFlight(null);
        }
      });
    },
    [detail.id, inFlight, router],
  );

  const canAssignSelf = detail.ownerUserId !== currentUserId;
  const isResolved = detail.status === "RESOLVED";
  const isInformational = detail.status === "INFORMATIONAL";

  return (
    <div className="mx-auto max-w-4xl px-6 py-8" data-testid="work-intake-detail-page">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-wider text-stone-500 font-semibold mb-1">Work intake · {detail.display.sourceLabel}</p>
        <h1 className="text-2xl font-semibold text-stone-900">{detail.display.subject}</h1>
        <p className="mt-2 text-sm text-stone-600">
          From <span className="font-medium">{detail.email?.senderName ?? detail.display.sender}</span>
          {detail.email?.senderAddress && <span className="text-stone-500"> · {detail.email.senderAddress}</span>}
          {" · "}
          <time>{formatDateTime(detail.display.receivedAt)}</time>
        </p>
      </header>

      {banner && (
        <div
          ref={bannerRef}
          tabIndex={-1}
          role={banner.tone === "error" ? "alert" : "status"}
          data-testid="action-banner"
          data-tone={banner.tone}
          className={`mb-6 rounded-lg border p-3 text-sm ${
            banner.tone === "success"
              ? "border-green-200 bg-green-50 text-green-900"
              : "border-red-200 bg-red-50 text-red-900"
          }`}
        >
          {banner.message}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <div className="md:col-span-2 space-y-6">
          <section className="card p-6" data-testid="evidence-card">
            <h2 className="text-sm font-semibold text-stone-900 mb-3">Email evidence</h2>
            {detail.email?.isSoftDeleted && (
              <div className="mb-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" data-testid="evidence-unavailable">
                The original email was removed from the mailbox. The intake orchestration state is preserved for your records.
              </div>
            )}
            <RecipientLine label="From" value={`${detail.email?.senderName ?? ""} <${detail.email?.senderAddress ?? ""}>`} />
            <RecipientLine label="To" value={(detail.email?.recipientsTo ?? []).join(", ") || "—"} />
            {detail.email?.recipientsCc.length ? (
              <RecipientLine label="Cc" value={detail.email.recipientsCc.join(", ")} />
            ) : null}
            <RecipientLine label="Received" value={formatDateTime(detail.email?.receivedAt ?? detail.display.receivedAt)} />
            <RecipientLine label="Source mailbox" value={detail.email?.mailboxConnectedEmail ?? "—"} />
            <hr className="my-4 border-stone-200" />
            {detail.email?.bodyHtmlSanitized ? (
              // The body has already passed through sanitizeEmailHtml
              // at ingest time. Rendering the sanitised HTML is
              // safe; the sanitiser tests pin the behaviour.
              <div
                className="prose prose-sm max-w-none text-stone-800"
                data-testid="email-body-html"
                // eslint-disable-next-line react/no-danger
                dangerouslySetInnerHTML={{ __html: detail.email.bodyHtmlSanitized }}
              />
            ) : detail.email?.bodyTextExtract ? (
              <pre className="whitespace-pre-wrap text-sm text-stone-800 font-sans" data-testid="email-body-text">
                {detail.email.bodyTextExtract}
              </pre>
            ) : (
              <p className="text-sm text-stone-500 italic">No message body was captured.</p>
            )}
            {detail.email?.webLink && (
              <p className="mt-4 text-xs text-stone-500">
                <a
                  href={detail.email.webLink}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="text-club-green-700 hover:underline"
                  data-testid="outlook-web-link"
                >
                  Open in Outlook on the web →
                </a>
              </p>
            )}
          </section>

          {detail.email?.attachments && detail.email.attachments.length > 0 && (
            <section className="card p-6" data-testid="attachments-card">
              <h2 className="text-sm font-semibold text-stone-900 mb-3">
                Attachments <span className="text-stone-500 font-normal">· metadata only</span>
              </h2>
              <ul className="space-y-2 text-sm">
                {detail.email.attachments.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-4 rounded border border-stone-200 bg-stone-50 px-3 py-2">
                    <div>
                      <p className="font-medium text-stone-900">{a.filename}</p>
                      <p className="text-xs text-stone-500">
                        {a.contentType} · {formatBytes(a.sizeBytes)}
                      </p>
                    </div>
                    <span className="text-xs text-stone-500">
                      {a.storageState === "REFUSED_TOO_LARGE"
                        ? "Too large to fetch"
                        : "Not yet downloaded"}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-stone-500">
                Attachment bytes are retrieved on demand in a future phase. Only filenames, types, and sizes are stored today.
              </p>
            </section>
          )}

          <section className="card p-6" data-testid="activity-card">
            <h2 className="text-sm font-semibold text-stone-900 mb-3">Activity</h2>
            {detail.activity.length === 0 ? (
              <p className="text-sm text-stone-500 italic">No activity yet.</p>
            ) : (
              <ul className="space-y-2 text-sm text-stone-700">
                {detail.activity.map((a) => (
                  <li key={a.id} className="flex justify-between gap-4">
                    <span>
                      <span className="font-medium text-stone-900">{friendlyActionLabel(a.action)}</span>
                      {a.actorName && <> by {a.actorName}</>}
                      {a.note && <span className="text-stone-500"> · {a.note}</span>}
                    </span>
                    <span className="text-xs text-stone-500 whitespace-nowrap">{formatDateTime(a.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="space-y-6">
          <section className="card p-6" data-testid="status-card">
            <h2 className="text-sm font-semibold text-stone-900 mb-3">Status</h2>
            <div className="space-y-3 text-sm">
              <MetaLine label="Status" value={friendlyStatusLabel(detail.status)} />
              <MetaLine label="Classification" value={detail.classification ?? "not classified"} />
              <MetaLine label="Reason" value={detail.classificationReason ?? "—"} />
              <MetaLine
                label="Confidence"
                value={`${detail.classificationConfidenceLabel}${detail.classificationMethod === "USER" ? " · user override" : ""}`}
              />
              <MetaLine label="Judgment required" value={detail.judgmentRequired ? "yes" : "no"} />
              <MetaLine label="Owner" value={detail.ownerName ?? "Unassigned"} />
              {detail.deferredUntil && (
                <MetaLine label="Deferred until" value={formatDateTime(detail.deferredUntil)} />
              )}
            </div>
          </section>

          <section className="card p-6" data-testid="actions-card">
            <h2 className="text-sm font-semibold text-stone-900 mb-3">Actions</h2>
            <div className="flex flex-col gap-2">
              {canAssignSelf && (
                <ActionButton
                  onClick={() => runAction("assign_self")}
                  disabled={pending}
                  primary
                  testId="action-assign-self"
                >
                  Assign to me
                </ActionButton>
              )}
              {!isResolved && (
                <ActionButton
                  onClick={() => setModal("resolve")}
                  disabled={pending}
                  testId="action-resolve"
                >
                  Resolve
                </ActionButton>
              )}
              {isResolved && (
                <ActionButton
                  onClick={() => setModal("reopen")}
                  disabled={pending}
                  testId="action-reopen"
                >
                  Reopen
                </ActionButton>
              )}
              {!isInformational && (
                <ActionButton
                  onClick={() => runAction("informational")}
                  disabled={pending}
                  testId="action-informational"
                >
                  Mark informational
                </ActionButton>
              )}
              <ActionButton
                onClick={() => setModal("defer")}
                disabled={pending || isResolved}
                testId="action-defer"
              >
                Defer…
              </ActionButton>
            </div>
          </section>
        </aside>
      </div>

      {modal === "resolve" && (
        <ConfirmModal
          testId="resolve-modal"
          title="Resolve this Work Intake item?"
          onCancel={() => setModal("none")}
          onConfirm={() => runAction("resolve")}
          confirmLabel="Resolve"
          pending={pending}
        >
          <p>You&apos;re marking this item as done. It stays in your history and can be reopened later if needed.</p>
        </ConfirmModal>
      )}
      {modal === "reopen" && (
        <ConfirmModal
          testId="reopen-modal"
          title="Reopen this Work Intake item?"
          onCancel={() => setModal("none")}
          onConfirm={() => runAction("reopen")}
          confirmLabel="Reopen"
          pending={pending}
        >
          <p>The item will return to the open queue. Any deferred date is cleared.</p>
        </ConfirmModal>
      )}
      {modal === "defer" && (
        <DeferModal
          onCancel={() => setModal("none")}
          onConfirm={(until) => runAction("defer", { until: until.toISOString() })}
          pending={pending}
        />
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------

function ActionButton({
  onClick,
  children,
  disabled,
  primary,
  testId,
}: {
  onClick: () => void;
  children: React.ReactNode;
  disabled: boolean;
  primary?: boolean;
  testId: string;
}) {
  const classes = primary
    ? "rounded-md bg-club-green-700 px-4 py-2 text-sm font-semibold text-white hover:bg-club-green-800"
    : "rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-50";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${classes} disabled:opacity-60 disabled:cursor-not-allowed`}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

function MetaLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-xs uppercase tracking-wider text-stone-500 font-semibold">{label}</span>
      <span className="text-stone-800 text-right">{value}</span>
    </div>
  );
}

function RecipientLine({ label, value }: { label: string; value: string }) {
  return (
    <p className="text-sm text-stone-800">
      <span className="text-stone-500">{label}: </span>
      {value}
    </p>
  );
}

function ConfirmModal({
  testId,
  title,
  onCancel,
  onConfirm,
  confirmLabel,
  pending,
  children,
}: {
  testId: string;
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel: string;
  pending: boolean;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus?.();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
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
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            className="rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-800"
            onClick={onCancel}
            data-testid={`${testId}-cancel`}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-md bg-club-green-700 px-4 py-2 text-sm font-semibold text-white hover:bg-club-green-800 disabled:opacity-60"
            onClick={onConfirm}
            data-testid={`${testId}-confirm`}
            disabled={pending}
            aria-busy={pending}
          >
            {pending ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeferModal({
  onCancel,
  onConfirm,
  pending,
}: {
  onCancel: () => void;
  onConfirm: (until: Date) => void;
  pending: boolean;
}) {
  const defaultDate = new Date(Date.now() + 24 * 3600_000);
  const [value, setValue] = useState<string>(toLocalDatetimeInput(defaultDate));
  return (
    <ConfirmModal
      testId="defer-modal"
      title="Defer this Work Intake item"
      onCancel={onCancel}
      onConfirm={() => {
        const parsed = new Date(value);
        if (!parsed || Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) return;
        onConfirm(parsed);
      }}
      confirmLabel="Defer"
      pending={pending}
    >
      <p className="mb-3">Pick a time to bring it back to your queue.</p>
      <label className="block text-xs uppercase tracking-wider text-stone-500 font-semibold mb-1">Defer until</label>
      <input
        type="datetime-local"
        className="w-full rounded border border-stone-300 px-3 py-2 text-sm"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        data-testid="defer-datetime-input"
        min={toLocalDatetimeInput(new Date())}
      />
    </ConfirmModal>
  );
}

// -----------------------------------------------------------------------------

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
function toLocalDatetimeInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function friendlyStatusLabel(s: string): string {
  switch (s) {
    case "OPEN":         return "Open";
    case "IN_PROGRESS":  return "In progress";
    case "DEFERRED":     return "Deferred";
    case "RESOLVED":     return "Resolved";
    case "INFORMATIONAL":return "Informational";
    case "SUPPRESSED":   return "Suppressed";
    default: return s;
  }
}
function friendlyActionLabel(a: string): string {
  switch (a) {
    case "MATERIALISED":         return "Item created from email evidence";
    case "ASSIGNED":             return "Assigned";
    case "STATUS_CHANGED":       return "Status changed";
    case "RESOLVED":             return "Resolved";
    case "REOPENED":             return "Reopened";
    case "DEFERRED":             return "Deferred";
    case "EVIDENCE_DELETED":     return "Source email removed from mailbox";
    default: return a;
  }
}
function errorLabel(code: string): string {
  switch (code) {
    case "not_visible":         return "You no longer have access to this item.";
    case "invalid_defer_time":  return "Defer time must be in the future.";
    case "unknown_action":      return "Unknown action.";
    default:                    return "Something went wrong. Try again.";
  }
}
function successLabel(action: string): string {
  switch (action) {
    case "resolve":        return "Resolved.";
    case "reopen":         return "Reopened.";
    case "informational":  return "Marked informational.";
    case "defer":          return "Deferred.";
    case "assign_self":    return "Assigned to you.";
    default:               return "Done.";
  }
}
