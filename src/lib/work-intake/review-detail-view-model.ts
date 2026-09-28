// WI-2B.1 (2026-09-27) — real Work Intake detail view-model.
//
// Adapts a canonical `WorkIntakeDetail` (+ optional
// `ApInvoiceCardIntelligence` from the AP intelligence pipeline)
// into the presentational shape the real-data review page renders.
//
// This adapter is the ONLY place mapping domain state to the review
// presentation. It preserves the accepted WI-2A visual design (see
// §13) but never emits the Fairway Irrigation fixture strings
// (see §12): every field is either a real canonical value or an
// explicit empty/pending state.

import type { WorkIntakeDetail } from "@/lib/work-intake/detail-reader";
import type { LinkedIntelligenceForEmail } from "@/lib/mission-control/intelligence-review-intakes";
import { formatFeedTimestamp } from "./format-feed-timestamp";

export interface ReviewHeaderVM {
  eyebrow: string;                    // e.g. "INTAKE" / "IN PROGRESS" / "RESOLVED"
  title: string;
  detectedAtLabel: string;            // "Today · 11:24 AM" or ISO fallback
  metaChips: Array<{ label: string; tone: "amber-outline" | "muted" }>;
}

export interface ReviewInvoiceVM {
  hasExtraction: boolean;             // true when AP intelligence produced values
  vendor: string | null;
  vendorMatchState: "MATCHED" | "AMBIGUOUS" | "NOT_FOUND" | "INSUFFICIENT_SIGNAL" | null;
  vendorMatchedName: string | null;
  invoiceNumber: string | null;
  invoiceDateLabel: string | null;
  dueDateLabel: string | null;
  totalLabel: string | null;          // "$48,750.00 USD"
  categoryLabel: string | null;
  glAccountLabel: string | null;      // "1630 · Course Improvements"
  glConfidencePercent: number | null;
  workflowStateLabel: string | null;  // e.g. "Ready for approval"
}

export interface ReviewContextRowVM {
  category: string;
  title: string;
  meta: string;
}

export interface ReviewWorkflowStageVM {
  index: number;
  label: string;
  supporting: string;
  state: "done" | "active" | "pending";
}

export interface ReviewSpectreVM {
  lead: string;
  keyInsights: string[];              // may be empty
  recommendation: string | null;
  classificationConfidence: string;   // "high" / "medium" / "low" / "not classified"
  hasIntelligence: boolean;
}

export interface ReviewDocumentVM {
  hasAttachments: boolean;
  attachmentCount: number;
  firstAttachmentFilename: string | null;
  webLink: string | null;             // Outlook web link where safe
  bodyPreview: string | null;         // brief text extract
}

export interface RealReviewData {
  workIntakeItemId: string;
  header: ReviewHeaderVM;
  invoice: ReviewInvoiceVM;
  document: ReviewDocumentVM;
  context: ReviewContextRowVM[];
  workflow: ReviewWorkflowStageVM[];
  spectre: ReviewSpectreVM;
}

interface AdapterInput {
  detail: WorkIntakeDetail;
  linked: LinkedIntelligenceForEmail | undefined;
  clubTimezone: string;
  nowIso?: string;
}

/** Present a WorkIntakeItem.status as a compact uppercase eyebrow
 *  string. Domain vocabulary — never a UI-invented word. */
function statusEyebrow(status: string): string {
  switch (status) {
    case "OPEN":          return "INTAKE";
    case "IN_PROGRESS":   return "IN PROGRESS";
    case "DEFERRED":      return "DEFERRED";
    case "RESOLVED":      return "RESOLVED";
    case "INFORMATIONAL": return "INFORMATIONAL";
    case "SUPPRESSED":    return "SUPPRESSED";
    default:              return status.toUpperCase();
  }
}

function humanClassification(classification: string | null): string | null {
  if (!classification) return null;
  return classification
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatIsoDate(iso: string, timezone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, month: "short", day: "numeric", year: "numeric",
  }).format(d);
}

