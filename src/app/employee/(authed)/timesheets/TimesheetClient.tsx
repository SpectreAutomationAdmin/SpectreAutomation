"use client";

// Payroll-3D-2 — Employee Portal Timesheet client widget.
// Renders the current pay period's entries, exceptions, and a
// correction dialog for Missing Clock Out (the MVP flow, §28).

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { submitCorrectionAction, cancelCorrectionAction } from "./_actions";

interface Entry {
  id: string;
  workDateIso: string;
  clockInIso: string;
  clockOutIso: string;
  recordedSeconds: number;
  breakSeconds: number;
  employmentAssignmentId: string | null;
}
interface Exception {
  kind: "MISSING_CLOCK_OUT" | "OPEN_BREAK" | "MISSING_ASSIGNMENT" | "INVALID_SEQUENCE";
  message: string;
  contextClockEventId?: string;
}
interface CorrectionRow {
  id: string;
  requestType: string;
  originalClockEventId: string | null;
  requestedOccurredAtIso: string | null;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  createdAtIso: string;
}
interface PeriodView {
  payPeriod: {
    id: string; taxYear: number; sequenceInYear: number;
    periodStartIso: string; periodEndIso: string; payDateIso: string;
  };
  status: "OPEN" | "NEEDS_ATTENTION" | "READY_FOR_REVIEW" | "SUBMITTED";
  entries: Entry[];
  exceptions: Exception[];
  totalSeconds: number;
  clubTimezone: string | null;
  pendingCorrections: CorrectionRow[];
}

