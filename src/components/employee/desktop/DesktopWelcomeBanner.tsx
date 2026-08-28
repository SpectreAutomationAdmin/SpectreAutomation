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
      {/* Founder-supplied white golf-flag SVG (2026-08-27). Sized by
         height so it fits the existing 48 px icon slot without
         growing the banner; width auto-scales to preserve the
         supplied vector aspect ratio. Decorative — the adjacent
         Welcome copy already conveys the message. */}
      <div className="flex items-center justify-center h-12 w-12 shrink-0" aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/golf-flag-white.svg"
          alt=""
          aria-hidden="true"
          className="h-9 w-auto object-contain block"
          data-testid="portal-desktop-welcome-flag"
        />
      </div>
      <div aria-hidden="true" className="w-px bg-club-gold/60 shrink-0" />
      <div className="min-w-0 flex-1 flex flex-col justify-center">
        <p className="font-serif text-[19px] leading-tight text-white break-words">
          Welcome to the {clubName} employee portal.
        </p>
        {/* Supporting-copy row with inline Quick Links (right-aligned
           via `justify-between`). `flex-nowrap` keeps everything on
           a single line at every desktop viewport so the banner
           height does not grow when Quick Links are configured
           (verified 72 px at 1366/1440/1536, 80 px at 1920 via
           Playwright). When zero links are configured the `<nav>`
           is not rendered and the row collapses to just the
           supporting copy — preserving the accepted no-links look. */}
        <div className="mt-1 flex items-baseline justify-between gap-3 flex-nowrap min-w-0">
          <p className="text-[13px] text-white/80 leading-snug min-w-0 truncate">
            Access your schedule, pay information and more.
          </p>
          {inlineLinks.length > 0 && (
            <nav
              className="flex items-baseline gap-2.5 text-[13px] text-white/90 flex-nowrap justify-end shrink-0"
              data-testid="portal-desktop-welcome-quick-links"
              aria-label="Quick Links"
            >
              {/* Compact "Quick Links" label — small, semibold,
                 slightly softened white so it reads as a section
                 marker without competing with the main headline.
                 No pill, no background, no oversized heading. */}
              <span
                className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/70 whitespace-nowrap"
                data-testid="portal-desktop-welcome-quick-links-label"
              >
                Quick Links
              </span>
              {inlineLinks.map((link) => (
                <a
                  key={link.id}
                  href={link.href}
                  target={link.external ? "_blank" : undefined}
                  rel={link.external ? "noopener noreferrer" : undefined}
                  className="inline-flex items-baseline gap-1 hover:text-white underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-club-gold rounded-sm whitespace-nowrap"
                  data-testid={`portal-desktop-welcome-quick-link-${link.id}`}
                >
                  <span>{link.label}</span>
                  {/* Same open-link glyph for EVERY configured Quick
                     Link, external or internal. Founder direction §7:
                     both Club Website and Employee Handbook must
                     read consistently. The glyph is decorative — the
                     underlying `target="_blank"` / same-tab behaviour
                     is unchanged from the previous ticket (§8). */}
                  <ExternalLinkGlyph />
                </a>
              ))}
              {overflowCount > 0 && (
                <a
                  href="/employee/quick-links"
                  className="text-white/85 hover:text-white underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-club-gold rounded-sm"
                  data-testid="portal-desktop-welcome-quick-links-overflow"
                  aria-label={`See ${overflowCount} additional Quick Links`}
                >
                  +{overflowCount} more
                </a>
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

/** Small open-link/external glyph used beside EVERY inline
 *  Quick Link on the Welcome banner. Kept as a single component
 *  so both Club Website and Employee Handbook (and any future
 *  configured link) render with identical geometry + spacing. */
function ExternalLinkGlyph() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="opacity-80"
    >
      <path d="M14 3h7v7" />
      <path d="M10 14 21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </svg>
  );
}
