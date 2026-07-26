"use client";

// Seat-level POS client.
//
// Left  — seat strip (touch-friendly seat buttons + per-seat order).
// Right — menu picker (categories, items, "Add to seat X").
// Bottom strip — "Send to kitchen/bar" + "Split & settle".
//
// Adding an item posts to addSeatItemAction (with the active seat
// number, or tableLevel=true if "Table" is selected). Sending fires
// chits via the existing sendUnsentItems. Settling shows a split
// dialog: pick groups, pick member-account per group, settle.

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  addSeatItemAction,
  removeSeatLineAction,
  sendSeatItemsAction,
  settleBySeatsAction,
  assignSeatAction,
  listSeatLineModifiersAction,
  setSeatLineModifiersAction,
  initiateQRPaymentAction,
  getQRPaymentStatusAction,
  cancelQRPaymentAction,
  simulateQRPaymentAction,
} from "../_actions";
import { getMenuTileDensity, getDescriptionTextClass } from "@/lib/pos/menu-density";

type LineModifier = {
  id: string;
  optionId: string | null;
  modifierType: "REMOVE" | "ADD" | "SUBSTITUTE" | "ALLERGY" | "NOTE";
  label: string;
  printLabel: string | null;
  priceDelta: number;
};

type SeatItem = {
  id: string;
  // Phase 7D — menuItemId drives the modifier catalog lookup. Nullable
  // because legacy lines may have been ringed in before menu pinning.
  menuItemId: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  status: string;
  seatNumber: number | null;
  // Denormalised flag so the UI can flag the line red even before it
  // expands the modifier list.
  hasAllergy: boolean;
  modifiers: LineModifier[];
};

type Seat = {
  seatNumber: number;
  subtotal: number;
  draftCount: number;
  sentCount: number;
  readyCount: number;
  servedCount: number;
  inGroupId: string | null;
  // Per-seat member / guest assignment. `isPrimary` is the host the
  // waiter set at seating time — that seat keeps its assignment for the
  // life of the check (UI blocks clearing it).
  assignment: {
    isPrimary: boolean;
    memberId: string | null;
    memberDisplay: string | null;
    memberNumber: string | null;
    guestName: string | null;
  };
  items: SeatItem[];
};

type TableLine = {
  id: string;
  menuItemId: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  status: string;
  hasAllergy: boolean;
  modifiers: LineModifier[];
};

// Allergens server-selectable on the modifier modal. Match the legacy
// LoungePOS set so the prep team sees consistent labels.
const COMMON_ALLERGENS = [
  "Gluten / wheat",
  "Dairy",
  "Egg",
  "Nut",
  "Peanut",
  "Soy",
  "Shellfish",
  "Fish",
  "Sesame",
  "Mustard",
  "Sulphite",
] as const;

// Per-line modifier delta (per unit × quantity).
function lineModifierTotal(line: SeatItem | TableLine): number {
  const perUnit = line.modifiers.reduce((s, m) => s + m.priceDelta, 0);
  return perUnit * line.quantity;
}
// Base price + modifier delta for one line.
function lineTotal(line: SeatItem | TableLine): number {
  return line.quantity * line.unitPrice + lineModifierTotal(line);
}

// accessStatus is read so the settle modal can disable Charge to
// Member Account for members whose charge account is suspended and
// route them to Pay by QR Code instead. Default-treated as enabled
// when missing for backwards compatibility with older payloads.
type Member = {
  id: string;
  firstName: string;
  lastName: string;
  memberNumber: string;
  accessStatus?: string | null;
};

type Cat = {
  id: string;
  name: string;
  items: Array<{ id: string; name: string; price: number; description: string | null }>;
};

