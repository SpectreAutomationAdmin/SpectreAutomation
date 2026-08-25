"use client";

// HR-2C §6-8 (2026-08-20) — Anchored coach-mark popover.
//
// Companion primitive for the Employee Portal guided tour. Given a
// selector, resolves the target element, scrolls it into view if it
// is off-screen, then renders a popover attached to the target with:
//   • a small arrow/caret pointing at the target
//   • side-preference of RIGHT (matches sidebar nav; falls back to
//     BOTTOM / TOP if the right doesn't fit)
//   • viewport clamping so the popover stays fully on-screen
//   • re-layout on scroll + resize + mutation while open
//   • React portal to document.body (never clipped by scroll containers)
//   • Escape / Skip close
//
// Pattern lifted from src/components/InfoTip.tsx (the codebase's
// hand-rolled anchored popover — no floating-ui / radix / headlessui
// dependency added). The founder specifically directed §7: "Prefer
// an existing positioning primitive already in the repository."
//
// The component is generic enough to be reused for future coach-marks
// on other Spectre surfaces; kept co-located under
// `components/employee/` for HR-2C's initial consumer.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";

export type CoachMarkSide = "right" | "bottom" | "top" | "left";

interface Props {
  /** CSS selector for the target element. Typically a
   *  `[data-tour-target="…"]` or an existing `[data-testid="…"]`. */
  targetSelector: string;
  /** Preferred side. The component flips to another side when the
   *  preferred side would clip the viewport. Default `right` (best
   *  for a fixed left sidebar). */
  preferredSide?: CoachMarkSide;
  /** Pixel gap between the popover and the target element. */
  gap?: number;
  /** Content of the popover. */
  children: ReactNode;
  /** Called if the target selector doesn't resolve after
   *  `resolveTimeoutMs`. Callers can advance the tour past a step
   *  whose target vanished (e.g. hidden on mobile). */
  onTargetMissing?: () => void;
  /** How long to wait for the target to appear before treating it
   *  as missing. Default 500 ms. */
  resolveTimeoutMs?: number;
  /** Optional data-testid on the popover shell. */
  testId?: string;
  /** Optional additional Tailwind class list for the popover shell. */
  className?: string;
}

// HR mobile-hotfix (2026-08-30) — mobile-responsive popover width.
// At 390 px viewport - 24 px viewport-margin the desktop 320-px
// popover left only 46 px of slack (and often didn't fit at all,
// which is exactly why the founder saw the popover cover the
// widget it was supposed to point at). The width is now a
// viewport-relative computation with a hard cap.
const POPOVER_WIDTH_DESKTOP = 320;
const POPOVER_WIDTH_MOBILE_MAX = 280;   // upper cap at ≥ mobile viewports
const POPOVER_MOBILE_BREAKPOINT = 640;  // < 640 px is treated as mobile
const VIEWPORT_MARGIN = 12;
const DEFAULT_GAP = 10;
const DEFAULT_TIMEOUT_MS = 500;

/** Resolve the popover width the caller should render at, given the
 *  current viewport. On mobile we shrink the popover so it (a) fits
 *  next to the target on 390-px screens and (b) doesn't blanket the
 *  widget it's supposed to point at. */
function resolvePopoverWidth(): number {
  if (typeof window === "undefined") return POPOVER_WIDTH_DESKTOP;
  const vw = window.innerWidth;
  if (vw >= POPOVER_MOBILE_BREAKPOINT) return POPOVER_WIDTH_DESKTOP;
  // Fit within viewport minus 2× margin, capped at MOBILE_MAX.
  return Math.min(POPOVER_WIDTH_MOBILE_MAX, vw - VIEWPORT_MARGIN * 2);
}

interface Position {
  top: number;
  left: number;
  side: CoachMarkSide;
  arrowOffset: number;
}

