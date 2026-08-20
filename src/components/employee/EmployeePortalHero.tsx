// HR-2C §1-4 (2026-08-20) — Employee Portal photographic hero.
//
// Rendered at the top of Employee Portal Home. When the Club has
// uploaded a `ClubMedia(category="employee_portal_hero")` asset the
// image streams through the same-origin proxy route (never a signed
// URL); when absent, an elegant branded gradient fallback derived
// from Club.primaryColor takes its place.
//
// Restrained hospitality-photography sizing (§1) — h-40 mobile, h-56
// tablet, h-72 desktop; never enormous. Full-bleed within the page's
// content column; object-cover on desktop/tablet, focal-point-friendly
// on mobile. Never emits the "Spectre" wordmark
// [[feedback_member_brand_shielding]] — the overlay text uses the
// Club's own name/wordmark passed in from the layout.

import type { CSSProperties } from "react";

interface Props {
  clubId: string;
  /** Cache-buster derived from the Media row's `sha256` or
   *  `uploadedAt` timestamp so replaced hero images propagate to
   *  already-open portals within a session. */
  version: string | null;
  /** Whether a `ClubMedia(employee_portal_hero)` row exists. When
   *  false the branded fallback renders instead. */
  hasImage: boolean;
  /** Club primary color — used for the branded gradient fallback +
   *  the subtle overlay tint when an image is present. Defaults to
   *  the Spectre-approved club green if missing. */
  primaryColor?: string | null;
  /** Employee display name for the greeting overlay. */
  greetingName: string;
  /** Employee position — small subtitle under the greeting. */
  positionName?: string | null;
}

const DEFAULT_PRIMARY = "#2f5832";

function greetingFor(date = new Date()): string {
  const h = date.getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

export default function EmployeePortalHero({
  clubId,
  version,
  hasImage,
  primaryColor,
  greetingName,
  positionName,
}: Props) {
  const brand = primaryColor?.trim() || DEFAULT_PRIMARY;
  const greeting = greetingFor();

  // Fallback branded gradient — used when the Club has not uploaded
  // a hero photograph. Derives a two-stop gradient from the Club's
  // primaryColor so each tenant has a distinct look; NEVER falls back
  // to a hardcoded Coulee Ridge photo (§4).
  const fallbackStyle: CSSProperties = {
    background: `linear-gradient(135deg, ${brand} 0%, ${darken(brand, 22)} 100%)`,
  };

  return (
    <section
      className="relative overflow-hidden rounded-lg border border-stone-200"
      data-testid="portal-hero"
      data-has-image={hasImage ? "true" : "false"}
    >
      <div className="relative h-40 md:h-56 lg:h-72 w-full" style={hasImage ? undefined : fallbackStyle}>
        {hasImage && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/clubs/${clubId}/employee-portal-hero${version ? `?v=${encodeURIComponent(version)}` : ""}`}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            data-testid="portal-hero-image"
          />
        )}
        {/* Subtle gradient overlay so light imagery keeps the greeting
            legible. Uses the Club's own brand color at low opacity so
            it never introduces a foreign accent. */}
        <div
          className="absolute inset-0"
          style={{
            background: hasImage
              ? `linear-gradient(180deg, transparent 40%, rgba(15, 20, 15, 0.55) 100%)`
              : `linear-gradient(180deg, transparent 40%, rgba(0, 0, 0, 0.25) 100%)`,
          }}
        />
        {/* Greeting overlay — restrained, bottom-left. Never obscures
            top half so a photo's focal subject stays visible. */}
        <div className="absolute inset-x-0 bottom-0 px-6 md:px-8 pb-4 md:pb-6">
          <p
            className="font-serif text-2xl md:text-3xl leading-tight text-white drop-shadow-sm"
            data-testid="portal-hero-greeting"
          >
            {greeting}, {greetingName}
          </p>
          {positionName && (
            <p className="mt-1 text-sm md:text-base text-white/85 drop-shadow-sm">
              {positionName}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

// -- helpers -----------------------------------------------------------------

/** Rough hex-darkening for the fallback gradient. Not a design-system
 *  color primitive — just enough to give the gradient a subtle bottom
 *  stop so a solid Club color reads as a treatment, not a swatch. */
function darken(hex: string, percent: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const r = Math.max(0, Math.floor(((n >> 16) & 0xff) * (1 - percent / 100)));
  const g = Math.max(0, Math.floor(((n >> 8) & 0xff) * (1 - percent / 100)));
  const b = Math.max(0, Math.floor((n & 0xff) * (1 - percent / 100)));
  return "#" + ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0");
}

