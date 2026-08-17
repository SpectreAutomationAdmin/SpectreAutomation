"use client";

// HR-2A (2026-08-16) — "Invite to complete onboarding" action.
//
// Small client component that POSTs to the invitation API when
// the operator confirms. The response contains only `invitationId`
// + `expiresAt` — the raw magic-link token is NEVER returned in
// the response body. HR-2B replaces the dev-stderr log with a
// real email delivery pipeline.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export default function InviteToOnboardingButton({ employeeId }: { employeeId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    if (isPending) return;
    if (!window.confirm("Send onboarding invitation to this employee?")) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/people/employees/${employeeId}/invitation`, {
          method: "POST",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(typeof data.error === "string" ? data.error : "Could not issue invitation.");
          return;
        }
        setSent(true);
        router.refresh();
      } catch {
        setError("Network error — please try again.");
      }
    });
  }

  if (sent) {
    return (
      <div className="rounded-md border border-club-green-300 bg-club-green-50 px-3 py-2 text-sm text-club-green-800">
        Invitation issued. The employee will receive an onboarding email once HR-2B ships email delivery.
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        className="btn btn-primary"
        onClick={handleClick}
        disabled={isPending}
      >
        {isPending ? "Issuing invitation…" : "Invite to complete onboarding"}
      </button>
      {error && (
        <div role="alert" className="text-xs text-red-700">{error}</div>
      )}
    </div>
  );
}
