// WI-2B.2 (2026-09-27) — unit tests for the review-detail
// view-model's classification override + PDF passthrough.

import { describe, expect, it } from "vitest";
import { toRealReviewData } from "@/lib/work-intake/review-detail-view-model";
import type { WorkIntakeDetail } from "@/lib/work-intake/detail-reader";
import type { LinkedIntelligenceForEmail } from "@/lib/mission-control/intelligence-review-intakes";

const ZONE = "America/Edmonton";

function baseDetail(overrides: Partial<WorkIntakeDetail> = {}): WorkIntakeDetail {
  return {
    id: "wi-abc",
    status: "OPEN",
    classification: "INFORMATIONAL",
    classificationReason: null,
    classificationMethod: "RULE",
    classificationConfidence: 0.5,
    classificationConfidenceLabel: "low",
    judgmentRequired: true,
    ownerUserId: null,
    ownerName: null,
    deferredUntil: null,
    resolvedAt: null,
    createdAt: "2026-09-27T18:00:00Z",
    updatedAt: "2026-09-27T18:00:00Z",
    primaryDocument: null,
    display: {
      sourceLabel: "Outlook",
      sender: "c.s.turcato@gmail.com",
      subject: "PAY NOW",
      receivedAt: "2026-09-27T18:00:00Z",
      hasAttachments: true,
    },
    email: null,
    activity: [],
    ...overrides,
  } as WorkIntakeDetail;
}

function linkedWithWorkflow(state: string | undefined, extra?: Partial<LinkedIntelligenceForEmail["invoiceSummary"] & object>): LinkedIntelligenceForEmail {
  return {
    apReviewIntakeIds: [],
    statementReviewIntakeIds: [],
    attachmentCount: 1,
    invoiceAttachmentCount: 1,
    statementAttachmentCount: 0,
    dominantFacet: "invoice",
    invoiceSummary: state === undefined ? undefined : {
      sender: { name: null, email: null, relationship: "OTHER" },
      extractedVendor: { name: "Club Support Inc" },
      vendorMatch: { state: "NOT_FOUND", matchedName: null, matchedVendorId: null },
      invoiceNumber: "200824",
      gross: { amount: "778.16", currency: "CAD" },
      paymentTerms: null,
      paymentTermsSource: null,
      purchaseOrder: { poNumber: null, matchedPoDocumentId: null, variance: null },
      category: {
        label: "Subscriptions",
        glAccountNumber: "6071",
        glAccountName: "Subscriptions",
        capitalState: "OPERATING",
        source: "VENDOR_DEFAULT",
        alternates: [],
      },
      workflowState: state as never,
      workflowReason: null,
      ...(extra ?? {}),
    },
  } as unknown as LinkedIntelligenceForEmail;
}

describe("WI-2B.2 view-model — classification presentation", () => {
  it("when NO AP intelligence: eyebrow = INTAKE, headline = Informational", () => {
    const out = toRealReviewData({
      detail: baseDetail(),
      linked: undefined,
      clubTimezone: ZONE,
    });
    expect(out.header.eyebrow).toBe("INTAKE");
    // First meta chip is the email classifier label.
    expect(out.header.metaChips[0]?.label).toBe("Informational");
    // Classification row shows email classifier + confidence.
    const cls = out.context.find((r) => r.category === "Classification");
    expect(cls?.title).toBe("Informational");
    expect(cls?.meta).toContain("Confidence: low");
  });

  it("when AP.workflowState = VENDOR_MATCH_REQUIRED: eyebrow = ACTION REQUIRED, headline chip = Vendor Match Required, original classifier preserved as provenance meta", () => {
    const out = toRealReviewData({
      detail: baseDetail({ status: "OPEN" }),
      linked: linkedWithWorkflow("VENDOR_MATCH_REQUIRED"),
      clubTimezone: ZONE,
    });
    expect(out.header.eyebrow).toBe("ACTION REQUIRED");
    expect(out.header.metaChips[0]?.label).toBe("Vendor Match Required");
    const cls = out.context.find((r) => r.category === "Classification");
    expect(cls?.title).toBe("Vendor Match Required");
    expect(cls?.meta).toBe("Original classifier: Informational · confidence low");
  });

  it("promotes for every actionable workflow state", () => {
    const cases = [
      "READY_FOR_APPROVAL",
      "VENDOR_MATCH_REQUIRED",
      "MISSING_INFORMATION",
      "NEEDS_JUDGMENT",
      "POSSIBLE_DUPLICATE",
      "CHART_OF_ACCOUNTS_REQUIRED",
    ];
    for (const state of cases) {
      const out = toRealReviewData({
        detail: baseDetail(),
        linked: linkedWithWorkflow(state),
        clubTimezone: ZONE,
      });
      expect(out.header.eyebrow, `state=${state}`).toBe("ACTION REQUIRED");
    }
  });

  it("does NOT promote when workflowState is ANALYSIS_PENDING or UNSUPPORTED", () => {
    for (const state of ["ANALYSIS_PENDING", "UNSUPPORTED"]) {
      const out = toRealReviewData({
        detail: baseDetail(),
        linked: linkedWithWorkflow(state),
        clubTimezone: ZONE,
      });
      expect(out.header.eyebrow, `state=${state}`).toBe("INTAKE");
    }
  });

  it("does NOT promote when persisted status is RESOLVED even if AP is actionable", () => {
    // A resolved item stays RESOLVED — the eyebrow does not become
    // ACTION REQUIRED just because a stale invoiceSummary lingers.
    const out = toRealReviewData({
      detail: baseDetail({ status: "RESOLVED" }),
      linked: linkedWithWorkflow("VENDOR_MATCH_REQUIRED"),
      clubTimezone: ZONE,
    });
    expect(out.header.eyebrow).toBe("RESOLVED");
  });

  it("does NOT mutate detail.classification (view-model-only override)", () => {
    const detail = baseDetail();
    const originalClassification = detail.classification;
    toRealReviewData({
      detail,
      linked: linkedWithWorkflow("VENDOR_MATCH_REQUIRED"),
      clubTimezone: ZONE,
    });
    expect(detail.classification).toBe(originalClassification);
  });
});

