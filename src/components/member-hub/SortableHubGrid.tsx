"use client";

// iOS-style sortable widget grid for the member hub.
//
// Contract:
//   - Each cell is a server-rendered widget (passed in as React `node`). The
//     client wraps it in a sortable container that reflows the other cells
//     with animation while one is being dragged.
//   - The client `order` + `sizes` state is the source of truth WHILE the
//     user is interacting. We only re-sync from props when the SET of widget
//     IDs changes (add/remove from the catalog) — never when the order or
//     individual sizes change, because that's what we're driving.
//   - The WHOLE CARD is draggable. Listeners attach to the cell wrapper so
//     a press-and-drag from anywhere on the tile reorders it. The
//     PointerSensor's 6px activation distance means a plain click on a
//     link inside the card still navigates — only a deliberate drag
//     activates a reorder. The overflow menu stops pointer-down
//     propagation so clicking `···` doesn't try to start a drag.
//
// Two sizes, one grid:
//   - COMPACT  cells take one row (≈132px tall).
//   - DETAILED cells take two rows (≈288px tall, matches the previous
//     single-size). `grid-auto-flow: dense` packs compact widgets into the
//     half-row gaps a detailed widget leaves behind.
//
// Persistence is async and silent: server actions fire after each
// interaction but do NOT revalidate `/app/member` — a server re-render
// during the drop or resize animation would corrupt dnd-kit's element
// registry and crash the next drag.

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";

export type WidgetSize = "COMPACT" | "DETAILED";

export type SortableItem = {
  id: string;                    // widget key, used by server actions
  size: WidgetSize;              // current persisted size
  compactNode: React.ReactNode;  // server-rendered compact tree
  detailedNode: React.ReactNode; // server-rendered detailed tree
};

// Short, decelerating drop transition shared by every cell so the active
// card AND the reflowing siblings finish landing together.
const DROP_TRANSITION = { duration: 140, easing: "cubic-bezier(0.2, 0.9, 0.3, 1)" } as const;

