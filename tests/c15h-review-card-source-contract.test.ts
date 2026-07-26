// Sprint 3 Checkpoint 15H (2026-07-25) — Source-contract locks for
// the Mission Control review-card wiring. Verifies the invariants
// that make the browser experience safe:
//   * new WorkItem.classification field is closed to the 6 approved values
//   * MC page routes AP_INVOICE_REVIEW and VENDOR_STATEMENT_REVIEW to the
//     new client card, NOT the legacy FeedItem
//   * loader queries the persisted intakes (no page-load materialisation)
//   * component never fetches PDF bytes eagerly (only inside iframe on expand)
//   * component uses the sandboxed iframe pattern for PDF preview
//   * component POSTs to the C15E / C15G closed-enum action endpoints
//     (no direct DB access, no aPInvoice.create client-side)

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MC_TYPES = readFileSync(join(process.cwd(), "src/lib/mission-control/index.ts"), "utf8");
const LOADER = readFileSync(join(process.cwd(), "src/lib/mission-control/intelligence-review-intakes.ts"), "utf8");
const COMPONENT = readFileSync(join(process.cwd(), "src/components/mission-control/IntelligenceReviewCard.tsx"), "utf8");
const PAGE = readFileSync(join(process.cwd(), "src/app/app/admin/page.tsx"), "utf8");
const CLI = readFileSync(join(process.cwd(), "bin/c15h-founder-fixture.ts"), "utf8");
const GLOBALS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

describe("WorkItem.classification field", () => {
  it("is a closed union of the 6 approved values", () => {
    for (const s of ["AP_INVOICE_REVIEW", "VENDOR_STATEMENT_REVIEW", "AR_AGING_60", "AR_AGING_90", "AR_AGING_120", "VENDOR_CONSOLIDATION_REVIEW"]) {
      expect(MC_TYPES).toMatch(new RegExp(`"${s}"`));
    }
  });
});

