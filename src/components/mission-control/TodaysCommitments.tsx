// Sprint 3 · Checkpoint 16G Stage E (2026-08-04) — Today's
// Commitments rail panel.
//
// Server-rendered from the snapshot loader. No client state.
// Restrained agenda format — time on the left, title + secondary
// context on the right. Source distinction via a compact eyebrow
// underneath the title. Never fabricates.

import Link from "next/link";
import type { TodayCommitmentsSnapshot } from "@/lib/mission-control/commitments";

interface Props {
  data: TodayCommitmentsSnapshot;
}

export default function TodaysCommitments({ data }: Props) {
  const hasItems = data.items.length > 0;
  const consent = data.calendarConsent;

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
          {data.items.map((it) => (
            <li key={it.key} className="spectre-mc-commitment-row" data-testid={`commitment-${it.source.toLowerCase()}`}>
              <div className="spectre-mc-commitment-time">
                {it.timeLabel}
              </div>
              <div className="spectre-mc-commitment-body">
                <div className="spectre-mc-commitment-title">{it.title}</div>
                <div className="spectre-mc-commitment-source">{it.sourceLabel}</div>
                {it.locationSummary ? (
                  <div className="spectre-mc-commitment-meta">{it.locationSummary}</div>
                ) : null}
              </div>
            </li>
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