export default function CoachMark({
  targetSelector,
  preferredSide = "right",
  gap = DEFAULT_GAP,
  children,
  onTargetMissing,
  resolveTimeoutMs = DEFAULT_TIMEOUT_MS,
  testId,
  className,
}: Props) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const [target, setTarget] = useState<Element | null>(null);
  const [pos, setPos] = useState<Position | null>(null);

  // Portal target — bail on SSR.
  useEffect(() => setMounted(true), []);

  // Resolve target element (with a short wait so freshly-mounted nav
  // links have time to appear). Scrolls into view if off-screen.
  useEffect(() => {
    let cancelled = false;
    let elapsed = 0;
    const step = 50;
    function tryResolve() {
      const el = document.querySelector(targetSelector);
      if (el) {
        if (!cancelled) {
          setTarget(el);
          // Scroll into view only if not fully visible.
          const r = el.getBoundingClientRect();
          const offscreen =
            r.top < 0 ||
            r.left < 0 ||
            r.bottom > window.innerHeight ||
            r.right > window.innerWidth;
          if (offscreen) el.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
        return;
      }
      elapsed += step;
      if (elapsed >= resolveTimeoutMs) {
        if (!cancelled) onTargetMissing?.();
        return;
      }
      window.setTimeout(tryResolve, step);
    }
    tryResolve();
    return () => { cancelled = true; };
  }, [targetSelector, resolveTimeoutMs, onTargetMissing]);

  // Position the popover.
  useLayoutEffect(() => {
    if (!target || !mounted) return;
    // On mobile the drawer / mobile-nav can shift layout AFTER the
    // initial place() call. MutationObserver + rAF re-layout catches
    // those late layout changes (§8 — "prove the rendered CoachMark
    // geometry is actually relative to the target element"; a
    // stale one-shot position would let the popover drift off the
    // widget as the shell animates in).
    const place = () => {
      const r = target.getBoundingClientRect();
      const popW = resolvePopoverWidth();
      const popH = popoverRef.current?.getBoundingClientRect().height ?? 160;
      const sides: CoachMarkSide[] =
        preferredSide === "right"
          ? ["right", "bottom", "top", "left"]
          : preferredSide === "bottom"
            ? ["bottom", "top", "right", "left"]
            : preferredSide === "top"
              ? ["top", "bottom", "right", "left"]
              : ["left", "right", "bottom", "top"];
      for (const side of sides) {
        const candidate = calcPlacement(r, side, popW, popH, gap);
        if (fits(candidate.top, candidate.left, popW, popH)) {
          setPos(candidate);
          return;
        }
      }
      // No side fits — clamp the preferred side to viewport bounds.
      const forced = calcPlacement(r, preferredSide, popW, popH, gap);
      setPos({
        ...forced,
        top: clamp(forced.top, VIEWPORT_MARGIN, window.innerHeight - popH - VIEWPORT_MARGIN),
        left: clamp(forced.left, VIEWPORT_MARGIN, window.innerWidth - popW - VIEWPORT_MARGIN),
      });
    };
    place();
    // A short RAF chain catches the target's post-animation resting
    // rect (the mobile drawer slides in over ~150 ms).
    let raf = 0;
    let attempts = 0;
    const settle = () => {
      place();
      if (attempts++ < 8) raf = window.requestAnimationFrame(settle);
    };
    raf = window.requestAnimationFrame(settle);
    const onScroll = () => place();
    const onResize = () => place();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    // MutationObserver on document.body catches DOM changes that
    // shift the target's rect (drawer opens, notification bar
    // appears / disappears, etc.) without our own event handlers.
    const mo = new MutationObserver(() => place());
    mo.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ["class", "style"],
    });
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      if (raf) window.cancelAnimationFrame(raf);
      mo.disconnect();
    };
  }, [target, mounted, gap, preferredSide]);

  if (!mounted || !target || !pos) return null;

  const style: CSSProperties = {
    position: "fixed",
    top: pos.top,
    left: pos.left,
    width: resolvePopoverWidth(),
    // Hard-cap max-width so a stale render never overflows the viewport.
    maxWidth: `calc(100vw - ${VIEWPORT_MARGIN * 2}px)`,
    zIndex: 1000,
  };

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-modal="false"
      style={style}
      className={
        "rounded-lg border border-stone-200 bg-white shadow-lg " +
        (className ?? "")
      }
      data-testid={testId}
      data-coach-mark-side={pos.side}
    >
      <Arrow side={pos.side} offset={pos.arrowOffset} />
      {children}
    </div>,
    document.body,
  );
}

