"use client";

// TA-1B closeout — existing-user "Accept invitation" button.
//
// One click, no password entry, no form. Posts { token } to the
// activation endpoint which dispatches to the existing-user path.

import { useState } from "react";
import { useRouter } from "next/navigation";

export function AcceptInvitationButton({ token }: { token: string }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/invite/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean };
      if (!res.ok) {
        setError(j.error ?? `Activation failed (HTTP ${res.status})`);
        setSubmitting(false);
        return;
      }
      router.push("/app/admin?invitation=accepted");
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <div data-testid="invite-existing-user-accept">
      {error ? (
        <div
          style={{
            padding: 12, marginBottom: 16, background: "#fef2f2",
            border: "1px solid #b91c1c", borderRadius: 4, color: "#7f1d1d", fontSize: 13,
          }}
          data-testid="invite-accept-error"
        >
          {error}
        </div>
      ) : null}
      <button
        type="button"
        onClick={accept}
        disabled={submitting}
        data-testid="invite-accept-btn"
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
        {submitting ? "Accepting…" : "Accept invitation"}
      </button>
    </div>
  );
}
