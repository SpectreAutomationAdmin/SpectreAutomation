// HR-2C Home refinement (2026-08-24) — Employee Home navigation widgets.
//
// Five compact dashboard launchers, restrained icon + full English
// label, no emoji, no bright colours. Real routes where they exist;
// truthful unavailable state (button becomes non-navigational,
// "Unavailable" chip) when the surface does not yet exist.
//
// Server component — pure data → JSX. Interaction is a native
// Link click or (for unavailable widgets) a disabled <div>. No
// client bundle needed.

import Link from "next/link";
import type { ReactNode } from "react";

export interface WidgetDef {
  key: string;
  label: string;
  href: string | null;   // null → unavailable (renders as disabled)
  icon: ReactNode;
  /** Optional short note shown when unavailable so the widget still
   *  reads as a legitimate destination, not a broken button. */
  unavailableNote?: string;
}

export default function HomeWidgetGrid({ widgets }: { widgets: WidgetDef[] }) {
  return (
    <section data-testid="portal-home-widgets" aria-label="Employee Portal shortcuts">
      <ul
        className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3"
        data-testid="portal-home-widgets-grid"
      >
        {widgets.map((w) => (
          <li key={w.key}>
            <WidgetTile w={w} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function WidgetTile({ w }: { w: WidgetDef }) {
  const available = w.href !== null;
  const base =
    "group h-full flex flex-col justify-between rounded-lg border border-stone-200 bg-white px-4 py-4 min-h-[112px] transition-colors";
  const interactive =
    "hover:border-stone-300 hover:bg-stone-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-club-green-700";
  const disabled = "opacity-70 cursor-not-allowed";
  const cls = available ? `${base} ${interactive}` : `${base} ${disabled}`;

  const body = (
    <>
      <div className="text-club-green-700 group-hover:text-club-green-800" aria-hidden="true">
        {w.icon}
      </div>
      <div className="mt-3">
        <div className="text-sm font-medium text-club-ink" data-testid={`portal-home-widget-label-${w.key}`}>
          {w.label}
        </div>
        {!available && (
          <div
            className="mt-1 text-[11px] uppercase tracking-[0.14em] text-stone-500"
            data-testid={`portal-home-widget-unavailable-${w.key}`}
          >
            Unavailable
          </div>
        )}
        {!available && w.unavailableNote && (
          <div className="mt-1 text-[11px] text-stone-500 leading-snug">
            {w.unavailableNote}
          </div>
        )}
      </div>
    </>
  );

  if (available && w.href) {
    return (
      <Link
        href={w.href}
        className={cls}
        data-testid={`portal-home-widget-${w.key}`}
        data-widget-available="true"
      >
        {body}
      </Link>
    );
  }
  return (
    <div
      className={cls}
      data-testid={`portal-home-widget-${w.key}`}
      data-widget-available="false"
      aria-disabled="true"
      role="group"
    >
      {body}
    </div>
  );
}
