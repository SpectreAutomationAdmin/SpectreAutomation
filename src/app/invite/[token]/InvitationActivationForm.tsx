"use client";

// TA-1B — Invitation activation client form.
//
// Renders three fields (name, password, confirm) and posts them to the
// activation endpoint. On success, redirects the user to /login so they
// re-enter with the new password and pick up their tenant memberships
// through the normal auth flow.

import { useState } from "react";
import { useRouter } from "next/navigation";

export function InvitationActivationForm({
  token,
  suggestedName,
}: {
  token: string;
  suggestedName: string;
}) {
  const router = useRouter();
  const [fullName, setFullName] = useState(suggestedName);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/invite/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password, confirmPassword, fullName }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string; details?: unknown };
        setError(j.error ?? `Activation failed (HTTP ${res.status})`);
        setSubmitting(false);
        return;
      }
      router.push("/login?invitation=activated");
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} data-testid="invite-activation-form">
      <label style={{ display: "block", marginBottom: 12 }}>
        <span style={{ display: "block", fontSize: 12, color: "#4a453d", marginBottom: 4 }}>Your name</span>
        <input
          type="text"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          data-testid="invite-full-name"
          style={inputStyle}
          required
          minLength={1}
          maxLength={160}
          autoComplete="name"
        />
      </label>
      <label style={{ display: "block", marginBottom: 12 }}>
        <span style={{ display: "block", fontSize: 12, color: "#4a453d", marginBottom: 4 }}>
          New password (10+ characters, include upper / lower / digit)
        </span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          data-testid="invite-password"
          style={inputStyle}
          required
          minLength={10}
          maxLength={200}
          autoComplete="new-password"
        />
      </label>
      <label style={{ display: "block", marginBottom: 20 }}>
        <span style={{ display: "block", fontSize: 12, color: "#4a453d", marginBottom: 4 }}>Confirm password</span>
        <input
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          data-testid="invite-confirm-password"
          style={inputStyle}
          required
          minLength={10}
          maxLength={200}
          autoComplete="new-password"
        />
      </label>
      {error ? (
        <div
          style={{
            padding: 12,
            marginBottom: 16,
            background: "#fef2f2",
            border: "1px solid #b91c1c",
            borderRadius: 4,
            color: "#7f1d1d",
            fontSize: 13,
          }}
          data-testid="invite-error"
        >
          {error}
        </div>
      ) : null}
      <button
        type="submit"
        disabled={submitting}
        data-testid="invite-submit"
        style={{
          width: "100%",
          padding: "12px 16px",
          background: submitting ? "#4a5a4f" : "#1e3a2a",
          color: "white",
          border: 0,
          borderRadius: 4,
          fontSize: 14,
          fontWeight: 600,
          cursor: submitting ? "wait" : "pointer",
        }}
      >
        {submitting ? "Activating…" : "Activate access"}
      </button>
    </form>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  fontSize: 14,
  border: "1px solid #d0c9bd",
  borderRadius: 4,
  background: "white",
  color: "#1a1a1a",
};
