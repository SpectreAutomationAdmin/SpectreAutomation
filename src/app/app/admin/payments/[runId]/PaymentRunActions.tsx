"use client";

// PAY-1A/5 (2026-09-26) — actions on a payment run.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface Props {
  runId: string;
  status: string;
  canPrepare: boolean;
  canAuthorize: boolean;
  canCancel: boolean;
}

export default function PaymentRunActions(props: Props) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function invoke(action: string, extra?: { reason?: string }) {
    setError(null);
    const res = await fetch(`/api/payments/runs/${props.runId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error || `${action} failed`);
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <section className="mt-8 rounded-md border border-stone-200 bg-white px-4 py-4" data-testid="run-actions">
      <h2 className="text-sm font-medium text-stone-900">Actions</h2>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {props.status === "PREPARED" && props.canPrepare && (
          <button
            type="button" disabled={isPending}
            onClick={() => invoke("submit-for-authorization")}
            data-testid="btn-submit-for-authorization"
            className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-900 hover:bg-stone-50"
          >
            Submit for authorization
          </button>
        )}
        {props.status === "PENDING_AUTHORIZATION" && props.canAuthorize && (
          <>
            <button
              type="button" disabled={isPending}
              onClick={() => invoke("authorize")}
              data-testid="btn-authorize"
              className="rounded-md bg-stone-900 px-3 py-1.5 text-sm text-white hover:bg-stone-800"
            >
              Authorize payment
            </button>
            <button
              type="button" disabled={isPending}
              onClick={() => {
                const reason = window.prompt("Return reason:");
                if (reason) invoke("return", { reason });
              }}
              data-testid="btn-return"
              className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-50"
            >
              Return for changes
            </button>
          </>
        )}
        {["PREPARED","PENDING_AUTHORIZATION","AUTHORIZED","SCHEDULED"].includes(props.status) && props.canCancel && (
          <button
            type="button" disabled={isPending}
            onClick={() => {
              const reason = window.prompt("Cancel reason:");
              if (reason) invoke("cancel", { reason });
            }}
            data-testid="btn-cancel"
            className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
          >
            Cancel
          </button>
        )}
        {(props.status === "AUTHORIZED" || props.status === "SCHEDULED") && props.canPrepare && (
          <button
            type="button" disabled={isPending}
            onClick={() => invoke("submit-to-provider")}
            data-testid="btn-submit-to-provider"
            className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-900 hover:bg-stone-50"
          >
            Submit to provider
          </button>
        )}
        {["SUBMITTED","ACCEPTED"].includes(props.status) && (
          <button
            type="button" disabled={isPending}
            onClick={() => invoke("poll")}
            data-testid="btn-poll"
            className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-900 hover:bg-stone-50"
          >
            Refresh status
          </button>
        )}
      </div>
      {error && <p className="mt-3 text-sm text-red-700" role="alert">{error}</p>}
    </section>
  );
}
