// Mission Control — data aggregation service. Foundation v1.0 (2026-07-18).
//
// The founder-approved Mission Control home surface at `/app/admin` renders
// three regions of live club state:
//
//   1. an executive briefing (five instrument-panel cells) — counts of
//      today's incoming work by disposition;
//   2. a Work Intake feed — the actual pending items requiring the
//      operator's attention, sourced from real domain services;
//   3. an executive rail — Today's Position (current AR / cash / tee /
//      dining state) + Executive Insight (a narrative derived from those
//      numbers) + Today's Commitments (in-app committee/board deadlines).
//
// This file is the single query surface the page RSC consumes.
//
// Data-integrity contract (per the founder's no-placeholder rule):
//   • Every value on the screen is sourced from Prisma at request time.
//   • If a domain service does not exist yet (payroll batches, calendar-
//     backed commitments), the corresponding feed section is OMITTED
//     from the response — never populated with placeholder data.
//   • Tenant-scoped everywhere via `tenantWhere` + explicit `clubId`.

import { prisma } from "@/lib/prisma";
import { tenantWhere } from "@/lib/services/tenant";
import type { Principal } from "@/lib/rbac";
import type { LinkedIntelligenceForEmail } from "./intelligence-review-intakes";
export type { ApInvoiceCardIntelligence, LinkedIntelligenceForEmail } from "./intelligence-review-intakes";
// Sprint 3 · Checkpoint 16G Stage A — canonical timezone-aware helpers.
import {
  toLocalDateString, startOfLocalDayUtc, todayLocalDateString,
} from "./arrival";
import { overnightWindow, composeOvernightSentence, type OvernightPreparationSummary } from "./overnight-preparation";

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

export type WorkItemState = "judgment" | "approval" | "comm" | "auto" | "info";

export type WorkItemAction = {
  key: string;
  label: string;
  href?: string;
  kind: "primary" | "secondary" | "tertiary";
  // Sprint 2 Checkpoint 14C additions — enable icon-bearing action
  // buttons + inline click behaviour (used only by email-derived
  // items; AP/AR/system items ignore these fields).
  iconKey?: "mail" | "reply" | "edit" | "clock" | "check" | "user-plus" | "send";
  disabledReason?: string;
  onClickAction?: "expand-view" | "expand-reply" | "expand-both";
};

export type WorkItemEvidenceCell = {
  label: "VENDOR" | "INVOICE" | "AP STATUS" | "AMOUNT";
  value: string;
  state: "found" | "ambiguous" | "not_found" | "not_extracted" | "extracted" | "duplicate" | "no_data";
};

export type WorkItemReadoutCell = {
  key: string;
  label: string;
  value: string;
  cents?: string;
  tone?: "default" | "observation" | "confidence";
};

