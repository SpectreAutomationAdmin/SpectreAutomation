// WI-2C — feed AP intelligence promotion tests. Verifies that
// `linkedIntelligence.invoiceSummary` overrides the persisted email
// classification for icon, status label, meta line, description,
// action label, and financial-context sub-line.

import { describe, expect, it } from "vitest";
import { toFeedRow } from "@/lib/work-intake/feed-view-model";
import type { WorkItem } from "@/lib/mission-control";
import type { LinkedIntelligenceForEmail } from "@/lib/mission-control/intelligence-review-intakes";

const ZONE = "America/Edmonton";
const CTX = { clubTimezone: ZONE, nowIso: "2026-09-28T18:00:00Z" };

function baseItem(overrides: Partial<Omit<WorkItem, "classification">> & { classification?: string } = {}): WorkItem {
  return {
    id: "wi_x",
    state: "info",
    idTag: "WI-X",
    title: "Sample",
    sender: { from: "Someone" },
    timestamp: "2026-09-27T18:00:00Z",
    timestampLabel: "1 day ago",
    actions: [],
    sortTimestamp: "2026-09-27T18:00:00Z",
    workIntakeItemId: "x",
    workDomain: "ACCOUNTS_PAYABLE",
    classification: "INFORMATIONAL",
    ...overrides,
  } as unknown as WorkItem;
}

function invoiceSummary(overrides: Partial<NonNullable<LinkedIntelligenceForEmail["invoiceSummary"]>> = {}): LinkedIntelligenceForEmail {
  return {
    apReviewIntakeIds: [], statementReviewIntakeIds: [],
    attachmentCount: 1, invoiceAttachmentCount: 1, statementAttachmentCount: 0,
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
      category: {
        label: "Subscriptions",
        glAccountNumber: "6071",
        glAccountName: "Subscriptions",
        capitalState: "OPERATING",
        source: null,
        alternates: [],
      },
      workflowState: "VENDOR_MATCH_REQUIRED",
      workflowReason: null,
      lineItems: [
        { description: "Microsoft 365 Business Standard", quantity: "26", unitCost: "17.85", amount: "464.10" },
        { description: "Microsoft 365 Business Basic", quantity: "5", unitCost: "8.51", amount: "42.55" },
        { description: "Microsoft 365 Business Premium", quantity: "5", unitCost: "35.76", amount: "178.80" },
        { description: "Microsoft 365 Visio Plan 2", quantity: "2", unitCost: "21.42", amount: "42.84" },
      ],
      tax: [{ label: "GST", amount: "37.06", rate: 5 }],
      ...overrides,
    },
  } as unknown as LinkedIntelligenceForEmail;
}

describe("WI-2C — icon precedence", () => {
  it("AP invoice with linkedIntelligence.invoiceSummary gets the invoice icon regardless of email classification", () => {
    // The exact PAY NOW pattern: workDomain=ACCOUNTS_PAYABLE,
    // classification=INFORMATIONAL, but linkedIntelligence has an
    // invoiceSummary. WI-2B mapped this to `ap`. WI-2C returns `invoice`.
    const row = toFeedRow(
      baseItem({ classification: "INFORMATIONAL", linkedIntelligence: invoiceSummary() }),
      CTX,
    );
    expect(row.icon).toBe("invoice");
  });

  it("AP_INVOICE_REVIEW WI (child intake) also gets the invoice icon", () => {
    const row = toFeedRow(
      baseItem({ classification: "AP_INVOICE_REVIEW", linkedIntelligence: undefined }),
      CTX,
    );
    expect(row.icon).toBe("invoice");
  });

  it("Both variants receive the SAME icon (PAY NOW parity with the AP_INVOICE_REVIEW child)", () => {
    const parent = toFeedRow(
      baseItem({ id: "wi_a", workIntakeItemId: "a", classification: "INFORMATIONAL", linkedIntelligence: invoiceSummary() }),
      CTX,
    );
    const child = toFeedRow(
      baseItem({ id: "wi_b", workIntakeItemId: "b", classification: "AP_INVOICE_REVIEW", linkedIntelligence: undefined }),
      CTX,
    );
    expect(parent.icon).toBe(child.icon);
  });

  it("Non-AP items keep their domain-based icon", () => {
    const payroll = toFeedRow(baseItem({ workDomain: "PAYROLL", classification: "PAYROLL_FINAL_APPROVAL", linkedIntelligence: undefined }), CTX);
    expect(payroll.icon).toBe("payroll");
    const ar = toFeedRow(baseItem({ workDomain: "ACCOUNTS_RECEIVABLE", classification: "AR_AGING_60", linkedIntelligence: undefined }), CTX);
    expect(ar.icon).toBe("member");
  });

  it("Sender identity never affects the icon", () => {
    const fromA = toFeedRow(baseItem({ sender: { from: "alice@example.com" }, linkedIntelligence: invoiceSummary() }), CTX);
    const fromB = toFeedRow(baseItem({ sender: { from: "bob@example.com" }, linkedIntelligence: invoiceSummary() }), CTX);
    expect(fromA.icon).toBe(fromB.icon);
  });
});

