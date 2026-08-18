"use client";

// HR-2B.3.1 (2026-08-18) §5 — "Resend invitation" client action.
//
// Small companion to `InviteToOnboardingButton`. Fires when the
// employee already has an active or in-progress session AND at least
// one prior invitation exists. Confirms with the operator, then POSTs
// to `/api/people/employees/[id]/invitation/resend`. Renders the same
// four outcome banners (DELIVERED / DEV_LOGGED / FAILED /
// NOT_ATTEMPTED) as the initial-invitation button so the operator
// never has to interpret two different vocabularies.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type EmailStatus = "DELIVERED" | "DEV_LOGGED" | "FAILED" | "NOT_ATTEMPTED";

interface ResendResponse {
  invitationId?: string;
  expiresAt?: string;
  sessionState?: string;
  supersededInvitationId?: string | null;
  email?: {
    status: EmailStatus;
    provider: string | null;
    externalSendConfirmed: boolean;
    failureReason: string | null;
    operatorAlert: boolean;
    senderIdentity: string | null;
  };
  error?: string;
}

export interface PriorInvitation {
  createdAt: string;
  recipientEmail: string | null;
}

interface Props {
  employeeId: string;
  priorInvitation: PriorInvitation | null;
}

function formatSentDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export default function ResendOnboardingButton({ employeeId, priorInvitation }: Props) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<ResendResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleClick() {
    if (pending) return;
    if (!window.confirm("Send a new invitation to this employee? This will invalidate the previous link.")) return;
    setOutcome(null);
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/people/employees/${employeeId}/invitation/resend`, {
          method: "POST",
        });
        const data: ResendResponse = await res.json().catch(() => ({}));
        // Same status vocabulary as the initial invitation:
        //   201 = delivered · 202 = persisted-without-external-send · 502 = provider-rejected
        const persisted = res.status === 201 || res.status === 202 || res.status === 502;
        if (!persisted) {
          setError(typeof data.error === "string" ? data.error : "Could not reissue invitation.");
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
    const { status, provider, failureReason, senderIdentity } = outcome.email;
    if (status === "DELIVERED") {
      return (
        <div
          role="status"
          data-testid="invitation-resend-delivered"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
        >
          New invitation sent{senderIdentity ? (
            <>
              {" from "}
              <span className="font-medium">{senderIdentity}</span>
            </>
          ) : (
            <>
              {" via "}
              <span className="font-medium">{provider ?? "email"}</span>
            </>
          )}
          . The previous link is no longer valid.
        </div>
      );
    }
    if (status === "DEV_LOGGED") {
      return (
        <div
          role="alert"
          data-testid="invitation-resend-dev-logged"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          New invitation created, but no email was sent — this Club has no email provider configured.
          The previous link is no longer valid.
        </div>
      );
    }
    if (status === "NOT_ATTEMPTED") {
      return (
        <div
          role="alert"
          data-testid="invitation-resend-not-attempted"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          New invitation created, but no email was sent — {failureReason ?? "no recipient email on file"}.
        </div>
      );
    }
    return (
      <div
        role="alert"
        data-testid="invitation-resend-failed"
        className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
      >
        New invitation created, but the email could not be sent. Please try again or contact your administrator.
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
        data-testid="invitation-resend-button"
        className="btn btn-secondary"
        onClick={handleClick}
        disabled={pending}
      >
        {pending ? "Sending new invitation…" : "Resend invitation"}
      </button>
      {priorInvitation && (
        <p className="text-xs text-stone-500" data-testid="invitation-prior-sent">
          Invitation sent {formatSentDate(priorInvitation.createdAt)}
          {priorInvitation.recipientEmail ? (
            <>
              {" to "}
              <span className="font-medium text-stone-700">{priorInvitation.recipientEmail}</span>
            </>
          ) : null}
        </p>
      )}
      {error && (
        <div role="alert" data-testid="invitation-resend-error" className="text-xs text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}
