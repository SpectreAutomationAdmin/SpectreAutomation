"use client";

// HR-2B.5 §27-28 (2026-08-19) — Final attestation + Submit.
//
// The employee ticks a single "the information I've provided is
// accurate" acknowledgement, which enables the Submit button.
// Legally-significant TD1 attestations are separate and were
// captured earlier in the payroll section (§27 — this general
// statement does NOT replace them).
//
// Submit posts through `submitOnboardingAction` (server), which
// re-validates readiness server-side. The client-side gate is a
// UX convenience, never the security boundary.

import { useState } from "react";

interface Props {
  action: (formData: FormData) => Promise<void> | void;
  /** True when every server-side precondition is met (payroll +
   *  credential). If false, the form is rendered as read-only with
   *  a hint pointing back to the incomplete section. */
  canSubmit: boolean;
}

export default function ReviewSubmitForm({ action, canSubmit }: Props) {
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);

  const enabled = canSubmit && attested;

  return (
    <form
      action={async (fd) => {
        setBusy(true);
        await action(fd);
      }}
      className="rounded-lg border border-emerald-200 bg-emerald-50/40 px-5 py-5 md:px-6 md:py-6"
      data-testid="review-submit-form"
    >
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          name="attested"
          value="1"
          checked={attested}
          onChange={(e) => setAttested(e.target.checked)}
          className="mt-1 text-emerald-700 focus:ring-emerald-700"
          data-testid="review-attestation-checkbox"
        />
        <span className="text-sm text-stone-800 leading-relaxed">
          I confirm that the information I&apos;ve provided is accurate to the best of
          my knowledge.
        </span>
      </label>

      {!canSubmit && (
        <p
          className="mt-3 text-xs text-amber-700"
          data-testid="review-cannot-submit-notice"
        >
          Something above is still incomplete. Please revisit the section marked
          &ldquo;Not set&rdquo; before submitting.
        </p>
      )}

      <div className="mt-5 flex items-center justify-end">
        <button
          type="submit"
          disabled={!enabled || busy}
          data-testid="review-submit-button"
          className="rounded-md bg-emerald-800 px-6 py-2.5 text-sm font-medium text-white hover:bg-emerald-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:ring-offset-2 disabled:bg-stone-300 disabled:cursor-not-allowed"
        >
          {busy ? "Submitting…" : "Submit onboarding"}
        </button>
      </div>
    </form>
  );
}