export type WorkItem = {
  id: string;
  state: WorkItemState;
  idTag: string;                    // e.g. AP-8241, AR-3391
  flag?: "policy-exception" | "policy-threshold";
  title: string;
  sender: { from: string; ctx?: string };
  timestamp: string;                // ISO or relative-friendly string
  timestampLabel: string;           // "42 min ago", "1 hr ago", "05:15 EDT"
  work?: string;                    // rendered as prose in the feed
  readout?: WorkItemReadoutCell[];
  recommendation?: string;
  actions: WorkItemAction[];
  // Sprint 2 Checkpoint 14B — email-derived items only. When
  // `emailMessageId` is present, Mission Control renders the item
  // via <EmailIntakeCard> (client component) with an inline
  // original-email panel and a reply composer instead of the
  // legacy <FeedItem> renderer. AP/AR/system items omit these.
  emailMessageId?: string;
  isUnread?: boolean;
  isHighImportance?: boolean;
  // Sprint 2 Checkpoint 14C — the loader now composes a structured
  // operational synopsis from the deterministic invoice-analysis
  // pipeline. The card renders `synopsisText` and `evidence` in
  // place of the raw email preview. `workIntakeItemId` is the
  // canonical WorkIntakeItem the card represents (used by the
  // conversation-thread API). `conversationMessageCount` lets the
  // card show a "2 messages in this conversation" badge when > 1.
  workIntakeItemId?: string;
  synopsisText?: string;
  evidence?: WorkItemEvidenceCell[];
  conversationMessageCount?: number;
  // Sprint 3 Checkpoint 15H — classification the MC page uses to pick
  // the right review-pane card renderer. Optional so legacy AP/AR feed
  // items without a review pane continue to fall through to <FeedItem>.
  classification?:
    | "AP_INVOICE_REVIEW"
    | "VENDOR_STATEMENT_REVIEW"
    | "AR_AGING_60" | "AR_AGING_90" | "AR_AGING_120"
    | "VENDOR_CONSOLIDATION_REVIEW";
  // Sprint 3 Checkpoint 15H Remediation (2026-07-25) — canonical
  // intake-arrival timestamp. The MC page sorts the merged feed
  // reverse-chronological on this ISO string. Each loader picks the
  // most authoritative source: source email receivedAt → ingested
  // document receivedAt → WorkIntakeItem.createdAt. NEVER database ID
  // and NEVER materializer execution order.
  sortTimestamp?: string; // ISO date-time
  // Sprint 3 Checkpoint 15H Unified Remediation (2026-07-25) —
  // Linked intelligence attached to an email-derived Work Intake:
  // when an inbound email has invoice / statement attachments that
  // materialised their own operational review intakes, they are
  // surfaced INSIDE the parent email card as tab facets rather than
  // as separate feed cards. The child WorkIntakeItems still exist in
  // the DB (evidence + reviewer decisions preserved) — they are
  // suppressed at feed-render time and rendered inside the parent's
  // tabs. Standalone uploads without an email origin keep their own
  // cards (see loader logic).
  // Sprint 3 Checkpoint 15I-2 (2026-07-27) — the invoiceSummary
  // shape is now the typed ApInvoiceCardIntelligence exported from
  // intelligence-review-intakes. The Variant D AP card consumes it
  // directly; the previous inline scaffold has been replaced.
  linkedIntelligence?: LinkedIntelligenceForEmail;
  // Sprint 3 Checkpoint 15I (2026-07-26) — per-user read state
  // projected by the loader from WorkIntakeItemRead. True when the
  // viewer has clicked-open this card at least once. The card's
  // isUnread flag mirrors !viewerHasRead. Loading the feed does NOT
  // flip this — only the click-to-expand action does.
  viewerHasRead?: boolean;
  // Live WorkIntakeItem.status ("OPEN" | "IN_PROGRESS" | "DEFERRED" |
  // "RESOLVED" | "INFORMATIONAL" | "SUPPRESSED"). Populated when the
  // item was materialised on the WorkIntakeItem canonical table. Some
  // loader-only paths (ap-adapter, ar-adapter) leave this undefined.
  workIntakeStatus?: string;
  // Sprint 3 · Checkpoint 16G Stage B/D (2026-08-04) — work-domain
  // taxonomy propagated to the renderer. The card picks its field
  // grid, primary action, and tab set by workDomain — never by the
  // legacy classification string.
  workDomain?: string;
  workIntent?: string;
  workSubtype?: string;
  workDomainConfidence?: number;
  // Sprint 3 · Checkpoint 16H rejection (2026-08-06) — canonical
  // WorkIntakeItem.createdAt (ISO). Completed History orders by this
  // (§15) — the ORIGINAL time the item entered Spectre, not
  // resolvedAt, updatedAt, archive time, reply time, or restoration
  // time. Also drives the Edmonton-timezone timeline separators
  // (§16). Optional so loader-only rows without a canonical WI
  // (legacy AP/AR adapters) still project safely.
  workIntakeCreatedAt?: string;
};

export type BriefingCounts = {
  arrivedToday: number;
  completedAutomatically: number;
  readyForApproval: number;
  needJudgment: number;
  informational: number;
};

export type Position = {
  memberARCurrent: number;
  memberAROver60: number;
  over60Flagged: boolean;
  teeTimesToday: number;
  reservationsTonight: number;
  reservationsCovers: number;
};

export type Insight = {
  narrative: string;                // one plain-language sentence, values already inlined
  source: string;                   // "AR ageing report", "Reservations service", …
  sourceTimeLabel: string;          // "08:14 EDT"
};

// Sprint 3 · Checkpoint 16G Stage A (2026-08-04) — overnight
// preparation summary. Composed by the loader from the OvernightPrep
// helper; the page consumes `sentence` verbatim.
export type OvernightPreparationSnapshot = {
  windowStart: string;    // ISO UTC
  windowEnd: string;      // ISO UTC
  itemsAnalysed: number;
  itemsCompletedAutomatically: number;
  itemsReadyForApproval: number;
  itemsNeedingJudgment: number;
  sentence: string;
};

// Sprint 3 · Checkpoint 16G Stage A — club timezone surfaced to the
// page so the header wall-clock is not hardcoded America/New_York
// anywhere.
export type ClubTimezoneSnapshot = {
  ianaZone: string;   // resolved club timezone (fallback UTC if missing)
  configured: boolean; // true when Club.timezone was set (not fallback)
};

