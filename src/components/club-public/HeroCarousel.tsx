"use client";

// 6-slide hero carousel modeled on the live silverspringsgolfclub.com home page.
//
// Rotation behavior:
//   - Auto-advances every 6 seconds.
//   - Pauses on hover, on focus within the carousel, and when the tab is
//     hidden (Page Visibility API).
//   - Arrows + dots + ←/→ keyboard navigation.
//   - Each slide announces itself to assistive tech via aria-live="polite".
//
// Imagery slots are CSS-rendered gradient panels because we deliberately do
// not hotlink the live site's photography. Each slide is labelled at the
// bottom-right with the asset slot name so reviewers know exactly which
// real photo replaces which gradient. See docs/silver-springs-content-gaps.md.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

type Slide = {
  key: string;
  gradient: string;
  // Bottom-right tag visible on every slide so the placeholder nature is
  // unambiguous — never pretends to be a real photo.
  assetSlot: string;
  // Optional secondary line that varies per slide. The headline + tagline
  // are constant (matching the live site, which repeats them across slides).
  flavor: string;
  cta?: { primaryHref: string; primaryLabel: string; secondaryHref?: string; secondaryLabel?: string };
};

const SLIDES: Slide[] = [
  {
    key: "course-morning",
    gradient: "bg-gradient-to-br from-club-green-900 via-club-green-700 to-club-green-400",
    assetSlot: "Course · Morning",
    flavor: "Eighteen holes. A clubhouse. A community.",
    cta: { primaryHref: "/membership", primaryLabel: "Become a Member", secondaryHref: "/golf", secondaryLabel: "See the Course" },
  },
  {
    key: "course-golden-hour",
    gradient: "bg-gradient-to-br from-amber-800 via-club-green-700 to-club-green-300",
    assetSlot: "Course · Golden hour",
    flavor: "Where the day eases into evening.",
    cta: { primaryHref: "/golf", primaryLabel: "Explore the Course", secondaryHref: "/golf/guest-information", secondaryLabel: "Guest Information" },
  },
  {
    key: "clubhouse-exterior",
    gradient: "bg-gradient-to-br from-stone-700 via-club-green-800 to-club-green-500",
    assetSlot: "Clubhouse · Exterior at dusk",
    flavor: "A second home, since 1958.",
    cta: { primaryHref: "/clubhouse", primaryLabel: "Visit the Clubhouse", secondaryHref: "/membership", secondaryLabel: "Become a Member" },
  },
  {
    key: "dining-room",
    gradient: "bg-gradient-to-br from-stone-800 via-amber-900 to-club-gold/70",
    assetSlot: "Dining · Main room",
    flavor: "A menu that follows the seasons.",
    cta: { primaryHref: "/clubhouse", primaryLabel: "Dining & Spaces" },
  },
  {
    key: "wedding-lawn",
    gradient: "bg-gradient-to-br from-club-cream via-club-sand to-club-green-300",
    assetSlot: "Events · Wedding on the lawn",
    flavor: "For the moments that matter most.",
    cta: { primaryHref: "/events", primaryLabel: "Catering & Events", secondaryHref: "/events/request", secondaryLabel: "Request an Event" },
  },
  {
    key: "trackman-bay",
    gradient: "bg-gradient-to-br from-stone-900 via-club-green-900 to-club-green-700",
    assetSlot: "The Trackman Range · Bay",
    flavor: "Real golf, all year, on the world’s best simulators.",
    cta: { primaryHref: "/golf/trackman-range", primaryLabel: "The Trackman Range" },
  },
];

const AUTO_ADVANCE_MS = 6000;

