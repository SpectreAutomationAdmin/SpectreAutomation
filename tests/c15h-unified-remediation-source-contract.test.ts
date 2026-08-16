// Sprint 3 Checkpoint 15H Unified Remediation (2026-07-25) —
// Source-contract locks for the "one canonical Work Intake card per
// inbound email conversation" remediation. Verifies:
//   * child AP/Statement intakes are SUPPRESSED from the MC feed when
//     they originate from an email that already has a PRIMARY email
//     intake — DB records preserved, UI hides them
//   * loadLinkedIntelligenceForEmailIntakes returns the AP + Statement
//     child intake ids + aggregated summaries for tabbed rendering
//   * suppression filter is used on AP + Statement loader queries
//   * MC snapshot builder computes suppression + augments email items
//     with linkedIntelligence before returning
//   * EmailIntakeCard has the tabbed layout, work-type eyebrow branch
//     (EMAIL · AP INVOICE, VENDOR STATEMENT, INVOICE + STATEMENT,
//     EMAIL CORRESPONDENCE), and a "View PDF" surface
//   * DocumentPreviewModal uses the blob-URL pattern so Chrome's
//     X-Frame-Options: DENY / CSP object-src 'none' cannot block it
//   * DocumentPreviewModal has focus trap + Escape close + focus
//     restore + a Download fallback
//   * /documents endpoint also returns EMAIL_ATTACHMENT-sourced
//     IngestedDocuments for email intakes (so the Attachments tab
//     works without needing an evidence link)
//   * Email intake carries linkedIntelligence through to the card

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MC_INDEX = readFileSync(join(process.cwd(), "src/lib/mission-control/index.ts"), "utf8");
const MC_LOADERS = readFileSync(join(process.cwd(), "src/lib/mission-control/intelligence-review-intakes.ts"), "utf8");
const EMAIL_CARD = readFileSync(join(process.cwd(), "src/components/mission-control/EmailIntakeCard.tsx"), "utf8");
const PREVIEW_MODAL = readFileSync(join(process.cwd(), "src/components/mission-control/DocumentPreviewModal.tsx"), "utf8");
const DOCS_ROUTE = readFileSync(join(process.cwd(), "src/app/api/mission-control/work-intake/[id]/documents/route.ts"), "utf8");
const MC_PAGE = readFileSync(join(process.cwd(), "src/app/app/admin/page.tsx"), "utf8");

