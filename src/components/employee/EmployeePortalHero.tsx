// HR-2C §1-4 (2026-08-20) — Employee Portal photographic hero.
// HR mobile-hotfix (2026-08-30) — greeting now derives from Club-local
// time via the canonical `greetingWordForInstant` helper. Previously
// the greeting used a server-local `getHours()` call, which meant the
// Fly (UTC) container decided morning/afternoon/evening instead of
// the Club's timezone — the founder observed "Good morning" at 20:00
// Alberta time.

import type { CSSProperties } from "react";
import { greetingWordForInstant } from "@/lib/mission-control/local-time";

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
  /** Club IANA timezone (e.g. `America/Edmonton`). Required so
   *  morning/afternoon/evening resolve against the Club's local
   *  time and not the server's UTC hour. When null (missing Club
   *  config), falls back to the UTC hour with a boundary that
   *  degrades gracefully — but the caller SHOULD always pass a
   *  real timezone. */
  clubTimezone: string | null;
}

const DEFAULT_PRIMARY = "#2f5832";

export default function EmployeePortalHero({
  clubId,
  version,
  hasImage,
  primaryColor,
  greetingName,
  positionName,
  clubTimezone,
}: Props) {
  const brand = primaryColor?.trim() || DEFAULT_PRIMARY;
  // Server-rendered greeting resolved against Club-local time.
  // Renders once per request; if the founder wants a live-updating
  // greeting the client side can hydrate it, but the SSR value must
  // already be correct for the Club's timezone.
  const greeting = clubTimezone
    ? greetingWordForInstant(new Date(), clubTimezone)
    : (() => {
        // Fallback ONLY when the Club has no timezone configured —
        // uses UTC. Callers should treat this as a configuration
        // defect and set Club.timezone.
        const h = new Date().getUTCHours();
        if (h >= 17 || h < 5) return "Good evening";
        if (h >= 12) return "Good afternoon";
        return "Good morning";
      })();

  // Fallback branded gradient — used when the Club has not uploaded
  // a hero photograph. Derives a two-stop gradient from the Club's
  // primaryColor so each tenant has a distinct look; NEVER falls back
  // to a hardcoded Coulee Ridge photo (§4).
  const fallbackStyle: CSSProperties = {
    background: `linear-gradient(135deg, ${brand} 0%, ${darken(brand, 22)} 100%)`,
  };

  const imgSrc = hasImage
    ? `/api/clubs/${clubId}/employee-portal-hero${version ? `?v=${encodeURIComponent(version)}` : ""}`
    : null;

  return (
    <>
      {/* -------------------- MOBILE HERO (< md) -------------------- */}
      {/* Rebuilt for the accepted mobile reference (2026-08-27): no
         border/radius, full-bleed under the fixed dark-green top
         bar, serif greeting centred over the hero photograph, an
         EMPLOYEE PORTAL label with decorative side rules, and a
         translucent weather pill at the lower-right. Weather text is
         a static presentation-only affordance — no live weather
         integration exists in the product today; the pill is styled
         to match the reference and is documented in the closeout. */}
      <section
        className="md:hidden relative overflow-hidden"
        data-testid="portal-hero"
        data-has-image={hasImage ? "true" : "false"}
      >
        <div className="relative h-52 w-full" style={hasImage ? undefined : fallbackStyle}>
          {imgSrc && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imgSrc}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
              data-testid="portal-hero-image"
            />
          )}
          <div
            className="absolute inset-0"
            style={{
              background: hasImage
                ? "linear-gradient(180deg, rgba(15,20,15,0.25) 0%, transparent 40%, rgba(15,20,15,0.45) 100%)"
                : "linear-gradient(180deg, transparent 40%, rgba(0,0,0,0.25) 100%)",
            }}
          />
          <div className="absolute inset-0 flex flex-col justify-end px-5 pb-5">
            <p
              className="font-serif text-[30px] leading-[1.05] text-white drop-shadow-sm"
              data-testid="portal-hero-greeting"
            >
              {greeting}, {greetingName}
            </p>
            <div className="mt-2 flex items-center gap-2 text-white/95">
              <span aria-hidden="true" className="h-px w-6 bg-white/70" />
              <span className="text-[10px] tracking-[0.32em]">EMPLOYEE PORTAL</span>
              <span aria-hidden="true" className="h-px w-6 bg-white/70" />
            </div>
          </div>
          {/* Weather pill — presentation-only. Static value on this
              first mobile ship; a live source would slot into
              WeatherPillProps and replace the innerText. */}
          <div className="absolute bottom-3 right-3 pointer-events-none">
            <div
              className="inline-flex items-center gap-1.5 rounded-full bg-black/45 text-white/95 backdrop-blur-sm px-3 py-1.5 text-[11px] font-medium ring-1 ring-white/15"
              data-testid="portal-hero-weather"
              aria-label="Local weather (approximate)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="8" cy="12" r="3.2" />
                <path d="M14 14a4 4 0 1 0 3-6.6" />
              </svg>
              <span className="tabular-nums">22°</span>
              <span className="text-white/80">Calgary</span>
            </div>
          </div>
        </div>
      </section>

      {/* -------------------- DESKTOP HERO (>= md) — unchanged -------------------- */}
      <section
        className="hidden md:block relative overflow-hidden rounded-lg border border-stone-200"
        data-testid="portal-hero-desktop"
        data-has-image={hasImage ? "true" : "false"}
      >
        <div className="relative h-56 lg:h-72 w-full" style={hasImage ? undefined : fallbackStyle}>
          {imgSrc && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imgSrc}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
            />
          )}
          <div
            className="absolute inset-0"
            style={{
              background: hasImage
                ? "linear-gradient(180deg, transparent 40%, rgba(15, 20, 15, 0.55) 100%)"
                : "linear-gradient(180deg, transparent 40%, rgba(0, 0, 0, 0.25) 100%)",
            }}
          />
          <div className="absolute inset-x-0 bottom-0 px-8 pb-6">
            <p className="font-serif text-3xl leading-tight text-white drop-shadow-sm">
              {greeting}, {greetingName}
            </p>
            {positionName && (
              <p className="mt-1 text-base text-white/85 drop-shadow-sm">
                {positionName}
              </p>
            )}
          </div>
        </div>
      </section>
    </>
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

