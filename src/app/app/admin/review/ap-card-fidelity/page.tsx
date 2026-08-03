// Sprint 3 Checkpoint 15I-2 (2026-07-27) — AP card fidelity review.
//
// Development-only. Renders the ACTUAL production EmailIntakeCard
// component against fixture data that mirrors the real Microsoft
// invoice extraction, in every workflow state the founder brief
// enumerates:
//
//   1. Vendor unmatched
//   2. Vendor matched + ready for approval
//   3. PO matched
//   4. No PO
//   5. Low-confidence category
//   6. Assigned to another user
//   7. Deferred for 24 hours
//   8. Expanded (all contextual tabs)
//
// Rules honoured (§Phase 8 of the founder brief):
//   • Uses the real EmailIntakeCard from src/components/mission-control/
//     — NOT a static mock-up.
//   • Uses the real ApInvoiceCardIntelligence shape from the loader.
//   • Dev-gated: NODE_ENV !== "production" → notFound.
//   • Not linked from the production sidebar; not routed in prod.
//
// See docs/design/work-intake-card-concepts.md history for the
// broader concept-review conventions.

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/session";
import EmailIntakeCard, { type EmailFeedCardData } from "@/components/mission-control/EmailIntakeCard";
import type { ApInvoiceCardIntelligence } from "@/lib/mission-control";

export const dynamic = "force-dynamic";

export default async function ApCardFidelityReviewPage() {
  if (process.env.NODE_ENV === "production") return notFound();
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <FidelityReview />;
}

// -------------------------------------------------------------------------
// Fixture states — every scenario the founder brief §Phase 8 enumerates.
// -------------------------------------------------------------------------

const MICROSOFT_BASE = {
  workIntakeItemId: "fx-msft-parent",
  emailMessageId: "fx-msft-email",
  idTag: "AP-93458",
  state: "judgment" as const,
  situationTitle: "",           // AP mode overrides — not read
  contextLine: "",              // AP mode overrides — not read
  timestampLabel: "1 day ago",
  synopsisText: "",             // AP mode overrides — not read
  evidence: [],                 // AP mode overrides — not read
  isUnread: true,
  isHighImportance: false,
  conversationMessageCount: 1,
  workIntakeStatus: "OPEN" as const,
};

function baseApFacts(): ApInvoiceCardIntelligence {
  return {
    sender: {
      name: "Chris Turcato",
      email: "cturcato@spectreautomation.com",
      relationship: "EMPLOYEE_FORWARD",
    },
    extractedVendor: { name: "Microsoft Corporation" },
    vendorMatch: { state: "NOT_FOUND", matchedName: null, matchedVendorId: null },
    invoiceNumber: "E0701097E3",
    gross: { amount: "31.29", currency: "CAD" },
    paymentTerms: null,
    paymentTermsSource: null,
    purchaseOrder: { poNumber: null, matchedPoDocumentId: null, variance: null },
    category: {
      label: null,
      glAccountNumber: null,
      glAccountName: null,
      capitalState: "OPERATING",
      source: null,
      alternates: [],
    },
    gstVerification: null,
    gstRatePercent: null,
    // Sprint 3 · Checkpoint 15P — fidelity fixture has no PDF, so
    // the extracted profile is null (matches the real DOCUMENT_UNREADABLE
    // path).
    extractedVendorProfile: null,
    invoiceCadenceThisQuarter: null,
    confidence: 62,
    workflowState: "VENDOR_MATCH_REQUIRED",
    workflowReason:
      "Match Microsoft Corporation to an existing vendor or onboard it, then confirm the proposed coding.",
    unresolvedFindingCount: 1,
    primaryAttachment: { documentId: "fx-doc-93458", filename: "93458725404.pdf" },
    allocations: null,
    workCardFacts: {
      documentFacts: {
        supplierNamePresent: true,
        payableReferencePresent: true,
        invoiceDatePresent: true,
        dueDatePresent: false,
        grossTotalPresent: true,
        currencyPresent: true,
      },
      vendorResolution: { state: "NEW_VENDOR_REQUIRED" },
      codingProposal: { state: "SINGLE", hasCategoryLabel: true, hasAllocations: false },
      postingReadiness: { ready: false, blockerCount: 0 },
    },
  };
}