export function SortableHubGrid({
  items,
  onReorder,
  onRemove,
  onResize,
}: {
  items: SortableItem[];
  onReorder: (orderedKeys: string[]) => Promise<{ ok: boolean; error?: string }>;
  onRemove: (key: string) => Promise<{ ok: boolean; error?: string }>;
  onResize: (key: string, size: WidgetSize) => Promise<{ ok: boolean; error?: string }>;
}) {
  const incomingIds = useMemo(() => items.map((i) => i.id), [items]);
  const incomingSizes = useMemo(
    () => Object.fromEntries(items.map((i) => [i.id, i.size])) as Record<string, WidgetSize>,
    [items],
  );

  const [order, setOrder] = useState<string[]>(incomingIds);
  const [sizes, setSizes] = useState<Record<string, WidgetSize>>(incomingSizes);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const skipNextItemsSyncRef = useRef(false);

  // Re-sync from props ONLY when the SET of widget IDs changes (e.g. user
  // added or removed a widget from the catalog page). Pure reorders or size
  // toggles from THIS component must not clobber themselves on the round
  // trip — that would race the animation and corrupt dnd-kit state.
  useEffect(() => {
    if (skipNextItemsSyncRef.current) {
      skipNextItemsSyncRef.current = false;
      return;
    }
    setOrder((prev) => {
      const prevSet = new Set(prev);
      const sameSet =
        incomingIds.length === prev.length &&
        incomingIds.every((id) => prevSet.has(id));
      if (sameSet) return prev;
      return incomingIds;
    });
    setSizes((prev) => {
      // Adopt incoming sizes for ids we don't have locally yet; preserve
      // our local sizes for ids the user has already toggled this session.
      const next: Record<string, WidgetSize> = { ...prev };
      for (const id of incomingIds) {
        if (!(id in next)) next[id] = incomingSizes[id];
      }
      // Drop sizes for ids no longer present.
      for (const id of Object.keys(next)) {
        if (!incomingIds.includes(id)) delete next[id];
      }
      return next;
    });
  }, [incomingIds, incomingSizes]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = order.indexOf(String(active.id));
    const newIndex = order.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(order, oldIndex, newIndex);
    setOrder(next);
    startTransition(async () => {
      const r = await onReorder(next);
      if (!r.ok) setError(r.error ?? "Could not save layout");
      else setError(null);
    });
  }

  function handleRemove(key: string) {
    skipNextItemsSyncRef.current = true;
    setOrder((prev) => prev.filter((k) => k !== key));
    startTransition(async () => {
      const r = await onRemove(key);
      if (!r.ok) setError(r.error ?? "Could not remove widget");
      else setError(null);
    });
  }

  function handleResize(key: string) {
    const current = sizes[key] ?? "DETAILED";
    const next: WidgetSize = current === "COMPACT" ? "DETAILED" : "COMPACT";
    setSizes((prev) => ({ ...prev, [key]: next }));
    startTransition(async () => {
      const r = await onResize(key, next);
      if (!r.ok) setError(r.error ?? "Could not change widget size");
      else setError(null);
    });
  }

  // Map id → both pre-rendered trees. Both versions are server-rendered
  // upfront so the resize button can switch between them with zero round
  // trip — eliminates the "formatting lag" the old single-node design had
  // (the wrapper resized instantly via CSS but the content was the
  // server-rendered tree at the previous size).
  const nodesFor = useMemo(
    () => new Map(items.map((i) => [i.id, { compact: i.compactNode, detailed: i.detailedNode }])),
    [items],
  );

  return (
    <>
      {error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={order} strategy={rectSortingStrategy}>
          {/* Square-grid layout.
              - 8 columns on desktop (4 on tablet, 2 on mobile). Detailed
                widgets take 2×2 cells = 1/4 of the row; compacts take 1×1.
                With `aspect-square`, both shapes are squares, and detailed
                is exactly 4× the area of compact.
              - `grid-flow-dense` packs compacts into any half-row slot a
                detailed widget would otherwise leave behind. */}
          <div
            className="mt-8 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-6 grid-flow-dense"
            aria-live="polite"
            aria-busy={pending || undefined}
          >
            {order.map((id) => {
              const currentSize = sizes[id] ?? "DETAILED";
              const trees = nodesFor.get(id);
              const node = trees
                ? currentSize === "COMPACT" ? trees.compact : trees.detailed
                : null;
              return (
                <SortableCell
                  key={id}
                  id={id}
                  size={currentSize}
                  onRemove={() => handleRemove(id)}
                  onResize={() => handleResize(id)}
                >
                  {node}
                </SortableCell>
              );
            })}
          </div>
        </SortableContext>
      </DndContext>
    </>
  );
}

function SortableCell({
  id,
  size,
  children,
  onRemove,
  onResize,
}: {
  id: string;
  size: WidgetSize;
  children: React.ReactNode;
  onRemove: () => void;
  onResize: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    transition: DROP_TRANSITION,
  });
  // We deliberately ignore `transform.scaleX` / `transform.scaleY` from
  // `rectSortingStrategy`. That strategy computes scale based on an
  // imagined `arrayMove` swap: a 1x1 tile that would visually occupy a
  // 2x2's old slot gets scaleX=2, scaleY=2 (and vice versa). For our
  // grid the cells always keep their own col/row span — they only
  // translate — so scaling produces a wrong "tile briefly resizes when
  // another card passes over it" flash. Applying translation-only
  // transforms keeps every cell its real size throughout the drag.
  const style: React.CSSProperties = {
    transform: transform
      ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)`
      : undefined,
    transition,
    zIndex: isDragging ? 10 : undefined,
  };
  const detailed = size === "DETAILED";

  return (
    // The whole card is the drag surface. dnd-kit's PointerSensor activates
    // after 6px of movement (configured at the parent), so a quick click
    // anywhere — including on a link inside the card — still fires the
    // click and only a deliberate drag triggers a reorder.
    //
    // `touch-none` is required so the browser's native touch scrolling
    // doesn't steal pointer events from dnd-kit. `select-none` keeps the
    // user from accidentally selecting widget text while dragging.
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`relative group rounded-xl aspect-square cursor-grab active:cursor-grabbing touch-none select-none ${detailed ? "col-span-2 row-span-2" : "col-span-1 row-span-1"} ${isDragging ? "shadow-elevated ring-2 ring-club-green-400" : ""}`}
    >
      {children}
      {/* Top-right control pair: resize (toggle compact/detailed) and
          hide. `onPointerDown` stops propagation so a click on either
          button is invisible to the wrapper's drag listeners — pressing
          a control never starts a reorder. The icons appear on hover
          with no backdrop or border so the resting card stays clean. */}
      <div
        onPointerDown={(e) => e.stopPropagation()}
        className={`absolute top-2 right-2 z-20 flex items-center gap-1 transition-opacity ${isDragging ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"}`}
      >
        <button
          type="button"
          onClick={onResize}
          aria-label={detailed ? "Make widget compact" : "Make widget detailed"}
          className="h-6 w-6 inline-flex items-center justify-center text-stone-500 hover:text-club-green-700 cursor-pointer"
        >
          {detailed ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M3.5 8h9" /></svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M3.5 8h9" /><path d="M8 3.5v9" /></svg>
          )}
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Hide widget from hub"
          className="h-6 w-6 inline-flex items-center justify-center text-stone-500 hover:text-red-700 cursor-pointer"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </div>
    </div>
  );
}
