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
      invoiceDate: null,
      dueDate: null,
      gross: { amount: "778.16", currency: "CAD" },
      lineItems: null,
      tax: null,
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

describe("WI-2B.4 — invoice date + due date + line items", () => {
  function withInvoice(
    dates: { invoiceDate?: string | null; dueDate?: string | null } = {},
    lineItems: Array<{ description: string; quantity: string | null; unitCost: string | null; amount: string | null }> | null = null,
    tax: Array<{ label: string; amount: string | null; rate: number | null }> | null = null,
  ): LinkedIntelligenceForEmail {
    return {
      apReviewIntakeIds: [],
      statementReviewIntakeIds: [],
      attachmentCount: 1,
      invoiceAttachmentCount: 1,
      statementAttachmentCount: 0,
      dominantFacet: "invoice",
      invoiceSummary: {
        sender: { name: null, email: null, relationship: "OTHER" },
        extractedVendor: { name: "Club Support Inc" },
        vendorMatch: { state: "NOT_FOUND", matchedName: null, matchedVendorId: null },
        invoiceNumber: "221007",
        invoiceDate: dates.invoiceDate ?? null,
        dueDate: dates.dueDate ?? null,
        gross: { amount: "707.17", currency: "CAD" },
        paymentTerms: null,
        paymentTermsSource: null,
        purchaseOrder: { poNumber: null, matchedPoDocumentId: null, variance: null },
        category: { label: "Subscriptions", glAccountNumber: "6071", glAccountName: "Subscriptions", capitalState: "OPERATING", source: null, alternates: [] },
        workflowState: "VENDOR_MATCH_REQUIRED" as never,
        workflowReason: null,
        lineItems,
        tax,
      },
    } as unknown as LinkedIntelligenceForEmail;
  }

  it("formats YYYY-MM-DD invoiceDate + dueDate into human labels", () => {
    const out = toRealReviewData({
      detail: baseDetail(),
      linked: withInvoice({ invoiceDate: "2026-07-15", dueDate: "2026-08-14" }),
      clubTimezone: ZONE,
    });
    expect(out.invoice.invoiceDateLabel).toBe("Jul 15, 2026");
    expect(out.invoice.dueDateLabel).toBe("Aug 14, 2026");
  });

  it("leaves invoiceDate/dueDate labels null when the extractor did not capture them", () => {
    const out = toRealReviewData({
      detail: baseDetail(),
      linked: withInvoice({ invoiceDate: null, dueDate: null }),
      clubTimezone: ZONE,
    });
    expect(out.invoice.invoiceDateLabel).toBeNull();
    expect(out.invoice.dueDateLabel).toBeNull();
  });

  it("gracefully returns null for unparseable date strings — no crash, no fabrication", () => {
    const out = toRealReviewData({
      detail: baseDetail(),
      linked: withInvoice({ invoiceDate: "n/a", dueDate: "" }),
      clubTimezone: ZONE,
    });
    expect(out.invoice.invoiceDateLabel).toBeNull();
    expect(out.invoice.dueDateLabel).toBeNull();
  });

  it("passes structured line items through with 1-based indexing", () => {
    const lines = [
      { description: "Software subscription — July 2026", quantity: "1", unitCost: "600.00", amount: "600.00" },
      { description: "Support & maintenance", quantity: "1", unitCost: "107.17", amount: "107.17" },
    ];
    const out = toRealReviewData({
      detail: baseDetail(),
      linked: withInvoice({}, lines),
      clubTimezone: ZONE,
    });
    expect(out.invoice.lineItems).not.toBeNull();
    expect(out.invoice.lineItems).toHaveLength(2);
    expect(out.invoice.lineItems![0]).toEqual({ n: 1, description: "Software subscription — July 2026", quantity: "1", unitCost: "600.00", amount: "600.00" });
    expect(out.invoice.lineItems![1].n).toBe(2);
  });

  it("returns null lineItems when the extractor produced none — never fabricates", () => {
    const out = toRealReviewData({
      detail: baseDetail(),
      linked: withInvoice({}, null),
      clubTimezone: ZONE,
    });
    expect(out.invoice.lineItems).toBeNull();
  });
});

