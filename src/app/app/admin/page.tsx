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

export const dynamic = "force-dynamic";

export default async function MissionControlPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId(user);

  const branding = await getActiveBranding();
  const clubName = branding.mode === "club"
    ? branding.wordmark
    : (user.club?.name ?? (await prisma.club.findFirst({ where: { id: clubId } }))?.name ?? "");

  const snapshot = await loadMissionControlSnapshot(principal, clubId);
  const connectPrompt = await loadMissionControlConnectPromptSpec({ principal, clubId });

  const firstName = user.name?.split(" ")[0] ?? "there";
  const greetingWord = greetingForHour(snapshot.syncedAt);

  const dateLabel = snapshot.syncedAt.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
    timeZone: "America/New_York",
  });
  const timeLabel = snapshot.syncedAt.toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/New_York",
  }) + " EDT";

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
          <MissionControlLiveRefresh
            initialWorkItemIds={snapshot.workItems.map((w) => w.id).sort()}
            initialSyncedAt={snapshot.syncedAt.toISOString()}
          />
        </div>
      </div>

      {/* State line — one-sentence orientation ------------------- */}
      <div className={`spectre-mc-state${stateAttention ? " spectre-mc-state--attention" : ""}`}>
        <span className="dot" />
        <StateSentence
          arrived={snapshot.briefing.arrivedToday}
          approval={snapshot.briefing.readyForApproval}
          judgment={snapshot.briefing.needJudgment}
          auto={snapshot.briefing.completedAutomatically}
        />
      </div>

      {/* Executive briefing — instrument-panel readout ----------- */}
      <section className="spectre-mc-briefing" aria-label="Overnight briefing">
        <BriefingCell
          state="arrived"
          label="Arrived today"
          value={snapshot.briefing.arrivedToday}
          sublabel="in the last 24 hours"
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
            <h2>Work intake<span className="count">· {snapshot.workItems.length} item{snapshot.workItems.length === 1 ? "" : "s"}</span></h2>
            <div className="controls">
              <button className="spectre-mc-chip on" type="button">
                <SortIcon />
                <span className="k">Sort:</span><span className="v">Priority</span>
              </button>
              <button className="spectre-mc-chip" type="button">
                <FilterIcon />
                <span>Filter</span>
              </button>
              <button className="spectre-mc-chip" type="button">
                <ClockIcon />
                <span>Today</span>
              </button>
            </div>
          </div>

          {snapshot.workItems.length === 0 ? (
            <div className="spectre-mc-item" style={{ padding: "20px 24px", borderLeftColor: "var(--spectre-status-success)" }}>
              <div className="spectre-mc-item-head">
                <span className="spectre-mc-pill approval">All clear</span>
              </div>
              <h3>Excellent. Your work intake is empty this morning.</h3>
              <p className="spectre-mc-work">Spectre has processed every overnight item automatically. Nothing requires your judgment or approval right now.</p>
            </div>
          ) : (
            snapshot.workItems.map((item) =>
              // Sprint 2 Checkpoint 14B — email-derived items use the
              // client-side card with inline expansion (view email +
              // reply composer). AP/AR/system-generated items use the
              // legacy server-rendered FeedItem, unchanged.
              item.emailMessageId ? (
                <EmailIntakeCard key={item.id} data={emailFeedData(item)} />
              ) : item.classification === "AP_INVOICE_REVIEW" ? (
                <IntelligenceReviewCard key={item.id} data={item} kind="AP_INVOICE_REVIEW" />
              ) : item.classification === "VENDOR_STATEMENT_REVIEW" ? (
                <IntelligenceReviewCard key={item.id} data={item} kind="VENDOR_STATEMENT_REVIEW" />
              ) : (
                <FeedItem key={item.id} item={item} />
              ),
            )
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
    actions: item.actions.map((a) => ({
      key: a.key,
      label: a.label,
      kind: a.kind,
      iconKey: a.iconKey,
      disabledReason: a.disabledReason,
      onClickAction: a.onClickAction,
    })),
    // Sprint 3 Checkpoint 15H Unified Remediation — attached
    // intelligence facets (invoice / statement child intakes) so the
    // email card can render them as tabs instead of separate cards.
    linkedIntelligence: item.linkedIntelligence,
  };
}

function fmtMoney(n: number): { whole: string; cents: string } {
  const abs = Math.abs(n);
  const cents = (abs % 1).toFixed(2).slice(1);
  const whole = Math.floor(abs).toLocaleString("en-US");
  return { whole: `${n < 0 ? "-" : ""}$${whole}`, cents };
}

function StateSentence({
  arrived, approval, judgment, auto,
}: { arrived: number; approval: number; judgment: number; auto: number; }) {
  if (arrived === 0) {
    return <><b>Everything is running normally.</b> No new work arrived overnight.</>;
  }

  // The running-state opener depends on whether judgment items exist.
  // When they do, the opener already carries the judgment count, so we
  // omit judgment from the follow-up summary to avoid an echo.
  const running = judgment === 0
    ? "Everything is running normally."
    : `${judgment} item${judgment === 1 ? "" : "s"} need${judgment === 1 ? "s" : ""} your judgment.`;

  const parts: string[] = [];
  if (approval > 0) parts.push(`${approval} ready for approval`);
  if (judgment === 0 && auto > 0) parts.push(`${auto} handled automatically`);
  else if (auto > 0) parts.push(`${auto} handled automatically`);
  const summary = parts.join(", ");

  return (
    <>
      <b>{running}</b> Spectre prepared <b>{arrived}</b> item{arrived === 1 ? "" : "s"} overnight
      {summary ? <> — {summary}.</> : "."}
    </>
  );
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
