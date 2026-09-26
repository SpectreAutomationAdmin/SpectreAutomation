"use client";

// AUTH-3C (2026-09-26) — Employee Profile → "Sign out on all devices".
//
// Restrained, confirm-then-fire. Mirrors SendPasswordResetButton's
// visual language exactly so the two security-adjacent controls read
// as a coherent pair. Never exposes session IDs, tokens, active-
// session counts, or database terminology (per founder brief §1).
//
// Idempotency: a zero-active-session target still returns { ok: true }
// from the server action; UI shows the same "signed out on all
// devices" confirmation (§35).

import { useState, useTransition } from "react";

interface Props {
  employeeId: string;
  employeeDisplayName: string;
  action: () => Promise<{ ok: true } | { ok: false; error: string }>;
}

export default function SignOutEmployeeEverywhereButton({
  employeeId,
  employeeDisplayName,
  action,
}: Props) {
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div
      data-testid="portal-signout-everywhere"
      data-employee-id={employeeId}
      className="space-y-2"
    >
      {!confirming && !message && (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          data-testid="portal-signout-everywhere-open"
          onClick={() => {
            setConfirming(true);
            setError(null);
          }}
        >
          Sign out on all devices
        </button>
      )}
      {confirming && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-club-ink">
            Sign out on all devices? This will sign {employeeDisplayName} out of
            Spectre on every device. They will need to sign in again.
          </span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={pending}
            data-testid="portal-signout-everywhere-confirm"
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const r = await action();
                if (r.ok) {
                  setMessage(`${employeeDisplayName} has been signed out on all devices.`);
                  setConfirming(false);
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
          data-testid="portal-signout-everywhere-success"
        >
          {message}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="text-xs text-red-700"
          data-testid="portal-signout-everywhere-error"
        >
          {error}
        </p>
      )}
    </div>
  );
}
