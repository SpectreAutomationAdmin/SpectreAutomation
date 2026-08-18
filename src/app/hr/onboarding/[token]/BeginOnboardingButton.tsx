"use client";

// HR-2B.1 (2026-08-18) — Begin onboarding submit button.
//
// Small client component so we can disable the button on submit (and
// avoid double-redemption if the employee taps twice). The parent
// server action handles rate-limit + redeem + session.

import { useFormStatus } from "react-dom";

export default function BeginOnboardingButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      data-testid="hr-onboarding-begin"
      className="w-full md:w-auto inline-flex items-center justify-center rounded-md bg-club-green-700 text-white font-medium px-6 py-3 text-base hover:bg-club-green-800 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
    >
      {pending ? "Just a moment…" : "Begin onboarding"}
    </button>
  );
}
