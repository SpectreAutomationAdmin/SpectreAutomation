"use client";

// HR-2A (2026-08-16) — "Invite to complete onboarding" action.
// HR-2B.3 tail (2026-08-20) — surface distinct delivery outcomes so
// the Club-side UI never masquerades a console-only DEV_LOGGED as
// a real send.
//
// Small client component that POSTs to the invitation API when
// the operator confirms. The response contains only `invitationId`
// + `expiresAt` + a safe `email` block — the raw magic-link token
// is NEVER returned in the response body.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type EmailStatus = "DELIVERED" | "DEV_LOGGED" | "FAILED" | "NOT_ATTEMPTED";

interface InvitationResponse {
  invitationId?: string;
  expiresAt?: string;
  sessionState?: string;
  email?: {
    status: EmailStatus;
    provider: string | null;
    externalSendConfirmed: boolean;
    failureReason: string | null;
    operatorAlert: boolean;
  };
  error?: string;
}

export default function InviteToOnboardingButton({ employeeId }: { employeeId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<InvitationResponse | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    if (isPending) return;
    if (!window.confirm("Send onboarding invitation to this employee?")) return;
    setError(null);
    setOutcome(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/people/employees/${employeeId}/invitation`, {
          method: "POST",
        });
        const data: InvitationResponse = await res.json().catch(() => ({}));
        // 201 = delivered · 202 = persisted-without-external-send · 502 = provider-rejected
        // Anything else = the invitation itself did not persist (auth, conflict, …).
        const invitationPersisted = res.status === 201 || res.status === 202 || res.status === 502;
        if (!invitationPersisted) {
          setError(typeof data.error === "string" ? data.error : "Could not issue invitation.");
          return;
        }
        setOutcome(data);
        router.refresh();
      } catch {
        setError("Network error — please try again.");
      }
    });
  }

  if (outcome && outcome.email) {
    const { status, provider, failureReason } = outcome.email;
    if (status === "DELIVERED") {
      return (
        <div
          role="status"
          data-testid="invitation-outcome-delivered"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
        >
          Invitation sent. The employee will receive an email from{" "}
          <span className="font-medium">{provider ?? "email"}</span> shortly.
        </div>
      );
    }
    if (status === "DEV_LOGGED") {
      return (
        <div
          role="alert"
          data-testid="invitation-outcome-dev-logged"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          Invitation created, but no email was sent — this Club has no email provider configured
          (the console-only development adapter fired instead). Ask your administrator to configure
          Spectre email delivery for this Club.
        </div>
      );
    }
    if (status === "NOT_ATTEMPTED") {
      return (
        <div
          role="alert"
          data-testid="invitation-outcome-not-attempted"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          Invitation created, but no email was sent — {failureReason ?? "no recipient email on file"}
          . Add a personal email to this employee and re-issue.
        </div>
      );
    }
    // FAILED
    return (
      <div
        role="alert"
        data-testid="invitation-outcome-failed"
        className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
      >
        Invitation created, but the email could not be sent. Please try again or contact your
        administrator.
        {failureReason && (
          <div className="mt-1 text-xs text-red-700">Provider reason: {failureReason}</div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        data-testid="invitation-invite-button"
        className="btn btn-primary"
        onClick={handleClick}
        disabled={isPending}
      >
        {isPending ? "Issuing invitation…" : "Invite to complete onboarding"}
      </button>
      {error && (
        <div role="alert" data-testid="invitation-invite-error" className="text-xs text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}
