// HR mobile-hotfix continuation (2026-08-28) — desktop 3×2 widget
// grid. Structure per accepted reference:
//
//   Scheduling      Paystubs             Time Off
//   Forms           Safety & Training    Clock In / Out
//
// Card composition mirrors the approved mobile card language:
//   [ icon ] · [ brass divider ] · [ serif title + description ] · [ chevron ]
//
// Non-navigational widgets stay visually identical to the others
// but render as aria-disabled + tabIndex=-1 so the affordance is
// honest.

import Link from "next/link";
import type { ReactNode } from "react";

export interface DesktopWidget {
  key: string;
  title: string;
  description: string;
  href: string | null;
  icon: ReactNode;
  tourTarget?: string;
}

export default function DesktopWidgetGrid({ widgets }: { widgets: DesktopWidget[] }) {
  return (
    <section
      className="hidden md:block"
      data-testid="portal-desktop-widgets"
      aria-label="Employee Portal shortcuts"
    >
      <ul
        // Final fidelity pass (2026-08-26) — 3×2 grid, uniform gap.
        // `gridAutoRows` is intentionally NOT `1fr`; per the founder
        // brief the card height must derive from the accepted
        // reference component dimension, NOT be squeezed to fit the
        // browser's remaining vertical space. Each card uses a fixed
        // `min-h-[160px]` so it holds the accepted proportion whether
        // the viewport is 768 px or 1080 px tall.
        className="grid grid-cols-3 gap-5"
        style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}
        data-testid="portal-desktop-widgets-grid"
      >
        {widgets.map((w) => (
          <li key={w.key} className="min-w-0">
            <Card w={w} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Card({ w }: { w: DesktopWidget }) {
  const available = w.href !== null;
  const body = (
    <div className="flex items-stretch h-full" data-widget-available={available ? "true" : "false"}>
      <div className="flex items-center justify-center pl-6 pr-5 text-club-green-700 [&_svg]:h-9 [&_svg]:w-9 shrink-0" aria-hidden="true">
        {w.icon}
      </div>
      <div aria-hidden="true" className="my-5 w-px bg-club-gold/65 shrink-0" />
      <div className="flex-1 min-w-0 px-6 py-7">
        <div className="font-serif text-[21px] leading-tight text-club-ink break-words">{w.title}</div>
        <div className="text-[14px] text-stone-500 leading-snug mt-2 break-words">{w.description}</div>
      </div>
      <div className="flex items-center pr-6 text-stone-400 shrink-0" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </div>
    </div>
  );
  const cls =
    // Final fidelity pass — fixed 160-px card height so the six cards
    // uniformly read as substantial self-service destinations,
    // independent of viewport height. Subtle warm border + restrained
    // shadow retained from the accepted reference.
    "block min-h-[160px] rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgba(15,20,15,0.04)] " +
    (available
      ? "hover:border-stone-300 hover:shadow-[0_3px_8px_rgba(15,20,15,0.07)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-club-green-700"
      : "cursor-default");
  if (available && w.href) {
    return (
      <Link href={w.href} className={cls} data-testid={`portal-desktop-widget-${w.key}`} data-tour-target={w.tourTarget} aria-label={w.title}>
        {body}
      </Link>
    );
  }
  return (
    <div className={cls} data-testid={`portal-desktop-widget-${w.key}`} data-tour-target={w.tourTarget} role="link" aria-disabled="true" tabIndex={-1}>
      {body}
    </div>
  );
}
