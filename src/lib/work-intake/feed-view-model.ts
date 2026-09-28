// WI-2B (2026-09-27) — Work Intake feed view-model.
//
// Adapts the canonical `WorkItem` DTO produced by
// loadMissionControlSnapshot into the shape the WI-1 accepted feed
// presentation (`WiFeedRow`) expects. This is the ONLY place mapping
// domain state to feed presentation lives — it must not spread across
// React components.
//
// Contract:
//   - domain state       → presentation status label + tone
//   - workDomain         → feed row icon
//   - displayReceivedAt  → "Today · 11:24 AM" / "Yesterday · 4:36 PM"
//                          / weekday / date, in the club timezone
//   - id                 → deterministic /review/{id} href
//   - displayHasAttachments → single doc attachment glyph
//
// This file has NO React imports and NO Prisma imports. It only
// consumes the WorkItem DTO from the mission-control loader.

import type { WorkItem } from "@/lib/mission-control/index";
import type {
  WiFeedRow,
  WiIcon,
  WiStatusTone,
} from "@/components/work-intake/scaffold/scaffold-data";
import { formatFeedTimestamp } from "./format-feed-timestamp";

interface AdapterContext {
  clubTimezone: string;   // IANA zone (e.g. "America/Edmonton")
  nowIso?: string;        // override for tests; defaults to Date.now()
}

/** Map the canonical WorkItem.state (+ workDomain + status) to the
 *  four presentation buckets used by the accepted feed row.
 *
 *  These are the ONLY strings the feed row renders — no UI-only
 *  inference (e.g. title.includes(...)) is allowed. When state or
 *  domain is missing/unknown, we fall through to the neutral FYI
 *  tone rather than fabricating a stronger claim. */
function mapStatus(item: WorkItem): { label: string; tone: WiStatusTone } {
  // Judgment items always take precedence — the WorkItem loader has
  // already applied the founder's judgment/approval bucketing rules.
  if (item.state === "judgment") {
    return { label: "Requires your judgment", tone: "judgment" };
  }
  if (item.state === "approval") {
    // Payroll approval + AR review both use the "approval" state.
    // Payroll's language is "Needs confirmation" (see the accepted
    // WI-1 scaffold); AR / AP invoice approval reads as
    // "Ready for review".
    if (item.workDomain === "PAYROLL") {
      return { label: "Needs confirmation", tone: "confirm" };
    }
    return { label: "Ready for review", tone: "review" };
  }
  if (item.state === "info") {
    return { label: "FYI", tone: "fyi" };
  }
  // "comm" (communications) and "auto" (auto-completed) both read as
  // informational in the current feed presentation.
  return { label: "FYI", tone: "fyi" };
}

/** Map WorkIntakeItem.workDomain to the row-icon vocabulary defined
 *  by the accepted WI-1 feed. Never derive icon from display text. */
function mapIcon(item: WorkItem): WiIcon {
  const d = item.workDomain;
  if (d === "ACCOUNTS_PAYABLE") {
    // The accepted feed uses the "invoice" glyph for AP invoice
    // reviews (folder/document form) and "ap" for statement/vendor
    // consolidation reviews (mailbox/inbox form).
    if (item.classification === "AP_INVOICE_REVIEW") return "invoice";
    return "ap";
  }
  if (d === "ACCOUNTS_RECEIVABLE") return "member";
  if (d === "PAYROLL") return "payroll";
  if (d === "MEMBERSHIP") return "member";
  if (d === "COMMUNICATIONS") return "member";
  // Governance / operations / hospitality / informational / general
  // fall back to the chart glyph (used by the "Staffing variance" row
  // in the WI-1 scaffold — a broad "analytics/insight" icon).
  return "chart";
}

/** Compose the row's second-line meta string ("Vendor · $Amount" or
 *  "Sender name"). Never invent an amount when none is present. */
function composeMetaLine(item: WorkItem): string {
  // Prefer the loader's sender.ctx (which for AP items carries the
  // vendor + amount) so we don't duplicate the domain's own
  // presentation logic.
  const parts: string[] = [];
  if (item.sender.from) parts.push(item.sender.from);
  if (item.sender.ctx) parts.push(item.sender.ctx);
  return parts.join(" · ");
}