function fmtTime(iso: string, tz: string | null): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-CA", {
    timeZone: tz ?? undefined, hour: "numeric", minute: "2-digit", hour12: true,
  });
}
function fmtDay(iso: string, tz: string | null): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-CA", {
    timeZone: tz ?? undefined, weekday: "short", month: "short", day: "numeric",
  });
}
function fmtDayIso(iso: string, tz: string | null): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-CA", { timeZone: tz ?? undefined, year: "numeric", month: "long", day: "numeric" });
}
function fmtDuration(s: number): string {
  const seconds = Math.max(0, Math.floor(s));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function TimesheetClient(props: {
  view: PeriodView;
  employmentAssignmentId: string | null;
}) {
  const router = useRouter();
  const tz = props.view.clubTimezone;
  const [dialog, setDialog] = useState<
    | { mode: "MISSING_CLOCK_OUT"; originalClockEventId: string; suggestedLocalIso: string }
    | null
  >(null);

  const dailyGroups = useMemo(() => {
    const g = new Map<string, Entry[]>();
    for (const e of props.view.entries) {
      const day = fmtDay(e.workDateIso, tz);
      const list = g.get(day) ?? [];
      list.push(e);
      g.set(day, list);
    }
    return [...g.entries()];
  }, [props.view.entries, tz]);

  const missingClockOut = props.view.exceptions.find((x) => x.kind === "MISSING_CLOCK_OUT");
  const hasPendingCorrectionForMissingOut = missingClockOut?.contextClockEventId
    ? props.view.pendingCorrections.some(
        (c) => c.status === "PENDING"
          && c.requestType === "ADD_MISSING_CLOCK_OUT"
          && c.originalClockEventId === missingClockOut.contextClockEventId,
      )
    : false;

  return (
    <div className="max-w-3xl" data-testid="portal-timesheet">
      <nav className="mb-4 flex items-center justify-between text-xs">
        <Link href="/employee" className="text-stone-500 underline">
          ← Home
        </Link>
        <Link href="/employee/time" className="text-stone-500 underline">
          Clock In / Out →
        </Link>
      </nav>

      <header className="mb-6 border-b border-stone-200 pb-4">
        <h1 className="font-serif text-3xl text-club-ink">Timesheet</h1>
        <p className="mt-1 text-sm text-stone-500">
          {fmtDayIso(props.view.payPeriod.periodStartIso, tz)} –{" "}
          {fmtDayIso(new Date(new Date(props.view.payPeriod.periodEndIso).getTime() - 86_400_000).toISOString(), tz)}
        </p>
        <p className="mt-1 text-[10px] uppercase tracking-wider text-stone-500">
          Pay date {fmtDayIso(props.view.payPeriod.payDateIso, tz)}
        </p>
      </header>

      {/* Exceptions */}
      {props.view.exceptions.length > 0 ? (
        <section className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4"
                 data-testid="portal-timesheet-exceptions">
          <div className="text-xs font-semibold uppercase tracking-wider text-amber-800">
            Needs attention
          </div>
          <ul className="mt-2 space-y-2 text-sm text-amber-900">
            {props.view.exceptions.map((ex, i) => (
              <li key={`${ex.kind}-${i}`} className="flex items-start justify-between gap-2"
                  data-testid={`portal-timesheet-exception:${ex.kind}`}>
                <span>{ex.message}</span>
                {ex.kind === "MISSING_CLOCK_OUT" && ex.contextClockEventId && !hasPendingCorrectionForMissingOut ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm shrink-0"
                    onClick={() => setDialog({
                      mode: "MISSING_CLOCK_OUT",
                      originalClockEventId: ex.contextClockEventId!,
                      suggestedLocalIso: defaultSuggestedLocalIso(tz),
                    })}
                    data-testid="portal-timesheet-request-correction"
                  >
                    Request correction
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Pending corrections */}
      {props.view.pendingCorrections.length > 0 ? (
        <section className="mb-6" data-testid="portal-timesheet-pending-corrections">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
            Pending corrections
          </h3>
          <ul className="space-y-2 text-sm">
            {props.view.pendingCorrections.map((c) => (
              <li key={c.id} className="flex items-start justify-between gap-2 rounded-md border border-stone-200 bg-white px-3 py-2"
                  data-testid={`portal-correction-row:${c.id}`}>
                <div>
                  <div className="font-medium text-stone-700">
                    {prettyCorrectionType(c.requestType)}
                    <span className="ml-2 inline-block rounded-sm bg-amber-100 px-1 text-[9px] font-semibold uppercase text-amber-900">
                      {c.status}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-stone-500">
                    {c.requestedOccurredAtIso ? `Proposed: ${fmtTime(c.requestedOccurredAtIso, tz)} · ` : ""}
                    Reason: {c.reason}
                  </div>
                </div>
                <CancelButton correctionId={c.id} onDone={() => router.refresh()} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Entries */}
      {dailyGroups.length === 0 ? (
        <p className="rounded-md border border-dashed border-stone-200 px-4 py-6 text-center text-xs text-stone-500">
          No recorded time yet for this pay period.
        </p>
      ) : (
        <section className="space-y-4">
          {dailyGroups.map(([day, entries]) => (
            <div key={day}>
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-stone-500">
                {day}
              </h3>
              <ul className="space-y-1">
                {entries.map((e) => (
                  <li key={e.id} className="rounded-md border border-stone-200 bg-white px-3 py-2 text-sm"
                      data-testid={`portal-timesheet-entry:${e.id}`}>
                    <div className="flex items-baseline justify-between">
                      <span className="tabular-nums text-club-ink">
                        {fmtTime(e.clockInIso, tz)} – {fmtTime(e.clockOutIso, tz)}
                      </span>
                      <span className="tabular-nums text-stone-500">
                        Recorded {fmtDuration(e.recordedSeconds)}
                      </span>
                    </div>
                    {e.breakSeconds > 0 ? (
                      <div className="mt-0.5 text-[11px] text-stone-500">
                        Break {fmtDuration(e.breakSeconds)}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
              <div className="mt-1 text-right text-[11px] text-stone-500">
                Day total {fmtDuration(entries.reduce((a, e) => a + e.recordedSeconds, 0))}
              </div>
            </div>
          ))}
        </section>
      )}

      {/* Period total */}
      <footer className="mt-6 flex items-baseline justify-between border-t border-stone-200 pt-4">
        <span className="text-xs font-semibold uppercase tracking-wide text-stone-500">
          Period recorded
        </span>
        <span className="text-2xl font-semibold tabular-nums text-club-ink"
              data-testid="portal-timesheet-total">
          {fmtDuration(props.view.totalSeconds)}
        </span>
      </footer>
      <p className="mt-2 text-[10px] text-stone-500">
        Recorded time · not yet approved payroll time.
      </p>

      {/* Correction dialog */}
      {dialog ? (
        <MissingClockOutDialog
          tz={tz}
          originalClockEventId={dialog.originalClockEventId}
          suggestedLocalIso={dialog.suggestedLocalIso}
          onCancel={() => setDialog(null)}
          onSubmitted={() => { setDialog(null); router.refresh(); }}
        />
      ) : null}
    </div>
  );
}

function prettyCorrectionType(t: string): string {
  switch (t) {
    case "ADD_MISSING_CLOCK_IN":  return "Add missing Clock In";
    case "ADD_MISSING_CLOCK_OUT": return "Add missing Clock Out";
    case "CORRECT_CLOCK_IN":      return "Correct Clock In";
    case "CORRECT_CLOCK_OUT":     return "Correct Clock Out";
    case "CORRECT_BREAK_START":   return "Correct Break Start";
    case "CORRECT_BREAK_END":     return "Correct Break End";
    default: return t;
  }
}

function defaultSuggestedLocalIso(tz: string | null): string {
  // Suggest "now" in the Club timezone as the default, floored to the minute.
  const now = new Date();
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz ?? undefined, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
  const parts = dtf.formatToParts(now);
  const y = parts.find((p) => p.type === "year")!.value;
  const mo = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  const hh = parts.find((p) => p.type === "hour")!.value;
  const mm = parts.find((p) => p.type === "minute")!.value;
  return `${y}-${mo}-${d}T${hh}:${mm}`;
}

function MissingClockOutDialog(props: {
  tz: string | null;
  originalClockEventId: string;
  suggestedLocalIso: string;
  onCancel: () => void;
  onSubmitted: () => void;
}) {
  const [localIso, setLocalIso] = useState(props.suggestedLocalIso);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
         role="dialog" aria-modal="true" data-testid="portal-correction-dialog">
      <div className="w-[420px] rounded-lg bg-white p-6 shadow-xl">
        <div className="text-xs font-semibold uppercase tracking-wider text-stone-500">
          Request correction · Missing Clock Out
        </div>
        <h3 className="mt-1 text-lg font-semibold text-club-ink">Propose a Clock Out time</h3>
        <p className="mt-1 text-xs text-stone-500">
          Times are in your Club's timezone{props.tz ? ` (${props.tz})` : ""}.
        </p>

        <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-stone-600">
          Proposed Clock Out
          <input
            type="datetime-local"
            className="input mt-1 w-full"
            value={localIso}
            onChange={(e) => setLocalIso(e.target.value)}
            data-testid="portal-correction-time"
          />
        </label>
        <label className="mt-3 block text-xs font-semibold uppercase tracking-wide text-stone-600">
          Reason
          <textarea
            className="input mt-1 w-full"
            rows={3}
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Forgot to clock out at end of shift."
            data-testid="portal-correction-reason"
          />
        </label>

        {error ? (
          <p className="mt-2 text-xs text-red-700" data-testid="portal-correction-error">{error}</p>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={props.onCancel}
            disabled={pending}
            data-testid="portal-correction-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={pending || !reason.trim() || !localIso}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const r = await submitCorrectionAction({
                  requestType: "ADD_MISSING_CLOCK_OUT",
                  originalClockEventId: props.originalClockEventId,
                  requestedLocalIso: localIso,
                  reason,
                });
                if (r.ok) props.onSubmitted();
                else setError(r.error);
              });
            }}
            data-testid="portal-correction-submit"
          >
            {pending ? "Submitting…" : "Submit request"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CancelButton({ correctionId, onDone }: { correctionId: string; onDone: () => void }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      className="text-[11px] underline text-stone-500"
      disabled={pending}
      onClick={() => startTransition(async () => {
        await cancelCorrectionAction(correctionId);
        onDone();
      })}
      data-testid={`portal-correction-cancel-btn:${correctionId}`}
    >
      {pending ? "Cancelling…" : "Cancel"}
    </button>
  );
}