export type MissionControlSnapshot = {
  briefing: BriefingCounts;
  workItems: WorkItem[];
  position: Position;
  insight: Insight;
  syncedAt: Date;
  // Sprint 3 · Checkpoint 16G Stage A additions.
  overnight: OvernightPreparationSnapshot;
  clubTimezone: ClubTimezoneSnapshot;
  // Sprint 3 · Checkpoint 16G Stage E — Today's Commitments panel
  // data. Combines the connected user's real Outlook calendar events
  // with Spectre-proposed operational deadlines.
  todaysCommitments: import("./commitments").TodayCommitmentsSnapshot;
};

// -------------------------------------------------------------------------
// Small helpers
// -------------------------------------------------------------------------

function relTime(now: Date, then: Date): string {
  const diffMs = now.getTime() - then.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return then.toLocaleDateString();
}

function money(n: number): { whole: string; cents: string } {
  const abs = Math.abs(n);
  const cents = (abs % 1).toFixed(2).slice(1); // ".50"
  const whole = Math.floor(abs).toLocaleString("en-US");
  return { whole: `${n < 0 ? "-" : ""}$${whole}`, cents };
}

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}
function endOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(23, 59, 59, 999);
  return c;
}

// -------------------------------------------------------------------------
// Work-item builders — one per domain that has a real service.
// -------------------------------------------------------------------------

async function loadPendingAPInvoiceItems(
  principal: Principal,
  clubId: string,
  now: Date,
): Promise<WorkItem[]> {
  const invoices = await prisma.aPInvoice.findMany({
    where: {
      ...tenantWhere(principal, clubId),
      status: "PENDING_APPROVAL",
    },
    include: { vendor: true },
    orderBy: { invoiceDate: "desc" },
    take: 6,
  });

  return invoices.map((inv) => {
    const amountNum = Number(inv.total ?? 0);
    const { whole, cents } = money(amountNum);
    const vendorName = inv.vendor?.operatingName ?? inv.vendor?.legalName ?? "Unknown vendor";
    const invoiceLabel = inv.invoiceNumber ? `#${inv.invoiceNumber}` : `#${inv.id.slice(0, 6)}`;
    const category = inv.description ?? "Vendor invoice";
    const submitted = inv.updatedAt ?? inv.createdAt;

    const readout: WorkItemReadoutCell[] = [
      { key: "amount",  label: "Amount",  value: whole, cents },
      { key: "vendor",  label: "Vendor",  value: vendorName },
      { key: "invoice", label: "Invoice", value: invoiceLabel },
      { key: "status",  label: "Status",  value: "Pending approval" },
    ];

    return {
      id: inv.id,
      state: "approval" as const,
      idTag: `AP-${(inv.invoiceNumber ?? inv.id).toString().slice(0, 8).toUpperCase()}`,
      title: `${vendorName} invoice ${invoiceLabel} — ${whole}${cents} · ${category}`,
      sender: {
        from: inv.vendor?.email ?? `${vendorName.toLowerCase().replace(/\s+/g, ".")}@vendor`,
        ctx: `Submitted ${relTime(now, submitted)}`,
      },
      timestamp: submitted.toISOString(),
      timestampLabel: relTime(now, submitted),
      recommendation: `Approve and post ${whole}${cents} to the vendor's expense account.`,
      readout,
      actions: [
        { key: "approve", label: "Review & approve", kind: "primary",   href: `/app/admin/ap/invoices/${inv.id}` },
        { key: "reply",   label: "Reply to vendor",  kind: "secondary" },
        { key: "assign",  label: "Assign",           kind: "secondary" },
        { key: "defer",   label: "Defer 24 hr",      kind: "tertiary"  },
      ],
    };
  });
}