/** Compose the row's third-line description. Prefer the domain's own
 *  synopsisText (deterministic invoice-analysis pipeline output);
 *  fall back to the raw work prose. */
function composeDescription(item: WorkItem): string {
  if (item.synopsisText) return item.synopsisText;
  if (item.work) return item.work;
  // A recommendation is a domain-produced suggestion, not chatter —
  // safe to surface when nothing else is available.
  return item.recommendation ?? "";
}

/** Optional single-doc attachment glyph. We do NOT expose raw
 *  attachment lists (that belongs in the review page). The row only
 *  hints at their presence with a doc glyph.
 *
 *  Source order (never both):
 *    1. linkedIntelligence.attachmentCount — the canonical count of
 *       invoice + statement attachments derived by the intelligence
 *       loader for email-backed AP items.
 *    2. otherwise no hint (WorkItemDTO does not currently expose
 *       displayHasAttachments; row rendering is safe when omitted). */
function composeAttachments(item: WorkItem): WiFeedRow["attachments"] {
  const count = item.linkedIntelligence?.attachmentCount ?? 0;
  if (count <= 0) return undefined;
  // Up to 3 doc glyphs; count remainder via "+N" on the last one.
  const shown = Math.min(count, 3);
  const remainder = count - shown;
  const glyphs: NonNullable<WiFeedRow["attachments"]> = [];
  for (let i = 0; i < shown - 1; i++) glyphs.push({ kind: "doc" });
  glyphs.push({ kind: "doc", count: remainder > 0 ? remainder : undefined });
  return glyphs;
}

/** Produce the deterministic detail-page href for a feed item.
 *
 *  WI-2B.1 identity-contract fix. The Mission Control snapshot's
 *  WorkItem DTO uses `id` as a *presentation* key that is loader-
 *  specific:
 *     email-intake / ar-intake  → id = "wi_<WorkIntakeItem.id>"
 *     payroll-intake            → id = "wi-<WorkIntakeItem.id>"
 *     ap-review-intake          → id = "<WorkIntakeItem.id>"
 *     loader-only AP invoices   → id = "<APInvoice.id>" (no WI row)
 *
 *  The canonical WorkIntakeItem id lives on the DTO as
 *  `workIntakeItemId` and is set by every loader whose row IS a
 *  canonical WI. Loader-only projections (pending AP invoices, some
 *  AR paths) leave it undefined and instead carry a domain-page
 *  href in the first action.
 *
 *  Routing contract (deterministic, no string parsing on the route):
 *    1. If workIntakeItemId is present → /app/admin/work-intake/review/{workIntakeItemId}
 *    2. Otherwise, if the first action carries an href → that domain URL
 *    3. Otherwise, no link — the feed renders an inert button (§10:
 *       "do not render a Review link that deterministically 404s"). */
function reviewHref(item: WorkItem): string | undefined {
  if (item.workIntakeItemId) {
    return `/app/admin/work-intake/review/${encodeURIComponent(item.workIntakeItemId)}`;
  }
  const domainHref = item.actions?.find((a) => a.href)?.href;
  if (domainHref) return domainHref;
  return undefined;
}

/** The canonical adapter. Every real WorkItem produced by the
 *  mission-control snapshot loader flows through this function
 *  before it reaches the feed row renderer. */
export function toFeedRow(item: WorkItem, ctx: AdapterContext): WiFeedRow {
  const iso = item.sortTimestamp ?? item.timestamp ?? new Date().toISOString();
  const status = mapStatus(item);
  return {
    id: item.id,
    icon: mapIcon(item),
    title: item.title,
    metaLine: composeMetaLine(item),
    description: composeDescription(item),
    status,
    timestamp: formatFeedTimestamp(iso, ctx.clubTimezone, ctx.nowIso),
    attachments: composeAttachments(item),
    // Assignee/participant avatars are intentionally omitted in
    // WI-2B — the WorkIntakeItem domain has a single ownerUserId,
    // not a participant collection. The row remains valid; the
    // renderer treats `participants` as optional.
    actionLabel: item.state === "info" || item.state === "comm" ? "View" : "Review",
    reviewHref: reviewHref(item),
  };
}

/** Adapt a full page of WorkItems in one call. */
export function toFeedRows(items: WorkItem[], ctx: AdapterContext): WiFeedRow[] {
  return items.map((it) => toFeedRow(it, ctx));
}
