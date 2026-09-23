"use client";

// WEB-1 §11 — "Software should disappear." editorial moment.
//
// As the reader scrolls, the word "disappear." recedes. Then "Your work
// shouldn't." emerges. Deliberately restrained — no scroll hijacking,
// respects prefers-reduced-motion (CSS fallback keeps the words legible
// with a soft dimming instead of blur).

import { useEffect, useRef, useState } from "react";
import { Wordmark } from "./Wordmark";

export function DisappearMoment() {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [progress, setProgress] = useState(0);   // 0 = fully visible, 1 = fully receded

  useEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect();
        // Progress starts when the element's top reaches ~65% of the
        // viewport and completes when its top hits ~20% — a short,
        // deliberate window that reads as a single beat rather than a
        // long scroll-jack.
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

  const receded = progress > 0.55;
  const emerged = progress > 0.55;

  return (
    <section
      id="disappear"
      className="mkt-surface-warm mkt-grain-warm"
      style={{ "--mkt-grain-alpha": 0.075 } as React.CSSProperties}
    >
      <div className="mkt-editorial" style={{ paddingBlock: "var(--mkt-section-y)" }}>
        <div className="mkt-eyebrow" style={{ marginBottom: "3rem" }}>
          <Wordmark variant="eyebrow" />
        </div>

        <div ref={anchorRef} style={{ minHeight: "42vh", position: "relative" }}>
          {/* First beat: Software should disappear. */}
          <h2 className="mkt-display-lg" style={{ margin: 0 }}>
            Software should&nbsp;
            <span className={`mkt-fadeword ${receded ? "is-receded" : ""}`}>
              disappear.
            </span>
          </h2>

          {/* Second beat: Your work shouldn't. */}
          <h2
            className="mkt-display-lg"
            style={{
              margin: "0.35em 0 0",
              opacity: emerged ? 1 : 0.05,
              transition: "opacity var(--mkt-dur-slow) var(--mkt-ease-out)",
              color: "var(--mkt-ink)",
            }}
            aria-hidden={!emerged}
          >
            Your work <span className="mkt-italic">shouldn&rsquo;t.</span>
          </h2>
        </div>

        <p className="mkt-lede" style={{ marginTop: "3rem", maxWidth: "34em" }}>
          Spectre quietly connects the people, information and workflows behind an exceptional
          private club — so the team can spend less time operating software and more time
          running the club.
        </p>
      </div>
    </section>
  );
}