export function SeatPOS({
  checkId,
  checkNumber,
  checkStatus,
  capacity,
  tableShape,
  tableLabel,
  seats,
  tableLines,
  menu,
  members,
  defaultMemberId,
}: {
  checkId: string;
  checkNumber: string;
  checkStatus: string;
  capacity: number;
  tableShape: "ROUND" | "SQUARE" | "RECTANGLE";
  tableLabel: string;
  seats: Seat[];
  tableLines: TableLine[];
  menu: Cat[];
  members: Member[];
  defaultMemberId: string | null;
}) {
  const router = useRouter();
  // Start with NO seat selected so the empty state ("Select a seat to
  // begin adding items.") reads correctly when the server first opens
  // the table. The seat strip's selected-seat highlight then becomes
  // a meaningful visual indicator after the first click.
  const [activeSeat, setActiveSeat] = useState<number | "TABLE" | null>(null);
  const [activeCat, setActiveCat] = useState<string>(menu[0]?.id ?? "");
  // Ref to the active-seat card. Whenever the server picks a new seat
  // we scroll it into view so the assignment panel is never below the
  // fold on smaller windows.
  const activeCardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (activeSeat !== null && activeCardRef.current) {
      activeCardRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [activeSeat]);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // Modifier modal — opened from the "Modify" button on a DRAFT line.
  // Holds the line being edited; null when closed.
  const [modifierLine, setModifierLine] = useState<SeatItem | TableLine | null>(null);

  const totals = useMemo(() => {
    // Server-side subtotal (qty × unit × discount) plus the per-line
    // modifier delta. Modifier deltas roll into the displayed grand
    // total so the server sees the right number on the bottom strip;
    // settlement still re-computes server-side from the source rows.
    const seatTotal = seats.reduce((s, x) => {
      const seatModDelta = x.items.reduce((acc, it) => acc + lineModifierTotal(it), 0);
      return s + x.subtotal + seatModDelta;
    }, 0);
    const tableTotal = tableLines.reduce((s, l) => s + lineTotal(l), 0);
    return { seatTotal, tableTotal, grand: seatTotal + tableTotal };
  }, [seats, tableLines]);

  function runAdd(menuItemId: string) {
    if (activeSeat === null) {
      setError("Select a seat to begin ordering.");
      return;
    }
    setError(null); setInfo(null);
    startTransition(async () => {
      const r = await addSeatItemAction(checkId, [{
        menuItemId,
        quantity: 1,
        seatNumber: activeSeat === "TABLE" ? undefined : activeSeat,
        tableLevel: activeSeat === "TABLE",
      }]);
      if (!r.ok) { setError(r.error); return; }
      router.refresh();
    });
  }

  function runRemove(checkLineId: string) {
    setError(null); setInfo(null);
    startTransition(async () => {
      const r = await removeSeatLineAction(checkId, checkLineId);
      if (!r.ok) { setError(r.error); return; }
      router.refresh();
    });
  }

  function openModifier(line: SeatItem | TableLine) {
    setError(null); setInfo(null);
    setModifierLine(line);
  }

  function saveModifier(mods: Array<{
    optionId: string | null;
    modifierType: "REMOVE" | "ADD" | "SUBSTITUTE" | "ALLERGY" | "NOTE";
    label: string;
    printLabel: string | null;
    priceDelta: number;
  }>) {
    if (!modifierLine) return;
    const lineId = modifierLine.id;
    startTransition(async () => {
      const r = await setSeatLineModifiersAction(checkId, lineId, mods);
      if (!r.ok) { setError(r.error); return; }
      setModifierLine(null);
      router.refresh();
    });
  }

  function runSend() {
    setError(null); setInfo(null);
    startTransition(async () => {
      const r = await sendSeatItemsAction(checkId);
      if (!r.ok) { setError(r.error); return; }
      setInfo(r.data.count > 0 ? `Sent ${r.data.count} chit${r.data.count === 1 ? "" : "s"} to the kitchen / bar.` : "Nothing to send.");
      router.refresh();
    });
  }

  // Step 21 — three-zone layout designed for hospitality POS use.
  //
  //   ┌──────────────────────────────────────────────────────┐
  //   │  Header (back link / hint / banners)                 │  ← flex-shrink-0
  //   ├──────────────────────────────────────────┬───────────┤
  //   │                                          │           │
  //   │   LEFT: menu panel (dominant)            │   RIGHT   │
  //   │   • category chips                       │   • table │
  //   │   • items grid (internal scroll)         │   • seat  │
  //   │                                          │   • lines │
  //   │                                          │     (scr) │
  //   ├──────────────────────────────────────────┴───────────┤
  //   │  Footer: Send / Split & settle / totals              │  ← sticky, always visible
  //   └──────────────────────────────────────────────────────┘
  //
  // Whole shell is viewport-locked (`h-[calc(100vh-120px)]`), so the
  // page itself never scrolls. Each scrolling zone gets `min-h-0` +
  // `overflow-y-auto`; the action bar is OUTSIDE all scroll
  // containers, so it cannot be pushed off-screen by a long order.
  return (
    <div
      data-testid="seatpos-shell"
      className="flex h-[calc(100vh-120px)] flex-col gap-3"
    >
      {/* Header — compact context strip. */}
      <div className="flex flex-shrink-0 items-center justify-between">
        <Link
          href="/app/admin/hospitality/reservations/floor"
          className="text-sm text-stone-500 hover:text-club-ink"
        >
          ← Back to floor map
        </Link>
        {activeSeat === null && (
          <span className="text-xs text-stone-500">Select a seat to begin ordering.</span>
        )}
      </div>
      {error && (
        <div className="flex-shrink-0 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      {info && (
        <div className="flex-shrink-0 rounded-md border border-club-green-300 bg-club-green-50 px-3 py-2 text-sm text-club-green-800">
          {info}
        </div>
      )}

      {/* Workspace — menu LEFT (1fr), side rail RIGHT (360px). */}
      <div
        data-testid="seatpos-workspace"
        className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]"
      >
        {/* LEFT: menu panel — primary workspace. */}
        <main
          data-testid="seatpos-menu-panel"
          className="card card-body flex min-h-0 flex-col"
        >
          <div className="flex flex-shrink-0 items-baseline justify-between gap-3">
            <h2 className="section-title text-base">Menu</h2>
            <span className="text-[11px] text-stone-500">
              {activeSeat === null
                ? "Select a seat on the right to start adding items."
                : activeSeat === "TABLE"
                  ? "Adding to: Table (shared)"
                  : `Adding to: Seat ${activeSeat}`}
            </span>
          </div>
          {/* Category chips — single-category-at-a-time, no vertical
              category stacking (matches Toast / TouchBistro / Square). */}
          <div className="mt-2 flex flex-shrink-0 flex-wrap gap-1.5">
            {menu.map((c) => (
              <button
                key={c.id}
                onClick={() => setActiveCat(c.id)}
                className={`rounded-md border px-2.5 py-1 text-xs ${activeCat === c.id ? "border-stone-900 bg-stone-900 text-white" : "border-stone-300 bg-white text-stone-700 hover:border-stone-500"}`}
              >
                {c.name}
              </button>
            ))}
          </div>
          {/* Items grid — Step 24: adaptive density via the
              getMenuTileDensity helper. Four tiers, all using
              `minmax(MIN, 1fr)` so tiles share leftover panel width
              instead of being capped at an absolute MAX px. This is
              what produces the visibly larger tiles in beverage
              categories (Wine, Draught) that step 23 missed —
              tiles now render at ~196–236 px on a typical 700–880 px
              menu panel, with room for a 1-line description. */}
          {(() => {
            const items = menu.find((c) => c.id === activeCat)?.items ?? [];
            const cfg = getMenuTileDensity({ itemCount: items.length });
            const maxToken = cfg.tileMax === "1fr" ? "1fr" : `${cfg.tileMax}px`;
            return (
              <div
                data-testid="seatpos-menu-items"
                data-density={cfg.density}
                data-item-count={items.length}
                className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1"
                style={{
                  display: "grid",
                  gridTemplateColumns: `repeat(auto-fill, minmax(${cfg.tileMin}px, ${maxToken}))`,
                  gridAutoRows: "min-content",
                  alignContent: "start",
                  justifyContent: "start",
                  gap: cfg.gap,
                }}
              >
                {items.map((it) => {
                  // Step 26 — length-aware description typography.
                  // Resolves to "" when the description should not
                  // render at all (dense tier, or a too-long string
                  // on the compact tier). The helper guarantees the
                  // returned font size is strictly smaller than the
                  // tier's title size.
                  const descClass = cfg.showDescription && it.description
                    ? getDescriptionTextClass({
                        density: cfg.density,
                        descriptionLength: it.description.length,
                      })
                    : "";
                  return (
                    <button
                      key={it.id}
                      disabled={pending}
                      onClick={() => runAdd(it.id)}
                      style={{
                        // Step 29 — every tile in the category is
                        // exactly cfg.tileHeight tall. Uniform rows,
                        // no aspect-ratio acrobatics. Short
                        // descriptions leave intentional whitespace
                        // inside the tile; long descriptions clamp.
                        height: cfg.tileHeight,
                      }}
                      className={`flex flex-col overflow-hidden rounded-md border border-stone-200 ${cfg.tilePadding} text-left transition-colors hover:border-stone-400 hover:bg-stone-50 hover:shadow-sm disabled:opacity-50`}
                    >
                      {/* Step 29 — three flex zones inside a fixed-
                          height tile. Name hugs the top; description
                          occupies the middle band (flex-1, min-h-0,
                          overflow-hidden so line-clamp clips before
                          overlapping the price); price sticks to the
                          bottom-right. Uniform card shape. */}
                      <span className={`block flex-shrink-0 ${cfg.nameClass}`}>{it.name}</span>
                      {descClass && it.description ? (
                        // Step 29.1 — the line-clamp class sets
                        // `display: -webkit-box`, which conflicts
                        // with `flex-1` on the same element (the
                        // child loses flex-item semantics). Wrap:
                        // outer div takes the flex-1 middle band;
                        // inner div carries the clamp class.
                        <div className="mt-2 min-h-0 flex-1 overflow-hidden">
                          <p
                            data-testid="menu-item-description"
                            className={`break-words ${descClass}`}
                          >
                            {it.description}
                          </p>
                        </div>
                      ) : (
                        // No description: keep a flex-1 spacer so
                        // the price still floats bottom-right inside
                        // the uniform-height tile.
                        <div className="flex-1" aria-hidden="true" />
                      )}
                      <div className="mt-2 flex flex-shrink-0 items-end justify-end">
                        <span className={cfg.priceClass}>{fmt(it.price)}</span>
                      </div>
                    </button>
                  );
                })}
                {menu.length === 0 && <div className="text-xs text-stone-500">No active lounge menu categories.</div>}
                {menu.length > 0 && items.length === 0 && (
                  <div className="text-xs text-stone-500">No items in this category yet.</div>
                )}
              </div>
            );
          })()}
        </main>

        {/* RIGHT: side rail — compact table visual + active-seat
            detail. The active-seat card scrolls internally so a long
            line list never pushes the sticky action bar off screen. */}
        <aside
          data-testid="seatpos-side-rail"
          className="flex min-h-0 flex-col gap-3"
        >
          {/* Compact table visual. The seat strip stays at its
              intrinsic size (~280px max via existing SVG cap). */}
          <div className="card card-body flex-shrink-0">
            <SeatStrip
              capacity={capacity}
              shape={tableShape}
              label={tableLabel}
              seats={seats}
              tableLines={tableLines}
              activeSeat={activeSeat}
              onSelect={(n) => setActiveSeat(n)}
            />
          </div>

          {/* Active seat — internal scroll so long orders don't
              blow up the layout. */}
          <div
            ref={activeCardRef}
            data-testid="seatpos-active-seat"
            className="card card-body flex min-h-0 flex-1 flex-col overflow-y-auto"
          >
            <h2 className="section-title flex-shrink-0 text-base">
              {activeSeat === null
                ? "No seat selected"
                : activeSeat === "TABLE"
                  ? "Table items (shared)"
                  : `Seat ${activeSeat}`}
            </h2>
            {activeSeat === null ? (
              <p className="mt-2 text-sm text-stone-500">
                Select a seat to begin ordering.
              </p>
            ) : (
              <>
                {/* Phase 18F — surface the active seat's assignment +
                    inline controls to (re)assign member or mark guest. */}
                {typeof activeSeat === "number" && (
                  <SeatAssignmentRow
                    checkId={checkId}
                    seat={seats.find((s) => s.seatNumber === activeSeat) ?? null}
                    members={members}
                    onChanged={() => router.refresh()}
                  />
                )}
                <SeatOrderList
                  activeSeat={activeSeat}
                  seats={seats}
                  tableLines={tableLines}
                  pending={pending}
                  onRemove={runRemove}
                  onModify={openModifier}
                />
              </>
            )}
          </div>
        </aside>
      </div>

      {/* Sticky action bar — OUTSIDE all scroll containers. Always
          visible regardless of seat-item count, category size, or
          screen height. */}
      <footer
        data-testid="seatpos-action-bar"
        className="flex flex-shrink-0 flex-wrap items-center gap-2 border-t border-stone-200 bg-white py-3"
      >
        <button disabled={pending} onClick={runSend} className="btn btn-primary btn-sm">
          {pending ? "Working…" : "Send to kitchen / bar"}
        </button>
        <SplitSettleButton
          checkId={checkId}
          seats={seats}
          tableLines={tableLines}
          members={members}
          defaultMemberId={defaultMemberId}
          disabled={pending || checkStatus === "CLOSED" || checkStatus === "VOIDED"}
          onChanged={() => router.refresh()}
        />
        <div className="ml-auto text-sm text-stone-600">
          <span className="font-medium">{checkStatus}</span>{" · "}
          Check {checkNumber}{" · "}
          <span className="text-stone-500">Subtotal {fmt(totals.grand)}</span>
        </div>
      </footer>

      {/* Modifier modal — fixed-overlay portal, independent of layout. */}
      {modifierLine && (
        <SeatModifierModal
          line={modifierLine}
          pending={pending}
          onSave={saveModifier}
          onCancel={() => setModifierLine(null)}
        />
      )}
    </div>
  );
}

