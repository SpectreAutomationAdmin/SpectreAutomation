"use client";

// HR-2B.5 §39-40 (2026-08-19) — First-login guided tour.
// HR-2C §6-9, §45-46 (2026-08-20) — Rebuilt as anchored coach-marks.
//
// Each step now attaches to the actual UI element it describes (via
// `data-tour-target` or an existing `data-testid`), instead of the
// prior detached bottom-right modal. The Welcome step anchors to the
// portal hero region so the header stays visible.
//
// New step: Safety & Training (§45).
// Replay: honoured by the `openOnMount` prop — when true, the tour
// re-launches regardless of the persisted `portalTourCompletedAt`
// state. See `TourReplayButton` for the Help affordance.
//
// Persistence unchanged (§40): Finish / Skip POST to
// /api/employee/tour-completed which sets Employee.portalTourCompletedAt.
// Replay never resets that timestamp — it simply re-mounts the tour.

import { useEffect, useState } from "react";
import CoachMark, { type CoachMarkSide } from "./CoachMark";

interface Step {
  title: string;
  body: string;
  /** CSS selector for the anchor. Preferred: `[data-tour-target="…"]`.
   *  Falls back to the existing `[data-testid="portal-nav-…"]` on the
   *  sidebar. */
  targetSelector: string;
  preferredSide?: CoachMarkSide;
}

const STEPS: Step[] = [
  {
    title: "Welcome to your employee portal.",
    body:
      "Take a quick look at what lives here — you can skip anytime and come back to it later from the Help menu.",
    targetSelector: '[data-testid="portal-hero"]',
    preferredSide: "bottom",
  },
  {
    title: "Schedule",
    body: "Your work schedule and upcoming shifts will appear here.",
    targetSelector: '[data-tour-target="schedule"], [data-testid="portal-nav-schedule"]',
    preferredSide: "right",
  },
  {
    title: "Availability",
    body: "Use Availability to let the Club know when you're available to work.",
    targetSelector: '[data-tour-target="availability"], [data-testid="portal-nav-availability"]',
    preferredSide: "right",
  },
  {
    title: "Pay",
    body: "This is where you'll find your pay statements and payroll information.",
    targetSelector: '[data-tour-target="pay"], [data-testid="portal-nav-pay"]',
    preferredSide: "right",
  },
  {
    title: "Safety & Training",
    body:
      "Complete the Club's required training and safety courses here.",
    targetSelector: '[data-tour-target="training"], [data-testid="portal-nav-safety-&-training"]',
    preferredSide: "right",
  },
  {
    title: "Documents",
    body: "Your employee documents and certifications live here.",
    targetSelector: '[data-tour-target="documents"], [data-testid="portal-nav-documents"]',
    preferredSide: "right",
  },
  {
    title: "Profile",
    body:
      "Review your employee information and keep your contact details current.",
    targetSelector: '[data-tour-target="profile"], [data-testid="portal-nav-profile"]',
    preferredSide: "right",
  },
];

interface Props {
  /** True when Employee.portalTourCompletedAt is set (from the
   *  server). Suppresses the initial launch unless `openOnMount` is
   *  also true. */
  alreadyDone: boolean;
  /** Force the tour to render immediately even when alreadyDone.
   *  Used by the "Take the portal tour" replay affordance. Never
   *  resets the timestamp — replay is just a re-mount. */
  openOnMount?: boolean;
}

export default function EmployeeTourOnFirstLogin({
  alreadyDone,
  openOnMount = false,
}: Props) {
  const [step, setStep] = useState(0);
  const [dismissed, setDismissed] = useState(alreadyDone && !openOnMount);

  useEffect(() => {
    if (openOnMount) {
      setDismissed(false);
      setStep(0);
    }
  }, [openOnMount]);

  // HR-2C B3.1 — On mobile the sidebar is hidden inside the drawer.
  // The tour dispatches a custom event so EmployeePortalMobileNav
  // opens its drawer, letting the coach-mark anchor on a real
  // (visible) nav element. Ignored on ≥ md.
  useEffect(() => {
    if (dismissed) return;
    if (typeof window === "undefined") return;
    if (window.matchMedia("(max-width: 767px)").matches) {
      document.dispatchEvent(new CustomEvent("spectre:portal:mobile-nav:open"));
    }
  }, [dismissed]);

  async function complete(finish: boolean) {
    setDismissed(true);
    if (typeof document !== "undefined") {
      // Close the drawer on mobile so the employee returns to the
      // page they started on.
      document.dispatchEvent(new CustomEvent("spectre:portal:mobile-nav:close"));
    }
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
  const isFirst = step === 0;

  return (
    <CoachMark
      targetSelector={s.targetSelector}
      preferredSide={s.preferredSide ?? "right"}
      testId="portal-tour"
      onTargetMissing={() => {
        // Anchor missing (e.g. Safety & Training on a viewport where
        // the sidebar is collapsed). Advance to the next step so the
        // tour keeps moving.
        if (isLast) void complete(true);
        else setStep((n) => n + 1);
      }}
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
        <p className="text-sm text-stone-700 leading-relaxed" data-testid="portal-tour-body">
          {s.body}
        </p>
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
            disabled={isFirst}
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
    </CoachMark>
  );
}
