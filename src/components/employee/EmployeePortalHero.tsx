// HR-2C §1-4 (2026-08-20) — Employee Portal photographic hero.
// HR mobile-hotfix (2026-08-30) — greeting now derives from Club-local
// time via the canonical `greetingWordForInstant` helper. Previously
// the greeting used a server-local `getHours()` call, which meant the
// Fly (UTC) container decided morning/afternoon/evening instead of
// the Club's timezone — the founder observed "Good morning" at 20:00
// Alberta time.

import type { CSSProperties } from "react";
import { greetingWordForInstant } from "@/lib/mission-control/local-time";
import type { CurrentWeatherObservation } from "@/lib/reporting/weather";
import WeatherIcon from "./WeatherIcon";

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
  /** Current weather observation for the tenant's coordinates. The
   *  page.tsx server component resolves this through the canonical
   *  `getCurrentWeather` helper (src/lib/reporting/weather) — the
   *  same service that powers the monthly reporting package. Both
   *  the mobile and desktop hero variants render from THIS one
   *  observation, so the two surfaces always show the same live
   *  temperature/condition. When null (never expected in practice —
   *  the helper degrades to the seed provider before it returns
   *  null), the pill renders a subtle neutral fallback. */
  weather: CurrentWeatherObservation | null;
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
  weather,
}: Props) {
  // Rendered by both hero variants so a single provider truth reaches
  // both the mobile pill and the desktop pill. Falls back to a neutral
  // pill when weather is null (never expected — the shared helper
  // degrades to the seed provider before returning null).
  const weatherTemp = weather ? `${weather.temperature}°` : "—";
  const weatherLabel = weather?.locationLabel ?? "";
  const weatherCondition = weather?.condition ?? "unknown";
  const weatherIsDay = weather?.isDay ?? true;
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
        {/* HR mobile-hotfix (2026-08-28) — hero height responds to
           the available viewport height. On a 667 dvh short phone
           the hero compresses to ~150 px, giving the dashboard the
           room it needs; on a 932 dvh tall phone the hero grows to
           ~215 px, matching the accepted reference. */}
        <div
          className="relative w-full"
          style={{
            ...(hasImage ? {} : fallbackStyle),
            height: "clamp(150px, 22dvh, 215px)",
          }}
        >
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
          {/* Weather pill — consumes the canonical live observation
             the page.tsx server component resolves through
             `getCurrentWeather` (same source as the monthly reporting
             package). Icon + temperature + location label all flow
             from the shared observation; no hardcoded literals. */}
          <div className="absolute bottom-3 right-3 pointer-events-none">
            <div
              className="inline-flex items-center gap-1.5 rounded-full bg-black/45 text-white/95 backdrop-blur-sm px-3 py-1.5 text-[11px] font-medium ring-1 ring-white/15"
              data-testid="portal-hero-weather"
              aria-label={weather ? `Current weather in ${weatherLabel}: ${weatherTemp}` : "Weather unavailable"}
              data-weather-source={weather?.provenance.source ?? "unavailable"}
            >
              <WeatherIcon condition={weatherCondition} isDay={weatherIsDay} size={15} />
              <span className="tabular-nums">{weatherTemp}</span>
              {weatherLabel && <span className="text-white/80">{weatherLabel}</span>}
            </div>
          </div>
        </div>
      </section>

      {/* -------------------- DESKTOP HERO (>= md) --------------------
         HR mobile-hotfix continuation (2026-08-28) — rebuilt to the
         accepted desktop reference. Full-bleed image spanning from
         the sidebar edge to the right viewport edge, no card border/
         radius, EMPLOYEE PORTAL rule under the greeting, sun-behind-
         cloud weather pill lower-right. Position label ("Controller"
         etc.) intentionally removed per the accepted spec. */}
      <section
        // Pre-redesign hero historical restore (2026-08-26) — the
        // founder-supplied canonical screenshot shows the OLD hero
        // treatment from commit 6988006 (before the desktop shell
        // rebuild): rounded card with a subtle border, sitting
        // inside the content column with left/right/top margin
        // (NOT full-bleed), `h-72` on desktop (288 px), object-cover
        // with default centered focal point. Only the CSS applies to
        // md+; the mobile hero is untouched.
        //
        // The `mx-8 mt-6` matches the accepted dashboard's `px-8`
        // gutter so the hero left/right edges align cleanly with
        // the widget grid below.
        className="hidden md:block relative overflow-hidden rounded-lg border border-stone-200 mx-8 mt-6"
        data-testid="portal-hero-desktop"
        data-has-image={hasImage ? "true" : "false"}
      >
        {/* Reduce-height pass (2026-08-26) — the founder approved the
           current hero's photographic framing (green centred, right
           tree, bunkers). This pass ONLY shortens the container so
           the full dashboard fits within a 1536 × 864 viewport.
           `object-fit: cover` + default `object-position: 50% 50%`
           are preserved, so the horizontal composition is unchanged
           and only equal amounts of top + bottom are trimmed from
           the visible image. Height uses a viewport-relative clamp
           so 1366/1440/1536/1920 all render a proportionally
           consistent hero without swinging the aspect. */}
        <div
          className="relative w-full"
          style={{
            ...(hasImage ? {} : fallbackStyle),
            height: "clamp(170px, 21vh, 260px)",
          }}
        >
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
                ? "linear-gradient(180deg, rgba(15,20,15,0.08) 0%, transparent 40%, rgba(15,20,15,0.55) 100%)"
                : "linear-gradient(180deg, transparent 40%, rgba(0, 0, 0, 0.25) 100%)",
            }}
          />
          <div className="absolute inset-0 flex flex-col justify-end px-12 pb-8">
            {/* Density rebalance — greeting nudged 52 → 46 px so it
               sits comfortably above the compacted dashboard. */}
            <p className="font-serif text-[46px] leading-[1.02] text-white drop-shadow-sm">
              {greeting}, {greetingName}
            </p>
            <div className="mt-3 flex items-center gap-3 text-white/95">
              <span aria-hidden="true" className="h-px w-12 bg-white/75" />
              <span className="text-[12px] tracking-[0.38em]">EMPLOYEE PORTAL</span>
              <span aria-hidden="true" className="h-px w-12 bg-white/75" />
            </div>
          </div>
          <div className="absolute bottom-6 right-6 pointer-events-none">
            <div
              className="inline-flex items-center gap-2.5 rounded-full bg-black/45 text-white/95 backdrop-blur-sm px-4.5 py-2.5 text-[15px] font-medium ring-1 ring-white/15"
              data-testid="portal-hero-weather-desktop"
              aria-label={weather ? `Current weather in ${weatherLabel}: ${weatherTemp}` : "Weather unavailable"}
              data-weather-source={weather?.provenance.source ?? "unavailable"}
              style={{ paddingLeft: "18px", paddingRight: "18px" }}
            >
              <WeatherIcon condition={weatherCondition} isDay={weatherIsDay} size={22} />
              <span className="tabular-nums">{weatherTemp}</span>
              {weatherLabel && <span className="text-white/80">{weatherLabel}</span>}
            </div>
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

