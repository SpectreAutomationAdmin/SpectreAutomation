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
    // Fidelity pass (2026-08-26) — panel is scaled to feel like a
    // proper dashboard module: larger outer padding, larger icon +
    // heading, and a min-height so the panel keeps its accepted
    // footprint even in the empty state (prevents Quick Links from
    // floating upward when there are no announcements to render).
    <section
      className="rounded-2xl bg-club-cream border border-stone-200/60 p-6 min-h-[240px] flex flex-col"
      data-testid="portal-desktop-announcements"
      aria-label="Announcements"
    >
      <header className="flex items-center gap-3 pb-4">
        <span className="text-club-green-700" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 10v4a1 1 0 0 0 1 1h3l7 4V5L8 9H5a1 1 0 0 0-1 1z" />
            <path d="M17 7.5a4.5 4.5 0 0 1 0 9" />
          </svg>
        </span>
        <h2 className="font-serif text-[19px] text-club-ink">Announcements</h2>
      </header>
      {items.length === 0 ? (
        <div className="flex-1 flex items-center" data-testid="portal-desktop-announcements-empty">
          <p className="text-[13px] text-stone-500 leading-relaxed">
            No announcements right now. When your Club posts new updates
            they&rsquo;ll appear here.
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