async function loadOverdueMemberARItems(
  principal: Principal,
  clubId: string,
  now: Date,
): Promise<WorkItem[]> {
  // Judgment items: accounts materially past due (60+ days) that a
  // policy-driven collections decision needs to be taken on.
  const accounts = await prisma.memberAccount.findMany({
    where: {
      ...tenantWhere(principal, clubId),
      OR: [
        { sixtyDayBalance: { gt: 0 } },
        { ninetyDayBalance: { gt: 0 } },
      ],
    },
    include: { member: true },
    orderBy: { ninetyDayBalance: "desc" },
    take: 4,
  });

  return accounts.map((acc) => {
    const past = Number(acc.sixtyDayBalance ?? 0) + Number(acc.ninetyDayBalance ?? 0);
    const past90 = Number(acc.ninetyDayBalance ?? 0);
    const { whole, cents } = money(past);
    const memberName = acc.member ? `${acc.member.firstName} ${acc.member.lastName}` : "Unknown member";
    const memberSinceDate = acc.member?.joinDate ?? acc.member?.createdAt ?? null;
    const memberSince = memberSinceDate ? new Date(memberSinceDate).getFullYear().toString() : "—";
    const ageBucket = past90 > 0 ? "90+ days" : "60+ days";

    return {
      id: `ar-${acc.id}`,
      state: "judgment" as const,
      idTag: `AR-${acc.id.slice(0, 6).toUpperCase()}`,
      flag: "policy-threshold" as const,
      title: `${memberName} — ${whole}${cents} outstanding · ${ageBucket}`,
      sender: {
        // Sprint 3 Checkpoint 15I-3 (2026-07-27) — removed the
        // hardcoded `ar@silversprings.club` fallback. That address
        // rendered on tenants that are not Silver Springs (e.g.
        // Coulee Ridge on staging) and misrepresented the source
        // of the AR-aging card. When the member has no email on
        // file, show the AR context explicitly instead of a
        // fabricated tenant-specific address.
        from: acc.member?.email ?? "Accounts receivable",
        ctx: `Member since ${memberSince}`,
      },
      timestamp: (acc.lastRecomputedAt ?? acc.createdAt).toISOString(),
      timestampLabel: relTime(now, acc.lastRecomputedAt ?? acc.createdAt),
      recommendation:
        past90 > 0
          ? "Ninety-day threshold met — attempt a live call before proposing a write-off."
          : "Sixty-day threshold crossed — send the standard second-notice or open a payment plan.",
      readout: [
        { key: "balance", label: "Balance",   value: whole, cents, tone: past90 > 0 ? "observation" : "default" },
        { key: "60-day",  label: "60-day",    value: money(Number(acc.sixtyDayBalance ?? 0)).whole },
        { key: "90-day",  label: "90-day",    value: money(past90).whole, tone: past90 > 0 ? "observation" : "default" },
        { key: "current", label: "Current",   value: money(Number(acc.currentBalance ?? 0)).whole },
      ],
      actions: [
        { key: "collect", label: "Open collections queue", kind: "primary",   href: "/app/admin/collections" },
        { key: "notice",  label: "Send notice",             kind: "secondary" },
        { key: "plan",    label: "Offer payment plan",      kind: "secondary" },
        { key: "defer",   label: "Defer 30 days",           kind: "tertiary"  },
      ],
    };
  });
}

// -------------------------------------------------------------------------
// Briefing counts — derived from the work items + a small direct query
// for "completed automatically" that would otherwise not be visible.
// -------------------------------------------------------------------------

async function loadBriefingCounts(
  principal: Principal,
  clubId: string,
  workItems: WorkItem[],
  clubTimezone: string,
  now: Date,
): Promise<BriefingCounts> {
  const readyForApproval = workItems.filter((w) => w.state === "approval").length;
  const needJudgment     = workItems.filter((w) => w.state === "judgment").length;
  const informational    = workItems.filter((w) => w.state === "info").length;

  // Sprint 3 · Checkpoint 16G Stage A (2026-08-04) — completedAutomatically
  // is now scoped to *today's local calendar in the club's timezone*, using
  // startOfLocalDayUtc. Previously it used server-local startOfDay, which
  // could be off by up to a full day for tenants in distant zones.
  const startOfTodayUtc = startOfLocalDayUtc(now, clubTimezone);
  const completedAutomatically = await prisma.aPInvoice.count({
    where: {
      ...tenantWhere(principal, clubId),
      status: "POSTED",
      postedAt: { gte: startOfTodayUtc },
    },
  }).catch(() => 0);

  // Sprint 3 · Checkpoint 16G Stage A (2026-08-04) — arrivedToday is
  // now a genuine time-window count: work items whose sortTimestamp
  // (canonical intake-arrival timestamp) falls within today's local
  // calendar day in the club's IANA timezone. The prior formula
  // (`workItems.length + completedAutomatically`) counted every open
  // item in the feed as an arrival regardless of when it actually
  // arrived — see 16G Phase 1 diagnostic.
  const todayLocal = todayLocalDateString(clubTimezone, now);
  const arrivedFromFeed = workItems.filter((w) => {
    const iso = w.sortTimestamp ?? w.timestamp;
    if (!iso) return false;
    const dt = new Date(iso);
    if (isNaN(dt.getTime())) return false;
    return toLocalDateString(dt, clubTimezone) === todayLocal;
  }).length;
  const arrivedToday = arrivedFromFeed + completedAutomatically;

  return {
    arrivedToday,
    completedAutomatically,
    readyForApproval,
    needJudgment,
    informational,
  };
}

// -------------------------------------------------------------------------
// Position — the executive rail's top block.
// -------------------------------------------------------------------------

