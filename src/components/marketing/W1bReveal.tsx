"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  className?: string;
  delayMs?: number;
  as?: keyof JSX.IntrinsicElements;
  children: React.ReactNode;
}

export function W1bReveal({ className = "", delayMs = 0, as = "div", children }: Props) {
  const Tag = as as any;
  const ref = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            if (delayMs > 0) setTimeout(() => setVisible(true), delayMs);
            else setVisible(true);
            obs.disconnect(); break;
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [delayMs]);
  return (
    <Tag ref={ref as any} className={`w1b-reveal ${visible ? "is-visible" : ""} ${className}`.trim()}>
      {children}
    </Tag>
  );
}
