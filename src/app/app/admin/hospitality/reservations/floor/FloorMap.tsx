"use client";

// Visual floor map for the hostess station — tabbed Excel-style.
//
// Only one dining area's SVG canvas is drawn at a time. A tab strip
// across the top mirrors Excel worksheet tabs: the active tab visually
// "owns" the canvas seam beneath it; inactive tabs sit behind. Counts
// (X seated / Y tables) are folded into the tab label so a hostess can
// see how busy each room is without switching.
//
// The whole component is sized to fit the visible viewport — never
// pushes the page below the fold under normal desktop or tablet use.
// The side panel is part of the same flex row so it doesn't introduce
// page scroll either; on smaller screens it overlays the canvas as a
// drawer instead.
//
// Tab selection persists in ?area=<id> so refresh / direct link works.

import { useEffect, useMemo, useState, useTransition, useRef } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import Link from "next/link";
import {
  setTableStatusAction,
  seatReservationAction,
  departReservationAction,
  openCheckAction,
  releaseTableAction,
} from "../_actions";
import { seatTableAction } from "@/app/app/admin/ops/pos/lounge/table/_actions";

// -----------------------------------------------------------------
// Types
// -----------------------------------------------------------------
export type FloorElement = {
  kind: "BAR" | "DIVIDER" | "LABEL";
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  label?: string;
};

export type FloorReservation = {
  id: string;
  status: string;
  startTimeIso: string;
  actualSeatedAtIso: string | null;
  partySize: number;
  memberName: string | null;
  guestName: string | null;
  linkedSpend: number;
  hasOpenCheck: boolean;
};

// Step 18 — unified seated-party context.
// A seated table always exposes the same shape regardless of whether
// the seating came from a reservation or from the floor-map self-
// seating path. The tile + side panel render from this; the original
// `liveReservation` is preserved so the panel can still offer the
// reservation-specific actions (Open reservation) when appropriate.
export type FloorSeatedParty = {
  source: "RESERVATION" | "POS_CHECK";
  hostName: string | null;
  partySize: number | null;
  seatedSinceIso: string;
  reservationId: string | null;
  checkId: string | null;
  // True when an unsettled check is still on this table. The side
  // panel uses this to disable Mark departed with a clear reason
  // rather than silently orphaning the check.
  checkIsActive: boolean;
};

export type FloorTable = {
  id: string;
  tableNumber: string;
  displayName: string | null;
  capacity: number;
  status: string;
  shape: "ROUND" | "SQUARE" | "RECTANGLE" | string;
  xPos: number | null;
  yPos: number | null;
  width: number;
  height: number;
  rotation: number;
  active: boolean;
  liveReservation: FloorReservation | null;
  upcomingReservation: FloorReservation | null;
  // Phase 18E — most recent non-closed POSCheck for this table.
  // Drives the "Open seat view" CTA on the side panel; present
  // whenever the table is SEATED (via reservation OR server-led
  // self-seating).
  openCheckId: string | null;
  openCheckNumber: string | null;
  // Step 18 — unified seated-party detail (host/party/elapsed) so
  // POS-seated tables show the same rich card as reservation-seated.
  seatedParty: FloorSeatedParty | null;
};

export type FloorArea = {
  id: string;
  name: string;
  description: string | null;
  canvasWidth: number;
  canvasHeight: number;
  floorElements: FloorElement[];
  tables: FloorTable[];
};

// Step 31 — double-click drilldown helper. Lives in a plain .ts
// file (src/lib/hospitality/floor-map-interactions.ts) so vitest
// can unit-test the predicate without parsing the TSX tree.
import { canOpenSeatViewOnDoubleClick } from "@/lib/hospitality/floor-map-interactions";
export { canOpenSeatViewOnDoubleClick };

export type FloorMember = {
  id: string;
  firstName: string;
  lastName: string;
  memberNumber: string;
};