describe("Child intake suppression — one card per inbound email", () => {
  it("exports loadChildReviewIntakesToSuppress", () => {
    expect(MC_LOADERS).toMatch(/export async function loadChildReviewIntakesToSuppress\(/);
  });
  it("walks INGESTED_DOCUMENT origin → EMAIL_ATTACHMENT → parent email intake", () => {
    // The suppression predicate needs the whole chain.
    expect(MC_LOADERS).toMatch(/kind: "INGESTED_DOCUMENT", role: "PRIMARY"/);
    expect(MC_LOADERS).toMatch(/sourceKind: "EMAIL_ATTACHMENT"/);
    expect(MC_LOADERS).toMatch(/workIntakeOrigins:\s*\{[\s\S]*?role: "PRIMARY"/);
  });
  it("returns two Sets (ap + statement) so callers filter each loader separately", () => {
    expect(MC_LOADERS).toMatch(/suppressedApIntakeIds:\s*Set<string>/);
    expect(MC_LOADERS).toMatch(/suppressedStatementIntakeIds:\s*Set<string>/);
  });
  it("does NOT delete or mutate any underlying WorkIntakeItem / IngestedDocument / findings", () => {
    // The suppression is READ-ONLY: no delete / update / archive on
    // the child intakes. Founder rule: preserve DB records.
    const fn = MC_LOADERS.slice(
      MC_LOADERS.indexOf("loadChildReviewIntakesToSuppress"),
      MC_LOADERS.indexOf("export ", MC_LOADERS.indexOf("loadChildReviewIntakesToSuppress") + 1),
    );
    expect(fn).not.toMatch(/prisma\.workIntakeItem\.delete/);
    expect(fn).not.toMatch(/prisma\.workIntakeItem\.update/);
    expect(fn).not.toMatch(/prisma\.ingestedDocument\.delete/);
    expect(fn).not.toMatch(/prisma\.emailAttachment\.delete/);
  });
  it("AP + Statement loaders accept a suppressedIds Set and filter with id notIn", () => {
    const apBlock = MC_LOADERS.slice(MC_LOADERS.indexOf("loadApReviewIntakeItems"));
    const stmtBlock = MC_LOADERS.slice(MC_LOADERS.indexOf("loadStatementReviewIntakeItems"));
    expect(apBlock).toMatch(/suppressedIds\?:\s*Set<string>/);
    expect(stmtBlock).toMatch(/suppressedIds\?:\s*Set<string>/);
    expect(apBlock).toMatch(/notIn:/);
    expect(stmtBlock).toMatch(/notIn:/);
  });
});

describe("Linked-intelligence resolver — tab facets for the unified card", () => {
  it("exports loadLinkedIntelligenceForEmailIntakes with the LinkedIntelligenceForEmail interface", () => {
    expect(MC_LOADERS).toMatch(/export interface LinkedIntelligenceForEmail/);
    expect(MC_LOADERS).toMatch(/export async function loadLinkedIntelligenceForEmailIntakes\(/);
  });
  it("returns apReviewIntakeIds + statementReviewIntakeIds + attachmentCount + dominantFacet", () => {
    expect(MC_LOADERS).toMatch(/apReviewIntakeIds:\s*string\[\]/);
    expect(MC_LOADERS).toMatch(/statementReviewIntakeIds:\s*string\[\]/);
    expect(MC_LOADERS).toMatch(/attachmentCount:\s*number/);
    expect(MC_LOADERS).toMatch(/invoiceAttachmentCount:\s*number/);
    expect(MC_LOADERS).toMatch(/statementAttachmentCount:\s*number/);
    expect(MC_LOADERS).toMatch(/dominantFacet:\s*"email"\s*\|\s*"invoice"\s*\|\s*"statement"\s*\|\s*"invoice\+statement"/);
  });
  it("carries invoiceSummary via the typed ApInvoiceCardIntelligence shape (15I-2)", () => {
    // Sprint 3 Checkpoint 15I-2 (2026-07-27) — the loader now
    // exports a typed ApInvoiceCardIntelligence with a richer shape
    // (extractedVendor.name, vendorMatch.state, gross.amount,
    // gross.currency, category.label, category.glAccountNumber,
    // capitalState, workflowState, etc.). The pre-15I-2 flat shape
    // is deliberately superseded.
    expect(MC_LOADERS).toMatch(/export interface ApInvoiceCardIntelligence/);
    expect(MC_LOADERS).toMatch(/invoiceSummary\?:\s*ApInvoiceCardIntelligence/);
    // Every field the AP card renders is present on the shape.
    for (const f of [
      "extractedVendor",
      "vendorMatch",
      "invoiceNumber",
      "gross:",
      "workflowState",
      "workflowReason",
      "primaryAttachment",
      "unresolvedFindingCount",
    ]) {
      expect(MC_LOADERS).toMatch(new RegExp(f.replace(/([.*+?^${}()|[\]\\])/g, "\\$1")));
    }
  });
  it("carries statementSummary (closing balance, reconciliation state, unresolved findings)", () => {
    const iface = MC_LOADERS.slice(MC_LOADERS.indexOf("statementSummary?"));
    expect(iface).toMatch(/vendorGuess:\s*string\s*\|\s*null/);
    expect(iface).toMatch(/closingBalance:\s*string\s*\|\s*null/);
    expect(iface).toMatch(/reconciliationState:\s*string\s*\|\s*null/);
    expect(iface).toMatch(/unresolvedFindingCount:\s*number/);
  });
  it("filters out inline attachments (signature images) when counting/classifying", () => {
    // isInline attachments (signature images, inline previews) MUST
    // NOT count toward attachmentCount or drive dominantFacet.
    expect(MC_LOADERS).toMatch(/isInline/);
  });
});

describe("MC snapshot builder — wires suppression + linkedIntelligence", () => {
  it("calls loadChildReviewIntakesToSuppress", () => {
    expect(MC_INDEX).toMatch(/loadChildReviewIntakesToSuppress\(/);
  });
  it("passes suppressedApIntakeIds + suppressedStatementIntakeIds into the loaders", () => {
    expect(MC_INDEX).toMatch(/suppressedIds:\s*suppressedApIntakeIds/);
    expect(MC_INDEX).toMatch(/suppressedIds:\s*suppressedStatementIntakeIds/);
  });
  it("augments email items with linkedIntelligence before returning", () => {
    expect(MC_INDEX).toMatch(/loadLinkedIntelligenceForEmailIntakes\(/);
    expect(MC_INDEX).toMatch(/linkedIntelligence/);
  });
  it("WorkItem type exposes optional linkedIntelligence", () => {
    expect(MC_INDEX).toMatch(/linkedIntelligence\?:/);
  });
});

describe("EmailIntakeCard — tabbed layout (Phase 4R rev-7 · 2026-08-15 supersede)", () => {
  // Rev-7 reduces the founder-facing tab set from five to three
  // (spectre-summary | conversation | attachments). Invoice Review
  // / Statement Review / Activity are retired; their content lives
  // inside the Spectre Summary (Invoice/Statement) or is
  // server-side only (Activity).
  it("declares the rev-7 tab set: spectre-summary | conversation | attachments", () => {
    expect(EMAIL_CARD).toMatch(/type Tab\s*=\s*"spectre-summary"\s*\|\s*"conversation"\s*\|\s*"attachments";/);
  });
  it("Rev-7: no {expanded ? …} accordion wrapper remains — cards are tab-driven", () => {
    expect(EMAIL_CARD).toMatch(/const availableTabs = tabsFor\(data\)/);
    expect(EMAIL_CARD).not.toMatch(/\{expanded \?/);
    expect(EMAIL_CARD).not.toMatch(/spectre-mc-item-expanded/);
  });
  it("renders a CardTabBar sub-component with role=tablist / role=tab", () => {
    expect(EMAIL_CARD).toMatch(/function CardTabBar\(/);
    expect(EMAIL_CARD).toMatch(/role="tablist"/);
    expect(EMAIL_CARD).toMatch(/role="tab"/);
    expect(EMAIL_CARD).toMatch(/aria-selected/);
  });
  it("rev-7 tab-label vocab", () => {
    expect(EMAIL_CARD).toMatch(/"spectre-summary":\s*"Spectre Summary"/);
    expect(EMAIL_CARD).toMatch(/conversation:\s*"Conversation"/);
    expect(EMAIL_CARD).toMatch(/attachments:\s*"Attachments"/);
    expect(EMAIL_CARD).not.toMatch(/invoice:\s*"Invoice Review"/);
    expect(EMAIL_CARD).not.toMatch(/statement:\s*"Statement Review"/);
    expect(EMAIL_CARD).not.toMatch(/activity:\s*"Activity"/);
  });
  it("PDF preview is offered via the DocumentPreviewModal (Attachments tab)", () => {
    expect(EMAIL_CARD).toMatch(/import DocumentPreviewModal/);
    expect(EMAIL_CARD).toMatch(/<DocumentPreviewModal/);
  });
  it("Rev-7: InvoiceFacetPane + StatementFacetPane retired with their tabs", () => {
    expect(EMAIL_CARD).not.toMatch(/function InvoiceFacetPane\(/);
    expect(EMAIL_CARD).not.toMatch(/function StatementFacetPane\(/);
  });
  it("Rev-7: only lazy-loads conversation + attachments (invoice/statement evidence is no longer proxied through the card)", () => {
    expect(EMAIL_CARD).toMatch(/loadConversationOnce/);
    expect(EMAIL_CARD).toMatch(/loadAttachmentsOnce/);
    expect(EMAIL_CARD).not.toMatch(/loadApEvidenceOnce\(/);
    expect(EMAIL_CARD).not.toMatch(/loadStatementEvidenceOnce\(/);
    // The ap-evidence + statement-evidence endpoints STILL EXIST
    // (used by tests + the CVAP modal); the card just no longer
    // proxies them into tab bodies. Assert against calls in the
    // card, not the presence of the endpoint URL elsewhere.
    // Attachments are fetched from the EMAIL intake id — the
    // /documents route walks the email origin chain.
    expect(EMAIL_CARD).toMatch(/\/api\/mission-control\/work-intake\/.*\/documents/);
  });
});

describe("DocumentPreviewModal — blob-URL bypass for X-Frame-Options: DENY", () => {
  it("fetches the preview endpoint with credentials + accept header, then URL.createObjectURL", () => {
    expect(PREVIEW_MODAL).toMatch(/credentials:\s*"same-origin"/);
    expect(PREVIEW_MODAL).toMatch(/URL\.createObjectURL\(/);
    // Iframe src MUST be the blob URL, NEVER the raw /preview URL —
    // that's what makes X-Frame-Options: DENY and CSP object-src
    // 'none' irrelevant to the modal.
    expect(PREVIEW_MODAL).toMatch(/src=\{blobUrl\}/);
  });
  it("revokes the blob URL on unmount + on close (no leaked object URLs)", () => {
    expect(PREVIEW_MODAL).toMatch(/URL\.revokeObjectURL\(/);
  });
  it("traps focus on Tab / Shift+Tab within the dialog", () => {
    expect(PREVIEW_MODAL).toMatch(/focusable/);
    expect(PREVIEW_MODAL).toMatch(/e\.shiftKey/);
    expect(PREVIEW_MODAL).toMatch(/last\.focus\(\)/);
    expect(PREVIEW_MODAL).toMatch(/first\.focus\(\)/);
  });
  it("closes on Escape and restores focus to the opener", () => {
    expect(PREVIEW_MODAL).toMatch(/e\.key === "Escape"/);
    expect(PREVIEW_MODAL).toMatch(/previousActive\.current/);
    expect(PREVIEW_MODAL).toMatch(/previousActive\.current\?\.focus\?\.\(\)/);
  });
  it("provides a Download action as a fallback when preview fails", () => {
    expect(PREVIEW_MODAL).toMatch(/data-testid="doc-preview-download"/);
    expect(PREVIEW_MODAL).toMatch(/\/api\/documents\/.*\/download/);
  });
  it("has role=dialog + aria-modal=true + aria-labelledby the filename heading", () => {
    expect(PREVIEW_MODAL).toMatch(/role="dialog"/);
    expect(PREVIEW_MODAL).toMatch(/aria-modal="true"/);
    expect(PREVIEW_MODAL).toMatch(/aria-labelledby="spectre-doc-preview-title"/);
  });
  it("never renders the storage key, bucket, or Graph attachment id", () => {
    expect(PREVIEW_MODAL).not.toMatch(/storageKey/);
    expect(PREVIEW_MODAL).not.toMatch(/storageBucket/);
    expect(PREVIEW_MODAL).not.toMatch(/graphAttachmentId/);
  });
});

describe("/documents endpoint — surfaces email-attachment docs for email intakes", () => {
  it("resolves the email intake's PRIMARY EmailWorkIntakeOrigin", () => {
    expect(DOCS_ROUTE).toMatch(/emailWorkIntakeOrigin\.findFirst/);
    expect(DOCS_ROUTE).toMatch(/role: "PRIMARY"/);
  });
  it("looks up IngestedDocuments by sourceKind=EMAIL_ATTACHMENT + sourceReferenceId IN [...]", () => {
    expect(DOCS_ROUTE).toMatch(/sourceKind:\s*"EMAIL_ATTACHMENT"/);
    expect(DOCS_ROUTE).toMatch(/sourceReferenceId:\s*\{\s*in:/);
  });
  it("filters out inline attachments (signature images)", () => {
    expect(DOCS_ROUTE).toMatch(/isInline/);
  });
  it("dedupes with the evidence-link results before returning", () => {
    // Same doc could be reachable via BOTH paths — dedup by id.
    expect(DOCS_ROUTE).toMatch(/new Map<string,/);
  });
  it("never returns storage key, bucket, or Graph attachment id", () => {
    expect(DOCS_ROUTE).not.toMatch(/storageKey/);
    expect(DOCS_ROUTE).not.toMatch(/storageBucket/);
    expect(DOCS_ROUTE).not.toMatch(/graphAttachmentId/);
  });
});

describe("Wiring — MC page passes linkedIntelligence through to EmailIntakeCard", () => {
  it("page.tsx emailFeedData copies item.linkedIntelligence into the card payload", () => {
    expect(MC_PAGE).toMatch(/linkedIntelligence:\s*item\.linkedIntelligence/);
  });
  it("EmailFeedCardData interface consumes the typed LinkedIntelligenceForEmail (15I-2)", () => {
    // Sprint 3 Checkpoint 15I-2 — the card's linkedIntelligence
    // prop is now the exported LinkedIntelligenceForEmail type
    // (which itself carries the typed ApInvoiceCardIntelligence).
    // Direct inline field enumeration is superseded.
    expect(EMAIL_CARD).toMatch(/linkedIntelligence\?:\s*LinkedIntelligenceForEmail/);
    expect(EMAIL_CARD).toMatch(/import type \{ LinkedIntelligenceForEmail, ApInvoiceCardIntelligence \}/);
  });
});
