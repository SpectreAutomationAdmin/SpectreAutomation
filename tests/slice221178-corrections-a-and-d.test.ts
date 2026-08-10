// Sprint 3 · 221178 follow-on (2026-08-10) — Corrections A + D
// acceptance test matrix. Locks the invariants the fresh-invoice
// audit found:
//
//   Correction A — the extractor's generalized totals-block classifier
//   rejects rows whose description contains SUBTOTAL / TOTAL / TAX /
//   etc. AND lacks a quantity or unit price. Legitimate purchased
//   lines (qty + unit price populated) are NOT rejected.
//
//   Correction D — when the canonical allocation authority reports
//   `cardCategory = "Multiple"`, the projection MUST NOT populate
//   `category.glAccountNumber / glAccountName`. The founder-facing
//   narrative composer's single-GL branch therefore cannot fire on
//   a Multiple invoice, and the Category cell / popover / AP Coding
//   remain the only accounting authority.

import { describe, it, expect } from "vitest";
import {
  isItemizedSummaryDescription,
  isTotalsBlockRowRejected,
} from "@/lib/ap-intelligence/line-item-region-strategies";

// -----------------------------------------------------------------------------
// §2, §16 — generalized totals-block classifier
// -----------------------------------------------------------------------------

describe("Correction A — isTotalsBlockRowRejected (generalized totals-block classifier)", () => {
  describe("REJECTS: summary / totals-block rows with no qty or unit price", () => {
    const cases = [
      // The exact 221178 phantom row
      { description: "June, 2026. Service Contract Fees. SUBTOTAL", quantity: null, unitPrice: null },
      // Bare tokens
      { description: "SUBTOTAL", quantity: null, unitPrice: null },
      { description: "Sub-Total", quantity: null, unitPrice: null },
      { description: "TOTAL", quantity: null, unitPrice: null },
      { description: "Total Due", quantity: null, unitPrice: null },
      { description: "Balance Due", quantity: null, unitPrice: null },
      { description: "Amount Due", quantity: null, unitPrice: null },
      { description: "Invoice Total", quantity: null, unitPrice: null },
      { description: "Net Total", quantity: null, unitPrice: null },
      // Tax lines
      { description: "GST 5%", quantity: null, unitPrice: null },
      { description: "HST", quantity: null, unitPrice: null },
      { description: "PST", quantity: null, unitPrice: null },
      { description: "Tax", quantity: null, unitPrice: null },
      // Embedded totals token with prose lead-in
      { description: "Charges for July 2026 SUBTOTAL", quantity: null, unitPrice: null },
      { description: "Statement Total", quantity: null, unitPrice: null },
    ];
    for (const c of cases) {
      it(`rejects: "${c.description}"`, () => {
        expect(isTotalsBlockRowRejected(c).reject).toBe(true);
      });
    }
  });

  describe("§3 REVERSE CONTROLS — legitimate purchased lines are NOT rejected", () => {
    const cases = [
      // Same tokens in description but with real qty + unit price → keep
      { description: "Total Care Maintenance Plan", quantity: 1, unitPrice: 495.00 },
      { description: "Tax Preparation Services", quantity: 1, unitPrice: 800.00 },
      { description: "Total Protection Service", quantity: 12, unitPrice: 15.00 },
      { description: "Tax Advisory Retainer", quantity: 1, unitPrice: 2500.00 },
      { description: "Balance Sheet Audit Fee", quantity: 1, unitPrice: 3500.00 },
      // Legitimate lines with no summary token — always kept
      { description: "Service Maintenance Fee", quantity: 1, unitPrice: 2275.00 },
      { description: "Bearing kit — front axle", quantity: 2, unitPrice: 45.00 },
      { description: "Diesel — 250 gallons", quantity: 250, unitPrice: 1.34 },
    ];
    for (const c of cases) {
      it(`keeps: "${c.description}" (qty=${c.quantity}, unitPrice=${c.unitPrice})`, () => {
        expect(isTotalsBlockRowRejected(c).reject).toBe(false);
      });
    }
  });

  describe("safety — non-totals descriptions never trip the classifier", () => {
    // Post-Ranker-Authority-slice (2026-08-10): empty / whitespace /
    // extractor-fallback descriptions with null qty AND unit price
    // ARE rejected as summary rollups (CPA "line item" case). Real
    // purchase text — even without qty/unit — is kept.
    const cases = [
      { description: "Ordinary line", quantity: null, unitPrice: null },
      { description: "Software License Renewal", quantity: null, unitPrice: null },
      { description: "Fuel purchase", quantity: null, unitPrice: null },
    ];
    for (const c of cases) {
      it(`keeps: "${c.description}"`, () => {
        expect(isTotalsBlockRowRejected(c).reject).toBe(false);
      });
    }
    it("rejects empty / whitespace description with no structural evidence (Ranker Authority slice)", () => {
      expect(isTotalsBlockRowRejected({ description: "", quantity: null, unitPrice: null }).reject).toBe(true);
      expect(isTotalsBlockRowRejected({ description: "   ", quantity: null, unitPrice: null }).reject).toBe(true);
    });
  });

  describe("interaction with the Slice 5.3 anchored filter", () => {
    it("both filters keep '2 Lines Total' rejected (regression guard for Oakcreek 1091559)", () => {
      // Slice 5.3 filter — anchored regex
      expect(isItemizedSummaryDescription("2 Lines Total")).toBe(true);
      expect(isItemizedSummaryDescription("Lines Total")).toBe(true);
      // New generalized filter — also catches it (defence in depth)
      expect(isTotalsBlockRowRejected({ description: "2 Lines Total", quantity: null, unitPrice: null }).reject).toBe(true);
    });
    it("Slice 5.3 filter does NOT catch the 221178 SUBTOTAL row (proves the new filter was necessary)", () => {
      const raw = "June, 2026. Service Contract Fees. SUBTOTAL";
      expect(isItemizedSummaryDescription(raw)).toBe(false);
      // New filter catches it
      expect(isTotalsBlockRowRejected({ description: raw, quantity: null, unitPrice: null }).reject).toBe(true);
    });
  });

  describe("§16 provenance reason", () => {
    it("emits a founder-readable reason on reject", () => {
      const r = isTotalsBlockRowRejected({ description: "SUBTOTAL", quantity: null, unitPrice: null });
      expect(r.reject).toBe(true);
      expect(r.reason).toContain("totals-block row");
      expect(r.reason).toMatch(/no quantity|no unit price/);
    });
    it("emits null reason on keep", () => {
      const r = isTotalsBlockRowRejected({ description: "Total Care Plan", quantity: 1, unitPrice: 100 });
      expect(r.reject).toBe(false);
      expect(r.reason).toBeNull();
    });
  });
});