async function loadPosition(principal: Principal, clubId: string): Promise<Position> {
  const today = startOfDay(new Date());
  const tomorrow = endOfDay(new Date());

  const [aggregate, teeCount, reservations] = await Promise.all([
    prisma.memberAccount.aggregate({
      where: { ...tenantWhere(principal, clubId) },
      _sum: { currentBalance: true, sixtyDayBalance: true, ninetyDayBalance: true },
    }),
    prisma.teeTime.count({
      where: {
        ...tenantWhere(principal, clubId),
        startTime: { gte: today, lte: tomorrow },
      },
    }).catch(() => 0),
    prisma.diningReservation.findMany({
      where: {
        ...tenantWhere(principal, clubId),
        reservationDate: { gte: today, lte: tomorrow },
        status: { in: ["CONFIRMED", "SEATED", "PENDING"] },
      },
      select: { partySize: true },
    }).catch(() => [] as Array<{ partySize: number | null }>),
  ]);

  const memberARCurrent = Number(aggregate._sum.currentBalance ?? 0);
  const memberAROver60 = Number(aggregate._sum.sixtyDayBalance ?? 0)
                       + Number(aggregate._sum.ninetyDayBalance ?? 0);

  const reservationsCovers = reservations.reduce((s, r) => s + (r.partySize ?? 0), 0);

  return {
    memberARCurrent,
    memberAROver60,
    over60Flagged: memberAROver60 > 0,
    teeTimesToday: teeCount,
    reservationsTonight: reservations.length,
    reservationsCovers,
  };
}

// -------------------------------------------------------------------------
// Insight — a short narrative computed from live values.
// -------------------------------------------------------------------------

function buildInsight(position: Position, workItems: WorkItem[], syncedAt: Date, clubTimezone: string = "UTC"): Insight {
  const overdueCount = workItems.filter((w) => w.id.startsWith("ar-")).length;
  const overdueTotal = position.memberAROver60;

  // Sprint 3 · Checkpoint 16G Stage A — resolve timeLabel through the
  // club's IANA timezone. No hardcoded America/New_York.
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit", minute: "2-digit", hour12: false,
    timeZoneName: "short", timeZone: clubTimezone,
  }).formatToParts(syncedAt);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const timeLabel = `${g("hour")}:${g("minute")} ${g("timeZoneName")}`;

  if (overdueCount === 0) {
    return {
      narrative:
        `Member AR is inside the sixty-day policy line. No accounts require collections judgment this morning.`,
      source: "AR ageing report",
      sourceTimeLabel: timeLabel,
    };
  }

  const { whole, cents } = money(overdueTotal);
  return {
    narrative:
      `Member AR is over the sixty-day line on ${overdueCount} account${overdueCount === 1 ? "" : "s"}` +
      ` (total ${whole}${cents}). Each account appears in the feed above with the recommended action.`,
    source: "AR ageing report",
    sourceTimeLabel: timeLabel,
  };
}

// -------------------------------------------------------------------------
// Public entrypoint.
// -------------------------------------------------------------------------

// Sprint 2 B4 (2026-07-19) — never let an email-intake load failure
// break AP/AR. The main loader wraps this in a Promise.all, and a
// rejection would collapse the whole snapshot. Wrap in a
// try-catch-return-empty.
async function loadEmailIntakeItemsSafe(principal: Principal, clubId: string, now: Date): Promise<WorkItem[]> {
  try {
    const { loadEmailIntakeItems } = await import("./email-intake");
    return await loadEmailIntakeItems({ principal, clubId, now });
  } catch {
    return [];
  }
}

