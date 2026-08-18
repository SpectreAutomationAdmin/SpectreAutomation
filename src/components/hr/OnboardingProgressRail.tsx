// HR-2B.2 (2026-08-18) — Employee-facing onboarding progress rail.
//
// Deliberately restrained — no numbered chips, no traffic lights, no
// verdict badges. A vertical list of stages with a subtle done-indicator.
// Client-agnostic: renders identically on mobile (stacked above the
// content) and desktop (sticky left column).

export interface OnboardingStage {
  key: string;
  label: string;
  done: boolean;
  current: boolean;
  /** True when this stage is intentionally shown as a future/unbuilt
   *  section. Rendered dimmer + non-interactive. */
  future?: boolean;
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
          return (
            <li
              key={s.key}
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
