// HR mobile-hotfix continuation (2026-08-28) — Quick Links panel
// on the desktop portal right rail. Different composition from the
// mobile Quick Links (which uses inline pipes) — the desktop
// version lists each destination on its own row with an external-
// link glyph, per the accepted reference.

interface Item {
  label: string;
  href: string | null;
}

interface Props {
  items?: Item[];
}

export default function DesktopQuickLinksCard({ items }: Props) {
  const list: Item[] = items ?? [
    { label: "Club Website", href: null },
    { label: "HR Policies", href: null },
    { label: "Contact HR", href: null },
  ];
  return (
    <section
      className="rounded-xl bg-club-cream border border-stone-200/60 p-4"
      data-testid="portal-desktop-quick-links"
      aria-label="Quick Links"
    >
      <header className="flex items-center gap-2 pb-3">
        <span className="text-club-green-700" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 14a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
            <path d="M14 10a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
          </svg>
        </span>
        <h2 className="font-serif text-[16px] text-club-ink">Quick Links</h2>
      </header>
      <ul className="rounded-lg bg-white border border-stone-200/70 divide-y divide-stone-200/70">
        {list.map((it) => {
          const inner = (
            <div className="flex items-center px-3 py-2.5">
              <span className={`flex-1 text-[13px] ${it.href ? "text-club-ink" : "text-stone-500"}`}>{it.label}</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-stone-400 shrink-0">
                <path d="M14 3h7v7" />
                <path d="M10 14 21 3" />
                <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
              </svg>
            </div>
          );
          return (
            <li key={it.label}>
              {it.href ? (
                <a href={it.href} className="block hover:bg-stone-50">{inner}</a>
              ) : (
                <div className="block cursor-default" aria-disabled="true">{inner}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