// Sprint 3 Checkpoint 15I (2026-07-26) — projects per-user read state
// (via the new WorkIntakeItemRead table) onto every WorkItem before
// returning the snapshot. Loading the feed does NOT insert a read row;
// the mark-read action fires on the first click-to-expand.
async function projectViewerReadState(
  workItems: WorkItem[],
  userId: string,
): Promise<void> {
  const intakeIds = workItems
    .map((w) => w.workIntakeItemId)
    .filter((id): id is string => !!id);
  if (intakeIds.length === 0) return;
  const rows = await prisma.workIntakeItemRead.findMany({
    where: { userId, workIntakeItemId: { in: intakeIds } },
    select: { workIntakeItemId: true },
  });
  const readSet = new Set(rows.map((r) => r.workIntakeItemId));
  // Phase 4R rev-12 (2026-08-16) — Outlook is the CANONICAL read
  // state for email-backed items. The rev-10 OR-latch formula
  //   isRead = viewerHasRead || outlookIsRead
  // caused a founder-reported defect (invoice #221007): once a
  // Spectre user clicked a card, the per-user WorkIntakeItemRead
  // row PERMANENTLY overrode any later Outlook `isRead=false`.
  // Marking the email unread in Outlook did NOT bring the card
  // back to unread in Spectre.
  //
  // Rev-12 splits the read-state model by item source:
  //
  //   Email-backed item (any PRIMARY EmailWorkIntakeOrigin)
  //     canonical: EmailMessage.isRead of the newest PRIMARY email.
  //     Bidirectional — Outlook can drive read → unread → read at
  //     will; the per-user WorkIntakeItemRead row does NOT override.
  //     Optimistic UI happens in the client component (readLocal)
  //     but is reset when the server projection re-reports.
  //
  //   Non-email item (no PRIMARY EmailWorkIntakeOrigin)
  //     canonical: presence/absence of WorkIntakeItemRead row.
  //     Same as pre-rev-10 behaviour.
  //
  // `viewerHasRead` is still surfaced (some callers depend on it
  // as a projection field), but no longer participates in the
  // isUnread decision for email-backed items.
  const primaryOrigins = await prisma.emailWorkIntakeOrigin.findMany({
    where: {
      workIntakeItemId: { in: intakeIds },
      role: "PRIMARY",
    },
    select: {
      workIntakeItemId: true,
      emailMessage: { select: { isRead: true } },
    },
  });
  // Per intake: (a) does any PRIMARY email exist? (email-backed?),
  //            (b) is any PRIMARY email currently unread in Outlook?
  const hasPrimaryEmail = new Set<string>();
  const anyPrimaryUnread = new Set<string>();
  for (const origin of primaryOrigins) {
    hasPrimaryEmail.add(origin.workIntakeItemId);
    if (origin.emailMessage && origin.emailMessage.isRead === false) {
      anyPrimaryUnread.add(origin.workIntakeItemId);
    }
  }
  for (const item of workItems) {
    if (!item.workIntakeItemId) continue;
    const viewerHasRead = readSet.has(item.workIntakeItemId);
    item.viewerHasRead = viewerHasRead;
    if (hasPrimaryEmail.has(item.workIntakeItemId)) {
      // Email-backed: Outlook is authoritative. Do NOT OR with the
      // per-user click history — that reintroduces the rev-10 latch.
      item.isUnread = anyPrimaryUnread.has(item.workIntakeItemId);
    } else {
      // Non-email item: per-user click history is canonical.
      item.isUnread = !viewerHasRead;
    }
  }
}

export interface LoadMissionControlOptions {
  // "active" (default): hide RESOLVED, SUPPRESSED, and DISMISSED items —
  // matches the existing loader's implicit contract.
  // "history": show ONLY RESOLVED items so the founder can review what
  // was cleared from the queue without repopulating the default view.
  feedFilter?: "active" | "history";
}

