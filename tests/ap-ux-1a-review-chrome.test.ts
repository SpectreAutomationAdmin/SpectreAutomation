// AP-UX-1a (2026-10-13) — contract tests for the review-page
// progressive intelligence strip + exception notice + source-level
// invariants.
//
// These tests exercise the PURE stage-derivation logic in
// IntelligenceStrip.deriveStages against synthetic RealReviewData
// shapes, and source-grep the review component to pin the
// composition invariants (preserved mutation guards, intelligence
// strip + vendor exception mounted at the right positions).

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { deriveStages } from "@/components/work-intake/review/IntelligenceStrip";
import type { RealReviewData } from "@/lib/work-intake/review-detail-view-model";

const REPO = path.resolve(__dirname, "..");

function makeData(invoice: Partial<RealReviewData["invoice"]>): RealReviewData {
  return {
    workIntakeItemId: "wi_test",
    header: { eyebrow: "", title: "", detectedAtLabel: "", metaChips: [] },
    invoice: {
      hasExtraction: false,
      vendor: null,
      vendorMatchState: null,
      vendorMatchedName: null,
      invoiceNumber: null,
      invoiceDateLabel: null,
      dueDateLabel: null,
      totalLabel: null,
      categoryLabel: null,
      glAccountLabel: null,
      glConfidencePercent: null,
      workflowStateLabel: null,
      lineItems: null,
      tax: null,
      ...invoice,
    },
    context: [],
    workflow: [],
    spectre: {
      lead: "",
      keyInsights: [],
      recommendation: null,
      classificationConfidence: "not classified",
      hasIntelligence: false,
    },
    document: {
      hasAttachments: false,
      firstAttachmentFilename: null,
      attachmentCount: 0,
      webLink: null,
      primaryPdf: null,
    },
  } as unknown as RealReviewData;
}

describe("AP-UX-1a §A — IntelligenceStrip derives 5-status stages from AUTHORITATIVE state", () => {
  it("empty invoice (no extraction) → every stage UNEVALUATED", () => {
    const stages = deriveStages(makeData({}));
    expect(stages).toHaveLength(5);
    expect(stages.every((s) => s.status === "UNEVALUATED")).toBe(true);
  });

  it("extraction done + matched vendor → analysis + vendor COMPLETED; detail carries matched name", () => {
    const stages = deriveStages(
      makeData({
        hasExtraction: true,
        vendor: "Club Support Inc",
        vendorMatchState: "MATCHED",
        vendorMatchedName: "Club Support Inc.",
      }),
    );
    const analysis = stages.find((s) => s.key === "analysis")!;
    const vendor = stages.find((s) => s.key === "vendor")!;
    expect(analysis.status).toBe("COMPLETED");
    expect(vendor.status).toBe("COMPLETED");
    expect(vendor.detail).toBe("Club Support Inc.");
  });

  it("vendor NOT_FOUND / AMBIGUOUS / INSUFFICIENT_SIGNAL → vendor stage ATTENTION (never COMPLETED by presence of a name alone)", () => {
    for (const state of ["NOT_FOUND", "AMBIGUOUS", "INSUFFICIENT_SIGNAL"] as const) {
      const stages = deriveStages(
        makeData({
          hasExtraction: true,
          vendor: "Club Support Inc",   // name is PRESENT ← must not promote to COMPLETED.
          vendorMatchState: state,
        }),
      );
      const vendor = stages.find((s) => s.key === "vendor")!;
      expect(vendor.status).toBe("ATTENTION");
      expect(vendor.detail).toBe("Club Support Inc");
    }
  });

  it("GL account label present → classification stage is SUGGESTED (never auto-promoted to COMPLETED)", () => {
    const stages = deriveStages(
      makeData({
        hasExtraction: true,
        glAccountLabel: "6700 · Office & Admin",
        glConfidencePercent: 82,
      }),
    );
    const cls = stages.find((s) => s.key === "classification")!;
    expect(cls.status).toBe("SUGGESTED");
    expect(cls.detail).toBe("6700 · Office & Admin · 82% confidence");
  });

  it("line items array populated → line-item stage COMPLETED with count detail", () => {
    const stages = deriveStages(
      makeData({
        hasExtraction: true,
        lineItems: [
          { n: 1, description: "A", quantity: null, unitCost: null, amount: null },
          { n: 2, description: "B", quantity: null, unitCost: null, amount: null },
        ],
      }),
    );
    const li = stages.find((s) => s.key === "lineitems")!;
    expect(li.status).toBe("COMPLETED");
    expect(li.detail).toBe("2 line items");
  });

  it("workflowStateLabel present → ready stage SUGGESTED (not COMPLETED — human still has to act)", () => {
    const stages = deriveStages(
      makeData({
        hasExtraction: true,
        workflowStateLabel: "Ready for approval",
      }),
    );
    const ready = stages.find((s) => s.key === "ready")!;
    expect(ready.status).toBe("SUGGESTED");
    expect(ready.detail).toBe("Ready for approval");
  });
});

