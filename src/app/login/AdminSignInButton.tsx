"use client";

// WEB-1D.6 — the admin Sign in button becomes a client component so it
// can read `useFormStatus()` and swap its inner content to a spinner +
// "Signing in…" label while the parent server action is in flight.
// The button remains inside the same <form action={loginAction}> in
// page.tsx — this component does NOT change any authentication logic,
// server action, session cookie, account-lock, rate-limit, audit-log,
// or tenant-resolution behaviour. It renders a different inner label,
// sets aria-busy + disabled to prevent duplicate submission, and
// nothing else. The external geometry of the button (width, height,
// padding, border, radius, colour) is unchanged: the .auth-submit
// class continues to size and skin the button; only the children swap.
//
// useFormStatus lives in react-dom (not react). It reads the pending
// state of the *nearest* ancestor <form>.

import { useFormStatus } from "react-dom";

interface Props {
  label: string;
}

export function AdminSignInButton({ label }: Props) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="auth-submit"
      disabled={pending}
      aria-busy={pending}
      data-testid="admin-login-submit"
    >
      {pending ? (
        <span className="auth-submit-pending">
          <span className="auth-submit-spinner" aria-hidden="true" />
          <span>Signing in&hellip;</span>
        </span>
      ) : (
        label
      )}
    </button>
  );
}
