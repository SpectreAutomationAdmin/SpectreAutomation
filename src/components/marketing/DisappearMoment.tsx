"use client";

// WEB-1A §9 — "Software should disappear." signature moment.
//
// A single beat that carries the philosophy on its own — deep negative
// space, deliberately generous. The type recedes and re-emerges in place.
// The subsequent Mission Control section (which lives elsewhere in the
// page) is the "product emerging from the philosophy" — this section
// stops before the product to preserve the two beats' contrast.

import { useEffect, useRef, useState } from "react";
import { Wordmark } from "./Wordmark";

export function DisappearMoment() {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect();
        const vh = window.innerHeight;
        const start = vh * 0.65;
        const end   = vh * 0.20;
        const p = Math.min(1, Math.max(0, (start - rect.top) / (start - end)));
        setProgress(p);
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  const receded = progress > 0.5;
  const emerged = progress > 0.55;

  return (
    <section
      id="disappear"
      className="mkt-surface-ink mkt-grain-dark"
      style={{ "--mkt-grain-alpha": 0.055 } as React.CSSProperties}
    >
      <div className="mkt-editorial" style={{ paddingBlock: "clamp(7rem, 14vw, 12rem)" }}>
        <div className="mkt-eyebrow" style={{ marginBottom: "3.5rem", color: "#C7B489" }}>
          <Wordmark variant="eyebrow" />
        </div>

        <div ref={anchorRef} style={{ minHeight: "48vh", position: "relative" }}>
          <h2 className="mkt-display-lg" style={{ margin: 0, color: "#EFE9DC" }}>
            Software should{" "}
            <span className={`mkt-fadeword ${receded ? "is-receded" : ""}`}>
              disappear.
            </span>
          </h2>

          <h2
            className="mkt-display-lg"
            style={{
              margin: "0.4em 0 0",
              opacity: emerged ? 1 : 0.04,
              transition: "opacity var(--mkt-dur-slow) var(--mkt-ease-out), transform var(--mkt-dur-slow) var(--mkt-ease-out)",
              transform: emerged ? "translateY(0)" : "translateY(0.4em)",
              color: "#EFE9DC",
            }}
            aria-hidden={!emerged}
          >
            Your work <span className="mkt-italic" style={{ color: "#C7B489" }}>shouldn&rsquo;t.</span>
          </h2>
        </div>

        <p className="mkt-lede" style={{ marginTop: "3.5rem", maxWidth: "34em", color: "#B5B0A2" }}>
          Spectre quietly connects the people, information and workflows behind an exceptional
          private club — so the team can spend less time operating software and more time
          running the club.
        </p>
      </div>
    </section>
  );
}