describe("AP-UX-1a §B — WorkIntakeReviewReal mounts the new primitives + preserves WI-2B §17 restrictions", () => {
  const src = fs.readFileSync(
    path.join(REPO, "src/components/work-intake/review/WorkIntakeReviewReal.tsx"),
    "utf-8",
  );

  it("imports IntelligenceStrip + ExceptionNotice from the review namespace", () => {
    expect(src).toMatch(/import IntelligenceStrip from "\.\/IntelligenceStrip"/);
    expect(src).toMatch(/import ExceptionNotice from "\.\/ExceptionNotice"/);
  });

  it("mounts <IntelligenceStrip> + <VendorMatchException> above <InvoiceDetails> inside .wi-review-body", () => {
    const body = src.slice(src.indexOf('className="wi-review-body"'));
    const close = body.indexOf("</div>");
    const scope = body.slice(0, close);
    const idxStrip = scope.indexOf("<IntelligenceStrip");
    const idxException = scope.indexOf("<VendorMatchException");
    const idxDetails = scope.indexOf("<InvoiceDetails");
    expect(idxStrip).toBeGreaterThan(-1);
    expect(idxException).toBeGreaterThan(idxStrip);
    expect(idxDetails).toBeGreaterThan(idxException);
  });

  it("Approve & Start + Send back buttons remain disabled (WI-2B §17 preserved)", () => {
    // Both action buttons still carry `disabled` — this slice does
    // NOT re-enable mutation.
    expect(src).toMatch(/Send back<\/button>/);
    expect(src).toMatch(/wi-review-btn--ghost" disabled>/);
    expect(src).toMatch(/wi-review-btn--primary" disabled>/);
    expect(src).toMatch(/Approve &amp; Start/);
  });

  it("VendorMatchException's primary action routes to Mission Control — no new backend wired", () => {
    const fn = src.slice(src.indexOf("function VendorMatchException"));
    const scope = fn.slice(0, 2_500);
    expect(scope).toContain('"/app/admin"');
    expect(scope).toContain('"Open in Mission Control"');
    // No `createVendorAction` or `postApInvoiceAction` reference —
    // the mutation path lives entirely on Mission Control.
    expect(scope).not.toMatch(/createVendorAction/);
    expect(scope).not.toMatch(/postApInvoiceAction/);
  });

  it("VendorMatchException renders ONLY when vendor match is unresolved", () => {
    const fn = src.slice(src.indexOf("function VendorMatchException"));
    const scope = fn.slice(0, 2_500);
    expect(scope).toMatch(/state === "AMBIGUOUS"/);
    expect(scope).toMatch(/state === "NOT_FOUND"/);
    expect(scope).toMatch(/state === "INSUFFICIENT_SIGNAL"/);
    // MATCHED does NOT trigger the exception.
    expect(scope).toMatch(/if \(!unresolved\) return null;/);
  });
});

describe("AP-UX-1a §C — Motion primitives honour prefers-reduced-motion", () => {
  const css = fs.readFileSync(path.join(REPO, "src/app/globals.css"), "utf-8");

  it("defines ap-ux-rise + ap-ux-dot-pulse keyframes", () => {
    expect(css).toMatch(/@keyframes ap-ux-rise/);
    expect(css).toMatch(/@keyframes ap-ux-dot-pulse/);
  });

  it("prefers-reduced-motion suppresses the intel-strip + exception animations", () => {
    // Scope specifically to the AP-UX-1a reduce block (preceded by
    // the ap-ux keyframes, not the global `[class*=\"spectre-\"]`
    // block that lives much earlier in the stylesheet).
    const anchor = css.indexOf("@keyframes ap-ux-dot-pulse");
    expect(anchor).toBeGreaterThan(-1);
    const start = css.indexOf("@media (prefers-reduced-motion: reduce)", anchor);
    expect(start).toBeGreaterThan(-1);
    const after = css.indexOf("@media (max-width:", start);
    const scope = css.slice(start, after > start ? after : start + 2_500);
    expect(scope).toContain(".ap-ux-intel-strip");
    expect(scope).toContain(".ap-ux-exception");
    expect(scope).toMatch(/animation: none !important/);
  });

  it("processing animation applies ONLY to data-status=\"PROCESSING\" (no continuous breathing on active stages)", () => {
    // The processing dot pulse selector requires the processing
    // class modifier — static active stages never animate.
    expect(css).toMatch(/\.ap-ux-intel-strip-item--processing \.ap-ux-intel-strip-processing-glyph circle/);
    expect(css).not.toMatch(/\.ap-ux-intel-strip-item--active[^-]/);
    // Workflow active-stage styling is NOT given a continuous
    // breathing animation.
    const flowActive = css.slice(css.indexOf(".wi-review-flow-stage--active"));
    const sampled = flowActive.slice(0, 1_000);
    expect(sampled).not.toMatch(/animation: [^;]*infinite/);
  });
});
