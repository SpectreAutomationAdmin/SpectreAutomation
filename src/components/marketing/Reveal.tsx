"use client";

// WEB-1 §26 — restrained reveal-on-scroll wrapper.
//
// Adds the .is-visible class to the root when the element enters the
// viewport. Respects prefers-reduced-motion via the CSS in marketing.css
// (which sets a no-transition fallback).

import { useEffect, useRef, useState } from "react";

interface RevealProps {
  as?: keyof JSX.IntrinsicElements;
  className?: string;
  delayMs?: number;
  children: React.ReactNode;
}

export function Reveal({ as = "div", className = "", delayMs = 0, children }: RevealProps) {
  const Tag = as as any;
  const ref = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            if (delayMs > 0) {
              setTimeout(() => setVisible(true), delayMs);
            } else {
              setVisible(true);
            }
            obs.disconnect();
            break;
          }
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -8% 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [delayMs]);

  return (
    <Tag
      ref={ref as any}
      className={`mkt-reveal ${visible ? "is-visible" : ""} ${className}`.trim()}
    >
      {children}
    </Tag>
  );
}
