"use client";

// COA-MAP-2C (2026-10-06) — pointer-driven whole-row mapping drag.
//
// HTML5 DnD could not deliver the premium motion the founder asked
// for:
//   • no click-vs-drag threshold (HTML5 fires immediately);
//   • browser-native translucent screenshot ghost that cannot be
//     cleanly replaced on all platforms;
//   • no source lift / placeholder;
//   • pointer tracking tied to dragover event frequency rather than
//     a smooth rAF animation loop;
//   • text selection can't be suppressed only during the gesture.
//
// This module replaces the TRANSPORT only.  The canonical mapping
// APIs (/api/admin/coa-mapping/preview + /.../reassign), validation
// semantics, effective-dating, audit trail, and shared Preview UI
// are all unchanged.
//
// Design:
//   • `onPointerDown` on the row records (startX, startY, account).
//   • Movement > 6 px activates drag mode; movement ≤ 6 px is a
//     normal click (Inspector opens via the row's own onClick).
//   • The floating overlay is a fixed-position React element
//     positioned by `transform: translate3d(x, y, 0)` so it never
//     touches layout.
//   • The source row gets `data-dragging-source="true"` so CSS can
//     fade it (opacity 0.35) without reflow.
//   • Drop target is detected via `document.elementFromPoint(x, y)`
//     walked up to the nearest `[data-fs-group-id]` ancestor.
//   • Auto-scroll runs on a dedicated rAF loop driven by the LAST
//     known pointer Y, with progressive velocity 2–14 px/frame
//     based on edge-zone penetration (quadratic ramp).
//   • `pointer-events: none` on the overlay so elementFromPoint
//     reports the actual DOM beneath the pointer.
//   • Suppress text selection via `user-select: none` on <html>
//     only during active drag.

import { useCallback, useEffect, useRef, useState } from "react";

const DRAG_THRESHOLD_PX = 6;
const EDGE_ZONE_PX = 100;
const V_BASE_PX_PER_FRAME = 2;   // outer zone
const V_MAX_PX_PER_FRAME = 14;   // extreme edge

type SelectableLike = Element & { tagName: string };

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  // Walk up a few parents to catch nested wrappers around a control.
  //
  // COA-MAP-3C (2026-10-08) — `A` (links) and `role="link"` are
  // DELIBERATELY NOT in this exclusion list.  The Chart of Accounts
  // Name column wraps the account name in a <Link> to the GL
  // account page, and the founder's natural grab point on an
  // account row is its name.  Blocking drag on <a> was the exact
  // regression the founder reported: "lost ability to drag and
  // drop accounts between Financial Statement Groups."
  //
  // The DRAG vs CLICK disambiguation is preserved by the 6 px
  // movement threshold + the synthetic-click suppression window
  // the hook installs on pointerup (see useEffect below).  A pure
  // click (no movement) still lets the Link navigate; a drag
  // (movement > 6 px) activates mapping and suppresses the Link.
  let el: Element | null = target;
  for (let i = 0; i < 4 && el; i++, el = el.parentElement) {
    const t = (el as SelectableLike).tagName;
    if (t === "INPUT" || t === "BUTTON" || t === "SELECT" || t === "TEXTAREA" || t === "LABEL") return true;
    const role = el.getAttribute("role");
    if (role === "button" || role === "menuitem" || role === "checkbox") return true;
    if (el.hasAttribute("data-no-row-drag")) return true;
  }
  return false;
}

function findFsGroupIdAtPoint(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const target = (el as Element).closest("[data-fs-group-id]");
  if (!target) return null;
  const id = target.getAttribute("data-fs-group-id");
  return id && id.length > 0 ? id : null;
}

function findScrollableAncestor(el: Element | null): HTMLElement {
  let node: Element | null = el;
  while (node) {
    const he = node as HTMLElement;
    const oy = getComputedStyle(he).overflowY;
    if ((oy === "auto" || oy === "scroll") && he.scrollHeight > he.clientHeight) {
      return he;
    }
    node = node.parentElement;
  }
  return (document.scrollingElement ?? document.documentElement) as HTMLElement;
}

export type AccountDragInfo = {
  accountId: string;
  accountNumber: string;
  accountName: string;
  currentFsGroupName: string | null;
};