describe("WI-2C — status precedence", () => {
  it("state='info' but linkedIntelligence has actionable workflow → 'Requires your judgment'", () => {
    const row = toFeedRow(
      baseItem({ state: "info", linkedIntelligence: invoiceSummary({ workflowState: "VENDOR_MATCH_REQUIRED" }) }),
      CTX,
    );
    expect(row.status).toEqual({ label: "Requires your judgment", tone: "judgment" });
  });

  it("state='info' without linkedIntelligence stays FYI", () => {
    const row = toFeedRow(baseItem({ state: "info", linkedIntelligence: undefined }), CTX);
    expect(row.status).toEqual({ label: "FYI", tone: "fyi" });
  });

  it("state='info' with ANALYSIS_PENDING does NOT promote", () => {
    const row = toFeedRow(
      baseItem({ state: "info", linkedIntelligence: invoiceSummary({ workflowState: "ANALYSIS_PENDING" }) }),
      CTX,
    );
    expect(row.status).toEqual({ label: "FYI", tone: "fyi" });
  });

  it("all actionable AP workflow states promote", () => {
    for (const state of ["READY_FOR_APPROVAL", "VENDOR_MATCH_REQUIRED", "MISSING_INFORMATION", "NEEDS_JUDGMENT", "POSSIBLE_DUPLICATE", "CHART_OF_ACCOUNTS_REQUIRED"] as const) {
      const row = toFeedRow(
        baseItem({ state: "info", linkedIntelligence: invoiceSummary({ workflowState: state }) }),
        CTX,
      );
      expect(row.status.label, `state=${state}`).toBe("Requires your judgment");
    }
  });
});

describe("WI-2C.1 — AP title hierarchy", () => {
  it("resolved AP invoice with category → title 'AP Invoice · {category}'", () => {
    const row = toFeedRow(
      baseItem({ title: "PAY NOW", linkedIntelligence: invoiceSummary() }),
      CTX,
    );
    expect(row.title).toBe("AP Invoice · Subscriptions");
  });

  it("email subject 'PAY NOW' is not used as the AP title once resolved", () => {
    const row = toFeedRow(
      baseItem({ title: "PAY NOW", linkedIntelligence: invoiceSummary() }),
      CTX,
    );
    expect(row.title).not.toBe("PAY NOW");
    expect(row.title).not.toContain("PAY NOW");
  });

  it("email subject 'Vendor reports an unpaid invoice' is not used as the AP title", () => {
    const row = toFeedRow(
      baseItem({
        title: "Vendor reports an unpaid invoice",
        linkedIntelligence: invoiceSummary({
          category: { label: "Telephone & Internet", glAccountNumber: "6072", glAccountName: "Telephone & Internet", capitalState: "OPERATING", source: null, alternates: [] } as never,
        }),
      }),
      CTX,
    );
    expect(row.title).toBe("AP Invoice · Telephone & Internet");
    expect(row.title).not.toContain("Vendor reports");
  });

  it("category missing but GL name present → uses GL name", () => {
    const row = toFeedRow(
      baseItem({
        title: "PAY NOW",
        linkedIntelligence: invoiceSummary({
          category: { label: null, glAccountNumber: "6099", glAccountName: "Miscellaneous", capitalState: "OPERATING", source: null, alternates: [] } as never,
        }),
      }),
      CTX,
    );
    expect(row.title).toBe("AP Invoice · Miscellaneous");
  });

  it("category + GL name missing → title 'AP Invoice'", () => {
    const row = toFeedRow(
      baseItem({
        title: "PAY NOW",
        linkedIntelligence: invoiceSummary({
          category: { label: null, glAccountNumber: null, glAccountName: null, capitalState: null, source: null, alternates: [] } as never,
        }),
      }),
      CTX,
    );
    expect(row.title).toBe("AP Invoice");
  });

  it("subtitle drops GL (was `vendor · total · GL`; now `vendor · total`)", () => {
    const row = toFeedRow(baseItem({ linkedIntelligence: invoiceSummary() }), CTX);
    expect(row.metaLine).toBe("Club Support Inc · $778.16 CAD");
    expect(row.metaLine).not.toContain("6071");
    expect(row.metaLine).not.toContain("Subscriptions");
  });

  it("non-AP items retain original title", () => {
    const row = toFeedRow(
      baseItem({
        title: "Weekly Update – Week of September 23rd, 2026",
        workDomain: "GENERAL", classification: "INFORMATIONAL", linkedIntelligence: undefined,
      }),
      CTX,
    );
    expect(row.title).toBe("Weekly Update – Week of September 23rd, 2026");
  });
});

