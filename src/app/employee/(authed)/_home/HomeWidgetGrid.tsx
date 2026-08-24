// HR-2C Home refinement (2026-08-24) — Employee Home navigation widgets.
//
// Icon-centric launcher tiles. Each tile is structured:
//
//   Heading (English label, top of tile)
//   ────────────────────────────────
//   [ large restrained line icon centred below ]
//
// No status copy. No explainer sentences. No implementation-state
// chip. Widgets that do not yet have a real destination render
// visually identically to the others but are non-navigational
// (aria-disabled, no href, not tabbable) so assistive technology
// does not describe them as working links.
//
// Server component — pure data → JSX. Interaction is a native Next
// <Link>; disabled widgets render as a <div role="link" aria-disabled>
// with no href and tabIndex=-1 so keyboard focus skips over them.

import Link from "next/link";
import type { ReactNode } from "react";

export interface WidgetDef {
  key: string;
  label: string;
  href: string | null; // null → visually identical tile, non-navigational
  icon: ReactNode;
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
    "group h-full flex flex-col items-center justify-between rounded-lg border border-stone-200 bg-white px-3 pt-4 pb-5 min-h-[132px] transition-colors";
  const interactive =
    "hover:border-stone-300 hover:bg-stone-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-club-green-700";
  const inert =
    // Same look — no muted opacity, no chip — but visibly non-interactive
    // on hover so the affordance is honest.
    "cursor-default";
  const cls = available ? `${base} ${interactive}` : `${base} ${inert}`;

  const body = (
    <>
      <div
        className="text-sm font-medium text-club-ink text-center"
        data-testid={`portal-home-widget-label-${w.key}`}
      >
        {w.label}
      </div>
      <div
        className="text-club-green-700 group-hover:text-club-green-800 flex items-center justify-center pt-3"
        aria-hidden="true"
      >
        {w.icon}
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
        aria-label={w.label}
      >
        {body}
      </Link>
    );
  }
  // Non-navigational: role="link" + aria-disabled so ATs announce it
  // as a link that is not currently available, and tabIndex={-1} so
  // keyboard focus skips it (§6 — must not masquerade as a working
  // link but the visual treatment stays identical).
  return (
    <div
      className={cls}
      data-testid={`portal-home-widget-${w.key}`}
      data-widget-available="false"
      role="link"
      aria-disabled="true"
      tabIndex={-1}
    >
      {body}
    </div>
  );
}