export type AccountDragState = {
  active: boolean;
  info: AccountDragInfo | null;
  pointer: { x: number; y: number };
  hoverGroupId: string | null;
};

export type UseAccountDrag = {
  state: AccountDragState;
  onRowPointerDown: (e: React.PointerEvent, info: AccountDragInfo) => void;
  cancel: () => void;
  /** Resolved on pointer-up WITH drag active.  Returns the target
   *  fsGroupId (or null if dropped outside a valid target).  The
   *  caller is responsible for opening the Reporting Impact drawer. */
  onDrop: (handler: (accountId: string, fsGroupId: string) => void) => void;
};

export function useAccountDrag(): UseAccountDrag {
  const [state, setState] = useState<AccountDragState>({
    active: false,
    info: null,
    pointer: { x: 0, y: 0 },
    hoverGroupId: null,
  });

  // Mutable refs so pointer listeners don't re-register on every
  // state change.
  const startRef = useRef<{ x: number; y: number; info: AccountDragInfo } | null>(null);
  const activeRef = useRef<boolean>(false);
  const pointerRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const scrollRafRef = useRef<number | null>(null);
  const scrollAncestorRef = useRef<HTMLElement | null>(null);
  const dropHandlerRef = useRef<((accountId: string, fsGroupId: string) => void) | null>(null);

  const stopScroll = useCallback(() => {
    if (scrollRafRef.current != null) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
  }, []);

  // rAF loop: pointer-driven velocity, independent of event rate.
  const scrollStep = useCallback(() => {
    if (!activeRef.current) {
      scrollRafRef.current = null;
      return;
    }
    const y = pointerRef.current.y;
    const vh = window.innerHeight;
    let v = 0;
    if (y < EDGE_ZONE_PX) {
      const t = Math.max(0, Math.min(1, 1 - y / EDGE_ZONE_PX));
      v = -Math.round(V_BASE_PX_PER_FRAME + t * t * (V_MAX_PX_PER_FRAME - V_BASE_PX_PER_FRAME));
    } else if (y > vh - EDGE_ZONE_PX) {
      const t = Math.max(0, Math.min(1, (y - (vh - EDGE_ZONE_PX)) / EDGE_ZONE_PX));
      v = Math.round(V_BASE_PX_PER_FRAME + t * t * (V_MAX_PX_PER_FRAME - V_BASE_PX_PER_FRAME));
    }
    if (v !== 0 && scrollAncestorRef.current) {
      scrollAncestorRef.current.scrollTop += v;
    }
    scrollRafRef.current = requestAnimationFrame(scrollStep);
  }, []);

  const activate = useCallback((x: number, y: number) => {
    activeRef.current = true;
    pointerRef.current = { x, y };
    // Lock in the scroll owner — the first scrollable ancestor of
    // the source row (should be `.spectre-dw-table-wrap` on the
    // Account List; falls back to document otherwise).
    const srcEl = document.querySelector(`[data-account-id="${startRef.current?.info.accountId}"]`);
    scrollAncestorRef.current = findScrollableAncestor(srcEl);
    // Prevent text selection + show grabbing cursor while active.
    document.documentElement.style.userSelect = "none";
    document.documentElement.style.cursor = "grabbing";
    // Mark the source row so CSS can fade it.
    if (srcEl) srcEl.setAttribute("data-dragging-source", "true");
    // Start the rAF scroll loop.
    if (scrollRafRef.current == null) {
      scrollRafRef.current = requestAnimationFrame(scrollStep);
    }
    setState((s) => ({
      ...s,
      active: true,
      info: startRef.current?.info ?? null,
      pointer: { x, y },
    }));
  }, [scrollStep]);

  const cleanup = useCallback(() => {
    activeRef.current = false;
    stopScroll();
    const prev = startRef.current?.info.accountId;
    if (prev) {
      const srcEl = document.querySelector(`[data-account-id="${prev}"]`);
      if (srcEl) srcEl.removeAttribute("data-dragging-source");
    }
    document.documentElement.style.userSelect = "";
    document.documentElement.style.cursor = "";
    startRef.current = null;
    scrollAncestorRef.current = null;
    setState({ active: false, info: null, pointer: { x: 0, y: 0 }, hoverGroupId: null });
  }, [stopScroll]);

  const cancel = useCallback(() => { cleanup(); }, [cleanup]);

  const onDrop = useCallback((handler: (accountId: string, fsGroupId: string) => void) => {
    dropHandlerRef.current = handler;
  }, []);

  // Global pointer listeners while a candidate drag is in flight.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!startRef.current) return;
      pointerRef.current = { x: e.clientX, y: e.clientY };
      if (!activeRef.current) {
        const dx = e.clientX - startRef.current.x;
        const dy = e.clientY - startRef.current.y;
        if (dx * dx + dy * dy >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
          activate(e.clientX, e.clientY);
        }
        return;
      }
      // Active drag — update pointer + hover target.
      const hoverId = findFsGroupIdAtPoint(e.clientX, e.clientY);
      setState((s) =>
        s.pointer.x === e.clientX && s.pointer.y === e.clientY && s.hoverGroupId === hoverId
          ? s
          : { ...s, pointer: { x: e.clientX, y: e.clientY }, hoverGroupId: hoverId },
      );
      e.preventDefault();
    };
    const onUp = (e: PointerEvent) => {
      if (!startRef.current) return;
      const wasActive = activeRef.current;
      const info = startRef.current.info;
      if (wasActive) {
        // COA-MAP-3C — suppress the synthetic `click` the browser
        // will dispatch next-tick for the pointerdown/up sequence.
        // Without this, dropping an account on a Financial
        // Statement Group that happens to overlap a <Link> (the
        // Name column) would navigate the user away mid-drop.
        // One-shot capturing click listener + preventDefault +
        // stopPropagation, auto-removed on fire or on the next
        // tick (whichever comes first).
        const suppressClick = (ce: MouseEvent) => {
          ce.preventDefault();
          ce.stopPropagation();
          ce.stopImmediatePropagation();
          window.removeEventListener("click", suppressClick, true);
        };
        window.addEventListener("click", suppressClick, true);
        setTimeout(() => window.removeEventListener("click", suppressClick, true), 0);

        const targetGroupId = findFsGroupIdAtPoint(e.clientX, e.clientY);
        cleanup();
        if (targetGroupId && dropHandlerRef.current) {
          dropHandlerRef.current(info.accountId, targetGroupId);
        }
      } else {
        // Below threshold — treat as a plain click.  Don't swallow;
        // the row's own onClick fires naturally, and if the pointer
        // was over a <Link> the Link navigation happens next-tick.
        startRef.current = null;
      }
    };
    const onCancel = () => { cleanup(); };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [activate, cleanup]);

  // Unmount cleanup.
  useEffect(() => () => { cleanup(); }, [cleanup]);

  const onRowPointerDown = useCallback((e: React.PointerEvent, info: AccountDragInfo) => {
    // Primary button only.
    if (e.button !== 0) return;
    // Interactive controls take precedence.
    if (isInteractiveTarget(e.target)) return;
    startRef.current = { x: e.clientX, y: e.clientY, info };
    pointerRef.current = { x: e.clientX, y: e.clientY };
    // We don't preventDefault here — row click should still fire
    // on pointerup if we never cross the threshold.
  }, []);

  return { state, onRowPointerDown, cancel, onDrop };
}

/**
 * The floating representation of the dragged account.  Fixed-
 * position, transform-translated, pointer-events:none so the
 * elementFromPoint hit test underneath still works.
 */
export function AccountDragOverlay(props: { state: AccountDragState }) {
  if (!props.state.active || !props.state.info) return null;
  const { pointer, info } = props.state;
  // Offset so the overlay rides a bit below+right of the pointer
  // like a native drag ghost — not centered on the cursor.
  const x = pointer.x + 14;
  const y = pointer.y - 10;
  return (
    <div
      aria-hidden
      data-testid="coa-mapping-drag-overlay"
      className="coa-mapping-drag-overlay"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        transform: `translate3d(${x}px, ${y}px, 0)`,
        pointerEvents: "none",
        zIndex: 9999,
        willChange: "transform",
      }}
    >
      <div className="coa-mapping-drag-overlay-card">
        <span className="coa-mapping-drag-overlay-num">{info.accountNumber}</span>
        <span className="coa-mapping-drag-overlay-name">{info.accountName}</span>
        {info.currentFsGroupName && (
          <span className="coa-mapping-drag-overlay-group">{info.currentFsGroupName}</span>
        )}
      </div>
    </div>
  );
}
