"use client";

// HR-2B.5 §4-9 (2026-08-19) — Portal password creation form.
//
// Client component so the two-field client-side match check gives
// immediate feedback without a server round-trip. The plaintext still
// posts through a normal form submission to the server action, which
// re-validates on the server (never trust the client).
//
// Founder rules honoured (§9):
//   - No paste-disable, no length truncation on the input itself.
//   - Sensible modern minimum length (server-enforced).
//   - Show / hide toggle so the employee can verify what they typed.
//   - No enumeration-friendly error text — the server actions return
//     a neutral message and this form displays it verbatim.

import { useState } from "react";

interface Props {
  action: (formData: FormData) => Promise<void> | void;
  minLength: number;
}

export default function PortalPasswordForm({ action, minLength }: Props) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);

  const tooShort = password.length > 0 && password.length < minLength;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = password.length >= minLength && confirm === password;

  return (
    <form action={action} className="mt-2 space-y-5" noValidate>
      <div>
        <label className="label" htmlFor="password">Create your password</label>
        <div className="mt-1 flex items-center gap-2">
          <input
            id="password"
            name="password"
            type={show ? "text" : "password"}
            className="input flex-1"
            autoComplete="new-password"
            minLength={minLength}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="portal-password-input"
          />
          <button
            type="button"
            className="text-xs text-stone-500 hover:text-stone-800 underline"
            onClick={() => setShow((s) => !s)}
            data-testid="portal-password-toggle"
          >
            {show ? "Hide" : "Show"}
          </button>
        </div>
        <p className="mt-1 text-xs text-stone-500">
          Use at least {minLength} characters. A passphrase you can remember is fine
          — password managers welcome.
        </p>
        {tooShort && (
          <p className="mt-1 text-xs text-red-700" data-testid="portal-password-too-short">
            Password must be at least {minLength} characters.
          </p>
        )}
      </div>

      <div>
        <label className="label" htmlFor="confirmPassword">Confirm password</label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type={show ? "text" : "password"}
          className="input mt-1"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          data-testid="portal-password-confirm"
        />
        {mismatch && (
          <p className="mt-1 text-xs text-red-700" data-testid="portal-password-mismatch">
            Passwords do not match.
          </p>
        )}
      </div>

      <div className="flex items-center justify-end pt-2">
        <button
          type="submit"
          disabled={!canSubmit}
          data-testid="portal-password-submit"
          className="rounded-md bg-emerald-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:ring-offset-2 disabled:bg-stone-300 disabled:cursor-not-allowed"
        >
          Continue
        </button>
      </div>
    </form>
  );
}