interface Scenario {
  key: string;
  heading: string;
  note: string;
  ap: ApInvoiceCardIntelligence;
  overrideStatus?: string;
}

const SCENARIOS: Scenario[] = [
  {
    key: "vendor-unmatched",
    heading: "1 · Vendor unmatched (current staging state)",
    note: "Extraction is complete but Microsoft Corporation is not on file as a Spectre vendor.",
    ap: baseApFacts(),
  },
  {
    key: "vendor-matched-ready",
    heading: "2 · Vendor matched · ready for approval",
    note: "Vendor onboarded; GL coding + amount confirmed; no reconcile variance.",
    ap: {
      ...baseApFacts(),
      vendorMatch: { state: "MATCHED", matchedName: "Microsoft Corporation", matchedVendorId: "fx-vendor-msft" },
      paymentTerms: "Net 30",
      category: {
        label: "Software subscriptions",
        glAccountNumber: "6220",
        glAccountName: "Software subscriptions",
        capitalState: "OPERATING",
        source: "NAME_KEYWORD",
        alternates: [],
      },
      invoiceCadenceThisQuarter: 3,
      confidence: 96,
      workflowState: "READY_FOR_APPROVAL",
      workflowReason: "Approve and post to GL 6220 Software subscriptions. No exceptions detected.",
      unresolvedFindingCount: 0,
    },
  },
  {
    key: "po-matched",
    heading: "3 · PO matched",
    note: "Vendor + coding confirmed; PO reference extracted and matched to an internal PO doc.",
    ap: {
      ...baseApFacts(),
      vendorMatch: { state: "MATCHED", matchedName: "Microsoft Corporation", matchedVendorId: "fx-vendor-msft" },
      paymentTerms: "Net 30",
      purchaseOrder: { poNumber: "PO-4832", matchedPoDocumentId: "fx-po-4832", variance: "0.00" },
      category: {
        label: "Software subscriptions",
        glAccountNumber: "6220",
        glAccountName: "Software subscriptions",
        capitalState: "OPERATING",
        source: "NAME_KEYWORD",
        alternates: [],
      },
      invoiceCadenceThisQuarter: 3,
      confidence: 98,
      workflowState: "READY_FOR_APPROVAL",
      workflowReason: "Approve and post to GL 6220 Software subscriptions. No PO variance detected.",
      unresolvedFindingCount: 0,
    },
  },
  {
    key: "no-po",
    heading: "4 · No PO (invoice number in the PO/Invoice cell)",
    note: "Vendor + amount confirmed but no PO reference — readout shows invoice # instead.",
    ap: {
      ...baseApFacts(),
      vendorMatch: { state: "MATCHED", matchedName: "Microsoft Corporation", matchedVendorId: "fx-vendor-msft" },
      paymentTerms: "Net 30",
      category: {
        label: "Software subscriptions",
        glAccountNumber: "6220",
        glAccountName: "Software subscriptions",
        capitalState: "OPERATING",
        source: "NAME_KEYWORD",
        alternates: [],
      },
      invoiceCadenceThisQuarter: 3,
      confidence: 92,
      workflowState: "READY_FOR_APPROVAL",
      workflowReason: "Approve and post to GL 6220 Software subscriptions. No PO on file — invoice is direct billing.",
      unresolvedFindingCount: 0,
    },
  },
  {
    key: "low-confidence-category",
    heading: "5 · Low-confidence category (needs judgment)",
    note: "Extraction succeeded but the GL/category recommender is uncertain — reviewer confirms coding.",
    ap: {
      ...baseApFacts(),
      vendorMatch: { state: "MATCHED", matchedName: "Microsoft Corporation", matchedVendorId: "fx-vendor-msft" },
      category: {
        label: null,
        glAccountNumber: null,
        glAccountName: null,
        capitalState: "AMBIGUOUS",
        source: null,
        alternates: [],
      },
      invoiceCadenceThisQuarter: 3,
      confidence: 54,
      workflowState: "NEEDS_JUDGMENT",
      workflowReason: "Review the extracted invoice facts before advancing — GL category confidence is low.",
      unresolvedFindingCount: 2,
    },
  },
  {
    key: "assigned-to-other",
    heading: "6 · Assigned to another Spectre user",
    note: "Card is currently owned by another admin. Assign display remains available; primary action unchanged.",
    ap: {
      ...baseApFacts(),
      vendorMatch: { state: "MATCHED", matchedName: "Microsoft Corporation", matchedVendorId: "fx-vendor-msft" },
      workflowState: "READY_FOR_APPROVAL",
      workflowReason: "Approve and post. Currently assigned to another reviewer.",
    },
  },
  {
    key: "deferred",
    heading: "7 · Deferred for 24 hours",
    note: "Fixture — after Defer 24 hr, the loader excludes the item from the active feed. Shown here for shape only.",
    ap: baseApFacts(),
    overrideStatus: "DEFERRED",
  },
  {
    key: "missing-information",
    heading: "8 · Missing information (PDF partial-extract)",
    note: "PDF text extraction returned partial content — invoice number recovered, total not confidently read.",
    ap: {
      ...baseApFacts(),
      invoiceNumber: "E0701097E3",
      gross: { amount: null, currency: null },
      confidence: 28,
      workflowState: "MISSING_INFORMATION",
      workflowReason: "The extractor could not confidently read the total. Open review to fill in the missing values.",
    },
  },
];

