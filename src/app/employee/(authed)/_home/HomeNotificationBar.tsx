"use client";

// HR-2C Home refinement (2026-08-24) — Thin dismissible notification bar.
//
// One row per active notification, sitting immediately underneath the
// hero photograph. Height-restrained, single-line on desktop where
// practical, wraps on mobile. Tone drives a pale background token
// (warning = pale amber) and the icon.
//
// The × control dismisses this row only. It NEVER completes training,
// updates eligibility, or acknowledges anything else — its only job is
// to hide THIS notification (identified by `notificationKey`) until
// the underlying obligation state changes and produces a new key.

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface Props {
  notificationKey: string;
  tone: "warning" | "info" | "success";
  message: string;
  actionLabel: string | null;
  actionHref: string | null;
  dismissAction: (key: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}

const TONE_STYLES: Record<Props["tone"], { wrap: string; icon: string }> = {
  warning: {
    wrap: "border-amber-200 bg-amber-50/70 text-amber-900",
    icon: "text-amber-800",
  },
  info: {
    wrap: "border-stone-200 bg-stone-50 text-stone-800",
    icon: "text-stone-600",
  },
  success: {
    wrap: "border-emerald-200 bg-emerald-50/70 text-emerald-900",
    icon: "text-emerald-800",
  },
};

function ToneIcon({ tone, className }: { tone: Props["tone"]; className: string }) {
  if (tone === "warning") {
    // Restrained warning triangle — matches Spectre monoline icon set.
    return (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
        <path d="M12 4l9.5 16H2.5L12 4z" />
        <line x1="12" y1="10" x2="12" y2="14" />
        <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (tone === "success") {
    return (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
        <circle cx="12" cy="12" r="9" />
        <polyline points="8 12 11 15 16 9" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <circle cx="12" cy="8" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export default function HomeNotificationBar({
  notificationKey,
  tone,
  message,
  actionLabel,
  actionHref,
  dismissAction,
}: Props) {
  const [dismissed, setDismissed] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const s = TONE_STYLES[tone];

  if (dismissed) return null;

  function handleDismiss() {
    setDismissed(true); // optimistic — the row already vanished
    startTransition(async () => {
      const result = await dismissAction(notificationKey);
      if (result.ok) {
        router.refresh();
      } else {
        setDismissed(false); // roll back on failure
      }
    });
  }

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md border px-4 py-2 ${s.wrap}`}
      data-testid="portal-home-notification"
      data-notification-key={notificationKey}
      data-notification-tone={tone}
      role="status"
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <ToneIcon tone={tone} className={s.icon} />
        <p className="text-sm leading-snug min-w-0" data-testid="portal-home-notification-message">
          {message}
        </p>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {actionHref && actionLabel && (
          <Link
            href={actionHref}
            className="text-xs uppercase tracking-[0.14em] underline underline-offset-4 hover:opacity-80"
            data-testid="portal-home-notification-action"
          >
            {actionLabel}
          </Link>
        )}
        <button
          type="button"
          onClick={handleDismiss}
          disabled={pending}
          className="rounded p-1 hover:bg-white/60 disabled:opacity-50"
          aria-label="Dismiss notification"
          data-testid="portal-home-notification-dismiss"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
