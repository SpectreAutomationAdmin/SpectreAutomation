// AP-ORB-3 (2026-10-15) — Orb Fidelity Lab (client wrapper).
//
// Renders two instances of the official `ThinkingOrb` component
// from the `thinking-orbs` npm package, side by side, at the
// library's native 64 px size and native internal animation
// clock.  No wrappers that could scale, filter, transform,
// blend, or clip.  No portals.  No choreography.  No reveal.
// No speed manipulation.  No text motion.
//
// The sole purpose is to prove Spectre can render the original
// component faithfully — nothing else.
//
// Per directive §3, both official theme variants are shown:
//   • Light tuning   → theme="light"  (dark ink on light ground)
//   • Dark  tuning   → theme="dark"   (light ink on dark ground)
//
// NOTE: `thinking-orbs@0.3.2` exposes the theme choice via the
//        `theme` prop (not `dark`), with values
//        `"auto" | "light" | "dark"`.  The directive's example
//        `<ThinkingOrb ... dark={false} />` is from an earlier
//        API; the current authoritative source uses `theme`.
//        Reported in writing in the founder acceptance doc.
//
// `size={64}` is the library's documented default; we pass it
// explicitly for self-documentation.  `speed={1}` is also the
// documented default.  `paused={false}` is the documented
// default.  We pass the exact props the directive asked for.

"use client";

import { ThinkingOrb } from "thinking-orbs";

export default function OrbFidelityLabClient() {
  return (
    <div className="orb-fidelity-lab" data-testid="orb-fidelity-lab">
      {/* Light tuning — the stock light-background orb. */}
      <section
        className="orb-fidelity-tile orb-fidelity-tile--light"
        aria-label="Light tuning"
        data-testid="orb-fidelity-tile-light"
        data-theme-tuning="light"
      >
        <div className="orb-fidelity-tile-body">
          <div className="orb-fidelity-tile-stage" data-testid="orb-fidelity-stage-light">
            <ThinkingOrb
              state="solving"
              size={64}
              theme="light"
              speed={1}
              paused={false}
            />
          </div>
        </div>
        <div className="orb-fidelity-tile-meta">
          <code>&lt;ThinkingOrb state="solving" size=&#123;64&#125; theme="light" /&gt;</code>
        </div>
      </section>

      {/* Dark tuning — the stock dark-background orb. */}
      <section
        className="orb-fidelity-tile orb-fidelity-tile--dark"
        aria-label="Dark tuning"
        data-testid="orb-fidelity-tile-dark"
        data-theme-tuning="dark"
      >
        <div className="orb-fidelity-tile-body">
          <div className="orb-fidelity-tile-stage" data-testid="orb-fidelity-stage-dark">
            <ThinkingOrb
              state="solving"
              size={64}
              theme="dark"
              speed={1}
              paused={false}
            />
          </div>
        </div>
        <div className="orb-fidelity-tile-meta">
          <code>&lt;ThinkingOrb state="solving" size=&#123;64&#125; theme="dark" /&gt;</code>
        </div>
      </section>
    </div>
  );
}
