// Mission Control — production Foundation v1.0 (2026-07-18).
//
// Founder-approved design: `public/design-concepts/mission-control/
// variant-d-instrument.html` (Variant D — Professional Instrument).
//
// Architecture:
//   • This page renders inside the Spectre chrome branch of AdminShell
//     via the `/app/admin` entry in `SPECTRE_MODE_EXACT_URLS`. Sub-routes
//     (`/app/admin/members`, `/app/admin/coa`, …) continue to render on
//     legacy chrome — Mission Control is scoped to the exact URL only.
//   • Data is sourced from `loadMissionControlSnapshot()` in
//     `src/lib/mission-control/index.ts`. Every displayed value is a
//     real Prisma query at request time. If a section has no real
//     source yet (calendar-backed commitments, cross-domain automation
//     ledger), that section is deliberately OMITTED — never populated
//     with placeholder data.

import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { getActiveBranding } from "@/lib/branding";
import { prisma } from "@/lib/prisma";
import { loadMissionControlSnapshot, type WorkItem } from "@/lib/mission-control";
import MissionControlConnectPrompt, { loadMissionControlConnectPromptSpec } from "@/components/mailbox/MissionControlConnectPrompt";
import EmailIntakeCard, { type EmailFeedCardData } from "@/components/mission-control/EmailIntakeCard";
import IntelligenceReviewCard from "@/components/mission-control/IntelligenceReviewCard";
import MissionControlLiveRefresh from "@/components/mission-control/MissionControlLiveRefresh";
import FeedSyncedStatusPill from "@/components/mission-control/FeedSyncedStatusPill";
import TodaysCommitments from "@/components/mission-control/TodaysCommitments";
import { loadFeedSyncedStatus } from "@/lib/mission-control/feed-synced-status";
import { computeTimelineMarkers } from "@/lib/mission-control/timeline-markers";

export const dynamic = "force-dynamic";

