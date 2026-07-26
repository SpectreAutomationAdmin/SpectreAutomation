"use client";

// Small hover/focus help bubble used in the top-right of analytics
// KPI tiles. The trigger is a circled "?" glyph; the bubble appears on
// mouse hover or keyboard focus and explains what the KPI tracks and
// why a manager cares.
//
// Accessibility:
//   • Wrapped in a real <button> so it's reachable by keyboard, with
//     focus styling that matches the rest of the design system.
//   • The bubble uses role="tooltip" and is linked via aria-describedby
//     when visible.
//   • Click does nothing — it's an info affordance only — but a click
//     toggles the bubble for touch devices that don't fire hover.

import { useEffect, useId, useRef, useState } from "react";

export function HelpTip({ text, label = "What does this mean?" }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrapperRef = useRef<HTMLSpanElement>(null);

  // Close on outside click for the touch / click-to-open flow.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [open]);

  return (
    <span
      ref={wrapperRef}
      className="relative inline-flex items-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          // Prevent a wrapping <a href> on the KpiCard from navigating
          // when the user just wants to read the help.
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-stone-300 bg-white text-[10px] font-medium text-stone-500 hover:border-club-green-400 hover:text-club-green-700 focus:outline-none focus:ring-2 focus:ring-club-green-400/40"
      >
        ?
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="absolute right-0 top-7 z-30 w-64 rounded-md border border-stone-200 bg-white text-stone-700 shadow-elevated px-3 py-2 text-xs leading-snug"
        >
          {text}
        </span>
      )}
    </span>
  );
}
