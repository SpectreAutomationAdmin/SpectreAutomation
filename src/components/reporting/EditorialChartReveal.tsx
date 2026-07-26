"use client";

// Founder rule 2026-07-13 v15.13 → v15.13.1 — shared viewport-
// triggered chart reveal, TIMING + RESET refinement.
//
// v15.13.1 tightens three properties of the shared reveal after
// founder review of the initial roll-out:
//
//   (a) TRIGGER LATER — the animation must not start on a top-edge
//       intersection. Default enterThreshold is now 0.65 (65 % of
//       the chart substantially inside the viewport), and a
//       -64 px top rootMargin insulates the sticky report header
//       so header-covered pixels never count as "visible".
//
//   (b) DIRECTION-AGNOSTIC REPLAY WITH HYSTERESIS — the reveal is
//       no longer a one-shot per page load. When the chart drops
//       below the reset threshold (default 0.12) the state resets
//       to pending; the next crossing of the enter threshold plays
//       the animation again. Hysteresis (enter 0.65 / reset 0.12)
//       prevents flicker while the user hovers near the boundary.
//
//   (c) DURATION IS DATA — a serialisable `durationMs` config
//       threads a `--editorial-chart-reveal-duration` CSS custom
//       property onto the wrapper's root <div>. Every reveal
//       keyframe in globals.css reads that variable via var(),
//       defaulting to 1600 ms (the founder's chosen "clearly
//       observable, still restrained" editorial timing).
//
// RSC SERIALISATION CONTRACT (v15.12.1) still applies: every prop
// is a primitive (number / string / boolean / ReactNode). No
// callback children, no render props, no closure formatters —
// nothing that would trip the Server → Client boundary.
//
// REDUCED MOTION — reduced-motion users never see the observer at
// all. They mount straight into `revealed: true` and stay there for
// the lifetime of the component; the reset behaviour is
// deliberately suppressed so no chart ever collapses back to an
// invisible state for a user who explicitly asked for less motion.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

// -----------------------------------------------------------------
// Context — chart primitives may consult it, but v15.13 wired all
// animation gating through CSS (via the `data-editorial-chart-
// revealed` attribute + `chart-anim-*` classes). The context is
// retained for future primitives that need JS-level reveal state.
// -----------------------------------------------------------------

/** Public shape of the reveal context. */
export type EditorialChartRevealState = {
  /** `true` once the chart has crossed its enter threshold (or on
   *  mount if reduced-motion is preferred); `false` before that AND
   *  after a hysteresis-driven reset. */
  revealed: boolean;
};

/** Default state — `revealed: true` so that a chart rendered outside
 *  any wrapper reads as "already revealed" and stays visually
 *  identical to its pre-v15.13 render. */
const EditorialChartRevealContext =
  createContext<EditorialChartRevealState>({ revealed: true });

/** Consumer hook. Chart primitives currently rely on CSS-gated
 *  reveal via `data-editorial-chart-revealed` and this hook is
 *  intentionally NOT consumed by any primitive in the shared chart
 *  set — the CSS attribute IS the single source of truth. Retained
 *  for future opt-in when a primitive genuinely needs the JS state
 *  (e.g. label typewriters, KPI count-ups). */
export function useEditorialChartRevealState(): EditorialChartRevealState {
  return useContext(EditorialChartRevealContext);
}

// -----------------------------------------------------------------
// Config — every field is JSON-serialisable so the wrapper can be
// invoked from Server Components without tripping the RSC boundary.
// -----------------------------------------------------------------

/** Founder rule 2026-07-13 v15.13.1 — serialisable config passed to
 *  the shared reveal wrapper. Every field is a primitive; NO
 *  functions cross the Server → Client boundary. See the top-of-
 *  file rationale. */
export type EditorialChartRevealConfig = {
  /** Fraction of the chart (after `rootMargin` cropping) that must
   *  be inside the viewport before the reveal fires. Default
   *  `0.65`. Founder spec: "The user should be looking directly at
   *  most of the chart before the plotting animation starts." */
  enterThreshold?: number;
  /** Fraction below which a previously-revealed chart resets to its
   *  pending state, ready to replay on re-entry. Default `0.12`.
   *  Founder spec: hysteresis so a "tiny intersection fluctuation
   *  near the threshold" doesn't restart the animation. */
  resetThreshold?: number;
  /** Duration of each `chart-anim-*` animation family, in ms.
   *  Default `1600`. Threaded into a `--editorial-chart-reveal-
   *  duration` CSS custom property on the wrapper's root <div>
   *  so every keyframe in globals.css picks the same clock via
   *  `var(--editorial-chart-reveal-duration, 1600ms)`. */
  durationMs?: number;
  /** When `true` (default), a chart that drops below
   *  `resetThreshold` resets to pending and replays on the next
   *  enter crossing. When `false`, the reveal is a strict one-shot
   *  per page load (the pre-v15.13.1 behaviour, retained as an
   *  opt-in for surfaces that intentionally want it, e.g. a locked
   *  hero card). */
  replayOnReenter?: boolean;
  /** IntersectionObserver `rootMargin`. Default
   *  `"-64px 0px 0px 0px"` — pixels the sticky report header covers
   *  don't count as visible. Any layout with a taller / shorter
   *  sticky header should pass its own value. */
  rootMargin?: string;
};

const DEFAULT_ENTER_THRESHOLD  = 0.65;
const DEFAULT_RESET_THRESHOLD  = 0.12;
const DEFAULT_DURATION_MS      = 1600;
const DEFAULT_REPLAY_ON_REENTER = true;
const DEFAULT_ROOT_MARGIN      = "-64px 0px 0px 0px";

// -----------------------------------------------------------------
// Media query — reduced motion detection.
// -----------------------------------------------------------------