// -----------------------------------------------------------------
// Status palette
// -----------------------------------------------------------------
const STATUS_STYLES: Record<string, { fill: string; stroke: string; text: string; label: string }> = {
  AVAILABLE:      { fill: "#ecfdf5", stroke: "#5e9a78", text: "#1f6047", label: "Available" },
  SEATED:         { fill: "#dbe7f5", stroke: "#1e4f8f", text: "#163d70", label: "Seated" },
  RESERVED_SOON:  { fill: "#fef3c7", stroke: "#b68a1a", text: "#7b5b00", label: "Reserved soon" },
  RESERVED:       { fill: "#eef3fb", stroke: "#3a6caa", text: "#1f4a82", label: "Reserved" },
  DIRTY:          { fill: "#ffedd5", stroke: "#c0651e", text: "#7a3e00", label: "Needs Reset" },
  OUT_OF_SERVICE: { fill: "#e7e5e4", stroke: "#78716c", text: "#3f3c39", label: "Out of service" },
};
function styleFor(status: string) {
  return STATUS_STYLES[status] ?? STATUS_STYLES.AVAILABLE;
}

// -----------------------------------------------------------------
// Time helpers
// -----------------------------------------------------------------
function minutesBetween(a: Date, b: Date): number {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));
}
function fmtElapsed(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
function fmtMoney(n: number): string {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function resolveDisplayStatus(t: FloorTable, now: Date): string {
  if (t.status === "SEATED" || t.liveReservation) return "SEATED";
  if (t.status === "DIRTY") return "DIRTY";
  if (t.status === "OUT_OF_SERVICE") return "OUT_OF_SERVICE";
  if (t.upcomingReservation) {
    const start = new Date(t.upcomingReservation.startTimeIso);
    const mins = (start.getTime() - now.getTime()) / 60_000;
    if (mins <= 30 && mins >= -5) return "RESERVED_SOON";
    if (mins > 30) return "RESERVED";
  }
  return "AVAILABLE";
}

// Stable slug for the URL query param.
function areaSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "area";
}

// -----------------------------------------------------------------
// Floor map root — tabbed, viewport-fit
// -----------------------------------------------------------------
export function FloorMap({ areas, members }: { areas: FloorArea[]; members: FloorMember[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const querySlug = searchParams.get("area");

  // Active area selection. Defaults to the first area; resolved from the
  // ?area= slug when present.
  const activeAreaId = useMemo(() => {
    if (querySlug) {
      const match = areas.find((a) => areaSlug(a.name) === querySlug);
      if (match) return match.id;
    }
    return areas[0]?.id ?? null;
  }, [areas, querySlug]);

  const [now, setNow] = useState<Date>(() => new Date());
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);

  // Tick once a minute for the visible elapsed counters; refresh server
  // state every 30 seconds.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const t = setInterval(() => router.refresh(), 30_000);
    return () => clearInterval(t);
  }, [router]);

  // Switching tabs clears any selected table so the panel doesn't show a
  // table from the previous area.
  function switchArea(area: FloorArea) {
    setSelectedTableId(null);
    const next = new URLSearchParams(searchParams.toString());
    next.set("area", areaSlug(area.name));
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }

  const activeArea = areas.find((a) => a.id === activeAreaId) ?? null;
  const selectedTable = activeArea?.tables.find((t) => t.id === selectedTableId) ?? null;

  if (areas.length === 0) {
    return (
      <div className="card card-body text-stone-500">
        No dining areas configured for this club yet.
      </div>
    );
  }

  return (
    // Outer wrapper fits the visible page below the admin chrome. The
    // bounded height is what stops the page from scrolling; the SVG
    // and side panel each fit themselves into it.
    <div
      className="flex flex-col rounded-lg border border-stone-200 bg-white overflow-hidden"
      style={{ height: "calc(100vh - 220px)", minHeight: 520 }}
    >
      {/* Excel-style tab strip */}
      <div role="tablist" aria-label="Dining areas" className="flex items-end gap-1 px-2 pt-2 bg-stone-100 border-b border-stone-300 shrink-0">
        {areas.map((a) => {
          const isActive = a.id === activeAreaId;
          const seated = a.tables.filter((t) => t.status === "SEATED" || t.liveReservation).length;
          const total = a.tables.length;
          return (
            <button
              key={a.id}
              role="tab"
              aria-selected={isActive}
              aria-controls={`area-panel-${a.id}`}
              id={`area-tab-${a.id}`}
              onClick={() => switchArea(a)}
              className={[
                "px-4 py-1.5 text-sm rounded-t-md border border-stone-300 transition-colors",
                isActive
                  ? "bg-white text-stone-900 border-b-white relative -mb-px font-medium shadow-[0_-1px_2px_rgba(0,0,0,0.04)]"
                  : "bg-stone-50 text-stone-600 hover:bg-stone-100 border-b-transparent",
              ].join(" ")}
            >
              {a.name}
              <span className={`ml-2 text-[11px] ${isActive ? "text-stone-500" : "text-stone-400"}`}>
                {seated} seated · {total} tables
              </span>
            </button>
          );
        })}
        <div className="ml-auto pr-2 pb-1 flex items-center gap-2">
          <Legend />
        </div>
      </div>

      {/* Body: map canvas + side panel share the remaining vertical space. */}
      <div className="flex-1 min-h-0 flex flex-col xl:flex-row">
        <div
          id={`area-panel-${activeArea?.id ?? ""}`}
          role="tabpanel"
          aria-labelledby={`area-tab-${activeArea?.id ?? ""}`}
          className="flex-1 min-h-0 min-w-0 relative bg-[#f6f3ee]"
        >
          {activeArea && (
            <AreaCanvas
              area={activeArea}
              now={now}
              onSelect={(id) => setSelectedTableId(id)}
              onDoubleSelect={(table) => {
                // Step 31 — double-click shortcut. Single-click
                // selection still fires first (browsers dispatch
                // onClick + onDoubleClick on a real dblclick); we
                // also explicitly select so the side panel matches
                // the navigation target. If the table isn't eligible
                // (e.g. AVAILABLE / DIRTY / SEATED-without-check),
                // the helper returns null and we no-op.
                setSelectedTableId(table.id);
                const href = canOpenSeatViewOnDoubleClick(table);
                if (href) router.push(href);
              }}
              selectedTableId={selectedTableId}
            />
          )}
          {/* Mobile/tablet: side panel slides over the canvas when a
              table is selected. xl+ uses the static column to the right. */}
          {selectedTable && (
            <div className="xl:hidden absolute inset-y-0 right-0 w-full max-w-sm bg-white border-l border-stone-200 shadow-xl overflow-y-auto">
              <DetailPanel
                table={selectedTable}
                now={now}
                members={members}
                onClose={() => setSelectedTableId(null)}
                onChanged={() => router.refresh()}
              />
            </div>
          )}
        </div>
        <aside className="hidden xl:flex xl:w-[340px] xl:shrink-0 border-l border-stone-200 bg-white overflow-y-auto">
          <DetailPanel
            table={selectedTable}
            now={now}
            members={members}
            onClose={() => setSelectedTableId(null)}
            onChanged={() => router.refresh()}
          />
        </aside>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------
// One area = one SVG canvas, fills its container
// -----------------------------------------------------------------
function AreaCanvas({
  area,
  now,
  onSelect,
  onDoubleSelect,
  selectedTableId,
}: {
  area: FloorArea;
  now: Date;
  onSelect: (tableId: string) => void;
  onDoubleSelect: (table: FloorTable) => void;
  selectedTableId: string | null;
}) {
  const W = area.canvasWidth || 1000;
  const H = area.canvasHeight || 700;
  // The SVG uses preserveAspectRatio="xMidYMid meet" by default, so it
  // scales DOWN to fit whichever container axis is tighter. Combined
  // with absolute positioning inside the relative tab panel, this gives
  // a "fit to window" floor map at any viewport size.
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      className="absolute inset-0 w-full h-full"
      role="img"
      aria-label={`${area.name} floor map`}
    >
      <defs>
        <pattern id={`grain-${area.id}`} width="80" height="80" patternUnits="userSpaceOnUse">
          <rect width="80" height="80" fill="#f6f3ee" />
          <path d="M0 40 Q 40 36 80 40" stroke="#ece4d4" strokeWidth="1" fill="none" />
          <path d="M0 60 Q 40 58 80 60" stroke="#ece4d4" strokeWidth="1" fill="none" />
        </pattern>
      </defs>
      <rect x="0" y="0" width={W} height={H} fill={`url(#grain-${area.id})`} />

      {area.floorElements.map((el, i) => (
        <FloorElementShape key={i} el={el} />
      ))}

      {area.tables.map((t) => (
        <TableShape
          key={t.id}
          t={t}
          now={now}
          selected={selectedTableId === t.id}
          onClick={() => onSelect(t.id)}
          onDoubleClick={() => onDoubleSelect(t)}
        />
      ))}
    </svg>
  );
}

// -----------------------------------------------------------------
// Decorative shapes — bar / dividers / floor labels.
// -----------------------------------------------------------------
function FloorElementShape({ el }: { el: FloorElement }) {
  if (el.kind === "BAR") {
    const r = 14;
    return (
      <g transform={`translate(${el.x - el.width / 2}, ${el.y - el.height / 2}) rotate(${el.rotation ?? 0} ${el.width / 2} ${el.height / 2})`}>
        <rect width={el.width} height={el.height} rx={r} ry={r} fill="#3a322a" stroke="#2a241e" strokeWidth={2} />
        <line x1={6} y1={el.height - 6} x2={el.width - 6} y2={el.height - 6} stroke="#b08a4a" strokeWidth={3} strokeLinecap="round" />
        <text x={el.width / 2} y={el.height / 2 + 6} textAnchor="middle" fontFamily="serif" fontSize={22} letterSpacing={6} fill="#f3e9d6">
          {el.label ?? "BAR"}
        </text>
      </g>
    );
  }
  if (el.kind === "DIVIDER") {
    return (
      <rect x={el.x - el.width / 2} y={el.y - el.height / 2} width={el.width} height={el.height} rx={3}
        fill="#dbcfb5" stroke="#bba47c" strokeWidth={1}
        transform={el.rotation ? `rotate(${el.rotation} ${el.x} ${el.y})` : undefined} />
    );
  }
  if (el.kind === "LABEL") {
    return (
      <text x={el.x} y={el.y} textAnchor="middle" fontFamily="serif" fontSize={14}
        fill="#7d6d4f" letterSpacing={4}
        transform={el.rotation ? `rotate(${el.rotation} ${el.x} ${el.y})` : undefined}>
        {el.label ?? ""}
      </text>
    );
  }
  return null;
}

// -----------------------------------------------------------------
// Table shape
// -----------------------------------------------------------------
function TableShape({
  t,
  now,
  selected,
  onClick,
  onDoubleClick,
}: {
  t: FloorTable;
  now: Date;
  selected: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
}) {
  const display = resolveDisplayStatus(t, now);
  const style = styleFor(display);
  const cx = t.xPos ?? 0;
  const cy = t.yPos ?? 0;
  const w = t.width;
  const h = t.height;
  const live = t.liveReservation;
  const upcoming = t.upcomingReservation;
  // Step 18 — read the unified seated-party context so a POS/self-
  // seated table shows the same host + elapsed time as one seated
  // via a reservation. `live` and `linkedSpend` stay scoped to the
  // reservation path because they're reservation-specific.
  const seated = t.seatedParty;
  const elapsedMin = seated
    ? minutesBetween(new Date(seated.seatedSinceIso), now)
    : null;
  const hostLabel = seated?.hostName ?? (seated ? "Guest party" : null);
  const guestLabel = seated
    ? hostLabel ?? "Seated party"
    : upcoming
      ? `Reserved for ${upcoming.memberName ?? upcoming.guestName ?? "party"} at ${new Date(upcoming.startTimeIso).toISOString().slice(11, 16)}`
      : "No party";
  const ariaLabel = `Table ${t.tableNumber}, ${style.label}, seats ${t.capacity}. ${guestLabel}.`;
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
      style={{ cursor: "pointer" }}
      transform={t.rotation ? `rotate(${t.rotation} ${cx} ${cy})` : undefined}
    >
      {t.shape === "ROUND" ? (
        <ellipse cx={cx} cy={cy + 4} rx={w / 2} ry={h / 2} fill="rgba(40,32,22,0.18)" />
      ) : (
        <rect x={cx - w / 2} y={cy - h / 2 + 4} width={w} height={h} rx={t.shape === "RECTANGLE" ? 10 : 6} fill="rgba(40,32,22,0.18)" />
      )}
      {t.shape === "ROUND" ? (
        <ellipse cx={cx} cy={cy} rx={w / 2} ry={h / 2}
          fill={style.fill} stroke={selected ? "#111" : style.stroke} strokeWidth={selected ? 3 : 2} />
      ) : (
        <rect x={cx - w / 2} y={cy - h / 2} width={w} height={h} rx={t.shape === "RECTANGLE" ? 10 : 6}
          fill={style.fill} stroke={selected ? "#111" : style.stroke} strokeWidth={selected ? 3 : 2} />
      )}
      <g transform={`translate(${cx - w / 2 + 6}, ${cy - h / 2 + 6})`}>
        <rect width={statusBadgeWidth(style.label)} height={16} rx={3} fill={style.stroke} />
        <text x={5} y={11} fontSize={9} fontFamily="ui-sans-serif, system-ui" fill="#fff" letterSpacing={0.5}>
          {style.label.toUpperCase()}
        </text>
      </g>
      <text x={cx} y={cy - 4} textAnchor="middle" fontFamily="ui-sans-serif, system-ui" fontSize={14} fontWeight={600} fill={style.text}>
        {t.displayName ?? `Table ${t.tableNumber}`}
      </text>
      <text x={cx} y={cy + 12} textAnchor="middle" fontFamily="ui-sans-serif, system-ui" fontSize={10} fill={style.text} opacity={0.7}>
        {`seats ${t.capacity}`}
      </text>
      {seated && (
        <text x={cx} y={cy + h / 2 + 14} textAnchor="middle" fontFamily="ui-sans-serif, system-ui" fontSize={11} fill={style.text}>
          {`${hostLabel ?? "Guest party"}${seated.partySize ? ` · ${seated.partySize} guests` : ""}`}
        </text>
      )}
      {seated && elapsedMin !== null && (
        <text x={cx} y={cy + h / 2 + 28} textAnchor="middle" fontFamily="ui-sans-serif, system-ui" fontSize={11} fill={style.text} opacity={0.75}>
          {`${fmtElapsed(elapsedMin)}${live && live.linkedSpend > 0 ? ` · ${fmtMoney(live.linkedSpend)}` : ""}`}
        </text>
      )}
      {!live && upcoming && resolveDisplayStatus(t, now) === "RESERVED_SOON" && (
        <text x={cx} y={cy + h / 2 + 14} textAnchor="middle" fontFamily="ui-sans-serif, system-ui" fontSize={11} fill={style.text}>
          {(() => {
            const mins = Math.round((new Date(upcoming.startTimeIso).getTime() - now.getTime()) / 60_000);
            if (mins <= 0) return `Arriving now · party of ${upcoming.partySize}`;
            return `In ${mins} min · party of ${upcoming.partySize}`;
          })()}
        </text>
      )}
    </g>
  );
}