describe("WI-2B.2 view-model — PDF passthrough", () => {
  it("no email → primaryPdf is null", () => {
    const out = toRealReviewData({
      detail: baseDetail({ email: null }),
      linked: undefined,
      clubTimezone: ZONE,
    });
    expect(out.document.primaryPdf).toBeNull();
  });

  it("email without a stored PDF attachment → primaryPdf is null", () => {
    const detail = baseDetail({
      email: {
        senderName: "", senderAddress: "", subject: "", recipientsTo: [], recipientsCc: [],
        receivedAt: "", sentAt: null, bodyHtmlSanitized: null, bodyTextExtract: null,
        webLink: null, isSoftDeleted: false, mailboxConnectedEmail: "",
        attachments: [
          { id: "att-1", filename: "note.txt", contentType: "text/plain", sizeBytes: 12, storageState: "STORED", ingestedDocumentId: "doc-1" },
        ],
      },
    });
    const out = toRealReviewData({ detail, linked: undefined, clubTimezone: ZONE });
    expect(out.document.primaryPdf).toBeNull();
  });

  it("email with STORED application/pdf attachment and promoted id → primaryPdf populated", () => {
    const detail = baseDetail({
      email: {
        senderName: "", senderAddress: "", subject: "", recipientsTo: [], recipientsCc: [],
        receivedAt: "", sentAt: null, bodyHtmlSanitized: null, bodyTextExtract: null,
        webLink: null, isSoftDeleted: false, mailboxConnectedEmail: "",
        attachments: [
          { id: "att-1", filename: "200824.pdf", contentType: "application/pdf", sizeBytes: 999, storageState: "STORED", ingestedDocumentId: "doc-1" },
        ],
      },
    });
    const out = toRealReviewData({ detail, linked: undefined, clubTimezone: ZONE });
    expect(out.document.primaryPdf).toEqual({
      ingestedDocumentId: "doc-1",
      filename: "200824.pdf",
      mimeType: "application/pdf",
    });
  });

  it("PDF attachment present but NOT yet promoted (ingestedDocumentId null) → primaryPdf remains null", () => {
    const detail = baseDetail({
      email: {
        senderName: "", senderAddress: "", subject: "", recipientsTo: [], recipientsCc: [],
        receivedAt: "", sentAt: null, bodyHtmlSanitized: null, bodyTextExtract: null,
        webLink: null, isSoftDeleted: false, mailboxConnectedEmail: "",
        attachments: [
          { id: "att-1", filename: "200824.pdf", contentType: "application/pdf", sizeBytes: 999, storageState: "METADATA_ONLY", ingestedDocumentId: null },
        ],
      },
    });
    const out = toRealReviewData({ detail, linked: undefined, clubTimezone: ZONE });
    expect(out.document.primaryPdf).toBeNull();
  });

  it("WI-2B.3: SHA-dedup case — attachment stays METADATA_ONLY, but detail.primaryDocument from evidence link surfaces the PDF", () => {
    // This is the EXACT PAY NOW scenario. The EmailAttachment on
    // this arrival is METADATA_ONLY because the same-SHA PDF was
    // already promoted from an earlier arrival. The canonical
    // IngestedDocumentEvidenceLink lookup surfaces the promoted
    // document at the WI level.
    const detail = baseDetail({
      primaryDocument: {
        ingestedDocumentId: "doc-canonical",
        filename: "200824.pdf",
        mimeType: "application/pdf",
        byteLength: 71369,
      },
      email: {
        senderName: "", senderAddress: "", subject: "", recipientsTo: [], recipientsCc: [],
        receivedAt: "", sentAt: null, bodyHtmlSanitized: null, bodyTextExtract: null,
        webLink: null, isSoftDeleted: false, mailboxConnectedEmail: "",
        attachments: [
          { id: "att-1", filename: "200824.pdf", contentType: "application/pdf", sizeBytes: 71565, storageState: "METADATA_ONLY", ingestedDocumentId: null },
        ],
      },
    });
    const out = toRealReviewData({ detail, linked: undefined, clubTimezone: ZONE });
    expect(out.document.primaryPdf).toEqual({
      ingestedDocumentId: "doc-canonical",
      filename: "200824.pdf",
      mimeType: "application/pdf",
    });
    expect(out.document.hasAttachments).toBe(true);
  });

  it("WI-2B.3: primaryDocument works even when no email is attached at all", () => {
    const detail = baseDetail({
      primaryDocument: {
        ingestedDocumentId: "doc-ap",
        filename: "vendor-invoice.pdf",
        mimeType: "application/pdf",
        byteLength: 12345,
      },
      email: null,
    });
    const out = toRealReviewData({ detail, linked: undefined, clubTimezone: ZONE });
    expect(out.document.primaryPdf?.ingestedDocumentId).toBe("doc-ap");
  });
});