/** Detect the user's motion preference at mount. Safe under SSR
 *  and inside headless environments — returns `false` on the
 *  server (no OS to consult; the client-side effect re-reads later)
 *  and `true` if `matchMedia` is unavailable / throws. */
function readsReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia !== "function") return true;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return true;
  }
}

// -----------------------------------------------------------------
// Wrapper — the shared Client Component.
// -----------------------------------------------------------------

/** Viewport-triggered animation wrapper. Every editorial chart in
 *  the Monthly Reporting Package should be wrapped in this
 *  component so it inherits the shared "draw into place" reveal
 *  behaviour by default.
 *
 *  Props:
 *   - `children`: the chart subtree.
 *   - `config`: serialisable {@link EditorialChartRevealConfig}
 *     overrides. Every field is optional; the founder-approved
 *     defaults handle every editorial chart out of the box.
 *   - `testid`: appended to `data-testid` for surgical test
 *     targeting.
 *
 *  The wrapper installs exactly ONE IntersectionObserver per
 *  instance and disconnects it on unmount. Observers stay lightweight
 *  even across dozens of charts because each fires only on threshold
 *  crossings, not continuously.
 */
export function EditorialChartReveal({
  children,
  config,
  testid,
}: {
  children: ReactNode;
  config?: EditorialChartRevealConfig;
  testid?: string;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [revealed, setRevealed] = useState(false);

  // Resolve the config with founder-approved defaults. Memoised so
  // the observer effect only re-installs when a value actually
  // changes (config = undefined stays referentially stable).
  const {
    enterThreshold,
    resetThreshold,
    durationMs,
    replayOnReenter,
    rootMargin,
  } = useMemo(
    () => ({
      enterThreshold:
        config?.enterThreshold ?? DEFAULT_ENTER_THRESHOLD,
      resetThreshold:
        config?.resetThreshold ?? DEFAULT_RESET_THRESHOLD,
      durationMs: config?.durationMs ?? DEFAULT_DURATION_MS,
      replayOnReenter:
        config?.replayOnReenter ?? DEFAULT_REPLAY_ON_REENTER,
      rootMargin: config?.rootMargin ?? DEFAULT_ROOT_MARGIN,
    }),
    [
      config?.enterThreshold,
      config?.resetThreshold,
      config?.durationMs,
      config?.replayOnReenter,
      config?.rootMargin,
    ],
  );

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    // Reduced motion — reveal immediately, DO NOT wire an observer,
    // DO NOT allow the reset path to run. Reduced-motion users
    // never see a chart collapse back to invisible.
    if (readsReducedMotion()) {
      setRevealed(true);
      return;
    }
    // IntersectionObserver unavailable (older browsers, headless
    // environments) — reveal on mount so the chart is always
    // usable.
    if (typeof IntersectionObserver === "undefined") {
      setRevealed(true);
      return;
    }
    // Register BOTH thresholds so the observer fires on crossings of
    // either. Inside the callback we inspect the current
    // intersectionRatio and route to reveal / reset via hysteresis:
    //
    //   ratio ≥ enterThreshold                → revealed = true
    //   ratio ≤ resetThreshold  (& replay on) → revealed = false
    //   otherwise                             → no change (holding
    //                                            the current state)
    //
    // The "otherwise" branch is the hysteresis band that protects
    // against replay flicker when the user hovers around the enter
    // threshold — the founder's exact concern.
    let disposed = false;
    const thresholds = Array.from(
      new Set([
        Math.max(0, Math.min(1, resetThreshold)),
        Math.max(0, Math.min(1, enterThreshold)),
      ]),
    ).sort((a, b) => a - b);
    const observer = new IntersectionObserver(
      (entries) => {
        if (disposed) return;
        for (const entry of entries) {
          const ratio = entry.intersectionRatio;
          if (ratio >= enterThreshold) {
            // Enter — direction-agnostic. Whether the user scrolled
            // up FROM below the chart or down FROM above it, the
            // same intersection ratio crossing triggers the reveal.
            setRevealed(true);
          } else if (replayOnReenter && ratio <= resetThreshold) {
            // Reset — only fires once the chart has substantially
            // left the viewport (or is nearly gone in either
            // direction). This is where the animation is armed for
            // the next entry.
            setRevealed(false);
          }
          // Between the two thresholds: PRESERVE the current state.
          // A revealed chart stays revealed; a pending chart stays
          // pending. Prevents flicker at slow scroll speeds.
        }
      },
      { threshold: thresholds, rootMargin },
    );
    observer.observe(el);
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [enterThreshold, resetThreshold, replayOnReenter, rootMargin]);

  // Inline style — threads the reveal duration into a CSS custom
  // property inherited by every descendant. The globals.css
  // keyframes consume it via `var(--editorial-chart-reveal-
  // duration, 1600ms)`. Kept as an inline literal so no Tailwind
  // arbitrary-value class is required.
  const rootStyle: CSSProperties = useMemo(
    () => ({
      // Cast — React's CSSProperties doesn't accept custom
      // properties by default; the string index signature is
      // permitted by TypeScript once we cast to a Record shape.
      ["--editorial-chart-reveal-duration"]: `${durationMs}ms`,
    } as CSSProperties & Record<string, string>),
    [durationMs],
  );

  return (
    <EditorialChartRevealContext.Provider value={{ revealed }}>
      <div
        ref={rootRef}
        data-editorial-chart-revealed={revealed ? "true" : "false"}
        {...(testid ? { "data-testid": testid } : {})}
        className="editorial-chart-reveal-root"
        style={rootStyle}
      >
        {children}
      </div>
    </EditorialChartRevealContext.Provider>
  );
}
