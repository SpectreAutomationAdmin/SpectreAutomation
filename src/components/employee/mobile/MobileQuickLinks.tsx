// Employee Portal Quick Links (2026-08-27) — mobile Quick Links,
// data-driven from the same `EmployeePortalQuickLink` rows as the
// desktop card. Visual language (cream card + green link icon +
// gold divider + inline pipes + right chevron) is UNCHANGED — only
// the source is now dynamic. Parent hides the card entirely when
// zero active links are configured.

import type { QuickLinkItem } from "../desktop/DesktopQuickLinksCard";

interface Props {
  items: QuickLinkItem[];
}

export default function MobileQuickLinks({ items }: Props) {
  // Cap the inline strip at the first 4 links so the mobile card
  // never horizontally overflows on narrow phones. Overflow indicator
  // exposes the count without inventing new UI.
  const visible = items.slice(0, 4);
  const hiddenCount = items.length - visible.length;
  return (
    <section
      className="md:hidden rounded-xl bg-club-cream border border-stone-200/60 px-4 py-3.5"
      data-testid="portal-mobile-quick-links"
    >
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center h-8 w-8 shrink-0 text-club-green-700" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 14a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
            <path d="M14 10a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
          </svg>
        </div>
        <div aria-hidden="true" className="h-8 w-px bg-club-gold/60" />
        <div className="min-w-0 flex-1">
          <p className="font-serif text-[15px] leading-tight text-club-ink">Quick Links</p>
          <p className="text-[11px] text-stone-500 leading-snug truncate mt-0.5">
            {visible.map((it, i) => (
              <span key={it.id}>
                <a
                  href={it.href}
                  target={it.external ? "_blank" : undefined}
                  rel={it.external ? "noopener noreferrer" : undefined}
                  className="hover:text-club-green-700 underline-offset-2 hover:underline"
                  data-testid={`portal-mobile-quick-link-${it.id}`}
                >
                  {it.label}
                </a>
                {i < visible.length - 1 && <span aria-hidden="true" className="mx-1.5 text-club-gold/60">|</span>}
              </span>
            ))}
            {hiddenCount > 0 && (
              <span className="ml-1.5 text-stone-400">+{hiddenCount} more</span>
            )}
          </p>
        </div>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-stone-400 shrink-0">
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </div>
    </section>
  );
}
