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
  /** WI-2B.4 — structured line items from the extractor. Null when
   *  the pipeline has not yet produced them (analysis pending). */
  lineItems: Array<{
    n: number;
    description: string;
    quantity: string | null;
    unitCost: string | null;
    amount: string | null;
  }> | null;
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
  /** WI-2B.2 — primary attachment resolved through to its promoted
   *  IngestedDocument. Null when either no attachment exists, no
   *  ingest promotion has happened yet, or the first attachment's
   *  mime type is not application/pdf. The client renders the
   *  actual PDF from GET /api/documents/{ingestedDocumentId}/preview. */
  primaryPdf: {
    ingestedDocumentId: string;
    filename: string;
    mimeType: string;
  } | null;
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
 *  string. Domain vocabulary — never a UI-invented word.
 *
 *  WI-2B.2 — when the AP intelligence pipeline has established an
 *  ACTIONABLE workflowState, the eyebrow reflects that business
 *  reality rather than the email classifier's provisional label.
 *  The persisted `status` column is NOT mutated — this is a
 *  presentation-only override, per Explore-agent-A guidance. */
function statusEyebrow(status: string, actionableFromAp: boolean): string {
  if (actionableFromAp && (status === "OPEN" || status === "IN_PROGRESS")) {
    return "ACTION REQUIRED";
  }
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

/** WI-2B.2 — the set of `invoiceSummary.workflowState` values that
 *  the AP intelligence pipeline uses to indicate work is required.
 *  ANALYSIS_PENDING is intentionally excluded (the pipeline hasn't
 *  yet made a judgment); UNSUPPORTED and READY_FOR_APPROVAL keep
 *  their own meaning but both still represent actionable work. */
const ACTIONABLE_AP_WORKFLOW_STATES = new Set([
  "READY_FOR_APPROVAL",
  "VENDOR_MATCH_REQUIRED",
  "MISSING_INFORMATION",
  "NEEDS_JUDGMENT",
  "POSSIBLE_DUPLICATE",
  "CHART_OF_ACCOUNTS_REQUIRED",
]);

function humanWorkflowState(state: string | undefined | null): string | null {
  if (!state) return null;
  return state
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
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
  actionableFromAp: boolean,
): Array<{ label: string; tone: "amber-outline" | "muted" }> {
  const chips: Array<{ label: string; tone: "amber-outline" | "muted" }> = [];
  // WI-2B.2 — when AP intelligence has established an actionable
  // workflow state, its label is the canonical headline. The email
  // classifier's label falls back to a muted provenance chip so the
  // original decision remains visible without dominating the header.
  if (actionableFromAp && invoice.workflowStateLabel) {
    chips.push({ label: invoice.workflowStateLabel, tone: "amber-outline" });
  } else {
    const cls = humanClassification(detail.classification);
    if (cls) chips.push({ label: cls, tone: "amber-outline" });
  }
  if (invoice.vendor) chips.push({ label: invoice.vendor, tone: "muted" });
  else if (detail.display.sourceLabel) chips.push({ label: detail.display.sourceLabel, tone: "muted" });
  if (invoice.totalLabel) chips.push({ label: invoice.totalLabel, tone: "muted" });
  return chips;
}

function buildInvoice(
  linked: LinkedIntelligenceForEmail | undefined,
  clubTimezone: string,
): ReviewInvoiceVM {
  const s = linked?.invoiceSummary;
  if (!s) {
    return {
      hasExtraction: false,
      vendor: null, vendorMatchState: null, vendorMatchedName: null,
      invoiceNumber: null, invoiceDateLabel: null, dueDateLabel: null,
      totalLabel: null, categoryLabel: null, glAccountLabel: null,
      glConfidencePercent: null, workflowStateLabel: null,
      lineItems: null,
    };
  }
  const vendorMatched = s.vendorMatch?.state === "MATCHED";
  return {
    hasExtraction: true,
    vendor: s.extractedVendor?.name ?? s.vendorMatch?.matchedName ?? null,
    vendorMatchState: s.vendorMatch?.state ?? null,
    vendorMatchedName: vendorMatched ? s.vendorMatch.matchedName : null,
    invoiceNumber: s.invoiceNumber ?? null,
    // WI-2B.4 — format ISO date strings in the club's IANA zone.
    invoiceDateLabel: formatIsoDayLabel(s.invoiceDate, clubTimezone),
    dueDateLabel: formatIsoDayLabel(s.dueDate, clubTimezone),
    totalLabel: totalLabel(s.gross),
    categoryLabel: s.category?.label ?? s.category?.purposeLabel ?? null,
    glAccountLabel: glLabel(s.category),
    glConfidencePercent: null,
    workflowStateLabel: humanWorkflowState(s.workflowState),
    lineItems: s.lineItems && s.lineItems.length > 0
      ? s.lineItems.map((li, i) => ({
          n: i + 1,
          description: li.description,
          quantity: li.quantity,
          unitCost: li.unitCost,
          amount: li.amount,
        }))
      : null,
  };
}

/** Format an ISO date-like string as "MMM d, yyyy" in the club
 *  timezone. The extractor may emit `YYYY-MM-DD` or a full ISO
 *  timestamp; either parses fine. Returns null on empty/unparseable. */
function formatIsoDayLabel(iso: string | null | undefined, timezone: string): string | null {
  if (!iso) return null;
  const trimmed = iso.trim();
  if (!trimmed) return null;
  // Bare YYYY-MM-DD is parsed as UTC midnight. That's fine for
  // date-only display; the timezone parameter only prevents an
  // off-by-one when a full timestamp lands close to midnight.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? new Date(trimmed + "T12:00:00Z") : new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, month: "short", day: "numeric", year: "numeric",
    }).format(d);
  } catch {
    return null;
  }
}

