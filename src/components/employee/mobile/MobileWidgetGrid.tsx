// HR mobile-hotfix (2026-08-27) — Accepted mobile reference feature
// cards. 2-column × 3-row grid. Each card: left green icon, gold
// vertical divider, serif title + short description, right chevron.
// Cards without a real destination render visually identically but
// are aria-disabled + tabIndex=-1 so ATs describe them as unavailable
// (same honesty rule as the desktop widget grid).
//
// Wrapped in <div className="md:hidden"> at the call site — desktop
// keeps the existing icon-centric HomeWidgetGrid presentation.

import Link from "next/link";
import type { ReactNode } from "react";

export interface MobileWidget {
  key: string;
  title: string;
  description: string;
  href: string | null;
  icon: ReactNode;
  tourTarget?: string;
}

export default function MobileWidgetGrid({ widgets }: { widgets: MobileWidget[] }) {
  return (
    <section className="md:hidden" data-testid="portal-mobile-widgets">
      <ul className="grid grid-cols-2 gap-3" data-testid="portal-mobile-widgets-grid">
        {widgets.map((w) => (
          <li key={w.key}>
            <Card w={w} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Card({ w }: { w: MobileWidget }) {
  const available = w.href !== null;
  const body = (
    <div className="flex items-stretch h-full" data-widget-available={available ? "true" : "false"}>
      <div className="flex items-center justify-center px-3 text-club-green-700 [&_svg]:h-7 [&_svg]:w-7" aria-hidden="true">
        {w.icon}
      </div>
      <div aria-hidden="true" className="my-3 w-px bg-club-gold/50" />
      <div className="flex-1 min-w-0 flex flex-col justify-center px-3 py-3">
        <div className="font-serif text-[15px] leading-tight text-club-ink truncate">
          {w.title}
        </div>
        <div className="text-[11px] text-stone-500 leading-snug line-clamp-2 mt-0.5">
          {w.description}
        </div>
      </div>
      <div className="flex items-center pr-2 text-stone-400" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </div>
    </div>
  );
  const cls =
    "block rounded-xl border border-stone-200 bg-white min-h-[92px] shadow-[0_1px_2px_rgba(15,20,15,0.04)] " +
    (available
      ? "hover:border-stone-300 active:bg-stone-50/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-club-green-700"
      : "cursor-default");
  if (available && w.href) {
    return (
      <Link href={w.href} className={cls} data-testid={`portal-mobile-widget-${w.key}`} data-tour-target={w.tourTarget} aria-label={w.title}>
        {body}
      </Link>
    );
  }
  return (
    <div className={cls} data-testid={`portal-mobile-widget-${w.key}`} data-tour-target={w.tourTarget} role="link" aria-disabled="true" tabIndex={-1}>
      {body}
    </div>
  );
}