// -----------------------------------------------------------------
// SeatStrip — shape-aware seat buttons around a small table icon.
// -----------------------------------------------------------------
function SeatStrip({
  capacity, shape, label, seats, tableLines, activeSeat, onSelect,
}: {
  capacity: number;
  shape: "ROUND" | "SQUARE" | "RECTANGLE";
  label: string;
  seats: Seat[];
  tableLines: TableLine[];
  activeSeat: number | "TABLE" | null;
  onSelect: (n: number | "TABLE") => void;
}) {
  // Positions around a 300x180 logical canvas centered on the table.
  // For each shape we place seats at "natural" sit-down points.
  const W = 600;
  const H = shape === "RECTANGLE" ? 220 : 320;
  const cx = W / 2;
  const cy = H / 2;
  const tableW = shape === "RECTANGLE" ? 280 : 140;
  const tableH = shape === "RECTANGLE" ? 90 : 140;

  const positions: Array<{ x: number; y: number; seat: number }> = [];
  if (shape === "ROUND") {
    const rx = tableW / 2 + 40;
    const ry = tableH / 2 + 40;
    for (let i = 0; i < capacity; i++) {
      const angle = (i / capacity) * 2 * Math.PI - Math.PI / 2;
      positions.push({ x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry, seat: i + 1 });
    }
  } else if (shape === "SQUARE") {
    // One per side; remaining seats double up at the next side.
    const slots: Array<{ x: number; y: number }> = [
      { x: cx,           y: cy - tableH / 2 - 30 }, // top
      { x: cx + tableW / 2 + 30, y: cy },           // right
      { x: cx,           y: cy + tableH / 2 + 30 }, // bottom
      { x: cx - tableW / 2 - 30, y: cy },           // left
      { x: cx - 35,      y: cy - tableH / 2 - 30 }, // top-left extra
      { x: cx + 35,      y: cy - tableH / 2 - 30 },
      { x: cx - 35,      y: cy + tableH / 2 + 30 },
      { x: cx + 35,      y: cy + tableH / 2 + 30 },
    ];
    for (let i = 0; i < capacity && i < slots.length; i++) {
      positions.push({ x: slots[i].x, y: slots[i].y, seat: i + 1 });
    }
  } else {
    // RECTANGLE: long edges (top + bottom) seat most parties; ends each get one.
    const long = Math.max(1, Math.ceil((capacity - 2) / 2));
    let s = 1;
    for (let i = 0; i < long && s <= capacity; i++) {
      positions.push({ x: cx - tableW / 2 + (tableW / (long + 1)) * (i + 1), y: cy - tableH / 2 - 30, seat: s++ });
    }
    for (let i = 0; i < long && s <= capacity; i++) {
      positions.push({ x: cx - tableW / 2 + (tableW / (long + 1)) * (i + 1), y: cy + tableH / 2 + 30, seat: s++ });
    }
    if (s <= capacity) { positions.push({ x: cx + tableW / 2 + 30, y: cy, seat: s++ }); }
    if (s <= capacity) { positions.push({ x: cx - tableW / 2 - 30, y: cy, seat: s++ }); }
  }

  const seatBySeatNumber = new Map(seats.map((s) => [s.seatNumber, s]));

  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-stone-500 mb-2">{tableLabel(label, capacity)}</div>
      {/* Capped width + max-height so the seat strip can't push the
          active-seat card below the fold on large screens. The viewBox
          preserves the aspect ratio inside the cap. */}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        className="block mx-auto w-full h-auto"
        style={{ maxWidth: 520, maxHeight: 280 }}
        role="group"
        aria-label="Seat selector"
      >
        {/* Table shape */}
        {shape === "ROUND" ? (
          <ellipse cx={cx} cy={cy} rx={tableW / 2} ry={tableH / 2} fill="#f3ede0" stroke="#bba47c" strokeWidth={2} />
        ) : (
          <rect x={cx - tableW / 2} y={cy - tableH / 2} width={tableW} height={tableH} rx={shape === "RECTANGLE" ? 10 : 6} fill="#f3ede0" stroke="#bba47c" strokeWidth={2} />
        )}
        <text x={cx} y={cy + 4} textAnchor="middle" fontFamily="serif" fontSize={14} fill="#7d6d4f">{label}</text>

        {positions.map(({ x, y, seat }) => {
          const ss = seatBySeatNumber.get(seat);
          const itemCount = ss?.items.length ?? 0;
          const isActive = activeSeat === seat;
          const a = ss?.assignment;
          const hasMember = !!a?.memberId;
          const hasGuest = !a?.memberId && !!a?.guestName;
          const colour = hasMember ? "#1e4f8f" : hasGuest ? "#7d6d4f" : itemCount > 0 ? "#1e4f8f" : "#8a7c63";
          const nameLabel = a?.memberDisplay
            ? shortName(a.memberDisplay)
            : a?.guestName
              ? (a.guestName === "Guest" ? "Guest" : shortName(a.guestName) + " (guest)")
              : "Unassigned";
          return (
            <g key={seat} onClick={() => onSelect(seat)} style={{ cursor: "pointer" }} role="button" aria-label={`Seat ${seat}, ${nameLabel}, ${itemCount} items`}>
              <circle cx={x} cy={y} r={26}
                fill={isActive ? "#111" : "#fff"} stroke={isActive ? "#111" : colour} strokeWidth={isActive ? 3 : 2} />
              <text x={x} y={y + 3} textAnchor="middle" fontSize={13} fontWeight={600} fill={isActive ? "#fff" : colour}>{seat}</text>
              {a?.isPrimary && (
                <text x={x} y={y - 30} textAnchor="middle" fontSize={9} fontWeight={700} fill="#1e4f8f">HOST</text>
              )}
              <text x={x} y={y + 42} textAnchor="middle" fontSize={11} fill="#3f3c39">{nameLabel}</text>
              {itemCount > 0 && (
                <g>
                  <circle cx={x + 18} cy={y - 18} r={10} fill="#f59e0b" stroke="#fff" strokeWidth={2} />
                  <text x={x + 18} y={y - 14} textAnchor="middle" fontSize={11} fontWeight={700} fill="#fff">{itemCount}</text>
                </g>
              )}
            </g>
          );
        })}
      </svg>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button onClick={() => onSelect("TABLE")}
          className={`rounded-md border px-3 py-1 text-xs ${activeSeat === "TABLE" ? "border-stone-900 bg-stone-900 text-white" : "border-stone-300 bg-white text-stone-700"}`}>
          Table {tableLines.length > 0 ? `(${tableLines.length})` : ""}
        </button>
        <span className="text-xs text-stone-500">Pick a seat, then tap a menu item on the right to add it.</span>
      </div>
    </div>
  );
}
function tableLabel(label: string, capacity: number) { return `${label} · seats ${capacity}`; }
function shortName(s: string): string {
  // "Owen Beauchamp" → "Owen B." for the tight seat label
  const parts = s.trim().split(/\s+/);
  if (parts.length < 2) return parts[0] ?? s;
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

// -----------------------------------------------------------------
// SeatAssignmentRow — inline UX for assigning a member or marking a
// seat as a guest. Shows the current assignment at the top + two
// short forms below: member-number lookup, or guest-name capture.
// The primary seat is locked (server can't clear it from here).
// -----------------------------------------------------------------
function SeatAssignmentRow({
  checkId, seat, members, onChanged,
}: {
  checkId: string;
  seat: Seat | null;
  members: Member[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"member" | "guest">("member");
  const [memberNumber, setMemberNumber] = useState("");
  const [guestName, setGuestName] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Reset the popup state every time the server selects a different
  // seat — otherwise switching from Seat 1 (locked HOST) to Seat 2
  // could leave stale `open`/`memberNumber` from a previous attempt.
  // Auto-open the popup when the newly selected seat is non-primary
  // and currently unassigned, so the server can type a member number
  // and press Enter without hunting for the "Assign" button.
  const lastSeatRef = useRef<number | null>(null);
  useEffect(() => {
    if (seat && lastSeatRef.current !== seat.seatNumber) {
      lastSeatRef.current = seat.seatNumber;
      setMemberNumber("");
      setGuestName("");
      setError(null);
      setMode("member");
      const unassigned = !seat.assignment.memberId && !seat.assignment.guestName;
      const canAssign = !seat.assignment.isPrimary;
      setOpen(unassigned && canAssign);
    }
  }, [seat?.seatNumber, seat?.assignment.memberId, seat?.assignment.guestName, seat?.assignment.isPrimary]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!seat) return null;
  const a = seat.assignment;
  const isPrimary = a.isPrimary;
  // Live preview of the typed member number → confirms the right
  // person before submit. Parity with the floor seating form.
  // Step 16 — normalize so a staff member who types "SS-1310" still
  // sees the matched live preview against canonical 4-digit storage.
  const normalizedInput = memberNumber.trim().replace(/^[A-Za-z]+-/, "");
  const matched = members.find(
    (m) => m.memberNumber.replace(/^[A-Za-z]+-/, "") === normalizedInput,
  );

  function runMember() {
    setError(null);
    const t = memberNumber.trim();
    if (!t) { setError("Enter a member number."); return; }
    startTransition(async () => {
      const r = await assignSeatAction(checkId, { seatNumber: seat!.seatNumber, memberNumber: t, guestName: null });
      if (!r.ok) { setError(r.error); return; }
      setOpen(false); setMemberNumber(""); onChanged();
    });
  }
  function runGuest() {
    setError(null);
    startTransition(async () => {
      const r = await assignSeatAction(checkId, { seatNumber: seat!.seatNumber, memberId: null, memberNumber: null, guestName: guestName.trim() || "Guest" });
      if (!r.ok) { setError(r.error); return; }
      setOpen(false); setGuestName(""); onChanged();
    });
  }
  function clear() {
    setError(null);
    startTransition(async () => {
      const r = await assignSeatAction(checkId, { seatNumber: seat!.seatNumber, memberId: null, memberNumber: null, guestName: null });
      if (!r.ok) { setError(r.error); return; }
      setOpen(false); onChanged();
    });
  }

  return (
    <div className="mt-3 rounded-md border border-stone-200 bg-stone-50 p-3 text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-stone-500">Diner at this seat</div>
          <div className="mt-0.5 text-sm text-stone-800">
            {a.memberDisplay ? (
              <>
                {a.memberDisplay}
                {a.memberNumber && <span className="ml-1 text-stone-500">· {a.memberNumber}</span>}
                {isPrimary && (
                  <span className="ml-2 inline-flex rounded border border-blue-300 bg-blue-50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-blue-800">Host</span>
                )}
              </>
            ) : a.guestName ? (
              <>
                {a.guestName} <span className="ml-1 text-stone-500">(guest)</span>
              </>
            ) : (
              <span className="text-stone-500">Unassigned</span>
            )}
          </div>
        </div>
        {!isPrimary && (
          <button onClick={() => setOpen((v) => !v)} className="text-club-green-700 hover:underline">
            {open ? "Close" : a.memberId || a.guestName ? "Change" : "Assign"}
          </button>
        )}
      </div>

      {open && !isPrimary && (
        <div className="mt-3 space-y-2">
          <div className="flex gap-1.5">
            <button onClick={() => setMode("member")} className={`rounded-md border px-2 py-1 text-[11px] ${mode === "member" ? "border-stone-900 bg-stone-900 text-white" : "border-stone-300 bg-white text-stone-700"}`}>
              Member
            </button>
            <button onClick={() => setMode("guest")} className={`rounded-md border px-2 py-1 text-[11px] ${mode === "guest" ? "border-stone-900 bg-stone-900 text-white" : "border-stone-300 bg-white text-stone-700"}`}>
              Guest
            </button>
            {(a.memberId || a.guestName) && (
              <button onClick={clear} disabled={pending} className="ml-auto text-[11px] text-stone-500 hover:underline">Clear seat</button>
            )}
          </div>

          {error && <div className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-red-700">{error}</div>}

          {mode === "member" ? (
            <form
              onSubmit={(e) => { e.preventDefault(); runMember(); }}
              className="space-y-1"
            >
              <label className="block text-[10px] uppercase tracking-wide text-stone-500">Member number</label>
              <input
                list={`seat-${seat.seatNumber}-members`}
                type="text"
                inputMode="numeric"
                maxLength={20}
                autoFocus
                value={memberNumber}
                onChange={(e) => setMemberNumber(e.target.value)}
                placeholder="1310"
                aria-label="Member number"
                className="input text-xs w-full"
              />
              <div className="text-[10px] text-stone-500">Enter the 4-digit member number.</div>
              <datalist id={`seat-${seat.seatNumber}-members`}>
                {members.map((m) => (
                  <option key={m.id} value={m.memberNumber}>{m.lastName}, {m.firstName}</option>
                ))}
              </datalist>
              {matched && (
                <div className="text-[10px] text-stone-500">→ {matched.firstName} {matched.lastName}</div>
              )}
              <button
                type="submit"
                disabled={pending || !memberNumber.trim()}
                className="btn btn-primary btn-sm w-full"
              >
                {pending ? "Saving…" : "Assign member"}
              </button>
              <p className="text-[10px] text-stone-500">Press Enter to assign.</p>
            </form>
          ) : (
            <form
              onSubmit={(e) => { e.preventDefault(); runGuest(); }}
              className="space-y-1"
            >
              <label className="block text-[10px] uppercase tracking-wide text-stone-500">Guest name (optional)</label>
              <input
                type="text"
                maxLength={120}
                autoFocus
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
                placeholder="Smith party, or leave blank for &quot;Guest&quot;"
                className="input text-xs w-full"
              />
              <button
                type="submit"
                disabled={pending}
                className="btn btn-primary btn-sm w-full"
              >
                {pending ? "Saving…" : "Mark as guest"}
              </button>
              <p className="text-[10px] text-stone-500">Press Enter to confirm.</p>
            </form>
          )}
        </div>
      )}

      {isPrimary && (
        <p className="mt-2 text-[10px] text-stone-500">
          Seat 1 holds the primary member set at seating. Mark the table departed to close the check.
        </p>
      )}
    </div>
  );
}

// -----------------------------------------------------------------
// SeatOrderList
// -----------------------------------------------------------------
function SeatOrderList({
  activeSeat, seats, tableLines, pending, onRemove, onModify,
}: {
  activeSeat: number | "TABLE";
  seats: Seat[];
  tableLines: TableLine[];
  pending: boolean;
  // Remove handler is wired to removeSeatLineAction. The service
  // refuses anything but DRAFT lines; the UI mirrors that by only
  // rendering the × on DRAFT rows.
  onRemove: (checkLineId: string) => void;
  // Modify handler opens the modifier modal for a DRAFT line. Sent
  // lines are immutable so the button is suppressed for non-DRAFT.
  onModify: (line: SeatItem | TableLine) => void;
}) {
  const items: Array<SeatItem | TableLine> =
    activeSeat === "TABLE"
      ? tableLines
      : seats.find((s) => s.seatNumber === activeSeat)?.items ?? [];
  // Subtotal = sum of lineTotal (base × qty + modifier delta × qty).
  const subtotal = items.reduce((sum, l) => sum + lineTotal(l), 0);
  if (items.length === 0) {
    return <div className="mt-2 text-sm text-stone-500">No items on this seat yet.</div>;
  }
  return (
    <div className="mt-2">
      <ul className="divide-y divide-stone-100">
        {items.map((l) => {
          const modDelta = lineModifierTotal(l);
          const base = l.quantity * l.unitPrice;
          const total = base + modDelta;
          const structuredMods = l.modifiers.filter(
            (m) => m.modifierType !== "ALLERGY" && m.modifierType !== "NOTE",
          );
          const allergyMods = l.modifiers.filter((m) => m.modifierType === "ALLERGY");
          const noteMod = l.modifiers.find((m) => m.modifierType === "NOTE");
          return (
            <li key={l.id} className="py-2 text-sm">
              <div className="flex items-baseline gap-2">
                <span className="tabular-nums">{l.quantity}</span>
                <span className="flex-1 text-stone-800">{l.description}</span>
                <span className={`text-[10px] rounded-full border px-1.5 py-0.5 ${statusChip(l.status)}`}>{l.status}</span>
                <span className="tabular-nums text-stone-700">{fmt(total)}</span>
                {l.status === "DRAFT" && l.menuItemId ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => onModify(l)}
                    className="ml-1 inline-flex items-center rounded-md border border-stone-300 px-2 py-1 text-xs text-stone-700 hover:border-stone-500 disabled:opacity-50"
                    aria-label={`Modify ${l.description}`}
                  >
                    Modify
                  </button>
                ) : (
                  <span aria-hidden="true" className="ml-1 inline-block h-7 w-[60px]" />
                )}
                {l.status === "DRAFT" ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => onRemove(l.id)}
                    aria-label={`Remove ${l.description}`}
                    className="ml-1 inline-flex h-7 w-7 items-center justify-center rounded-md border border-stone-300 text-stone-500 hover:border-red-400 hover:text-red-700 disabled:opacity-50"
                  >
                    ×
                  </button>
                ) : (
                  // Sent / fired / ready / served lines can no longer be
                  // removed — keep the slot so the row stays aligned with
                  // DRAFT siblings above.
                  <span aria-hidden="true" className="ml-1 inline-block h-7 w-7" />
                )}
              </div>
              {/* Per-line modifier summary. Structured modifiers are
                  rendered as small chips so the server can see the
                  list at a glance; allergies use a red block; free-
                  text notes are italicised below. */}
              {structuredMods.length > 0 && (
                <ul className="mt-1 pl-6 flex flex-wrap gap-1 text-[11px]">
                  {structuredMods.map((m) => (
                    <li key={m.id} className="inline-flex items-center rounded-md border border-stone-300 bg-white px-1.5 py-0.5 text-stone-700">
                      {m.printLabel || m.label}
                      {m.priceDelta !== 0 && (
                        <span className="ml-1 tabular-nums text-stone-500">
                          {m.priceDelta > 0 ? "+" : ""}{fmt(m.priceDelta)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {allergyMods.length > 0 && (
                <div className="mt-1 ml-6 rounded-md border-2 border-red-400 bg-red-50 px-2 py-1 text-[11px] font-medium text-red-800">
                  <span className="uppercase tracking-wide">Allergy:</span>{" "}
                  {allergyMods.map((m) => m.label).join(", ")}
                </div>
              )}
              {noteMod && (
                <div className="mt-1 ml-6 text-[11px] text-stone-600 italic">
                  Note: {noteMod.label}
                </div>
              )}
              {modDelta !== 0 && (
                <div className="mt-0.5 pl-6 text-[11px] text-stone-500">
                  Base {fmt(base)} · Modifiers {modDelta > 0 ? "+" : ""}{fmt(modDelta)}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-2 flex items-baseline justify-between text-sm">
        <span className="text-xs text-stone-500">Subtotal</span>
        <span className="font-medium tabular-nums">{fmt(subtotal)}</span>
      </div>
    </div>
  );
}
function statusChip(s: string): string {
  if (s === "DRAFT") return "border-stone-300 bg-stone-50 text-stone-600";
  if (s === "SENT" || s === "FIRED" || s === "PREPARING") return "border-blue-300 bg-blue-50 text-blue-700";
  if (s === "READY") return "border-amber-300 bg-amber-50 text-amber-800";
  if (s === "SERVED") return "border-club-green-300 bg-club-green-50 text-club-green-800";
  return "border-stone-300 bg-stone-50 text-stone-600";
}

// -----------------------------------------------------------------
// SplitSettleButton — opens a modal that groups seats and settles each.
// -----------------------------------------------------------------
function SplitSettleButton({
  checkId, seats, tableLines, members, defaultMemberId, disabled, onChanged,
}: {
  checkId: string;
  seats: Seat[];
  tableLines: TableLine[];
  members: Member[];
  defaultMemberId: string | null;
  disabled: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Per-group settle outcome — populated after a successful settle so
  // the modal flips from "build groups" to "settle complete" with the
  // per-group email status visible before the server clicks Done.
  const [settled, setSettled] = useState<Array<{
    label: string;
    grandTotal: number;
    receiptEmailStatus: string | null;
    receiptEmailAddress: string | null;
    receiptEmailFailure: string | null;
  }> | null>(null);

  const seatsWithItems = seats.filter((s) => s.items.length > 0);
  type GroupSpec = {
    label: string;
    seatNumbers: number[];
    paymentMethod: "MEMBER_ACCOUNT" | "QR_PAY";
    memberId: string | null;
  };
  const [groups, setGroups] = useState<GroupSpec[]>([]);

  // Step 19 — QR payment pending state. While `qr` is non-null the
  // modal shows the QR/payment-link panel and polls for status. Goes
  // back to null on cancel / decline / expire so the server can retry
  // or pick a different method.
  const [qr, setQr] = useState<{
    paymentId: string;
    paymentUrl: string;
    amount: number;
    status: string;
    simulationEnabled: boolean;
    failureReason: string | null;
  } | null>(null);

  function init() {
    // Default split: each seat its own group; if a default member is on
    // the check, all groups bill to them (host can edit before settling).
    setGroups(
      seatsWithItems.map((s) => ({
        label: `Seat ${s.seatNumber}`,
        seatNumbers: [s.seatNumber],
        paymentMethod: "MEMBER_ACCOUNT" as const,
        memberId: defaultMemberId,
      })),
    );
    setError(null);
    setSettled(null);
    setQr(null);
    setOpen(true);
  }

  function moveSeatToGroup(seat: number, targetIdx: number) {
    setGroups((prev) => {
      const next = prev.map((g) => ({ ...g, seatNumbers: g.seatNumbers.filter((s) => s !== seat) }));
      next[targetIdx] = { ...next[targetIdx], seatNumbers: [...next[targetIdx].seatNumbers, seat].sort((a, b) => a - b) };
      return next.filter((g) => g.seatNumbers.length > 0);
    });
  }
  function newGroup() {
    setGroups((prev) => [...prev, { label: `Group ${String.fromCharCode(65 + prev.length)}`, seatNumbers: [], paymentMethod: "MEMBER_ACCOUNT" as const, memberId: defaultMemberId }]);
  }
  function mergeWithFirst() {
    setGroups((prev) => prev.length === 0 ? prev : [{
      label: "All seats",
      seatNumbers: prev.flatMap((g) => g.seatNumbers).sort((a, b) => a - b),
      paymentMethod: "MEMBER_ACCOUNT" as const,
      memberId: prev[0]?.memberId ?? defaultMemberId,
    }]);
  }

  // Step 19 — charge-account-disabled helper. Reads accessStatus from
  // the member payload pulled in page.tsx. Suspended members can't
  // post to MEMBER_ACCOUNT and must use Pay by QR Code.
  function chargeAccountDisabledFor(memberId: string | null): boolean {
    if (!memberId) return false;
    const m = members.find((x) => x.id === memberId);
    if (!m) return false;
    return m.accessStatus === "CHARGE_ACCOUNT_SUSPENDED" || m.accessStatus === "FULL_SUSPENSION";
  }

  function totalForGroup(g: { seatNumbers: number[] }): number {
    const sub = g.seatNumbers.reduce((sum, n) => sum + (seats.find((s) => s.seatNumber === n)?.subtotal ?? 0), 0);
    return sub * 1.05; // GST 5%
  }

  function runSettle() {
    setError(null);
    startTransition(async () => {
      const r = await settleBySeatsAction(checkId, {
        groups: groups
          .filter((g) => g.seatNumbers.length > 0)
          .map((g) => ({
            label: g.label,
            seatNumbers: g.seatNumbers,
            paymentMethod: g.paymentMethod,
            memberId: g.memberId,
          })),
        allowUnsentLines: true,
      });
      if (!r.ok) { setError(r.error); return; }
      // Flip the modal to the result panel so the server sees the
      // per-group email status before dismissing.
      setSettled(
        r.data.groups.map((g) => ({
          label: g.label,
          grandTotal: g.grandTotal,
          receiptEmailStatus: g.receiptEmailStatus ?? null,
          receiptEmailAddress: g.receiptEmailAddress ?? null,
          receiptEmailFailure: g.receiptEmailFailure ?? null,
        })),
      );
      // Refresh the parent so the seat strip / closed-check links
      // reflect the new state; the modal itself stays open.
      onChanged();
    });
  }

  // Step 19 — Pay by QR Code. Only the merge-all single-group case is
  // supported in this slice; the button is hidden on per-group QR.
  // Initiates a POSQRPayment row, flips the modal into the pending
  // panel, and starts polling.
  function runStartQR() {
    setError(null);
    if (groups.length !== 1) {
      setError("Pay by QR Code requires merging all seats into one group.");
      return;
    }
    const g = groups[0];
    if (g.seatNumbers.length === 0) {
      setError("Add at least one seat to the group before paying by QR.");
      return;
    }
    startTransition(async () => {
      const r = await initiateQRPaymentAction({
        checkId,
        memberId: g.memberId,
      });
      if (!r.ok) { setError(r.error); return; }
      setQr({
        paymentId: r.data.paymentId,
        paymentUrl: r.data.paymentUrl,
        amount: r.data.amount,
        status: r.data.status,
        simulationEnabled: r.data.simulationEnabled,
        failureReason: null,
      });
    });
  }

  // Step 19 — poll the pending QR payment every 2s. On CONFIRMED we
  // flip into the existing settled panel; on a terminal-failure
  // state we surface the reason and let the server retry.
  useEffect(() => {
    if (!qr || qr.status === "CONFIRMED" || qr.status === "DECLINED" || qr.status === "EXPIRED" || qr.status === "CANCELLED") {
      return;
    }
    let cancelled = false;
    const tick = async () => {
      const r = await getQRPaymentStatusAction(qr.paymentId);
      if (cancelled) return;
      if (!r.ok) {
        setError(r.error);
        return;
      }
      if (r.data.status !== qr.status || r.data.failureReason !== qr.failureReason) {
        setQr((prev) => prev ? { ...prev, status: r.data.status, failureReason: r.data.failureReason } : prev);
      }
      if (r.data.status === "CONFIRMED") {
        // The settle path inside confirmQRPayment already fired the
        // receipt email and closed the check. Synthesize the same
        // "settled" panel rows the MEMBER_ACCOUNT path produces.
        setSettled([{
          label: "Pay by QR Code",
          grandTotal: qr.amount,
          receiptEmailStatus: null,
          receiptEmailAddress: null,
          receiptEmailFailure: null,
        }]);
        onChanged();
      }
    };
    // Fire first poll immediately, then every 2s until terminal.
    void tick();
    const id = setInterval(() => { void tick(); }, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, [qr?.paymentId, qr?.status, qr?.amount, qr?.failureReason, onChanged]);

  function cancelQR() {
    if (!qr) return;
    const paymentId = qr.paymentId;
    startTransition(async () => {
      await cancelQRPaymentAction(paymentId, "Server cancelled before confirmation");
      setQr(null);
      onChanged();
    });
  }

  function simulateQR(outcome: "CONFIRM" | "DECLINE" | "EXPIRE") {
    if (!qr) return;
    const paymentId = qr.paymentId;
    startTransition(async () => {
      const r = await simulateQRPaymentAction(paymentId, outcome);
      if (!r.ok) setError(r.error);
      // Status flip is observed by the polling effect — no local
      // update needed beyond letting the next tick fetch it.
    });
  }

  function dismissSettled() {
    setSettled(null);
    setOpen(false);
  }

  return (
    <>
      <button disabled={disabled || seatsWithItems.length === 0} onClick={init} className="btn btn-primary btn-sm">
        Split &amp; settle
      </button>
      {open && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={settled ? dismissSettled : () => setOpen(false)}>
          <div className="bg-white rounded-lg max-w-3xl w-full p-5 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="font-serif text-xl">{settled ? "Settled" : "Split & settle"}</h2>
              <button onClick={settled ? dismissSettled : () => setOpen(false)} className="text-stone-400 hover:text-stone-700" aria-label="Close">✕</button>
            </div>
            {/* RESULT panel — shown after settle completes. Each group
                row carries its email outcome so the server knows
                immediately who got an email and who didn't. */}
            {settled && (
              <div className="mt-3 space-y-3">
                <p className="text-xs text-stone-500">
                  Check is closed. Per-group totals and receipt-email status are below — failed/skipped emails can be resent from the closed-checks page.
                </p>
                <ul className="space-y-2">
                  {settled.map((g, i) => {
                    const tone =
                      g.receiptEmailStatus === "SENT" ? "text-club-green-700" :
                      g.receiptEmailStatus === "DEV_LOGGED" ? "text-amber-700" :
                      g.receiptEmailStatus === "FAILED" || g.receiptEmailStatus === "SUPPRESSED" ? "text-red-700" :
                      "text-stone-600";
                    const emailLabel =
                      g.receiptEmailStatus === "SENT" ? "Sent" :
                      g.receiptEmailStatus === "DEV_LOGGED" ? "Dev-logged" :
                      g.receiptEmailStatus === "FAILED" ? "Failed" :
                      g.receiptEmailStatus === "SUPPRESSED" ? "Suppressed" :
                      g.receiptEmailStatus === "SKIPPED_NO_EMAIL" ? "No email on file" :
                      g.receiptEmailStatus ?? "—";
                    return (
                      <li key={i} className="rounded-md border border-stone-200 px-3 py-2 text-sm">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-medium">{g.label}</span>
                          <span className="tabular-nums text-stone-700">{fmt(g.grandTotal)}</span>
                        </div>
                        <div className="mt-1 flex items-baseline justify-between text-xs">
                          <span className={tone}>Receipt email: {emailLabel}</span>
                          {g.receiptEmailAddress && (
                            <span className="text-stone-500">{maskInline(g.receiptEmailAddress)}</span>
                          )}
                        </div>
                        {g.receiptEmailFailure && (
                          <div className="mt-1 text-[11px] text-red-700">{g.receiptEmailFailure}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <div className="flex justify-end">
                  <button onClick={dismissSettled} className="btn btn-primary btn-sm">Done</button>
                </div>
              </div>
            )}

            {/* Step 19 — Pay by QR Code pending panel.
                Shown while a POSQRPayment is open (QR_ISSUED / PENDING).
                Folds back into the picker on cancel / decline / expire so
                the server can retry or pick a different method. */}
            {!settled && qr && qr.status !== "CONFIRMED" && (
              <div className="mt-3 space-y-3">
                <div className="rounded-md border border-stone-300 bg-stone-50 p-4 text-sm">
                  <div className="text-xs uppercase tracking-wide text-stone-500">Pay by QR Code</div>
                  <div className="mt-1 text-stone-900 tabular-nums">{fmt(qr.amount)}</div>
                  <div className="mt-3 flex items-center gap-4">
                    {/* Lightweight QR-style block. Real processor swap-in
                        replaces this with a hosted-checkout iframe / QR. */}
                    <div className="flex h-28 w-28 items-center justify-center rounded-md border-2 border-stone-900 bg-white text-[10px] text-stone-700">
                      QR&nbsp;CODE
                    </div>
                    <div className="text-xs">
                      <div className="text-stone-700">
                        Scan or open the link:
                      </div>
                      <a href={qr.paymentUrl} target="_blank" rel="noreferrer" className="break-all text-club-green-700 hover:underline">
                        {qr.paymentUrl}
                      </a>
                    </div>
                  </div>
                  <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-stone-300 bg-white px-2.5 py-0.5 text-[11px]">
                    <span className={`inline-block h-2 w-2 rounded-full ${qr.status === "QR_ISSUED" || qr.status === "PENDING" || qr.status === "CREATED" ? "bg-amber-500" : qr.status === "DECLINED" || qr.status === "EXPIRED" || qr.status === "CANCELLED" ? "bg-red-500" : "bg-club-green-600"}`} aria-hidden="true" />
                    <span className="uppercase tracking-wide text-stone-700">
                      {qr.status === "QR_ISSUED" || qr.status === "PENDING" || qr.status === "CREATED"
                        ? "Waiting for payment"
                        : qr.status === "DECLINED" ? "Declined"
                        : qr.status === "EXPIRED" ? "Expired"
                        : qr.status === "CANCELLED" ? "Cancelled"
                        : qr.status}
                    </span>
                  </div>
                  {qr.failureReason && (
                    <div className="mt-2 text-[11px] text-red-700">{qr.failureReason}</div>
                  )}
                  {/* DEV ONLY simulation controls — hidden in production. */}
                  {qr.simulationEnabled && (
                    <div className="mt-4 border-t border-stone-200 pt-3">
                      <div className="text-[10px] uppercase tracking-wide text-amber-700">Development only — simulate outcome</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button onClick={() => simulateQR("CONFIRM")} disabled={pending} className="btn btn-primary btn-sm">Simulate confirmed</button>
                        <button onClick={() => simulateQR("DECLINE")} disabled={pending} className="btn btn-secondary btn-sm">Simulate declined</button>
                        <button onClick={() => simulateQR("EXPIRE")} disabled={pending} className="btn btn-secondary btn-sm">Simulate expired</button>
                      </div>
                    </div>
                  )}
                </div>
                {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
                <div className="flex flex-wrap justify-end gap-2">
                  {(qr.status === "DECLINED" || qr.status === "EXPIRED" || qr.status === "CANCELLED") ? (
                    <button onClick={() => setQr(null)} disabled={pending} className="btn btn-primary btn-sm">
                      Back to payment methods
                    </button>
                  ) : (
                    <button onClick={cancelQR} disabled={pending} className="btn btn-secondary btn-sm">
                      Cancel QR payment
                    </button>
                  )}
                </div>
              </div>
            )}

            {!settled && !qr && (
              <>
                <p className="mt-1 text-xs text-stone-500">
                  Each group settles to one member account. Seats start as their own group; tap a seat to move it.
                </p>

            {error && <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              <button onClick={newGroup} className="btn btn-secondary btn-sm">+ New group</button>
              <button onClick={mergeWithFirst} className="btn btn-secondary btn-sm">Merge all into one</button>
            </div>

            <div className="mt-4 space-y-3">
              {groups.map((g, idx) => {
                // Step 19 — flag if the picked member's charge account
                // is disabled. MEMBER_ACCOUNT settle is gated server-side
                // by the same accessStatus check; surface the reason
                // here so the server picks Pay by QR Code instead.
                const chargeDisabled = chargeAccountDisabledFor(g.memberId);
                return (
                <div key={idx} className="rounded-md border border-stone-200 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      className="input text-xs w-40"
                      value={g.label}
                      onChange={(e) => setGroups((prev) => prev.map((x, i) => i === idx ? { ...x, label: e.target.value } : x))}
                    />
                    <select
                      className="input text-xs"
                      value={g.memberId ?? ""}
                      onChange={(e) => setGroups((prev) => prev.map((x, i) => i === idx ? { ...x, memberId: e.target.value || null } : x))}
                    >
                      <option value="">— pick a member to bill —</option>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>{m.lastName}, {m.firstName} · {m.memberNumber}</option>
                      ))}
                    </select>
                    <span className="ml-auto text-sm tabular-nums">
                      {fmt(totalForGroup(g))} <span className="text-xs text-stone-500">(incl. GST)</span>
                    </span>
                  </div>
                  {chargeDisabled && (
                    <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                      Charge account disabled. Merge all seats and use Pay by QR Code.
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {seatsWithItems.map((s) => {
                      const inThis = g.seatNumbers.includes(s.seatNumber);
                      return (
                        <button
                          key={s.seatNumber}
                          onClick={() => inThis ? null : moveSeatToGroup(s.seatNumber, idx)}
                          disabled={inThis}
                          className={`rounded-md border px-2 py-1 text-xs ${inThis ? "border-stone-900 bg-stone-900 text-white" : "border-stone-300 bg-white text-stone-700 hover:border-stone-500"}`}
                        >
                          Seat {s.seatNumber}{" "}
                          <span className={inThis ? "text-stone-300" : "text-stone-500"}>{fmt(s.subtotal)}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                );
              })}
            </div>

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button onClick={() => setOpen(false)} disabled={pending} className="btn btn-secondary btn-sm">Cancel</button>
              {/* Step 19 — Pay by QR Code. Whole-check only for this
                  slice: requires the groups to be merged into one. */}
              {groups.length === 1 && groups[0].seatNumbers.length > 0 && (
                <button
                  onClick={runStartQR}
                  disabled={pending}
                  className="btn btn-secondary btn-sm"
                  title={
                    chargeAccountDisabledFor(groups[0].memberId)
                      ? "Required: this member's charge account is disabled."
                      : "Show a QR code so the member can pay from their phone."
                  }
                >
                  Pay by QR Code
                </button>
              )}
              <button
                onClick={runSettle}
                disabled={
                  pending ||
                  groups.every((g) => g.seatNumbers.length === 0) ||
                  // Block Settle on any MEMBER_ACCOUNT group whose
                  // chosen member has a suspended charge account.
                  groups.some((g) => g.paymentMethod === "MEMBER_ACCOUNT" && chargeAccountDisabledFor(g.memberId))
                }
                className="btn btn-primary btn-sm"
              >
                {pending ? "Settling…" : "Settle all groups"}
              </button>
            </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// Mask "owen@example.com" → "o***@example.com" for the success panel.
// Kept local so the modal doesn't reach back into the receipts service.
function maskInline(email: string): string {
  const [name, host] = email.split("@");
  if (!host) return email;
  return `${name.slice(0, 1)}${"*".repeat(Math.max(2, name.length - 1))}@${host}`;
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

// -----------------------------------------------------------------
// SeatModifierModal — touch-friendly modifier picker for one DRAFT line.
//
// Loads the per-item catalog from listSeatLineModifiersAction, lets
// the server toggle remove/add chips, single-select substitute chips
// per group, multi-select allergens, and type a free-text note. Saves
// the whole set via setSeatLineModifiersAction (parent provides
// `onSave`). Sent / voided / closed lines never reach this modal —
// the parent gates the Modify button on DRAFT status.
// -----------------------------------------------------------------
type CatalogOption = { id: string; label: string; printLabel: string | null; priceDelta: number };
type CatalogGroup = { id: string; label: string; modifierType: "REMOVE" | "ADD" | "SUBSTITUTE"; options: CatalogOption[] };

function SeatModifierModal({
  line, pending, onSave, onCancel,
}: {
  line: SeatItem | TableLine;
  pending: boolean;
  onSave: (
    mods: Array<{
      optionId: string | null;
      modifierType: "REMOVE" | "ADD" | "SUBSTITUTE" | "ALLERGY" | "NOTE";
      label: string;
      printLabel: string | null;
      priceDelta: number;
    }>,
  ) => void;
  onCancel: () => void;
}) {
  const [catalog, setCatalog] = useState<CatalogGroup[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Hydrate from the line's current modifier set so reopening the
  // modal shows what's already applied.
  const [selectedOptions, setSelectedOptions] = useState<Set<string>>(
    () => new Set(line.modifiers.filter((m) => m.optionId).map((m) => m.optionId as string)),
  );
  const [selectedAllergens, setSelectedAllergens] = useState<Set<string>>(() => {
    const known = new Set<string>();
    for (const m of line.modifiers) {
      if (m.modifierType !== "ALLERGY") continue;
      known.add(m.label);
    }
    return known;
  });
  const initialNote = line.modifiers.find((m) => m.modifierType === "NOTE");
  const [noteText, setNoteText] = useState<string>(initialNote?.label ?? "");
  const [allergenCustom, setAllergenCustom] = useState<string>("");

  // The seat number is on SeatItem but not TableLine — guard the cast.
  const seatLabel =
    "seatNumber" in line && line.seatNumber != null
      ? `Seat ${line.seatNumber}`
      : "Table";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!line.menuItemId) {
        setCatalog([]);
        return;
      }
      const r = await listSeatLineModifiersAction(line.menuItemId);
      if (cancelled) return;
      if (r.ok) {
        setCatalog(r.data as CatalogGroup[]);
      } else {
        setLoadError(r.error);
      }
    })();
    return () => { cancelled = true; };
  }, [line.menuItemId]);

  function toggleOption(o: CatalogOption) {
    setSelectedOptions((prev) => {
      const next = new Set(prev);
      if (next.has(o.id)) next.delete(o.id);
      else next.add(o.id);
      return next;
    });
  }
  // Substitute groups behave as single-select per group: picking one
  // clears whatever was selected in the same group.
  function pickSubstitute(group: CatalogGroup, o: CatalogOption | null) {
    setSelectedOptions((prev) => {
      const next = new Set(prev);
      for (const opt of group.options) next.delete(opt.id);
      if (o) next.add(o.id);
      return next;
    });
  }
  function toggleAllergen(name: string) {
    setSelectedAllergens((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }
  function addCustomAllergen() {
    const t = allergenCustom.trim();
    if (!t) return;
    setSelectedAllergens((prev) => new Set([...prev, t]));
    setAllergenCustom("");
  }

  const previewDelta = (() => {
    if (!catalog) return 0;
    let d = 0;
    for (const g of catalog) {
      for (const o of g.options) {
        if (selectedOptions.has(o.id)) d += o.priceDelta;
      }
    }
    return d;
  })();
  const qty = line.quantity;
  const previewLineTotal = qty * line.unitPrice + qty * previewDelta;

  const canSave = catalog !== null && !pending;
  const canSubmit =
    canSave &&
    // Allergy requires a non-empty label — chip selection or custom
    // text. Empty allergy submit is blocked at the service too.
    (selectedAllergens.size === 0 || Array.from(selectedAllergens).every((a) => a.trim().length > 0));

  function handleSave() {
    if (!catalog) return;
    const out: Array<{
      optionId: string | null;
      modifierType: "REMOVE" | "ADD" | "SUBSTITUTE" | "ALLERGY" | "NOTE";
      label: string;
      printLabel: string | null;
      priceDelta: number;
    }> = [];
    for (const g of catalog) {
      for (const o of g.options) {
        if (!selectedOptions.has(o.id)) continue;
        out.push({
          optionId: o.id,
          modifierType: g.modifierType,
          label: o.label,
          printLabel: o.printLabel ?? null,
          priceDelta: o.priceDelta,
        });
      }
    }
    for (const name of selectedAllergens) {
      out.push({
        optionId: null,
        modifierType: "ALLERGY",
        label: name,
        printLabel: null,
        priceDelta: 0,
      });
    }
    if (noteText.trim()) {
      out.push({
        optionId: null,
        modifierType: "NOTE",
        label: noteText.trim(),
        printLabel: null,
        priceDelta: 0,
      });
    }
    onSave(out);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 px-4"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="bg-white rounded-xl shadow-elevated w-full max-w-3xl p-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-stone-500">Modify item</div>
            <h2 className="mt-0.5 font-serif text-xl text-club-ink">{line.description}</h2>
            <div className="mt-0.5 text-xs text-stone-500">
              {seatLabel} · {qty} × {fmt(line.unitPrice)}
            </div>
          </div>
          <button onClick={onCancel} className="text-stone-400 hover:text-stone-700" aria-label="Close">✕</button>
        </div>

        {loadError && (
          <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</div>
        )}
        {catalog === null && !loadError && (
          <div className="mt-3 text-sm text-stone-500">Loading modifier options…</div>
        )}

        {catalog && catalog.length === 0 && (
          <div className="mt-3 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-600">
            No structured modifier options for this item — add an allergy note or free-text note below.
          </div>
        )}

        {/* Catalog groups — touch chips. SUBSTITUTE groups are single-
            select; REMOVE / ADD are multi-select. */}
        {catalog && catalog.length > 0 && (
          <div className="mt-4 space-y-4">
            {catalog.map((g) => (
              <section key={g.id}>
                <div className="text-[10px] uppercase tracking-wide text-stone-500">
                  {g.label} <span className="ml-1 text-stone-400">({g.modifierType})</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {g.modifierType === "SUBSTITUTE" && (
                    <button
                      type="button"
                      onClick={() => pickSubstitute(g, null)}
                      className={`rounded-md border px-3 py-1.5 text-xs ${g.options.every((o) => !selectedOptions.has(o.id)) ? "border-stone-900 bg-stone-900 text-white" : "border-stone-300 bg-white text-stone-700"}`}
                    >
                      None
                    </button>
                  )}
                  {g.options.map((o) => {
                    const active = selectedOptions.has(o.id);
                    return (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => (g.modifierType === "SUBSTITUTE" ? pickSubstitute(g, o) : toggleOption(o))}
                        className={`rounded-md border px-3 py-1.5 text-xs ${active ? "border-stone-900 bg-stone-900 text-white" : "border-stone-300 bg-white text-stone-700 hover:border-stone-500"}`}
                      >
                        {o.label}
                        {o.priceDelta !== 0 && (
                          <span className={`ml-1.5 tabular-nums ${active ? "text-stone-200" : "text-stone-500"}`}>
                            {o.priceDelta > 0 ? "+" : ""}{fmt(o.priceDelta)}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}

        {/* Allergens — multi-select chips + a free-text input for
            allergies that aren't on the chip list. The kitchen chit
            renders one red block per allergy, so multiple entries
            stay visible. */}
        <section className="mt-5">
          <div className="text-[10px] uppercase tracking-wide text-red-700">Allergies / important notes</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {COMMON_ALLERGENS.map((name) => {
              const active = selectedAllergens.has(name);
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => toggleAllergen(name)}
                  className={`rounded-md border px-3 py-1.5 text-xs ${active ? "border-red-600 bg-red-600 text-white" : "border-red-200 bg-red-50 text-red-800 hover:border-red-400"}`}
                >
                  {name}
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex gap-2">
            <input
              type="text"
              value={allergenCustom}
              onChange={(e) => setAllergenCustom(e.target.value)}
              placeholder="Other allergy (e.g. sesame oil)"
              maxLength={80}
              className="input text-xs flex-1"
              aria-label="Custom allergy"
            />
            <button
              type="button"
              onClick={addCustomAllergen}
              disabled={!allergenCustom.trim()}
              className="btn btn-secondary btn-sm"
            >
              Add allergy
            </button>
          </div>
          {selectedAllergens.size > 0 && (
            <div className="mt-2 flex flex-wrap gap-1 text-[11px]">
              {Array.from(selectedAllergens).map((n) => (
                <span key={n} className="inline-flex items-center gap-1 rounded-md border border-red-400 bg-red-50 px-2 py-0.5 text-red-800">
                  {n}
                  <button type="button" onClick={() => toggleAllergen(n)} className="text-red-600 hover:text-red-900" aria-label={`Remove allergy ${n}`}>×</button>
                </span>
              ))}
            </div>
          )}
        </section>

        {/* Free-text kitchen / bar note. */}
        <section className="mt-5">
          <label htmlFor="seat-mod-note" className="block text-[10px] uppercase tracking-wide text-stone-500">
            Kitchen / bar note (optional)
          </label>
          <textarea
            id="seat-mod-note"
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="e.g. Medium-rare, plate separately, allergy seated next to a child"
            maxLength={200}
            rows={2}
            className="input text-sm mt-1 w-full"
          />
        </section>

        {/* Running preview of price impact + line total. */}
        <div className="mt-5 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-700 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <span className="text-stone-500">Base</span>{" "}
            <span className="tabular-nums">{fmt(qty * line.unitPrice)}</span>
            <span className="mx-2 text-stone-400">·</span>
            <span className="text-stone-500">Modifiers</span>{" "}
            <span className="tabular-nums">
              {qty * previewDelta > 0 ? "+" : ""}{fmt(qty * previewDelta)}
            </span>
          </div>
          <div>
            <span className="text-stone-500">Line total</span>{" "}
            <span className="font-semibold tabular-nums text-club-ink">{fmt(previewLineTotal)}</span>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button onClick={onCancel} disabled={pending} className="btn btn-secondary btn-sm">Cancel</button>
          <button onClick={handleSave} disabled={!canSubmit} className="btn btn-primary btn-sm">
            {pending ? "Saving…" : "Save modifiers"}
          </button>
        </div>
      </div>
    </div>
  );
}
