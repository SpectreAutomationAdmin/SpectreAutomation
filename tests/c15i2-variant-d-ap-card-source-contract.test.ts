// Sprint 3 Checkpoint 15I-2 (2026-07-27) — AP invoice card fidelity locks.
//
// These tests hold the shape of the Variant D AP-mode card and the
// data-projection pipeline so that future edits cannot silently:
//   • project the email sender as the vendor,
//   • drop the PDF-extracted vendor/invoice/total from the parent
//     card, forcing the reviewer back into the modal,
//   • re-introduce the narrative "Vendor reports an unpaid invoice"
//     title in place of the factual "<Vendor> invoice #<N> — <A>"
//     title,
//   • demote the primary action back to "Resolve" for AP cards,
//   • drop the Defer 24 hr, attachment aux link, or workflow-state
//     pill from the collapsed body,
//   • re-parse the PDF inside the React component,
//   • merge the suppressed AP child intake into the parent row.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CARD = read("src/components/mission-control/EmailIntakeCard.tsx");
const LOADER = read("src/lib/mission-control/intelligence-review-intakes.ts");
const INDEX = read("src/lib/mission-control/index.ts");
const FIXTURE_PAGE = read("src/app/app/admin/review/ap-card-fidelity/page.tsx");

function read(p: string) {
  return readFileSync(join(process.cwd(), p), "utf8");
}

describe("ApInvoiceCardIntelligence — typed projection contract", () => {
  it("declares the typed shape with every required field", () => {
    expect(LOADER).toMatch(/export interface ApInvoiceCardIntelligence/);
    // Every field the AP card renders
    for (const f of [
      "sender:",
      "relationship:",
      "extractedVendor:",
      "vendorMatch:",
      "invoiceNumber",
      "gross:",
      "paymentTerms",
      "purchaseOrder",
      "category:",
      "invoiceCadenceThisQuarter",
      "confidence",
      "workflowState",
      "workflowReason",
      "unresolvedFindingCount",
      "primaryAttachment",
    ]) {
      expect(LOADER).toMatch(new RegExp(f.replace(/([.*+?^${}()|[\]\\])/g, "\\$1")));
    }
  });
  it("workflow state enum matches the founder brief (§7)", () => {
    expect(LOADER).toMatch(/"READY_FOR_APPROVAL"/);
    expect(LOADER).toMatch(/"VENDOR_MATCH_REQUIRED"/);
    expect(LOADER).toMatch(/"MISSING_INFORMATION"/);
    expect(LOADER).toMatch(/"NEEDS_JUDGMENT"/);
    expect(LOADER).toMatch(/"POSSIBLE_DUPLICATE"/);
  });
  it("sender.relationship enum distinguishes VENDOR / EMPLOYEE_FORWARD / OTHER", () => {
    expect(LOADER).toMatch(/"VENDOR"\s*\|\s*"EMPLOYEE_FORWARD"\s*\|\s*"OTHER"/);
  });
});

