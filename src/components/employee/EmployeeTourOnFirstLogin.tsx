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

// HR-2C Shell Refinement (2026-08-24) — Tour steps now anchor to
// Home widgets (the actual product UI) instead of the removed
// sidebar links. The persistent left rail is Home + Profile only;
// functional destinations live in the Home widgets.
const STEPS: Step[] = [
  {
    title: "Welcome to your employee portal.",
    body:
      "Take a quick look at what lives here — you can skip anytime and come back to it later from the Help menu.",
    targetSelector: '[data-testid="portal-hero"]',
    preferredSide: "bottom",
  },
  {
    title: "Scheduling",
    body: "Your upcoming shifts and work schedule appear here.",
    targetSelector: '[data-tour-target="scheduling"]',
    preferredSide: "bottom",
  },
  {
    title: "Paystubs",
    body: "Your pay statements and payroll history live here.",
    targetSelector: '[data-tour-target="paystubs"]',
    preferredSide: "bottom",
  },
  {
    title: "Time Off Requests",
    body: "Request time off and see the status of your requests.",
    targetSelector: '[data-tour-target="time-off"]',
    preferredSide: "bottom",
  },
  {
    title: "Forms",
    body: "Complete and view forms your Club sends your way.",
    targetSelector: '[data-tour-target="forms"]',
    preferredSide: "bottom",
  },
  {
    title: "Safety & Training",
    body: "Complete the Club's required training and safety courses.",
    targetSelector: '[data-tour-target="training"]',
    preferredSide: "bottom",
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
  // HR mobile-hotfix (2026-08-30) — pause the popover render while
  // the mobile drawer is manually open. The drawer covers the
  // widget the popover is anchored to; when the drawer closes the
  // popover reappears at the same step. Not a state reset — the
  // tour's `step` + `dismissed` are preserved.
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (openOnMount) {
      setDismissed(false);
      setStep(0);
    }
  }, [openOnMount]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onOpen = () => setDrawerOpen(true);
    const onClose = () => setDrawerOpen(false);
    document.addEventListener("spectre:portal:mobile-drawer:opened", onOpen);
    document.addEventListener("spectre:portal:mobile-drawer:closed", onClose);
    return () => {
      document.removeEventListener("spectre:portal:mobile-drawer:opened", onOpen);
      document.removeEventListener("spectre:portal:mobile-drawer:closed", onClose);
    };
  }, []);

  // HR-2C Shell Refinement (2026-08-24) — Widget-anchored steps are
  // visible on Home directly; only the Profile step still lives in
  // the sidebar/drawer. On mobile, the drawer opens only when the
  // current step's target is a sidebar nav item — otherwise the
  // drawer would obscure the widget the step is trying to anchor to.
  useEffect(() => {
    if (dismissed) return;
    if (typeof window === "undefined") return;
    if (!window.matchMedia("(max-width: 767px)").matches) return;
    const currentTarget = STEPS[step]?.targetSelector ?? "";
    const isNavTarget = currentTarget.includes("portal-nav-") ||
      currentTarget.includes('"profile"');
    document.dispatchEvent(new CustomEvent(
      isNavTarget
        ? "spectre:portal:mobile-nav:open"
        : "spectre:portal:mobile-nav:close",
    ));
  }, [dismissed, step]);

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
  // While the mobile drawer is manually open, hide the popover so
  // the founder-reported "tour appears to restart" artefact can't
  // occur when the drawer closes and reveals the popover again.
  if (drawerOpen) return null;
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
