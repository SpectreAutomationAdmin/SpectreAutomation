"use client";

// AUTH-3C (2026-09-26) — Tenant Users → per-user "Sign out on all
// devices". Inline confirm-then-fire, matches the Employee Profile
// button's visual language so the two surfaces read as coherent.
// Self-revocation redirects the caller's browser to /login
// immediately after the server action resolves.

import { useState, useTransition } from "react";

interface Props {
  targetUserId: string;
  targetDisplayName: string;
  /** True when the row is the CURRENTLY authenticated admin. The
   *  confirmation copy changes to first-person and success handling
   *  redirects to /login. */
  isSelf: boolean;
  action: () => Promise<{ ok: true; selfRevocation: boolean } | { ok: false; error: string }>;
}

export default function SignOutUserEverywhereButton({
  targetUserId,
  targetDisplayName,
  isSelf,
  action,
}: Props) {
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const confirmCopy = isSelf
    ? "Sign out on all devices? This will sign you out of Spectre on every device. You will need to sign in again."
    : `Sign out on all devices? This will sign ${targetDisplayName} out of Spectre on every device. They will need to sign in again.`;

  const successCopy = isSelf
    ? "You have been signed out on all devices. Redirecting…"
    : `${targetDisplayName} has been signed out on all devices.`;

  return (
    <div
      data-testid={`tenant-user-signout:${targetUserId}`}
      data-is-self={isSelf ? "true" : "false"}
      className="space-y-2"
    >
      {!confirming && !message && (
        <button
          type="button"
          className="rounded-md border px-3 py-1 text-xs"
          style={{ borderColor: "#a8712a", color: "#7a4e14" }}
          data-testid={`tenant-user-signout-open:${targetUserId}`}
          onClick={() => {
            setConfirming(true);
            setError(null);
          }}
        >
          Sign out on all devices
        </button>
      )}
      {confirming && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-club-ink" style={{ color: "#4a453d" }}>
            {confirmCopy}
          </span>
          <button
            type="button"
            className="rounded-md px-3 py-1 text-xs font-semibold text-white"
            style={{ background: pending ? "#7a4e14" : "#a8712a" }}
            disabled={pending}
            data-testid={`tenant-user-signout-confirm:${targetUserId}`}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const r = await action();
                if (r.ok) {
                  setMessage(successCopy);
                  setConfirming(false);
                  if (r.selfRevocation) {
                    // Give the message one paint frame so the user
                    // sees "Redirecting…" before the navigation lands
                    // on /login.
                    setTimeout(() => {
                      window.location.href = "/login";
                    }, 200);
                  }
                } else {
                  setError(r.error);
                }
              });
            }}
          >
            {pending ? "Signing out…" : "Sign out on all devices"}
          </button>
          <button
            type="button"
            className="text-xs text-stone-500 underline"
            onClick={() => {
              setConfirming(false);
              setError(null);
            }}
          >
            Cancel
          </button>
        </div>
      )}
      {message && (
        <p
          role="status"
          className="text-xs text-emerald-800"
          data-testid={`tenant-user-signout-success:${targetUserId}`}
        >
          {message}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="text-xs text-red-700"
          data-testid={`tenant-user-signout-error:${targetUserId}`}
        >
          {error}
        </p>
      )}
    </div>
  );
}
