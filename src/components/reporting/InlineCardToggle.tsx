"use client";

// MBR-VIS-5A (2026-10-11) — Inline card/component visibility toggle.
//
// Icon-only (no VISIBLE/HIDDEN text, no chip, no border).  Rendered
// immediately after a component title, inline:
//
//   Operating Stewardship — KPI Scorecard [eye]
//
// Used for every independently controllable sub-card (Operating
// Stewardship, Capital Stewardship, Department Net Performance,
// etc.) and any other component with its own title.

import { VisibilityToggle } from "./VisibilityToggle";
import { useVisibilityState } from "./VisibilityState";

export type InlineCardToggleProps = {
  componentKey: string;
  cardLabel: string;
  /** Optional tint for the eye icon — "cream" for dark card headers. */
  tone?: "default" | "cream";
};

export function InlineCardToggle({
  componentKey,
  cardLabel,
  tone = "default",
}: InlineCardToggleProps) {
  // Self-detects editing + period from the VisibilityState context —
  // zero-prop integration.  Returns null outside a Provider.
  const ctx = useVisibilityState();
  if (!ctx || !ctx.period) return null;
  const explicitHidden = ctx.explicitHidden(componentKey);
  return (
    <span
      data-testid={`inline-card-toggle-${componentKey}`}
      data-component-key={componentKey}
      className={
        "ml-2 inline-flex items-center align-middle " +
        // MBR-VIS-5B — "cream" tone renders WHITE for the dark-green
        // card headers (Operating / Capital Stewardship + sub-cards).
        // The underlying VisibilityToggle inherits via `text-current`,
        // so the icon stroke matches whatever colour we set here.
        (tone === "cream" ? "text-white " : "text-club-green-800/80 ")
      }
    >
      <VisibilityToggle
        reportingYear={ctx.period.reportingYear}
        reportingMonth={ctx.period.reportingMonth}
        componentKey={componentKey}
        hidden={explicitHidden}
        size="sm"
        label={`${explicitHidden ? "Show" : "Hide"} ${cardLabel} in published report`}
      />
    </span>
  );
}
