// Manager-facing KPI tile. Renders a label, a large value, optional
// secondary line, optional delta vs prior period, and a coloured
// border that reflects the underlying threshold status. A small "?"
// in the top-right corner reveals a help bubble explaining what the
// KPI tracks and why a manager cares.

import type { ThresholdStatus } from "@/lib/analytics/hospitality";
import { HelpTip } from "./HelpTip";

type Props = {
  label: string;
  value: string;
  secondary?: string | null;
  status?: ThresholdStatus | null;
  delta?: { value: string; direction: "up" | "down" | "flat"; intent?: "good" | "bad" | "neutral" } | null;
  href?: string;
  // One-or-two-sentence hover explanation. Shown via a "?" affordance
  // in the corner. Omit it on KPIs whose label is self-evident.
  help?: string;
};

export function KpiCard({ label, value, secondary, status, delta, href, help }: Props) {
  const borderCls = statusBorder(status);
  const inner = (
    <div className={`card card-body min-h-[6rem] border-l-4 relative ${borderCls}`}>
      {help && (
        // Absolutely positioned so the body content keeps its natural
        // layout. Sits above the card's content with z-index so the
        // bubble can overlap neighbours without clipping.
        <span className="absolute top-2 right-2">
          <HelpTip text={help} label={`What does "${label}" mean?`} />
        </span>
      )}
      <div className={`text-[10px] uppercase tracking-wide text-stone-500 ${help ? "pr-6" : ""}`}>{label}</div>
      <div className="mt-1 font-serif text-3xl text-club-ink leading-tight tabular-nums">{value}</div>
      <div className="mt-1 flex items-center gap-2 text-xs">
        {secondary && <span className="text-stone-500">{secondary}</span>}
        {delta && <DeltaPill delta={delta} />}
      </div>
    </div>
  );
  if (href) {
    return (
      <a href={href} className="block hover:opacity-90 transition-opacity">
        {inner}
      </a>
    );
  }
  return inner;
}

function statusBorder(s: ThresholdStatus | null | undefined): string {
  if (s === "GREEN") return "border-club-green-500";
  if (s === "AMBER") return "border-amber-500";
  if (s === "RED") return "border-red-500";
  return "border-stone-300";
}

function DeltaPill({ delta }: { delta: NonNullable<Props["delta"]> }) {
  const tone =
    delta.intent === "good"
      ? "text-club-green-700 bg-club-green-50 border-club-green-200"
      : delta.intent === "bad"
      ? "text-red-700 bg-red-50 border-red-200"
      : "text-stone-600 bg-stone-50 border-stone-200";
  const arrow = delta.direction === "up" ? "▲" : delta.direction === "down" ? "▼" : "·";
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] tabular-nums ${tone}`}>
      <span aria-hidden="true">{arrow}</span>
      <span>{delta.value}</span>
    </span>
  );
}