function FidelityReview() {
  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 20px 96px" }}>
      <header style={{ borderBottom: "1px solid var(--spectre-border-hairline)", paddingBottom: 12, marginBottom: 20 }}>
        <p style={{ fontSize: 11, letterSpacing: "1.5px", textTransform: "uppercase", color: "#8a7f6a", fontWeight: 600, margin: 0 }}>
          Development · concept review
        </p>
        <h1 style={{ margin: "4px 0 0", font: "400 24px/1.15 'Iowan Old Style', Georgia, serif" }}>
          AP card fidelity — Microsoft invoice against Ace Foods reference
        </h1>
        <p style={{ fontSize: 13, color: "#635a4a", margin: "6px 0 0", maxWidth: 780 }}>
          Every card below renders the <strong>real production <code>EmailIntakeCard</code> component</strong> with
          the Microsoft-fixture <code>ApInvoiceCardIntelligence</code> projection — the exact shape the loader will
          produce on staging after this rework lands. Compare against{" "}
          <Link href="/design-concepts/mission-control/variant-d-instrument.html" target="_blank" style={{ color: "#2f4739", fontWeight: 600 }}>
            the Ace Foods reference
          </Link>
          .
        </p>
      </header>

      {SCENARIOS.map((s) => (
        <section key={s.key} style={{ marginBottom: 32 }} data-testid={`ap-fidelity-${s.key}`}>
          <h2 style={{ font: "400 15px/1.2 Georgia, serif", margin: "0 0 4px" }}>{s.heading}</h2>
          <p style={{ fontSize: 12, color: "#8a7f6a", margin: "0 0 10px" }}>{s.note}</p>
          <EmailIntakeCard
            data={{
              ...MICROSOFT_BASE,
              workIntakeItemId: `${MICROSOFT_BASE.workIntakeItemId}-${s.key}`,
              workIntakeStatus: s.overrideStatus ?? MICROSOFT_BASE.workIntakeStatus,
              linkedIntelligence: {
                apReviewIntakeIds: ["fx-child"],
                statementReviewIntakeIds: [],
                attachmentCount: 1,
                invoiceAttachmentCount: 1,
                statementAttachmentCount: 0,
                dominantFacet: "invoice",
                invoiceSummary: s.ap,
              } satisfies EmailFeedCardData["linkedIntelligence"],
            }}
          />
        </section>
      ))}
    </div>
  );
}
