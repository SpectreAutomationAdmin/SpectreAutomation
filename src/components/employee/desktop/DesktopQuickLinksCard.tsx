// Employee Portal Quick Links (2026-08-27) — desktop right-rail
// panel. Fully data-driven from `EmployeePortalQuickLink` rows via
// `listQuickLinks(clubId, { activeOnly: true })`. When zero links
// are configured the parent hides the card entirely per §17.

export interface QuickLinkItem {
  id: string;
  label: string;
  href: string;
  external: boolean;
}

interface Props {
  items: QuickLinkItem[];
}

export default function DesktopQuickLinksCard({ items }: Props) {
  return (
    <section
      className="rounded-2xl bg-club-cream border border-stone-200/60 p-4"
      data-testid="portal-desktop-quick-links"
      aria-label="Quick Links"
    >
      <header className="flex items-center gap-2.5 pb-2.5">
        <span className="text-club-green-700" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 14a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
            <path d="M14 10a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
          </svg>
        </span>
        <h2 className="font-serif text-[16px] text-club-ink">Quick Links</h2>
      </header>
      <ul className="rounded-xl bg-white border border-stone-200/70 divide-y divide-stone-200/70">
        {items.map((it) => (
          <li key={it.id}>
            <a
              href={it.href}
              className="block hover:bg-stone-50"
              target={it.external ? "_blank" : undefined}
              rel={it.external ? "noopener noreferrer" : undefined}
              data-testid={`portal-desktop-quick-link-${it.id}`}
            >
              <div className="flex items-center px-3.5 py-2.5">
                <span className="flex-1 text-[13.5px] text-club-ink">{it.label}</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-stone-400 shrink-0 ml-3">
                  <path d="M14 3h7v7" />
                  <path d="M10 14 21 3" />
                  <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
                </svg>
              </div>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
