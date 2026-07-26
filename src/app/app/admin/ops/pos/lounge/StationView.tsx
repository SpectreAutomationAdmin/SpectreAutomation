"use client";

// Kitchen / Bar prep-station view. Shows queued chits as cards. Each
// card has Acknowledge / Mark Ready actions and a browser-native
// "Print" button so the staff can route the chit to whatever printer
// the workstation has set up.
//
// Browser print: an `@media print` style block hides everything but
// the focused chit so the printed page is clean. Future thermal-
// printer integration would slot in alongside this — the chit data
// already lives on POSChit; you'd swap the print() call for a network
// printer dispatch.

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/Badge";
import { formatDateTime } from "@/lib/finance";
import { acknowledgeChitAction, markChitReadyAction } from "./_actions";

// Prep time goals (minutes) by station. Kitchen food has a 10-minute
// target; the bar makes drinks faster. The timer escalates color as it
// approaches and crosses the goal, by design — a chit aging past goal
// should be visible from across the line.
const PREP_GOAL_MINUTES: Record<"KITCHEN" | "BAR", number> = {
  KITCHEN: 10,
  BAR: 5,
};

type ChitLineModifierView = {
  id: string;
  modifierType: string; // REMOVE | ADD | SUBSTITUTE | ALLERGY | NOTE
  label: string;
  printLabel: string | null;
};
type ChitLineView = {
  id: string;
  displayDescription: string;
  displayQuantity: number | string;
  displayNote: string | null;
  hasAllergy?: boolean;
  modifiers?: ChitLineModifierView[];
  // Phase 18E — seat assignment, snapshotted at send time. The kitchen
  // reads this to plate by seat. Null = no seat (legacy / table line).
  displaySeatNumber?: number | null;
  displayTableLevel?: boolean;
};
type CheckView = {
  id: string;
  checkNumber: string;
  diningMode: string;
  tableNumber: string | null;
  member: { firstName: string; lastName: string; memberNumber: string } | null;
};
type ChitView = {
  id: string;
  station: string;
  status: string;
  course: number;
  sentAt: Date | string;
  // null while HELD; set when the chit became active in the kitchen
  // view (course 1 = sentAt, later courses = fire time).
  firedAt: Date | string | null;
  // null = manual fire only; otherwise the moment this HELD chit will
  // auto-promote to QUEUED.
  fireAt: Date | string | null;
  acknowledgedAt: Date | string | null;
  readyAt: Date | string | null;
  lines: ChitLineView[];
  check: CheckView;
};

