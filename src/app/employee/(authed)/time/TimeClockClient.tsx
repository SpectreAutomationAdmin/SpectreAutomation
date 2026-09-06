"use client";

// Payroll-3D-1 (2026-09-05) — client-side state-aware clock widget.
// The full page renders on the server (see page.tsx); this client
// component drives the four transitions + client-side elapsed-time
// tick. Every ACTION goes through a server action which re-resolves
// the employee from the portal cookie — the client never sends an
// employeeId.

import { useMemo, useState, useTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  clockInAction, clockOutAction, breakStartAction, breakEndAction,
} from "./_actions";

type ClockState = "OFF_CLOCK" | "WORKING" | "ON_BREAK";
type TimekeepingMethod =
  | "NO_TIME_ENTRY_REQUIRED"
  | "CLOCK_REQUIRED"
  | "MANUAL_TIMESHEET"
  | "SCHEDULE_DERIVED";

interface StateView {
  state:                ClockState;
  currentSessionStart?: string | null;
  currentBreakStart?:   string | null;
  currentSessionBreakSeconds: number;
  onBreak:              boolean;
  timekeepingMethod:    TimekeepingMethod;
  currentSessionAssignmentId?: string | null;
}

interface HistoryEvent {
  id:         string;
  kind:       "CLOCK_IN" | "CLOCK_OUT" | "BREAK_START" | "BREAK_END";
  occurredAt: string;
}

// Format a Date/string in the Club's IANA timezone as h:mm AM/PM.
function fmtTimeInTz(iso: string | null | undefined, tz: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  try {
    return d.toLocaleTimeString("en-CA", {
      timeZone: tz ?? undefined,
      hour: "numeric", minute: "2-digit", hour12: true,
    });
  } catch {
    return d.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", hour12: true });
  }
}
function fmtDayInTz(iso: string | null | undefined, tz: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  try {
    return d.toLocaleDateString("en-CA", {
      timeZone: tz ?? undefined,
      year: "numeric", month: "short", day: "numeric",
    });
  } catch {
    return d.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" });
  }
}
function fmtElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function kindLabel(k: HistoryEvent["kind"]): string {
  switch (k) {
    case "CLOCK_IN":    return "Clock In";
    case "CLOCK_OUT":   return "Clock Out";
    case "BREAK_START": return "Break Start";
    case "BREAK_END":   return "Break End";
  }
}

interface ActiveAssignment {
  id: string;
  roleLabel: string;
  departmentCode: string | null;
  departmentName: string | null;
}

