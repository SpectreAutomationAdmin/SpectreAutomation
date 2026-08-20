"use client";

// HR-2B.5 §39-40 (2026-08-19) — First-login guided tour.
//
// Restrained coach marks (not a blocking multi-step modal per §39).
// Renders NULL when the employee has already dismissed / completed
// the tour; otherwise walks them through Pay / Schedule / Availability
// / Documents / Profile with Next / Back / Skip / Finish.
//
// Persistence: on Finish or Skip, POSTs to /api/employee/tour-completed
// which sets Employee.portalTourCompletedAt so subsequent logins do
// not replay the tour. Manual replay via /employee/help/tour is a
// future affordance (§40).

import { useEffect, useState } from "react";

const STEPS: Array<{ title: string; body: string; targetTestId?: string }> = [
  {
    title: "Welcome to your employee portal.",
    body: "Take a quick look at what lives here — you can skip anytime and come back to it later.",
  },
  {
    title: "Pay",
    body: "This is where you'll find your pay statements and payroll information.",
    targetTestId: "portal-nav-pay",
  },
  {
    title: "Schedule",
    body: "Your work schedule will appear here.",
    targetTestId: "portal-nav-schedule",
  },
  {
    title: "Availability",
    body: "Use Availability to let the Club know when you're available to work.",
    targetTestId: "portal-nav-availability",
  },
  {
    title: "Documents",
    body: "Your employee documents and certifications live here.",
    targetTestId: "portal-nav-documents",
  },
  {
    title: "Profile",
    body: "Review your employee information and keep your contact details current.",
    targetTestId: "portal-nav-profile",
  },
];

interface Props {
  /** If true, the tour has already been completed / skipped — do not
   *  render. The server has this info because Employee.portalTourCompletedAt
   *  is set. */
  alreadyDone: boolean;
}

export default function EmployeeTourOnFirstLogin({ alreadyDone }: Props) {
  const [step, setStep] = useState(0);
  const [dismissed, setDismissed] = useState(alreadyDone);

  useEffect(() => {
    if (alreadyDone) setDismissed(true);
  }, [alreadyDone]);

  async function complete(finish: boolean) {
    setDismissed(true);
    // Best-effort record. If the fetch fails, the worst-case is the
    // tour replays on next login — no data corruption.
    try {
      await fetch("/api/employee/tour-completed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ finished: finish }),
      });
    } catch {
      /* noop */
    }
  }

  if (dismissed) return null;
  const s = STEPS[step]!;
  const isLast = step === STEPS.length - 1;

  return (
    <div
      role="dialog"
      aria-label="Portal tour"
      className="fixed bottom-6 right-6 z-40 w-[min(360px,90vw)] rounded-lg border border-stone-200 bg-white shadow-lg"
      data-testid="portal-tour"
    >
      <div className="px-5 py-4 border-b border-stone-100">
        <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">
          Portal tour · {step + 1} of {STEPS.length}
        </div>
        <h2 className="mt-2 font-serif text-lg text-club-ink" data-testid="portal-tour-title">
          {s.title}
        </h2>
      </div>
      <div className="px-5 py-4">
        <p className="text-sm text-stone-700 leading-relaxed">{s.body}</p>
      </div>
      <div className="px-5 py-3 border-t border-stone-100 flex items-center justify-between">
        <button
          type="button"
          onClick={() => complete(false)}
          className="text-xs text-stone-500 hover:text-stone-800 underline underline-offset-4"
          data-testid="portal-tour-skip"
        >
          Skip tour
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setStep((n) => Math.max(0, n - 1))}
            disabled={step === 0}
            className="rounded-md border border-stone-200 px-3 py-1.5 text-xs text-stone-600 hover:bg-stone-50 disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid="portal-tour-back"
          >
            Back
          </button>
          {!isLast ? (
            <button
              type="button"
              onClick={() => setStep((n) => Math.min(STEPS.length - 1, n + 1))}
              className="rounded-md bg-emerald-800 px-3 py-1.5 text-xs text-white hover:bg-emerald-900"
              data-testid="portal-tour-next"
            >
              Next
            </button>
          ) : (
            <button
              type="button"
              onClick={() => complete(true)}
              className="rounded-md bg-emerald-800 px-3 py-1.5 text-xs text-white hover:bg-emerald-900"
              data-testid="portal-tour-finish"
            >
              Finish
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
