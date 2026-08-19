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
//
// HR-2B.3.6 (2026-08-19) — Completed steps become navigable.
//   * A stage or sub-stage becomes clickable when the caller supplies
//     an `href`. The caller (layout) sets `href` ONLY for a step whose
//     canonical persisted state says it was completed — the rail never
//     infers "clickable" from URL history, DOM state, or localStorage.
//   * A stage with sub-stages also acts as an expand/collapse trigger.
//     Clicking a stage with `href` navigates; clicking a stage with
//     sub-stages but no href expands/collapses. When both are present,
//     the label navigates and a subtle disclosure caret toggles children.
//   * Future / incomplete stages remain visually dim + non-interactive
//     regardless of any `href` (defensive; layouts should never pass one).
//
// Preserves the existing founder-accepted visual vocabulary — no big
// chevrons, no wizard chrome, no colour additions.

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export interface OnboardingSubStage {
  key: string;
  label: string;
  done: boolean;
  /** HR-2B.3.6 — set to make this completed sub-step clickable. */
  href?: string;
}

export interface OnboardingStage {
  key: string;
  label: string;
  done: boolean;
  current: boolean;
  /** True when this stage is intentionally shown as a future/unbuilt
   *  section. Rendered dimmer + non-interactive. */
  future?: boolean;
  /** Optional sub-stages. Rendered beneath the parent, indented, when
   *  the parent stage is `current` OR the parent is expanded. */
  subStages?: OnboardingSubStage[];
  /** HR-2B.3.6 — set to make this completed stage clickable at the
   *  parent level. When both `href` and `subStages` are present, the
   *  label navigates AND the parent still exposes its expand/collapse. */
  href?: string;
}

export function OnboardingProgressRail({ stages }: { stages: OnboardingStage[] }) {
  // Track which parents are expanded. Initial state: every `current`
  // parent + every parent with a done sub-stage is expanded. This
  // preserves the pre-HR-2B.3.6 default (current stage shows its
  // children) and adds "completed parents keep their children reachable
  // once opened".
  const initiallyExpanded = new Set<string>();
  for (const s of stages) {
    if (s.current || (s.subStages && s.subStages.some((ss) => ss.done))) {
      initiallyExpanded.add(s.key);
    }
  }
  const [expanded, setExpanded] = useState<Set<string>>(initiallyExpanded);

  // Keep the current stage expanded across prop changes without
  // clobbering the operator's explicit collapse. We ADD current-stage
  // keys on prop change, but do NOT remove keys the user set.
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const s of stages) if (s.current) next.add(s.key);
      return next;
    });
  }, [stages]);

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

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
          const hasSubs = !!s.subStages && s.subStages.length > 0;
          const isExpanded = expanded.has(s.key);
          const showSubStages = hasSubs && isExpanded;
          // Parent is navigable only if the caller passed a href AND
          // the stage isn't a future placeholder.
          const parentNav = s.href && !s.future;

          // Parent label content — extracted so the same JSX renders
          // inside <Link>, <button>, or a plain <span> depending on
          // affordance.
          const parentLabel = (
            <>
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
              {s.done && <span className="sr-only">completed</span>}
            </>
          );

          return (
            <li key={s.key}>
              <div
                className={`flex items-center gap-3 ${stateClasses}`}
                aria-current={s.current ? "step" : undefined}
              >
                {parentNav ? (
                  // Navigable parent — the label is a Link.
                  <Link
                    href={s.href!}
                    data-testid={`onboarding-rail-parent-${s.key}`}
                    className="flex items-center gap-3 hover:text-emerald-800"
                  >
                    {parentLabel}
                  </Link>
                ) : hasSubs && !s.future ? (
                  // Non-navigable parent with sub-stages — clicking the
                  // label toggles the child list.
                  <button
                    type="button"
                    onClick={() => toggle(s.key)}
                    aria-expanded={isExpanded}
                    aria-controls={`onboarding-rail-subs-${s.key}`}
                    data-testid={`onboarding-rail-parent-${s.key}`}
                    className="flex items-center gap-3 hover:text-emerald-800"
                  >
                    {parentLabel}
                  </button>
                ) : (
                  <span
                    data-testid={`onboarding-rail-parent-${s.key}`}
                    className="flex items-center gap-3"
                  >
                    {parentLabel}
                  </span>
                )}
                {hasSubs && !s.future && (
                  // Disclosure caret — subtle, uses ▸/▾. Kept separate
                  // from the label so navigating and expanding are
                  // independently actionable.
                  <button
                    type="button"
                    onClick={() => toggle(s.key)}
                    aria-label={isExpanded ? `Collapse ${s.label}` : `Expand ${s.label}`}
                    aria-expanded={isExpanded}
                    aria-controls={`onboarding-rail-subs-${s.key}`}
                    data-testid={`onboarding-rail-toggle-${s.key}`}
                    className="ml-auto text-[10px] text-stone-400 hover:text-stone-700"
                  >
                    {isExpanded ? "▾" : "▸"}
                  </button>
                )}
              </div>
              {showSubStages && (
                <ol
                  id={`onboarding-rail-subs-${s.key}`}
                  data-testid={`onboarding-rail-subs-${s.key}`}
                  className="mt-2 ml-5 space-y-1.5 border-l border-stone-200 pl-3"
                >
                  {s.subStages!.map((sub) => {
                    const subNav = !!sub.href;
                    const inner = (
                      <>
                        <span
                          aria-hidden="true"
                          className={`inline-block h-1.5 w-1.5 rounded-full flex-none ${
                            sub.done ? "bg-emerald-700" : "bg-stone-300"
                          }`}
                        />
                        <span>{sub.label}</span>
                        {sub.done && <span className="sr-only">completed</span>}
                      </>
                    );
                    return (
                      <li
                        key={sub.key}
                        className={`flex items-center gap-2.5 text-[13px] ${
                          sub.done ? "text-stone-800" : "text-stone-500"
                        }`}
                      >
                        {subNav ? (
                          <Link
                            href={sub.href!}
                            data-testid={`onboarding-rail-sub-${sub.key}`}
                            className="flex items-center gap-2.5 hover:text-emerald-800"
                          >
                            {inner}
                          </Link>
                        ) : (
                          <span
                            data-testid={`onboarding-rail-sub-${sub.key}`}
                            className="flex items-center gap-2.5"
                          >
                            {inner}
                          </span>
                        )}
                      </li>
                    );
                  })}
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
