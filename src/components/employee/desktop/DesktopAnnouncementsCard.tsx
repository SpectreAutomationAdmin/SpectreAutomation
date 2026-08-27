// HR mobile-hotfix continuation (2026-08-28) — Announcements panel
// on the desktop portal right rail. Cream card, megaphone icon,
// serif heading. Rows show date + snippet + chevron.
//
// Data: the product does not currently ship a "club announcements"
// backend, so this component renders whichever `items` the parent
// resolves. When the parent has none it renders a neutral empty
// state — NO fabricated fixture rows. Documented in the closeout.

import type { ReactNode } from "react";

export interface AnnouncementItem {
  id: string;
  dateLabel: string;
  body: ReactNode;
  href?: string | null;
}

interface Props {
  items: AnnouncementItem[];
  viewAllHref?: string | null;
}

export default function DesktopAnnouncementsCard({ items, viewAllHref = null }: Props) {
  return (
    // Density rebalance (2026-08-26) — panel trimmed for the
    // one-screen-fit target: p-6 → p-4, min-h 240 → 160. Still holds
    // a substantial footprint so Quick Links doesn't float, but no
    // longer reserves space equivalent to a two-item populated card.
    <section
      className="rounded-2xl bg-club-cream border border-stone-200/60 p-4 min-h-[160px] flex flex-col"
      data-testid="portal-desktop-announcements"
      aria-label="Announcements"
    >
      {/* Fore! Employee Announcements branding (2026-08-27). The
         retro-script Fore! logo replaces the generic megaphone +
         "Announcements" heading; the accessible name is preserved
         via the SVG's `aria-labelledby` title so screen readers
         still announce the panel purpose. */}
      <header className="pb-2.5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/fore-employee-announcements.svg"
          alt="Fore! Employee Announcements"
          className="block w-full max-w-[220px] h-auto"
          data-testid="portal-desktop-announcements-fore-logo"
        />
      </header>
      {items.length === 0 ? (
        // Density rebalance — empty state remains intentionally
        // composed (medallion + copy) but is more compact so the
        // panel doesn't consume more vertical space than a populated
        // 1–2 row card would.
        <div
          className="flex-1 flex flex-col items-center justify-center text-center px-2 py-2"
          data-testid="portal-desktop-announcements-empty"
        >
          <div
            className="flex items-center justify-center h-9 w-9 rounded-full bg-club-gold/10 border border-club-gold/30 text-club-green-700"
            aria-hidden="true"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 10v4a1 1 0 0 0 1 1h3l7 4V5L8 9H5a1 1 0 0 0-1 1z" />
              <path d="M17 7.5a4.5 4.5 0 0 1 0 9" />
            </svg>
          </div>
          <p className="text-[12.5px] text-stone-600 leading-snug mt-2 max-w-[220px]">
            No announcements right now.
          </p>
          <p className="text-[11.5px] text-stone-500 leading-snug mt-0.5 max-w-[240px]">
            When your Club posts new updates they&rsquo;ll appear here.
          </p>
        </div>
      ) : (
        <ul className="rounded-lg bg-white border border-stone-200/70 divide-y divide-stone-200/70">
          {items.map((it) => {
            const inner = (
              <div className="flex items-start gap-3 px-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] text-stone-500 mb-0.5">{it.dateLabel}</div>
                  <div className="text-[13px] text-club-ink leading-snug">{it.body}</div>
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-stone-400 shrink-0 mt-0.5">
                  <polyline points="9 6 15 12 9 18" />
                </svg>
              </div>
            );
            return (
              <li key={it.id}>
                {it.href ? <a href={it.href} className="block hover:bg-stone-50">{inner}</a> : <div>{inner}</div>}
              </li>
            );
          })}
        </ul>
      )}
      {viewAllHref && items.length > 0 && (
        <div className="pt-3 text-right">
          <a href={viewAllHref} className="text-[12px] text-club-green-700 hover:text-club-green-800 underline underline-offset-2">
            View all announcements
          </a>
        </div>
      )}
    </section>
  );
}
