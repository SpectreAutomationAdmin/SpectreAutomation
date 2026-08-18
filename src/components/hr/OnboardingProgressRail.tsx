// HR-2B.2 (2026-08-18) — Employee-facing onboarding progress rail.
//
// Deliberately restrained — no numbered chips, no traffic lights, no
// verdict badges. A vertical list of stages with a subtle done-indicator.
// Client-agnostic: renders identically on mobile (stacked above the
// content) and desktop (sticky left column).
//
// HR-2B.3 (2026-08-19) — extended with optional per-stage `subStages`.
// A sub-stage list renders indented beneath its parent stage ONLY when
// the parent is the current stage. Same dot markers, slightly smaller
// font. No colors beyond the existing emerald/stone palette.

export interface OnboardingSubStage {
  key: string;
  label: string;
  done: boolean;
}

export interface OnboardingStage {
  key: string;
  label: string;
  done: boolean;
  current: boolean;
  /** True when this stage is intentionally shown as a future/unbuilt
   *  section. Rendered dimmer + non-interactive. */
  future?: boolean;
  /** Optional sub-stages. Rendered beneath the parent, indented, only
   *  when the parent stage is `current`. */
  subStages?: OnboardingSubStage[];
}

export function OnboardingProgressRail({ stages }: { stages: OnboardingStage[] }) {
  return (
    <nav aria-label="Onboarding progress" className="text-sm">
      <ol className="space-y-2.5">
        {stages.map((s) => {
          const stateClasses = s.future
            ? "text-stone-400"
            : s.done
              ? "text-stone-900"
              : s.current
                ? "text-stone-900 font-medium"
                : "text-stone-500";
          const showSubStages = s.current && s.subStages && s.subStages.length > 0;
          return (
            <li key={s.key}>
              <div
                className={`flex items-center gap-3 ${stateClasses}`}
                aria-current={s.current ? "step" : undefined}
              >
                <span
                  aria-hidden="true"
                  className={`inline-block h-2 w-2 rounded-full flex-none ${
                    s.done
                      ? "bg-emerald-700"
                      : s.current
                        ? "bg-stone-900"
                        : s.future
                          ? "bg-stone-200"
                          : "bg-stone-300"
                  }`}
                />
                <span>{s.label}</span>
                {s.done && (
                  <span className="sr-only">completed</span>
                )}
              </div>
              {showSubStages && (
                <ol className="mt-2 ml-5 space-y-1.5 border-l border-stone-200 pl-3">
                  {s.subStages!.map((sub) => (
                    <li
                      key={sub.key}
                      className={`flex items-center gap-2.5 text-[13px] ${
                        sub.done ? "text-stone-800" : "text-stone-500"
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`inline-block h-1.5 w-1.5 rounded-full flex-none ${
                          sub.done ? "bg-emerald-700" : "bg-stone-300"
                        }`}
                      />
                      <span>{sub.label}</span>
                      {sub.done && <span className="sr-only">completed</span>}
                    </li>
                  ))}
                </ol>
              )}
            </li>
          );
        })}
      </ol>
      <p className="mt-6 text-[11px] text-stone-400">
        Save and return anytime.
      </p>
    </nav>
  );
}
