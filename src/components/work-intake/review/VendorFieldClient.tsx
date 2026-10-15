// AP-ORB-1 (2026-10-14) — client wrapper for the Vendor cell.
//
// Server-side the review page passes the real persisted vendor
// string to this component.  The component normally renders the
// SAME DOM the pre-AP-ORB-1 cell did — a plain inline span with
// the vendor name.
//
// When the URL carries `?orb=1`, the component additionally renders
// a tiny "Replay" button next to the value and allows the founder
// to trigger the orb-reveal choreography on demand.  The button is
// gated purely by the URL — no env var, no build-time flag; the
// query string can be removed and the Vendor cell renders exactly
// as production without touching the component tree.
//
// Zero auto-replay.  Zero backend calls.  Zero mutation surface.
// Reduced-motion short-circuits every trigger to an instant render
// via the inner VendorFieldOrbReveal hook.

"use client";

import { useSearchParams } from "next/navigation";
import type { OrbSize } from "thinking-orbs";
import VendorFieldOrbReveal, {
  VendorFieldOrbStatic,
  useVendorOrbReplay,
} from "./VendorFieldOrbReveal";

interface Props {
  vendor: string;
  /** Orb pixel size.  Default 20 (AP-ORB-1 production).  The real
   *  AP Review page NEVER passes this — it keeps the default so
   *  production stays byte-identical.  Only the staging demo
   *  surface sets 64 (AP-ORB-2 experiment). */
  size?: OrbSize;
}

export default function VendorFieldClient({ vendor, size = 20 }: Props) {
  const searchParams = useSearchParams();
  const replayEnabled = searchParams?.get("orb") === "1";
  const { playing, trigger, complete } = useVendorOrbReplay();

  return (
    <>
      {playing ? (
        <VendorFieldOrbReveal
          vendor={vendor}
          playing={true}
          onComplete={complete}
          size={size}
        />
      ) : (
        <VendorFieldOrbStatic vendor={vendor} />
      )}
      {replayEnabled ? (
        <button
          type="button"
          className="ap-orb-vendor-replay"
          onClick={trigger}
          data-testid="ap-orb-vendor-replay"
          aria-label="Replay vendor extraction animation"
          disabled={playing}
        >
          {playing ? "Playing…" : "Replay orb"}
        </button>
      ) : null}
    </>
  );
}