function buildContext(
  detail: WorkIntakeDetail,
  invoice: ReviewInvoiceVM,
  actionableFromAp: boolean,
): ReviewContextRowVM[] {
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
  // Classification row — WI-2B.2 fix. Presents the AP workflow state
  // as the canonical classification when actionable, and preserves
  // the original email classifier decision in the meta line so the
  // provenance stays visible. No DB write; the persisted
  // `classification` column is unchanged.
  const emailClsLabel = humanClassification(detail.classification) ?? "Not classified";
  if (actionableFromAp && invoice.workflowStateLabel) {
    rows.push({
      category: "Classification",
      title: invoice.workflowStateLabel,
      meta: `Original classifier: ${emailClsLabel} · confidence ${detail.classificationConfidenceLabel}`,
    });
  } else {
    rows.push({
      category: "Classification",
      title: emailClsLabel,
      meta: `Confidence: ${detail.classificationConfidenceLabel}`,
    });
  }
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

  // WI-2B.3 — primary PDF resolution order:
  //   1. detail.primaryDocument (from IngestedDocumentEvidenceLink)
  //      — dedup-safe, matches the AP intelligence / Mission Control
  //      documents API.
  //   2. per-attachment ingestedDocumentId + application/pdf mime
  //      (WI-2B.2 path — kept for fresh promotions that also carry a
  //      matching sourceReferenceId).
  //
  // The storageState guard from WI-2B.2 is removed: EmailAttachment
  // rows correctly stay METADATA_ONLY when SHA-dedup routes them to
  // an already-promoted IngestedDocument via the evidence link. The
  // IngestedDocument itself is `status = "STORED"` — that is what
  // determines whether bytes are retrievable, not the attachment's
  // own storageState.
  let primaryPdf: ReviewDocumentVM["primaryPdf"] = null;
  if (detail.primaryDocument) {
    primaryPdf = {
      ingestedDocumentId: detail.primaryDocument.ingestedDocumentId,
      filename: detail.primaryDocument.filename,
      mimeType: detail.primaryDocument.mimeType,
    };
  } else {
    const pdfCandidate = attachments.find(
      (a) =>
        a.ingestedDocumentId !== null &&
        /^application\/pdf(;|$)/i.test(a.contentType),
    );
    if (pdfCandidate) {
      primaryPdf = {
        ingestedDocumentId: pdfCandidate.ingestedDocumentId!,
        filename: pdfCandidate.filename,
        mimeType: pdfCandidate.contentType,
      };
    }
  }
  return {
    hasAttachments: attachments.length > 0 || !!detail.primaryDocument,
    attachmentCount: attachments.length,
    firstAttachmentFilename: attachments[0]?.filename ?? detail.primaryDocument?.filename ?? null,
    webLink: email?.webLink ?? null,
    bodyPreview: email?.bodyTextExtract?.slice(0, 240) ?? null,
    primaryPdf,
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
 *  and (optional) AP intelligence for AP-classified items.
 *
 *  WI-2B.2 — the persisted `WorkIntakeItem.classification` column
 *  represents the email classifier's provisional decision at
 *  message ingest time. When the AP intelligence pipeline (which
 *  runs downstream once attachments are analysed) has produced an
 *  actionable `invoiceSummary.workflowState`, the presentation
 *  layer promotes that state to the headline chip / eyebrow /
 *  Classification row, while preserving the original classifier
 *  decision as provenance meta. NO DB write. NO changes to
 *  reclassifyFromCanonicalAnalysis. */
export function toRealReviewData({
  detail, linked, clubTimezone, nowIso,
}: AdapterInput): RealReviewData {
  const invoice = buildInvoice(linked, clubTimezone);
  const actionableFromAp =
    !!linked?.invoiceSummary?.workflowState &&
    ACTIONABLE_AP_WORKFLOW_STATES.has(linked.invoiceSummary.workflowState);
  const receivedIso = detail.display.receivedAt || detail.createdAt;
  const detectedLabel = formatFeedTimestamp(receivedIso, clubTimezone, nowIso);
  const header: ReviewHeaderVM = {
    eyebrow: statusEyebrow(detail.status, actionableFromAp),
    title: detail.display.subject || detail.display.sender || "Untitled Work Intake",
    detectedAtLabel: detectedLabel ? `Detected ${detectedLabel.toLowerCase()}` : "",
    metaChips: metaChips(detail, invoice, actionableFromAp),
  };
  return {
    workIntakeItemId: detail.id,
    header,
    invoice,
    document: buildDocument(detail),
    context: buildContext(detail, invoice, actionableFromAp),
    workflow: buildWorkflow(detail.status),
    spectre: buildSpectre(detail, linked),
  };
}

// Re-export ISO-date formatter so callers building the real-data page
// have a single import surface.
export { formatIsoDate };
