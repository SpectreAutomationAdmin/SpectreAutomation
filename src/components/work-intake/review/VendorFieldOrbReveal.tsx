// AP-ORB-1 (2026-10-14) — Vendor-field intelligence motion.
//
// Replaces the plain-text rendering of the Vendor VALUE (not the
// label, not the row, not any adjacent field) with a short
// choreographed sequence:
//
//   Phase A — Thinking      (0 → 850 ms)
//     - A size=20 `solving` thinking-orb spins in the value slot.
//     - Orb speed = 1 (full baked speed).
//     - Vendor text is hidden (translateY(16px) + opacity 0, clipped
//       inside the cell).
//
//   Phase B — Deceleration  (850 → 1650 ms)
//     - Orb speed eases from 1 → 0.08 (cubic-out).
//     - Vendor text starts its upward motion at ~1,100 ms with
//       high initial velocity, easing into position (cubic-out).
//     - Text slides from +16 px to 0 px, opacity 0 → 1.
//
//   Phase C — Synchronized resolution (1650 → 2100 ms)
//     - Orb speed = 0; `paused` flips true for the final frame to
//       prevent any residual visible rotation.
//     - Orb fades out (120 ms) WITHOUT a layout shift (position:
//       absolute inside the cell).
//     - Vendor text is at rest in its final position.
//
// At t = 2100 ms the component renders exactly the same DOM as the
// pre-animation static state: a `<span>` with the vendor name.  No
// orb canvas, no additional wrappers, no residual transform.
//
// prefers-reduced-motion: the component short-circuits the whole
// sequence and renders the static vendor text immediately.  Replay
// in reduced-motion mode is a no-op.
//
// Isolation:
//   - Zero changes to adjacent fields or to the production layout.
//   - Zero backend / server-action imports.
//   - No auto-play.  The parent component owns a trigger that is
//     only visible when `?orb=1` is in the current URL (staging-
//     only review mechanism; removable without any Vendor-field
//     code change).
//   - Uses the real persisted vendor value — never hardcodes a
//     demo name.
//   - Clean cleanup on unmount or re-trigger.

"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { ThinkingOrb } from "thinking-orbs";

/** Total animation duration in milliseconds. */
export const AP_ORB_DURATION_MS = 2_100;
const PHASE_A_END = 850;
const PHASE_B_END = 1_650;
const TEXT_RISE_START = 1_100;

/** Linear interpolation. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
/** Cubic ease-out — fast start, slow finish; the orb's deceleration
 *  profile + the text's "high-velocity-then-rest" entrance. */
function easeOutCubic(t: number): number {
  const u = 1 - Math.min(Math.max(t, 0), 1);
  return 1 - u * u * u;
}

interface Props {
  /** Real persisted vendor name.  When null the component renders
   *  the existing "Not yet extracted" placeholder (handled by the
   *  caller — this component expects a string). */
  vendor: string;
  /** When true the component is currently in a replay cycle.  The
   *  parent is responsible for incrementing a key or flipping this
   *  bool each time the founder clicks Replay. */
  playing: boolean;
  /** Called once when the resolution phase ends.  Parent uses this
   *  to flip `playing` back to false and remove the orb canvas
   *  from the DOM. */
  onComplete: () => void;
}