export function HeroCarousel({
  wordmark,
  foundedYear,
  region,
}: {
  wordmark: string;
  foundedYear?: number | null;
  region?: string | null;
}) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-advance with pause on hover / focus / hidden tab.
  useEffect(() => {
    if (paused) return;
    if (typeof document !== "undefined" && document.hidden) return;
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % SLIDES.length);
    }, AUTO_ADVANCE_MS);
    return () => window.clearInterval(id);
  }, [paused, index]);

  useEffect(() => {
    const onVisibility = () => setPaused(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // ← / → keyboard
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") { setIndex((i) => (i - 1 + SLIDES.length) % SLIDES.length); }
      if (e.key === "ArrowRight") { setIndex((i) => (i + 1) % SLIDES.length); }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, []);

  const goto = (next: number) => setIndex(((next % SLIDES.length) + SLIDES.length) % SLIDES.length);
  const slide = SLIDES[index];

  return (
    <section
      ref={containerRef}
      tabIndex={-1}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      aria-roledescription="carousel"
      aria-label="Welcome"
      className="relative overflow-hidden focus:outline-none"
    >
      {/* Slides */}
      <div className="relative h-[78vh] min-h-[560px] max-h-[820px]">
        {SLIDES.map((s, i) => (
          <div
            key={s.key}
            role="group"
            aria-roledescription="slide"
            aria-label={`${i + 1} of ${SLIDES.length}: ${s.assetSlot}`}
            aria-hidden={i !== index}
            className={`absolute inset-0 transition-opacity duration-700 ease-out ${i === index ? "opacity-100" : "opacity-0 pointer-events-none"}`}
          >
            <div className={`absolute inset-0 ${s.gradient}`} aria-hidden="true" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/15 to-transparent" aria-hidden="true" />
            <div className="absolute bottom-5 right-6 text-[11px] uppercase tracking-[0.3em] text-club-cream/80 bg-black/30 px-3 py-1 rounded-full backdrop-blur-sm">
              {s.assetSlot}
            </div>
          </div>
        ))}

        {/* Overlay content — headline + tagline are constant across slides
            (matching the live site); only the "flavor" line + CTAs rotate. */}
        <div className="relative h-full max-w-7xl mx-auto px-6 md:px-10 flex items-center">
          <div className="text-club-cream max-w-3xl" aria-live="polite">
            {foundedYear ? (
              <div className="text-[11px] uppercase tracking-[0.35em] text-club-gold/90">
                Est. {foundedYear}{region ? ` · ${region}` : ""}
              </div>
            ) : null}
            <h1 className="mt-4 font-serif text-4xl md:text-6xl leading-[1.05]">
              Welcome to {wordmark} Golf &amp; Country Club.
            </h1>
            <p className="mt-6 font-serif italic text-2xl md:text-3xl text-club-cream/90">
              Play golf. Enjoy life.
            </p>
            <p key={slide.key} className="mt-5 text-base md:text-lg text-club-cream/85 transition-opacity duration-500">
              {slide.flavor}
            </p>
            {slide.cta ? (
              <div className="mt-10 flex flex-wrap gap-3">
                <Link
                  href={slide.cta.primaryHref}
                  className="inline-flex items-center justify-center rounded-md bg-club-green-700 text-white px-6 py-3 text-sm font-medium tracking-wide hover:bg-club-green-800 transition-colors"
                >
                  {slide.cta.primaryLabel}
                </Link>
                {slide.cta.secondaryHref ? (
                  <Link
                    href={slide.cta.secondaryHref}
                    className="inline-flex items-center justify-center rounded-md border border-club-cream/60 text-club-cream px-6 py-3 text-sm font-medium tracking-wide hover:bg-club-cream/10"
                  >
                    {slide.cta.secondaryLabel}
                  </Link>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        {/* Prev / next arrows */}
        <button
          type="button"
          onClick={() => goto(index - 1)}
          aria-label="Previous slide"
          className="absolute left-3 md:left-6 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-black/30 hover:bg-black/50 backdrop-blur-sm text-club-cream flex items-center justify-center"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => goto(index + 1)}
          aria-label="Next slide"
          className="absolute right-3 md:right-6 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-black/30 hover:bg-black/50 backdrop-blur-sm text-club-cream flex items-center justify-center"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {/* Dots */}
        <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex gap-2">
          {SLIDES.map((s, i) => (
            <button
              key={s.key}
              type="button"
              aria-label={`Go to slide ${i + 1}: ${s.assetSlot}`}
              aria-current={i === index ? "true" : undefined}
              onClick={() => goto(i)}
              className={`h-2 rounded-full transition-all ${i === index ? "w-8 bg-club-cream" : "w-2 bg-club-cream/40 hover:bg-club-cream/60"}`}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
