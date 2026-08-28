// HR-2C Employee Portal desktop welcome banner (2026-08-27 refinement).
//
// Refinements applied here:
//   • Quick Links now render inline on the second (supporting-copy)
//     row instead of a separate right-rail card. Existing tenant-
//     admin data source reused verbatim.
//   • Banner outer geometry preserved: same padding, radius, min
//     visual height. Verified via before/after Playwright at
//     1366×768, 1440×900, 1536×864, 1920×1080 — Δ width/height ≈ 0.
//   • Overflow behaviour: display up to N inline links and, when
//     more exist, show a compact "+N more" trailing hint. Silent
//     drop-through is forbidden.
//   • No hardcoded link names — every link comes from the
//     `QuickLinkItem` rows the tenant admin configured.
//
// Preserved: megaphone glyph, gold vertical divider on the left,
// serif headline, sans supporting copy, trailing chevron.

import type { QuickLinkItem } from "./DesktopQuickLinksCard";

interface Props {
  clubName: string;
  href?: string | null;
  /** Tenant-configured Quick Links. Same rows that used to
   *  populate `DesktopQuickLinksCard`. */
  quickLinks?: QuickLinkItem[];
}

const INLINE_QUICK_LINK_LIMIT = 3;

export default function DesktopWelcomeBanner({ clubName, href, quickLinks = [] }: Props) {
  const inlineLinks = quickLinks.slice(0, INLINE_QUICK_LINK_LIMIT);
  const overflowCount = Math.max(0, quickLinks.length - inlineLinks.length);

  const inner = (
    <div
      className="hidden md:flex items-stretch gap-5 rounded-2xl bg-club-green-800 text-white px-6 py-4 [@media(max-height:900px)]:py-3 shadow-[0_1px_2px_rgba(15,20,15,0.06)]"
      data-testid="portal-desktop-welcome-banner"
    >
      <div className="flex items-center justify-center h-12 w-12 shrink-0 text-white/95" aria-hidden="true">
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
        {/* Supporting-copy row with inline Quick Links (right-aligned
           via `justify-between`). When zero links are configured the
           `<nav>` is not rendered and the row collapses to just the
           supporting copy — preserving the accepted no-links look. */}
        <div className="mt-1 flex items-baseline justify-between gap-4 flex-wrap">
          <p className="text-[13px] text-white/80 leading-snug break-words min-w-0">
            Access your schedule, pay information and more.
          </p>
          {inlineLinks.length > 0 && (
            <nav
              className="flex items-baseline gap-2 text-[13px] text-white/90 flex-wrap justify-end shrink-0"
              data-testid="portal-desktop-welcome-quick-links"
              aria-label="Quick Links"
            >
              {inlineLinks.map((link, i) => (
                <span key={link.id} className="flex items-baseline gap-2">
                  <a
                    href={link.href}
                    target={link.external ? "_blank" : undefined}
                    rel={link.external ? "noopener noreferrer" : undefined}
                    className="inline-flex items-baseline gap-1 hover:text-white underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-club-gold rounded-sm"
                    data-testid={`portal-desktop-welcome-quick-link-${link.id}`}
                  >
                    <span>{link.label}</span>
                    {link.external && (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="opacity-80">
                        <path d="M14 3h7v7" />
                        <path d="M10 14 21 3" />
                        <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
                      </svg>
                    )}
                  </a>
                  {i < inlineLinks.length - 1 && (
                    <span aria-hidden="true" className="text-white/40">·</span>
                  )}
                </span>
              ))}
              {overflowCount > 0 && (
                <>
                  <span aria-hidden="true" className="text-white/40">·</span>
                  <a
                    href="/employee/quick-links"
                    className="text-white/85 hover:text-white underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-club-gold rounded-sm"
                    data-testid="portal-desktop-welcome-quick-links-overflow"
                    aria-label={`See ${overflowCount} additional Quick Links`}
                  >
                    +{overflowCount} more
                  </a>
                </>
              )}
            </nav>
          )}
        </div>
      </div>
      <div className="flex items-center pl-2 text-white/80 shrink-0" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