function totalLabel(
  gross: { amount: string | null; currency: string | null } | undefined,
): string | null {
  if (!gross) return null;
  const { amount, currency } = gross;
  if (!amount) return null;
  const parsed = Number(amount);
  if (Number.isNaN(parsed)) return `${amount}${currency ? ` ${currency}` : ""}`;
  const money = `$${parsed.toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
  return currency ? `${money} ${currency}` : money;
}

function glLabel(
  category: { glAccountNumber: string | null; glAccountName: string | null } | undefined,
): string | null {
  if (!category) return null;
  const { glAccountNumber, glAccountName } = category;
  if (glAccountNumber && glAccountName) return `${glAccountNumber} – ${glAccountName}`;
  return glAccountNumber ?? glAccountName ?? null;
}

function metaChips(
  detail: WorkIntakeDetail,
  invoice: ReviewInvoiceVM,
): Array<{ label: string; tone: "amber-outline" | "muted" }> {
  const chips: Array<{ label: string; tone: "amber-outline" | "muted" }> = [];
  const cls = humanClassification(detail.classification);
  if (cls) chips.push({ label: cls, tone: "amber-outline" });
  if (invoice.vendor) chips.push({ label: invoice.vendor, tone: "muted" });
  else if (detail.display.sourceLabel) chips.push({ label: detail.display.sourceLabel, tone: "muted" });
  if (invoice.totalLabel) chips.push({ label: invoice.totalLabel, tone: "muted" });
  return chips;
}

function buildInvoice(linked: LinkedIntelligenceForEmail | undefined): ReviewInvoiceVM {
  const s = linked?.invoiceSummary;
  if (!s) {
    return {
      hasExtraction: false,
      vendor: null, vendorMatchState: null, vendorMatchedName: null,
      invoiceNumber: null, invoiceDateLabel: null, dueDateLabel: null,
      totalLabel: null, categoryLabel: null, glAccountLabel: null,
      glConfidencePercent: null, workflowStateLabel: null,
    };
  }
  const vendorMatched = s.vendorMatch?.state === "MATCHED";
  return {
    hasExtraction: true,
    vendor: s.extractedVendor?.name ?? s.vendorMatch?.matchedName ?? null,
    vendorMatchState: s.vendorMatch?.state ?? null,
    vendorMatchedName: vendorMatched ? s.vendorMatch.matchedName : null,
    invoiceNumber: s.invoiceNumber ?? null,
    invoiceDateLabel: null, // not on the summary shape today
    dueDateLabel: null,
    totalLabel: totalLabel(s.gross),
    categoryLabel: s.category?.label ?? s.category?.purposeLabel ?? null,
    glAccountLabel: glLabel(s.category),
    glConfidencePercent: null, // TODO WI-2C: confidence surface
    workflowStateLabel: s.workflowState
      ? s.workflowState.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
      : null,
  };
}

function buildContext(detail: WorkIntakeDetail, invoice: ReviewInvoiceVM): ReviewContextRowVM[] {
  const rows: ReviewContextRowVM[] = [];
  if (invoice.vendorMatchState) {
    const stateWord = invoice.vendorMatchState === "MATCHED"
      ? "Approved vendor"
      : invoice.vendorMatchState === "AMBIGUOUS"
        ? "Vendor match ambiguous"
        : invoice.vendorMatchState === "NOT_FOUND"
          ? "Vendor not found in Spectre records"
          : "Insufficient signal for vendor match";
    rows.push({
      category: "Vendor Status",
      title: stateWord,
      meta: invoice.vendorMatchedName ?? invoice.vendor ?? detail.display.sender,
    });
  } else {
    rows.push({
      category: "Vendor Status",
      title: detail.display.sender || "Unknown sender",
      meta: detail.display.sourceLabel,
    });
  }
  // Classification confidence — always shown for a real record.
  rows.push({
    category: "Classification",
    title: humanClassification(detail.classification) ?? "Not classified",
    meta: `Confidence: ${detail.classificationConfidenceLabel}`,
  });
  // Ownership.
  rows.push({
    category: "Assigned To",
    title: detail.ownerName ?? "Unassigned",
    meta: detail.ownerUserId
      ? "Personal mailbox item"
      : "Available to any authorized reviewer",
  });
  return rows;
}

function buildWorkflow(status: string): ReviewWorkflowStageVM[] {
  const done = "done" as const;
  const active = "active" as const;
  const pending = "pending" as const;
  const template = (states: [typeof done | typeof active | typeof pending, ...Array<typeof done | typeof active | typeof pending>]) => [
    { index: 1, label: "Intake",   supporting: "Extracted & categorized", state: states[0] },
    { index: 2, label: "Review",   supporting: states[1] === "active" ? "You are here" : "", state: states[1] },
    { index: 3, label: "Route",    supporting: "Send for approval",       state: states[2] },
    { index: 4, label: "Execute",  supporting: "Post to ERP",             state: states[3] },
    { index: 5, label: "Complete", supporting: "Notify stakeholders",     state: states[4] },
  ] as ReviewWorkflowStageVM[];
  switch (status) {
    case "OPEN":          return template([done, active, pending, pending, pending]);
    case "IN_PROGRESS":   return template([done, active, pending, pending, pending]);
    case "DEFERRED":      return template([done, active, pending, pending, pending]);
    case "RESOLVED":      return template([done, done, done, done, done]);
    case "INFORMATIONAL": return template([done, done, pending, pending, pending]);
    case "SUPPRESSED":    return template([done, pending, pending, pending, pending]);
    default:              return template([done, active, pending, pending, pending]);
  }
}

function buildDocument(detail: WorkIntakeDetail): ReviewDocumentVM {
  const email = detail.email;
  const attachments = email?.attachments ?? [];
  return {
    hasAttachments: attachments.length > 0,
    attachmentCount: attachments.length,
    firstAttachmentFilename: attachments[0]?.filename ?? null,
    webLink: email?.webLink ?? null,
    bodyPreview: email?.bodyTextExtract?.slice(0, 240) ?? null,
  };
}

function buildSpectre(
  detail: WorkIntakeDetail,
  linked: LinkedIntelligenceForEmail | undefined,
): ReviewSpectreVM {
  const insights: string[] = [];
  if (detail.classificationReason) insights.push(detail.classificationReason);
  const invoice = linked?.invoiceSummary;
  if (invoice?.workflowState && invoice.workflowState !== "READY_FOR_APPROVAL") {
    insights.push(
      "AP workflow state: " +
      invoice.workflowState.replace(/_/g, " ").toLowerCase(),
    );
  }
  if (invoice?.vendorMatch?.state === "NOT_FOUND") {
    insights.push("Vendor is not in Spectre records — this may be a first-time supplier.");
  } else if (invoice?.vendorMatch?.state === "MATCHED" && invoice.vendorMatch.matchedName) {
    insights.push(`Vendor matched: ${invoice.vendorMatch.matchedName}`);
  }
  return {
    lead: linked?.invoiceSummary
      ? "Here's what Spectre has extracted from the invoice attachment."
      : "Spectre has classified this Work Intake item; deeper extraction may still be pending.",
    keyInsights: insights,
    recommendation: null,     // no fabricated recommendations per §15
    classificationConfidence: detail.classificationConfidenceLabel,
    hasIntelligence: insights.length > 0,
  };
}

/** Compose a real-data review presentation from the canonical detail
 *  and (optional) AP intelligence for AP-classified items. */
export function toRealReviewData({
  detail, linked, clubTimezone, nowIso,
}: AdapterInput): RealReviewData {
  const invoice = buildInvoice(linked);
  const receivedIso = detail.display.receivedAt || detail.createdAt;
  const detectedLabel = formatFeedTimestamp(receivedIso, clubTimezone, nowIso);
  const header: ReviewHeaderVM = {
    eyebrow: statusEyebrow(detail.status),
    title: detail.display.subject || detail.display.sender || "Untitled Work Intake",
    detectedAtLabel: detectedLabel ? `Detected ${detectedLabel.toLowerCase()}` : "",
    metaChips: metaChips(detail, invoice),
  };
  return {
    workIntakeItemId: detail.id,
    header,
    invoice,
    document: buildDocument(detail),
    context: buildContext(detail, invoice),
    workflow: buildWorkflow(detail.status),
    spectre: buildSpectre(detail, linked),
  };
}

// Re-export ISO-date formatter so callers building the real-data page
// have a single import surface.
export { formatIsoDate };
