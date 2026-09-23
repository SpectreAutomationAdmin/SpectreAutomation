// WEB-1A §7 — Cinematic Spectre brand hero.
//
// Cycle 1 (2026-09-22) observed that the Unsplash architecture photograph
// returned a residential bedroom rather than clubhouse subject-matter.
// Rather than gamble on unvetted photo ids, the hero now composes a
// deep, architectural SVG environment — dark oak paneling, a leaded
// window at right, dawn light entering across the composition, and a
// brass horizon rule. Every visual is a first-party primitive, so the
// composition reads consistently across viewers and environments.
//
// Photography is reserved for surfaces where subject-matter can be
// verified visually (Club Identity — a tight architectural detail).

import { Reveal } from "./Reveal";
import { Wordmark } from "./Wordmark";

function Arrow() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true" className="mkt-cta-arrow">
      <path d="M4 12h16M14 6l6 6-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  );
}

export function HeroCinematic() {
  return (
    <section className="mkt-hero-cinematic">
      {/* Cinematic SVG environment — dark oak / leaded window / dawn light. */}
      <svg
        className="mkt-hero-photo"
        viewBox="0 0 1600 900"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
      >
        <defs>
          {/* Deep slate/oak base */}
          <linearGradient id="oakField" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"  stopColor="#1D1F1B" />
            <stop offset="55%" stopColor="#1A1C18" />
            <stop offset="100%" stopColor="#0F110E" />
          </linearGradient>
          {/* Warm dawn glow entering the right */}
          <radialGradient id="dawnGlow" cx="80%" cy="30%" r="60%">
            <stop offset="0%"  stopColor="#F5D89A" stopOpacity="0.55" />
            <stop offset="45%" stopColor="#8E6D3E" stopOpacity="0.20" />
            <stop offset="100%" stopColor="#1D1F1B" stopOpacity="0" />
          </radialGradient>
          {/* Directional beam of dawn light */}
          <linearGradient id="beam" x1="1" y1="0" x2="0" y2="1">
            <stop offset="0%"  stopColor="#F7EAC7" stopOpacity="0" />
            <stop offset="55%" stopColor="#F7EAC7" stopOpacity="0.11" />
            <stop offset="100%" stopColor="#F7EAC7" stopOpacity="0" />
          </linearGradient>
          {/* Subtle floor sheen */}
          <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="#0F110E" />
            <stop offset="100%" stopColor="#000000" />
          </linearGradient>
          {/* Panelling vertical hairlines pattern (oak joinery suggestion) */}
          <pattern id="oakPanel" width="240" height="1" patternUnits="userSpaceOnUse">
            <line x1="0" y1="0" x2="0" y2="900" stroke="#33352E" strokeWidth="0.5" opacity="0.55" />
          </pattern>
          {/* Leaded window mullion grid */}
          <pattern id="mullion" width="80" height="110" patternUnits="userSpaceOnUse">
            <rect x="0" y="0" width="80" height="110" fill="none" />
            <rect x="0.5" y="0.5" width="79" height="109" fill="none" stroke="#1A1C18" strokeWidth="1" opacity="0.85" />
          </pattern>
          {/* Warm window glow */}
          <linearGradient id="window" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="#F5D89A" stopOpacity="0.55" />
            <stop offset="70%"  stopColor="#B98B4A" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#5B4A19" stopOpacity="0.10" />
          </linearGradient>
        </defs>

        {/* Deep field */}
        <rect width="1600" height="900" fill="url(#oakField)" />
        {/* Oak panelling hairlines on the left half */}
        <rect x="0" y="0" width="1100" height="900" fill="url(#oakPanel)" opacity="0.7" />

        {/* Right-side leaded window with warm inner glow */}
        <g transform="translate(1050 60)">
          <rect x="0" y="0" width="440" height="660" fill="url(#window)" />
          <rect x="0" y="0" width="440" height="660" fill="url(#mullion)" />
          {/* Frame */}
          <rect x="-4" y="-4" width="448" height="668" fill="none" stroke="#A08658" strokeOpacity="0.65" strokeWidth="1.5" />
        </g>

        {/* Dawn glow washing the room */}
        <rect width="1600" height="900" fill="url(#dawnGlow)" />
        {/* Long dawn beam cutting across the floor */}
        <polygon points="1600,150 1600,900 400,900 1400,150" fill="url(#beam)" opacity="0.85" />

        {/* Floor foreground */}
        <rect x="0" y="720" width="1600" height="180" fill="url(#floor)" />

        {/* Brass horizon rule */}
        <line x1="0" y1="720" x2="1600" y2="720" stroke="#A08658" strokeWidth="0.75" opacity="0.6" />
        <line x1="0" y1="726" x2="1600" y2="726" stroke="#A08658" strokeWidth="0.35" opacity="0.3" />

        {/* Faint plaque — engraved suggestion */}
        <g transform="translate(120 795)" opacity="0.55">
          <rect x="0" y="0" width="220" height="42" fill="#0E100D" stroke="#A08658" strokeOpacity="0.35" />
          <text x="110" y="27" textAnchor="middle" fontFamily="Source Serif 4, Georgia, serif"
                fontSize="10" letterSpacing="3.2" fill="#A08658" opacity="0.85">
            SPECTRE · AUTOMATION
          </text>
        </g>
      </svg>
      {/* Warm-slate color grade to guarantee type contrast on the left half. */}
      <div className="mkt-hero-grade" aria-hidden="true" />
      {/* Paper-grain overlay for tactility. */}
      <div className="mkt-hero-grain mkt-grain-dark" aria-hidden="true" style={{ "--mkt-grain-alpha": 0.09 } as React.CSSProperties} />
      {/* Editorial type layer. */}
      <div className="mkt-hero-copy">
        <div className="mkt-container">
          <Reveal>
            <div className="mkt-eyebrow" style={{ marginBottom: "2rem", color: "#C7B489" }}>
              <Wordmark variant="eyebrow" />
            </div>
          </Reveal>
          <Reveal delayMs={80}>
            <h1 className="mkt-display-lg" style={{ margin: 0, color: "#F4EFE3", maxWidth: "17ch" }}>
              The Operating System for <span className="mkt-italic">Private Clubs.</span>
            </h1>
          </Reveal>
          <Reveal delayMs={180}>
            <p
              className="mkt-lede"
              style={{
                marginTop: "2rem",
                color: "#D9D3C2",
                maxWidth: "34em",
              }}
            >
              Spectre quietly connects the people, information and workflows behind an exceptional
              private club — so the team can spend less time operating software and more time
              running the club.
            </p>
          </Reveal>
          <Reveal delayMs={260}>
            <div style={{ marginTop: "2.75rem", display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
              <a
                href="mailto:hello@spectreautomation.com?subject=Spectre%20Demonstration"
                className="mkt-cta mkt-cta-primary"
                style={{ background: "#EFE9DC", color: "#1A1E1A", borderColor: "#EFE9DC" }}
              >
                Request a Demonstration <Arrow />
              </a>
              <a
                href="#mission-control"
                className="mkt-cta mkt-cta-secondary"
                style={{ color: "#EFE9DC", borderColor: "rgba(239,233,220,0.35)" }}
              >
                Explore Spectre
              </a>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