export default async function MissionControlPage({
  searchParams,
}: {
  searchParams?: { view?: string };
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId(user);

  const branding = await getActiveBranding();
  const clubName = branding.mode === "club"
    ? branding.wordmark
    : (user.club?.name ?? (await prisma.club.findFirst({ where: { id: clubId } }))?.name ?? "");

  // Sprint 3 Checkpoint 15I — history-filter toggle. `?view=history`
  // shows only RESOLVED items so the operator can review completed
  // work without repopulating the default active queue.
  const view: "active" | "history" = searchParams?.view === "history" ? "history" : "active";

  const snapshot = await loadMissionControlSnapshot(principal, clubId, { feedFilter: view });
  const connectPrompt = await loadMissionControlConnectPromptSpec({ principal, clubId });
  // Sprint 3 · Checkpoint 15M — Feed Synced header pill (replaces
  // the removed "Connected accounts" sidebar entry).
  const feedSyncedStatus = await loadFeedSyncedStatus(clubId, principal.id);

  const firstName = user.name?.split(" ")[0] ?? "there";
  const greetingWord = greetingForHour(snapshot.syncedAt);

  // Sprint 3 · Checkpoint 16G Stage A — use the club's configured
  // IANA timezone (snapshot.clubTimezone), never a hardcoded fallback.
  // Time-zone-name = "short" emits the correct abbreviation for the
  // current instant (MDT / MST / EST etc.) instead of the previous
  // hardcoded "EDT".
  const clubTz = snapshot.clubTimezone.ianaZone;
  const dateLabel = snapshot.syncedAt.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
    timeZone: clubTz,
  });
  const timeParts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit", minute: "2-digit", hour12: false,
    timeZoneName: "short", timeZone: clubTz,
  }).formatToParts(snapshot.syncedAt);
  const tzAbbrev = timeParts.find((p) => p.type === "timeZoneName")?.value ?? "";
  const hh = timeParts.find((p) => p.type === "hour")?.value ?? "";
  const mm = timeParts.find((p) => p.type === "minute")?.value ?? "";
  const timeLabel = `${hh}:${mm} ${tzAbbrev}`;

  const stateAttention = snapshot.briefing.needJudgment > 0;

  return (
    <div>
      {/* Header line — greeting + date/sync ---------------------- */}
      <div className="spectre-mc-header">
        <h1 className="spectre-mc-greeting">
          {greetingWord}, {firstName}.
          {clubName ? <span className="club">{clubName}</span> : null}
        </h1>
        <div className="spectre-mc-header-meta">
          <span className="date">{dateLabel} · {timeLabel}</span>
          <FeedSyncedStatusPill status={feedSyncedStatus} />
          <MissionControlLiveRefresh
            initialWorkItemIds={snapshot.workItems.map((w) => w.id).sort()}
            initialSyncedAt={snapshot.syncedAt.toISOString()}
          />
        </div>
      </div>

      {/* State line — one-sentence orientation ------------------- */}
      {/* Sprint 3 · Checkpoint 16G Stage A — the overnight sentence
          is composed by the loader from the actual analysis window;
          the page renders it verbatim so English can never drift
          from the underlying numbers. */}
      <div className={`spectre-mc-state${stateAttention ? " spectre-mc-state--attention" : ""}`}>
        <span className="dot" />
        <StateSentence
          overnightSentence={snapshot.overnight.sentence}
          judgment={snapshot.briefing.needJudgment}
        />
      </div>

      {/* Executive briefing — instrument-panel readout ----------- */}
      {/* Sprint 3 · Checkpoint 16G Stage A — sublabel now describes
          what the metric actually measures ("received since midnight"
          in the club's local timezone), replacing the misleading
          "in the last 24 hours" text under a calendar-day count. */}
      <section className="spectre-mc-briefing" aria-label="Overnight briefing">
        <BriefingCell
          state="arrived"
          label="Arrived today"
          value={snapshot.briefing.arrivedToday}
          sublabel="received since midnight"
        />
        <BriefingCell
          state="auto"
          label="Completed automatically"
          value={snapshot.briefing.completedAutomatically}
          sublabel="already resolved"
        />
        <BriefingCell
          state="approval"
          label="Ready for approval"
          value={snapshot.briefing.readyForApproval}
          sublabel={snapshot.briefing.readyForApproval > 0 ? "requires sign-off" : "queue is clear"}
        />
        <BriefingCell
          state="judgment"
          label="Need judgment"
          value={snapshot.briefing.needJudgment}
          sublabel={snapshot.briefing.needJudgment > 0 ? "policy exception" : "queue is clear"}
        />
        <BriefingCell
          state="info"
          label="Informational"
          value={snapshot.briefing.informational}
          sublabel="no action required"
        />
      </section>

      {/* Feed + rail --------------------------------------------- */}
      <div className="spectre-mc-grid">
        <section>
          <div className="spectre-mc-feed-head">
            {/* Sprint 3 · Checkpoint 16H §1 — visible feed header
                renamed "Work intake" → "Work Intake Feed". Internal
                types/models keep the WorkIntakeItem name. */}
            <h2>
              Work Intake Feed
              <span className="count">· {snapshot.workItems.length} item{snapshot.workItems.length === 1 ? "" : "s"}</span>
            </h2>
            <div className="controls">
              {/* Sprint 3 Checkpoint 15I — Active / Completed toggle.
                  Server-rendered — the loader re-projects based on
                  ?view=history. */}
              <Link
                href="/app/admin"
                className={`spectre-mc-chip${view === "active" ? " on" : ""}`}
                data-testid="feed-view-active"
              >
                <span className="k">View:</span><span className="v">Active</span>
              </Link>
              <Link
                href="/app/admin?view=history"
                className={`spectre-mc-chip${view === "history" ? " on" : ""}`}
                data-testid="feed-view-history"
              >
                <span>Completed history</span>
              </Link>
            </div>
          </div>

          {snapshot.workItems.length === 0 ? (
            <div className="spectre-mc-item" style={{ padding: "20px 24px", borderLeftColor: "var(--spectre-status-success)" }}>
              <div className="spectre-mc-item-head">
                <span className="spectre-mc-pill approval">All clear</span>
              </div>
              <h3>Your Work Intake Feed is empty right now.</h3>
              {/* Sprint 3 · Checkpoint 16G Stage A — empty-state copy
                  no longer claims Spectre processed overnight items
                  when the queue may have simply had nothing to process. */}
              <p className="spectre-mc-work">Nothing requires your judgment or approval at the moment.</p>
            </div>
          ) : (
            (() => {
              // Sprint 3 · Checkpoint 16H rejection (2026-08-06) —
              // Completed History timeline separators (§16). Only
              // rendered in history view; active view keeps the
              // existing arrival-based flow unbroken.
              const markers = view === "history"
                ? computeTimelineMarkers(snapshot.workItems, clubTz, snapshot.syncedAt)
                : snapshot.workItems.map(() => null);
              return snapshot.workItems.map((item, idx) => {
                const card = item.emailMessageId ? (
                  <EmailIntakeCard key={item.id} data={emailFeedData(item)} />
                ) : item.classification === "AP_INVOICE_REVIEW" ? (
                  <IntelligenceReviewCard key={item.id} data={item} kind="AP_INVOICE_REVIEW" />
                ) : item.classification === "VENDOR_STATEMENT_REVIEW" ? (
                  <IntelligenceReviewCard key={item.id} data={item} kind="VENDOR_STATEMENT_REVIEW" />
                ) : (
                  <FeedItem key={item.id} item={item} />
                );
                const marker = markers[idx];
                if (!marker) return card;
                return (
                  <div key={`marker-group-${marker.key}-${item.id}`}>
                    <div
                      className="spectre-mc-timeline-marker"
                      role="separator"
                      data-testid="mc-timeline-marker"
                      data-marker-key={marker.key}
                    >
                      <span className="spectre-mc-timeline-marker-label">{marker.label}</span>
                      <span className="spectre-mc-timeline-marker-rule" aria-hidden="true" />
                    </div>
                    {card}
                  </div>
                );
              });
            })()
          )}
        </section>

        <aside className="spectre-mc-rail" aria-label="Executive rail">
          {/* Today's Position -------------------------------------- */}
          <section className="spectre-mc-rail-card">
            <div className="spectre-mc-rail-head">
              <span className="t">Today&rsquo;s position</span>
              <Link href="/app/admin/finance" className="a">View ledger →</Link>
            </div>
            <PositionRow label="Member AR"           value={fmtMoney(snapshot.position.memberARCurrent)} />
            <PositionRow
              label="Over 60 days"
              value={fmtMoney(snapshot.position.memberAROver60)}
              flag={snapshot.position.over60Flagged ? { text: "policy 60", tone: "warn" } : undefined}
            />
            <PositionRow label="Tee times today"      value={String(snapshot.position.teeTimesToday)} />
            <PositionRow label="Reservations tonight" value={String(snapshot.position.reservationsTonight)} />
            <PositionRow label="Covers projected"     value={String(snapshot.position.reservationsCovers)} />
          </section>

          {/* Sprint 2 B3 (2026-07-19) — Optional Outlook connect prompt.
                Only renders when the current user has no active
                personal mailbox connection AND the feature is on AND
                the user has connect permission. Explicitly secondary
                — placed below the operational cards, above the
                Executive Insight, so it never dominates the rail. */}
          {connectPrompt?.visible && (
            <MissionControlConnectPrompt
              headline={connectPrompt.headline}
              copy={connectPrompt.copy}
              connectHref={connectPrompt.connectHref}
            />
          )}

          {/* Executive Insight ------------------------------------- */}
          <section className="spectre-mc-rail-card spectre-mc-insight">
            <div className="spectre-mc-rail-head">
              <span className="t">Executive insight</span>
              <Link href="/app/admin/reporting/monthly" className="a">More →</Link>
            </div>
            <p>{snapshot.insight.narrative}</p>
            <div className="src">
              <SourceIcon />
              Source: <Link href="/app/admin/collections">{snapshot.insight.source}</Link> · {snapshot.insight.sourceTimeLabel}
            </div>
          </section>

          {/* Sprint 3 · Checkpoint 16G Stage E — Today's Commitments.
              Beneath Executive Insight per the approved Mission Control
              concept. Real Outlook events + Spectre-proposed deadlines. */}
          <TodaysCommitments data={snapshot.todaysCommitments} />
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small stateless renderers
// ---------------------------------------------------------------------------

function greetingForHour(d: Date): string {
  const h = d.getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

// Sprint 2 Checkpoint 14C — pack a WorkItem into the props shape the
// EmailIntakeCard client component consumes. Only called when
// item.emailMessageId is defined (i.e. the item is email-derived).
//
// C14C revision: no "detailHref" (Open detail was removed), no
// raw email preview (synopsisText + evidence replace it), and card
// actions carry Spectre icons.
function emailFeedData(item: WorkItem): EmailFeedCardData {
  const workIntakeItemId = item.workIntakeItemId ??
    (item.id.startsWith("wi_") ? item.id.slice(3) : item.id);
  const cardState: EmailFeedCardData["state"] =
    item.state === "info" ? "info" : item.state === "judgment" ? "judgment" : "comm";
  return {
    workIntakeItemId,
    emailMessageId: item.emailMessageId as string,
    state: cardState,
    idTag: item.idTag,
    situationTitle: item.title,
    contextLine: item.sender.from,
    timestampLabel: item.timestampLabel,
    synopsisText: item.synopsisText ?? "",
    evidence: (item.evidence ?? []) as EmailFeedCardData["evidence"],
    recommendation: item.recommendation,
    isUnread: !!item.isUnread,
    isHighImportance: !!item.isHighImportance,
    conversationMessageCount: item.conversationMessageCount ?? 1,
    // Sprint 3 Checkpoint 15I — the Variant D card synthesises its
    // own queue-level actions (Resolve) from workIntakeStatus. Domain
    // actions (Reply, view PDF, approve) live inside the expanded
    // tabs. The loader's actions array is intentionally NOT passed
    // through — the card contract is queue-first.
    workIntakeStatus: item.workIntakeStatus,
    // Sprint 3 Checkpoint 15H Unified Remediation — attached
    // intelligence facets (invoice / statement child intakes) so the
    // email card can render them as tabs instead of separate cards.
    linkedIntelligence: item.linkedIntelligence,
    // Sprint 3 · Checkpoint 16G Stage B/D (2026-08-04) — work-domain
    // taxonomy propagated to the card renderer.
    workDomain: item.workDomain,
    workIntent: item.workIntent,
    workSubtype: item.workSubtype,
  };
}

function fmtMoney(n: number): { whole: string; cents: string } {
  const abs = Math.abs(n);
  const cents = (abs % 1).toFixed(2).slice(1);
  const whole = Math.floor(abs).toLocaleString("en-US");
  return { whole: `${n < 0 ? "-" : ""}$${whole}`, cents };
}

// Sprint 3 · Checkpoint 16G Stage A — the overnight sentence is
// authored by the loader (`overnight.sentence` from
// composeOvernightSentence). This component only decorates it with
// the running-state opener that depends on judgment count.
function StateSentence({
  overnightSentence, judgment,
}: { overnightSentence: string; judgment: number; }) {
  const running = judgment === 0
    ? "Everything is running normally."
    : `${judgment} item${judgment === 1 ? "" : "s"} need${judgment === 1 ? "s" : ""} your judgment.`;
  return (<><b>{running}</b> {overnightSentence}</>);
}

function BriefingCell({
  state, label, value, sublabel,
}: {
  state: "arrived" | "auto" | "approval" | "judgment" | "info";
  label: string; value: number; sublabel: string;
}) {
  return (
    <button className={`cell ${state}`} type="button">
      <div className="k"><span className="swatch" />{label}</div>
      <div className="v">{value}</div>
      <div className="s">{sublabel}</div>
    </button>
  );
}

function PositionRow({
  label, value, flag,
}: {
  label: string;
  value: string | { whole: string; cents: string };
  flag?: { text: string; tone: "warn" | "ok" };
}) {
  const isMoney = typeof value !== "string";
  return (
    <div className="spectre-mc-rail-row">
      <span className="k">{label}</span>
      <span className="v">
        {isMoney ? (
          <>{value.whole}<span className="cents">{value.cents}</span></>
        ) : (
          value
        )}
        {flag ? (
          <span className={`flag${flag.tone === "ok" ? " ok" : ""}`}>{flag.text}</span>
        ) : null}
      </span>
    </div>
  );
}

// Sprint 3 Checkpoint 15H Remediation (2026-07-25) — work-type
// eyebrow label helpers. Every card renders one so email / AP / AR /
// statement / vendor / general cards are distinguishable in one glance.
function feedItemWorkTypeSlug(item: WorkItem): string {
  if (item.classification === "AR_AGING_60" || item.classification === "AR_AGING_90" || item.classification === "AR_AGING_120") return "ar-collections";
  if (item.classification === "AP_INVOICE_REVIEW") return "ap-invoice";
  if (item.classification === "VENDOR_STATEMENT_REVIEW") return "vendor-statement";
  if (item.classification === "VENDOR_CONSOLIDATION_REVIEW") return "vendor-review";
  if (item.idTag.startsWith("AP-")) return "ap-invoice";
  if (item.idTag.startsWith("AR-")) return "ar-collections";
  return "general";
}
function feedItemWorkTypeLabel(item: WorkItem): string {
  const slug = feedItemWorkTypeSlug(item);
  return slug === "ap-invoice" ? "AP INVOICE"
    : slug === "ar-collections" ? "AR COLLECTIONS"
    : slug === "vendor-statement" ? "VENDOR STATEMENT"
    : slug === "vendor-review" ? "VENDOR REVIEW"
    : "GENERAL INFORMATION";
}

function FeedItem({ item }: { item: WorkItem }) {
  const primary  = item.actions.find((a) => a.kind === "primary");
  const secondary = item.actions.filter((a) => a.kind === "secondary");
  const tertiary = item.actions.filter((a) => a.kind === "tertiary");

  return (
    <article className={`spectre-mc-item ${item.state}`}>
      <div className="spectre-mc-item-head">
        <span className={`spectre-mc-worktype spectre-mc-worktype--${feedItemWorkTypeSlug(item)}`}>
          {feedItemWorkTypeLabel(item)}
        </span>
        <span className={`spectre-mc-pill ${item.state}`}>{PILL_LABEL[item.state]}</span>
        <span className="spectre-mc-id-tag">{item.idTag}</span>
        {item.flag ? <span className="spectre-mc-flag">{FLAG_LABEL[item.flag]}</span> : null}
        <span className="spectre-mc-ts">{item.timestampLabel}</span>
      </div>
      <h3>{item.title}</h3>
      {item.sender ? (
        <div className="spectre-mc-sender">
          <span className="from">{item.sender.from}</span>
          {item.sender.ctx ? (<><span className="sep">·</span><span>{item.sender.ctx}</span></>) : null}
        </div>
      ) : null}
      {item.work ? (
        <p className="spectre-mc-work" dangerouslySetInnerHTML={{ __html: item.work }} />
      ) : null}
      {item.readout && item.readout.length > 0 ? (
        <div className="spectre-mc-readout">
          {item.readout.map((c) => (
            <div key={c.key} className="cell">
              <div className="k">{c.label}</div>
              <div className={`v ${c.tone === "observation" ? "observation" : c.tone === "confidence" ? "confidence" : ""}`.trim()}>
                {c.value}
                {c.cents ? <span className="cents">{c.cents}</span> : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {item.recommendation ? (
        <div className="spectre-mc-rec">
          <span className="k">Recommended</span>
          <span className="v">{item.recommendation}</span>
        </div>
      ) : null}
      <div className="spectre-mc-actions">
        {primary ? (
          primary.href ? (
            <Link href={primary.href} className="spectre-btn spectre-btn--primary">
              <CheckIcon />
              {primary.label}
            </Link>
          ) : (
            <button type="button" className="spectre-btn spectre-btn--primary">
              <CheckIcon />
              {primary.label}
            </button>
          )
        ) : null}
        {secondary.map((a) => (
          a.href ? (
            <Link key={a.key} href={a.href} className="spectre-btn spectre-btn--secondary">{a.label}</Link>
          ) : (
            <button key={a.key} type="button" className="spectre-btn spectre-btn--secondary">{a.label}</button>
          )
        ))}
        {tertiary.map((a) => (
          a.href ? (
            <Link key={a.key} href={a.href} className="spectre-btn spectre-btn--ghost">{a.label}</Link>
          ) : (
            <button key={a.key} type="button" className="spectre-btn spectre-btn--ghost">{a.label}</button>
          )
        ))}
      </div>
    </article>
  );
}

const PILL_LABEL: Record<WorkItem["state"], string> = {
  judgment: "Needs judgment",
  approval: "Ready for approval",
  comm:     "Communication required",
  auto:     "Completed automatically",
  info:     "Informational",
};

const FLAG_LABEL: Record<NonNullable<WorkItem["flag"]>, string> = {
  "policy-exception": "Policy exception",
  "policy-threshold": "Policy threshold",
};

// ---------------------------------------------------------------------------
// Inline SVG icons — one monochrome family (matches Variant D)
// ---------------------------------------------------------------------------

const SVG_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.9,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function CheckIcon()  { return <svg {...SVG_PROPS} strokeWidth={2.2} width="12" height="12"><path d="M5 12l5 5L20 7" /></svg>; }
function SortIcon()   { return <svg {...SVG_PROPS} width="11" height="11"><path d="M4 6h16" /><path d="M7 12h10" /><path d="M10 18h4" /></svg>; }
function FilterIcon() { return <svg {...SVG_PROPS} width="11" height="11"><path d="M4 5h16l-6 8v6l-4-2v-4z" /></svg>; }
function ClockIcon()  { return <svg {...SVG_PROPS} width="11" height="11"><circle cx="12" cy="12" r="9" /><path d="M12 8v5l3 2" /></svg>; }
function SourceIcon() { return <svg {...SVG_PROPS} width="11" height="11"><path d="M4 6h16" /><path d="M4 12h10" /><path d="M4 18h13" /></svg>; }
