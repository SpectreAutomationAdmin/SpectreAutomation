// HR mobile-hotfix (2026-08-27) — Accepted mobile reference Quick
// Links panel. Cream card, green link icon, gold vertical divider,
// serif heading, inline link labels separated by gold pipes, right
// chevron. Any destination without a real route renders as a
// non-navigational label — the reference never invented URLs.

interface LinkOpt {
  label: string;
  href: string | null;
}

interface Props {
  clubWebsiteHref?: string | null;
  hrPoliciesHref?: string | null;
  contactHrHref?: string | null;
}

export default function MobileQuickLinks({
  clubWebsiteHref = null,
  hrPoliciesHref = null,
  contactHrHref = null,
}: Props) {
  const items: LinkOpt[] = [
    { label: "Club Website", href: clubWebsiteHref },
    { label: "HR Policies", href: hrPoliciesHref },
    { label: "Contact HR", href: contactHrHref },
  ];
  return (
    <section
      className="md:hidden rounded-xl bg-club-cream border border-stone-200/60 px-4 py-3.5"
      data-testid="portal-mobile-quick-links"
    >
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center h-8 w-8 shrink-0 text-club-green-700" aria-hidden="true">
          {/* Link icon */}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 14a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
            <path d="M14 10a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
          </svg>
        </div>
        <div aria-hidden="true" className="h-8 w-px bg-club-gold/60" />
        <div className="min-w-0 flex-1">
          <p className="font-serif text-[15px] leading-tight text-club-ink">Quick Links</p>
          <p className="text-[11px] text-stone-500 leading-snug truncate mt-0.5">
            {items.map((it, i) => (
              <span key={it.label}>
                {it.href ? (
                  <a href={it.href} className="hover:text-club-green-700 underline-offset-2 hover:underline">
                    {it.label}
                  </a>
                ) : (
                  <span className="text-stone-500">{it.label}</span>
                )}
                {i < items.length - 1 && <span aria-hidden="true" className="mx-1.5 text-club-gold/60">|</span>}
              </span>
            ))}
          </p>
        </div>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-stone-400 shrink-0">
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </div>
    </section>
  );
}
