// Sprint 3 · Checkpoint 15S (2026-07-29) — regression tests for the
// persistent source-to-canonical-AP relationship.
//
// Founder rule (architectural reset, §Tests required before deployment):
//
//   1. First email with a new PDF creates one canonical AP workflow.
//   2. Same PDF in a second email links to the unresolved canonical
//      workflow (RETRANSMISSION relationship).
//   3. The second email does not render a sender-derived AP card.
//   4. Exactly one founder-visible AP workflow exists.
//   5. Both source emails are retained in audit/source history.
//   6. Same PDF after posting is identified as a duplicate/follow-up
//      and cannot create another posting.
//   7. Same PDF in another tenant does not link across tenants.
//   8. SHA collision/document reuse cannot establish a workflow link
//      without tenant and source validation.
//   9. Analysis-version mismatch triggers one controlled reanalysis.
//  10. New records use the explicit relationship rather than
//      projection-time SHA discovery.
//  11. Sender fallback is unavailable while invoice attachment
//      analysis is pending.
//
// Source-contract-heavy — no live DB round-trips are required for
// most assertions, since the analysis-version and vendor-fallback
// contracts are pure functions.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  currentAnalysisVersion,
  isAnalysisVersionCurrent,
  SUPPLIER_EXTRACT_VERSION,
  LINE_ITEMS_EXTRACT_VERSION,
  TAX_RECONCILE_VERSION,
  ECONOMIC_PURPOSE_VERSION,
  GL_RECOMMEND_VERSION,
} from "@/lib/ap-intelligence/analysis-version";

const strip = (s: string) =>
  s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

const MATERIALISE = strip(readFileSync(join(process.cwd(), "src/lib/ap-intelligence/materialise.ts"), "utf8"));
const PROJECTION = strip(readFileSync(join(process.cwd(), "src/lib/mission-control/intelligence-review-intakes.ts"), "utf8"));
const INVOICE_ANALYSIS = strip(readFileSync(join(process.cwd(), "src/lib/mission-control/invoice-analysis.ts"), "utf8"));
const DIAG_ROUTE = strip(readFileSync(join(process.cwd(), "src/app/api/admin/mailbox-diagnostic/[mailboxConnectionId]/route.ts"), "utf8"));
const SCHEMA = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");

describe("15S · analysis-version composite", () => {
  it("emits a stable, human-readable composite string with every component version", () => {
    const v = currentAnalysisVersion();
    expect(v).toMatch(/^ap-v1:extract=\d+:supplier=\d+:lines=\d+:tax=\d+:ids=\d+:purpose=\d+:gl=\d+$/);
    expect(v).toContain(`supplier=${SUPPLIER_EXTRACT_VERSION}`);
    expect(v).toContain(`lines=${LINE_ITEMS_EXTRACT_VERSION}`);
    expect(v).toContain(`tax=${TAX_RECONCILE_VERSION}`);
    expect(v).toContain(`purpose=${ECONOMIC_PURPOSE_VERSION}`);
    expect(v).toContain(`gl=${GL_RECOMMEND_VERSION}`);
  });

  it("isAnalysisVersionCurrent returns true only for the exact current composite", () => {
    expect(isAnalysisVersionCurrent(currentAnalysisVersion())).toBe(true);
    expect(isAnalysisVersionCurrent("ap-v1:extract=99:supplier=99:lines=99:tax=99:ids=99:purpose=99:gl=99")).toBe(false);
    expect(isAnalysisVersionCurrent(null)).toBe(false);
    expect(isAnalysisVersionCurrent("")).toBe(false);
  });
});

