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

/** WI-2C — the set of AP `invoiceSummary.workflowState` values that
 *  indicate action is required. Mirrors the same set the Review
 *  page uses in `review-detail-view-model.ts::ACTIONABLE_AP_WORKFLOW_STATES`.
 *  Kept as a duplicate constant here so this adapter has no dependency
 *  on the Review view-model (they can evolve independently but MUST
 *  stay in sync; the unit tests assert exact equality). */
const ACTIONABLE_AP_WORKFLOW_STATES = new Set([
  "READY_FOR_APPROVAL",
  "VENDOR_MATCH_REQUIRED",
  "MISSING_INFORMATION",
  "NEEDS_JUDGMENT",
  "POSSIBLE_DUPLICATE",
  "CHART_OF_ACCOUNTS_REQUIRED",
]);

/** WI-2C — has the AP intelligence pipeline resolved this item as
 *  an actionable invoice? True whenever `linkedIntelligence.invoiceSummary`
 *  exists AND its workflow state is in the actionable set. This is
 *  the single source of truth for the WI-2C precedence rule
 *  (`resolved AP intelligence overrides email classification`). */
function hasActionableApIntelligence(item: WorkItem): boolean {
  const state = item.linkedIntelligence?.invoiceSummary?.workflowState;
  if (!state) return false;
  return ACTIONABLE_AP_WORKFLOW_STATES.has(state);
}

/** Map the canonical WorkItem.state (+ workDomain + linked AP
 *  intelligence) to the presentation buckets used by the accepted
 *  feed row.
 *
 *  WI-2C precedence rule: when the AP intelligence pipeline has
 *  resolved a linked invoice into an actionable workflow state, that
 *  state overrides the email classifier's provisional state. The
 *  persisted `WorkIntakeItem.status` is NOT mutated — this is a
 *  presentation-only override, identical in spirit to the Review
 *  page's `statusEyebrow` override. */