export function StationView({
  chits: initial,
  heldChits = [],
  station,
  refreshKey,
}: {
  chits: ChitView[];
  heldChits?: ChitView[];
  station: "KITCHEN" | "BAR";
  refreshKey?: string;
}) {
  const [chits, setChits] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [printingChitId, setPrintingChitId] = useState<string | null>(null);
  const router = useRouter();

  // Reconcile the optimistic-update local `chits` state with fresh
  // server props on every refresh. Without this, a server-side
  // promoteDueHeldChits sweep would re-render with new props but the
  // active grid would stay stale.
  useEffect(() => {
    setChits(initial);
  }, [initial]);

  // Triggered when a HELD chit's FireCountdown reaches zero — calls
  // router.refresh() so the server-side promoteDueHeldChits sweep runs
  // and the chit moves from the Up-next strip to the active grid.
  // Ref-guarded so multiple chits hitting zero in the same tick don't
  // hammer the server.
  const refreshScheduledRef = useRef(false);
  function onCountdownDue() {
    if (refreshScheduledRef.current) return;
    refreshScheduledRef.current = true;
    // 750ms buffer: gives the server clock a tiny margin over any
    // client clock skew, and lets multiple near-simultaneous due
    // chits coalesce into a single refresh.
    setTimeout(() => {
      router.refresh();
      // After the refresh completes the new props will arrive and
      // we re-arm. We rely on the prop-sync useEffect above firing.
      refreshScheduledRef.current = false;
    }, 750);
  }

  // Optimistic mutation: flip the local state first, then sync with
  // the server. If the action fails we restore the previous state.
  function ack(chitId: string) {
    const before = chits;
    setChits((cs) => cs.map((c) => c.id === chitId ? { ...c, status: "ACKNOWLEDGED", acknowledgedAt: new Date() } : c));
    startTransition(async () => {
      const r = await acknowledgeChitAction(chitId);
      if (!r.ok) setChits(before);
    });
  }
  function ready(chitId: string) {
    const before = chits;
    setChits((cs) => cs.map((c) => c.id === chitId ? { ...c, status: "READY", readyAt: new Date() } : c));
    startTransition(async () => {
      const r = await markChitReadyAction(chitId);
      if (!r.ok) setChits(before);
    });
  }
  function print(chitId: string) {
    setPrintingChitId(chitId);
    // Defer print() so React paints the print-only state first.
    setTimeout(() => {
      window.print();
      setPrintingChitId(null);
    }, 100);
  }

  if (chits.length === 0 && heldChits.length === 0) {
    return (
      <div className="card card-body text-center text-stone-500">
        <div className="text-sm">No active {station.toLowerCase()} chits.</div>
        <div className="mt-1 text-xs">When a server sends new items to {station.toLowerCase()}, they&rsquo;ll appear here.</div>
      </div>
    );
  }

  return (
    <>
      {/* Hide everything else when printing a single chit. */}
      <style jsx global>{`
        @media print {
          body * { visibility: hidden; }
          .print-target, .print-target * { visibility: visible; }
          .print-target { position: absolute; left: 0; top: 0; width: 100%; }
          .no-print { display: none !important; }
        }
      `}</style>

      {heldChits.length > 0 && (
        <section className="mb-6 no-print">
          <div className="flex items-center gap-2 px-1 mb-2">
            <h2 className="text-xs uppercase tracking-wide text-stone-500">Up next ({heldChits.length})</h2>
            <span className="text-[10px] text-stone-400">Held — waiting on fire</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {heldChits.map((c) => (
              <HeldChitCard key={c.id} chit={c} onCountdownDue={onCountdownDue} />
            ))}
          </div>
        </section>
      )}

      <div className={`grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 ${refreshKey ?? ""}`}>
        {chits.map((c) => {
          const isPrinting = printingChitId === c.id;
          return (
            <div
              key={c.id}
              className={`card overflow-hidden ${isPrinting ? "print-target" : ""}`}
            >
              <div className={`px-4 py-3 ${c.status === "READY" ? "bg-club-green-50" : "bg-stone-50"} border-b border-stone-200`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="font-mono text-xs text-stone-500">{c.check.checkNumber}</div>
                      <div className="inline-flex items-center rounded-md border border-stone-300 bg-white px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-stone-700">
                        Course {c.course}
                      </div>
                    </div>
                    <div className="mt-1 font-medium text-club-ink truncate">
                      {c.check.member ? `${c.check.member.firstName} ${c.check.member.lastName}` : "Guest"}
                    </div>
                    <div className="text-xs text-stone-600">
                      {c.check.diningMode === "TO_GO" ? <strong className="text-stone-900">TO GO</strong> : "Dining in"}
                      {c.check.tableNumber && <> · Table {c.check.tableNumber}</>}
                    </div>
                    <div className="text-[10px] text-stone-500 mt-1">
                      Fired {formatDateTime(c.firedAt ?? c.sentAt)}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    <PrepTimer firedAt={c.firedAt ?? c.sentAt} readyAt={c.readyAt} goalMinutes={PREP_GOAL_MINUTES[station]} />
                    <Badge status={c.status} />
                  </div>
                </div>
              </div>
              <div className="p-4">
                <ul className="space-y-2 text-sm">
                  {c.lines.map((l) => {
                    const mods = l.modifiers ?? [];
                    const structuredMods = mods.filter(
                      (m) => m.modifierType !== "ALLERGY" && m.modifierType !== "NOTE"
                    );
                    const allergyMods = mods.filter((m) => m.modifierType === "ALLERGY");
                    const noteMod = mods.find((m) => m.modifierType === "NOTE");
                    return (
                      <li key={l.id} className="border-b border-stone-100 last:border-b-0 pb-2 last:pb-0">
                        <div className="font-medium text-club-ink">
                          <span className="tabular-nums">{Number(String(l.displayQuantity))}</span> × {l.displayDescription}
                          {l.displaySeatNumber != null && (
                            <span className="ml-2 inline-flex items-center rounded-md border border-stone-300 bg-white px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-stone-700">Seat {l.displaySeatNumber}</span>
                          )}
                          {l.displayTableLevel && !l.displaySeatNumber && (
                            <span className="ml-2 inline-flex items-center rounded-md border border-stone-300 bg-white px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-stone-700">Table</span>
                          )}
                        </div>
                        {/* Modifiers — sub-bullets the prep crew reads off the chit.
                            Indented and prefixed with "·" so they look like
                            instructions on a paper ticket. */}
                        {structuredMods.length > 0 && (
                          <ul className="mt-1 pl-3 space-y-0.5 text-xs text-stone-700">
                            {structuredMods.map((m) => (
                              <li key={m.id} className="leading-snug">
                                · {m.printLabel || m.label}
                              </li>
                            ))}
                          </ul>
                        )}
                        {/* Allergies (one row per chip the server selected,
                            joined for compact display). Red block, all caps
                            prefix — line cook can never miss it. */}
                        {allergyMods.length > 0 && (
                          <div className="mt-1 rounded-md border-2 border-red-400 bg-red-50 px-2 py-1 text-xs font-medium text-red-800">
                            <span className="uppercase tracking-wide">Allergy:</span>{" "}
                            {allergyMods.map((m) => m.label).join(", ")}
                          </div>
                        )}
                        {/* Free-text kitchen / bar note — italic so it reads
                            as a comment rather than an instruction. */}
                        {(noteMod || l.displayNote) && (
                          <div className="mt-1 text-xs text-stone-600 italic leading-snug">
                            {noteMod ? noteMod.label : `Note: ${l.displayNote}`}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
              <div className="px-4 py-3 border-t border-stone-200 flex flex-wrap gap-2 no-print">
                {c.status === "QUEUED" || c.status === "PRINTED" ? (
                  <button type="button" disabled={pending} onClick={() => ack(c.id)} className="btn btn-secondary btn-sm">
                    Acknowledge
                  </button>
                ) : null}
                {c.status !== "READY" && c.status !== "CANCELLED" && (
                  <button type="button" disabled={pending} onClick={() => ready(c.id)} className="btn btn-primary btn-sm">
                    Mark ready
                  </button>
                )}
                <button type="button" onClick={() => print(c.id)} className="btn btn-secondary btn-sm ml-auto">
                  Print
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// Live mm:ss timer in the corner of each chit card. Counts up from
// `firedAt` (when the kitchen actually started seeing the chit, NOT
// when the server hit send — held chits don't accumulate during the
// hold). Freezes the instant the chit is marked READY so the line
// can see what time was clocked. Colour escalates as the elapsed time
// approaches and crosses the station goal:
//   • 0 – 50% of goal    → stone (calm)
//   • 50 – 75% of goal   → amber (warming up)
//   • 75 – 100% of goal  → orange (push)
//   • ≥ 100% of goal     → red, pulsing (over time — stress)
//   • READY              → club green, frozen (made it)
function PrepTimer({
  firedAt,
  readyAt,
  goalMinutes,
}: {
  firedAt: Date | string;
  readyAt: Date | string | null;
  goalMinutes: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (readyAt) return; // frozen — no need to tick
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [readyAt]);

  const startMs = toMs(firedAt);
  const endMs = readyAt ? toMs(readyAt) : now;
  const elapsedSec = Math.max(0, Math.floor((endMs - startMs) / 1000));
  const mm = Math.floor(elapsedSec / 60);
  const ss = elapsedSec % 60;
  const display = `${mm}:${String(ss).padStart(2, "0")}`;

  // Determine stress tier.
  const elapsedMin = elapsedSec / 60;
  const ratio = goalMinutes > 0 ? elapsedMin / goalMinutes : 0;
  let tierCls: string;
  if (readyAt) {
    tierCls = "bg-white text-club-green-700 border-club-green-300";
  } else if (ratio < 0.5) {
    tierCls = "bg-white text-stone-600 border-stone-200";
  } else if (ratio < 0.75) {
    tierCls = "bg-amber-50 text-amber-800 border-amber-300";
  } else if (ratio < 1) {
    tierCls = "bg-orange-50 text-orange-800 border-orange-400";
  } else {
    tierCls = "bg-red-50 text-red-700 border-red-400 animate-pulse";
  }

  const aria = readyAt
    ? `Made ready in ${mm} minutes ${ss} seconds`
    : `In prep for ${mm} minutes ${ss} seconds, goal ${goalMinutes} minutes`;

  return (
    <div
      role="timer"
      aria-label={aria}
      className={`tabular-nums font-mono text-base font-semibold leading-none px-2.5 py-1.5 rounded-md border ${tierCls}`}
    >
      {display}
    </div>
  );
}

function toMs(d: Date | string): number {
  return typeof d === "string" ? new Date(d).getTime() : d.getTime();
}

// Compact card for HELD chits in the "Up next" strip. Dimmed so the
// line cooks know it isn't a fire-now ticket; shows course number,
// summary of items, and either a live countdown to auto-fire or a
// "Manual fire" badge. Once the chit promotes (auto or manual), the
// next page revalidation drops it into the active grid.
function HeldChitCard({ chit, onCountdownDue }: { chit: ChitView; onCountdownDue?: () => void }) {
  return (
    <div className="card overflow-hidden border-dashed bg-stone-50/60 opacity-95">
      <div className="px-3 py-2 border-b border-stone-200 bg-stone-50 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="font-mono text-[11px] text-stone-500">{chit.check.checkNumber}</div>
            <div className="inline-flex items-center rounded-md border border-stone-300 bg-white px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-stone-700">
              Course {chit.course}
            </div>
          </div>
          <div className="mt-1 text-sm font-medium text-club-ink truncate">
            {chit.check.member ? `${chit.check.member.firstName} ${chit.check.member.lastName}` : "Guest"}
          </div>
        </div>
        <FireCountdown fireAt={chit.fireAt} onDue={onCountdownDue} />
      </div>
      <ul className="px-3 py-2 space-y-1 text-xs text-stone-600">
        {chit.lines.map((l) => {
          const mods = l.modifiers ?? [];
          const allergyMods = mods.filter((m) => m.modifierType === "ALLERGY");
          const modSummary = mods
            .filter((m) => m.modifierType !== "ALLERGY" && m.modifierType !== "NOTE")
            .map((m) => m.printLabel || m.label)
            .join(", ");
          return (
            <li key={l.id}>
              <div className="truncate">
                <span className="tabular-nums">{Number(String(l.displayQuantity))}</span> × {l.displayDescription}
                {modSummary && <span className="text-stone-400"> — {modSummary}</span>}
              </div>
              {allergyMods.length > 0 && (
                <div className="mt-0.5 inline-flex items-center gap-1 rounded-md border border-red-300 bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
                  <span className="uppercase tracking-wide">Allergy:</span>{" "}
                  <span>{allergyMods.map((m) => m.label).join(", ")}</span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Live countdown to auto-fire. Shows "Manual" when fireAt is null
// (server has to tap Fire next course), or mm:ss until promotion
// otherwise. When the countdown hits zero we call onDue exactly
// once — the parent (StationView) responds by calling router.refresh()
// which runs the server's promoteDueHeldChits sweep and promotes
// the chit. We show "Firing…" until the refreshed props arrive.
function FireCountdown({ fireAt, onDue }: { fireAt: Date | string | null; onDue?: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  const dueFiredRef = useRef(false);
  useEffect(() => {
    if (!fireAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [fireAt]);

  if (!fireAt) {
    return (
      <div className="text-[10px] font-medium uppercase tracking-wide text-stone-600 border border-stone-300 bg-white rounded-md px-2 py-1 shrink-0">
        Manual
      </div>
    );
  }
  const fireMs = typeof fireAt === "string" ? new Date(fireAt).getTime() : fireAt.getTime();
  const remainingSec = Math.max(0, Math.floor((fireMs - now) / 1000));
  const mm = Math.floor(remainingSec / 60);
  const ss = remainingSec % 60;
  if (remainingSec === 0) {
    if (!dueFiredRef.current && onDue) {
      dueFiredRef.current = true;
      onDue();
    }
    return (
      <div className="text-[10px] font-medium uppercase tracking-wide text-amber-800 border border-amber-300 bg-amber-50 rounded-md px-2 py-1 shrink-0 animate-pulse">
        Firing…
      </div>
    );
  }
  return (
    <div className="text-[11px] text-stone-700 border border-stone-300 bg-white rounded-md px-2 py-1 shrink-0 tabular-nums font-mono">
      Fires in {mm}:{String(ss).padStart(2, "0")}
    </div>
  );
}