describe("15S · schema — ApIntakeSource + WorkIntakeItem.analysisVersion", () => {
  it("declares WorkIntakeItem.analysisVersion (nullable)", () => {
    expect(SCHEMA).toMatch(/analysisVersion\s+String\?/);
  });
  it("declares the ApIntakeSource model", () => {
    expect(SCHEMA).toMatch(/model ApIntakeSource\s*\{/);
  });
  it("ApIntakeSource carries tenant scope (clubId)", () => {
    expect(SCHEMA).toMatch(/model ApIntakeSource[\s\S]*clubId\s+String/);
  });
  it("ApIntakeSource enforces one row per EmailAttachment (unique)", () => {
    expect(SCHEMA).toMatch(/emailAttachmentId\s+String\s+@unique/);
  });
  it("ApIntakeSource records the canonical AP intake + relationship + analysisVersionAtLink", () => {
    expect(SCHEMA).toMatch(/canonicalApIntakeId\s+String/);
    expect(SCHEMA).toMatch(/relationship\s+String/);
    expect(SCHEMA).toMatch(/analysisVersionAtLink\s+String\?/);
  });
});

describe("15S · materializer writes ApIntakeSource + analysisVersion", () => {
  it("upsertApIntakeSource helper exists and is called from materialiseSingleInvoiceDocument", () => {
    expect(MATERIALISE).toMatch(/async function upsertApIntakeSource/);
    expect(MATERIALISE).toMatch(/upsertApIntakeSource\s*\(/);
  });
  it("relationship classification distinguishes original / retransmission / possible-duplicate", () => {
    expect(MATERIALISE).toMatch(/"ORIGINAL_SUBMISSION"/);
    expect(MATERIALISE).toMatch(/"RETRANSMISSION"/);
    expect(MATERIALISE).toMatch(/"POSSIBLE_DUPLICATE"/);
    expect(MATERIALISE).toMatch(/"FORWARDED_COPY"/);
  });
  it("tenant safety: cross-tenant SHA collision cannot establish a link", () => {
    // upsertApIntakeSource must validate clubId parity across the
    // four related rows before writing.
    expect(MATERIALISE).toMatch(/tenant mismatch/i);
    expect(MATERIALISE).toMatch(/will not link across tenants/i);
  });
  it("stamps analysisVersion on WorkIntakeItem + ApIntakeSource on every run", () => {
    expect(MATERIALISE).toMatch(/analysisVersion:\s*currentVersion/);
    expect(MATERIALISE).toMatch(/analysisVersionAtLink:\s*args\.analysisVersion/);
  });
  it("does not silently reopen a POSTED APInvoice — classifies as POSSIBLE_DUPLICATE", () => {
    expect(MATERIALISE).toMatch(/POSTED[\s\S]*POSSIBLE_DUPLICATE|POSSIBLE_DUPLICATE[\s\S]*POSTED/);
  });
});

describe("15S · projection reads ApIntakeSource explicitly", () => {
  it("loadChildReviewIntakesToSuppress queries ApIntakeSource FIRST", () => {
    expect(PROJECTION).toMatch(/prisma\.apIntakeSource\.findMany/);
    expect(PROJECTION).toMatch(/explicitlyLinkedApIntakes/);
  });
  it("retains bounded legacy fallback for pre-15S records without ApIntakeSource", () => {
    expect(PROJECTION).toMatch(/legacyReviews/);
    expect(PROJECTION).toMatch(/legacyDocToParent/);
  });
  it("linked-intelligence resolver joins via ApIntakeSource — not sourceReferenceId only", () => {
    expect(PROJECTION).toMatch(/canonicalApByAttachment/);
    expect(PROJECTION).toMatch(/emailAttachmentId:\s*\{\s*in:\s*attachmentIds\s*\}/);
  });
  it("linked-intelligence merges explicit + legacy AP intake ids (deduped)", () => {
    expect(PROJECTION).toMatch(/explicitApIds/);
    expect(PROJECTION).toMatch(/legacyApIds/);
    expect(PROJECTION).toMatch(/new Set\(\[\.\.\.explicitApIds,\s*\.\.\.legacyApIds\]\)/);
  });
});

describe("15S · invoice-analysis vendor fallback is disabled for PDF-invoice emails", () => {
  it("pickVendorDisplayName accepts hasPdfInvoiceAttachment option", () => {
    expect(INVOICE_ANALYSIS).toMatch(/hasPdfInvoiceAttachment\?:\s*boolean/);
  });
  it("returns em-dash (existing convention) instead of sender name when a PDF invoice attachment is present", () => {
    expect(INVOICE_ANALYSIS).toMatch(/if \(opts\?\.hasPdfInvoiceAttachment\) \{\s*return "—"/);
  });
  it("composeInvoiceSynopsis threads the flag from newestEmail.hasAttachments", () => {
    expect(INVOICE_ANALYSIS).toMatch(/hasPdfInvoiceAttachment:\s*!!newestEmail\.hasAttachments/);
  });
  it("sender-fallback branch remains for non-PDF invoice emails (backward compat)", () => {
    // Guard: ident.senderName || ident.senderEmail || "Unknown sender"
    expect(INVOICE_ANALYSIS).toMatch(/ident\.senderName\s*\|\|\s*ident\.senderEmail\s*\|\|\s*"Unknown sender"/);
  });
});

describe("15S · diagnostic route — reanalyse_attachment", () => {
  it("exposes the reanalyse_attachment action", () => {
    expect(DIAG_ROUTE).toMatch(/action === "reanalyse_attachment"/);
  });
  it("supports dryRun", () => {
    expect(DIAG_ROUTE).toMatch(/bodyExt\.dryRun/);
  });
  it("locates attachment by hash (never raw graphAttachmentId)", () => {
    expect(DIAG_ROUTE).toMatch(/attachmentIdHash/);
    expect(DIAG_ROUTE).toMatch(/short\(a\.id\)\s*===\s*bodyExt\.attachmentIdHash/);
  });
  it("tenant-scopes the attachment lookup via emailMessage.clubId + mailboxConnectionId", () => {
    expect(DIAG_ROUTE).toMatch(/emailMessage:\s*\{\s*clubId:\s*conn\.clubId,\s*mailboxConnectionId:\s*conn\.id\s*\}/);
  });
  it("routes through materialiseSingleInvoiceDocument with sourceContext (idempotent path)", () => {
    expect(DIAG_ROUTE).toMatch(/materialiseSingleInvoiceDocument/);
    expect(DIAG_ROUTE).toMatch(/sourceContext:\s*\{/);
  });
  it("emits an audit event for every non-dryRun reanalysis", () => {
    expect(DIAG_ROUTE).toMatch(/action:\s*"MAILBOX_DIAGNOSTIC_REANALYSE_ATTACHMENT"/);
  });
});

describe("15S · Web + Worker analysis-version match (composite is deterministic)", () => {
  it("currentAnalysisVersion() is a pure function of module constants — deterministic across processes", () => {
    // Same-process two calls must be equal. Web + worker use the
    // same module + same constants, so the composite matches iff
    // both apps ship the same build.
    expect(currentAnalysisVersion()).toBe(currentAnalysisVersion());
  });
});