describe("summariseApIntake — real extraction projection", () => {
  it("calls analyseIngestedInvoice against the child intake's primary document", () => {
    expect(LOADER).toMatch(/import\s*\{\s*analyseIngestedInvoice\s*\}\s*from\s*["']@\/lib\/ap-intelligence\/analyse["']/);
    expect(LOADER).toMatch(/analyseIngestedInvoice\(\{\s*clubId,\s*ingestedDocumentId:\s*docRef\s*\}\)/);
  });
  it("no field of the returned invoiceSummary is hardcoded to null", () => {
    // Guard against the pre-15I-2 pattern where vendorGuess/invoiceNumber/
    // total/currency were literally `null` regardless of extraction.
    const fn = LOADER.slice(
      LOADER.indexOf("async function summariseApIntake"),
      LOADER.indexOf("async function classifySenderRelationship"),
    );
    expect(fn).not.toMatch(/vendorGuess:\s*null,\s*invoiceNumber:\s*null,\s*total:\s*null/);
  });
  it("projects sender identity via a walk email → attachment → intake, never from vendor guess", () => {
    // Walk the EmailAttachment.id chain via sourceReferenceId.
    expect(LOADER).toMatch(/emailAttachment\.findFirst/);
    expect(LOADER).toMatch(/doc\.sourceReferenceId/);
    expect(LOADER).toMatch(/emailMessage:\s*\{\s*clubId\s*\}/);
  });
  it("counts prior invoices from the matched vendor this quarter for the cadence line", () => {
    expect(LOADER).toMatch(/function countInvoicesThisQuarter/);
    expect(LOADER).toMatch(/prisma\.aPInvoice\.count/);
    expect(LOADER).toMatch(/vendorId,\s*invoiceDate:\s*\{\s*gte:\s*start\s*\}/);
  });
  it("derives workflow state from analyser outputs — not from generic email flags", () => {
    expect(LOADER).toMatch(/function deriveApWorkflowState/);
    expect(LOADER).toMatch(/a\.reconcile\.state === "DUPLICATE"/);
    expect(LOADER).toMatch(/a\.extraction\.state === "DOCUMENT_UNREADABLE"/);
    expect(LOADER).toMatch(/a\.vendor\.state === "NOT_FOUND"/);
  });
});

describe("sender ≠ vendor safeguard (founder brief §2 · §3.3)", () => {
  it("classifySenderRelationship never falls through to VENDOR just because the sender name matches", () => {
    const fn = LOADER.slice(LOADER.indexOf("async function classifySenderRelationship"));
    // A VENDOR classification requires a DOMAIN match (not a name/label).
    expect(fn).toMatch(/senderDomain === args\.extractedVendorDomain/);
    // EMPLOYEE_FORWARD requires an active club role.
    expect(fn).toMatch(/clubRoles:\s*\{\s*some:\s*\{\s*clubId:\s*args\.clubId\s*\}\s*\}/);
  });
  it("buildApSenderLine labels forwarding employees explicitly", () => {
    expect(CARD).toMatch(/relationship === "EMPLOYEE_FORWARD"/);
    expect(CARD).toMatch(/`Forwarded by \$\{ap\.sender\.email\}`/);
    // And renders the PDF vendor separately so the reviewer cannot
    // confuse the forwarder for the vendor.
    expect(CARD).toMatch(/PDF vendor: \$\{ap\.extractedVendor\.name\}/);
  });
});

describe("Variant D AP card — collapsed body regions", () => {
  it("renders an AP-mode pill from the workflow state (never the generic email pill)", () => {
    expect(CARD).toMatch(/function pillForApWorkflow/);
    expect(CARD).toMatch(/"Ready for approval"/);
    expect(CARD).toMatch(/"Vendor match required"/);
    expect(CARD).toMatch(/"Missing information"/);
    expect(CARD).toMatch(/data-testid="ap-workflow-pill"/);
  });
  it("factual title component renders <Vendor> invoice #<N> — <Amount> · <Category>", () => {
    // Sprint 3 · Checkpoint 15M — the pre-15M string builder
    // `buildApTitle` became a React component `ApTitle` so the
    // vendor-name segment could be an anchor link. Functional
    // invariants preserved: vendor + invoice # + amount + category
    // concatenated in the same order with the same separators.
    expect(CARD).toMatch(/function ApTitle/);
    expect(CARD).toMatch(/\{invoiceNumber \? <>\s*\{invoiceNumber\}/);
    expect(CARD).toMatch(/\{amount \? <>\s* — \{amount\}/);
    expect(CARD).toMatch(/\{category \? <>\s* · \{category\}/);
    expect(CARD).toMatch(/data-testid="ap-title"/);
  });
  it("factual title omits missing segments cleanly (no em-dash-into-nothing)", () => {
    // Each segment is guarded by `<segment> ? <> ... </> : null`
    // so an absent value never renders its separator.
    const fn = CARD.slice(CARD.indexOf("function ApTitle"), CARD.indexOf("function formatOperationalMoney"));
    // No unguarded literal "— " or "· " appears in the render.
    // Every optional segment is wrapped by a ternary.
    expect(fn).toMatch(/\{amount \? <>\s* — \{amount\}/);
    expect(fn).toMatch(/\{category \? <>\s* · \{category\}/);
    // The pre-15M imperative pattern `parts.push(...)` is gone.
    expect(fn).not.toMatch(/parts\.push\(/);
  });
  it("4-cell readout renders AMOUNT · PO/INVOICE · CATEGORY · CONFIDENCE (Ace Foods layout)", () => {
    expect(CARD).toMatch(/data-testid="ap-readout"/);
    // Callers pass `testid="ap-readout-..."` into <ReadoutCell />.
    expect(CARD).toMatch(/testid="ap-readout-amount"/);
    expect(CARD).toMatch(/testid="ap-readout-po-or-invoice"/);
    expect(CARD).toMatch(/testid="ap-readout-category"/);
    expect(CARD).toMatch(/testid="ap-readout-confidence"/);
    // Never re-introduces "AP STATUS" as a readout cell.
    expect(CARD).not.toMatch(/label:\s*"AP STATUS"/);
    // ReadoutCell renders it as data-testid at runtime.
    expect(CARD).toMatch(/<div className="cell" data-testid=\{testid\}>/);
  });
  it("recommendation strip renders the derived workflowReason (not a generic sentence)", () => {
    expect(CARD).toMatch(/data-testid="ap-recommendation"/);
    expect(CARD).toMatch(/\{ap\.workflowReason\}/);
  });
});

describe("AP action row — Ace Foods layout", () => {
  it("primary action label follows the workflow state (Approve & post / Create vendor & post / …)", () => {
    expect(CARD).toMatch(/function primaryActionForApWorkflow/);
    expect(CARD).toMatch(/"Approve & post"/);
    // Sprint 3 · Checkpoint 15L — the founder renamed the
    // VENDOR_MATCH_REQUIRED primary from "Match vendor" to
    // "Create vendor & post" once the vendor-first modal shipped.
    expect(CARD).toMatch(/"Create vendor & post"/);
    expect(CARD).toMatch(/"Request information"/);
    expect(CARD).toMatch(/"Review duplicate"/);
    expect(CARD).toMatch(/data-testid="ap-action-primary"/);
    expect(CARD).toMatch(/data-workflow-state=\{ap\.workflowState\}/);
  });
  it("Resolve is NOT the primary action for AP cards", () => {
    // The AP action row rendering block is inside `ap ? ... : ...`,
    // so `card-resolve` only appears in the non-AP fallback branch.
    // Confirm the AP branch never renders it.
    const apRow = CARD.slice(CARD.indexOf("function ApActionRow"));
    expect(apRow).not.toMatch(/data-testid="card-resolve"/);
    expect(apRow).not.toMatch(/>Resolve</);
  });
  it("Primary AP action is wired to onPrimary (never a no-op) and jumps into Invoice Review", () => {
    // Sprint 3 Checkpoint 15I-2 (2026-07-27) — per the founder's
    // staging brief §Phase 3, a staging card must not visually
    // promise functionality that does nothing. The primary AP
    // button must invoke a real handler. The handler expands the
    // card + switches tab to "invoice" so the canonical domain
    // workflow controls (Approve & post, Match vendor, etc.) are
    // one interaction away.
    expect(CARD).toMatch(/onPrimary:\s*\(\)\s*=>\s*void/);
    expect(CARD).toMatch(/onClick=\{\(e\) => \{\s*e\.stopPropagation\(\);\s*onPrimary\(\);\s*\}\}/);
    // The parent card wires onPrimary → setExpanded + setTab("invoice") + load evidence.
    expect(CARD).toMatch(/setExpanded\(true\)/);
    expect(CARD).toMatch(/setTab\("invoice"\)/);
    expect(CARD).toMatch(/loadApEvidenceOnce\(\)/);
  });
  it("Defer 24 hr control is present in the AP action row + calls the defer action", () => {
    expect(CARD).toMatch(/data-testid="ap-action-defer"/);
    expect(CARD).toMatch(/handleDefer24h/);
    expect(CARD).toMatch(/action:\s*"defer"/);
    expect(CARD).toMatch(/24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  });
  it("Assign control is visibly disabled with an accessible explanation (truthful omission, not a false control)", () => {
    // Sprint 3 Checkpoint 15I-2 (2026-07-27) — per the founder's
    // staging brief §Phase 3, the Assign button must NOT visually
    // promise functionality it doesn't perform. Until full
    // delegation lands in a follow-up, Assign is `disabled` with
    // an aria-disabled + explanatory `title` tooltip.
    expect(CARD).toMatch(/data-testid="ap-action-assign"/);
    expect(CARD).toMatch(/>\s*Assign\s*</);
    // Slice out the ApActionRow so we're checking the AP-mode
    // Assign only.
    const row = CARD.slice(CARD.indexOf("function ApActionRow"));
    const btn = row.slice(row.indexOf('data-testid="ap-action-assign"'));
    expect(btn).toMatch(/disabled/);
    expect(btn).toMatch(/aria-disabled="true"/);
    expect(btn).toMatch(/title="Assignment[^"]+follow-up[^"]+"/);
  });
  it("Attachment footer aux link opens the existing blob-URL PDF modal", () => {
    expect(CARD).toMatch(/data-testid="ap-attachment-footer"/);
    expect(CARD).toMatch(/spectre-mc-aux-link/);
    expect(CARD).toMatch(/Invoice · PDF/);
    // Wired through setPdfModal (existing DocumentPreviewModal), not a new modal
    expect(CARD).toMatch(/setPdfModal\(\{ documentId: ap\.primaryAttachment!\.documentId/);
  });
  it("no collapsed-row 'View PDF' button re-appears (the footer aux replaces it)", () => {
    // The Attachments tab body renders per-attachment "View PDF" buttons
    // legitimately — those are inside the tab, not the collapsed row.
    // Guard: no unified-view-pdf test id (that was the collapsed-row form).
    expect(CARD).not.toMatch(/data-testid="unified-view-pdf"/);
  });
});

describe("card never re-parses PDF on the client", () => {
  it("EmailIntakeCard does not import analyseIngestedInvoice or the parser", () => {
    expect(CARD).not.toMatch(/from ["']@\/lib\/ap-intelligence\/analyse["']/);
    expect(CARD).not.toMatch(/from ["']@\/lib\/ap-intelligence\/parse-invoice["']/);
  });
  it("EmailIntakeCard consumes the typed projection (LinkedIntelligenceForEmail / ApInvoiceCardIntelligence)", () => {
    expect(CARD).toMatch(/import type \{ LinkedIntelligenceForEmail, ApInvoiceCardIntelligence \}/);
    // AP-mode gate reads from linked?.invoiceSummary — never rebuilds it.
    expect(CARD).toMatch(/const ap: ApInvoiceCardIntelligence \| null = linked\?\.invoiceSummary \?\? null/);
  });
});

describe("dev-only fixture route", () => {
  it("returns 404 in production", () => {
    expect(FIXTURE_PAGE).toMatch(/process\.env\.NODE_ENV === "production"/);
    expect(FIXTURE_PAGE).toMatch(/notFound\(\)/);
  });
  it("uses the REAL production EmailIntakeCard, not a local mock", () => {
    expect(FIXTURE_PAGE).toMatch(/import EmailIntakeCard, \{ type EmailFeedCardData \} from "@\/components\/mission-control\/EmailIntakeCard"/);
    expect(FIXTURE_PAGE).toMatch(/<EmailIntakeCard/);
  });
  it("carries every founder-brief state (§Phase 8)", () => {
    for (const k of [
      "vendor-unmatched",
      "vendor-matched-ready",
      "po-matched",
      "no-po",
      "low-confidence-category",
      "assigned-to-other",
      "deferred",
      "missing-information",
    ]) {
      expect(FIXTURE_PAGE).toMatch(new RegExp(`key:\\s*"${k}"`));
    }
  });
});

describe("15H preservation — the AP rework did not break the accepted architecture", () => {
  it("loader still calls loadChildReviewIntakesToSuppress (one canonical parent per email)", () => {
    expect(INDEX).toMatch(/loadChildReviewIntakesToSuppress\(/);
  });
  it("loader still calls loadLinkedIntelligenceForEmailIntakes (child summary aggregation)", () => {
    expect(INDEX).toMatch(/loadLinkedIntelligenceForEmailIntakes\(/);
  });
  it("card still uses DocumentPreviewModal (blob-URL bypass for X-Frame-Options)", () => {
    expect(CARD).toMatch(/import DocumentPreviewModal/);
    expect(CARD).toMatch(/<DocumentPreviewModal/);
  });
});