function statusBadgeWidth(label: string): number {
  return Math.round(label.length * 5.4 + 12);
}

// -----------------------------------------------------------------
// Legend — compact, fits in the tab strip's tail
// -----------------------------------------------------------------
function Legend() {
  const items: Array<keyof typeof STATUS_STYLES> = [
    "AVAILABLE", "RESERVED_SOON", "SEATED", "DIRTY", "OUT_OF_SERVICE",
  ];
  return (
    <div className="hidden md:flex flex-wrap items-center gap-1.5 text-[10px] text-stone-600">
      {items.map((key) => {
        const s = STATUS_STYLES[key];
        return (
          <div key={key} className="inline-flex items-center gap-1 rounded-full border border-stone-300 bg-white px-2 py-0.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.fill, border: `1.5px solid ${s.stroke}` }} aria-hidden="true" />
            <span>{s.label}</span>
          </div>
        );
      })}
    </div>
  );
}

// -----------------------------------------------------------------
// Detail / action panel
// -----------------------------------------------------------------
function DetailPanel({
  table,
  now,
  members,
  onClose,
  onChanged,
}: {
  table: FloorTable | null;
  now: Date;
  members: FloorMember[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const lastTableId = useRef<string | null>(null);
  useEffect(() => {
    if (table?.id !== lastTableId.current) {
      setError(null); setInfo(null);
      lastTableId.current = table?.id ?? null;
    }
  }, [table?.id]);

  if (!table) {
    return (
      <div className="p-5 text-sm text-stone-500">
        Click any table on the floor to view the seated party and the actions you can take.
      </div>
    );
  }

  function run(fn: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, successMessage?: string) {
    setError(null); setInfo(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) { setError(r.error); return; }
      if (successMessage) setInfo(successMessage);
      onChanged();
    });
  }

  const live = table.liveReservation;
  const upcoming = table.upcomingReservation;
  const seated = table.seatedParty;
  const display = resolveDisplayStatus(table, now);
  const style = styleFor(display);
  // Step 18 — elapsed time is derived from the unified seated-party
  // context so it works for both reservation- and POS-seated tables.
  const elapsedMin = seated
    ? minutesBetween(new Date(seated.seatedSinceIso), now)
    : null;

  return (
    <div className="p-5 text-sm w-full">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-stone-500">{table.shape.toLowerCase()} · seats {table.capacity}</div>
          <h3 className="font-serif text-xl text-stone-900">{table.displayName ?? `Table ${table.tableNumber}`}</h3>
          <div className="mt-1 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5"
            style={{ background: style.fill, borderColor: style.stroke, color: style.text }}>
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: style.stroke }} aria-hidden="true" />
            <span className="text-[11px] uppercase tracking-wide">{style.label}</span>
          </div>
        </div>
        <button onClick={onClose} className="text-stone-400 hover:text-stone-700" aria-label="Close table detail">✕</button>
      </div>

      {error && <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
      {info && <div className="mt-3 rounded-md border border-club-green-300 bg-club-green-50 px-3 py-2 text-xs text-club-green-800">{info}</div>}

      {/* Phase 18E — single seat-view CTA that adapts to the table state:
          • table already has a POSCheck → direct link
          • SEATED via reservation, no check yet → button creates the
            check and then routes to the seat view in one tap.
          Either way the waiter never has to know whether the check
          existed before they sat the party. */}
      {table.status === "SEATED" && (
        <SeatViewCTA
          openCheckId={table.openCheckId}
          openCheckNumber={table.openCheckNumber}
          liveReservationId={live?.id ?? null}
        />
      )}

      {seated && (
        // Step 18 — single rich seated-party card driven by the
        // unified `seated` context. Renders the same host / party /
        // elapsed shape for reservation- AND POS-seated tables; the
        // action row is what differs (reservation vs releaseTable).
        <div className="mt-4 rounded-md bg-stone-50 p-3 text-xs space-y-1">
          <div className="font-medium text-stone-900">
            {seated.hostName ?? "Guest party"}
          </div>
          {seated.partySize !== null && (
            <div className="text-stone-600">Party of {seated.partySize}</div>
          )}
          {elapsedMin !== null && <div className="text-stone-600">Seated {fmtElapsed(elapsedMin)} ago</div>}
          {live && live.linkedSpend > 0 && (
            <div className="text-stone-600">Linked spend: {fmtMoney(live.linkedSpend)}</div>
          )}
          <div className="pt-2 flex flex-wrap gap-2">
            {seated.reservationId && (
              <Link href={`/app/admin/hospitality/reservations/${seated.reservationId}`} className="text-club-green-700 hover:underline">
                Open reservation
              </Link>
            )}
            {seated.checkIsActive ? (
              // Open check on the table — Mark departed is unsafe.
              // Show a disabled affordance with the exact reason so
              // the waiter knows what to do next.
              <button
                disabled
                title="Settle the check before marking departed."
                className="text-stone-400 cursor-not-allowed"
              >
                Mark departed
              </button>
            ) : seated.reservationId ? (
              // Reservation-backed depart goes through the reservation
              // workflow (also flips status COMPLETED).
              <button
                disabled={pending}
                onClick={() => run(
                  () => departReservationAction(seated.reservationId!),
                  "Marked departed. Table is now DIRTY.",
                )}
                className="text-club-green-700 hover:underline"
              >
                Mark departed
              </button>
            ) : (
              // POS-seated, no reservation. Goes through releaseTable
              // so the table flips to DIRTY without orphaning a check.
              <button
                disabled={pending}
                onClick={() => run(
                  () => releaseTableAction(table.id),
                  "Marked departed. Table is now DIRTY.",
                )}
                className="text-club-green-700 hover:underline"
              >
                Mark departed
              </button>
            )}
          </div>
          {seated.checkIsActive && (
            <div className="pt-1 text-[10px] text-stone-500">
              Settle the check before marking departed.
            </div>
          )}
        </div>
      )}

      {!seated && upcoming && (
        <div className="mt-4 rounded-md bg-stone-50 p-3 text-xs space-y-1">
          <div className="font-medium text-stone-900">{upcoming.memberName ?? upcoming.guestName ?? "Reserved party"}</div>
          <div className="text-stone-600">
            Arriving {new Date(upcoming.startTimeIso).toISOString().slice(11, 16)} · party of {upcoming.partySize}
          </div>
          <div className="pt-2 flex flex-wrap gap-2">
            <Link href={`/app/admin/hospitality/reservations/${upcoming.id}`} className="text-club-green-700 hover:underline">Open reservation</Link>
            <button disabled={pending} onClick={() => run(() => seatReservationAction(upcoming.id, table.id), "Party seated.")} className="text-club-green-700 hover:underline">
              Seat now
            </button>
          </div>
        </div>
      )}

      {!seated && !upcoming && (
        <SelfSeatingForm
          tableId={table.id}
          capacity={table.capacity}
          disabled={pending || table.status !== "AVAILABLE"}
          tableStatus={table.status}
          members={members}
          onSeated={(checkId) => {
            // Server-led self-seating succeeded. Take the waiter straight
            // into the seat-level POS so they can take the order.
            window.location.href = `/app/admin/ops/pos/lounge/table/${checkId}`;
          }}
        />
      )}

      <div className="mt-5 border-t border-stone-100 pt-3">
        <div className="text-[10px] uppercase tracking-wide text-stone-500 mb-2">Table actions</div>
        <div className="flex flex-wrap gap-2">
          {table.status === "DIRTY" && (
            <button disabled={pending} onClick={() => run(() => setTableStatusAction(table.id, "AVAILABLE"), "Table reset and ready.")} className="btn btn-primary btn-sm">
              Reset Table
            </button>
          )}
          {table.status !== "SEATED" && table.status !== "OUT_OF_SERVICE" && (
            <button disabled={pending} onClick={() => run(() => setTableStatusAction(table.id, "OUT_OF_SERVICE"), "Table taken out of service.")} className="btn btn-secondary btn-sm">
              Out of service
            </button>
          )}
          {table.status === "OUT_OF_SERVICE" && (
            <button disabled={pending} onClick={() => run(() => setTableStatusAction(table.id, "AVAILABLE"), "Table returned to service.")} className="btn btn-primary btn-sm">
              Return to service
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------
// SelfSeatingForm — waiter clicks AVAILABLE table → opens an OPEN
// check linked to the table, then redirects the waiter into the
// seat-level POS surface.
// -----------------------------------------------------------------
// -----------------------------------------------------------------
// SeatViewCTA — single drilldown for every SEATED table.
//
// If the table already has an open POSCheck, render a static link
// straight to the seat-level view. If the table is SEATED via a live
// reservation but the check hasn't been opened yet, render a button
// that opens the check on-demand and then navigates — so the server
// always reaches the seat view in one tap regardless of how the
// table got seated.
// -----------------------------------------------------------------
function SeatViewCTA({
  openCheckId,
  openCheckNumber,
  liveReservationId,
}: {
  openCheckId: string | null;
  openCheckNumber: string | null;
  liveReservationId: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (openCheckId) {
    return (
      <Link
        href={`/app/admin/ops/pos/lounge/table/${openCheckId}`}
        className="mt-3 block rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-sm text-blue-900 hover:bg-blue-100"
      >
        <div className="font-medium">Open seat view</div>
        <div className="text-xs text-blue-800/80">
          Take the order seat-by-seat
          {openCheckNumber ? ` · check ${openCheckNumber}` : ""}
        </div>
      </Link>
    );
  }

  if (!liveReservationId) {
    // Edge case: SEATED but no check + no live reservation. Shouldn't
    // happen in normal flow; let the side panel fall through to its
    // existing copy.
    return null;
  }

  function open() {
    setError(null);
    startTransition(async () => {
      const r = await openCheckAction(liveReservationId!);
      if (!r.ok) { setError(r.error); return; }
      router.push(`/app/admin/ops/pos/lounge/table/${r.data.checkId}`);
    });
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={open}
        disabled={pending}
        className="w-full text-left rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-sm text-blue-900 hover:bg-blue-100 disabled:opacity-60"
      >
        <div className="font-medium">{pending ? "Opening seat view…" : "Open seat view"}</div>
        <div className="text-xs text-blue-800/80">
          {pending ? "Creating the check now." : "Opens a POS check for this party and takes you straight to the seat-level view."}
        </div>
      </button>
      {error && <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
    </div>
  );
}

function SelfSeatingForm({
  tableId,
  capacity,
  disabled,
  tableStatus,
  members,
  onSeated,
}: {
  tableId: string;
  capacity: number;
  disabled: boolean;
  tableStatus: string;
  members: FloorMember[];
  onSeated: (checkId: string) => void;
}) {
  // Two-step flow: first click commits to seating, second step prompts for
  // the primary member number. Keeps the AVAILABLE-table panel clean until
  // the server has actually decided to seat the party.
  const [step, setStep] = useState<"idle" | "prompt">("idle");
  const [pending, startTransition] = useTransition();
  const [partySize, setPartySize] = useState<number>(2);
  const [memberNumber, setMemberNumber] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setStep("idle");
    setMemberNumber("");
    setError(null);
  }

  function submit() {
    const trimmed = memberNumber.trim();
    if (!trimmed) {
      setError("Enter the primary member number to continue.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const r = await seatTableAction({ tableId, partySize, memberNumber: trimmed });
      if (!r.ok) { setError(r.error); return; }
      onSeated(r.data.checkId);
    });
  }

  if (tableStatus !== "AVAILABLE") {
    return (
      <div className="mt-4 rounded-md bg-stone-50 p-3 text-xs text-stone-600">
        {tableStatus === "DIRTY"
          ? "This table needs a reset before the next party can be seated."
          : tableStatus === "OUT_OF_SERVICE"
            ? "This table is currently out of service."
            : "No active party or upcoming reservation on this table."}
      </div>
    );
  }

  if (step === "idle") {
    // Step 1 — single action. No form fields yet. The server has not
    // committed to seating; show them one obvious next step.
    return (
      <div className="mt-4 space-y-2">
        <button
          type="button"
          disabled={disabled || pending}
          onClick={() => setStep("prompt")}
          className="btn btn-primary btn-sm w-full"
        >
          Mark seated + start check
        </button>
        <p className="text-[10px] text-stone-500 text-center">
          You&rsquo;ll be asked for the primary member number on the next step.
        </p>
      </div>
    );
  }

  // Step 2 — primary member prompt. Enter submits, Cancel returns to idle.
  // Normalize both sides so a user who types "SS-1310" still gets a
  // live preview against the canonical 4-digit "1310" stored on the
  // member row.
  const normalizedInput = memberNumber.trim().replace(/^[A-Za-z]+-/, "");
  const matched = members.find(
    (m) => m.memberNumber.replace(/^[A-Za-z]+-/, "") === normalizedInput,
  );
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      className="mt-4 rounded-md border border-stone-200 bg-stone-50 p-3 text-xs space-y-3"
    >
      <div>
        <label className="block text-[10px] uppercase tracking-wide text-stone-500 mb-1">
          Primary member number <span className="text-red-600">*</span>
        </label>
        <input
          list="floor-member-numbers"
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
        <div className="mt-0.5 text-[10px] text-stone-500">Enter the 4-digit member number.</div>
        <datalist id="floor-member-numbers">
          {members.map((m) => (
            <option key={m.id} value={m.memberNumber}>{m.lastName}, {m.firstName}</option>
          ))}
        </datalist>
        {matched && (
          <div className="mt-1 text-[10px] text-stone-500">→ {matched.firstName} {matched.lastName}</div>
        )}
      </div>
      <div>
        <label className="block text-[10px] uppercase tracking-wide text-stone-500 mb-1">Party size</label>
        <input
          type="number"
          min={1}
          max={capacity}
          value={partySize}
          onChange={(e) => setPartySize(Math.max(1, Math.min(capacity, Number(e.target.value) || 1)))}
          className="input text-xs w-24"
        />
        <div className="mt-0.5 text-[10px] text-stone-500">Capacity: {capacity}</div>
      </div>
      {error && <div className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-red-700">{error}</div>}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={reset}
          className="btn btn-secondary btn-sm flex-1"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={disabled || pending || !memberNumber.trim()}
          className="btn btn-primary btn-sm flex-1"
        >
          {pending ? "Opening…" : "Continue"}
        </button>
      </div>
      <p className="text-[10px] text-stone-500">
        Press Enter to continue. Additional seats can be assigned in the seat view.
      </p>
    </form>
  );
}