function mapStatus(item: WorkItem): { label: string; tone: WiStatusTone } {
  // Judgment items always take precedence — the WorkItem loader has
  // already applied the founder's judgment/approval bucketing rules.
  if (item.state === "judgment") {
    return { label: "Requires your judgment", tone: "judgment" };
  }
  // WI-2C — if the item's persisted state is "info" but the AP
  // intelligence has resolved an actionable workflow, promote it.
  // This is the exact defect the founder reported for PAY NOW:
  // persisted classification stayed INFORMATIONAL, but
  // invoiceSummary.workflowState = VENDOR_MATCH_REQUIRED.
  if (item.state === "info" && hasActionableApIntelligence(item)) {
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
 *  by the accepted WI-1 feed. Never derive icon from display text.
 *
 *  WI-2C — the AP invoice glyph is authoritative for EVERY item the
 *  AP intelligence pipeline has resolved as an invoice, regardless
 *  of the email classifier's original label. The prior split (based
 *  on `classification === "AP_INVOICE_REVIEW"`) meant two AP
 *  invoices in the same feed could get different icons based on
 *  whether the row happened to be an AP-review child or an email-
 *  derived parent — semantically incoherent. */
function mapIcon(item: WorkItem): WiIcon {
  const d = item.workDomain;
  if (d === "ACCOUNTS_PAYABLE") {
    // WI-2C precedence: resolved AP invoice intelligence wins over
    // the email classifier. Any item that has `invoiceSummary`
    // becomes the invoice glyph, so PAY NOW (email-derived) and
    // "Vendor reports an unpaid invoice" (AP_INVOICE_REVIEW child)
    // now share the same icon.
    if (item.linkedIntelligence?.invoiceSummary) return "invoice";
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

/** WI-2C — format a Decimal-safe amount + currency string into a
 *  presentation label (e.g. `$778.16 CAD`). No fabrication when the
 *  extractor didn't capture either. */
function formatInvoiceAmount(gross: { amount: string | null; currency: string | null } | undefined): string | null {
  if (!gross) return null;
  const { amount, currency } = gross;
  if (!amount) return null;
  const parsed = Number(amount);
  if (Number.isNaN(parsed)) return currency ? `${amount} ${currency}` : amount;
  const money = `$${parsed.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return currency ? `${money} ${currency}` : money;
}

/** WI-2C — vendor label from AP intelligence (extracted vendor OR
 *  matched Spectre vendor), or null when neither is present. */
function vendorLabel(inv: NonNullable<WorkItem["linkedIntelligence"]>["invoiceSummary"]): string | null {
  if (!inv) return null;
  return inv.extractedVendor?.name ?? inv.vendorMatch?.matchedName ?? null;
}

/** WI-2C — GL account label (e.g. `6071 – Subscriptions`). */
function glLabel(inv: NonNullable<WorkItem["linkedIntelligence"]>["invoiceSummary"]): string | null {
  if (!inv?.category) return null;
  const { glAccountNumber, glAccountName } = inv.category;
  if (glAccountNumber && glAccountName) return `${glAccountNumber} – ${glAccountName}`;
  return glAccountNumber ?? glAccountName ?? null;
}

/** Compose the row's second-line meta string.
 *
 *  WI-2C — for AP items with resolved intelligence, this becomes
 *  `Vendor · $Amount CUR · GL number – GL name`.
 *  WI-2C.1 — GL is now expressed in the TITLE (`AP Invoice · {category}`),
 *  so the subtitle line is compact `Vendor · Total` only. Otherwise
 *  falls back to the WorkItem loader's own sender/context string. */
function composeMetaLine(item: WorkItem): string {
  const inv = item.linkedIntelligence?.invoiceSummary;
  if (inv) {
    const parts: string[] = [];
    const vendor = vendorLabel(inv);
    if (vendor) parts.push(vendor);
    const amt = formatInvoiceAmount(inv.gross);
    if (amt) parts.push(amt);
    if (parts.length > 0) return parts.join(" · ");
  }
  const parts: string[] = [];
  if (item.sender.from) parts.push(item.sender.from);
  if (item.sender.ctx) parts.push(item.sender.ctx);
  return parts.join(" · ");
}

/** WI-2C.1 — human-readable category token for the AP title.
 *  Preference order: `category.label` → `category.purposeLabel` →
 *  `category.glAccountName`. Falls back to null; the title then
 *  becomes `"AP Invoice"` with no suffix. */
function apCategoryToken(inv: NonNullable<WorkItem["linkedIntelligence"]>["invoiceSummary"]): string | null {
  if (!inv?.category) return null;
  return inv.category.label ?? inv.category.purposeLabel ?? inv.category.glAccountName ?? null;
}

/** WI-2C.1 — resolved AP-invoice title. Replaces the email subject
 *  as the primary title once Spectre has resolved the record as an
 *  AP invoice. Applies to any record with `linkedIntelligence.invoiceSummary`
 *  regardless of source (email, upload, AP_INVOICE_REVIEW child).
 *
 *  Rule: `AP Invoice · {resolved category}` when the pipeline
 *  produced a category token; otherwise `AP Invoice`. Original
 *  email subject remains provenance on the WorkIntakeItem and in
 *  the Review page's activity trail — never leaked back as the
 *  operational title. */
function apResolvedTitle(inv: NonNullable<WorkItem["linkedIntelligence"]>["invoiceSummary"]): string {
  const token = apCategoryToken(inv);
  return token ? `AP Invoice · ${token}` : "AP Invoice";
}

/** WI-2C — invoice-purpose commentary. One concise sentence
 *  answering "what am I actually paying for?" Composed strictly from
 *  extractor evidence — vendor + category + top line-item
 *  descriptions. No fabrication, no invented facts. */
function composeApPurposeCommentary(
  inv: NonNullable<WorkItem["linkedIntelligence"]>["invoiceSummary"],
): string | null {
  if (!inv) return null;
  const vendor = vendorLabel(inv);
  const categoryLabel = inv.category?.label ?? inv.category?.purposeLabel ?? null;
  const items = (inv.lineItems ?? []).map((li) => li.description).filter(Boolean).slice(0, 4);
  if (items.length > 0 && vendor && categoryLabel) {
    // "Monthly Microsoft subscription for Microsoft 365 Business Standard,
    //  Microsoft 365 Business Basic, Microsoft 365 Business Premium."
    const productList = items.length === 1
      ? items[0]
      : items.length === 2
        ? `${items[0]} and ${items[1]}`
        : `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
    return `${categoryLabel} from ${vendor}: ${productList}.`;
  }
  if (vendor && categoryLabel) return `${categoryLabel} from ${vendor}.`;
  if (items.length > 0) {
    return `Invoice covers ${items.slice(0, 3).join(", ")}.`;
  }
  return null;
}

/** WI-2C — financial-context commentary. TRUTHFUL: uses only signals
 *  the extractor already computed. No budget query, no history
 *  fabrication. */
function composeApFinancialContext(
  inv: NonNullable<WorkItem["linkedIntelligence"]>["invoiceSummary"],
): string | null {
  if (!inv) return null;
  // WI-2C — vendor cadence is the only cross-invoice signal already
  // computed by the AP intelligence pipeline. `invoiceCadenceThisQuarter`
  // on ApInvoiceCardIntelligence is `number | null` — the count of
  // PRIOR invoices from the matched vendor this quarter. It provides
  // a truthful "this is the Nth invoice this quarter" observation.
  // Only meaningful when the vendor was matched to a Spectre record.
  const priorCount = inv.invoiceCadenceThisQuarter;
  if (typeof priorCount === "number" && priorCount >= 0) {
    if (priorCount === 0) {
      return "First invoice from this vendor this quarter.";
    }
    const nth = ordinal(priorCount + 1);
    return `${nth} invoice from this vendor this quarter.`;
  }
  const vendorState = inv.vendorMatch?.state;
  if (vendorState === "NOT_FOUND") {
    return "First comparable invoice found — no historical comparison available.";
  }
  return "Historical comparison not yet available.";
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Compose the row's third-line description.
 *
 *  WI-2C precedence:
 *    1. AP purpose commentary (when linkedIntelligence has an invoice)
 *    2. Domain synopsisText (deterministic invoice-analysis text)
 *    3. Raw work prose
 *    4. Domain recommendation */
function composeDescription(item: WorkItem): string {
  const inv = item.linkedIntelligence?.invoiceSummary;
  if (inv) {
    const purpose = composeApPurposeCommentary(inv);
    if (purpose) return purpose;
  }
  if (item.synopsisText) return item.synopsisText;
  if (item.work) return item.work;
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
  const inv = item.linkedIntelligence?.invoiceSummary;
  // WI-2C — when AP intelligence resolved an invoice, "Review" is
  // the correct action label regardless of the base state (which may
  // still say "info" from the email classifier).
  const treatAsAp = inv != null;
  const baseIsView = item.state === "info" || item.state === "comm";
  const actionLabel: "Review" | "View" = baseIsView && !treatAsAp ? "View" : "Review";
  // WI-2C.1 — resolved AP-invoice title override. When the AP
  // pipeline has produced an invoice, the operational title becomes
  // `AP Invoice · {category}`, not the email subject. The original
  // subject stays on the WorkIntakeItem for provenance.
  const title = inv ? apResolvedTitle(inv) : item.title;
  return {
    id: item.id,
    icon: mapIcon(item),
    title,
    metaLine: composeMetaLine(item),
    description: composeDescription(item),
    status,
    timestamp: formatFeedTimestamp(iso, ctx.clubTimezone, ctx.nowIso),
    attachments: composeAttachments(item),
    actionLabel,
    reviewHref: reviewHref(item),
    financialContext: inv ? composeApFinancialContext(inv) ?? undefined : undefined,
  };
}

/** Adapt a full page of WorkItems in one call. */
export function toFeedRows(items: WorkItem[], ctx: AdapterContext): WiFeedRow[] {
  return items.map((it) => toFeedRow(it, ctx));
}
