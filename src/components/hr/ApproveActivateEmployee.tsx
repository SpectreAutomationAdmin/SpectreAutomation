"use client";

// HR mobile-hotfix (2026-08-30) — admin action for approving a
// submitted onboarding + activating the employee (§4).
//
// Wrapped in a client component ONLY for the confirmation UX +
// pending state; the actual write goes through the server action
// which enforces both `hr:onboarding:approve` + `hr:employee:write`
// permissions. UI is deliberately restrained — a readiness panel
// (rendered as a plain <ul>) + one primary action button. Zero
// plaintext SIN or banking is displayed here.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { OnboardingApprovalReadiness } from "@/lib/hr/onboarding-approve-activate";

interface Props {
  readiness: OnboardingApprovalReadiness;
  action: () => Promise<{ ok: true } | { ok: false; error: string }>;
}

function StatusRow({ label, ready, muted }: { label: string; ready: boolean; muted?: string }) {
  return (
    <li
      className="flex items-baseline justify-between gap-3 py-1"
      data-testid={`approve-readiness-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
    >
      <span className="text-sm text-club-ink">{label}</span>
      <span
        className={
          "text-xs font-medium " + (ready ? "text-emerald-800" : "text-amber-800")
        }
      >
        {ready ? (muted ?? "Ready") : "Missing"}
      </span>
    </li>
  );
}

export default function ApproveActivateEmployee({ readiness, action }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  // If the employee is already ACTIVE, render a summary row instead
  // of the action button. Idempotent — the service call would
  // return the same state anyway but the UI shouldn't invite it.
  if (readiness.employeeLifecycle === "ACTIVE" && readiness.session?.state === "APPROVED") {
    return (
      <section
        className="spectre-person-section mt-6"
        data-testid="approve-activate-already-active"
      >
        <div className="spectre-person-section-head">
          <h3 className="spectre-person-eyebrow">Onboarding</h3>
        </div>
        <p className="text-sm text-emerald-800">
          Onboarding approved &middot; employee is currently active.
        </p>
      </section>
    );
  }

  // Session not submitted yet → informational; no action.
  if (readiness.session?.state !== "SUBMITTED") {
    return (
      <section
        className="spectre-person-section mt-6"
        data-testid="approve-activate-not-ready"
      >
        <div className="spectre-person-section-head">
          <h3 className="spectre-person-eyebrow">Onboarding</h3>
        </div>
        <p className="text-sm text-stone-500">
          Waiting for the employee to complete + submit their onboarding
          {readiness.session?.state ? ` (session: ${readiness.session.state.toLowerCase()})` : ""}.
        </p>
      </section>
    );
  }

  const disabled = !readiness.readyForApproval || !readiness.callerCanApprove || pending;

  return (
    <section
      className="spectre-person-section mt-6"
      data-testid="approve-activate-section"
    >
      <div className="spectre-person-section-head">
        <h3 className="spectre-person-eyebrow">Approve &amp; Activate</h3>
      </div>
      <p className="text-sm text-stone-500 mt-1">
        {readiness.displayName} has submitted onboarding. Confirm the
        readiness summary below and activate them when ready.
      </p>

      <ul className="mt-3 divide-y divide-stone-100" data-testid="approve-readiness-list">
        <StatusRow label="Employment assignment" ready={readiness.employmentAssignmentPresent} />
        <StatusRow label="Personal details" ready={readiness.personalDetailsPresent} />
        <StatusRow label="SIN" ready={readiness.sinPresent} muted="On file" />
        <StatusRow
          label="Direct deposit"
          ready={readiness.bankingPresent}
          muted={readiness.bankingStatus ? `On file · ${readiness.bankingStatus}` : "Ready"}
        />
        <StatusRow label="Federal TD1" ready={readiness.federalTd1Present} />
        <StatusRow label="Provincial TD1" ready={readiness.provincialTd1Present} />
        <StatusRow label="Emergency contact" ready={readiness.emergencyContactPresent} />
        <StatusRow label="Portal credential" ready={readiness.portalCredentialPresent} />
      </ul>

      {!readiness.callerCanApprove && (
        <p className="mt-3 text-xs text-stone-500" data-testid="approve-activate-no-permission">
          You need HR onboarding approval permission to complete this action.
        </p>
      )}

      {!confirming ? (
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={disabled}
            data-testid="btn-approve-activate"
            onClick={() => { setConfirming(true); setError(null); }}
          >
            Approve &amp; Activate Employee
          </button>
          {!readiness.readyForApproval && (
            <span className="text-xs text-amber-800">
              Address the missing items above before approving.
            </span>
          )}
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-3" data-testid="approve-activate-confirm">
          <span className="text-sm text-club-ink">
            Approve onboarding and set {readiness.displayName} as ACTIVE?
          </span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={pending}
            data-testid="btn-approve-activate-confirm"
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const result = await action();
                if (result.ok) {
                  setConfirming(false);
                  router.refresh();
                } else {
                  setError(result.error);
                }
              });
            }}
          >
            {pending ? "Approving…" : "Yes, activate"}
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
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-700" data-testid="approve-activate-error">
          {error}
        </p>
      )}
    </section>
  );
}