export default function TimeClockClient(props: {
  initialState: StateView;
  history:      HistoryEvent[];
  clubTimezone: string | null;
  now:          string; // server-issued ISO, for initial rendering only
  activeAssignments?: ActiveAssignment[];
}) {
  const router = useRouter();
  const [state, setState] = useState<StateView>(props.initialState);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Payroll-3D-3A — multi-assignment employees pick their work
  // assignment before Clock In. If exactly ONE active assignment
  // exists, the server auto-selects it (no picker). If multiple,
  // the picker is required.
  const activeAssignments = props.activeAssignments ?? [];
  const needsAssignmentPick = activeAssignments.length > 1;
  const [selectedAssignmentId, setSelectedAssignmentId] = useState<string>(
    activeAssignments.length === 1 ? activeAssignments[0].id : "",
  );

  // Client-side elapsed-time tick for UX only. Payroll duration is
  // ALWAYS derived from server timestamps at Clock Out (§14, §59).
  const [nowMs, setNowMs] = useState<number>(() => new Date(props.now).getTime());
  useEffect(() => {
    if (state.state === "OFF_CLOCK") return;
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    setNowMs(Date.now());
    return () => clearInterval(id);
  }, [state.state]);

  const tz = props.clubTimezone;
  const nonInteractive = state.timekeepingMethod !== "CLOCK_REQUIRED";

  const sessionStartLabel = fmtTimeInTz(state.currentSessionStart, tz);
  const breakStartLabel   = fmtTimeInTz(state.currentBreakStart,   tz);
  const grossSeconds = state.currentSessionStart
    ? Math.max(0, Math.floor((nowMs - new Date(state.currentSessionStart).getTime()) / 1000))
    : 0;
  const paidSeconds  = Math.max(0, grossSeconds - state.currentSessionBreakSeconds);

  async function run(action: () => Promise<{ ok: true; state: unknown } | { ok: false; error: string }>) {
    setError(null);
    startTransition(async () => {
      const r = await action();
      if ("ok" in r && r.ok) {
        setState(r.state as StateView);
        router.refresh();
      } else if ("error" in r) {
        setError(r.error);
      }
    });
  }

  return (
    <div className="max-w-2xl" data-testid="portal-time-clock">
      {/* State banner */}
      <section
        className="rounded-lg border p-5"
        style={{
          background: "var(--spectre-surface)",
          borderColor: "var(--spectre-border-muted)",
        }}
        data-testid="portal-time-state"
        data-clock-state={state.state}
      >
        {nonInteractive ? (
          <div>
            <h2 className="text-lg font-semibold text-club-ink">Time entry not required</h2>
            <p className="mt-2 text-sm text-stone-600">
              Your role does not require clocking in and out for payroll. If you believe this is a
              mistake, please contact your manager.
            </p>
          </div>
        ) : state.state === "OFF_CLOCK" ? (
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-stone-500">
              You&#39;re not clocked in
            </div>
            {needsAssignmentPick ? (
              <label className="mt-4 block">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-stone-600">
                  Where are you working?
                </span>
                <select
                  className="input mt-1 w-full"
                  value={selectedAssignmentId}
                  onChange={(e) => setSelectedAssignmentId(e.target.value)}
                  data-testid="portal-time-assignment-picker"
                  disabled={pending}
                >
                  <option value="">— Choose an assignment —</option>
                  {activeAssignments.map((a) => (
                    <option
                      key={a.id}
                      value={a.id}
                      data-testid={`portal-time-assignment-option:${a.departmentCode ?? "no-dept"}`}
                    >
                      {a.departmentName ?? "(no department)"}
                      {a.departmentCode ? ` · ${a.departmentCode}` : ""}
                      {a.roleLabel !== "PRIMARY" ? ` · ${a.roleLabel.toLowerCase()}` : ""}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <button
              type="button"
              className="btn btn-primary mt-4 w-full py-3 text-base"
              disabled={pending || (needsAssignmentPick && !selectedAssignmentId)}
              onClick={() => run(() => clockInAction(
                needsAssignmentPick
                  ? { employmentAssignmentId: selectedAssignmentId }
                  : undefined,
              ))}
              data-testid="portal-time-clock-in"
            >
              {pending ? "Clocking in…" : "Clock In"}
            </button>
            {needsAssignmentPick && !selectedAssignmentId ? (
              <p className="mt-2 text-[11px] text-stone-500">
                Pick the assignment for this shift before clocking in.
              </p>
            ) : null}
          </div>
        ) : state.state === "WORKING" ? (
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-emerald-800">
              Clocked in
            </div>
            <div className="mt-1 text-2xl font-semibold text-club-ink" data-testid="portal-time-since">
              Since {sessionStartLabel}
            </div>
            <div className="mt-1 text-xs text-stone-500">
              Recorded time · <span data-testid="portal-time-paid-elapsed">{fmtElapsed(paidSeconds)}</span>
              {state.currentSessionBreakSeconds > 0 ? (
                <span> · Break {fmtElapsed(state.currentSessionBreakSeconds)}</span>
              ) : null}
            </div>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                className="btn btn-secondary flex-1 py-3 text-base"
                disabled={pending}
                onClick={() => run(breakStartAction)}
                data-testid="portal-time-break-start"
              >
                Start Break
              </button>
              <button
                type="button"
                className="btn btn-primary flex-1 py-3 text-base"
                disabled={pending}
                onClick={() => run(clockOutAction)}
                data-testid="portal-time-clock-out"
              >
                Clock Out
              </button>
            </div>
          </div>
        ) : (
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-amber-800">
              On break
            </div>
            <div className="mt-1 text-2xl font-semibold text-club-ink" data-testid="portal-time-since">
              Since {breakStartLabel}
            </div>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                className="btn btn-primary flex-1 py-3 text-base"
                disabled={pending}
                onClick={() => run(breakEndAction)}
                data-testid="portal-time-break-end"
              >
                End Break
              </button>
              <button
                type="button"
                className="btn btn-secondary flex-1 py-3 text-base"
                disabled={pending}
                onClick={() => run(clockOutAction)}
                data-testid="portal-time-clock-out"
              >
                Clock Out
              </button>
            </div>
          </div>
        )}
        {error ? (
          <p className="mt-3 text-xs text-red-700" data-testid="portal-time-error">
            {error}
          </p>
        ) : null}
      </section>

      {/* Recent history */}
      <section className="mt-6" data-testid="portal-time-history">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
          Recent
        </h3>
        {props.history.length === 0 ? (
          <p className="rounded-lg border border-dashed border-stone-200 px-4 py-6 text-center text-xs text-stone-500">
            No clock events yet.
          </p>
        ) : (
          <RecentHistory history={props.history} tz={tz} />
        )}
      </section>

      {/* Footer note */}
      <p className="mt-4 text-[10px] text-stone-500">
        Recorded time · not yet approved payroll time. Times shown in{" "}
        {tz ?? "your local timezone"}.
      </p>
    </div>
  );
}

function RecentHistory({ history, tz }: { history: HistoryEvent[]; tz: string | null }) {
  const grouped = useMemo(() => {
    const g = new Map<string, HistoryEvent[]>();
    for (const e of history) {
      const key = fmtDayInTz(e.occurredAt, tz);
      const list = g.get(key) ?? [];
      list.push(e);
      g.set(key, list);
    }
    return [...g.entries()];
  }, [history, tz]);

  return (
    <div className="space-y-4">
      {grouped.map(([day, events]) => (
        <div key={day}>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">
            {day}
          </div>
          <ul className="mt-1 space-y-1">
            {events.map((e) => (
              <li key={e.id} className="flex justify-between text-sm">
                <span className="text-stone-700">{kindLabel(e.kind)}</span>
                <span className="tabular-nums text-stone-500">{fmtTimeInTz(e.occurredAt, tz)}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
