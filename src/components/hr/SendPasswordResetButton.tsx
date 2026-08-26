"use client";

// HR mobile-hotfix (2026-08-26) — Employee Profile → "Send password
// reset" action. Restrained, confirm-then-fire. Never shows the
// resulting reset URL or the employee's password. Only the
// canonical send flow — server enforces hr:employee:write.

import { useState, useTransition } from "react";

interface Props {
  employeeId: string;
  employeeDisplayName: string;
  hasPersonalEmail: boolean;
  action: () => Promise<{ ok: true } | { ok: false; error: string }>;
}

export default function SendPasswordResetButton({
  employeeId, employeeDisplayName, hasPersonalEmail, action,
}: Props) {
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!hasPersonalEmail) {
    return (
      <p className="text-xs text-stone-500" data-testid="portal-reset-no-email">
        No email address on file for {employeeDisplayName} — record their
        email in Overview before sending a reset link.
      </p>
    );
  }

  return (
    <div data-testid="portal-reset-admin" data-employee-id={employeeId} className="space-y-2">
      {!confirming && !message && (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          data-testid="portal-reset-admin-open"
          onClick={() => { setConfirming(true); setError(null); }}
        >
          Send password reset
        </button>
      )}
      {confirming && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-club-ink">
            Email a one-time password-reset link to {employeeDisplayName}?
          </span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={pending}
            data-testid="portal-reset-admin-confirm"
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const r = await action();
                if (r.ok) {
                  setMessage("Reset link sent. The employee's next sign-in will use their new password.");
                  setConfirming(false);
                } else {
                  setError(r.error);
                }
              });
            }}
          >
            {pending ? "Sending…" : "Send reset link"}
          </button>
          <button
            type="button"
            className="text-xs text-stone-500 underline"
            onClick={() => { setConfirming(false); setError(null); }}
          >
            Cancel
          </button>
        </div>
      )}
      {message && (
        <p role="status" className="text-xs text-emerald-800" data-testid="portal-reset-admin-sent">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-700" data-testid="portal-reset-admin-error">
          {error}
        </p>
      )}
    </div>
  );
}