describe("WI-2C — meta line + description", () => {
  it("AP invoice meta line = vendor · total (WI-2C.1 subtitle rule)", () => {
    const row = toFeedRow(baseItem({ linkedIntelligence: invoiceSummary() }), CTX);
    expect(row.metaLine).toBe("Club Support Inc · $778.16 CAD");
  });

  it("AP invoice description = concise purpose commentary from real evidence", () => {
    const row = toFeedRow(baseItem({ linkedIntelligence: invoiceSummary() }), CTX);
    expect(row.description).toContain("Subscriptions");
    expect(row.description).toContain("Club Support Inc");
    expect(row.description).toContain("Microsoft 365 Business Standard");
  });

  it("description does NOT contain any subtotal / tax mangled text", () => {
    const row = toFeedRow(baseItem({ linkedIntelligence: invoiceSummary() }), CTX);
    expect(row.description).not.toContain("Billing Cycle");
    expect(row.description).not.toContain("6741");
    expect(row.description).not.toContain("741.10");
  });

  it("Non-AP items keep the original meta + description path", () => {
    const row = toFeedRow(
      baseItem({
        workDomain: "GENERAL", classification: "INFORMATIONAL",
        sender: { from: "Newsletter", ctx: "Weekly update" },
        synopsisText: "Weekly update text.",
        linkedIntelligence: undefined,
      }),
      CTX,
    );
    expect(row.metaLine).toBe("Newsletter · Weekly update");
    expect(row.description).toBe("Weekly update text.");
  });
});

describe("WI-2C — action label", () => {
  it("AP invoice always uses Review (never View), even when base state is info", () => {
    const row = toFeedRow(
      baseItem({ state: "info", linkedIntelligence: invoiceSummary() }),
      CTX,
    );
    expect(row.actionLabel).toBe("Review");
  });

  it("Non-AP info items still use View", () => {
    const row = toFeedRow(
      baseItem({ state: "info", workDomain: "GENERAL", classification: "INFORMATIONAL", linkedIntelligence: undefined }),
      CTX,
    );
    expect(row.actionLabel).toBe("View");
  });
});

describe("WI-2C — financial context commentary (truthful only)", () => {
  it("vendor not found → 'First comparable invoice found — no historical comparison available.'", () => {
    const row = toFeedRow(
      baseItem({
        linkedIntelligence: invoiceSummary({
          vendorMatch: { state: "NOT_FOUND", matchedName: null, matchedVendorId: null },
          invoiceCadenceThisQuarter: null,
        }),
      }),
      CTX,
    );
    expect(row.financialContext).toBe("First comparable invoice found — no historical comparison available.");
  });

  it("cadence 0 → 'First invoice from this vendor this quarter.'", () => {
    const row = toFeedRow(
      baseItem({
        linkedIntelligence: invoiceSummary({
          vendorMatch: { state: "MATCHED", matchedName: "Club Support Inc", matchedVendorId: "v1" },
          invoiceCadenceThisQuarter: 0,
        }),
      }),
      CTX,
    );
    expect(row.financialContext).toBe("First invoice from this vendor this quarter.");
  });

  it("cadence 2 (3rd invoice) uses ordinal suffix correctly", () => {
    const row = toFeedRow(
      baseItem({
        linkedIntelligence: invoiceSummary({
          vendorMatch: { state: "MATCHED", matchedName: "Club Support Inc", matchedVendorId: "v1" },
          invoiceCadenceThisQuarter: 2,
        }),
      }),
      CTX,
    );
    expect(row.financialContext).toBe("3rd invoice from this vendor this quarter.");
  });

  it("no financial context on non-AP items", () => {
    const row = toFeedRow(baseItem({ workDomain: "GENERAL", linkedIntelligence: undefined }), CTX);
    expect(row.financialContext).toBeUndefined();
  });

  it("no fabricated budget language when no evidence exists", () => {
    const row = toFeedRow(
      baseItem({
        linkedIntelligence: invoiceSummary({
          vendorMatch: { state: "MATCHED", matchedName: "Club Support Inc", matchedVendorId: "v1" },
          invoiceCadenceThisQuarter: null,
        }),
      }),
      CTX,
    );
    // Must NOT invent "On budget" / "Above budget" / "$X above average"
    // when the pipeline did not compute a comparison.
    expect(row.financialContext ?? "").not.toMatch(/budget|above|below|average|\$/i);
    expect(row.financialContext).toBe("Historical comparison not yet available.");
  });
});