// -- helpers -----------------------------------------------------------------

function calcPlacement(
  target: DOMRect,
  side: CoachMarkSide,
  popW: number,
  popH: number,
  gap: number,
): Position {
  const targetCenterY = target.top + target.height / 2;
  const targetCenterX = target.left + target.width / 2;
  let top = 0;
  let left = 0;
  let arrowOffset = 0;
  switch (side) {
    case "right":
      top = targetCenterY - popH / 2;
      left = target.right + gap;
      arrowOffset = clamp(popH / 2, 20, popH - 20);
      break;
    case "left":
      top = targetCenterY - popH / 2;
      left = target.left - popW - gap;
      arrowOffset = clamp(popH / 2, 20, popH - 20);
      break;
    case "bottom":
      top = target.bottom + gap;
      left = targetCenterX - popW / 2;
      arrowOffset = clamp(popW / 2, 20, popW - 20);
      break;
    case "top":
      top = target.top - popH - gap;
      left = targetCenterX - popW / 2;
      arrowOffset = clamp(popW / 2, 20, popW - 20);
      break;
  }
  return { top, left, side, arrowOffset };
}

function fits(top: number, left: number, w: number, h: number): boolean {
  return (
    top >= VIEWPORT_MARGIN &&
    left >= VIEWPORT_MARGIN &&
    top + h <= window.innerHeight - VIEWPORT_MARGIN &&
    left + w <= window.innerWidth - VIEWPORT_MARGIN
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Small arrow/caret rendered on the side of the popover facing
 *  the target. Pure CSS via a border-triangle so no SVG is needed. */
function Arrow({ side, offset }: { side: CoachMarkSide; offset: number }) {
  const size = 8;
  const common: CSSProperties = { position: "absolute", width: 0, height: 0, borderStyle: "solid" };
  switch (side) {
    case "right":
      return (
        <span
          data-testid="coach-mark-arrow"
          style={{
            ...common,
            top: offset - size,
            left: -size,
            borderWidth: `${size}px ${size}px ${size}px 0`,
            borderColor: `transparent white transparent transparent`,
            filter: "drop-shadow(-1px 0 0 rgb(231 229 228))",
          }}
        />
      );
    case "left":
      return (
        <span
          data-testid="coach-mark-arrow"
          style={{
            ...common,
            top: offset - size,
            right: -size,
            borderWidth: `${size}px 0 ${size}px ${size}px`,
            borderColor: `transparent transparent transparent white`,
            filter: "drop-shadow(1px 0 0 rgb(231 229 228))",
          }}
        />
      );
    case "bottom":
      return (
        <span
          data-testid="coach-mark-arrow"
          style={{
            ...common,
            top: -size,
            left: offset - size,
            borderWidth: `0 ${size}px ${size}px ${size}px`,
            borderColor: `transparent transparent white transparent`,
            filter: "drop-shadow(0 -1px 0 rgb(231 229 228))",
          }}
        />
      );
    case "top":
      return (
        <span
          data-testid="coach-mark-arrow"
          style={{
            ...common,
            bottom: -size,
            left: offset - size,
            borderWidth: `${size}px ${size}px 0 ${size}px`,
            borderColor: `white transparent transparent transparent`,
            filter: "drop-shadow(0 1px 0 rgb(231 229 228))",
          }}
        />
      );
  }
}
