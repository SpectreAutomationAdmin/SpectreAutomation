"use client";

// HR mobile-hotfix (2026-08-27) — real-device viewport diagnostic.
//
// Mounted from the employee (authed) layout, but ONLY renders when
// the URL carries `?viewportDebug=1`. Presents a live overlay of:
//   * screen.{width,height}
//   * window.inner{Width,Height}
//   * document.documentElement.client{Width,Height}
//   * document.documentElement.scroll{Width,Height}
//   * visualViewport.{width,height,scale,offsetLeft,offsetTop}
//   * devicePixelRatio
//   * abbreviated userAgent
//   * runtime build marker (staging release version passed as prop)
//
// The founder opens the staging portal with the query flag on a
// real iPhone and screenshots this overlay. That screenshot is the
// authoritative evidence of the real-device viewport state.
//
// Updates on window.resize, visualViewport.resize/scroll,
// orientationchange, and (defensively) requestAnimationFrame every
// 500 ms while mounted so a screenshot always shows a current
// value.

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

interface Metrics {
  screenW: number; screenH: number;
  innerW: number; innerH: number;
  clientW: number; clientH: number;
  scrollW: number; scrollH: number;
  vvW: number | null; vvH: number | null; vvScale: number | null;
  vvOffL: number | null; vvOffT: number | null;
  dpr: number;
  ua: string;
}

function readMetrics(): Metrics {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  return {
    screenW: window.screen?.width ?? 0,
    screenH: window.screen?.height ?? 0,
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    clientW: document.documentElement.clientWidth,
    clientH: document.documentElement.clientHeight,
    scrollW: document.documentElement.scrollWidth,
    scrollH: document.documentElement.scrollHeight,
    vvW: vv?.width ?? null,
    vvH: vv?.height ?? null,
    vvScale: vv?.scale ?? null,
    vvOffL: vv?.offsetLeft ?? null,
    vvOffT: vv?.offsetTop ?? null,
    dpr: window.devicePixelRatio ?? 1,
    ua: (navigator.userAgent ?? "").slice(0, 120),
  };
}

interface Props {
  /** Runtime build marker so the screenshot proves which deploy
   *  the founder was viewing. Passed from the server layout. */
  releaseMarker?: string | null;
}

export default function ViewportDebugOverlay({ releaseMarker }: Props) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const enabled = searchParams.get("viewportDebug") === "1";
  const [m, setM] = useState<Metrics | null>(null);

  useEffect(() => {
    if (!enabled) return;
    setM(readMetrics());
    const tick = () => setM(readMetrics());
    window.addEventListener("resize", tick);
    window.addEventListener("orientationchange", tick);
    window.visualViewport?.addEventListener("resize", tick);
    window.visualViewport?.addEventListener("scroll", tick);
    const interval = window.setInterval(tick, 500);
    return () => {
      window.removeEventListener("resize", tick);
      window.removeEventListener("orientationchange", tick);
      window.visualViewport?.removeEventListener("resize", tick);
      window.visualViewport?.removeEventListener("scroll", tick);
      window.clearInterval(interval);
    };
  }, [enabled]);

  if (!enabled || !m) return null;

  const scaleSuspicious = m.vvScale != null && Math.abs(m.vvScale - 1) > 0.02;
  const insetSuspicious = m.innerW !== m.clientW;

  return (
    <div
      data-testid="viewport-debug-overlay"
      style={{
        position: "fixed",
        top: "env(safe-area-inset-top, 0px)",
        left: 4,
        right: 4,
        zIndex: 2147483647,
        background: "rgba(3, 10, 3, 0.92)",
        color: "#f6f5ea",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 11,
        lineHeight: 1.35,
        padding: "8px 10px",
        borderRadius: 8,
        pointerEvents: "none",
        boxShadow: "0 2px 12px rgba(0,0,0,0.4)",
      }}
    >
      <div style={{ fontWeight: 700, letterSpacing: 0.4 }}>
        VIEWPORT DEBUG · {releaseMarker ?? "unknown"} · {pathname}
      </div>
      <div>
        screen: {m.screenW}×{m.screenH} · dpr: {m.dpr}
      </div>
      <div>
        innerW/H: {m.innerW}×{m.innerH}
      </div>
      <div>
        clientW/H: {m.clientW}×{m.clientH}
      </div>
      <div>
        scrollW/H: {m.scrollW}×{m.scrollH}
        {m.scrollW !== m.clientW && (
          <span style={{ color: "#f5c8a2" }}> · Δ={m.scrollW - m.clientW}</span>
        )}
      </div>
      <div style={{ color: scaleSuspicious ? "#ff8f6a" : "#f6f5ea" }}>
        vv: {m.vvW ?? "n/a"}×{m.vvH ?? "n/a"} · scale: {m.vvScale?.toFixed(3) ?? "n/a"} · off: {m.vvOffL ?? "n/a"},{m.vvOffT ?? "n/a"}
        {scaleSuspicious && " ← ZOOMED"}
      </div>
      {insetSuspicious && (
        <div style={{ color: "#f5c8a2" }}>
          innerW≠clientW (Δ={m.innerW - m.clientW}) — scrollbar / inset?
        </div>
      )}
      <div style={{ marginTop: 4, opacity: 0.75, wordBreak: "break-all" }}>
        {m.ua}
      </div>
    </div>
  );
}
