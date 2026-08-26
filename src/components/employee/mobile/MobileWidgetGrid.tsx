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
  // HR mobile-hotfix (2026-08-27) — no ellipsis on card titles or
  // descriptions. Titles wrap naturally ("Safety &" / "Training";
  // "Clock In /" / "Out"). Descriptions wrap to 2 lines max via
  // line-clamp-2 which is a soft cap — natural break is preferred.
  const body = (
    <div className="flex items-stretch h-full" data-widget-available={available ? "true" : "false"}>
      <div className="flex items-center justify-center pl-2.5 pr-2 text-club-green-700 [&_svg]:h-6 [&_svg]:w-6 shrink-0" aria-hidden="true">
        {w.icon}
      </div>
      <div aria-hidden="true" className="my-2.5 w-px bg-club-gold/50 shrink-0" />
      <div className="flex-1 min-w-0 flex flex-col justify-center pl-2.5 pr-1 py-2.5">
        <div className="font-serif text-[14px] leading-[1.15] text-club-ink break-words">
          {w.title}
        </div>
        <div className="text-[11px] text-stone-500 leading-snug mt-0.5">
          {w.description}
        </div>
      </div>
      <div className="flex items-center pr-1.5 text-stone-400 shrink-0" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </div>
    </div>
  );
  const cls =
    "block rounded-xl border border-stone-200 bg-white shadow-[0_1px_2px_rgba(15,20,15,0.04)] " +
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
