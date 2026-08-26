// HR mobile-hotfix (2026-08-27) — Accepted mobile reference welcome
// banner. Renders under the hero on <md widths only. Dark forest
// green rounded card with a megaphone icon, gold vertical divider,
// serif headline, sans supporting copy, and a right chevron.
//
// Tenant-safe: the Club name is passed in from the page, never
// hard-coded to "Coulee Ridge".

interface Props {
  clubName: string;
  href?: string | null;
}

export default function MobileWelcomeBanner({ clubName, href }: Props) {
  const inner = (
    <div
      className="flex items-center gap-3 rounded-xl bg-club-green-800 text-white px-4 py-3.5"
      data-testid="portal-mobile-welcome-banner"
    >
      <div className="flex items-center justify-center h-9 w-9 shrink-0 text-white/95" aria-hidden="true">
        {/* Megaphone / announcement */}
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 10v4a1 1 0 0 0 1 1h3l7 4V5L8 9H5a1 1 0 0 0-1 1z" />
          <path d="M17 7.5a4.5 4.5 0 0 1 0 9" />
        </svg>
      </div>
      <div aria-hidden="true" className="h-9 w-px bg-club-gold/60" />
      <div className="min-w-0 flex-1">
        <p className="font-serif text-[15px] leading-tight text-white truncate">
          Welcome to the {clubName} employee portal.
        </p>
        <p className="text-[12px] text-white/75 leading-snug truncate">
          Access your schedule, pay information and more.
        </p>
      </div>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-white/85 shrink-0">
        <polyline points="9 6 15 12 9 18" />
      </svg>
    </div>
  );

  if (href) {
    return <a href={href} className="block md:hidden">{inner}</a>;
  }
  return <div className="md:hidden">{inner}</div>;
}