export async function loadMissionControlSnapshot(
  principal: Principal,
  clubId: string,
  options: LoadMissionControlOptions = {},
): Promise<MissionControlSnapshot> {
  const now = new Date();
  const feedFilter = options.feedFilter ?? "active";
  // Sprint 3 · Checkpoint 16G Stage A — resolve club timezone before
  // any calendar-day arithmetic. Never default to America/New_York.
  const clubRow = await prisma.club.findUnique({
    where: { id: clubId },
    select: { timezone: true },
  });
  const clubTimezone = (clubRow?.timezone ?? "UTC").trim() || "UTC";
  const clubTimezoneSnapshot: ClubTimezoneSnapshot = {
    ianaZone: clubTimezone,
    configured: !!clubRow?.timezone,
  };
  // Sprint 3 Checkpoint 15B (2026-07-24) — AR-aging items are now
  // loaded from persisted WorkIntakeItem + WorkIntakeFinding via
  // loadArIntakeItems (read-only). The legacy ad-hoc
  // loadOverdueMemberARItems is preserved below for reference only
  // and is NO LONGER called from the snapshot loader — the persisted
  // path is authoritative.
  const { loadArIntakeItems } = await import("./ar-intake");
  // Sprint 3 Checkpoint 15H (2026-07-25) — AP-review + statement-review
  // situations are surfaced alongside the existing AP-approval, AR-aging,
  // and email flows. All read-only; materialised by the C15E / C15G CLIs.
  const {
    loadApReviewIntakeItems, loadStatementReviewIntakeItems,
    loadChildReviewIntakesToSuppress, loadLinkedIntelligenceForEmailIntakes,
  } = await import("./intelligence-review-intakes");
  // Sprint 3 Checkpoint 15H Unified Remediation (2026-07-25) —
  // Compute the set of AP + Statement intakes whose primary
  // IngestedDocument was ingested from an email attachment where a
  // canonical email intake ALREADY exists. Those children are
  // suppressed from the feed; the email card renders their analysis
  // as tabs. Standalone-upload docs (no email origin) still appear as
  // their own cards.
  const { suppressedApIntakeIds, suppressedStatementIntakeIds } = await loadChildReviewIntakesToSuppress(clubId);
  const [apItems, arItems, emailItems, apReviewItems, statementReviewItems] = await Promise.all([
    loadPendingAPInvoiceItems(principal, clubId, now),
    loadArIntakeItems({ clubId, now }),
    loadEmailIntakeItemsSafe(principal, clubId, now),
    loadApReviewIntakeItems({ clubId, now, suppressedIds: suppressedApIntakeIds }),
    loadStatementReviewIntakeItems({ clubId, now, suppressedIds: suppressedStatementIntakeIds }),
  ]);
  // Augment email items with the aggregated intelligence facets from
  // any attachment-derived AP / Statement child intakes.
  const emailIntakeIds = emailItems.map((e) => e.workIntakeItemId).filter((x): x is string => !!x);
  const linkedIntel = await loadLinkedIntelligenceForEmailIntakes({ clubId, emailIntakeIds });
  for (const item of emailItems) {
    if (item.workIntakeItemId) {
      const linked = linkedIntel.get(item.workIntakeItemId);
      if (linked) item.linkedIntelligence = linked;
    }
  }

  const { mergeWorkItems } = await import("./email-intake");
  // Sprint 3 Checkpoint 15H Remediation — canonical reverse-chronological
  // sort by intake-arrival timestamp. Sender + freshness matter to the
  // reviewer far more than "which loader produced it".
  const unsorted: WorkItem[] = [
    ...apReviewItems,
    ...statementReviewItems,
    ...mergeWorkItems({ ap: apItems, ar: arItems, email: emailItems }),
  ];
  const workItems: WorkItem[] = unsorted.sort((a, b) => {
    // Prefer explicit sortTimestamp when set. Fall back to timestamp
    // (raw ISO from the loader). Fall back finally to id lex order for
    // stability when timestamps tie.
    const at = a.sortTimestamp ?? a.timestamp ?? "";
    const bt = b.sortTimestamp ?? b.timestamp ?? "";
    if (at !== bt) return bt.localeCompare(at); // newest first
    return b.id.localeCompare(a.id);
  });

  // Sprint 3 Checkpoint 15I — per-user read state.
  await projectViewerReadState(workItems, principal.id);

  // Sprint 3 Checkpoint 15I — history filter.
  // ACTIVE (default): filter out RESOLVED so the queue stays focused
  //   on unresolved work. The underlying loader intake queries already
  //   filter status: notIn ["RESOLVED", "SUPPRESSED"], but AP-adapter
  //   and email items may include statuses outside that filter; a
  //   secondary UI-layer pass belt-and-suspenders it.
  // HISTORY: show ONLY resolved items so the operator can review the
  //   completed queue without dumping them back into the active view.
  const filteredWorkItems: WorkItem[] = feedFilter === "history"
    ? workItems.filter((w) => w.workIntakeStatus === "RESOLVED" || w.state === "auto")
    : workItems.filter((w) => w.workIntakeStatus !== "RESOLVED");

  // Sprint 3 · Checkpoint 16H rejection (2026-08-06) — Completed
  // History MUST order by WorkIntakeItem.createdAt DESC (founder
  // §15). Restoration + recompletion never change position (§17).
  // ACTIVE view keeps arrival-based sortTimestamp.
  const visibleWorkItems: WorkItem[] = feedFilter === "history"
    ? [...filteredWorkItems].sort((a, b) => {
        const at = a.workIntakeCreatedAt ?? a.sortTimestamp ?? a.timestamp ?? "";
        const bt = b.workIntakeCreatedAt ?? b.sortTimestamp ?? b.timestamp ?? "";
        if (at !== bt) return bt.localeCompare(at);
        return b.id.localeCompare(a.id);
      })
    : filteredWorkItems;

  // Sprint 3 · Checkpoint 16H rejection #3 (2026-08-06) — briefing
  // MUST derive from the SAME projected/filtered set the feed renders
  // (§12 canonical visible-work model). Previously `workItems` (the
  // raw pre-filter merge) was passed in, so RESOLVED items excluded
  // by the Active filter still inflated Needs Judgment / Informational
  // counters — the founder saw 8+2 in the summary but only 7 rendered
  // cards. The invariant is:
  //     visibleWorkItems.length ===
  //         readyForApproval + needJudgment + informational + auto
  // (arrivedToday and completedAutomatically are separate time-based
  // metrics and may overlap the buckets; they are NOT part of the
  // mutually-exclusive sum.)
  const [briefing, position] = await Promise.all([
    loadBriefingCounts(principal, clubId, visibleWorkItems, clubTimezone, now),
    loadPosition(principal, clubId),
  ]);

  const insight = buildInsight(position, visibleWorkItems, now, clubTimezone);

  // Sprint 3 · Checkpoint 16G Stage A — compose the overnight-
  // preparation snapshot honestly. Window is prev 19:00 → 07:00 local
  // (or now if pre-07:00). Counts derive from real analysis events
  // during the window — NOT from currently-open items.
  const { start, end } = overnightWindow(now, clubTimezone);
  const [analysedInWindow, autoCompletedInWindow] = await Promise.all([
    prisma.workIntakeItem.count({
      where: {
        clubId,
        lastAnalysedAt: { gte: start, lt: end },
      },
    }).catch(() => 0),
    prisma.aPInvoice.count({
      where: {
        ...tenantWhere(principal, clubId),
        status: "POSTED",
        postedAt: { gte: start, lt: end },
      },
    }).catch(() => 0),
  ]);
  const readyInWindow = visibleWorkItems.filter((w) =>
    w.state === "approval" && w.timestamp
    && new Date(w.timestamp) >= start && new Date(w.timestamp) < end,
  ).length;
  const judgmentInWindow = visibleWorkItems.filter((w) =>
    w.state === "judgment" && w.timestamp
    && new Date(w.timestamp) >= start && new Date(w.timestamp) < end,
  ).length;
  const overnight: OvernightPreparationSnapshot = {
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    itemsAnalysed: analysedInWindow,
    itemsCompletedAutomatically: autoCompletedInWindow,
    itemsReadyForApproval: readyInWindow,
    itemsNeedingJudgment: judgmentInWindow,
    sentence: composeOvernightSentence({
      itemsAnalysed: analysedInWindow,
      itemsCompletedAutomatically: autoCompletedInWindow,
      itemsReadyForApproval: readyInWindow,
      itemsNeedingJudgment: judgmentInWindow,
    }),
  };

  // Sprint 3 · Checkpoint 16G Stage E — Today's Commitments panel
  // combines real Outlook events (if consent granted) with
  // Spectre-proposed operational deadlines. Loader passes an
  // injected mailbox-accessor so the calendar client can request
  // the connected user's own calendar with their delegated token.
  const { loadTodayCommitments } = await import("./commitments");
  const todaysCommitments = await loadTodayCommitments({
    clubId, userId: principal.id, clubTimezone, now,
    loadUserMailbox: async (userId) => {
      // Sprint 3 · Checkpoint 16H (2026-08-04) — feature-flag gated.
      // Without OUTLOOK_CALENDAR_READ_ENABLED, we skip the token
      // decrypt entirely (safe default: panel shows the Spectre
      // proposals + Calendar-not-enabled state).
      const { isOutlookCalendarReadEnabled } = await import("@/lib/env");
      if (!isOutlookCalendarReadEnabled()) {
        return null;
      }
      const mb = await prisma.mailboxConnection.findFirst({
        where: { userId, clubId, status: "CONNECTED" },
        select: { id: true, grantedScopes: true },
      }).catch(() => null);
      if (!mb) return null;
      const scopes = (mb.grantedScopes ?? "").split(/\s+/).filter(Boolean);
      // If the scope isn't there, no need to attempt token decrypt.
      if (!scopes.map((s) => s.toLowerCase()).includes("calendars.read")) {
        return { grantedScopes: scopes, accessToken: null };
      }
      try {
        const { getFreshDelegatedAccessToken } = await import("@/lib/mailbox/connect");
        const tok = await getFreshDelegatedAccessToken({
          mailboxConnectionId: mb.id, callerClubId: clubId, callerUserId: userId,
        });
        return { grantedScopes: scopes, accessToken: tok.accessToken };
      } catch {
        // Token refresh failed → surface as PERMISSION_MISSING so
        // the user is nudged to reconnect; DO NOT block Mission
        // Control from rendering.
        return { grantedScopes: scopes, accessToken: null };
      }
    },
  }).catch(() => ({
    items: [], calendarConsent: "DISCONNECTED" as const,
    outlookEventCount: 0, spectreCommitmentCount: 0,
    windowStart: now, windowEnd: now,
  }));

  return {
    briefing, workItems: visibleWorkItems, position, insight, syncedAt: now,
    overnight, clubTimezone: clubTimezoneSnapshot, todaysCommitments,
  };
}
