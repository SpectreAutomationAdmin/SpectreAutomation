// Sprint 3 · Checkpoint 16G Stage E (2026-08-04) — Today's
// Commitments rail panel.
//
// Server-rendered from the snapshot loader. Sprint 3 · Checkpoint 16H
// calendar-acceptance (2026-08-05) — client-hydrated for temporal
// state (PAST / IN_PROGRESS / UPCOMING / ALL_DAY). Past appointments
// remain visible for the rest of the local day but appear faded +
// strikethrough. A 60-second client tick recomputes state locally
// from already-loaded startIso/endIso — no Graph refetch.
//
// Restrained agenda format — time on the left, title + secondary
// context on the right. Source distinction via a compact eyebrow
// underneath the title. Never fabricates.

"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { TodayCommitmentsSnapshot, TodayCommitment, CalendarCommitmentState } from "@/lib/mission-control/commitments";

interface Props {
  data: TodayCommitmentsSnapshot;
}

// Recompute state on the client from serialised startIso/endIso.
// Never refetches Graph. Mirrors deriveCommitmentState on the server.
function deriveClientState(item: TodayCommitment, now: Date): CalendarCommitmentState {
  if (item.isAllDay) return "ALL_DAY";
  const nowMs = now.getTime();
  const start = item.startIso ? new Date(item.startIso).getTime() : NaN;
  const end = item.endIso ? new Date(item.endIso).getTime() : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return item.state;
  if (end <= nowMs) return "PAST";
  if (start <= nowMs) return "IN_PROGRESS";
  return "UPCOMING";
}

export default function TodaysCommitments({ data }: Props) {
  const consent = data.calendarConsent;
  const hasItems = data.items.length > 0;

  // Sprint 3 · Checkpoint 16H — 60-second tick so PAST fading appears
  // without a full page reload. Ticks are inexpensive (setState of a
  // Date) and never touch the network; the Graph events are already
  // in props.data.items with absolute ISO instants.
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const itemsWithLiveState = useMemo(
    () => data.items.map((it) => ({ ...it, state: deriveClientState(it, now) })),
    [data.items, now],
  );

  return (
    <section className="spectre-mc-rail-card spectre-mc-commitments" aria-label="Today's commitments" data-testid="todays-commitments">
      <div className="spectre-mc-rail-head">
        <span className="t">Today&rsquo;s commitments</span>
        {data.outlookEventCount + data.spectreCommitmentCount > 0 ? (
          <span className="a" data-testid="commitments-count">{data.outlookEventCount + data.spectreCommitmentCount}</span>
        ) : null}
      </div>

      {hasItems ? (
        <ol className="spectre-mc-commitments-list" data-testid="commitments-list">
          {itemsWithLiveState.map((it) => (
            <CommitmentRow key={it.key} it={it} />
          ))}
        </ol>
      ) : (
        <EmptyState consent={consent} />
      )}

      {consent === "MAIL_ONLY" || consent === "PERMISSION_MISSING" ? (
        <CalendarConsentHint consent={consent} />
      ) : null}
    </section>
  );
}

// Sprint 3 · Checkpoint 16H — per-row rendering with temporal-state
// class. `.is-past` = faded + strikethrough (see globals.css).
// Never removes the item from the DOM or from the accessibility tree.
function CommitmentRow({ it }: { it: TodayCommitment }) {
  const past = it.state === "PAST";
  return (
    <li
      className={`spectre-mc-commitment-row${past ? " is-past" : ""}${it.state === "IN_PROGRESS" ? " is-in-progress" : ""}`}
      data-testid={`commitment-${it.source.toLowerCase()}`}
      data-state={it.state}
    >
      <div className="spectre-mc-commitment-time">{it.timeLabel}</div>
      <div className="spectre-mc-commitment-body">
        <div className="spectre-mc-commitment-title">
          {it.title}
          {past ? (
            <span className="spectre-mc-visually-hidden"> (past appointment)</span>
          ) : null}
        </div>
        <div className="spectre-mc-commitment-source">{it.sourceLabel}</div>
        {it.locationSummary ? (
          <div className="spectre-mc-commitment-meta">{it.locationSummary}</div>
        ) : null}
      </div>
    </li>
  );
}

function EmptyState({ consent }: { consent: TodayCommitmentsSnapshot["calendarConsent"] }) {
  if (consent === "CONNECTED") {
    return (
      <p className="spectre-mc-commitments-empty" data-testid="commitments-empty-connected">
        No appointments or proposed follow-ups for today.
      </p>
    );
  }
  if (consent === "MAIL_ONLY" || consent === "PERMISSION_MISSING") {
    return (
      <p className="spectre-mc-commitments-empty" data-testid="commitments-empty-permission">
        No proposed follow-ups for today.
      </p>
    );
  }
  return (
    <p className="spectre-mc-commitments-empty" data-testid="commitments-empty-disconnected">
      No proposed follow-ups for today.
    </p>
  );
}

function CalendarConsentHint({ consent }: { consent: "MAIL_ONLY" | "PERMISSION_MISSING" }) {
  // Sprint 3 · Checkpoint 16G §14 — restrained hint. Never describes
  // Outlook as fully disconnected when the mailbox itself is connected.
  const msg = consent === "MAIL_ONLY"
    ? "Calendar view isn't enabled for this mailbox yet."
    : "Calendar view isn't available right now.";
  return (
    <div className="spectre-mc-commitments-hint" data-testid="calendar-consent-hint">
      <span>{msg}</span>
      <Link href="/app/admin/settings/connected-accounts" className="spectre-mc-commitments-hint-link">
        Manage connected accounts →
      </Link>
    </div>
  );
}
