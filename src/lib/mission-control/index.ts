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

export type MissionControlSnapshot = {
  briefing: BriefingCounts;
  workItems: WorkItem[];
  position: Position;
  insight: Insight;
  syncedAt: Date;
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
        from: acc.member?.email ?? "ar@silversprings.club",
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
): Promise<BriefingCounts> {
  const readyForApproval = workItems.filter((w) => w.state === "approval").length;
  const needJudgment     = workItems.filter((w) => w.state === "judgment").length;
  const informational    = workItems.filter((w) => w.state === "info").length;

  // "Completed automatically" today: posted AP invoices since 00:00 that were
  // approved without human intervention. Approximated by counting POSTED
  // invoices with `postedAt` in today's window — an underestimate that never
  // over-claims automation credit.
  const today = startOfDay(new Date());
  const completedAutomatically = await prisma.aPInvoice.count({
    where: {
      ...tenantWhere(principal, clubId),
      status: "POSTED",
      postedAt: { gte: today },
    },
  }).catch(() => 0);

  const arrivedToday = workItems.length + completedAutomatically;

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

function buildInsight(position: Position, workItems: WorkItem[], syncedAt: Date): Insight {
  const overdueCount = workItems.filter((w) => w.id.startsWith("ar-")).length;
  const overdueTotal = position.memberAROver60;

  const timeLabel = syncedAt.toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", hour12: false,
    timeZone: "America/New_York",
  }) + " EDT";

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
  for (const item of workItems) {
    if (!item.workIntakeItemId) continue;
    item.viewerHasRead = readSet.has(item.workIntakeItemId);
    // The card's isUnread flag now reflects the per-user state.
    // The prior EmailMessage.isRead-derived value is superseded.
    item.isUnread = !item.viewerHasRead;
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
  const visibleWorkItems: WorkItem[] = feedFilter === "history"
    ? workItems.filter((w) => w.workIntakeStatus === "RESOLVED" || w.state === "auto")
    : workItems.filter((w) => w.workIntakeStatus !== "RESOLVED");

  const [briefing, position] = await Promise.all([
    loadBriefingCounts(principal, clubId, workItems),
    loadPosition(principal, clubId),
  ]);

  const insight = buildInsight(position, visibleWorkItems, now);

  return { briefing, workItems: visibleWorkItems, position, insight, syncedAt: now };
}
