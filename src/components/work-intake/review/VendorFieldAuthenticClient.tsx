// AP-ORB-4 (2026-10-18) — authentic Solving-orb Vendor cell.
//
// Replaces the AP-ORB-1 / AP-ORB-2 custom orb speed-control +
// text-rise choreography with the ORIGINAL unmodified
// `thinking-orbs` 0.3.2 `<ThinkingOrb />` at its library-native
// 64 px size — the AP-ORB-3 fidelity lab is the authoritative
// visual reference.
//
// Behaviour on replay:
//   1. Hide the vendor text.
//   2. Mount a React portal to document.body containing a
//      <ThinkingOrb state="solving" size={64} speed={1}
//                    paused={false} theme="light" />
//      inside a position:fixed wrapper anchored to the Vendor
//      cell's center via getBoundingClientRect().
//   3. Let the orb run at its own internal animation clock for
//      ~2 seconds.
//   4. Unmount the portal.
//   5. Restore the vendor text verbatim.
//
// No deceleration, no speed ramp, no text slide, no fade in/out,
// no synchronized resolution.  Zero wrappers that could scale,
// filter, transform, blend, or clip the canvas.  Replay is gated
// by `?orb=1` (staging-only) — no auto-play; no backend calls,
// no mutation, no OCR, no vendor matching, no accounting write.
//
// prefers-reduced-motion: the replay is a no-op — the vendor
// text stays visible, the portal never mounts, the trigger
// resolves immediately so the button can be clicked again.

"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "next/navigation";
import { ThinkingOrb } from "thinking-orbs";

/** How long the authentic orb runs on each replay (ms). */
export const AP_ORB_4_RUN_MS = 2_000;

interface Props {
  vendor: string;
}

export default function VendorFieldAuthenticClient({ vendor }: Props) {
  const searchParams = useSearchParams();
  const replayEnabled = searchParams?.get("orb") === "1";
  const [playing, setPlaying] = useState(false);
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchorRefCb = useCallback((el: HTMLSpanElement | null) => {
    setAnchor(el);
  }, []);

  // Track reduced-motion once on mount.
  const reducedMotionRef = useRef(false);
  useEffect(() => {
    const mql =
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    reducedMotionRef.current = !!mql?.matches;
  }, []);

  const trigger = useCallback(() => {
    if (reducedMotionRef.current) return;
    if (timerRef.current != null) clearTimeout(timerRef.current);
    setPlaying(true);
    timerRef.current = setTimeout(() => {
      setPlaying(false);
      timerRef.current = null;
    }, AP_ORB_4_RUN_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
    };
  }, []);

  // When playing, hide the vendor text via `visibility: hidden`
  // (not display:none) so the cell retains its original width +
  // bounding box — no layout shift.
  const textStyle: React.CSSProperties = playing
    ? { visibility: "hidden" }
    : { visibility: "visible" };

  return (
    <>
      <span
        ref={anchorRefCb}
        className="ap-orb-authentic-cell"
        data-testid="ap-orb-authentic-cell"
        data-ap-orb-authentic-playing={playing ? "true" : "false"}
      >
        <span
          className="ap-orb-authentic-text"
          style={textStyle}
          data-testid="ap-orb-authentic-text"
        >
          {vendor}
        </span>
        {playing ? (
          <AuthenticOrbOverlay anchor={anchor} />
        ) : null}
      </span>
      {replayEnabled ? (
        <button
          type="button"
          className="ap-orb-vendor-replay"
          onClick={trigger}
          data-testid="ap-orb-authentic-replay"
          aria-label="Replay authentic Solving orb"
          disabled={playing}
        >
          {playing ? "Playing…" : "Replay orb"}
        </button>
      ) : null}
    </>
  );
}

/** Portal overlay — fixed-positioned, anchored to the Vendor
 *  cell's center.  Renders the ORIGINAL ThinkingOrb at its
 *  documented defaults.  Zero wrappers that could scale,
 *  filter, transform, blend, or clip the canvas. */
function AuthenticOrbOverlay({ anchor }: { anchor: HTMLSpanElement | null }) {
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor) {
      setCoords(null);
      return;
    }
    const update = () => {
      const r = anchor.getBoundingClientRect();
      setCoords({
        top: r.top + r.height / 2 - 32,
        left: r.left + r.width / 2 - 32,
      });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [anchor]);

  if (typeof window === "undefined" || !coords) return null;
  return createPortal(
    <div
      className="ap-orb-authentic-overlay"
      style={{
        position: "fixed",
        top: coords.top,
        left: coords.left,
        width: 64,
        height: 64,
        pointerEvents: "none",
        zIndex: 50,
      }}
      aria-hidden="true"
      data-testid="ap-orb-authentic-overlay"
    >
      <ThinkingOrb
        state="solving"
        size={64}
        speed={1}
        paused={false}
        theme="light"
      />
    </div>,
    document.body,
  );
}