describe("Loader — read-only, tenant-scoped, no page-load writes", () => {
  it("never creates WorkIntakeItem / IngestedDocument / findings", () => {
    expect(LOADER).not.toMatch(/workIntakeItem\.create\(/);
    expect(LOADER).not.toMatch(/ingestedDocument\.create\(/);
    expect(LOADER).not.toMatch(/workIntakeFinding\.create\(/);
    expect(LOADER).not.toMatch(/aPInvoice\.create\(/);
    expect(LOADER).not.toMatch(/vendorPayment\.create\(/);
  });
  it("only queries persisted intakes classified AP_INVOICE_REVIEW / VENDOR_STATEMENT_REVIEW", () => {
    expect(LOADER).toMatch(/classification:\s*"AP_INVOICE_REVIEW"/);
    expect(LOADER).toMatch(/classification:\s*"VENDOR_STATEMENT_REVIEW"/);
  });
  it("every findMany includes clubId scope", () => {
    const findManys = LOADER.match(/prisma\.[a-zA-Z]+\.findMany\(\{[\s\S]*?where:\s*\{[\s\S]*?\}/g) ?? [];
    expect(findManys.length).toBeGreaterThan(0);
    for (const q of findManys) {
      expect(q).toMatch(/clubId/);
    }
  });
});

describe("MC page routing — new cards receive AP + Statement traffic", () => {
  it("routes AP_INVOICE_REVIEW to IntelligenceReviewCard", () => {
    expect(PAGE).toMatch(/classification === "AP_INVOICE_REVIEW"[\s\S]{0,120}IntelligenceReviewCard/);
  });
  it("routes VENDOR_STATEMENT_REVIEW to IntelligenceReviewCard", () => {
    expect(PAGE).toMatch(/classification === "VENDOR_STATEMENT_REVIEW"[\s\S]{0,120}IntelligenceReviewCard/);
  });
  it("does NOT fall back to FeedItem for the two new classifications", () => {
    // The branch that lands on FeedItem must be the final `: (` after
    // both the AP + Statement checks. Verify ordering in the raw file.
    const idxAp = PAGE.indexOf('classification === "AP_INVOICE_REVIEW"');
    const idxStmt = PAGE.indexOf('classification === "VENDOR_STATEMENT_REVIEW"');
    const idxFallback = PAGE.indexOf("<FeedItem key={item.id}");
    expect(idxAp).toBeGreaterThan(-1);
    expect(idxStmt).toBeGreaterThan(-1);
    expect(idxFallback).toBeGreaterThan(-1);
    expect(idxAp).toBeLessThan(idxFallback);
    expect(idxStmt).toBeLessThan(idxFallback);
  });
});

describe("Component — never eagerly fetches PDF bytes", () => {
  it("does not fetch previewUrl directly (only mounts it as an iframe src on expand)", () => {
    // No `fetch(previewUrl)` in the component — bytes only flow through the iframe.
    const fetches = COMPONENT.match(/fetch\s*\(\s*[^)]*previewUrl/g) ?? [];
    expect(fetches.length).toBe(0);
  });
  it("mounts PDF via <iframe src={doc.previewUrl} sandbox=\"\">", () => {
    // The iframe must appear only inside the DocumentPanel sub-component.
    expect(COMPONENT).toMatch(/<iframe[\s\S]*?src=\{doc\.previewUrl\}/);
    expect(COMPONENT).toMatch(/sandbox=""/);
  });
  it("only fires the review-evidence fetch on expand (loadOnce guard)", () => {
    expect(COMPONENT).toMatch(/loadOnce/);
    const collapsedFetches = COMPONENT.match(/useEffect\([^)]+fetch\(/g) ?? [];
    expect(collapsedFetches.length).toBe(0);
  });
});

describe("Component — actions use POST to the closed-enum endpoints only", () => {
  it("POSTs to /ap-actions or /statement-actions", () => {
    expect(COMPONENT).toMatch(/\/ap-actions/);
    expect(COMPONENT).toMatch(/\/statement-actions/);
  });
  it("never posts to /api/ap or otherwise directly triggers postInvoice / payments", () => {
    expect(COMPONENT).not.toMatch(/postInvoice/);
    expect(COMPONENT).not.toMatch(/aPInvoice\.create/);
    expect(COMPONENT).not.toMatch(/vendorPayment\.create/);
    expect(COMPONENT).not.toMatch(/\/api\/ap\//);
  });
});

describe("Component — never exposes storage keys, bucket, or bank details", () => {
  it("does not reference storageKey / storageBucket / accountLastFour / processorToken", () => {
    expect(COMPONENT).not.toMatch(/storageKey/);
    expect(COMPONENT).not.toMatch(/storageBucket/);
    expect(COMPONENT).not.toMatch(/accountLastFour/);
    expect(COMPONENT).not.toMatch(/processorToken/);
  });
  it("does not reference Graph attachment ids or internal DB ids as display text", () => {
    expect(COMPONENT).not.toMatch(/graphAttachmentId/);
    expect(COMPONENT).not.toMatch(/graphMessageId/);
  });
});

describe("Component — accessibility scaffolding", () => {
  it("gives the iframe a title", () => {
    expect(COMPONENT).toMatch(/title=\{`Preview: \$\{doc\.filename\}`\}/);
  });
  it("uses role=status / role=alert for inline banners", () => {
    expect(COMPONENT).toMatch(/role="status"/);
    expect(COMPONENT).toMatch(/role="alert"/);
  });
  it("provides <table><thead><th scope=\"col\">…</thead> for the statement table", () => {
    expect(COMPONENT).toMatch(/<th scope="col">/);
  });
  it("wires aria-busy on in-flight action buttons", () => {
    expect(COMPONENT).toMatch(/aria-busy=\{actionInFlight === a\.key\}/);
  });
  it("uses role=tablist + aria-selected on the reconciliation filter tabs", () => {
    expect(COMPONENT).toMatch(/role="tablist"/);
    expect(COMPONENT).toMatch(/aria-selected=\{filter === k\}/);
  });
});

describe("CSS — review pane uses only --spectre-* tokens, not legacy palette", () => {
  it("no stone-* or club-green-* utility classes appear in the new pane rules", () => {
    // Slice the newly added block.
    const start = GLOBALS.indexOf("Sprint 3 Checkpoint 15H (2026-07-25) — Intelligence review pane styles");
    expect(start).toBeGreaterThan(-1);
    const block = GLOBALS.slice(start);
    expect(block).not.toMatch(/\bstone-\d+\b/);
    expect(block).not.toMatch(/club-green-\d+/);
  });
  it("has responsive breakpoints for 1279 and 1023 widths", () => {
    const start = GLOBALS.indexOf("Sprint 3 Checkpoint 15H (2026-07-25) — Intelligence review pane styles");
    const block = GLOBALS.slice(start);
    expect(block).toMatch(/max-width:\s*1279px/);
    expect(block).toMatch(/max-width:\s*1023px/);
  });
});

describe("Founder fixture CLI — staging + Silver Springs guards + idempotent", () => {
  it("refuses non-staging URLs", () => {
    expect(CLI).toMatch(/APP_URL is not staging\/localhost/);
  });
  it("refuses Silver Springs by slug or name", () => {
    expect(CLI).toMatch(/silver-springs/i);
  });
  it("uses stable natural keys c15h-fixture:*", () => {
    expect(CLI).toMatch(/c15h-fixture/);
  });
  it("supports --wipe for safe cleanup", () => {
    expect(CLI).toMatch(/--wipe/);
  });
  it("prints founder-review URLs at the end", () => {
    expect(CLI).toMatch(/FOUNDER-REVIEW URLS/);
    expect(CLI).toMatch(/ap-evidence/);
    expect(CLI).toMatch(/statement-evidence/);
  });
});
