"use client";

// WEB-1D · Employee Portal login form. Structural behaviour unchanged
// from HR-2B.5 §7-9 (email + password, show/hide password toggle, POST
// to the server action). Presentation moved to the shared `.spectre-auth`
// design system so the portal reads as an extension of the Spectre
// marketing surface.
//
// §7 + [[feedback_member_brand_shielding]]: the "Spectre" wordmark is
// never shown on this surface; the parent page renders the Club name
// or a neutral fallback. This component is presentation-only.

import { useState } from "react";
import { useFormStatus } from "react-dom";

// WEB-1D.7 — pending-state submit button for the Employee Portal.
// Mirrors the WEB-1D.6 admin AdminSignInButton behaviour with an
// employee-specific normal label ("Sign in", not "Sign in to Spectre").
// Declared as a nested client component so useFormStatus() reads the
// pending state of its nearest ancestor <form> (the employee form
// below). The employee form's server action is unchanged; this only
// swaps inner content while pending, disables the button to prevent
// duplicate submission, and sets aria-busy for AT. Prefers-reduced-
// motion is honoured via the .auth-submit-spinner rule already
// shipped by WEB-1D.6 in auth.css — no CSS delta this phase.
// Duplication vs abstraction (§14): the pattern is ~10 lines. A
// shared component would require refactoring the frozen admin button
// (WEB-1D.6 §18) for a two-prop saving. The smallest safe change is
// duplication.
function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="auth-submit"
      disabled={pending}
      aria-busy={pending}
      data-testid="employee-login-submit"
    >
      {pending ? (
        <span className="auth-submit-pending">
          <span className="auth-submit-spinner" aria-hidden="true" />
          <span>Signing in&hellip;</span>
        </span>
      ) : (
        "Sign in"
      )}
    </button>
  );
}

export default function EmployeeLoginForm({
  action,
}: {
  action: (formData: FormData) => Promise<void> | void;
}) {
  const [showPassword, setShowPassword] = useState(false);

  return (
    <form action={action} className="auth-form" noValidate>
      <div className="auth-field">
        <label className="auth-label" htmlFor="employee-login-email">Email address</label>
        <input
          id="employee-login-email"
          name="email"
          type="email"
          className="auth-input"
          autoComplete="username"
          inputMode="email"
          required
          maxLength={254}
          placeholder="you@example.com"
          data-testid="employee-login-email"
        />
      </div>
      <div className="auth-field">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <label className="auth-label" htmlFor="employee-login-password">Password</label>
          <button
            type="button"
            className="auth-utility-muted"
            style={{
              background: "transparent",
              border: 0,
              cursor: "pointer",
              fontSize: "0.7rem",
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              padding: 0,
            }}
            onClick={() => setShowPassword((s) => !s)}
            data-testid="employee-login-toggle"
          >
            {showPassword ? "Hide" : "Show"}
          </button>
        </div>
        <input
          id="employee-login-password"
          name="password"
          type={showPassword ? "text" : "password"}
          className="auth-input"
          autoComplete="current-password"
          required
          data-testid="employee-login-password"
        />
      </div>
      <SubmitButton />
    </form>
  );
}