describe("WI-2B.5 — tax breakdown + no subtotal/total pollution", () => {
  function withInvoice(
    lineItems: Array<{ description: string; quantity: string | null; unitCost: string | null; amount: string | null }> | null,
    tax: Array<{ label: string; amount: string | null; rate: number | null }> | null,
  ): LinkedIntelligenceForEmail {
    return {
      apReviewIntakeIds: [],
      statementReviewIntakeIds: [],
      attachmentCount: 1,
      invoiceAttachmentCount: 1,
      statementAttachmentCount: 0,
      dominantFacet: "invoice",
      invoiceSummary: {
        sender: { name: null, email: null, relationship: "OTHER" },
        extractedVendor: { name: "Club Support Inc" },
        vendorMatch: { state: "NOT_FOUND", matchedName: null, matchedVendorId: null },
        invoiceNumber: "200824",
        invoiceDate: null, dueDate: null,
        gross: { amount: "778.16", currency: "CAD" },
        paymentTerms: null, paymentTermsSource: null,
        purchaseOrder: { poNumber: null, matchedPoDocumentId: null, variance: null },
        category: { label: null, glAccountNumber: null, glAccountName: null, capitalState: null, source: null, alternates: [] },
        workflowState: "VENDOR_MATCH_REQUIRED" as never,
        workflowReason: null,
        lineItems, tax,
      },
    } as unknown as LinkedIntelligenceForEmail;
  }

  it("passes structured tax rows through with real canonical labels", () => {
    const out = toRealReviewData({
      detail: baseDetail(),
      linked: withInvoice(
        [{ description: "MS Office 365", quantity: "26", unitCost: "17.85", amount: "464.10" }],
        [{ label: "GST", amount: "37.06", rate: 5 }],
      ),
      clubTimezone: ZONE,
    });
    expect(out.invoice.tax).toEqual([{ label: "GST", amount: "37.06", rate: 5 }]);
  });

  it("supports multiple tax rows (HST/PST/QST coexist without collapsing)", () => {
    const out = toRealReviewData({
      detail: baseDetail(),
      linked: withInvoice(
        [{ description: "Service", quantity: "1", unitCost: "100.00", amount: "100.00" }],
        [
          { label: "GST", amount: "5.00", rate: 5 },
          { label: "PST", amount: "7.00", rate: 7 },
        ],
      ),
      clubTimezone: ZONE,
    });
    expect(out.invoice.tax).toHaveLength(2);
    expect(out.invoice.tax![0].label).toBe("GST");
    expect(out.invoice.tax![1].label).toBe("PST");
  });

  it("tax is null when no tax was extracted — never invents a row", () => {
    const out = toRealReviewData({
      detail: baseDetail(),
      linked: withInvoice(
        [{ description: "Service", quantity: "1", unitCost: "100.00", amount: "100.00" }],
        null,
      ),
      clubTimezone: ZONE,
    });
    expect(out.invoice.tax).toBeNull();
  });

  it("preserves purchase rows regardless of whether tax exists", () => {
    const purchase = [
      { description: "Item A", quantity: "1", unitCost: "10.00", amount: "10.00" },
      { description: "Item B", quantity: "2", unitCost: "20.00", amount: "40.00" },
    ];
    const withTax = toRealReviewData({
      detail: baseDetail(),
      linked: withInvoice(purchase, [{ label: "GST", amount: "2.50", rate: 5 }]),
      clubTimezone: ZONE,
    });
    const withoutTax = toRealReviewData({
      detail: baseDetail(),
      linked: withInvoice(purchase, null),
      clubTimezone: ZONE,
    });
    expect(withTax.invoice.lineItems).toHaveLength(2);
    expect(withoutTax.invoice.lineItems).toHaveLength(2);
    expect(withTax.invoice.lineItems!.map((l) => l.description)).toEqual(["Item A", "Item B"]);
  });
});
