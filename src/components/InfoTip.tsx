"use client";

// Hover/focus tooltip rendered via a React portal to <body> so it
// cannot be clipped by the sticky-header / table overflow contexts
// it sits inside.
//
// Used by the COA mapping table's column headers to surface the
// complete list of available options for Type / Category / FS
// Group / Departments (founder spec 2026-07-03).
//
// Trigger is a small "i" button. The tooltip opens on hover OR
// keyboard focus and stays open while the cursor is inside either
// the trigger OR the tooltip body. Escape closes it explicitly.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

type Props = {
  /** Accessible label — read by screen readers as the button's name. */
  label: string;
  /** Tooltip content — usually a structured list of available options. */
  children: ReactNode;
  /** data-testid prefix for the trigger + popover. */
  testid: string;
  /** Optional max-width override for long lists (default 18rem). */
  maxWidthRem?: number;
};

export function InfoTip({ label, children, testid, maxWidthRem = 18 }: Props) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  // Portal target is created lazily on mount so SSR doesn't try to
  // hit document.body. The render is suppressed until then.
  useEffect(() => setMounted(true), []);

  // Reposition the popover relative to the trigger every time it
  // opens (and on scroll/resize while open so it follows correctly
  // inside a sticky header or scrolling table).
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const t = triggerRef.current;
      if (!t) return;
      const r = t.getBoundingClientRect();
      const popoverWidth = maxWidthRem * 16; // 1rem ≈ 16px
      // Default anchor: directly below the trigger, left edge
      // aligned. Flip rightward if the default would overflow the
      // viewport's right edge.
      let left = r.left;
      if (left + popoverWidth > window.innerWidth - 12) {
        left = Math.max(12, window.innerWidth - popoverWidth - 12);
      }
      setPos({ top: r.bottom + 6, left });
    };
    place();
    const onScroll = () => place();
    const onResize = () => place();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, maxWidthRem]);

  // Outside-click / Escape close. While the cursor is over either
  // the trigger or the popover, treat hover as "still inside" so
  // the user can move their mouse into the list to scroll it.
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`${label} info`}
        data-testid={`${testid}-trigger`}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={(e) => {
          // Don't close if the cursor moved INTO the popover.
          const next = e.relatedTarget as Node | null;
          if (next && popoverRef.current?.contains(next)) return;
          // Defer the close so the cursor has a frame to enter
          // the popover without flicker.
          setTimeout(() => {
            const stillInTrigger = triggerRef.current?.matches(":hover");
            const stillInPopover = popoverRef.current?.matches(":hover");
            if (!stillInTrigger && !stillInPopover) setOpen(false);
          }, 80);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKey}
        className="ml-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-stone-300 text-[9px] text-stone-500 hover:bg-stone-100 focus:outline-none focus:ring-2 focus:ring-club-gold/50"
      >
        i
      </button>
      {mounted && open
        ? createPortal(
            <div
              ref={popoverRef}
              role="tooltip"
              data-testid={`${testid}-popover`}
              onMouseLeave={(e) => {
                const next = e.relatedTarget as Node | null;
                if (next && triggerRef.current?.contains(next)) return;
                setOpen(false);
              }}
              style={{
                position: "fixed",
                top: pos.top,
                left: pos.left,
                maxWidth: `${maxWidthRem}rem`,
                maxHeight: "60vh",
                zIndex: 1000,
              }}
              className="overflow-y-auto rounded-md border border-stone-200 bg-white shadow-xl px-3 py-2 text-xs text-stone-700"
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