export default function VendorFieldOrbReveal({ vendor, playing, onComplete }: Props) {
  // Elapsed-time state drives all downstream derived values on
  // every rAF tick.  Capped at AP_ORB_DURATION_MS.
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);

  // Respect prefers-reduced-motion.  When set, we short-circuit the
  // animation and render the vendor text immediately.  The parent
  // sees `onComplete` fire on the next tick so its playing flag
  // flips back to false.
  const prefersReducedMotion = useRef(false);
  useEffect(() => {
    const mql = typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
    prefersReducedMotion.current = !!mql?.matches;
  }, []);

  // Drive the animation only while `playing` is true.
  useEffect(() => {
    if (!playing) {
      // Full reset — the vendor-text transform returns to its
      // resting state when `elapsed === AP_ORB_DURATION_MS` AND
      // when `playing` is false (static final state).
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      startRef.current = null;
      setElapsed(AP_ORB_DURATION_MS);
      return;
    }
    if (prefersReducedMotion.current) {
      setElapsed(AP_ORB_DURATION_MS);
      queueMicrotask(() => onCompleteRef.current?.());
      return;
    }
    setElapsed(0);
    startRef.current = null;
    const tick = (now: number) => {
      if (startRef.current == null) startRef.current = now;
      const el = Math.min(AP_ORB_DURATION_MS, now - startRef.current);
      setElapsed(el);
      if (el >= AP_ORB_DURATION_MS) {
        onCompleteRef.current?.();
        rafRef.current = null;
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [playing]);

  // Derived values.
  const inThinking = playing && elapsed < PHASE_A_END;
  const inDecel = playing && elapsed >= PHASE_A_END && elapsed < PHASE_B_END;
  const inResolve = playing && elapsed >= PHASE_B_END && elapsed < AP_ORB_DURATION_MS;
  const orbVisible = inThinking || inDecel || inResolve;

  // Orb speed — 1 during thinking; eases from 1 → 0.08 during
  // deceleration; 0 during resolution.
  let orbSpeed = 1;
  if (inDecel) {
    const u = (elapsed - PHASE_A_END) / (PHASE_B_END - PHASE_A_END);
    orbSpeed = lerp(1, 0.08, easeOutCubic(u));
  } else if (inResolve) {
    orbSpeed = 0;
  }

  // Orb opacity — stays 1 while visible, fades out across the
  // first 120 ms of the resolution phase.
  let orbOpacity = 1;
  if (inResolve) {
    const u = (elapsed - PHASE_B_END) / 120;
    orbOpacity = 1 - Math.min(1, u);
  } else if (!orbVisible) {
    orbOpacity = 0;
  }

  // Vendor-text transform.  translate3d(0, Y, 0) + opacity.
  // Y starts at +16 px (below the baseline) and eases to 0 px.
  // Opacity ramps 0 → 1 on the same curve.  Starts at
  // TEXT_RISE_START inside Phase B so the text's upward motion
  // overlaps with the orb's deceleration (directive §3B).
  let textY = 16;
  let textOpacity = 0;
  if (playing && elapsed >= TEXT_RISE_START) {
    const u = (elapsed - TEXT_RISE_START) / (AP_ORB_DURATION_MS - TEXT_RISE_START);
    const eased = easeOutCubic(u);
    textY = lerp(16, 0, eased);
    textOpacity = eased;
  } else if (!playing && elapsed >= AP_ORB_DURATION_MS) {
    // Static final state — text at rest, visible.
    textY = 0;
    textOpacity = 1;
  }

  // Pause the orb engine on the exact final frame so no residual
  // rotation shows while it fades out.
  const orbPaused = inResolve;

  return (
    <span
      className="ap-orb-vendor-cell"
      data-testid="ap-orb-vendor-cell"
      data-ap-orb-phase={inThinking ? "thinking" : inDecel ? "decel" : inResolve ? "resolve" : "idle"}
    >
      {orbVisible ? (
        <span
          className="ap-orb-vendor-orb"
          style={{ opacity: orbOpacity }}
          aria-hidden="true"
          data-testid="ap-orb-vendor-orb"
        >
          <ThinkingOrb
            state="solving"
            size={20}
            speed={orbSpeed}
            paused={orbPaused}
            theme="light"
            aria-hidden="true"
          />
        </span>
      ) : null}
      <span
        className="ap-orb-vendor-text"
        style={{
          transform: `translate3d(0, ${textY.toFixed(2)}px, 0)`,
          opacity: textOpacity,
          // Visibility hint for assistive tech — the final rested
          // state marks itself as the authoritative value.
        }}
        aria-live={playing ? "polite" : undefined}
        data-testid="ap-orb-vendor-text"
      >
        {vendor}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Static-render helper — the default rendering path when the user
// has NOT clicked Replay.  Produces the SAME DOM as the post-
// animation resting state so the layout is byte-identical with and
// without this component in the tree.
// ---------------------------------------------------------------------------
export function VendorFieldOrbStatic({ vendor }: { vendor: string }) {
  return (
    <span
      className="ap-orb-vendor-cell"
      data-ap-orb-phase="idle"
      data-testid="ap-orb-vendor-cell"
    >
      <span
        className="ap-orb-vendor-text"
        style={{ transform: "translate3d(0, 0px, 0)", opacity: 1 }}
        data-testid="ap-orb-vendor-text"
      >
        {vendor}
      </span>
    </span>
  );
}

/**
 * Convenience hook for the parent component.  Centralises the
 * playing-flag state + the replay trigger + the cleanup on unmount.
 * The parent calls `trigger()` from an onClick handler.
 */
export function useVendorOrbReplay() {
  const [playing, setPlaying] = useState(false);
  // Guard against overlapping replays — if a replay is in flight
  // and the user clicks Replay again, we reset `playing` to false
  // for one tick before re-arming to force a clean rAF restart.
  const trigger = useCallback(() => {
    setPlaying(false);
    queueMicrotask(() => setPlaying(true));
  }, []);
  const complete = useCallback(() => setPlaying(false), []);
  return { playing, trigger, complete };
}
