// HR mobile-hotfix continuation (2026-08-26) — accepted desktop
// reference welcome banner. Renders directly beneath the hero and
// above the widget grid on md+ widths only.
//
// Visual specification (accepted desktop reference):
//   [ megaphone ] │ gold divider │ Welcome to the {Club} employee portal.
//                                  Access your schedule, pay information and more.
//                                                                              [ > ]
//
//   - dark forest-green background (bg-club-green-800)
//   - rounded-2xl outer shape
//   - white/cream megaphone glyph
//   - brass/gold vertical divider (full inner height)
//   - large serif headline, sans supporting copy
//   - right-facing chevron
//   - generous but not excessive horizontal padding
//
// Tenant-safe: the Club name is passed in from the page, never
// hardcoded. Text never truncated — natural wrap on narrower
// content columns.

interface Props {
  clubName: string;
  href?: string | null;
}

export default function DesktopWelcomeBanner({ clubName, href }: Props) {
  const inner = (
    <div
      className="hidden md:flex items-stretch gap-5 rounded-2xl bg-club-green-800 text-white px-6 py-5 shadow-[0_1px_2px_rgba(15,20,15,0.06)]"
      data-testid="portal-desktop-welcome-banner"
    >
      <div className="flex items-center justify-center h-11 w-11 shrink-0 text-white/95" aria-hidden="true">
        {/* Megaphone / announcement glyph */}
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 10v4a1 1 0 0 0 1 1h3l7 4V5L8 9H5a1 1 0 0 0-1 1z" />
          <path d="M17 7.5a4.5 4.5 0 0 1 0 9" />
        </svg>
      </div>
      <div aria-hidden="true" className="w-px bg-club-gold/60 shrink-0" />
      <div className="min-w-0 flex-1 flex flex-col justify-center">
        <p className="font-serif text-[19px] leading-tight text-white break-words">
          Welcome to the {clubName} employee portal.
        </p>
        <p className="text-[13.5px] text-white/80 leading-snug mt-1 break-words">
          Access your schedule, pay information and more.
        </p>
      </div>
      <div className="flex items-center pl-2 text-white/80 shrink-0" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </div>
    </div>
  );

  if (href) {
    return (
      <a
        href={href}
        className="block focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-club-gold rounded-2xl"
      >
        {inner}
      </a>
    );
  }
  return inner;
}
